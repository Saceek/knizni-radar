/**
 * Sáčkův radar – Enrichment backlogu
 * -----------------------------------
 * Projde backlog.json a doplní:
 *  - knihy přidané z databazeknih.cz: hodnocení z databazeknih.cz, cenu z Kosmasu/Dobrovského
 *  - filmy/seriály přidané "naslepo" (ČSFD blokuje živé vyhledávání v appce, viz index.html
 *    "+ Přidat i bez nalezení"): rok, plakát, hodnocení, typ (film/seriál) z ČSFD přes Playwright
 *    (obyčejný fetch ČSFD blokuje - stejný BotStopper důvod jako u build-movies.js)
 * Spouštět jako poslední krok v build pipeline.   node build-enrich-backlog.js
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { loadGamePassSet, isInGamePass } = require("./gamepass-match");
const { normalizeGameTitle: normalizeTitle } = require("./gamepass-match"); // obecná normalizace, hodí se i na filmy

const BACKLOG_FILE = path.join(__dirname, "backlog.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DELAY = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBacklog() {
  try { return JSON.parse(fs.readFileSync(BACKLOG_FILE, "utf-8")); }
  catch { return []; }
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

// Fetch rating + cover from databazeknih detail page
async function enrichFromDatabazeknih(link) {
  try {
    const $ = cheerio.load(await getHtml(link));
    let rating = null;
    $("a[href*='/hodnoceni-knihy/']").each((_, el) => {
      if (rating != null) return;
      const m = $(el).text().replace(/\s+/g, "").match(/(\d{1,3})%/);
      if (m) { const n = parseInt(m[1], 10); if (n >= 0 && n <= 100) rating = n; }
    });
    const cover = $("meta[property='og:image']").attr("content") || null;
    return { rating, cover };
  } catch (e) {
    console.warn("[enrich] databazeknih error:", e.message);
    return {};
  }
}

const norm = (s = "") => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();

// Search Kosmas for price — matches title before accepting price
async function fetchKosmasPrice(title) {
  try {
    const url = `https://www.kosmas.cz/hledej/?q=${encodeURIComponent(title)}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const normTitle = norm(title);
    let price = null, priceUrl = null;
    $(".grid-item").each((_, item) => {
      if (price) return;
      // Title is in the book detail link text (not the discount span)
      let itemTitle = "";
      $(item).find("a[href*='/knihy/']").each((_, a) => {
        const t = $(a).text().trim();
        if (t && t.length > 3 && !t.includes("%") && !t.includes("Kč")) { itemTitle = norm(t); return false; }
      });
      if (!itemTitle) {
        // Fallback: get title from link title attribute
        const a = $(item).find("a[href*='/knihy/'][title]").first();
        itemTitle = norm(a.attr("title") || "");
      }
      const words = normTitle.split(" ").filter(w => w.length > 3);
      if (!words.length) return;
      const matches = words.filter(w => itemTitle.includes(w)).length;
      if (matches < Math.ceil(words.length * 0.5)) return;
      const href = $(item).find("a[href*='/knihy/']").first().attr("href") || "";
      const priceEl = $(item).find(".price__default").first().text().trim();
      const priceMatch = priceEl.match(/(\d[\d\s]*)\s*Kč/);
      if (priceMatch && href) {
        const p = parseInt(priceMatch[1].replace(/\s/g,""), 10);
        if (p >= 50 && p < 5000) { price = p; priceUrl = "https://www.kosmas.cz"+href; }
      }
    });
    return price ? { shop: "Kosmas", price, url: priceUrl } : null;
  } catch (e) { return null; }
}

// Search Dobrovský for price — matches title before accepting price
async function fetchDobrovskýPrice(title) {
  try {
    const url = `https://www.knihydobrovsky.cz/vyhledavani?search=${encodeURIComponent(title)}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);
    const normTitle = norm(title);
    let price = null, priceUrl = null;
    $("h3.title").each((_, h3) => {
      if (price) return;
      const nameSpan = $(h3).find("span.name").first();
      const itemTitle = norm(nameSpan.attr("title") || nameSpan.text());
      const words = normTitle.split(" ").filter(w => w.length > 3);
      if (!words.length) return;
      const matches = words.filter(w => itemTitle.includes(w)).length;
      if (matches < Math.ceil(words.length * 0.5)) return;
      const href = $(h3).find("a[href*='/kniha/']").first().attr("href") || "";
      // price is in the sibling .content div (h3's parent contains both h3.title and div.content)
      const container = $(h3).parent();
      const priceText = container.find(".price-wrap .price strong").first().text().trim();
      const priceMatch = priceText.match(/(\d[\d\s]*)\s*Kč/);
      if (priceMatch && href) {
        const p = parseInt(priceMatch[1].replace(/\s/g,""), 10);
        if (p >= 50 && p < 5000) {
          price = p;
          priceUrl = href.startsWith("http") ? href : "https://www.knihydobrovsky.cz"+href;
        }
      }
    });
    return price ? { shop: "Dobrovský", price, url: priceUrl } : null;
  } catch (e) { return null; }
}

const CSFD_WAIT = 6000; // Anubis/BotStopper JS výzva potřebuje pár vteřin, než přesměruje na skutečný obsah

// Vybere nejlepší shodu z výsledků hledání – přeskočí epizody seriálů (dvojité id/slug v URL,
// např. /film/237486-pernikovy-tata/420273-pilotni-dil/) a vezme tu s nejvyšším překryvem slov.
function bestCsfdMatch(items, title) {
  const wanted = normalizeTitle(title).split(" ").filter((w) => w.length > 2);
  if (!wanted.length) return null;
  let best = null, bestScore = 0;
  for (const it of items) {
    if (/\/film\/\d+-[^/]+\/\d+-/.test(it.href)) continue; // epizoda, ne hlavní záznam
    const norm = normalizeTitle(it.title);
    const matches = wanted.filter((w) => norm.includes(w)).length;
    const score = matches / wanted.length;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 0.5 ? best : null;
}

async function enrichMovieFromCSFD(page, title) {
  const searchUrl = `https://www.csfd.cz/hledat/?q=${encodeURIComponent(title)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(CSFD_WAIT);
  const searchHtml = await page.content();
  const $s = cheerio.load(searchHtml);
  const items = [];
  $s("article.article-poster-50").each((_, el) => {
    const a = $s(el).find("a.film-title-name");
    const href = a.attr("href") || "";
    const t = a.text().trim();
    if (t && href) items.push({ title: t, href });
  });
  const match = bestCsfdMatch(items, title);
  if (!match) return null;

  const url = "https://www.csfd.cz" + match.href;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(CSFD_WAIT);
  const detailHtml = await page.content();
  const $d = cheerio.load(detailHtml);

  const poster = $d("meta[property='og:image']").attr("content") || null;
  const originText = $d(".origin").text().replace(/\s+/g, " ").trim();
  const country = (originText.split(/\d{4}/)[0] || "").replace(/[,·]/g, "").trim() || null;
  // Rok(y): "(2008–2013)" = seriál, jednoduchý rok "1994" = film
  const isSeries = /\(\d{4}\s*[–-]\s*\d{0,4}\)/.test(originText);
  const yearMatch = originText.match(/\b(19|20)\d{2}\b/);
  const ratingText = $d(".film-rating-average").first().text().trim();
  const ratingMatch = ratingText.match(/(\d{1,3})\s*%/);
  const genres = $d(".genres").text().split(/\s{2,}|,|\//).map((g) => g.replace(/\s+/g, " ").trim()).filter(Boolean);

  return {
    title: match.title,
    url,
    poster,
    country,
    year: yearMatch ? yearMatch[0] : null,
    rating: ratingMatch ? parseInt(ratingMatch[1], 10) : null,
    genres,
    type: isSeries ? "seriál" : "film",
  };
}

async function main() {
  console.log("[enrich] start", new Date().toISOString());
  const backlog = loadBacklog();
  if (!backlog.length) { console.log("[enrich] prázdný backlog, končím"); return; }

  // Find books needing enrichment: from databazeknih.cz without rating or price
  const toEnrich = backlog.filter((item) =>
    (item._category === "book" || !item._category) &&
    (item.cat || []).includes("databazeknih.cz") &&
    (item.rating == null || !item.prices?.length)
  );

  let changed = 0;

  // Game Pass flag pro hry v backlogu (přepočítá se vždy, katalog se mění denně)
  const gamePassSet = loadGamePassSet(__dirname);
  backlog.forEach((item) => {
    if (item._category !== "game") return;
    const flag = isInGamePass(item.title, gamePassSet);
    if (item.gamePass !== flag) { item.gamePass = flag; changed++; }
  });

  const toEnrichMovies = backlog.filter((item) => item._category === "movie" && item.rating == null);

  if (!toEnrich.length && !toEnrichMovies.length && !changed) { console.log("[enrich] vše obohaceno, nic k dělání"); return; }
  if (toEnrich.length) console.log(`[enrich] ${toEnrich.length} knih k obohacení`);
  for (const item of toEnrich) {
    console.log(`  → ${item.title}`);

    // Rating from databazeknih
    if (item.rating == null && item.link && item.link.includes("databazeknih")) {
      const { rating, cover } = await enrichFromDatabazeknih(item.link);
      if (rating != null) { item.rating = rating; item.ratingSource = "databazeknih.cz"; changed++; console.log(`    rating: ${rating}%`); }
      if (cover && !item.cover) item.cover = cover;
      await sleep(DELAY);
    }

    // Price from Kosmas
    if (!item.prices?.length) {
      const kosmas = await fetchKosmasPrice(item.title);
      if (kosmas) {
        item.prices = [kosmas];
        changed++;
        console.log(`    cena: ${kosmas.price} Kč (${kosmas.shop})`);
      }
      await sleep(DELAY);
      // Also try Dobrovský
      const dobr = await fetchDobrovskýPrice(item.title);
      if (dobr) {
        item.prices = [...(item.prices || []), dobr];
        changed++;
        console.log(`    cena: ${dobr.price} Kč (${dobr.shop})`);
      }
      await sleep(DELAY);
    }
  }

  // Filmy/seriály přidané "naslepo" z Backlog vyhledávání (bez rating = ještě neobohaceno)
  if (toEnrichMovies.length) {
    console.log(`[enrich] ${toEnrichMovies.length} filmů/seriálů k obohacení z ČSFD`);
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    const page = await browser.newPage({ userAgent: UA });
    for (const item of toEnrichMovies) {
      console.log(`  → ${item.title}`);
      try {
        const info = await enrichMovieFromCSFD(page, item.title);
        if (info) {
          if (info.poster) item.poster = info.poster;
          if (info.rating != null) item.rating = info.rating;
          if (info.year) item.year = info.year;
          if (info.country) item.country = info.country;
          if (info.genres?.length) item.genres = info.genres;
          if (info.type) item.type = info.type;
          if (info.url) item.url = info.url;
          changed++;
          console.log(`    ✓ ${info.type}, ${info.rating}%, ${info.year}`);
        } else {
          console.log("    ✗ na ČSFD nenalezeno");
        }
      } catch (e) {
        console.warn("    ! chyba:", e.message);
      }
    }
    await browser.close();
  }

  if (changed > 0) {
    fs.writeFileSync(BACKLOG_FILE, JSON.stringify(backlog, null, 2));
    console.log(`[enrich] hotovo: ${changed} změn uloženo → backlog.json`);
  } else {
    console.log("[enrich] žádné nové informace nenalezeny");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
