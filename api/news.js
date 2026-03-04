// /api/news.js
// Vercel Serverless Function: fetch 3 RSS feeds, parse RSS/Atom, filter by selected asset keywords,
// return JSON for your SWFA 2026 news panel.
//
// Usage (client):
//   https://swfa2026-proxy.vercel.app/api/news?q=bitcoin%20btc
//
// Notes:
// - Uses a tolerant RSS/Atom parser (regex-based) to avoid dependencies.
// - Includes DEBUG payload so you can diagnose blocked feeds / parse issues.
// - Uses synonym-aware filtering (e.g., Binance/BNB/Binance Coin).
// - If filtering yields zero, falls back to returning unfiltered top crypto headlines (never-empty UX).

function parseCutoffISO(cutoffStr){
  // cutoffStr expected "YYYY-MM-DD"
  if(!cutoffStr) return null;
  const d = new Date(cutoffStr + "T23:59:59Z"); // end-of-day UTC
  return isNaN(d.getTime()) ? null : d;
}

function publishedTime(it){
  if(!it?.published) return 0;
  const t = new Date(it.published).getTime();
  return isNaN(t) ? 0 : t;
}

export default async function handler(req, res) {

  const cutoffStr = (req.query.cutoff || "").toString().trim();
  const cutoffDate = parseCutoffISO(cutoffStr);
  
  const cors = () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  if (req.method === "OPTIONS") {
    cors();
    return res.status(204).end();
  }  

  cors();

  try {
    const qRaw = (req.query.q || "bitcoin btc").toString().trim();
    const q = qRaw.slice(0, 120);

    // 3 feeds: choose sources that typically work well from serverless.
    // If any feed fails (403/429), debug will reveal it.
    const feeds = [
      { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
      { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
      { name: "Yahoo Finance (Crypto)", url: "https://finance.yahoo.com/rss/crypto" }
    ];

    // Asset keyword synonyms (match your UI mapping)
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

    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const key = q.toLowerCase().trim();
    const terms2 = synonyms[key] || terms;

    // ---------- helpers ----------
    const stripTags = (s) =>
      (s || "")
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

    const pick = (txt, re) => {
      const m = txt.match(re);
      return m ? m[1].trim() : "";
    };

    const toISOorEmpty = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      return isNaN(dt.getTime()) ? "" : dt.toISOString();
    };

    async function fetchText(url) {
      const r = await fetch(url, {
        headers: {
          // some sites behave better with a UA string
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
            pick(e, /<published[^>]*>([\s\S]*?)<\/published>/i);
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
            pick(b, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
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

    function filterItems(itemsArr, termsArr) {
      if (!termsArr || !termsArr.length) return itemsArr;
      return itemsArr.filter((it) => {
        const hay = ((it.title || "") + " " + (it.snippet || "")).toLowerCase();
        return termsArr.some((w) => hay.includes(w));
      });
    }

    function sortNewest(itemsArr) {
      return itemsArr.sort((a, b) => {
        const ta = a.published ? new Date(a.published).getTime() : 0;
        const tb = b.published ? new Date(b.published).getTime() : 0;
        return tb - ta;
      });
    }

    // ---------- fetch feeds ----------
    const settled = await Promise.allSettled(feeds.map((f) => fetchText(f.url)));

    const debug = {
      q,
      terms: terms2,
      feeds: [],
      totalParsed: 0,
      totalAfterFilter: 0,
      usedFallback: false
    };

    let all = [];

    for (let i = 0; i < feeds.length; i++) {
      const f = feeds[i];
      const s = settled[i];

      if (s.status === "fulfilled") {
        const { ok, status, statusText, text } = s.value;
        debug.feeds.push({ name: f.name, url: f.url, ok, status, statusText });

        if (ok && text) {
          const parsed = parseRSSorAtom(text, f.name);
          all = all.concat(parsed);
        }
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

    // ---------- relevance filter ----------
    let filtered = filterItems(all, terms2);
    debug.totalAfterFilter = filtered.length;

    // Never-empty UX: if no results after filter, show top crypto headlines (unfiltered)
    // so the panel isn't blank.
    if (filtered.length === 0) {
      debug.usedFallback = true;
      filtered = all.slice(); // unfiltered
    }

    filtered = sortNewest(filtered);

    // Sort newest first
    filtered = sortNewest(filtered);

    // If cutoffDate provided, keep only items published <= cutoffDate
    if (cutoffDate) {
      const cutoffMs = cutoffDate.getTime();
      filtered = filtered.filter(it => {
        const t = publishedTime(it);
        // If an item has no valid published date, drop it for cutoff mode
        return t > 0 && t <= cutoffMs;
      });
    }
    
    // Deduplicate by URL
    const seen = new Set();
    const out = [];
    for (const it of filtered) {
      const u = (it.url || "").trim();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(it);
      if (out.length >= 12) break;
    }

    res.status(200).json({ items: out, debug });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Server error" });
  }
}


