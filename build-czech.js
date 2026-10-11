/**
 * Sáčkův radar – čeština do her (oficiální ze Steamu + fanouškovské překlady)
 * --------------------------------------------------------------------------
 * Node 18+ (globální fetch), bez závislostí.   node build-czech.js
 *
 * Hry se berou ze všech stránek webu: games.json (Steam žebříček), backlog.json, news.json,
 * coming.json a metacritic.json.
 *  - oficiální čeština: Steam appdetails → supported_languages ("Czech", s hvězdičkou = i dabing).
 *    Hry bez Steam ID (hlavně z Metacritic) se dohledají ve Steam vyhledávání, jen při přesné
 *    shodě názvu. Výsledky se cachují v czech.json a znovu ověřují nejdřív po RECHECK_DAYS.
 *  - fanouškovská čeština: lokalizace.net (sitemap → detail s procenty, týmem a Steam ID)
 *    a hernipreklady.cz (seznam → detail se stavem a průběhem překlad/korektura/testování).
 *  - fanSince / doneSince: kdy se poprvé objevil / dokončil fanouškovský překlad (pro řadu
 *    „Nové češtiny“ na Novinkách).
 *
 * Výstup: czech.json → { updatedAt, games: { <normalizovaný název>: { title, appid, official,
 *   checkedAt, ln?, hp?, fanSince?, doneSince? } } }
 *   official: "full" (i dabing) | "text" (rozhraní a titulky) | "none" | null (neověřeno / není na Steamu)
 */

const fs = require("fs");
const path = require("path");
const { normalizeGameTitle } = require("./gamepass-match");

const DIR = __dirname;
const OUT = path.join(DIR, "czech.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const RECHECK_DAYS = 7;
const MAX_STEAM_CALLS = 150;   // na jeden běh – zbytek se dožene příště (limit Steam API ~200 / 5 min)
const STEAM_DELAY = 1500;
const WEB_DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

function loadJson(file) { try { return JSON.parse(fs.readFileSync(path.join(DIR, file), "utf-8")); } catch { return null; } }
async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs,en" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
const decode = (s) => (s || "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&aacute;/g, "á").replace(/&iacute;/g, "í").replace(/&eacute;/g, "é").replace(/&yacute;/g, "ý").replace(/&uacute;/g, "ú")
  .replace(/&Aacute;/g, "Á").replace(/&Iacute;/g, "Í").replace(/&Eacute;/g, "É").trim();
const appidFromUrl = (u) => ((u || "").match(/store\.steampowered\.com\/app\/(\d+)/) || [])[1] || null;
// klíč i pro slug na lokalizace.net – bez ™®, apostrofů a dvojteček
const key = (s) => normalizeGameTitle(decode(s).replace(/[™®©]/g, "").replace(/['’`]/g, ""));

function collectGames() {
  const map = new Map();
  // prio = pořadí ověřování na Steamu (limit dotazů na běh): Můj seznam → Novinky → žebříček → Očekávané → Metacritic
  const add = (title, appid, prio) => {
    if (!title) return;
    const k = key(title);
    if (!k) return;
    const cur = map.get(k);
    if (!cur) map.set(k, { title, appid: appid ? String(appid) : null, prio });
    else { if (!cur.appid && appid) cur.appid = String(appid); cur.prio = Math.min(cur.prio, prio); }
  };
  (loadJson("backlog.json") || []).filter((b) => b._category === "game").forEach((b) => add(b.title, b.appid || appidFromUrl(b.url), 0));
  (loadJson("news.json")?.items || []).filter((i) => i.type === "game").forEach((i) => add(i.title, i.appid || appidFromUrl(i.url), 1));
  (loadJson("games.json")?.games || []).forEach((g) => add(g.name, g.appid, 2));
  (loadJson("coming.json")?.games || []).forEach((g) => add(g.title, appidFromUrl(g.url), 3));
  const mc = loadJson("metacritic.json");
  if (mc && mc.years) Object.values(mc.years).forEach((y) => (y.games || []).forEach((g) => add(g.title, null, 4)));
  return map;
}

let steamCalls = 0;
async function steamSearchAppid(title) {
  steamCalls++;
  const j = JSON.parse(await getText(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=us`));
  const hit = (j.items || []).find((it) => key(it.name) === key(title));
  return hit ? String(hit.id) : null;
}
async function steamOfficial(appid) {
  steamCalls++;
  const j = JSON.parse(await getText(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic&l=english`));
  const d = j[appid] && j[appid].success ? j[appid].data : null;
  if (!d) return null;
  const m = (d.supported_languages || "").match(/Czech(\s*<strong>\*<\/strong>)?/);
  return m ? (m[1] ? "full" : "text") : "none";
}

async function main() {
  console.log("[czech] start", new Date().toISOString());
  const prev = loadJson("czech.json")?.games || {};
  const games = collectGames();
  console.log(`[czech] ${games.size} her ze všech stránek`);

  // --- fanouškovské překlady: seznamy obou webů ---
  let lnSlugs = new Set(), hpList = [];
  try {
    const sm = await getText("https://lokalizace.net/sitemap.xml");
    lnSlugs = new Set([...sm.matchAll(/<loc>https:\/\/lokalizace\.net\/localizations\/([^<]+)<\/loc>/g)].map((m) => m[1]));
  } catch (e) { console.warn("  ! lokalizace.net sitemap:", e.message); }
  try {
    const html = await getText("https://hernipreklady.cz/seznam-prekladu");
    hpList = [...html.matchAll(/<th class="list-title"[^>]*>\s*<a href="\/seznam-prekladu\/([^"]+)">\s*([^<]+?)\s*<\/a>\s*<\/th>\s*<td class="list-date small">\s*([^<]+?)\s*<\/td>\s*<td class="list-author">\s*([^<]*?)\s*<\/td>/g)]
      .map((m) => ({ slug: m[1], title: decode(m[2]), date: decode(m[3]), author: decode(m[4]) }));
  } catch (e) { console.warn("  ! hernipreklady.cz seznam:", e.message); }
  console.log(`[czech] lokalizace.net ${lnSlugs.size} · hernipreklady.cz ${hpList.length}`);
  const hpByKey = new Map(hpList.map((h) => [key(h.title.replace(/\s*\+\s*DLC$/i, "")), h]));

  const out = {};
  const needSteam = [];
  for (const [k, g] of games) {
    const p = prev[k] || {};
    const e = { title: g.title, prio: g.prio, appid: g.appid || p.appid || null, official: p.official ?? null, checkedAt: p.checkedAt || null,
      fanSince: p.fanSince || null, doneSince: p.doneSince || null };
    out[k] = e;
    const stale = !e.checkedAt || (Date.now() - new Date(e.checkedAt)) / 864e5 >= RECHECK_DAYS;
    if (stale) needSteam.push(e);

    // lokalizace.net – slug = název s pomlčkami (někdy s -steam)
    const slug = k.replace(/ /g, "-");
    const ln = lnSlugs.has(slug) ? slug : lnSlugs.has(slug + "-steam") ? slug + "-steam" : null;
    if (ln) {
      try {
        const t = await getText("https://lokalizace.net/localizations/" + ln);
        const pct = (t.match(/Český překlad (\d{1,3})% hotovo/) || [])[1];
        const team = (t.match(/Lokalizace od ([^."<]+)/) || [])[1];
        const sid = (t.match(/store\.steampowered\.com\/app\/(\d+)/) || [])[1] || null;
        if (!e.appid && sid) e.appid = sid;
        // jiná hra se stejným názvem (Steam ID nesedí) → nebrat
        if (!(sid && e.appid && sid !== e.appid)) e.ln = { url: "https://lokalizace.net/localizations/" + ln, pct: pct != null ? +pct : null, team: team ? decode(team) : null };
      } catch (err) { console.warn("  ! lokalizace.net", ln, err.message); if (p.ln) e.ln = p.ln; }
      await sleep(WEB_DELAY);
    }
    const h = hpByKey.get(k);
    if (h) {
      try {
        const t = await getText("https://hernipreklady.cz/seznam-prekladu/" + h.slug);
        const stav = (t.match(/field-label ">Stav: <\/span>\s*<span class="field-value ">([^<]+)/) || [])[1];
        const bars = [...t.matchAll(/field-label graf\d">([^<:]+):?\s*<\/span>[\s\S]{0,600}?width:\s*(\d{1,3})%/g)].map((m) => ({ k: decode(m[1]), v: +m[2] }));
        e.hp = { url: "https://hernipreklady.cz/seznam-prekladu/" + h.slug, stav: stav ? decode(stav) : null, bars, author: h.author || null, date: h.date || null };
      } catch (err) { console.warn("  ! hernipreklady.cz", h.slug, err.message); if (p.hp) e.hp = p.hp; }
      await sleep(WEB_DELAY);
    }
    const hasFan = !!(e.ln || e.hp);
    const done = (e.ln && e.ln.pct === 100) || (e.hp && e.hp.bars.length > 0 && e.hp.bars.every((b) => b.v === 100));
    if (hasFan && !e.fanSince) e.fanSince = Object.keys(prev).length ? today() : "2000-01-01";  // první běh: nehlásit vše jako nové
    if (done && !e.doneSince) e.doneSince = Object.keys(prev).length ? today() : "2000-01-01";
    if (!hasFan) { e.fanSince = null; e.doneSince = null; }
  }

  // --- oficiální čeština ze Steamu (s limitem na běh) ---
  needSteam.sort((a, b) => ((a.checkedAt ? 1 : 0) - (b.checkedAt ? 1 : 0)) || a.prio - b.prio);  // nikdy neověřené a důležitější napřed
  for (const e of needSteam) {
    if (steamCalls >= MAX_STEAM_CALLS) break;
    try {
      if (!e.appid) { e.appid = await steamSearchAppid(e.title); await sleep(STEAM_DELAY); }
      if (e.appid && steamCalls < MAX_STEAM_CALLS) { e.official = await steamOfficial(e.appid); await sleep(STEAM_DELAY); }
      e.checkedAt = today();   // i když hra na Steamu není – další pokus až za RECHECK_DAYS
    } catch (err) { console.warn("  ! Steam", e.title, err.message); await sleep(STEAM_DELAY * 2); }
  }
  const left = needSteam.filter((e) => e.checkedAt !== today()).length;

  const vals = Object.values(out);
  const c = (f) => vals.filter(f).length;
  console.log(`[czech] oficiálně ${c((e) => e.official === "text" || e.official === "full")} (dabing ${c((e) => e.official === "full")}) · bez ${c((e) => e.official === "none")} · neověřeno ${c((e) => e.official == null)} · fanouškovsky ${c((e) => e.ln || e.hp)}`);
  if (left) console.log(`[czech] ${left} her se ověří při dalším běhu (limit ${MAX_STEAM_CALLS} dotazů na Steam)`);
  for (const e of Object.values(out)) delete e.prio;
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), games: out }, null, 2));
  console.log("[czech] hotovo → czech.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
