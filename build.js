/**
 * Knižní radar – měsíční prodejní bestsellery Kosmas + Dobrovský
 * -------------------------------------------------------------
 * Node 18+ (globální fetch). Závislost: cheerio.   npm i cheerio && node build.js
 *
 *  - pořadí + cena = z výpisu bestsellerů (Kosmas, Dobrovský)
 *  - NÁZEV (s diakritikou) + OBÁLKA = z detailu knihy v obchodě (og:title / og:image)
 *  - z databazeknih.cz: procentuální HODNOCENÍ + ODKAZ na stránku knihy
 *  - obálka: og:image z obchodu → databazeknih → Google Books (poslední záloha)
 *  - pořadí: combined rank = nejnižší pozice napříč obchody; shoda → víc obchodů → nižší součet
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "books.json");
const DBK = "https://www.databazeknih.cz";
const UA = "KnizniRadar/1.0 (+kontakt@example.cz)";
const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DELAY = 700;
const PER_SHOP = 20;
const MAX_BOOKS = 40;

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
const abs = (base, href) => (!href ? null : href.startsWith("http") ? href : href.startsWith("//") ? "https:" + href : base + href);
const isPlaceholder = (u = "") => /blank\.gif|1px|placeholder|spacer|loading/i.test(u);
function slugToTitle(slug) {
  const t = slug.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

// odřízne koncové formátové/edicní značky: "[e-kniha]", "(audiokniha)", "[brožovaná vazba]"…
// (jen když závorka obsahuje známé klíčové slovo – běžné názvy v závorkách zůstanou)
const EDITION_RE = /\s*[\[(]\s*(e-?kniha|e-?book|audiokniha|audio|mp3|cd|dvd|kniha|bro\u017eovan\xe1|v\xe1zan\xe1|pevn\xe1 vazba|paperback|hardback|hardcover|defektn\xed|po\u0161kozen\xfd obal|bazar)[^\])]*[\])]\s*$/i;
function stripEdition(t) {
  let s = t || "", prev;
  do { prev = s; s = s.replace(EDITION_RE, "").trim(); } while (s !== prev);
  return s.replace(/\s{2,}/g, " ").trim();
}

// slučovací klíč: bez diakritiky/interpunkce + bez zbylých formátových slov (e kniha, audiokniha…)
function mergeKey(title) {
  return norm(stripEdition(title))
    .replace(/\b(e ?kniha|e ?book|audiokniha)\b/g, "")
    .replace(/\s{2,}/g, " ").trim();
}

// "Už letím - Martin Moravec,Marek Dvořák"  ->  "Už letím"
function cleanOgTitle(ogTitle) {
  if (!ogTitle) return null;
  let t = ogTitle.split("|")[0].trim();          // pryč "| Knihy Dobrovský" / "| KOSMAS.cz"
  t = t.replace(/\s+[–-]\s+[^–-]+$/, "").trim();  // pryč koncové " - Autor(é)"
  t = stripEdition(t);                            // pryč "[e-kniha]" apod.
  return t || null;
}

async function getHtml(url, ua = UA) {
  const res = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// detail knihy v obchodě → skutečný název (og:title) + obálka (og:image)
async function shopDetail(url) {
  try {
    const $ = cheerio.load(await getHtml(url));
    const og = (p) => $(`meta[property='${p}']`).attr("content") || $(`meta[name='${p}']`).attr("content") || null;
    const title = cleanOgTitle(og("og:title"));
    let cover = og("og:image");
    if (cover && isPlaceholder(cover)) cover = null;
    return { title, cover: cover || null };
  } catch (e) { console.warn("[detail]", url, "→", e.message); return {}; }
}

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
    const scope = (() => { const sc = $(a).closest(".grid-item, li, article, [class*='product']"); return sc.length ? sc : $(a).parent().parent().parent(); })();
    let author = null;
    scope.find("a[href]").each((__, x) => { if (author) return; const h = $(x).attr("href") || ""; if (shop.authorRe.test(h)) { const t = $(x).text().replace(/\s+/g, " ").trim(); if (t) author = t; } });
    const prices = [...scope.text().matchAll(/(\d[\d\s]*)\s*Kč/g)].map((x) => parseInt(x[1].replace(/\s/g, ""), 10)).filter((n) => n >= 20 && n < 5000);
    const price = prices.length ? Math.min(...prices) : null;
    const img = scope.find("img").first();
    let cover = img.attr("src") || img.attr("data-src") || img.attr("data-original") || null;
    if (cover && isPlaceholder(cover)) cover = null;
    byId.set(id, {
      titleFallback: slugToTitle(slug),     // jen záloha, hlavní název přijde z detailu
      author, price,
      cover: cover ? abs(shop.base, cover) : null,
      url: abs(shop.base, href), pos: ++order,
    });
  });
  return [...byId.values()].slice(0, PER_SHOP);
}

// databazeknih: PROCENTUÁLNÍ hodnocení (0–100) + obálka + odkaz na stránku knihy
async function enrichDatabazeknih(title) {
  try {
    const $ = cheerio.load(await getHtml(`${DBK}/search?q=${encodeURIComponent(title)}&in=books`, UA_BROWSER));
    // první odkaz na detail knihy: /knihy/<slug>-<id> i /prehled-knihy/<slug>-<id>
    let href = null;
    $("a[href]").each((_, a) => {
      if (href) return;
      const h = $(a).attr("href") || "";
      if (/\/(prehled-knihy|knihy)\/[^/?#]+-\d+(?:[/?#]|$)/.test(h)) href = h;
    });
    if (!href) return {};
    let link = (href.startsWith("http") ? href : DBK + href).replace("/knihy/", "/prehled-knihy/");
    await sleep(DELAY);
    const $$ = cheerio.load(await getHtml(link, UA_BROWSER));

    // procento je text odkazu na /hodnoceni-knihy/... ve tvaru "96 %"
    let rating = null;
    $$("a[href*='/hodnoceni-knihy/']").each((_, el) => {
      if (rating != null) return;
      const m = $$(el).text().replace(/\s+/g, "").match(/(\d{1,3})%/);
      if (m) { const n = parseInt(m[1], 10); if (n >= 0 && n <= 100) rating = n; }
    });

    const cover = $$("meta[property='og:image']").attr("content") || null;
    return { rating, cover, link };
  } catch (e) { console.warn("[dbk]", title, "→", e.message); return {}; }
}

// Google Books – úplně poslední záloha obálky (dle názvu + autora). Volitelně GOOGLE_BOOKS_API_KEY.
async function googleCover(title, author) {
  const hasAuthor = author && author !== "neznámý autor";
  const q = `intitle:${title}` + (hasAuthor ? `+inauthor:${author}` : "");
  const params = new URLSearchParams({ q, country: "CZ", maxResults: "3" });
  if (process.env.GOOGLE_BOOKS_API_KEY) params.set("key", process.env.GOOGLE_BOOKS_API_KEY);
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`,
      { headers: { "User-Agent": UA, "Accept-Language": "cs" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const it of data.items || []) {
      const links = it.volumeInfo && it.volumeInfo.imageLinks;
      const raw = links && (links.thumbnail || links.smallThumbnail);
      if (raw) return raw.replace(/^http:/, "https:").replace("&edge=curl", "").replace("zoom=1", "zoom=2");
    }
    return null;
  } catch (e) { console.warn("[google]", title, "→", e.message); return null; }
}

async function main() {
  console.log("[build] start", new Date().toISOString(), "| Kosmas měsíc:", MONTH);
  const map = new Map();

  for (const shop of SHOPS) {
    let items = [];
    try { items = scrapeShop(await getHtml(shop.url), shop); console.log(`[shop] ${shop.name}: ${items.length} knih`); }
    catch (e) { console.warn(`[shop] ${shop.name} chyba: ${e.message}`); }

    // dotáhni z detailu skutečný název + obálku (og:title / og:image)
    for (const it of items) {
      const d = await shopDetail(it.url);
      it.title = d.title || stripEdition(it.titleFallback); // hlavní = og:title, jinak slug-záloha
      if (d.cover) it.cover = d.cover;                  // og:image je spolehlivá obálka
      await sleep(DELAY);
    }

    items.forEach((it) => {
      const key = mergeKey(it.title);                   // tištěná i e-kniha → stejný klíč
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

  const agg = [...map.values()].map((b) => ({
    ...b, minRank: Math.min(...b.ranks), shopsCount: new Set(b.shops).size, sumRank: b.ranks.reduce((a, c) => a + c, 0),
  })).sort((a, b) => a.minRank - b.minRank || b.shopsCount - a.shopsCount || a.sumRank - b.sumRank).slice(0, MAX_BOOKS);

  console.log(`[build] agregováno ${agg.length} titulů, dotahuji databazeknih…`);

  const books = [];
  let googleFilled = 0;
  for (let i = 0; i < agg.length; i++) {
    const b = agg[i];
    const e = await enrichDatabazeknih(b.title);
    await sleep(DELAY);

    // obálka: og:image z obchodu → databazeknih → Google Books (poslední záloha)
    let cover = b.cover || e.cover || null;
    let coverSource = b.cover ? "shop" : (e.cover ? "databazeknih.cz" : null);
    if (!cover) {
      const gc = await googleCover(b.title, b.author);
      if (gc) { cover = gc; coverSource = "google-books"; googleFilled++; }
      await sleep(DELAY);
    }

    books.push({
      title: b.title,
      author: b.author || "neznámý autor",
      cat: [...new Set(b.shops)],
      rating: e.rating ?? null,
      ratingSource: e.rating != null ? "databazeknih.cz" : null,
      readers: agg.length - i,
      series: null, lang: null, year: null, pages: null, publisher: null, desc: null,
      cover,                 // og:image z obchodu → databazeknih → Google Books
      coverSource,           // shop | databazeknih.cz | google-books | null
      link: e.link || null,  // odkaz na stránku knihy na databazeknih
      prices: b.prices.sort((x, y) => x.price - y.price),
    });
  }

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), books }, null, 2));
  console.log(`[build] hotovo: ${books.length} titulů → books.json (Google Books doplnil ${googleFilled} obálek)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
