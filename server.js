require("dotenv").config();
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP = process.env.SHOPIFY_STORE;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ✅ STATIC TOKEN ONLY
const STATIC_TOKEN = process.env.SHOPIFY_TOKEN || "";

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// AUTH (LOCKED TO STATIC TOKEN)
// ─────────────────────────────────────────────────────────────────────────────
function getAuthMode() {
  if (SHOP && STATIC_TOKEN) return "static_token";
  return "missing";
}

async function getShopifyAccessToken() {
  if (!SHOP) throw new Error("Missing SHOPIFY_STORE.");
  if (!STATIC_TOKEN) throw new Error("Missing SHOPIFY_TOKEN.");
  return STATIC_TOKEN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify GraphQL helper
// ─────────────────────────────────────────────────────────────────────────────
async function shopifyQuery(query) {
  const accessToken = await getShopifyAccessToken();

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query }),
  });

  const data = await res.json();

  if (!res.ok || data.errors) {
    throw new Error(JSON.stringify(data.errors || data));
  }

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date range resolver (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function resolveDateRange(query) {
  const { from, to, days } = query;

  if (from) {
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = to
      ? new Date(`${to}T23:59:59.999Z`)
      : new Date(`${from}T23:59:59.999Z`);

    return {
      sinceISO: fromDate.toISOString(),
      untilISO: toDate.toISOString(),
      label: to && to !== from ? `${from} to ${to}` : from,
      rangeType: "custom",
      from,
      to: to || from,
      days: 1,
    };
  }

  const numDays = parseInt(days, 10) || 7;
  const since = new Date();
  since.setDate(since.getDate() - numDays);

  return {
    sinceISO: since.toISOString(),
    untilISO: new Date().toISOString(),
    label: `Last ${numDays} days`,
    rangeType: "rolling",
    days: numDays,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch orders (unchanged core)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAllOrders(sinceISO, untilISO) {
  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const after = cursor ? `, after: "${cursor}"` : "";

    const query = `
    {
      orders(first: 100${after}, query: "created_at:>=${sinceISO} created_at:<=${untilISO}") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            customer { id numberOfOrders }
          }
        }
      }
    }`;

    const result = await shopifyQuery(query);
    const page = result.data.orders;

    allOrders.push(...page.edges.map(e => e.node));
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return allOrders;
}

// ─────────────────────────────────────────────────────────────────────────────
// Basic analytics (simplified but valid)
// ─────────────────────────────────────────────────────────────────────────────
function buildAnalytics(orders, range) {
  let revenue = 0;
  let repeat = 0;
  let newC = 0;

  for (const o of orders) {
    revenue += parseFloat(o.totalPriceSet.shopMoney.amount || 0);
    if (o.customer?.numberOfOrders > 1) repeat++;
    else newC++;
  }

  return {
    meta: range,
    summary: {
      totalOrders: orders.length,
      totalRevenue: Math.round(revenue),
      repeatCustomers: repeat,
      newCustomers: newC,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    authMode: getAuthMode(),
  });
});

app.get("/analytics", async (req, res) => {
  try {
    const range = resolveDateRange(req.query);
    const orders = await fetchAllOrders(range.sinceISO, range.untilISO);
    const data = buildAnalytics(orders, range);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ NEW: CLAUDE CHAT
// ─────────────────────────────────────────────────────────────────────────────
app.get("/claude-chat", async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();

    let rangeQuery = { days: 30 };

    if (q.includes("yesterday")) {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const date = d.toISOString().slice(0, 10);
      rangeQuery = { from: date, to: date };
    } else if (q.includes("7") || q.includes("week")) {
      rangeQuery = { days: 7 };
    }

    const range = resolveDateRange(rangeQuery);
    const orders = await fetchAllOrders(range.sinceISO, range.untilISO);
    const analytics = buildAnalytics(orders, range);

    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `
Answer this Shopify analytics question using the data.

Question: ${q}

Data:
${JSON.stringify(analytics)}
            `,
          },
        ],
      }),
    });

    const raw = await ai.json();
    const text = raw.content?.[0]?.text || "No answer";

    res.type("text/plain").send(text);
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("Error generating answer");
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});