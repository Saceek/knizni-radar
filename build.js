/**
 * Knižní radar – sběrací skript (Google Books API)
 * ------------------------------------------------
 * Node 18+ (globální fetch). BEZ závislostí, bez scrapingu.
 * Spustí se přes GitHub Actions, vyrobí ./books.json.
 *
 *   node build.js
 *
 * Proč Google Books: je to oficiální, strukturované JSON API → spolehlivé.
 * Dává: titul, autor, obálka, popis, ISBN, počet stran, rok, vydavatel,
 *       kde je k dispozici i hodnocení (averageRating) a cenu (Google Play).
 *
 * Co tím PROZATÍM nemáme (vyžaduje affiliate feedy / domluvu, ne scraping):
 *   - hodnocení z databazeknih.cz
 *   - ceny z Kosmas / Dobrovský / Luxor / Palmknihy
 * Tyhle zdroje se dají přidat později jako další "providers".
 */

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "books.json");
const KEY = process.env.GOOGLE_BOOKS_KEY ? `&key=${process.env.GOOGLE_BOOKS_KEY}` : "";
const PER_QUERY = 20;   // kolik výsledků na dotaz
const MAX_TOTAL = 30;   // kolik titulů nakonec ponechat

// Kategorie → vyhledávací dotazy (čeština). Klidně uprav/přidej.
const QUERIES = [
  { cat: "Detektivky", q: "detektivka" },
  { cat: "Detektivky", q: "krimi thriller" },
  { cat: "Životopisné", q: "biografie" },
  { cat: "Životopisné", q: "životopis memoáry" },
  { cat: "Rozhovory", q: "rozhovory kniha" },
  { cat: "Čeští autoři", q: "český román" },
  { cat: "Čeští autoři", q: "česká próza novinka" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s = "") => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
const hasCzechChars = (s = "") => /[ěščřžýáíéúůňťďĚŠČŘŽÝÁÍÉÚŮ]/.test(s);

async function googleBooks(q) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&langRestrict=cs&country=CZ&orderBy=relevance&maxResults=${PER_QUERY}${KEY}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "KnizniRadar/1.0" } });
    const data = await res.json();
    if (data.error) { console.warn("GB error:", data.error.message); return []; }
    return data.items || [];
  } catch (e) { console.warn("GB fetch:", e.message); return []; }
}

function mapVolume(item, cat) {
  const v = item.volumeInfo || {};
  const sale = item.saleInfo || {};
  if (!v.title) return null;

  const author = (v.authors || []).join(", ") || "neznámý autor";
  const cats = new Set([cat]);
  if (hasCzechChars(author)) cats.add("Čeští autoři");

  const isbn = (v.industryIdentifiers || []).find((i) => i.type === "ISBN_13" || i.type === "ISBN_10")?.identifier || null;
  const cover = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "").replace("http://", "https://").replace("&edge=curl", "") || null;

  // cena z Google Play (jediný zdroj v této verzi)
  let prices = [];
  if (sale.saleability === "FOR_SALE" && sale.retailPrice) {
    prices = [{ shop: "Google Play", price: Math.round(sale.retailPrice.amount), url: sale.buyLink || item.canonicalVolumeLink || null }];
  }

  return {
    title: v.title + (v.subtitle ? ": " + v.subtitle : ""),
    author,
    cat: [...cats],
    rating: v.averageRating ? Math.round(v.averageRating * 20) : null, // 0-5 → 0-100 %
    ratingCount: v.ratingsCount || null,
    ratingSource: v.averageRating ? "Google Books" : null,
    readers: v.ratingsCount || null,
    series: null,
    lang: v.language === "cs" ? "Čeština" : v.language || null,
    year: v.publishedDate ? parseInt(v.publishedDate.slice(0, 4), 10) || null : null,
    pages: v.pageCount || null,
    publisher: v.publisher || null,
    desc: (v.description || "").replace(/<[^>]+>/g, "").slice(0, 160) || null,
    isbn,
    cover,
    prices,
  };
}

async function main() {
  console.log("[build] start", new Date().toISOString());
  const byKey = new Map();

  for (const { cat, q } of QUERIES) {
    const items = await googleBooks(q);
    for (const it of items) {
      const b = mapVolume(it, cat);
      if (!b) continue;
      const key = norm(b.title + "|" + b.author);
      if (byKey.has(key)) {
        const ex = byKey.get(key);
        ex.cat = [...new Set([...ex.cat, ...b.cat])]; // sluč kategorie u duplicit
        if (!ex.cover && b.cover) ex.cover = b.cover;
        if (!ex.rating && b.rating) { ex.rating = b.rating; ex.ratingSource = b.ratingSource; ex.ratingCount = b.ratingCount; }
        if (!ex.prices.length && b.prices.length) ex.prices = b.prices;
      } else {
        byKey.set(key, b);
      }
    }
    await sleep(300); // slušný odstup
  }

  let books = [...byKey.values()]
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1)) // od nejvyššího hodnocení; bez hodnocení dolů
    .slice(0, MAX_TOTAL);

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), books }, null, 2));
  console.log(`[build] hotovo: ${books.length} titulů → books.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
