/**
 * Knižní radar – sběrací skript (one-shot) pro GitHub Actions
 * -----------------------------------------------------------
 * Node 18+ (globální fetch). Spustí se 1× denně přes GitHub Actions,
 * posbírá data a zapíše ./books.json, který si pak čte frontend.
 *
 *   npm i cheerio
 *   node build.js
 *
 * !!! LEGÁLNOST !!! – stejné zásady jako u serveru:
 *   - Obálky/metadata: Google Books API (oficiální).
 *   - Ceny: ideálně affiliate/produktové feedy obchodů (stabilní, ToS-friendly).
 *   - databazeknih.cz nemá veřejné API → respektuj robots.txt, slušný UA, 1×/den.
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "books.json");
const UA = "KnizniRadar/1.0 (kontakt@example.cz)"; // dosaď reálný kontakt
const DELAY = 1200; // ms mezi requesty na stejný zdroj
const GOOGLE_KEY = process.env.GOOGLE_BOOKS_KEY || "";
const CATEGORIES = ["Detektivky", "Životopisné", "Rozhovory", "Čeští autoři"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normTitle = (s = "") => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

async function httpGet(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// ---------- SEED: seznam titulů (příklad: Kosmas bestsellery 14 dní) ----------
async function seedKosmasBestsellers(maxItems = 30) {
  const html = await httpGet(`https://www.kosmas.cz/bestsellery/1x${maxItems}/?articleTypeIds=3563`);
  const $ = cheerio.load(html);
  const items = [];
  $("h3 a[href*='/knihy/']").each((_, el) => {
    const title = $(el).text().trim();
    const $card = $(el).closest("*").parent();
    const author = $card.find("a[href*='/autor/']").first().text().trim() || null;
    const url = "https://www.kosmas.cz" + $(el).attr("href");
    if (title) items.push({ title, author, sourceUrl: url });
  });
  const seen = new Set();
  return items.filter((b) => { const k = normTitle(b.title); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- METADATA + OBÁLKA: Google Books (oficiální API) ----------
async function enrichGoogleBooks(book) {
  const q = encodeURIComponent(`intitle:${book.title}${book.author ? " inauthor:" + book.author.split("(")[0] : ""}`);
  const key = GOOGLE_KEY ? `&key=${GOOGLE_KEY}` : "";
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&country=CZ${key}`, { headers: { "User-Agent": UA } });
    const data = await res.json();
    const v = data?.items?.[0]?.volumeInfo;
    if (!v) return book;
    const isbn = (v.industryIdentifiers || []).find((i) => i.type === "ISBN_13" || i.type === "ISBN_10")?.identifier;
    const cover = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "").replace("http://", "https://").replace("&edge=curl", "");
    return {
      ...book,
      isbn: isbn || null,
      cover: cover || null,
      pages: v.pageCount || null,
      year: v.publishedDate ? parseInt(v.publishedDate.slice(0, 4), 10) : null,
      publisher: v.publisher || null,
      lang: v.language === "cs" ? "Čeština" : v.language || null,
      desc: (v.description || "").slice(0, 160) || null,
    };
  } catch (e) { console.warn("GoogleBooks:", e.message); return book; }
}

// ---------- CENY: jeden provider na obchod. Kosmas jako funkční vzor. ----------
async function priceKosmas(book) {
  try {
    const q = encodeURIComponent(book.isbn || book.title);
    const html = await httpGet(`https://www.kosmas.cz/hledani/?q=${q}`);
    const $ = cheerio.load(html);
    const link = $("a[href*='/knihy/']").first().attr("href");
    const priceTxt = $(".price, .cena, [class*='price']").first().text().replace(/\s/g, "");
    const price = parseInt((priceTxt.match(/(\d+)\s*Kč/) || priceTxt.match(/(\d+)/) || [])[1], 10);
    if (!price) return null;
    return { shop: "Kosmas", price, url: link ? "https://www.kosmas.cz" + link : "https://www.kosmas.cz" };
  } catch (e) { console.warn("Kosmas:", e.message); return null; }
}
// TODO: napoj přes feed/HTML – dokud nevrací, obchod se prostě nezobrazí
async function priceDobrovsky() { return null; }
async function priceLuxor() { return null; }
async function pricePalmknihy() { return null; }
const PRICE_PROVIDERS = [priceKosmas, priceDobrovsky, priceLuxor, pricePalmknihy];

// ---------- HODNOCENÍ: databazeknih.cz (selektory ověř proti živému HTML) ----------
async function ratingDatabazeKnih(book) {
  try {
    const q = encodeURIComponent(book.title);
    const html = await httpGet(`https://www.databazeknih.cz/search?q=${q}&in=books`);
    const $ = cheerio.load(html);
    const href = $("a.new[href*='/knihy/'], a[href*='/prehled-knihy/']").first().attr("href");
    if (!href) return null;
    const detail = await httpGet(href.startsWith("http") ? href : "https://www.databazeknih.cz" + href);
    const $$ = cheerio.load(detail);
    const percent = parseInt($$(".ratingValue, [itemprop='ratingValue'], .bookRatingValue").first().text().replace(/\D/g, ""), 10);
    const count = parseInt($$("[itemprop='ratingCount'], .ratingDetail .label").first().text().replace(/\D/g, ""), 10) || null;
    return Number.isFinite(percent) ? { percent, count } : null;
  } catch (e) { console.warn("databazeknih:", e.message); return null; }
}

// ---------- Kategorizace (heuristika; ladí se dle reálných štítků) ----------
function classify(book) {
  const cats = new Set();
  const hay = normTitle(`${book.title} ${book.desc || ""}`);
  if (/detektiv|krimi|vrazd|thriller|zlocin/.test(hay)) cats.add("Detektivky");
  if (/zivotopis|biografie|memoar|pameti/.test(hay)) cats.add("Životopisné");
  if (/rozhovor/.test(hay)) cats.add("Rozhovory");
  if (/[ěščřžýáíéúů]/i.test(book.author || "")) cats.add("Čeští autoři");
  return [...cats];
}

// ---------- Hlavní běh ----------
async function main() {
  console.log("[build] start", new Date().toISOString());
  const seed = await seedKosmasBestsellers(30);
  const out = [];

  for (const raw of seed) {
    let book = await enrichGoogleBooks({ ...raw, readers: null });
    await sleep(DELAY);

    const prices = [];
    for (const p of PRICE_PROVIDERS) { const r = await p(book); if (r?.price) prices.push(r); await sleep(DELAY); }
    book.prices = prices;

    const rating = await ratingDatabazeKnih(book);
    await sleep(DELAY);
    book.rating = rating?.percent ?? null;
    book.ratingCount = rating?.count ?? null;
    book.ratingSource = rating ? "databazeknih.cz" : null;

    book.cat = classify(book);
    out.push(book);
  }

  const filtered = out
    .filter((b) => b.cat.length > 0)
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), books: filtered }, null, 2));
  console.log(`[build] hotovo: ${filtered.length} titulů → books.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
