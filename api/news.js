export default async function handler(req, res) {
  try {
    const q = (req.query.q || "bitcoin").toString().slice(0, 80);

    // Three reputable RSS sources:
    // 1) Reuters: RSS availability varies by region/topic; if your chosen RSS doesn’t work,
    //    swap to AP News RSS or FT RSS as permitted.
    // 2) CoinDesk RSS
    // 3) Cointelegraph RSS
    const feeds = [
      { name: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
      { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
      { name: "Reuters",       url: "https://www.reuters.com/rssFeed/cryptoCurrencyNews" }
    ];

    // Small helper: fetch text
    async function getText(url){
      const r = await fetch(url, { headers: { "user-agent":"swfa2026-proxy" } });
      if(!r.ok) throw new Error(`Feed fetch failed: ${url}`);
      return await r.text();
    }

    // Basic RSS/Atom parse without dependencies (lightweight).
    // If you prefer, I can give you a version using "rss-parser" for cleaner parsing.
    function extractItems(xml, sourceName){
      const items = [];
      const isAtom = /<entry\b/i.test(xml);
      if(isAtom){
        const entries = xml.split(/<entry\b/i).slice(1);
        for(const e of entries){
          const title = (e.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
          const link  = (e.match(/<link[^>]*href="([^"]+)"/i)?.[1] || "").trim();
          const date  = (e.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ||
                        e.match(/<published>([\s\S]*?)<\/published>/i)?.[1] || "").trim();
          const sum   = (e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || "").replace(/<[^>]+>/g,"").trim();
          if(title && link) items.push({ source: sourceName, title, url: link, published: date, snippet: sum.slice(0, 180) });
        }
      } else {
        const blocks = xml.split(/<item\b/i).slice(1);
        for(const b of blocks){
          const title = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
          const link  = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
          const date  = (b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || "").trim();
          const desc  = (b.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || "").replace(/<[^>]+>/g,"").trim();
          if(title && link) items.push({ source: sourceName, title, url: link, published: date, snippet: desc.slice(0, 180) });
        }
      }
      return items;
    }

    const xmls = await Promise.allSettled(feeds.map(f => getText(f.url)));
    let items = [];
    for(let i=0;i<feeds.length;i++){
      if(xmls[i].status === "fulfilled"){
        items = items.concat(extractItems(xmls[i].value, feeds[i].name));
      }
    }

    // Simple relevance filter by keyword string
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    items = items.filter(it => {
      const t = (it.title + " " + (it.snippet||"")).toLowerCase();
      return terms.some(w => t.includes(w));
    });

    // Sort newest first when possible
    items.sort((a,b)=> new Date(b.published||0) - new Date(a.published||0));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ items: items.slice(0, 12) });
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: e.message || "Server error" });
  }
}