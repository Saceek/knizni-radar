/**
 * Sáčkův radar – HowLongToBeat "Main + Extra" doba dohrání pro hry ze Steamu/backlogu
 * -------------------------------------------------------------------------------------
 * Node 18+ (globální fetch).   node build-hltb.js
 *
 * HowLongToBeat nemá oficiální API a jejich search endpoint je schválně zamlžený
 * (mění se s každým buildem webu) + vyžaduje krátkodobý auth token. Postup (odkoukaný
 * z aktuálního _next JS bundlu, stejný princip jako používá knihovna howlongtobeatpy):
 *   1) GET  /                       – najde <script src> s _next/static/chunks/*.js
 *   2) GET  ten script              – regexem najde aktuální jméno search endpointu
 *      (aktuálně "/api/bleed", ale mění se – proto se hledá dynamicky přes fetch(...,{method:"POST"}))
 *   3) GET  {endpoint}/init?t=...   – vrátí {token, hpKey, hpVal} (jednorázový auth token)
 *   4) POST {endpoint}              – search dotaz s headers x-auth-token/x-hp-key/x-hp-val
 *
 * Výstup: hltb.json → { updatedAt, games: [{title, hours, url}] }
 *  - "hours": "Main + Extra" (comp_plus) v hodinách, zaokrouhleno na 1 des. místo
 *  - vstupní seznam názvů = union her z games.json (Steam list) + backlog.json (hry)
 */

const fs = require("fs");
const path = require("path");
const { normalizeGameTitle } = require("./gamepass-match");

const DIR = __dirname;
const OUT = path.join(DIR, "hltb.json");
const BASE = "https://howlongtobeat.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DELAY = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, file), "utf-8")); }
  catch { return null; }
}

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: BASE + "/" } });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.text();
}

async function findSearchEndpoint() {
  const html = await getText(BASE + "/");
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const src of scriptSrcs) {
    try {
      const js = await getText(BASE + src);
      const m = js.match(/fetch\(["'](\/api\/[a-zA-Z0-9_]+)["']\s*,\s*\{[^}]*method:\s*["']POST["']/);
      if (m) return m[1];
    } catch (_) { /* ignore individual chunk failures */ }
  }
  return null;
}

async function getAuth(endpoint) {
  const j = JSON.parse(await getText(`${BASE}${endpoint}/init?t=${Date.now()}`));
  return { token: j.token, hpKey: j.hpKey, hpVal: j.hpVal };
}

async function searchGame(endpoint, auth, title) {
  const payload = {
    searchType: "games",
    searchTerms: title.split(" "),
    searchPage: 1,
    size: 5,
    searchOptions: {
      games: { userId: 0, platform: "", sortCategory: "popular", rangeCategory: "main", rangeTime: { min: 0, max: 0 }, gameplay: { perspective: "", flow: "", genre: "", difficulty: "" }, rangeYear: { min: "", max: "" }, modifier: "" },
      users: { sortCategory: "postcount" },
      lists: { sortCategory: "follows" },
      filter: "", sort: 0, randomizer: 0,
    },
    useCache: true,
  };
  if (auth.hpKey) payload[auth.hpKey] = auth.hpVal;
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Referer: BASE + "/",
      Origin: BASE,
      "x-auth-token": auth.token,
      "x-hp-key": auth.hpKey,
      "x-hp-val": auth.hpVal,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  return j.data || [];
}

function bestMatch(title, results) {
  const wanted = normalizeGameTitle(title);
  let best = null;
  for (const r of results) {
    const norm = normalizeGameTitle(r.game_name);
    if (norm === wanted) return r;                 // exact normalized match wins immediately
    if (!best && wanted.split(" ").every((w) => w.length < 3 || norm.includes(w))) best = r;
  }
  return best;
}

function collectTitles() {
  const games = loadJson("games.json");
  const backlog = loadJson("backlog.json") || [];
  const set = new Set();
  (games?.games || []).forEach((g) => g.name && set.add(g.name));
  backlog.filter((b) => b._category === "game").forEach((b) => b.title && set.add(b.title));
  return [...set];
}

async function main() {
  console.log("[hltb] start", new Date().toISOString());
  const endpoint = await findSearchEndpoint();
  if (!endpoint) { console.error("[hltb] nepodařilo se najít search endpoint, končím"); return; }
  console.log("[hltb] search endpoint:", endpoint);

  const titles = collectTitles();
  console.log(`[hltb] ${titles.length} her k vyhledání`);

  const out = [];
  let auth = await getAuth(endpoint);
  for (const title of titles) {
    try {
      const results = await searchGame(endpoint, auth, title);
      const match = bestMatch(title, results);
      // Main + Extra (comp_plus) je preferovaný styl hraní; když ho HLTB pro danou hru nemá
      // (moc nová/krátká hra bez dost dat), spadneme na Main Story (comp_main) místo prázdna.
      const seconds = match?.comp_plus || match?.comp_main;
      if (match && seconds) {
        out.push({ title, hours: Math.round((seconds / 3600) * 10) / 10, url: `${BASE}/game/${match.game_id}` });
        console.log(`  ✓ ${title} → ${(seconds / 3600).toFixed(1)} h${match.comp_plus ? "" : " (Main Story)"}`);
      } else {
        console.log(`  ✗ ${title} (nenalezeno)`);
      }
    } catch (e) {
      console.warn(`  ! ${title} →`, e.message);
      if (e.message.includes("403")) { auth = await getAuth(endpoint); } // token expired, refresh
    }
    await sleep(DELAY);
  }

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), games: out }, null, 2));
  console.log(`[hltb] hotovo: ${out.length}/${titles.length} her → hltb.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
