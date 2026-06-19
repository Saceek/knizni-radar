/**
 * Knižní radar – prodejní bestsellery obchodů + hodnocení/žánry z databazeknih
 * ---------------------------------------------------------------------------
 * Node 18+ (globální fetch). Závislost: cheerio.   npm i cheerio && node build.js
 *
 * - název knihy z URL produktu (slug) + slučování podle ID z URL (ne z textu odkazu)
 * - z čistého názvu se na databazeknih dotáhne přesný název, autor, hodnocení, ŽÁNRY, obálka
 * - kategorie = reálné žánry z databazeknih (tagy), žádné škatulkování; zobrazí se vše
 *
 * POZN.: scraping (křehké, e-shopy mohou blokovat / renderovat JS). Robustní cesta = feed.
 *   Luxor přes prostý fetch nejede (JS render) → vypnuto, případně přes feed.
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "books.json");
const DBK = "https://www.databazeknih.cz";
const UA = "KnizniRadar/1.0 (+kontakt@example.cz)"; // dosaď reálný kontakt
const DELAY = 700;
const PER_SHOP = 25;
const MAX_BOOKS = 40;

// re: zachytí ID i slug z URL produktu (idG/slugG = index capture group)
const SHOPS = [
  { name: "Kosmas", base: "https://www.kosmas.cz", url: "https://www.kosmas.cz/bestsellery/1x20/?articleTypeIds=3563,3564,3565",
    re: /\/knihy\/(\d+)\/([^/?#]+)/, idG: 1, slugG: 2 },
  { name: "Dobrovský", base: "https://www.knihydobrovsky.cz", url: "https://www.knihydobrovsky.cz/bestsellery/knihy",
    re: /\/kniha\/([a-z0-9-]+)-(\d+)\b/, idG: 2, slugG: 1 },
  // Luxor: JS-render → prostý fetch nestačí; zapnout až přes feed.
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s = "") => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const abs = (base, href) => (!href ? null : href.startsWith("http") ? href : base + href);
function slugToTitle(slug) {
  const t = slug.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// --- scrape obchodu: dedup podle ID z URL, název ze slugu, cena+obálka z karty ---
function scrapeShop(html, shop) {
  const $ = cheerio.load(html);
  const byId = new Map();
  let order = 0;
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    const m = shop.re.exec(href);
    if (!m) return;
    const id = m[shop.idG];
    const slug = m[shop.slugG];
    const scope = (() => { const sc = $(a).closest("li, article, [class*='product'], [class*='item']"); return sc.length ? sc : $(a).parent().parent(); })();
    if (byId.has(id)) {
      const b = byId.get(id);
      if (!b.price) {
        const pr = [...scope.text().matchAll(/(\d[\d\s]*)\s*Kč/g)].map((x) => parseInt(x[1].replace(/\s/g, ""), 10)).filter((n) => n >= 20 && n < 5000);
        if (pr.length) b.price = Math.min(...pr);
      }
      if (!b.cover) { const img = scope.find("img").first(); b.cover = abs(shop.base, img.attr("src") || img.attr("data-src") || img.attr("data-original")); }
      return;
    }
    const prices = [...scope.text().matchAll(/(\d[\d\s]*)\s*Kč/g)].map((x) => parseInt(x[1].replace(/\s/g, ""), 10)).filter((n) => n >= 20 && n < 5000);
    const img = scope.find("img").first();
    byId.set(id, {
      id, slugTitle: slugToTitle(slug), url: abs(shop.base, href),
      price: prices.length ? Math.min(...prices) : null,
      cover: abs(shop.base, img.attr("src") || img.attr("data-src") || img.attr("data-original")),
      order: order++,
    });
  });
  return [...byId.values()].sort((a, b) => a.order - b.order).slice(0, PER_SHOP);
}

// --- databazeknih: detail (název, autor, hodnocení, žánry, popis, rok, obálka) ---
function parseDetail($) {
  const title = $("h1[itemprop='name'], h1.book_title, h1").first().text().replace(/\s+/g, " ").trim() || null;
  const author = $("[itemprop='author']").first().text().trim() || $("a[href*='/autori/']").first().text().trim() || null;
  let rating = null;
  for (const sel of ["[itemprop='ratingValue']", ".bookRatingValue", ".ratingValue", ".bRatingValue"]) {
    const raw = $(sel).first().text().replace(",", ".").replace(/[^\d.]/g, "");
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) { rating = n <= 5 ? Math.round(n * 20) : Math.round(n); break; }
  }
  const genres = $("a[href*='/zanry/']").map((_, el) => $(el).text().trim()).get().filter(Boolean);
  let desc = ($("[itemprop='description']").first().text() || $(".perex, .summary").first().text() || "").replace(/\s+/g, " ").trim();
  if (desc.length > 180) desc = desc.slice(0, 180) + "…";
  const year = parseInt(($("[itemprop='datePublished']").first().text().match(/\d{4}/) || [])[0], 10) || null;
  const cover = $("[itemprop='image']").attr("src") || $(".kniha_img img, .book_cover img").first().attr("src") || null;
  return { title, author, rating, genres, desc: desc || null, year, cover: cover ? abs(DBK, cover) : null };
}

async function enrichDatabazeknih(query) {
  try {
    const $ = cheerio.load(await getHtml(`${DBK}/search?q=${encodeURIComponent(query)}&in=books`));
    const href = $("a[href*='/prehled-knihy/']").first().attr("href") || $("a[href*='/knihy/']").first().attr("href");
    if (!href) return {};
    const detailUrl = href.startsWith("http") ? href : DBK + href;
    await sleep(DELAY);
    return { ...parseDetail(cheerio.load(await getHtml(detailUrl))), link: detailUrl };
  } catch (e) { console.warn("[dbk]", query, "→", e.message); return {}; }
}

async function main() {
  console.log("[build] start", new Date().toISOString());
  const map = new Map(); // norm(slugTitle) → agregovaná kniha

  for (const shop of SHOPS) {
    let items = [];
    try { items = scrapeShop(await getHtml(shop.url), shop); console.log(`[shop] ${shop.name}: ${items.length} knih`); }
    catch (e) { console.warn(`[shop] ${shop.name} chyba: ${e.message}`); }
    items.forEach((it, i) => {
      const key = norm(it.slugTitle);
      if (!key) return;
      if (!map.has(key)) map.set(key, { slugTitle: it.slugTitle, prices: [], cover: null, score: 0, shops: 0 });
      const b = map.get(key);
      if (it.price) b.prices.push({ shop: shop.name, price: it.price, url: it.url });
      if (!b.cover && it.cover) b.cover = it.cover;
      b.score += PER_SHOP - i;
      b.shops += 1;
    });
    await sleep(DELAY);
  }

  const agg = [...map.values()].sort((a, b) => b.shops - a.shops || b.score - a.score).slice(0, MAX_BOOKS);
  console.log(`[build] agregováno ${agg.length} titulů, dotahuji databazeknih…`);

  const books = [];
  for (const b of agg) {
    const d = await enrichDatabazeknih(b.slugTitle);
    await sleep(DELAY);
    books.push({
      title: d.title || b.slugTitle,            // přesný název z databazeknih, jinak ze slugu
      author: d.author || "neznámý autor",
      cat: (d.genres || []).slice(0, 4),        // reálné žánry jako tagy (žádné škatulkování)
      rating: d.rating ?? null,
      ratingSource: d.rating != null ? "databazeknih.cz" : null,
      readers: b.score,                          // ~ prodejní popularita
      series: null, lang: null, year: d.year ?? null, pages: null, publisher: null,
      desc: d.desc ?? null,
      cover: b.cover || d.cover || null,
      link: d.link || null,
      prices: b.prices.sort((x, y) => x.price - y.price),
    });
  }

  books.sort((a, b) => b.readers - a.readers); // žebříček dle prodejní popularity
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), books }, null, 2));
  console.log(`[build] hotovo: ${books.length} titulů → books.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
