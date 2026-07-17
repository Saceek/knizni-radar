/**
 * Sáčkův radar – Novinky: porovná aktuální data s předchozími a vygeneruje news.json
 * ----------------------------------------------------------------------------------
 * Spouštět PO všech ostatních build skriptech.   node build-news.js
 *
 *  - porovná books.json vs previous-books.json → nové knihy
 *  - porovná crew.json (bestsellers) vs previous-crew.json → nové komiksy v CREW žebříčku
 *    (stejný princip jako u knih – diffuje se přesně ten seznam, co je vidět v Knižní Bestsellery)
 *  - porovná games.json vs previous-games.json → nové hry (vydané za posledních 7 dní)
 *  - porovná movies.json vs previous-movies.json → nové filmy/seriály
 *  - výsledek zapíše do news.json
 *  - aktuální data zkopíruje do previous-*.json pro příští porovnání
 */

const fs = require("fs");
const path = require("path");
const { normalizeGameTitle } = require("./gamepass-match");

const DIR = __dirname;
const OUT = path.join(DIR, "news.json");
const HISTORY = path.join(DIR, "news-history.json");
const SEEN = path.join(DIR, "news-seen.json");
const RETAIN_DAYS = 3;
const SEEN_RETAIN_DAYS = 365; // jak dlouho si pamatujeme "tohle už bylo v Novinkách", než to smí být "nové" znovu

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, file), "utf-8")); }
  catch { return null; }
}

function diffBooks(current, previous) {
  const cur = (current?.books || current || []);
  const prev = new Set((previous?.books || previous || []).map((b) => b.title));
  return cur.filter((b) => !prev.has(b.title)).map((b) => ({
    type: "book",
    title: b.title,
    author: b.author,
    cover: b.cover,
    rating: b.rating,
    ratingSource: b.ratingSource || "databazeknih.cz",
    link: b.link,
    price: b.prices?.length ? Math.min(...b.prices.map((p) => p.price)) : null,
    priceShop: b.prices?.length ? b.prices.sort((a, c) => a.price - c.price)[0].shop : null,
    cat: b.cat,
  }));
}

function diffComics(current, previous) {
  // Diffuje "bestsellers" (Top 30 CREW podle popularity) – přesně ten seznam, který je
  // vidět jako chip "CREW" v Knižní Bestsellery. Ne "comics" (feed novinek), aby změny
  // v CREW sekci vždy odpovídaly tomu, co se reálně objeví/zmizí v Novinkách.
  const cur = (current?.bestsellers || []);
  const prev = new Set((previous?.bestsellers || []).map((c) => c.title));
  return cur.filter((c) => !prev.has(c.title)).map((c) => ({
    type: "comic",
    title: c.title,
    author: c.author,
    cover: c.cover,
    rating: c.rating,
    ratingSource: c.ratingSource,
    link: c.link,
    price: c.price,
    originalPrice: c.originalPrice,
    discount: c.discount,
    url: c.url,
    publisher: c.publisher,
  }));
}

function diffGames(current, previous) {
  const cur = (current?.games || current || []);
  const prevIds = new Set((previous?.games || previous || []).map((g) => g.appid));
  const weekAgo = Date.now() - 7 * 86400000;
  return cur
    .filter((g) => !prevIds.has(g.appid))
    .filter((g) => !g.released || Date.parse(g.released) >= weekAgo)
    .map((g) => ({
      type: "game",
      title: g.name,
      appid: g.appid,
      rating: g.rating,
      reviews: g.reviews,
      scoreDesc: g.scoreDesc,
      price: g.price,
      image: g.image,
      url: g.url,
      tags: g.tags,
      released: g.released,
      gamePass: !!g.gamePass,
    }));
}

// Nové přírůstky do PC Game Passu (ne nové hry na Steamu - katalog Game Passu se mění nezávisle
// na datu vydání, hry do něj přibývají roky po releasu). Obohatíme o cenu/hodnocení/tagy ze Steamu,
// pokud tam stejná hra (podle normalizovaného názvu) je - jinak se zobrazí jen s obrázkem z MS katalogu.
function diffGamePass(current, previous, steamGames) {
  const cur = current?.games || [];
  const prevIds = new Set((previous?.games || []).map((g) => g.productId));
  const steamByTitle = new Map((steamGames || []).map((g) => [normalizeGameTitle(g.name), g]));
  return cur.filter((g) => !prevIds.has(g.productId)).map((g) => {
    const steam = steamByTitle.get(normalizeGameTitle(g.title));
    return {
      type: "game",
      title: g.title,
      url: steam?.url || g.url,
      image: steam?.image || g.image,
      price: steam?.price ?? null,
      rating: steam?.rating ?? null,
      tags: steam?.tags || [],
      released: steam?.released ?? null,
      gamePass: true,
    };
  });
}

function diffMovies(current, previous) {
  const cur = (current?.movies || current || []);
  const prevUrls = new Set((previous?.movies || previous || []).map((m) => m.url));
  return cur.filter((m) => !prevUrls.has(m.url)).map((m) => ({
    type: m.type === "seriál" ? "series" : "movie",
    title: m.title,
    year: m.year,
    rating: m.rating,
    poster: m.poster,
    url: m.url,
    genres: m.genres,
    country: m.country,
    vod: m.vod,
    csfdType: m.type,
  }));
}

function main() {
  console.log("[news] start", new Date().toISOString());

  const books = loadJson("books.json");
  const prevBooks = loadJson("previous-books.json");
  const comics = loadJson("crew.json");
  const prevComics = loadJson("previous-crew.json");
  const games = loadJson("games.json");
  const prevGames = loadJson("previous-games.json");
  const movies = loadJson("movies.json");
  const prevMovies = loadJson("previous-movies.json");
  const gamepass = loadJson("gamepass.json");
  const prevGamepass = loadJson("previous-gamepass.json");

  const newBooksRaw = books ? diffBooks(books, prevBooks) : [];
  const newComicsRaw = comics ? diffComics(comics, prevComics) : [];
  const newGamesRaw = games ? diffGames(games, prevGames) : [];
  const newMoviesRaw = movies ? diffMovies(movies, prevMovies) : [];
  const newGamePassRaw = gamepass ? diffGamePass(gamepass, prevGamepass, games?.games) : [];
  const todaysItemsRaw = [...newBooksRaw, ...newComicsRaw, ...newMoviesRaw, ...newGamesRaw, ...newGamePassRaw];

  // Trvalá paměť "tohle už jsme jednou v Novinkách ukázali" - odděleně od 3denní rolling
  // historie, protože jinak titul, co na den vypadne z žebříčku/seznamu a pak se vrátí
  // (posun v pořadí na Kosmasu, CREW, ČSFD...), vypadá pro diff proti-včerejšku jako
  // úplná novinka znovu, i když ji uživatel před pár dny už viděl.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let seen = loadJson("news-seen.json");
  if (!seen) {
    // První běh po zavedení téhle paměti - naseedujeme z aktuální rolling historie,
    // ať se to, co je právě teď vidět, nezačne hned zítra tvářit jako "nové" znovu.
    const existingHistory = loadJson("news-history.json") || [];
    seen = existingHistory.map((h) => ({ key: h.type + "::" + h.title, firstSeen: h.firstSeen }));
    console.log(`[news] news-seen.json neexistuje, seeduji z ${seen.length} položek aktuální historie`);
  }
  const seenKeySet = new Set(seen.map((s) => s.key));
  const todaysItems = todaysItemsRaw.filter((item) => !seenKeySet.has(item.type + "::" + item.title));
  const newBooks = newBooksRaw.filter((i) => todaysItems.includes(i));
  const newComics = newComicsRaw.filter((i) => todaysItems.includes(i));
  const newGames = newGamesRaw.filter((i) => todaysItems.includes(i));
  const newMovies = newMoviesRaw.filter((i) => todaysItems.includes(i));
  const newGamePass = newGamePassRaw.filter((i) => todaysItems.includes(i));
  const skipped = todaysItemsRaw.length - todaysItems.length;

  // Load rolling history, append today's genuinely-new items, prune entries older than RETAIN_DAYS
  let history = loadJson("news-history.json") || [];
  const seenKeys = new Set(history.map((h) => h.type + "::" + h.title));
  todaysItems.forEach((item) => {
    const key = item.type + "::" + item.title;
    if (!seenKeys.has(key)) {
      history.push({ ...item, firstSeen: today });
      seenKeys.add(key);
    }
    if (!seenKeySet.has(key)) { seen.push({ key, firstSeen: today }); seenKeySet.add(key); }
  });
  history = history.filter((h) => {
    const ageDays = Math.floor((now - new Date(h.firstSeen + "T00:00:00Z")) / 86400000);
    return ageDays < RETAIN_DAYS;
  });
  // Vlastní paměť prunujeme jen mnohem pomaleji (roky ne dny), ať soubor neroste do nekonečna
  seen = seen.filter((s) => {
    const ageDays = Math.floor((now - new Date(s.firstSeen + "T00:00:00Z")) / 86400000);
    return ageDays < SEEN_RETAIN_DAYS;
  });

  const itemsWithAge = history.map((h) => {
    const ageDays = Math.floor((now - new Date(h.firstSeen + "T00:00:00Z")) / 86400000);
    const { firstSeen, ...rest } = h;
    return { ...rest, firstSeen, daysLeft: RETAIN_DAYS - ageDays };
  }).sort((a, b) => a.daysLeft - b.daysLeft);

  const news = {
    updatedAt: new Date().toISOString(),
    items: itemsWithAge,
    counts: {
      books: itemsWithAge.filter((i) => i.type === "book").length,
      comics: itemsWithAge.filter((i) => i.type === "comic").length,
      movies: itemsWithAge.filter((i) => i.type === "movie").length,
      series: itemsWithAge.filter((i) => i.type === "series").length,
      games: itemsWithAge.filter((i) => i.type === "game").length,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(news, null, 2));
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));
  fs.writeFileSync(SEEN, JSON.stringify(seen, null, 2));
  console.log(`[news] dnes nově: ${newBooks.length} knih, ${newComics.length} komiksů, ${newMovies.length} filmů/seriálů, ${newGames.length} her, ${newGamePass.length} přírůstků do Game Passu (${skipped} přeskočeno - už dřív viděno) | celkem v okně ${RETAIN_DAYS} dnů: ${itemsWithAge.length} → news.json`);

  // Archive current data for next comparison
  if (books) fs.writeFileSync(path.join(DIR, "previous-books.json"), JSON.stringify(books));
  if (comics) fs.writeFileSync(path.join(DIR, "previous-crew.json"), JSON.stringify(comics));
  if (games) fs.writeFileSync(path.join(DIR, "previous-games.json"), JSON.stringify(games));
  if (movies) fs.writeFileSync(path.join(DIR, "previous-movies.json"), JSON.stringify(movies));
  if (gamepass) fs.writeFileSync(path.join(DIR, "previous-gamepass.json"), JSON.stringify(gamepass));
  console.log("[news] previous-*.json aktualizováno");
}

main();
