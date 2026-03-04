// /api/news.js
// Vercel Serverless Function: fetch 3 RSS feeds, parse RSS/Atom, filter by selected asset keywords,
// and (optionally) return an "as-of" snapshot using a cutoff date.
//
// Usage:
//   https://swfa2026-proxy.vercel.app/api/news?q=bitcoin%20btc
//   https://swfa2026-proxy.vercel.app/api/news?q=bitcoin%20btc&cutoff=2026-02-15
//
// Notes:
// - Regex-based RSS/Atom parsing (no deps).
// - Debug payload included for diagnostics.
// - Synonym-aware filtering.
// - Cutoff mode: returns headlines published on or before the cutoff date.
//   If date parsing fails for some items, it will fall back safely to avoid returning an empty list.

function parseCutoffISO(cutoffStr){
  if(!cutoffStr) return null;
  // end-of-day UTC
  const d = new Date(cutoffStr + "T23:59:59Z");
  return isNaN(d.getTime()) ? null : d;
}

function publishedTime(it){
  if(!it?.published) return 0;
  const t = new Date(it.published).getTime();
  return isNaN(t) ? 0 : t;
}

export default async function handler(req, res) {
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

    const cutoffStr = (req.query.cutoff || "").toString().trim();
    const cutoffDate = parseCutoffISO(cutoffStr);

    // Feeds (serverless-friendly)
    const feeds = [
      { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
      { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
      { name: "Yahoo Finance (Crypto)", url: "https://finance.yahoo.com/rss/crypto" }
    ];

    // Asset keyword synonyms
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

    // Robust date normalization: returns ISO string or ""
    function toISOorEmpty(d){
      if(!d) return "";

      // Clean wrappers/spaces
      const s = String(d)
        .replace(/<!\[CDATA\[/g, "")
        .replace(/\]\]>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // Try native parsing
      let dt = new Date(s);
      if(!isNaN(dt.getTime())) return dt.toISOString();

      // Common ISO date without time
      if(/^\d{4}-\d{2}-\d{2}$/.test(s)){
        dt = new Date(s + "T00:00:00Z");
        if(!isNaN(dt.getTime())) return dt.toISOString();
      }

      // Some RSS dates include trailing timezone text oddities; last attempt
      // Remove commas and retry (helps some pubDate variants)
      const s2 = s.replace(/,/g, "");
      dt = new Date(s2);
      if(!isNaN(dt.getTime())) return dt.toISOString();

      return "";
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

          // Capture more date tags (some feeds use updated/published)
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

    function filterItems(itemsArr, termsArr) {
      if (!termsArr || !termsArr.length) return itemsArr;
      return itemsArr.filter((it) => {
        const hay = ((it.title || "") + " " + (it.snippet || "")).toLowerCase();
        return termsArr.some((w) => hay.includes(w));
      });
    }

    function sortNewest(itemsArr) {
      return itemsArr.sort((a, b) => {
        const ta = publishedTime(a);
        const tb = publishedTime(b);
        return tb - ta;
      });
    }

    // ---------- fetch feeds ----------
    const settled = await Promise.allSettled(feeds.map((f) => fetchText(f.url)));

    const debug = {
      q,
      terms: terms2,
      cutoff: cutoffStr || "",
      feeds: [],
      totalParsed: 0,
      totalAfterFilter: 0,
      totalAfterCutoff: 0,
      usedFallback: false,
      cutoffFallbackUsed: false,
      undatedCountParsed: 0
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
    debug.undatedCountParsed = all.filter(it => publishedTime(it) === 0).length;

    // ---------- relevance filter ----------
    let filtered = filterItems(all, terms2);
    debug.totalAfterFilter = filtered.length;

    // Never-empty UX: if no results after relevance filter, show top crypto headlines (unfiltered)
    if (filtered.length === 0) {
      debug.usedFallback = true;
      filtered = all.slice();
    }

    // Sort newest first
    filtered = sortNewest(filtered);

    // ---------- cutoff filter (as-of snapshot) ----------
    if (cutoffDate) {
      const cutoffMs = cutoffDate.getTime();

      // Prefer "dated" items for true as-of
      const dated = filtered.filter(it => publishedTime(it) > 0);
      const byCutoff = dated.filter(it => publishedTime(it) <= cutoffMs);

      if (byCutoff.length > 0) {
        filtered = byCutoff;
      } else {
        // If nothing matches cutoff (often due to feeds not providing parseable dates),
        // fall back to showing the best available items (never blank).
        debug.cutoffFallbackUsed = true;
        filtered = filtered; // keep as-is
      }
    }

    debug.totalAfterCutoff = filtered.length;

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
