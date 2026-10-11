/**
 * Sáčkův radar – Metacritic: nejlépe hodnocené hry, filmy a seriály posledních 3 let
 * ------------------------------------------------------------------------------------
 * Node 18+ (globální fetch), bez závislostí.   node build-metacritic.js
 *
 *  - zdroj: metacritic.com/browse/{game|movie|tv}/all/all/{rok}/ (řazeno dle Metascore)
 *  - Metacritic nemá veřejné API; data jsou v Nuxt payloadu stránky (<script id="__NUXT_DATA__">,
 *    pole s odkazy přes indexy) – stránkuje se, dokud nepřijde titul pod MIN_SCORE
 *  - obrázky: zmenšená verze (podepsaná /a/img/resize/<hash>/… URL ze stránky), originál jen záložně
 *  - když Metacritic nevrátí nic (změna stránky, blokace), zůstanou poslední dobrá data
 *
 * Výstup: metacritic.json → { updatedAt, minScore, years: { "2026": { games:[], movies:[], tv:[] }, … } }
 */

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "metacritic.json");
const MIN_SCORE = 85;
const MAX_PAGES = 15;
const CATS = { games: "game", movies: "movie", tv: "tv" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nuxt payload: pole, kde objekty a pole odkazují na další položky indexem
function revive(arr) {
  const cache = new Map();
  const r = (i) => {
    if (typeof i !== "number") return i;
    if (cache.has(i)) return cache.get(i);
    const v = arr[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && ["Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "NuxtError"].includes(v[0])) {
        const o = r(v[1]); cache.set(i, o); return o;
      }
      if (v[0] === "Set" || v[0] === "Map") { cache.set(i, null); return null; }
      const out = []; cache.set(i, out); v.forEach((x) => out.push(r(x))); return out;
    }
    if (v && typeof v === "object") { const o = {}; cache.set(i, o); for (const k in v) o[k] = r(v[k]); return o; }
    cache.set(i, v); return v;
  };
  return r(0);
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("chybí __NUXT_DATA__");
  const root = revive(JSON.parse(m[1]));
  const items = [], seen = new Set();
  (function walk(o, d) {
    if (!o || typeof o !== "object" || d > 40 || seen.has(o)) return;
    seen.add(o);
    if (o.title && o.slug && o.criticScoreSummary) items.push(o);
    for (const k in o) walk(o[k], d + 1);
  })(root, 0);
  // zmenšené obrázky (192×288) – podpis je v HTML u každé karty
  const thumbs = new Map();
  for (const t of html.matchAll(/\/a\/img\/resize\/[0-9a-f]+\/catalog(\/provider\/[^?"']+)\?[^"'\s]*width=192/g)) {
    thumbs.set(t[1], "https://www.metacritic.com" + t[0].replace(/&amp;/g, "&"));
  }
  return { items, thumbs };
}

function toItem(x, thumbs) {
  const c = x.criticScoreSummary || {};
  const bucket = x.image && x.image.bucketPath;
  return {
    title: x.title,
    url: "https://www.metacritic.com" + (c.url || "").replace("critic-reviews/", ""),
    score: c.score,
    reviews: c.reviewCount || 0,
    positive: c.positiveCount || 0, mixed: c.neutralCount || 0, negative: c.negativeCount || 0,
    sentiment: c.sentiment || null,
    userScore: x.userScore && x.userScore.score != null ? x.userScore.score : null,
    released: x.releaseDate || null,
    genres: (x.genres || []).map((g) => g.name).filter(Boolean).slice(0, 2),
    platforms: [...new Set((x.platforms || []).map((p) => p.name))],
    image: bucket ? (thumbs.get(bucket) || "https://www.metacritic.com/a/img/catalog" + bucket) : null,
    imageFull: bucket ? "https://www.metacritic.com/a/img/catalog" + bucket : null,
    desc: (x.description || "").replace(/\s+/g, " ").trim().slice(0, 260) || null,
  };
}

async function fetchCategory(slug, year) {
  const list = [], seen = new Set();
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `https://www.metacritic.com/browse/${slug}/all/all/${year}/` + (p > 1 ? `?page=${p}` : "");
    const { items, thumbs } = await fetchPage(url);
    if (!items.length) break;
    let below = false;
    for (const x of items) {
      const s = x.criticScoreSummary && x.criticScoreSummary.score;
      if (s == null || s < MIN_SCORE) { below = true; continue; }
      if (seen.has(x.slug)) continue;
      seen.add(x.slug);
      list.push(toItem(x, thumbs));
    }
    await sleep(900);
    if (below) break;
  }
  return list;
}

async function main() {
  console.log("[metacritic] start", new Date().toISOString());
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf-8")); } catch { /* první běh */ }
  const now = new Date().getFullYear();
  const years = {};
  let fresh = 0;
  for (const year of [now, now - 1, now - 2]) {
    years[year] = {};
    for (const [key, slug] of Object.entries(CATS)) {
      let list = [];
      try { list = await fetchCategory(slug, year); }
      catch (e) { console.warn(`  ! ${year} ${key}: ${e.message}`); }
      const old = prev && prev.years && prev.years[year] && prev.years[year][key];
      if (!list.length && old && old.length) { list = old; console.log(`  = ${year} ${key}: nic nestaženo, ponechávám ${old.length} z minula`); }
      else { fresh += list.length; console.log(`  ✓ ${year} ${key}: ${list.length} titulů ${MIN_SCORE}+`); }
      years[year][key] = list;
    }
  }
  if (!fresh) {
    console.error("[metacritic] nic se nestáhlo — metacritic.json ponechán beze změny");
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), minScore: MIN_SCORE, years }, null, 2));
  console.log(`[metacritic] hotovo → metacritic.json (${fresh} titulů)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
