/**
 * Sáčkův radar – Steam: nově vyšlé hry s vysokým hodnocením (všechny kategorie)
 * ----------------------------------------------------------------------------
 * Node 18+ (globální fetch). Závislost: cheerio.   node build-games.js
 *
 *  - seznam: store.steampowered.com/search/results/  (category1=998, sort Released_DESC, BEZ filtru tagů)
 *  - hodnocení + počet recenzí: ze souhrnu recenzí přímo v řádku výsledků (tooltip) → levné, bez tisíců API volání
 *  - jen pro hry, co projdou prahem: appdetails → žánry (česky), cena v Kč, obrázek, typ
 *  - obrázek: header_image z appdetails, host přepsán na cloudflare (akamai varianta v prohlížeči vrací 404)
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "games.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DELAY = 450;

const WINDOW_DAYS = 30;   // build okno (frontend pak zužuje na 7/14/30)
const MIN_RATING = 85;    // % kladných recenzí
const MIN_REVIEWS = 30;   // ať 85 % není ze tří recenzí
const PAGE = 100;
const MAX_PAGES = 25;     // pojistka (Steam stejně výsledky shora omezuje)
const MAX_CAND = 300;     // strop kandidátů → strop appdetails volání

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseReleased(s) {
  if (!s) return null;
  const ym = s.match(/\b(20\d{2})\b/); if (!ym) return null;
  const mm = s.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (!mm) return null;
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

async function searchPage(start) {
  const url = `https://store.steampowered.com/search/results/?query=&start=${start}&count=${PAGE}`
    + `&dynamic_data=&sort_by=Released_DESC&category1=998`
    + `&supportedlang=&ndl=1&infinite=1&l=english&cc=us`;
  const text = await getText(url);
  try { const j = JSON.parse(text); if (j && j.results_html) return j.results_html; } catch (_) {}
  return text;
}

// appdetails: typ, jméno, obrázek, žánry (česky), cena v Kč
async function fetchDetails(appid) {
  try {
    const text = await getText(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic,genres,price_overview&l=czech&cc=cz`);
    const j = JSON.parse(text);
    const node = j && j[appid];
    if (!node || !node.success || !node.data) return null;
    const d = node.data;
    return {
      type: d.type || null,
      name: d.name || null,
      header: d.header_image || null,
      genres: (d.genres || []).map((g) => g.description).filter(Boolean),
      price: d.is_free ? "Zdarma" : ((d.price_overview && d.price_overview.final_formatted) || null),
    };
  } catch (e) { console.warn("[details]", appid, "→", e.message); return null; }
}

async function main() {
  console.log("[games] start", new Date().toISOString());
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * 86400000;
  const cand = new Map(); // appid → { name, released(ISO), rating, reviews, desc }
  let rowsSeen = 0, withReview = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    let html = "";
    try { html = await searchPage(p * PAGE); } catch (e) { console.warn("[search]", e.message); break; }
    const $ = cheerio.load(html);
    const rows = $("a.search_result_row[data-ds-appid]");
    if (rows.length === 0) break;
    let stop = false;

    rows.each((_, el) => {
      const appid = ($(el).attr("data-ds-appid") || "").split(",")[0].trim();
      if (!appid) return;
      const d = parseReleased($(el).find(".search_released").first().text().trim());
      if (!d) return;                                   // coming soon / bez data
      const ms = d.getTime();
      if (ms > now + 86400000) return;                  // budoucí → přeskoč (řadí se nahoře)
      if (ms < cutoff) { stop = true; return false; }   // starší než okno → konec (řazeno sestupně)
      rowsSeen++;

      // souhrn recenzí z tooltipu: "Very Positive<br>92% of the 1,234 user reviews ..."
      let tip = "";
      $(el).find("[data-tooltip-html]").each((__, t) => {
        const h = $(t).attr("data-tooltip-html") || "";
        if (/% of the/i.test(h)) { tip = h; return false; }
      });
      if (!tip) return;
      withReview++;
      const pct = (tip.match(/(\d{1,3})%/) || [])[1];
      const cntRaw = (tip.match(/of the ([\d.,\s]+) user reviews/i) || [])[1];
      if (!pct || !cntRaw) return;
      const rating = +pct;
      const reviews = parseInt(cntRaw.replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(reviews)) return;
      if (rating < MIN_RATING || reviews < MIN_REVIEWS) return;

      const name = $(el).find(".title").first().text().trim();
      const desc = tip.split("<br>")[0].trim();
      if (!cand.has(appid) && cand.size < MAX_CAND)
        cand.set(appid, { name, released: d.toISOString(), rating, reviews, desc });
    });

    console.log(`[search] strana ${p + 1}: ${rows.length} řádků, kandidátů zatím ${cand.size}`);
    if (stop || cand.size >= MAX_CAND) break;
    await sleep(DELAY);
  }

  console.log(`[games] v okně viděno ${rowsSeen} her, z toho ${withReview} se souhrnem recenzí; kandidátů ${cand.size}. Dotahuji detaily…`);
  const games = [];
  for (const [appid, info] of cand) {
    const det = await fetchDetails(appid);
    await sleep(DELAY);
    if (det && det.type && det.type !== "game") continue;   // pryč DLC / soundtrack / demo
    games.push({
      appid: +appid,
      name: (det && det.name) || info.name,
      rating: info.rating,
      reviews: info.reviews,
      scoreDesc: info.desc || null,
      released: info.released,
      tags: (det && det.genres && det.genres.length) ? det.genres : [],
      price: (det && det.price) || null,
      image: (det && det.header)
        ? det.header.replace("shared.akamai.steamstatic.com", "shared.cloudflare.steamstatic.com")
        : `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      url: `https://store.steampowered.com/app/${appid}/`,
    });
  }

  games.sort((a, b) => b.reviews - a.reviews || b.rating - a.rating);
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), games }, null, 2));
  console.log(`[games] hotovo: ${games.length} her (≥${MIN_RATING} %, ≥${MIN_REVIEWS} recenzí, všechny kategorie) → games.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
