/**
 * Knižní radar – měsíční prodejní bestsellery Kosmas + Dobrovský
 * -------------------------------------------------------------
 * Node 18+ (globální fetch). Závislost: cheerio.   npm i cheerio && node build.js
 *
 * PRAVIDLA (dle zadání):
 *  - název, autor, cena, OBÁLKA, pořadí = JEN z obchodů (Kosmas, Dobrovský)
 *  - databazeknih.cz = VÝHRADNĚ procentuální hodnocení
 *  - pořadí: combined rank = nejlepší (nejnižší) pozice napříč obchody;
 *            shoda → víc obchodů, pak nižší součet pozic. #1 na obchodě = nahoře.
 *  - Kosmas: měsíční žebříček aktuálního měsíce (mainstream, ne 14denní výprodejový)
 *
 * POZN.: scraping je křehký; když obchod změní HTML / zablokuje IP, projeví se to v logu.
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "books.json");
const DBK = "https://www.databazeknih.cz";
const UA = "KnizniRadar/1.0 (+kontakt@example.cz)";
const DELAY = 700;
const PER_SHOP = 20;
const MAX_BOOKS = 40;

// aktuální měsíc pro Kosmas (formát "2026-6")
const NOW = new Date();
const MONTH = `${NOW.getFullYear()}-${NOW.getMonth() + 1}`;

const SHOPS = [
  { name: "Kosmas", base: "https://www.kosmas.cz",
    url: `https://www.kosmas.cz/bestsellery/${MONTH}/1x20/?articleTypeIds=3563,3564,3565`,
    detailRe: /\/knihy\/(\d+)\/([^/?#]+)/, idG: 1, slugG: 2, authorRe: /\/autor\// },
  { name: "Dobrovský", base: "https://www.knihydobrovsky.cz",
    url: "https://www.knihydobrovsky.cz/bestsellery/knihy",
    detailRe: /\/kniha\/([a-z0-9-]+)-(\d+)\b/, idG: 2, slugG: 1, authorRe: /\/autori\// },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s = "") => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const abs = (base, href) => (!href ? null : href.startsWith("http") ? href : base + href);
const isPlaceholder = (u = "") => /blank\.gif|1px|placeholder|spacer|loading/i.test(u);
function slugToTitle(slug) {
  const t = slug.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// --- scrape obchodu: pořadí dle žebříčku; vše z karty (titul slug, autor, cena, obálka) ---
function scrapeShop(html, shop) {
  const $ = cheerio.load(html);
  const byId = new Map();
  let order = 0;
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    const m = shop.detailRe.exec(href);
    if (!m) return;
    const id = m[shop.idG], slug = m[shop.slugG];
    if (byId.has(id)) return;

    const scope = (() => { const sc = $(a).closest("li, article, [class*='product'], [class*='item']"); return sc.length ? sc : $(a).parent().parent().parent(); })();

    let author = null;
    scope.find("a[href]").each((__, x) => { if (author) return; const h = $(x).attr("href") || ""; if (shop.authorRe.test(h)) { const t = $(x).text().replace(/\s+/g, " ").trim(); if (t) author = t; } });

    const prices = [...scope.text().matchAll(/(\d[\d\s]*)\s*Kč/g)].map((x) => parseInt(x[1].replace(/\s/g, ""), 10)).filter((n) => n >= 20 && n < 5000);
    const price = prices.length ? Math.min(...prices) : null; // sleva = aktuální (nižší)

    const img = scope.find("img").first();
    let cover = img.attr("src") || img.attr("data-src") || img.attr("data-original") || null;
    if (cover && isPlaceholder(cover)) cover = null;

    byId.set(id, { title: slugToTitle(slug), author, price, cover: cover ? abs(shop.base, cover) : null, url: abs(shop.base, href), pos: ++order });
  });
  return [...byId.values()].slice(0, PER_SHOP);
}

// --- databazeknih: VÝHRADNĚ % hodnocení ---
async function ratingDatabazeknih(title) {
  try {
    const $ = cheerio.load(await getHtml(`${DBK}/search?q=${encodeURIComponent(title)}&in=books`));
    const href = $("a[href*='/prehled-knihy/']").first().attr("href");
    if (!href) return null;
    await sleep(DELAY);
    const $$ = cheerio.load(await getHtml(href.startsWith("http") ? href : DBK + href));
    for (const sel of ["[itemprop='ratingValue']", ".bookRatingValue", ".ratingValue", ".bRatingValue"]) {
      const raw = $$(sel).first().text().replace(",", ".").replace(/[^\d.]/g, "");
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0) return n <= 5 ? Math.round(n * 20) : Math.round(n);
    }
    return null;
  } catch (e) { console.warn("[dbk]", title, "→", e.message); return null; }
}

async function main() {
  console.log("[build] start", new Date().toISOString(), "| Kosmas měsíc:", MONTH);
  const map = new Map();

  for (const shop of SHOPS) {
    let items = [];
    try { items = scrapeShop(await getHtml(shop.url), shop); console.log(`[shop] ${shop.name}: ${items.length} knih`); }
    catch (e) { console.warn(`[shop] ${shop.name} chyba: ${e.message}`); }
    items.forEach((it) => {
      const key = norm(it.title);
      if (!key) return;
      if (!map.has(key)) map.set(key, { title: it.title, author: null, cover: null, prices: [], ranks: [], shops: [] });
      const b = map.get(key);
      if (!b.author && it.author) b.author = it.author;
      if (!b.cover && it.cover) b.cover = it.cover;
      if (it.price) b.prices.push({ shop: shop.name, price: it.price, url: it.url });
      b.ranks.push(it.pos);
      b.shops.push(shop.name);
    });
    await sleep(DELAY);
  }

  // combined rank: nejnižší pozice → víc obchodů → nižší součet pozic
  const agg = [...map.values()].map((b) => ({
    ...b,
    minRank: Math.min(...b.ranks),
    shopsCount: new Set(b.shops).size,
    sumRank: b.ranks.reduce((a, c) => a + c, 0),
  })).sort((a, b) => a.minRank - b.minRank || b.shopsCount - a.shopsCount || a.sumRank - b.sumRank)
    .slice(0, MAX_BOOKS);

  console.log(`[build] agregováno ${agg.length} titulů, dotahuji % z databazeknih…`);

  const books = [];
  for (let i = 0; i < agg.length; i++) {
    const b = agg[i];
    const rating = await ratingDatabazeknih(b.title);
    await sleep(DELAY);
    books.push({
      title: b.title,
      author: b.author || "neznámý autor",
      cat: [...new Set(b.shops)],                 // tag = u kterých obchodů je bestseller
      rating,
      ratingSource: rating != null ? "databazeknih.cz" : null,
      readers: agg.length - i,                    // pořadí dle prodejní popularity (sestupně)
      series: null, lang: null, year: null, pages: null, publisher: null,
      desc: null,
      cover: b.cover || null,                     // Kosmas má obálku; u Dobrovský dotáhne web z Google Books
      link: null,
      prices: b.prices.sort((x, y) => x.price - y.price),
    });
  }

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), books }, null, 2));
  console.log(`[build] hotovo: ${books.length} titulů → books.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
