export default async function handler(req, res) {
  // Enable CORS so your ariesbank.com page can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Grab query params
  const {
    coin = "bitcoin",
    vs = "usd",
    days = "max",
    interval = "daily"
  } = req.query || {};

  // Your CoinGecko API key will be stored in Vercel as an env var
  const apiKey = process.env.CG_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "missing_api_key",
      hint: "Set CG_KEY in Vercel project environment variables."
    });
  }

  // Build CoinGecko request URL
  const cgUrl =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin)}` +
    `/market_chart?vs_currency=${encodeURIComponent(vs)}` +
    `&days=${encodeURIComponent(days)}` +
    `&interval=${encodeURIComponent(interval)}`;

  try {
    const cgResp = await fetch(cgUrl, {
      headers: {
        "accept": "application/json",
        "User-Agent": "swfa2026-demo",
        "x-cg-demo-api-key": apiKey
        // If you're on a paid CoinGecko plan instead of demo/free,
        // change that header name to:
        // "x-cg-pro-api-key": apiKey
        //
        // and optionally change base URL to:
        // https://pro-api.coingecko.com/api/v3/...
      }
    });

    const textBody = await cgResp.text();

    // Forward CoinGecko status code to the client
    res.status(cgResp.status).setHeader("Content-Type", "application/json");

    // If CoinGecko complained, include that info verbatim
    if (!cgResp.ok) {
      return res.send(
        JSON.stringify({
          error: "coingecko_error",
          status: cgResp.status,
          passthrough: textBody
        })
      );
    }

    // Otherwise send the raw data
    return res.send(textBody);

  } catch (err) {
    return res.status(502).json({
      error: "proxy_failed",
      message: err.message
    });
  }
}
