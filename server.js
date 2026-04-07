require("dotenv").config();
const express = require("express");

const app = express();

const SHOP = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const PORT = process.env.PORT || 3000;

async function shopifyQuery(query) {
  const res = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN
    },
    body: JSON.stringify({ query })
  });

  return res.json();
}

app.get("/", (req, res) => {
  res.send("Backend working");
});

app.get("/analytics", async (req, res) => {
  try {
    const query = `
    {
      orders(first: 20) {
        edges {
          node {
            name
            totalPriceSet {
              shopMoney { amount }
            }
          }
        }
      }
    }`;

    const data = await shopifyQuery(query);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});