/**
 * Sáčkův radar – odehraný čas a achievementy (Steam + Xbox / PC Game Pass)
 * -------------------------------------------------------------------------
 * Node 18+ (globální fetch), bez závislostí.   node build-playtime.js
 *
 *  - Steam: IPlayerService/GetOwnedGames (playtime_forever v minutách, poslední hraní)
 *    + ISteamUserStats/GetPlayerAchievements pro hry z Mého seznamu a Aktivních questů.
 *    Env: STEAM_API_KEY, STEAM_ID64.
 *  - Xbox: OpenXBL (xbl.io, hlavička X-Authorization) – historie titulů s achievementy
 *    a u sledovaných her i statistika MinutesPlayed (pokud ji API vrátí). Env: XBL_API_KEY.
 *  Bez klíčů se daná část přeskočí a zůstanou data z minula.
 *
 * Výstup: playtime.json → { updatedAt, steam: { <normalizovaný název>: { appid, title, min,
 *   last, ach? } }, xbox: { <normalizovaný název>: { titleId, title, min?, last, ach? } } }
 *   ach = { done, total }
 */

const fs = require("fs");
const path = require("path");
const { normalizeGameTitle } = require("./gamepass-match");

const DIR = __dirname;
const OUT = path.join(DIR, "playtime.json");
const MAX_ACH_CALLS = 40;      // achievementy jen pro sledované hry
const MAX_XBL_STATS = 15;      // OpenXBL free tier ~150 dotazů / h
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf-8")); } catch { return null; } };
const appidFromUrl = (u) => ((u || "").match(/store\.steampowered\.com\/app\/(\d+)/) || [])[1] || null;
const key = (s) => normalizeGameTitle(String(s || "").replace(/['’`]/g, ""));

// hry, které sleduju: Můj seznam + Aktivní questy
function trackedGames() {
  const list = [];
  (loadJson("backlog.json") || []).filter((b) => b._category === "game").forEach((b) => list.push({ title: b.title, appid: b.appid || appidFromUrl(b.url) }));
  const prog = loadJson("progress.json") || {};
  for (const k of ["game_pc", "game_ps5", "game_nsw2", "game"]) if (prog[k] && prog[k].title) list.push({ title: prog[k].title, appid: appidFromUrl(prog[k].url) });
  return list;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.replace(/key=[^&]+/, "key=***")}`);
  return r.json();
}

async function steam(prev, tracked) {
  const apiKey = process.env.STEAM_API_KEY, sid = process.env.STEAM_ID64;
  if (!apiKey || !sid) { console.log("[playtime] Steam: chybí STEAM_API_KEY/STEAM_ID64 – ponechávám data z minula"); return prev; }
  const j = await getJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${sid}&include_appinfo=1&include_played_free_games=1&format=json`);
  const owned = j.response?.games || [];
  if (!owned.length) { console.warn("[playtime] Steam: prázdná knihovna (soukromý profil?) – ponechávám data z minula"); return prev; }
  const out = {};
  for (const g of owned) {
    if (!g.playtime_forever) continue;
    const p = prev[key(g.name)] || {};
    out[key(g.name)] = { appid: String(g.appid), title: g.name, min: g.playtime_forever,
      last: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString().slice(0, 10) : null, ach: p.ach || null };
  }
  // achievementy jen u sledovaných a odehraných her
  const byAppid = new Map(Object.values(out).map((e) => [e.appid, e]));
  const want = [...new Set(tracked.map((t) => t.appid || out[key(t.title)]?.appid).filter((a) => a && byAppid.has(String(a))))];
  let calls = 0;
  for (const appid of want) {
    if (calls++ >= MAX_ACH_CALLS) break;
    try {
      const a = await getJson(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${apiKey}&steamid=${sid}&appid=${appid}`);
      const list = a.playerstats?.achievements || [];
      if (list.length) byAppid.get(appid).ach = { done: list.filter((x) => x.achieved).length, total: list.length };
    } catch (e) { /* hra bez achievementů vrací 400 */ }
    await sleep(300);
  }
  console.log(`[playtime] Steam: ${Object.keys(out).length} odehraných her, achievementy u ${want.length}`);
  return out;
}

// najde v libovolném JSONu statistiku MinutesPlayed (tvar odpovědi OpenXBL se liší podle endpointu)
function findMinutes(o, d = 0) {
  if (!o || typeof o !== "object" || d > 8) return null;
  if (/^minutesplayed$/i.test(o.name || "") && o.value != null && !isNaN(+o.value)) return +o.value;
  for (const k in o) { const v = findMinutes(o[k], d + 1); if (v != null) return v; }
  return null;
}

async function xbox(prev, tracked) {
  const apiKey = process.env.XBL_API_KEY;
  if (!apiKey) { console.log("[playtime] Xbox: chybí XBL_API_KEY – ponechávám data z minula"); return prev; }
  const H = { "X-Authorization": apiKey, Accept: "application/json", "Accept-Language": "cs-CZ" };
  const j = await getJson("https://api.xbl.io/v2/achievements", H);
  const titles = j.titles || [];
  const out = {};
  for (const t of titles) {
    const a = t.achievement || {};
    const p = prev[key(t.name)] || {};
    out[key(t.name)] = { titleId: String(t.titleId), title: t.name,
      last: (t.titleHistory?.lastTimePlayed || "").slice(0, 10) || null,
      ach: a.totalAchievements ? { done: a.currentAchievements || 0, total: a.totalAchievements } : null,
      min: p.min ?? null };
  }
  // odehraný čas jen u sledovaných her (každý titul = 1 dotaz)
  const want = tracked.map((t) => out[key(t.title)]).filter(Boolean);
  let n = 0;
  for (const e of [...new Set(want)]) {
    if (n++ >= MAX_XBL_STATS) break;
    try {
      const s = await getJson(`https://api.xbl.io/v2/achievements/stats/${e.titleId}`, H);
      const m = findMinutes(s);
      if (m != null) e.min = m;
      else if (n === 1) console.log("[playtime] Xbox: MinutesPlayed nenalezeno, ukázka odpovědi:", JSON.stringify(s).slice(0, 400));
    } catch (err) { console.warn("  ! Xbox stats", e.title, err.message); }
    await sleep(500);
  }
  console.log(`[playtime] Xbox: ${titles.length} titulů, čas u ${want.filter((e) => e.min != null).length} sledovaných`);
  return out;
}

async function main() {
  console.log("[playtime] start", new Date().toISOString());
  const prev = loadJson("playtime.json") || {};
  const tracked = trackedGames();
  let s = prev.steam || {}, x = prev.xbox || {};
  try { s = await steam(s, tracked); } catch (e) { console.warn("[playtime] Steam selhal:", e.message); }
  try { x = await xbox(x, tracked); } catch (e) { console.warn("[playtime] Xbox selhal:", e.message); }
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), steam: s, xbox: x }, null, 2));
  console.log("[playtime] hotovo → playtime.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
