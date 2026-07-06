/**
 * Sáčkův radar – porovnání doporučeného HW hry s Xbox Ally X
 * ---------------------------------------------------------------
 * Node 18+ (globální fetch).   node build-hwcompare.js
 *
 * Pro každou hru (ze games.json + backlog.json) stáhne ze Steam appdetails
 * doporučenou (nebo když chybí, minimální) konfiguraci, vytáhne z ní název
 * grafiky a procesoru a porovná je s Xbox Ally X (Radeon 890M / Ryzen AI Z2
 * Extreme) přes ruční tabulku tříd výkonu v hw-tiers.js.
 *
 * Výstup: hwcompare.json → { updatedAt, games: [{ title, tier, note, gpu, cpu }] }
 *   tier: "green" (Ally X silnější) | "orange" (±15 %) | "red" (Ally X slabší) | null (nenalezeno)
 */

const fs = require("fs");
const path = require("path");
const { ALLY_X_GPU_SCORE, ALLY_X_CPU_SCORE, matchGpuTier, matchCpuTier } = require("./hw-tiers");
const { normalizeGameTitle } = require("./gamepass-match");

const DIR = __dirname;
const OUT = path.join(DIR, "hwcompare.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DELAY = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, file), "utf-8")); }
  catch { return null; }
}

// Steam appdetails potřebuje appid - starší backlog položky (přidané před tímto polem)
// ho nemají uložený. Nejdřív zkusíme dohledat v aktuálním games.json, a když hra
// mezitím vypadla z jeho 30denního okna, jako poslední záchranu zkusíme živé
// Steam vyhledávání podle názvu (stejné API jako v backlogovém vyhledávání).
async function findAppidBySearch(title) {
  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=us`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const j = await res.json();
    const wanted = normalizeGameTitle(title);
    const hit = (j.items || []).find((it) => normalizeGameTitle(it.name) === wanted) || (j.items || [])[0];
    return hit ? hit.id : null;
  } catch { return null; }
}

async function collectGames() {
  const games = loadJson("games.json");
  const backlog = loadJson("backlog.json") || [];
  const map = new Map(); // appid → {title, appid}
  (games?.games || []).forEach((g) => { if (g.appid) map.set(g.appid, { title: g.name, appid: g.appid }); });
  backlog.filter((b) => b._category === "game" && b.appid).forEach((b) => map.set(b.appid, { title: b.title, appid: b.appid }));

  for (const b of backlog.filter((x) => x._category === "game" && !x.appid)) {
    const g = (games?.games || []).find((x) => normalizeGameTitle(x.name) === normalizeGameTitle(b.title));
    if (g) { map.set(g.appid, { title: g.name, appid: g.appid }); continue; }
    const appid = await findAppidBySearch(b.title);
    await sleep(DELAY);
    if (appid) map.set(appid, { title: b.title, appid });
  }
  return [...map.values()];
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]+>/g, "\n");
}

function extractField(text, label) {
  const re = new RegExp(label + ":\\s*([^\\n]+)", "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

async function fetchRequirements(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic,pc_requirements&cc=us&l=english`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const node = j[appid];
  if (!node?.success || !node.data) return null;
  const req = node.data.pc_requirements;
  if (!req) return null;
  // Recommended je náš cílový styl hraní ("100 % detaily"); když chybí, spadneme na minimum
  const html = (typeof req.recommended === "string" && req.recommended) || (typeof req.minimum === "string" && req.minimum) || "";
  if (!html) return null;
  const text = stripHtml(html);
  return {
    gpu: extractField(text, "Graphics"),
    cpu: extractField(text, "Processor"),
    usedMinimum: !req.recommended,
  };
}

function compare(gpuMatch, cpuMatch) {
  // Grafika rozhoduje hlavně (hry jsou dnes většinou GPU-bound); CPU jen dorovnává hraniční případy.
  if (!gpuMatch) return null;
  const ratio = ALLY_X_GPU_SCORE / gpuMatch.score;
  let tier = ratio >= 1.15 ? "green" : ratio >= 0.85 ? "orange" : "red";
  if (cpuMatch) {
    const cpuRatio = ALLY_X_CPU_SCORE / cpuMatch.score;
    if (cpuRatio < 0.85 && tier === "green") tier = "orange";  // CPU by mohl brzdit i přes silnější grafiku
    if (cpuRatio < 0.7 && tier === "orange") tier = "red";
  }
  return tier;
}

async function main() {
  console.log("[hwcompare] start", new Date().toISOString());
  const games = await collectGames();
  console.log(`[hwcompare] ${games.length} her k porovnání`);

  const out = [];
  for (const { title, appid } of games) {
    try {
      const req = await fetchRequirements(appid);
      if (!req) { console.log(`  ✗ ${title} (bez požadavků na Steamu)`); await sleep(DELAY); continue; }
      const gpuMatch = matchGpuTier(req.gpu);
      const cpuMatch = matchCpuTier(req.cpu);
      const tier = compare(gpuMatch, cpuMatch);
      if (!tier) { console.log(`  ✗ ${title} (grafiku "${req.gpu}" se nepodařilo spárovat)`); await sleep(DELAY); continue; }
      out.push({
        title, tier,
        gpu: req.gpu, cpu: req.cpu,
        usedMinimum: req.usedMinimum,
        note: `${req.usedMinimum ? "Minimální" : "Doporučená"} konfigurace: ${req.gpu || "?"}${req.cpu ? ", " + req.cpu : ""}`,
      });
      console.log(`  ✓ ${title} → ${tier} (${req.gpu})`);
    } catch (e) {
      console.warn(`  ! ${title} →`, e.message);
    }
    await sleep(DELAY);
  }

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), games: out }, null, 2));
  console.log(`[hwcompare] hotovo: ${out.length}/${games.length} her → hwcompare.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
