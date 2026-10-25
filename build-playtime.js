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

// OpenXBL vrací data obalená { content: …, code } – starší endpointy bez obálky
const unwrap = (j) => (j && j.content && typeof j.content === "object" ? j.content : j);

// všechny statistiky MinutesPlayed v odpovědi (Xbox userstats: statlistscollection[].stats[] s titleid)
function collectMinutes(o, acc = [], d = 0) {
  if (!o || typeof o !== "object" || d > 10) return acc;
  if (/^minutesplayed$/i.test(o.name || "") && o.value != null && !isNaN(+o.value)) acc.push({ titleId: o.titleid != null ? String(o.titleid) : null, min: +o.value });
  for (const k in o) collectMinutes(o[k], acc, d + 1);
  return acc;
}

async function xbox(prev, tracked) {
  const apiKey = process.env.XBL_API_KEY;
  if (!apiKey) { console.log("[playtime] Xbox: chybí XBL_API_KEY – ponechávám data z minula"); return { out: prev, info: "bez klíče" }; }
  const H = { "X-Authorization": apiKey, Accept: "application/json", "Accept-Language": "cs-CZ" };
  // historie titulů (i Game Pass) s achievementy a posledním hraním
  const th = unwrap(await getJson("https://api.xbl.io/v2/titles", H));
  const titles = th.titles || [];
  const xuid = th.xuid || null;
  const out = {};
  for (const t of titles) {
    if (!t.name) continue;
    const a = t.achievement || {};
    const p = prev[key(t.name)] || {};
    out[key(t.name)] = { titleId: String(t.titleId), title: t.name,
      last: (t.titleHistory?.lastTimePlayed || "").slice(0, 10) || null,
      ach: a.totalAchievements ? { done: a.currentAchievements || 0, total: a.totalAchievements }
        : a.progressPercentage != null && a.totalGamerscore ? { pct: a.progressPercentage } : null,
      min: p.min ?? null };
  }
  // odehraný čas sledovaných her – jeden hromadný dotaz na statistiku MinutesPlayed
  const want = [...new Set(tracked.map((t) => out[key(t.title)]).filter(Boolean))];
  let note = "";
  if (want.length && xuid) {
    try {
      const r = await fetch("https://api.xbl.io/v2/player/stats", { method: "POST", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ xuids: [xuid], stats: want.map((e) => ({ name: "MinutesPlayed", titleId: e.titleId })) }) });
      const body = await r.json().catch(() => null);
      const mins = collectMinutes(body);
      for (const m of mins) {
        const e = m.titleId ? want.find((w) => w.titleId === m.titleId) : want.length === 1 ? want[0] : null;
        if (e) e.min = m.min;
      }
      if (!mins.length) { note = ` · stats HTTP ${r.status}: ${JSON.stringify(body).slice(0, 200)}`; console.log("[playtime] Xbox: MinutesPlayed nenalezeno:", JSON.stringify(body).slice(0, 600)); }
    } catch (err) { note = " · stats chyba: " + err.message; console.warn("  ! Xbox stats", err.message); }
  }
  const info = `${titles.length} titulů · sledované ${want.map((e) => `${e.title}: ${e.min != null ? e.min + " min" : "?"}`).join(", ") || "žádné"}${note}`;
  console.log("[playtime] Xbox:", info);
  return { out, info };
}

async function main() {
  console.log("[playtime] start", new Date().toISOString());
  const prev = loadJson("playtime.json") || {};
  const tracked = trackedGames();
  let s = prev.steam || {}, x = prev.xbox || {}, xboxInfo = prev.xboxInfo || null;
  try { s = await steam(s, tracked); } catch (e) { console.warn("[playtime] Steam selhal:", e.message); }
  try { const r = await xbox(x, tracked); x = r.out; xboxInfo = r.info; } catch (e) { console.warn("[playtime] Xbox selhal:", e.message); xboxInfo = "chyba: " + e.message; }
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), steam: s, xbox: x, xboxInfo }, null, 2));
  console.log("[playtime] hotovo → playtime.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
