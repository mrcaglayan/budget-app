// routes/productPreview.js
const express = require("express");
const router = express.Router();

/**
 * Fetch that works on Node 18+ (global fetch) and Node 16 (node-fetch).
 * If you're on Node 16, run:  npm i node-fetch
 */
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}
async function xfetch(url, opts = {}) {
  const headers = {
    "user-agent": "product-preview/1.0 (+https://localhost)",
    ...(opts.headers || {}),
  };
  return _fetch(url, { ...opts, headers });
}

// ---- tiny in-memory cache ----
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map(); // q -> { t, data }

function buildFallback(q) {
  // Always return something useful (no outbound HTTP needed)
  return {
    title: q,
    snippet: "",
    link: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    source: "fallback",
    // A generic, externally hosted image — avoids your server fetching it
    image: `https://source.unsplash.com/480x320/?${encodeURIComponent(q)},food`,
    price: null,
  };
}

router.get("/product/preview", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing q" });

  try {
    // Serve from cache if warm
    const now = Date.now();
    const hit = cache.get(q);
    if (hit && now - hit.t < CACHE_TTL_MS) return res.json(hit.data);

    // 1) Try OpenFoodFacts (no API key)
    const off = await searchOpenFoodFacts(q);
    if (off) {
      cache.set(q, { t: now, data: off });
      return res.json(off);
    }

    // 2) Fallback to Wikipedia (TR first, then EN)
    const wiki = await searchWikipedia(q, ["tr", "en"]);
    if (wiki) {
      cache.set(q, { t: now, data: wiki });
      return res.json(wiki);
    }

    // 3) Final fallback (always 200)
    const fb = buildFallback(q);
    cache.set(q, { t: now, data: fb });
    return res.json(fb);
  } catch (e) {
    console.error("product/preview error:", e);
    // Still return a 200 with a generic fallback, so the UI never breaks
    return res.json(buildFallback(q));
  }
});

module.exports = router;

// ---------- Providers ----------

async function searchOpenFoodFacts(query) {
  const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
  url.searchParams.set("search_terms", query);
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  url.searchParams.set("page_size", "5");

  let resp;
  try {
    resp = await xfetch(url.toString());
  } catch (e) {
    console.error("OFF fetch failed:", e);
    return null;
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("OFF HTTP error:", resp.status, txt?.slice?.(0, 200));
    return null;
  }

  const json = await resp.json().catch((err) => {
    console.error("OFF JSON parse error:", err);
    return null;
  });
  if (!json) return null;

  const products = Array.isArray(json.products) ? json.products : [];
  if (!products.length) return null;

  // Prefer an item with an image
  const p = products.find(x => x.image_front_url || x.image_url) || products[0];

  const title = p.product_name || p.generic_name || p.categories || query;

  const bits = [];
  if (p.brands) bits.push(p.brands);
  if (p.quantity) bits.push(p.quantity);
  if (p.categories) bits.push(p.categories.split(",").slice(0, 2).join(", ").trim());
  const nutri = p.nutrition_grades ? `Nutriscore: ${String(p.nutrition_grades).toUpperCase()}` : null;
  const snippet = [bits.filter(Boolean).join(" • "), nutri].filter(Boolean).join(" • ");

  const link = p.url || (p.code ? `https://world.openfoodfacts.org/product/${p.code}` : null);
  const image = p.image_front_small_url || p.image_front_url || p.image_url || null;

  return { title, snippet, link, source: "OpenFoodFacts", image, price: null };
}

async function searchWikipedia(query, langs = ["tr", "en"]) {
  for (const lang of langs) {
    try {
      // 1) find page title
      const searchURL = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      searchURL.searchParams.set("format", "json");
      searchURL.searchParams.set("action", "query");
      searchURL.searchParams.set("list", "search");
      searchURL.searchParams.set("srlimit", "1");
      searchURL.searchParams.set("srsearch", query);

      const sResp = await xfetch(searchURL.toString());
      if (!sResp.ok) continue;
      const sJson = await sResp.json().catch(() => null);
      const hit = sJson?.query?.search?.[0];
      if (!hit?.title) continue;

      // 2) summary + thumbnail
      const titleEncoded = encodeURIComponent(hit.title);
      const sumURL = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${titleEncoded}`;
      const sumResp = await xfetch(sumURL);
      if (!sumResp.ok) continue;
      const sum = await sumResp.json().catch(() => null);
      if (!sum) continue;

      return {
        title: sum.title || query,
        snippet: sum.extract || "",
        link: sum.content_urls?.desktop?.page || null,
        source: lang === "tr" ? "Vikipedi" : "Wikipedia",
        image: sum.thumbnail?.source || null,
        price: null,
      };
    } catch (e) {
      // Try the next language
      console.warn(`Wikipedia ${lang} provider failed:`, e?.message || e);
      continue;
    }
  }
  return null;
}
