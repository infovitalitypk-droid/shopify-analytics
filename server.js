require("dotenv").config();
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // 🔥 IMPORTANT: handle preflight requests
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});
// ─── Shopify GraphQL helper ──────────────────────────────────────────────────
async function shopifyQuery(query) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN
    },
    body: JSON.stringify({ query })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${text}`);

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Invalid Shopify JSON: ${text}`); }

  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

// ─── Date range resolver ─────────────────────────────────────────────────────
// Returns { sinceISO, untilISO, label, rangeType }
// Priority: from/to params > days param
function resolveDateRange(query) {
  const { from, to, days } = query;

  if (from) {
    // Validate format YYYY-MM-DD
    const dateRx = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRx.test(from)) throw new Error("Invalid 'from' format. Use YYYY-MM-DD.");
    if (to && !dateRx.test(to)) throw new Error("Invalid 'to' format. Use YYYY-MM-DD.");

    const fromDate = new Date(from + "T00:00:00.000Z");
    const toDate = to
      ? new Date(to + "T23:59:59.999Z")
      : new Date(from + "T23:59:59.999Z"); // default to same day

    if (isNaN(fromDate.getTime())) throw new Error("Invalid 'from' date.");
    if (isNaN(toDate.getTime())) throw new Error("Invalid 'to' date.");
    if (toDate < fromDate) throw new Error("'to' must be >= 'from'.");

    const diffMs = toDate - fromDate;
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    return {
      sinceISO: fromDate.toISOString(),
      untilISO: toDate.toISOString(),
      label: to && to !== from ? `${from} to ${to}` : from,
      rangeType: "custom",
      from,
      to: to || from,
      days: diffDays
    };
  }

  // Fall back to days
  const numDays = Math.min(parseInt(days) || 7, 365);
  const since = new Date();
  since.setDate(since.getDate() - numDays);
  since.setHours(0, 0, 0, 0);

  return {
    sinceISO: since.toISOString(),
    untilISO: new Date().toISOString(),
    label: `Last ${numDays} days`,
    rangeType: "rolling",
    from: null,
    to: null,
    days: numDays
  };
}

// ─── Paginated order fetcher ─────────────────────────────────────────────────
// Fetches ALL orders within the date window across multiple pages (250/page max)
async function fetchAllOrders(sinceISO, untilISO) {
  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  // Build Shopify query filter — always filter by sinceISO;
  // if untilISO is provided (custom range), also add upper bound
  const untilClause = untilISO ? ` created_at:<=${untilISO}` : "";

  while (hasNextPage) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `
    {
      orders(first: 250, reverse: true${afterClause}, query: "created_at:>=${sinceISO}${untilClause}") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            customer {
              id
              email
              firstName
              lastName
              numberOfOrders
              createdAt
              defaultAddress {
                city
                province
                country
                countryCodeV2
              }
            }
            shippingAddress {
              city
              province
              country
              countryCodeV2
            }
            lineItems(first: 20) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    price
                    product { productType tags }
                  }
                }
              }
            }
            discountCodes
            tags
            note
            referrerUrl
          }
        }
      }
    }`;

    const result = await shopifyQuery(query);
    const page = result.data.orders;
    allOrders = allOrders.concat(page.edges.map(e => e.node));
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return allOrders;
}

// ─── Main analytics builder ──────────────────────────────────────────────────
function buildAnalytics(orders, range) {
  let totalRevenue = 0;
  let totalDiscount = 0;
  let totalShipping = 0;
  let currency = "PKR";

  const customerMap = {};
  const productCounts = {};
  const cityMap = {};
  const countryMap = {};
  const dailyMap = {};
  const hourMap = Array(24).fill(0);
  const statusMap = {};
  const fulfillmentMap = {};
  const discountUsage = {};
  const newVsRepeat = { new: 0, repeat: 0 };
  let cancelledCount = 0;

  for (const order of orders) {
    const amount = parseFloat(order.totalPriceSet?.shopMoney?.amount || 0);
    const discount = parseFloat(order.totalDiscountsSet?.shopMoney?.amount || 0);
    const shipping = parseFloat(order.totalShippingPriceSet?.shopMoney?.amount || 0);
    currency = order.totalPriceSet?.shopMoney?.currencyCode || currency;

    totalRevenue += amount;
    totalDiscount += discount;
    totalShipping += shipping;

    if (order.cancelledAt) cancelledCount++;

    const fin = order.displayFinancialStatus || "UNKNOWN";
    const ful = order.displayFulfillmentStatus || "UNFULFILLED";
    statusMap[fin] = (statusMap[fin] || 0) + 1;
    fulfillmentMap[ful] = (fulfillmentMap[ful] || 0) + 1;

    const day = order.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { orders: 0, revenue: 0 };
    dailyMap[day].orders++;
    dailyMap[day].revenue += amount;

    const hour = new Date(order.createdAt).getUTCHours();
    hourMap[hour]++;

    for (const code of (order.discountCodes || [])) {
      if (code) discountUsage[code] = (discountUsage[code] || 0) + 1;
    }

    for (const edge of order.lineItems.edges) {
      const title = edge.node.title;
      const qty = edge.node.quantity;
      productCounts[title] = (productCounts[title] || 0) + qty;
    }

    const addr = order.shippingAddress || order.customer?.defaultAddress;
    if (addr) {
      const city = addr.city || "Unknown";
      const country = addr.country || "Unknown";
      const countryCode = addr.countryCodeV2 || "??";

      if (!cityMap[city]) cityMap[city] = { count: 0, revenue: 0, country, countryCode };
      cityMap[city].count++;
      cityMap[city].revenue += amount;

      if (!countryMap[country]) countryMap[country] = { count: 0, revenue: 0, countryCode };
      countryMap[country].count++;
      countryMap[country].revenue += amount;
    }

    if (order.customer?.id) {
      const cid = order.customer.id;
      if (!customerMap[cid]) {
        customerMap[cid] = {
          email: order.customer.email,
          name: `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim(),
          totalOrdersLifetime: order.customer.numberOfOrders,
          ordersInPeriod: 0,
          totalSpentInPeriod: 0,
          firstOrderInPeriod: order.createdAt,
          lastOrderInPeriod: order.createdAt,
          city: order.customer.defaultAddress?.city || null,
          country: order.customer.defaultAddress?.country || null,
          isRepeat: order.customer.numberOfOrders > 1
        };
      }
      customerMap[cid].ordersInPeriod++;
      customerMap[cid].totalSpentInPeriod += amount;
      if (order.createdAt < customerMap[cid].firstOrderInPeriod) customerMap[cid].firstOrderInPeriod = order.createdAt;
      if (order.createdAt > customerMap[cid].lastOrderInPeriod) customerMap[cid].lastOrderInPeriod = order.createdAt;
    }
  }

  for (const c of Object.values(customerMap)) {
    if (c.isRepeat) newVsRepeat.repeat++;
    else newVsRepeat.new++;
  }

  const sortedCities = Object.entries(cityMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 15)
    .map(([city, d]) => ({ city, country: d.country, countryCode: d.countryCode, orders: d.count, revenue: Math.round(d.revenue) }));

  const sortedCountries = Object.entries(countryMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([country, d]) => ({ country, countryCode: d.countryCode, orders: d.count, revenue: Math.round(d.revenue) }));

  const bestProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, quantitySold]) => ({ title, quantitySold }));

  const dailyBreakdown = Object.entries(dailyMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({ date, orders: d.orders, revenue: Math.round(d.revenue) }));

  const peakHour = hourMap.indexOf(Math.max(...hourMap));

  const topCustomers = Object.values(customerMap)
    .sort((a, b) => b.totalSpentInPeriod - a.totalSpentInPeriod)
    .slice(0, 10)
    .map(c => ({
      email: c.email,
      name: c.name || "Guest",
      ordersInPeriod: c.ordersInPeriod,
      totalSpentInPeriod: Math.round(c.totalSpentInPeriod),
      totalOrdersLifetime: c.totalOrdersLifetime,
      city: c.city,
      country: c.country,
      firstOrderInPeriod: c.firstOrderInPeriod,
      lastOrderInPeriod: c.lastOrderInPeriod
    }));

  const topDiscounts = Object.entries(discountUsage)
    .sort((a, b) => b[1] - a[1])
    .map(([code, uses]) => ({ code, uses }));

  const recentOrders = orders.slice(0, 10).map(o => ({
    orderName: o.name,
    createdAt: o.createdAt,
    amount: parseFloat(o.totalPriceSet?.shopMoney?.amount || 0),
    customerEmail: o.customer?.email || null,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    city: (o.shippingAddress || o.customer?.defaultAddress)?.city || null,
    country: (o.shippingAddress || o.customer?.defaultAddress)?.country || null
  }));

  const avgOrder = orders.length ? totalRevenue / orders.length : 0;

  return {
    meta: {
      // Always include both days and range info
      days: range.days,
      rangeType: range.rangeType,
      rangeLabel: range.label,
      from: range.from,
      to: range.to,
      totalOrdersFetched: orders.length,
      generatedAt: new Date().toISOString()
    },
    summary: {
      totalOrders: orders.length,
      cancelledOrders: cancelledCount,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalDiscount: Number(totalDiscount.toFixed(2)),
      totalShipping: Number(totalShipping.toFixed(2)),
      avgOrderValue: Number(avgOrder.toFixed(2)),
      currency,
      uniqueCustomers: Object.keys(customerMap).length,
      repeatCustomers: newVsRepeat.repeat,
      newCustomers: newVsRepeat.new
    },
    financialStatus: statusMap,
    fulfillmentStatus: fulfillmentMap,
    bestProducts,
    topCustomers,
    topDiscountCodes: topDiscounts,
    location: {
      byCity: sortedCities,
      byCountry: sortedCountries
    },
    customerJourney: {
      newVsRepeat,
      peakOrderHour: peakHour,
      peakOrderHourLabel: `${peakHour}:00 – ${peakHour + 1}:00 UTC`,
      hourlyDistribution: hourMap.map((count, hour) => ({ hour, count }))
    },
    dailyBreakdown,
    recentOrders
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.send("Vitality Analytics Backend — OK"));

// GET /analytics?days=7|30|90|180|365
// GET /analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
// GET /analytics?from=YYYY-MM-DD  (single day)
app.get("/analytics", async (req, res) => {
  try {
    const range = resolveDateRange(req.query);
    const orders = await fetchAllOrders(range.sinceISO, range.untilISO);
    const analytics = buildAnalytics(orders, range);
    res.json(analytics);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// GET /claude-summary?days=7|30|90
// GET /claude-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
// GET /claude-summary?from=YYYY-MM-DD  (single day)
app.get("/claude-summary", async (req, res) => {
  try {
    const range = resolveDateRange(req.query);

    // Build analytics URL using the same params that were passed in
    const baseUrl = "https://shopify-analytics-production-b0c3.up.railway.app/analytics";
    let analyticsUrl;
    if (range.rangeType === "custom") {
      analyticsUrl = `${baseUrl}?from=${range.from}&to=${range.to}`;
    } else {
      analyticsUrl = `${baseUrl}?days=${range.days}`;
    }

    const analyticsRes = await fetch(analyticsUrl);
    const analyticsData = await analyticsRes.json();

    const { summary, bestProducts, location, customerJourney, topCustomers, topDiscountCodes, meta } = analyticsData;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: "You are a Shopify analytics expert. Give concise, practical, data-driven insights. Use plain text, no markdown symbols.",
        messages: [{
          role: "user",
          content: `Analyze this Shopify store data for ${meta.rangeLabel} and provide:
1. Business performance summary
2. Top products insight
3. Customer retention insight (new vs repeat)
4. Location/geography insight
5. Peak ordering time insight
6. 3 specific action items to grow revenue

Data:
- Period: ${meta.rangeLabel}
- Total orders: ${summary.totalOrders} | Revenue: ${summary.currency} ${summary.totalRevenue} | Avg order: ${summary.currency} ${summary.avgOrderValue}
- Unique customers: ${summary.uniqueCustomers} | New: ${summary.newCustomers} | Repeat: ${summary.repeatCustomers}
- Cancelled orders: ${summary.cancelledOrders}
- Total discounts given: ${summary.currency} ${summary.totalDiscount}
- Top products: ${bestProducts.slice(0,5).map(p => `${p.title} (${p.quantitySold} units)`).join(", ")}
- Top cities: ${location.byCity.slice(0,5).map(c => `${c.city} (${c.orders} orders)`).join(", ")}
- Top countries: ${location.byCountry.slice(0,3).map(c => `${c.country} (${c.orders} orders)`).join(", ")}
- Peak order hour: ${customerJourney.peakOrderHourLabel}
- New vs repeat: ${customerJourney.newVsRepeat.new} new, ${customerJourney.newVsRepeat.repeat} repeat
- Top discount codes: ${topDiscountCodes.slice(0,3).map(d => `${d.code} (${d.uses}x)`).join(", ") || "none"}
- Top customers by spend: ${topCustomers.slice(0,3).map(c => `${c.email} (${summary.currency} ${c.totalSpentInPeriod})`).join(", ")}`
        }]
      })
    });

    const raw = await response.json();
    if (!response.ok) return res.status(response.status).json(raw);

    const text = (raw.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n");

    res.json({
      days: range.days,
      rangeType: range.rangeType,
      rangeLabel: range.label,
      from: range.from,
      to: range.to,
      summary: text
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));