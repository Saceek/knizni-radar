/**
 * Sáčkův radar – Novinky: porovná aktuální data s předchozími a vygeneruje news.json
 * ----------------------------------------------------------------------------------
 * Spouštět PO všech ostatních build skriptech.   node build-news.js
 *
 *  - porovná books.json vs previous-books.json → nové knihy
 *  - porovná games.json vs previous-games.json → nové hry (vydané za posledních 7 dní)
 *  - porovná movies.json vs previous-movies.json → nové filmy/seriály
 *  - výsledek zapíše do news.json
 *  - aktuální data zkopíruje do previous-*.json pro příští porovnání
 */

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const OUT = path.join(DIR, "news.json");
const HISTORY = path.join(DIR, "news-history.json");
const RETAIN_DAYS = 3;

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
      rating: g.rating,
      reviews: g.reviews,
      scoreDesc: g.scoreDesc,
      price: g.price,
      image: g.image,
      url: g.url,
      tags: g.tags,
      released: g.released,
    }));
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
  const games = loadJson("games.json");
  const prevGames = loadJson("previous-games.json");
  const movies = loadJson("movies.json");
  const prevMovies = loadJson("previous-movies.json");

  const newBooks = books ? diffBooks(books, prevBooks) : [];
  const newGames = games ? diffGames(games, prevGames) : [];
  const newMovies = movies ? diffMovies(movies, prevMovies) : [];
  const todaysItems = [...newBooks, ...newMovies, ...newGames];

  // Load rolling history, append today's new items with today's date, prune entries older than RETAIN_DAYS
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let history = loadJson("news-history.json") || [];
  const seenKeys = new Set(history.map((h) => h.type + "::" + h.title));
  todaysItems.forEach((item) => {
    const key = item.type + "::" + item.title;
    if (!seenKeys.has(key)) {
      history.push({ ...item, firstSeen: today });
      seenKeys.add(key);
    }
  });
  history = history.filter((h) => {
    const ageDays = Math.floor((now - new Date(h.firstSeen + "T00:00:00Z")) / 86400000);
    return ageDays < RETAIN_DAYS;
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
      movies: itemsWithAge.filter((i) => i.type === "movie").length,
      series: itemsWithAge.filter((i) => i.type === "series").length,
      games: itemsWithAge.filter((i) => i.type === "game").length,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(news, null, 2));
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));
  console.log(`[news] dnes nově: ${newBooks.length} knih, ${newMovies.length} filmů/seriálů, ${newGames.length} her | celkem v okně ${RETAIN_DAYS} dnů: ${itemsWithAge.length} → news.json`);

  // Archive current data for next comparison
  if (books) fs.writeFileSync(path.join(DIR, "previous-books.json"), JSON.stringify(books));
  if (games) fs.writeFileSync(path.join(DIR, "previous-games.json"), JSON.stringify(games));
  if (movies) fs.writeFileSync(path.join(DIR, "previous-movies.json"), JSON.stringify(movies));
  console.log("[news] previous-*.json aktualizováno");
}

main();
