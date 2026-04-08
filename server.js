require("dotenv").config();
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

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

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${text}`);
  }

  const data = JSON.parse(text);

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data;
}

app.get("/", (_req, res) => {
  res.send("Backend working");
});

app.get("/analytics", async (_req, res) => {
  try {
    const query = `
    {
      orders(first: 50, reverse: true) {
        edges {
          node {
            name
            createdAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customer {
              id
              email
            }
            lineItems(first: 20) {
              edges {
                node {
                  title
                  quantity
                }
              }
            }
          }
        }
      }
    }`;

    const result = await shopifyQuery(query);
    const orders = result.data.orders.edges.map(e => e.node);

    let totalRevenue = 0;
    let currency = "USD";
    const customerCounts = {};
    const productCounts = {};

    for (const order of orders) {
      const amount = parseFloat(order.totalPriceSet?.shopMoney?.amount || 0);
      currency = order.totalPriceSet?.shopMoney?.currencyCode || currency;
      totalRevenue += amount;

      if (order.customer?.id) {
        customerCounts[order.customer.id] = (customerCounts[order.customer.id] || 0) + 1;
      }

      for (const edge of order.lineItems.edges) {
        const title = edge.node.title;
        const qty = edge.node.quantity;
        productCounts[title] = (productCounts[title] || 0) + qty;
      }
    }

    const repeatCustomers = Object.values(customerCounts).filter(count => count > 1).length;
    const uniqueCustomers = Object.keys(customerCounts).length;

    const bestProducts = Object.entries(productCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([title, quantitySold]) => ({ title, quantitySold }));

    const recentOrders = orders.slice(0, 10).map(order => ({
      orderName: order.name,
      createdAt: order.createdAt,
      amount: parseFloat(order.totalPriceSet?.shopMoney?.amount || 0),
      customerEmail: order.customer?.email || null
    }));

    res.json({
      summary: {
        totalOrders: orders.length,
        totalRevenue: Number(totalRevenue.toFixed(2)),
        currency,
        uniqueCustomers,
        repeatCustomers
      },
      bestProducts,
      recentOrders
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});