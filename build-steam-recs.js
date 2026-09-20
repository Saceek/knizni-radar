/**
 * Sáčkův radar – osobní Steam doporučení
 * -------------------------------------------------------------------
 * Steam nemá veřejné API pro skutečnou "Recommended for you" stránku (ta
 * vyžaduje přihlášenou relaci). Místo toho postavíme vlastní signál ze
 * dvou věcí, co veřejné/klíčované API má:
 *
 *  1) Wishlist (IWishlistService/GetWishlist) - nejsilnější signál, přímo
 *     říká "tohle chci". Hra z games.json na wishlistu -> wishlisted:true.
 *  2) Vlastněné hry (IPlayerService/GetOwnedGames) vážené odehraným časem -
 *     z top odehraných her se zjistí oblíbené žánry (appdetails), a hra ze
 *     žebříčku sdílející aspoň 2 z top 5 žánrů dostane recommended:true.
 *
 * Vyžaduje env proměnné STEAM_API_KEY a STEAM_ID64 (GitHub Actions secrets).
 * Bez nich skript nic nedělá (continue-on-error v pipeline).
 *   node build-steam-recs.js
 */

const fs = require("fs");
const path = require("path");

const GAMES_FILE = path.join(__dirname, "games.json");
const DELAY = 450;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOP_PLAYED_LIMIT = 15; // kolik nejhranějších vlastněných her jde do žánrového profilu
const MIN_GENRE_MATCH = 2; // kolik žánrů z top 5 preferencí (po odfiltrování obecných) musí hra sdílet
// Příliš obecné žánry (skoro každá indie hra je "Nezávislé"/"Akční") by udělaly z
// "doporučeno" prázdný pojem - do profilu přeferencí se nepočítají.
const GENERIC_GENRES = new Set(["Nezávislé", "Nenáročné", "Akční", "Nástroje", "Software"]);

async function fetchOwnedGames(key, steamid) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamid}&include_appinfo=1&format=json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("GetOwnedGames HTTP " + r.status);
  const j = await r.json();
  return j.response?.games || [];
}

async function fetchWishlist(key, steamid) {
  const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamid}&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("GetWishlist HTTP " + r.status);
  const j = await r.json();
  return (j.response?.items || []).map((i) => i.appid);
}

async function fetchGenres(appid) {
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=genres&l=czech&cc=cz`);
    const j = await r.json();
    const node = j && j[appid];
    if (!node || !node.success || !node.data) return [];
    return (node.data.genres || []).map((g) => g.description);
  } catch (e) { return []; }
}

async function main() {
  console.log("[steam-recs] start", new Date().toISOString());
  const key = process.env.STEAM_API_KEY;
  const steamid = process.env.STEAM_ID64;
  if (!key || !steamid) { console.log("[steam-recs] STEAM_API_KEY/STEAM_ID64 nenastaveno, přeskočeno"); return; }

  let data;
  try { data = JSON.parse(fs.readFileSync(GAMES_FILE, "utf-8")); }
  catch (e) { console.log("[steam-recs] games.json nenalezen, končím"); return; }
  const games = data.games || data;

  const [owned, wishlist] = await Promise.all([fetchOwnedGames(key, steamid), fetchWishlist(key, steamid)]);
  const wishlistSet = new Set(wishlist);
  console.log(`[steam-recs] ${owned.length} vlastněných her, ${wishlist.length} na wishlistu`);

  // Žánrový profil z nejhranějších vlastněných her (váha = odehraný čas)
  const topPlayed = [...owned].sort((a, b) => b.playtime_forever - a.playtime_forever).slice(0, TOP_PLAYED_LIMIT);
  const genreWeight = {};
  for (const g of topPlayed) {
    const genres = await fetchGenres(g.appid);
    genres.filter((genre) => !GENERIC_GENRES.has(genre)).forEach((genre) => { genreWeight[genre] = (genreWeight[genre] || 0) + Math.max(1, g.playtime_forever); });
    await sleep(DELAY);
  }
  const topGenres = Object.entries(genreWeight).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);
  console.log("[steam-recs] top žánry:", topGenres.join(", ") || "(žádné - všechny hry mají 0 min)");

  let changed = 0;
  for (const g of games) {
    const wishlisted = wishlistSet.has(g.appid);
    const genreMatches = (g.tags || []).filter((t) => topGenres.includes(t)).length;
    const recommended = !wishlisted && genreMatches >= MIN_GENRE_MATCH;
    if (g.wishlisted !== wishlisted) { g.wishlisted = wishlisted; changed++; }
    if (g.recommended !== recommended) { g.recommended = recommended; changed++; }
  }

  if (changed > 0) {
    fs.writeFileSync(GAMES_FILE, JSON.stringify(data, null, 2));
    const wCount = games.filter((g) => g.wishlisted).length;
    const rCount = games.filter((g) => g.recommended).length;
    console.log(`[steam-recs] hotovo: ${wCount} na wishlistu, ${rCount} doporučeno podle žánru → games.json`);
  } else {
    console.log("[steam-recs] žádná změna");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
