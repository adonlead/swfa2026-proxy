// /api/news.js
// Vercel Serverless Function
// - Live mode (no cutoff): fetch 3 RSS feeds, parse RSS/Atom, keyword-filter, return latest headlines.
// - Historical mode (cutoff=YYYY-MM-DD): use GDELT 2.1 DOC API to return headlines within
//     [cutoff 00:00:00Z, (cutoff+1 day) 23:59:59Z]
//   This supports "news on that date and the next day" reliably (RSS cannot).
//
// Usage:
//   /api/news?q=bitcoin%20btc
//   /api/news?q=bitcoin%20btc&cutoff=2026-02-15
//
// Notes:
// - No external deps.
// - Debug payload included for diagnostics.
// - For academic integrity: cutoff mode is a historical archive query (GDELT), not RSS.

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function safeStr(x, max = 160) {
  return String(x || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseCutoffWindowUTC(cutoffStr) {
  if (!cutoffStr) return null;
  // cutoffStr expected YYYY-MM-DD from <input type="date">
  const start = new Date(cutoffStr + "T00:00:00Z");
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000 - 1); // +2 days minus 1ms
  return { start, end };
}

function yyyymmddhhmmss(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    dt.getUTCFullYear() +
    pad(dt.getUTCMonth() + 1) +
    pad(dt.getUTCDate()) +
    pad(dt.getUTCHours()) +
    pad(dt.getUTCMinutes()) +
    pad(dt.getUTCSeconds())
  );
}

function stripTags(s) {
  return (s || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(txt, re) {
  const m = txt.match(re);
  return m ? m[1].trim() : "";
}

function toISOorEmpty(d) {
  if (!d) return "";
  const s = String(d)
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  let dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    dt = new Date(s + "T00:00:00Z");
    if (!isNaN(dt.getTime())) return dt.toISOString();
  }

  const s2 = s.replace(/,/g, "");
  dt = new Date(s2);
  if (!isNaN(dt.getTime())) return dt.toISOString();

  return "";
}

function publishedTime(it) {
  if (!it?.published) return 0;
  const t = new Date(it.published).getTime();
  return isNaN(t) ? 0 : t;
}

function dedupeLimit(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const u = (it.url || "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

function filterByTerms(items, terms) {
  if (!terms || !terms.length) return items;
  return items.filter((it) => {
    const hay = ((it.title || "") + " " + (it.snippet || "")).toLowerCase();
    return terms.some((w) => hay.includes(w));
  });
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      "user-agent": "swfa2026-proxy/1.0 (+https://swfa2026-proxy.vercel.app)"
    }
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, statusText: r.statusText, text };
}

function parseRSSorAtom(xml, source) {
  const items = [];
  const lower = xml.toLowerCase();
  const isAtom = lower.includes("<feed") && lower.includes("<entry");
  const isRSS = lower.includes("<rss") || lower.includes("<channel");

  if (isAtom) {
    const entries = xml.split(/<entry\b/i).slice(1);
    for (const e of entries) {
      const title = stripTags(pick(e, /<title[^>]*>([\s\S]*?)<\/title>/i));
      let link = pick(e, /<link[^>]*href="([^"]+)"/i);
      if (!link) link = stripTags(pick(e, /<link[^>]*>([\s\S]*?)<\/link>/i));

      const date =
        pick(e, /<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
        pick(e, /<published[^>]*>([\s\S]*?)<\/published>/i) ||
        pick(e, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);

      const summary =
        stripTags(pick(e, /<summary[^>]*>([\s\S]*?)<\/summary>/i)) ||
        stripTags(pick(e, /<content[^>]*>([\s\S]*?)<\/content>/i));

      if (title && link) {
        items.push({
          source,
          title,
          url: link,
          published: toISOorEmpty(date),
          snippet: summary.slice(0, 220)
        });
      }
    }
  } else if (isRSS) {
    const blocks = xml.split(/<item\b/i).slice(1);
    for (const b of blocks) {
      const title = stripTags(pick(b, /<title[^>]*>([\s\S]*?)<\/title>/i));
      const link =
        stripTags(pick(b, /<link[^>]*>([\s\S]*?)<\/link>/i)) ||
        stripTags(pick(b, /<guid[^>]*>([\s\S]*?)<\/guid>/i));

      const date =
        pick(b, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
        pick(b, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) ||
        pick(b, /<published[^>]*>([\s\S]*?)<\/published>/i) ||
        pick(b, /<updated[^>]*>([\s\S]*?)<\/updated>/i);

      const desc =
        stripTags(pick(b, /<description[^>]*>([\s\S]*?)<\/description>/i)) ||
        stripTags(pick(b, /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i));

      if (title && link) {
        items.push({
          source,
          title,
          url: link,
          published: toISOorEmpty(date),
          snippet: desc.slice(0, 220)
        });
      }
    }
  }

  return items;
}

// GDELT historical (cutoff mode)
async function fetchGdelt(qTerms, windowUTC) {
  // Build a query that increases relevance but still broad enough
  // Example qTerms: ["bitcoin","btc"]
  const query = safeStr(qTerms.join(" OR "), 180);

  const start = yyyymmddhhmmss(windowUTC.start);
  const end = yyyymmddhhmmss(windowUTC.end);

  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc" +
    `?query=${encodeURIComponent(query)}` +
    "&mode=ArtList" +
    "&format=json" +
    "&maxrecords=50" +
    `&startdatetime=${start}` +
    `&enddatetime=${end}` +
    "&sort=datedesc";

  const r = await fetch(url, {
    headers: { "user-agent": "swfa2026-proxy/1.0 (+https://swfa2026-proxy.vercel.app)" }
  });
  const data = await r.json().catch(() => ({}));

  return { ok: r.ok, status: r.status, data, url };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    return res.status(204).end();
  }
  cors(res);

  try {
    const qRaw = safeStr(req.query.q || "bitcoin btc", 120);
    const cutoffStr = safeStr(req.query.cutoff || "", 32);

    // Synonyms map (match your UI mapping)
    const synonyms = {
      "bitcoin btc": ["bitcoin", "btc"],
      "ethereum eth": ["ethereum", "eth"],
      "solana sol": ["solana", "sol"],
      "cardano ada": ["cardano", "ada"],
      "dogecoin doge": ["dogecoin", "doge"],
      "binance bnb": ["binance", "bnb", "binance coin", "bnb chain"],
      "ripple xrp": ["ripple", "xrp"],
      "polkadot dot": ["polkadot", "dot"],
      "litecoin ltc": ["litecoin", "ltc"]
    };

    const key = qRaw.toLowerCase().trim();
    const terms = (synonyms[key] || qRaw.toLowerCase().split(/\s+/).filter(Boolean))
      .map(t => t.trim())
      .filter(Boolean);

    const debug = {
      q: qRaw,
      terms,
      cutoff: cutoffStr || "",
      mode: cutoffStr ? "historical_gdelt" : "live_rss",
      feeds: [],
      gdelt: null,
      totalParsed: 0,
      totalAfterFilter: 0,
      totalAfterCutoff: 0,
      usedFallback: false,
      note: ""
    };

    // ----------------------------
    // Historical mode (cutoff) -> GDELT
    // ----------------------------
    if (cutoffStr) {
      const windowUTC = parseCutoffWindowUTC(cutoffStr);
      if (!windowUTC) {
        debug.note = "Invalid cutoff date. Use YYYY-MM-DD.";
        return res.status(200).json({ items: [], debug });
      }

      const gd = await fetchGdelt(terms, windowUTC);
      debug.gdelt = {
        ok: gd.ok,
        status: gd.status,
        queryUrl: gd.url,
        windowStartUTC: windowUTC.start.toISOString(),
        windowEndUTC: windowUTC.end.toISOString()
      };

      if (!gd.ok) {
        debug.note = "GDELT request failed.";
        return res.status(200).json({ items: [], debug });
      }

      const arts = gd.data?.articles || [];
      // Convert to your UI schema
      let items = arts.map(a => ({
        source: a.sourceCountry
          ? `GDELT (${a.sourceCountry})`
          : "GDELT",
        title: safeStr(a.title || "", 220),
        url: safeStr(a.url || "", 600),
        published: a.seendate ? toISOorEmpty(a.seendate) : "",
        snippet: safeStr(a.snippet || a.description || "", 220)
      }));

      // Optional extra filter (keep relevance high)
      items = filterByTerms(items, terms);

      debug.totalParsed = arts.length;
      debug.totalAfterFilter = items.length;

      // In cutoff mode, ONLY show within the window (GDELT already does, but keep safe)
      const startMs = windowUTC.start.getTime();
      const endMs = windowUTC.end.getTime();
      items = items.filter(it => {
        const t = publishedTime(it);
        return t > 0 && t >= startMs && t <= endMs;
      });
      debug.totalAfterCutoff = items.length;

      // Sort newest first and dedupe
      items.sort((a,b)=> publishedTime(b) - publishedTime(a));
      items = dedupeLimit(items, 12);

      if (items.length === 0) {
        debug.note =
          `No archived headlines matched for ${cutoffStr} to ${windowUTC.end.toISOString().slice(0,10)}. ` +
          `Try broader keywords (e.g., "bitcoin") or remove ticker-only terms.`;
      }

      return res.status(200).json({ items, debug });
    }

    // ----------------------------
    // Live mode (no cutoff) -> RSS
    // ----------------------------
    const feeds = [
      { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
      { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
      { name: "Yahoo Finance (Crypto)", url: "https://finance.yahoo.com/rss/crypto" }
    ];

    const settled = await Promise.allSettled(feeds.map((f) => fetchText(f.url)));

    let all = [];
    for (let i = 0; i < feeds.length; i++) {
      const f = feeds[i];
      const s = settled[i];
      if (s.status === "fulfilled") {
        const { ok, status, statusText, text } = s.value;
        debug.feeds.push({ name: f.name, url: f.url, ok, status, statusText });
        if (ok && text) all = all.concat(parseRSSorAtom(text, f.name));
      } else {
        debug.feeds.push({
          name: f.name,
          url: f.url,
          ok: false,
          status: 0,
          statusText: String(s.reason?.message || s.reason || "fetch failed")
        });
      }
    }

    debug.totalParsed = all.length;

    let filtered = filterByTerms(all, terms);
    debug.totalAfterFilter = filtered.length;

    // Never-empty UX in LIVE mode only
    if (filtered.length === 0) {
      debug.usedFallback = true;
      filtered = all.slice();
    }

    filtered.sort((a,b)=> publishedTime(b) - publishedTime(a));
    const items = dedupeLimit(filtered, 12);

    if (items.length === 0) {
      debug.note = "No headlines returned. Try Refresh.";
    }

    return res.status(200).json({ items, debug });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
