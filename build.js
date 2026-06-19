/**
 * Knižní radar – sběr z PRODEJNÍCH bestsellerů obchodů + hodnocení databazeknih
 * ----------------------------------------------------------------------------
 * Node 18+ (globální fetch). Závislost: cheerio.
 *   npm i cheerio
 *   node build.js
 *
 * Logika (dle zadání – relevantní je reálný prodej, ne „právě čtu"):
 *   1) seed = prodejní žebříčky obchodů (Kosmas, Dobrovský, Luxor)
 *   2) agregace napříč obchody → ceny pro porovnání; kniha u víc obchodů = výš
 *   3) hodnocení (%), kategorie, autor, popis a obálka z databazeknih.cz
 *
 * UPOZORNĚNÍ (čti):
 *   - Tohle je SCRAPING. Je křehký (změní-li obchod HTML, je třeba doladit selektory)
 *     a e-shopy mohou blokovat IP GitHub Actions (bot-ochrana). Pokud nějaký obchod
 *     vrátí 0 knih, uvidíš to v logu → robustní cesta je pak jeho affiliate/produktový feed.
 *   - Slušně: 1×/den, vlastní User-Agent, pauzy. Respektuj robots.txt a podmínky obchodů.
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "books.json");
const DBK = "https://www.databazeknih.cz";
const UA = "KnizniRadar/1.0 (+kontakt@example.cz)"; // dosaď reálný kontakt
const DELAY = 700;
const PER_SHOP = 20;   // kolik bestsellerů brát z každého obchodu
const MAX_BOOKS = 26;  // kolik nakonec dotáhnout z databazeknih

const SHOPS = [
  { name: "Kosmas",    base: "https://www.kosmas.cz",         url: "https://www.kosmas.cz/bestsellery/1x20/?articleTypeIds=3563,3564,3565", detail: /\/knihy\/\d+\// },
  { name: "Dobrovský", base: "https://www.knihydobrovsky.cz", url: "https://www.knihydobrovsky.cz/bestsellery/knihy",                       detail: /\/kniha\/[\w-]+-\d+/ },
  { name: "Luxor",     base: "https://www.luxor.cz",          url: "https://www.luxor.cz/c/9548/knihy",                                     detail: /\/v\/\d+\// },
  // Palmknihy (hlavně e-knihy) – ověř URL/selektory, pak odkomentuj:
  // { name: "Palmknihy", base: "https://www.palmknihy.cz", url: "https://www.palmknihy.cz/elektronicke-knihy", detail: /\/kniha\// },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s = "") => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const abs = (base, href) => (!href ? null : href.startsWith("http") ? href : base + href);

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// --- scrape jednoho obchodu: vrátí [{title, url, price, cover}] v pořadí žebříčku ---
function scrapeShop(html, shop) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];
  $("a").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (!shop.detail.test(href)) return;
    const title = ($(a).attr("title") || $(a).text() || "").replace(/\s+/g, " ").trim();
    if (title.length < 2) return;
    const key = norm(title);
    if (seen.has(key)) return;

    // karta = nejbližší rozumný kontejner
    let scope = $(a).closest("li");
    if (!scope.length) scope = $(a).closest("article");
    if (!scope.length) scope = $(a).parent().parent();
    const text = scope.text();
    const prices = [...text.matchAll(/(\d[\d\s]*)\s*Kč/g)]
      .map((m) => parseInt(m[1].replace(/\s/g, ""), 10))
      .filter((n) => n >= 20 && n < 5000);
    const price = prices.length ? Math.min(...prices) : null; // nejnižší uvedená = aktuální/akční
    const img = scope.find("img").first();
    const cover = img.attr("src") || img.attr("data-src") || img.attr("data-original") || null;

    seen.add(key);
    items.push({ title, url: abs(shop.base, href), price, cover: cover ? abs(shop.base, cover) : null });
  });
  return items.slice(0, PER_SHOP);
}

// --- databazeknih: detail knihy ---
function parseDetail($) {
  const author =
    $("[itemprop='author']").first().text().trim() ||
    $("a[href*='/autori/']").first().text().trim() || "neznámý autor";

  let rating = null;
  for (const sel of ["[itemprop='ratingValue']", ".bookRatingValue", ".ratingValue", ".bRatingValue"]) {
    const raw = $(sel).first().text().replace(",", ".").replace(/[^\d.]/g, "");
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) { rating = n <= 5 ? Math.round(n * 20) : Math.round(n); break; }
  }
  const genreTxt = $("a[href*='/zanry/']").map((_, el) => $(el).text().trim()).get().filter(Boolean).join(", ");
  let desc = ($("[itemprop='description']").first().text() || $(".perex, .summary").first().text() || "").replace(/\s+/g, " ").trim();
  if (desc.length > 180) desc = desc.slice(0, 180) + "…";
  const year = parseInt(($("[itemprop='datePublished']").first().text().match(/\d{4}/) || [])[0], 10) || null;
  const cover = $("[itemprop='image']").attr("src") || $(".kniha_img img, .book_cover img").first().attr("src") || null;
  return { author, rating, genreTxt, desc: desc || null, year, cover: cover ? abs(DBK, cover) : null };
}

async function enrichDatabazeknih(title) {
  try {
    const $ = cheerio.load(await getHtml(`${DBK}/search?q=${encodeURIComponent(title)}&in=books`));
    const href = $("a[href*='/prehled-knihy/']").first().attr("href") || $("a[href*='/knihy/']").first().attr("href");
    if (!href) return {};
    const detailUrl = href.startsWith("http") ? href : DBK + href;
    await sleep(DELAY);
    const d = parseDetail(cheerio.load(await getHtml(detailUrl)));
    return { ...d, link: detailUrl };
  } catch (e) { console.warn("[dbk]", title, "→", e.message); return {}; }
}

function classify(genreTxt = "", author = "") {
  const g = genreTxt.toLowerCase();
  const cats = new Set();
  if (/detektiv|krimi|thriller/.test(g)) cats.add("Detektivky");
  if (/biografie|memoár|memoar|životopis|zivotopis|pamět|pamet|literatura faktu/.test(g)) cats.add("Životopisné");
  if (/rozhovor/.test(g)) cats.add("Rozhovory");
  if (/[ěščřžýáíéúůňťďĚŠČŘŽÝÁÍÉÚŮ]/.test(author)) cats.add("Čeští autoři");
  return [...cats];
}

async function main() {
  console.log("[build] start", new Date().toISOString());
  const map = new Map(); // norm(title) → agregovaná kniha

  for (const shop of SHOPS) {
    let items = [];
    try { items = scrapeShop(await getHtml(shop.url), shop); console.log(`[shop] ${shop.name}: ${items.length} knih`); }
    catch (e) { console.warn(`[shop] ${shop.name} chyba: ${e.message}`); }
    items.forEach((it, i) => {
      const key = norm(it.title);
      if (!map.has(key)) map.set(key, { title: it.title, prices: [], cover: null, score: 0, shops: 0 });
      const b = map.get(key);
      if (it.price) b.prices.push({ shop: shop.name, price: it.price, url: it.url });
      if (!b.cover && it.cover) b.cover = it.cover;
      b.score += PER_SHOP - i; // vyšší pozice v žebříčku = víc bodů
      b.shops += 1;
    });
    await sleep(DELAY);
  }

  const agg = [...map.values()]
    .sort((a, b) => b.shops - a.shops || b.score - a.score) // víc obchodů + lepší pozice = výš
    .slice(0, MAX_BOOKS);
  console.log(`[build] agregováno ${agg.length} titulů, dotahuji databazeknih…`);

  const books = [];
  for (const b of agg) {
    const d = await enrichDatabazeknih(b.title);
    await sleep(DELAY);
    books.push({
      title: b.title,
      author: d.author || "neznámý autor",
      cat: classify(d.genreTxt, d.author || ""),
      rating: d.rating ?? null,
      ratingSource: d.rating != null ? "databazeknih.cz" : null,
      readers: b.score,         // ~ popularita dle prodejů (víc obchodů/lepší pozice)
      series: null,
      lang: null,
      year: d.year ?? null,
      pages: null,
      publisher: null,
      desc: d.desc ?? null,
      cover: b.cover || d.cover || null,
      link: d.link || null,
      prices: b.prices.sort((x, y) => x.price - y.price),
    });
  }

  // výchozí řazení dle prodejní popularity (žebříček); frontend umí přeřadit dle hodnocení/ceny
  books.sort((a, b) => b.readers - a.readers);

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), books }, null, 2));
  console.log(`[build] hotovo: ${books.length} titulů → books.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
