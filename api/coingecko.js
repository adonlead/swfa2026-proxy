// api/coingecko.js
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = req.query || {};
  const coin = q.coin || "bitcoin";
  const vs = q.vs || "usd";
  let days = (q.days || "365").toString().toLowerCase();
  const interval = q.interval || "daily";

  if (days === "max") days = "365";
  if (/^\d+$/.test(days) && parseInt(days,10) > 365) days = "365";

  const apiKey = process.env.CG_KEY;
  if (!apiKey) return res.status(500).json({ error: "missing_api_key" });

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin)}/market_chart?vs_currency=${encodeURIComponent(vs)}&days=${days}&interval=${encodeURIComponent(interval)}`;

  try {
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        "User-Agent": "swfa2026-demo",
        "x-cg-demo-api-key": apiKey
      }
    });
    const body = await r.text();
    return res.status(r.status).setHeader("Content-Type","application/json").send(body);
  } catch (e) {
    return res.status(502).json({ error: "proxy_failed", message: e.message });
  }
};
