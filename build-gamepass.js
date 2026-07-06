/**
 * Sáčkův radar – seznam her aktuálně v PC Game Passu
 * -----------------------------------------------------
 * Node 18+ (globální fetch).   node build-gamepass.js
 *
 * Používá neoficiální, ale veřejně dostupné Microsoft/Xbox API, které stojí
 * za katalogovými weby (trueachievements, xboxgamepass.com apod.):
 *   1) catalog.gamepass.com/sigls/v2  – vrátí ID produktů v daném Game Pass seznamu
 *   2) displaycatalog.mp.microsoft.com – z ID produktů dotáhne názvy her
 *
 * Výstup: gamepass.json → { updatedAt, titles: ["Elden Ring", ...] }
 * (normalizované názvy se pak porovnávají s hrami ze Steamu v ostatních build skriptech)
 */

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "gamepass.json");
// Veřejně známé ID seznamu "PC Game Pass" v Microsoft katalogu.
const PC_GAME_PASS_LIST_ID = "fdd9e2a7-0fee-49f6-ad69-4354098401ff";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function getJson(url, opts) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...(opts?.headers || {}) }, ...opts });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.json();
}

async function fetchListProductIds() {
  const url = `https://catalog.gamepass.com/sigls/v2?id=${PC_GAME_PASS_LIST_ID}&language=en-us&market=US`;
  const j = await getJson(url);
  return (Array.isArray(j) ? j : []).map((x) => x.id).filter(Boolean);
}

async function fetchTitles(ids) {
  const titles = [];
  const BATCH = 20;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${batch.join(",")}&market=US&languages=en-us&MS-CV=DGU1mcuYo0WMMp+F.1`;
    try {
      const j = await getJson(url);
      (j.Products || []).forEach((p) => {
        const title = p?.LocalizedProperties?.[0]?.ProductTitle;
        if (title) titles.push(title);
      });
    } catch (e) {
      console.warn("[gamepass] batch", i, "→", e.message);
    }
  }
  return titles;
}

async function main() {
  console.log("[gamepass] start", new Date().toISOString());
  const ids = await fetchListProductIds();
  console.log(`[gamepass] ${ids.length} her v seznamu PC Game Pass`);
  const titles = await fetchTitles(ids);
  const unique = [...new Set(titles)].sort();
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), titles: unique }, null, 2));
  console.log(`[gamepass] hotovo: ${unique.length} názvů → gamepass.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
