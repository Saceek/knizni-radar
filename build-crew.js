/**
 * Sáčkův radar – komiksové novinky nakladatelství CREW
 * ------------------------------------------------------
 * Node 18+ (globální fetch). Závislost: cheerio.   node build-crew.js
 *
 *  - seznam + cena = z výpisu novinek (obchod.crew.cz/kategorie--3/komiks/novinky)
 *  - autor (scénář/kresba) = z detailu komiksu
 *  - z databazeknih.cz: procentuální HODNOCENÍ + ODKAZ na stránku komiksu
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "crew.json");
const CREW_BASE = "https://www.obchod.crew.cz";
const DBK = "https://www.databazeknih.cz";
const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DELAY = 1000;
const MAX_ITEMS = 26;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(url, ua = UA_BROWSER) {
  const res = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function scrapeNovinky(html) {
  const $ = cheerio.load(html);
  const items = [];
  $("article.item").each((_, el) => {
    const scope = $(el);
    const link = scope.find("a.item__img, h3.item__tit a").first().attr("href") || "";
    const idMatch = link.match(/\/detail\/komiks-(\d+)-/);
    if (!idMatch) return;
    const id = idMatch[1];

    const title = scope.find("h3.item__tit").attr("title") || scope.find("h3.item__tit").text().trim();
    if (!title) return;

    const img = scope.find("a.item__img img").first();
    let cover = img.attr("data-src") || img.attr("src") || null;
    if (cover && !cover.startsWith("http")) cover = CREW_BASE + cover;
    if (cover && cover.includes("/ph/komiks.png")) cover = null; // placeholder, no real cover yet

    const priceEl = scope.find("span[itemprop='price']").first();
    const price = priceEl.length ? parseInt(priceEl.text().replace(/\D/g, ""), 10) : null;

    const delEl = scope.find("del").first();
    const originalPrice = delEl.length ? parseInt(delEl.text().replace(/\D/g, ""), 10) : null;

    items.push({
      id,
      title,
      price: price || null,
      originalPrice: originalPrice || null,
      discount: (originalPrice && price) ? Math.round(100 - (price / originalPrice) * 100) : 0,
      cover,
      url: CREW_BASE + link,
    });
  });
  return items.slice(0, MAX_ITEMS);
}

// Fetch author (scénář + kresba) from detail page
async function enrichFromDetail(url) {
  try {
    const $ = cheerio.load(await getHtml(url));
    const bodyText = $("body").text();
    const scriptMatch = bodyText.match(/Scénář:\s*([^\n]+?)(?:\s{2,}|Kresba:|$)/);
    const artMatch = bodyText.match(/Kresba:\s*([^\n]+?)(?:\s{2,}|Překlad:|Redakce:|$)/);
    const authors = [];
    if (scriptMatch) authors.push(scriptMatch[1].trim());
    if (artMatch && artMatch[1].trim() !== (scriptMatch ? scriptMatch[1].trim() : "")) authors.push(artMatch[1].trim());
    return { author: authors.length ? authors.join(", ") : null };
  } catch (e) {
    console.warn("[crew detail]", url, "→", e.message);
    return {};
  }
}

const norm = (s = "") => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Strip volume/issue numbers and bracket noise so "Kagurabači 4: Rovnost" ~ "Kagurabači" matches
function coreTitle(t) {
  return norm(t).replace(/\b\d+\b/g, "").replace(/\s{2,}/g, " ").trim();
}

// databazeknih: PROCENTUÁLNÍ hodnocení (0–100) + odkaz na stránku komiksu
// Ověřuje shodu názvu, aby se nenapárovala nesouvisející kniha se stejným prvním výsledkem hledání.
async function enrichDatabazeknih(title) {
  try {
    const wantedCore = coreTitle(title);
    const wantedWords = wantedCore.split(" ").filter((w) => w.length > 2);
    const urls = [
      `${DBK}/search?q=${encodeURIComponent(title)}&in=books`,
      `${DBK}/vyhledavani/knihy?q=${encodeURIComponent(title)}`,
    ];
    let href = null;
    for (const searchUrl of urls) {
      if (href) break;
      try {
        const $ = cheerio.load(await getHtml(searchUrl, UA_BROWSER));
        $("a[href]").each((_, a) => {
          if (href) return;
          const h = $(a).attr("href") || "";
          const slugMatch = h.match(/\/(?:prehled-knihy|knihy)\/([^/?#]+)-\d+(?:[/?#]|$)/);
          if (!slugMatch) return;
          // Match against the URL slug, not visible link text — image-link anchors have empty
          // text, and the text-link anchor often shows only the subtitle (e.g. "Rovnost" for
          // "Kagurabači 4: Rovnost"), missing the main series name entirely.
          const slugWords = norm(slugMatch[1].replace(/-/g, " "));
          const matches = wantedWords.filter((w) => slugWords.includes(w)).length;
          if (wantedWords.length && matches / wantedWords.length >= 0.6) href = h;
        });
      } catch (e) { /* try next URL */ }
      if (!href) await sleep(DELAY);
    }
    if (!href) return {};
    let link = (href.startsWith("http") ? href : DBK + href).replace("/knihy/", "/prehled-knihy/");
    await sleep(DELAY);
    const $$ = cheerio.load(await getHtml(link, UA_BROWSER));

    let rating = null;
    $$("a[href*='/hodnoceni-knihy/']").each((_, el) => {
      if (rating != null) return;
      const m = $$(el).text().replace(/\s+/g, "").match(/(\d{1,3})%/);
      if (m) { const n = parseInt(m[1], 10); if (n >= 0 && n <= 100) rating = n; }
    });

    return { rating, link };
  } catch (e) {
    console.warn("[crew dbk]", title, "→", e.message);
    return {};
  }
}

async function main() {
  console.log("[crew] start", new Date().toISOString());

  const listHtml = await getHtml(`${CREW_BASE}/kategorie--3/komiks/novinky`);
  const items = scrapeNovinky(listHtml);
  console.log(`[crew] ${items.length} komiksů nalezeno`);

  const comics = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    console.log(`  [${i + 1}/${items.length}] ${it.title}`);

    const detail = await enrichFromDetail(it.url);
    await sleep(DELAY);

    const dbk = await enrichDatabazeknih(it.title);

    comics.push({
      title: it.title,
      author: detail.author || null,
      cover: it.cover,
      rating: dbk.rating ?? null,
      ratingSource: dbk.rating != null ? "databazeknih.cz" : null,
      link: dbk.link || null,
      price: it.price,
      originalPrice: it.originalPrice,
      discount: it.discount,
      url: it.url,
      publisher: "CREW",
    });
  }

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), comics }, null, 2));
  console.log(`[crew] hotovo: ${comics.length} komiksů → crew.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
