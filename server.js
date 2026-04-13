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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

// ─── Paginated order fetcher ─────────────────────────────────────────────────
// Fetches ALL orders within the date window across multiple pages (250/page max)
async function fetchAllOrders(sinceISO) {
  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `
    {
      orders(first: 250, reverse: true${afterClause}, query: "created_at:>=${sinceISO}") {
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
function buildAnalytics(orders, days) {
  let totalRevenue = 0;
  let totalDiscount = 0;
  let totalShipping = 0;
  let currency = "PKR";

  const customerMap = {};         // id → { email, name, orders, totalSpent, address, firstOrder, lastOrder }
  const productCounts = {};       // title → qty
  const cityMap = {};             // city → { count, revenue }
  const countryMap = {};          // country → { count, revenue }
  const dailyMap = {};            // YYYY-MM-DD → { orders, revenue }
  const hourMap = Array(24).fill(0); // orders by hour
  const statusMap = {};           // financial status counts
  const fulfillmentMap = {};      // fulfillment status counts
  const discountUsage = {};       // discount code → count
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

    // Cancelled
    if (order.cancelledAt) cancelledCount++;

    // Financial / fulfillment status
    const fin = order.displayFinancialStatus || "UNKNOWN";
    const ful = order.displayFulfillmentStatus || "UNFULFILLED";
    statusMap[fin] = (statusMap[fin] || 0) + 1;
    fulfillmentMap[ful] = (fulfillmentMap[ful] || 0) + 1;

    // Daily breakdown
    const day = order.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { orders: 0, revenue: 0 };
    dailyMap[day].orders++;
    dailyMap[day].revenue += amount;

    // Hour of day
    const hour = new Date(order.createdAt).getUTCHours();
    hourMap[hour]++;

    // Discount codes
    for (const code of (order.discountCodes || [])) {
      if (code) discountUsage[code] = (discountUsage[code] || 0) + 1;
    }

    // Products
    for (const edge of order.lineItems.edges) {
      const title = edge.node.title;
      const qty = edge.node.quantity;
      productCounts[title] = (productCounts[title] || 0) + qty;
    }

    // Location — prefer shippingAddress, fall back to customer defaultAddress
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

    // Customer journey
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

  // New vs repeat
  for (const c of Object.values(customerMap)) {
    if (c.isRepeat) newVsRepeat.repeat++;
    else newVsRepeat.new++;
  }

  // Sort helpers
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
      days,
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

// GET /analytics?days=7|30|90|180|365  (default 7)
app.get("/analytics", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 365);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceISO = since.toISOString();

    const orders = await fetchAllOrders(sinceISO);
    const analytics = buildAnalytics(orders, days);
    res.json(analytics);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// GET /claude-summary?days=7|30|90
app.get("/claude-summary", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 365);
    const analyticsRes = await fetch(
      `https://shopify-analytics-production-b0c3.up.railway.app/analytics?days=${days}`
    );
    const analyticsData = await analyticsRes.json();

    const { summary, bestProducts, location, customerJourney, topCustomers, topDiscountCodes } = analyticsData;

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
          content: `Analyze this Shopify store data for the last ${days} days and provide:
1. Business performance summary
2. Top products insight
3. Customer retention insight (new vs repeat)
4. Location/geography insight
5. Peak ordering time insight
6. 3 specific action items to grow revenue

Data:
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

    res.json({ days, summary: text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));