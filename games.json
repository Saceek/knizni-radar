/**
 * Knižní radar – Steam: nově vyšlé hry s vysokým hodnocením
 * ---------------------------------------------------------
 * Node 18+ (globální fetch). Závislost: cheerio.   node build-games.js
 *
 *  - seznam: store.steampowered.com/search/results/  (filtr category1=998 + tags=<id>, sort Released_DESC)
 *  - hodnocení: store.steampowered.com/appreviews/<appid>  → % kladných z query_summary
 *  - obrázek: cdn.cloudflare.steamstatic.com/steam/apps/<appid>/header.jpg
 *  - výstup games.json se 30denním oknem; frontend si pak filtruje 7/14/30 dní
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "games.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DELAY = 500;

const WINDOW_DAYS = 30;   // build okno (frontend pak zužuje na 7/14/30)
const MIN_RATING = 85;    // % kladných recenzí
const MIN_REVIEWS = 30;   // ať 85 % není ze tří recenzí (lze zvednout na 100)

// tag ID → české jméno pro zobrazení
const TAGS = [
  { id: 1628, name: "Metroidvania" },
  { id: 19,   name: "Akční" },
  { id: 21,   name: "Dobrodružné" },
  { id: 9,    name: "Strategické" },
  { id: 1663, name: "FPS" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
// "5 Jun, 2026" / "Jun 5, 2026" / "Jun 2026"  → Date (UTC). Bez měsíce nebo "Coming soon" → null.
function parseReleased(s) {
  if (!s) return null;
  const ym = s.match(/\b(20\d{2})\b/); if (!ym) return null;
  const mm = s.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (!mm) return null;                                  // jen rok / TBA / Coming soon → přeskoč
  const dm = s.match(/\b(\d{1,2})\b/);
  const day = dm ? parseInt(dm[1], 10) : 1;
  const d = new Date(Date.UTC(+ym[1], MONTHS[mm[1]], day));
  return isNaN(d.getTime()) ? null : d;
}

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

// vrátí HTML s řádky výsledků (search/results vrací JSON {results_html} při infinite=1)
async function searchRowsHtml(tagId) {
  const url = `https://store.steampowered.com/search/results/?query=&start=0&count=100`
    + `&dynamic_data=&sort_by=Released_DESC&category1=998&tags=${tagId}`
    + `&supportedlang=&ndl=1&infinite=1&l=english&cc=us`;
  const text = await getText(url);
  try { const j = JSON.parse(text); if (j && j.results_html) return j.results_html; } catch (_) {}
  return text; // fallback: kdyby přišlo rovnou HTML
}

async function fetchRating(appid) {
  try {
    const text = await getText(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`);
    const j = JSON.parse(text);
    const q = j && j.query_summary;
    if (!q || !q.total_reviews) return null;
    return { rating: Math.round((q.total_positive / q.total_reviews) * 100), reviews: q.total_reviews, desc: q.review_score_desc || null };
  } catch (e) { console.warn("[reviews]", appid, "→", e.message); return null; }
}

// z URL kapsle v řádku odvodí header.jpg (zachová správný host i ?t= cache-bust); jinak fallback
function headerImage(rawImg, appid) {
  if (rawImg && /\/capsule[^/?]*\.(jpg|png)/i.test(rawImg)) return rawImg.replace(/\/capsule[^/?]*\.(jpg|png)/i, "/header.jpg");
  if (rawImg) return rawImg;
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
}

async function main() {
  console.log("[games] start", new Date().toISOString());
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * 86400000;
  const cand = new Map(); // appid → { name, released(ISO), tags:Set }

  for (const t of TAGS) {
    let html = "";
    try { html = await searchRowsHtml(t.id); } catch (e) { console.warn(`[tag ${t.name}]`, e.message); }
    const $ = cheerio.load(html);
    let inWin = 0;
    $("a.search_result_row[data-ds-appid]").each((_, el) => {
      const appid = ($(el).attr("data-ds-appid") || "").split(",")[0].trim();
      if (!appid) return;
      const name = $(el).find(".title").first().text().trim();
      const d = parseReleased($(el).find(".search_released").first().text().trim());
      if (!d) return;
      const ms = d.getTime();
      if (ms > now + 86400000 || ms < cutoff) return;     // budoucí (coming soon) nebo starší než okno
      const img = $(el).find("img").first();
      const rawImg = img.attr("src") || img.attr("data-src") || null;  // aktuální URL z řádku (i pro novější hry)
      if (!cand.has(appid)) cand.set(appid, { name, released: d.toISOString(), tags: new Set(), img: rawImg });
      cand.get(appid).tags.add(t.name);
      inWin++;
    });
    console.log(`[tag ${t.name}] v okně: ${inWin}`);
    await sleep(DELAY);
  }

  console.log(`[games] unikátních kandidátů: ${cand.size}, dotahuji hodnocení…`);
  const games = [];
  for (const [appid, info] of cand) {
    const r = await fetchRating(appid);
    await sleep(DELAY);
    if (!r) continue;
    if (r.rating < MIN_RATING || r.reviews < MIN_REVIEWS) continue;
    games.push({
      appid: +appid,
      name: info.name,
      rating: r.rating,
      reviews: r.reviews,
      scoreDesc: r.desc,
      released: info.released,
      tags: [...info.tags],
      image: headerImage(info.img, appid),
      url: `https://store.steampowered.com/app/${appid}/`,
    });
  }

  games.sort((a, b) => Date.parse(b.released) - Date.parse(a.released) || b.rating - a.rating);
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), games }, null, 2));
  console.log(`[games] hotovo: ${games.length} her (≥${MIN_RATING} %, ≥${MIN_REVIEWS} recenzí) → games.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
