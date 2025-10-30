// api/coingecko.js
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = req.query || {};
  const coin = q.coin || "bitcoin";
  const vs = q.vs || "usd";
  const days = q.days || "max";
  const interval = q.interval || "daily";

  const apiKey = process.env.CG_KEY;
  if (!apiKey) return res.status(500).json({ error: "missing_api_key" });

  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin)}` +
    `/market_chart?vs_currency=${encodeURIComponent(vs)}` +
    `&days=${encodeURIComponent(days)}&interval=${encodeURIComponent(interval)}`;

  try {
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        "User-Agent": "swfa2026-demo",
        "x-cg-demo-api-key": apiKey
        // if Pro plan: use "x-cg-pro-api-key"
        // and optionally base URL https://pro-api.coingecko.com/api/v3/...
      }
    });
    const body = await r.text();
    res.status(r.status).setHeader("Content-Type", "application/json").send(body);
  } catch (e) {
    res.status(502).json({ error: "proxy_failed", message: e.message });
  }
};
