/**
 * Sáčkův radar – Coming Soon: očekávané filmy, seriály, hry a knihy
 * ------------------------------------------------------------------
 * Node 18+, playwright, cheerio.   node build-coming.js
 *
 *  - ČSFD: "Filmy/Seriály, na které se nejvíce těším" seznamy
 *  - Steam: Popular Upcoming / Most Wishlisted coming soon
 *  - Kosmas: předobjednávky knih
 */

const { chromium } = require("playwright");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "coming.json");
const DELAY = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrapeCSFDList(page, url, type) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await sleep(3000);

  // Scroll down multiple times to load more items
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(800);
  }
  await page.evaluate(() => window.scrollTo(0, 0));

  const currentYear = new Date().getFullYear();
  const items = await page.evaluate(({ type, currentYear }) => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll("a[href*='/film/']").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const match = href.match(/\/film\/(\d+)-([^/]+)/);
      if (!match) return;
      const id = match[1];
      if (seen.has(id)) return;
      seen.add(id);

      let title = a.textContent.trim();
      if (/^\d+\.$/.test(title)) {
        const parent = a.closest("li, article, tr, [class*='item'], .article-poster, section, div") || a.parentElement;
        if (parent) {
          const titleLink = parent.querySelector(".film-title-name, h3 a, .article-movie-content a");
          if (titleLink) title = titleLink.textContent.trim();
        }
      }
      if (!title || title.length < 2 || /^\d+\.$/.test(title)) {
        const slug = match[2] || "";
        title = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
      }
      if (!title || title.length < 2 || title === "více" || title === "Filmy" || title === "Seriály") return;

      const container = a.closest("li, article, tr, [class*='item'], .article-poster, section") || a.parentElement;
      const text = container ? container.textContent.replace(/\s+/g, " ").trim() : "";
      const yearMatch = text.match(/\b(202[4-9]|203\d)\b/);
      const year = yearMatch ? yearMatch[0] : null;

      if (year && parseInt(year) < currentYear) return;

      const img = container ? container.querySelector("img") : null;
      let poster = img ? (img.getAttribute("src") || img.getAttribute("data-src") || "") : "";
      if (poster.startsWith("//")) poster = "https:" + poster;
      if (/placeholder|spacer|1px/i.test(poster)) poster = "";

      results.push({ id, title, year, type, poster: poster || null, url: "https://www.csfd.cz" + href });
    });

    return results;
  }, { type, currentYear });

  console.log(`  [scroll] ${items.length} budoucích položek nalezeno`);
  return items;
}

async function enrichCSFDItems(page, items) {
  for (const item of items.slice(0, 50)) {
    try {
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await sleep(DELAY);

      const detail = await page.evaluate(() => {
        const og = (p) => document.querySelector(`meta[property='${p}']`)?.getAttribute("content") || null;
        const poster = og("og:image");

        const originEl = document.querySelector(".origin, [class*='origin']");
        const originText = originEl ? originEl.textContent.trim() : "";
        const parts = originText.split(",").map((s) => s.trim());
        let country = null, genres = [];
        const genreWords = /akční|drama|komed|horor|thriller|sci-fi|fantasy|animovan|dokument|rodinný|dobrodruž|mysteriózn|krimi|válečný|hudební|historick|romantick|western|sportovní|pohádka/i;
        parts.forEach((p) => {
          if (/^\d{4}$/.test(p) || /\d+\s*min/.test(p)) return;
          if (p.includes("/")) {
            const subs = p.split("/").map((s) => s.trim());
            if (subs.some((s) => genreWords.test(s))) genres.push(...subs);
            else if (!country) country = p;
          } else if (genreWords.test(p)) genres.push(p);
          else if (!country) country = p;
        });

        // Premiere date
        let premiereDate = null;
        const allText = document.body.innerText || "";
        const dateMatch = allText.match(/(?:V kinech od|Na VOD od|Premiéra)\s*(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/i);
        if (dateMatch) premiereDate = dateMatch[1].replace(/\s/g, "");

        // VOD platform
        const vodMatch = allText.match(/Na VOD od[\s\S]{0,30}?(Netflix|HBO\s*Max|Disney\+|Amazon Prime|Prime Video|Apple TV\+?|Canal\+|Voyo|SkyShowtime)/i);
        const vod = vodMatch ? [vodMatch[1].trim()] : [];
        if (!vod.length && /V kinech od/i.test(allText)) vod.push("Kino");

        // Get proper title from og:title
        let ogTitle = og("og:title");
        if (ogTitle) ogTitle = ogTitle.split("|")[0].split("–")[0].split(" - ČSFD")[0].trim();

        return { poster, country, genres, premiereDate, vod, ogTitle };
      });

      if (detail.ogTitle) item.title = detail.ogTitle;
      if (detail.poster && !detail.poster.includes("logo-social")) item.poster = detail.poster;
      if (detail.country) item.country = detail.country;
      if (detail.genres?.length) item.genres = detail.genres;
      if (detail.premiereDate) item.premiereDate = detail.premiereDate;
      if (detail.vod?.length) item.vod = detail.vod;
      // Update year from premiere date if available
      if (detail.premiereDate) {
        const ym = detail.premiereDate.match(/(\d{4})/);
        if (ym) item.year = ym[1];
      }

      console.log(`  [+] ${item.title} — ${item.premiereDate || "bez data"}, ${(item.genres || []).join(", ") || "–"}`);
    } catch (e) {
      console.warn(`  [!] ${item.title} — ${e.message}`);
    }
  }
}

// ČSFD kalendář kinopremiér po měsících (/kino/premiery/?month=&year=) – datum je v nadpisu
// skupiny („v kinech od 29.10.2026“), plakát/rok/země/žánr přímo u filmu, bez návštěvy detailu.
async function scrapeCSFDPremieres(page, months = 3) {
  const out = [], seen = new Set();
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const url = `https://www.csfd.cz/kino/premiery/?month=${d.getMonth() + 1}&year=${d.getFullYear()}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(4000);
      const items = await page.evaluate(() => {
        // nadpisy skupin: elementy bez filmů uvnitř, jejichž vlastní text obsahuje datum
        const heads = [...document.querySelectorAll("body *")].filter((el) => {
          if (el.querySelector("article")) return false;
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
          return /v kinech od\s*\d{1,2}\.\d{1,2}\.\d{4}/i.test(own);
        }).map((el) => ({ el, date: el.textContent.match(/(\d{1,2}\.\d{1,2}\.\d{4})/)[1] }));
        const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return [...document.querySelectorAll("article")].map((el) => {
          const a = el.querySelector("a.film-title-name");
          if (!a) return null;
          const m = (a.getAttribute("href") || "").match(/\/film\/(\d+)-/);
          const img = el.querySelector("img");
          const srcset = img ? (img.getAttribute("srcset") || "") : "";
          const big = (srcset.match(/(\S+)\s+2x/) || [])[1] || (img && img.getAttribute("src")) || "";
          const genresTxt = (el.querySelector(".film-origins-genres .info") || {}).textContent || "";
          const country = ((el.querySelector(".info-country") || {}).textContent || "").trim();
          const head = heads.filter((h) => before(h.el, el)).pop();
          return {
            id: m ? m[1] : null, title: a.textContent.trim(), url: "https://www.csfd.cz" + a.getAttribute("href"),
            year: ((el.querySelector(".film-title-info .info") || {}).textContent || "").trim(),
            poster: big ? (big.startsWith("//") ? "https:" + big : big) : null,
            country: country || null,
            genres: genresTxt.replace(country, "").split(",").map((g) => g.trim()).filter((g) => g.length > 1),
            premiereDate: head ? head.date : null,
          };
        }).filter(Boolean);
      });
      let added = 0;
      for (const it of items) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        out.push({ ...it, type: "film", vod: ["Kino"], source: "premiery" });
        added++;
      }
      console.log(`  [premiéry] ${d.getMonth() + 1}/${d.getFullYear()}: ${added} filmů`);
    } catch (e) {
      console.warn(`  [premiéry] ${url}: ${e.message}`);
    }
  }
  return out;
}

// SerialZone – premiéry řad seriálů (díly E01) z kalendáře zahraničních seriálů. Kalendář
// obsahuje i stovky lokálních pořadů, takže se filtruje: další řady známých seriálů podle počtu
// hodnocení, úplně nové seriály podle velké streamovací platformy a žánru. Údaje o seriálech
// se cachují na týden (coming hraje každou hodinu, SerialZone nechceme zatěžovat).
const SZ_CACHE = path.join(__dirname, "serialzone-cache.json");
const SZ_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SZ_MIN_VOTES = 80;
const SZ_BIG = /Netflix|HBO|Max|Disney|Prime Video|Apple TV|SkyShowtime|Paramount|Peacock|Hulu|FX|AMC|BBC|ITV|Showtime|Starz|Canal|Sky/i;
const SZ_SKIP_GENRES = /animovan|anime|reality|dokument|talk|soutěž|zábavn|pořad|kuchař|vaření|zpravodaj|sport/i;
const decodeHtml = (s) => (s || "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").trim();
async function szShow(slug, cache) {
  const c = cache[slug];
  if (c && (Date.now() - c.fetchedAt) / 864e5 < 7) return c;
  const res = await fetch(`https://www.serialzone.cz/serial/${slug}/`, { headers: { "User-Agent": SZ_UA, "Accept-Language": "cs" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const t = await res.text();
  const info = (t.match(/<div class="mb-sz-basic-info-line">([\s\S]*?)<\/div>/) || [])[1] || "";
  const stanice = [...info.matchAll(/stanice=[^"]*">([^<]+)</g)].map((m) => decodeHtml(m[1]));
  const genres = [...info.matchAll(/zanr\[\]=[^"]*">([^<]+)</g)].map((m) => decodeHtml(m[1]));
  const country = [...info.matchAll(/zeme=[^"]*">([^<]+)</g)].map((m) => decodeHtml(m[1]));
  const votes = +((t.match(/itemprop="ratingCount">(\d+)</) || [])[1] || 0);
  const rating = (t.match(/itemprop="ratingValue">(\d+)</) || [])[1];
  const poster = (t.match(/https:\/\/www\.serialzone\.cz\/obrazky\/plakaty\/[^"' ]+\.jpg/) || [])[0] || null;
  const desc = decodeHtml((t.match(/property="og:description" content="([^"]*)"/) || [])[1] || "");
  const entry = { stanice, genres, country: country.join(" / ") || null, votes, rating: rating ? +rating : null, poster, desc, fetchedAt: Date.now() };
  cache[slug] = entry;
  await sleep(500);
  return entry;
}
async function scrapeSerialZone(months = 3) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(SZ_CACHE, "utf-8")); } catch { /* první běh */ }
  const out = [], seen = new Set();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = d.getFullYear(), mo = d.getMonth() + 1;
    let html;
    try {
      const r = await fetch(`https://www.serialzone.cz/kalendar/zahranicni/${y}/${mo}/`, { headers: { "User-Agent": SZ_UA, "Accept-Language": "cs" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      html = await r.text();
    } catch (e) { console.warn(`  [serialzone] ${mo}/${y}: ${e.message}`); continue; }
    // den v měsíci = poslední <div class="date"> před záznamem
    const re = /<div class="date"[^>]*><a[^>]*>(\d{1,2})<\/a><\/div>|<div data-sid="\d+" class="([^"]+)">[\s\S]{0,200}?href="https:\/\/www\.serialzone\.cz\/serial\/([^/]+)\/" title="[^"]*" class="cef-text">([^<]+)<br \/><span class="font10">S(\d+)E01<\/span>/g;
    let day = null, cnt = 0;
    for (const m of html.matchAll(re)) {
      if (m[1]) { day = +m[1]; continue; }
      const slug = m[3];
      if (!day || seen.has(slug)) continue;
      const date = new Date(y, mo - 1, day);
      if (date < today) continue;
      seen.add(slug);
      const season = +m[5];
      let s;
      try { s = await szShow(slug, cache); } catch (e) { console.warn(`  [serialzone] ${slug}: ${e.message}`); continue; }
      if (s.genres.some((g) => SZ_SKIP_GENRES.test(g))) continue;
      const big = s.stanice.some((st) => SZ_BIG.test(st));
      const ok = season > 1 ? s.votes >= SZ_MIN_VOTES : big;
      if (!ok) continue;
      cnt++;
      out.push({
        id: "sz-" + slug, title: decodeHtml(m[4]), type: "seriál", season,
        year: String(y), url: `https://www.serialzone.cz/serial/${slug}/`, poster: s.poster,
        genres: s.genres.slice(0, 3), country: s.country,
        premiereDate: `${String(day).padStart(2, "0")}.${String(mo).padStart(2, "0")}.${y}`,
        vod: s.stanice.slice(0, 1), votes: s.votes, source: "serialzone",
      });
    }
    console.log(`  [serialzone] ${mo}/${y}: ${cnt} premiér řad po filtru`);
  }
  // cache nezvětšovat donekonečna – staré záznamy pryč
  for (const k of Object.keys(cache)) if ((Date.now() - cache[k].fetchedAt) / 864e5 > 30) delete cache[k];
  fs.writeFileSync(SZ_CACHE, JSON.stringify(cache));
  return out;
}

const normTitle = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function scrapeSteamComing(page) {
  await page.goto("https://store.steampowered.com/search/?filter=popularcomingsoon&ndl=1", {
    waitUntil: "networkidle", timeout: 30000,
  });
  await sleep(2000);

  const items = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll("a.search_result_row[data-ds-appid]").forEach((row, i) => {
      if (i >= 25) return;
      const appid = (row.getAttribute("data-ds-appid") || "").split(",")[0].trim();
      const name = row.querySelector(".title")?.textContent?.trim() || "";
      const released = row.querySelector(".search_released")?.textContent?.trim() || "";
      if (!name) return;
      results.push({ appid, name, released, url: `https://store.steampowered.com/app/${appid}/` });
    });
    return results;
  });

  // Enrich with details
  for (const item of items.slice(0, 50)) {
    try {
      const text = await (await fetch(
        `https://store.steampowered.com/api/appdetails?appids=${item.appid}&filters=basic,genres,price_overview&l=czech&cc=cz`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      )).text();
      const j = JSON.parse(text);
      const d = j?.[item.appid]?.data;
      if (d) {
        item.image = d.header_image?.replace("shared.akamai.steamstatic.com", "shared.cloudflare.steamstatic.com") || null;
        item.genres = (d.genres || []).map((g) => g.description).filter(Boolean);
        item.price = d.is_free ? "Zdarma" : d.price_overview?.final_formatted || null;
        item.type = d.type || "game";
      }
      await sleep(400);
    } catch (e) {
      console.warn(`  [!] ${item.name} — ${e.message}`);
    }
  }

  return items.filter((i) => !i.type || i.type === "game");
}

async function scrapeKosmasPreorders() {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  try {
    const res = await fetch("https://www.kosmas.cz/predprodej/?sort=trending", {
      headers: { "User-Agent": UA, "Accept-Language": "cs" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const $ = cheerio.load(html);

    const items = [];
    const seen = new Set();
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href") || "";
      const m = /\/knihy\/(\d+)\/([^/?#]+)/.exec(href);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);

      const scope = (() => {
        const sc = $(a).closest(".grid-item, li, article, [class*='product']");
        return sc.length ? sc : $(a).parent().parent().parent();
      })();

      const title = scope.find("a[href*='/knihy/']").filter((_, el) => $(el).text().trim().length > 2).first().text().trim();
      if (!title || title.length < 2) return;

      let author = null;
      scope.find("a[href*='/autor/']").each((__, x) => {
        if (author) return;
        const t = $(x).text().replace(/\s+/g, " ").trim();
        if (t) author = t;
      });

      const prices = [...scope.text().matchAll(/(\d[\d\s]*)\s*Kč/g)].map((x) => parseInt(x[1].replace(/\s/g, ""), 10)).filter((n) => n >= 20 && n < 5000);
      const price = prices.length ? Math.min(...prices) : null;

      const img = scope.find("img").first();
      let cover = img.attr("src") || img.attr("data-src") || null;
      if (cover && /placeholder|spacer/i.test(cover)) cover = null;

      const dateMatch = scope.text().match(/(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/);

      items.push({
        title,
        author: author || null,
        cover: cover ? (cover.startsWith("http") ? cover : "https://www.kosmas.cz" + cover) : null,
        price,
        url: "https://www.kosmas.cz" + href,
        releaseDate: dateMatch ? dateMatch[1].replace(/\s/g, "") : null,
      });
    });

    return items.slice(0, 15);
  } catch (e) {
    console.warn("[kosmas preorders]", e.message);
    return [];
  }
}

async function main() {
  console.log("[coming] start", new Date().toISOString());

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "cs-CZ",
  });
  const page = await context.newPage();

  // Filmy: kalendář kinopremiér (3 měsíce) + žebříček „nejvíce se těšíme“ (velké filmy dál dopředu)
  console.log("[coming] ČSFD kinopremiéry…");
  const premieres = await scrapeCSFDPremieres(page, 3);
  console.log("[coming] ČSFD filmy, na které se těšíme…");
  const anticipated = await scrapeCSFDList(page, "https://www.csfd.cz/seznamy/filmy/?detail=1", "film");
  const premIds = new Set(premieres.map((f) => f.id));
  const antNew = anticipated.filter((f) => !premIds.has(f.id));
  await enrichCSFDItems(page, antNew);
  // obnovené premiéry starých filmů (Anton Špelec 1932, Pina 2011…) do Očekávaných nepatří
  const minYear = new Date().getFullYear() - 1;
  const films = [...premieres.filter((f) => !f.year || +f.year >= minYear), ...antNew];
  console.log(`[coming] ${films.length} filmů (${premieres.length} z kalendáře premiér)`);

  // Seriály: žebříček „nejvíce se těšíme“ + premiéry řad ze SerialZone
  console.log("[coming] ČSFD seriály…");
  const csfdSeries = await scrapeCSFDList(page, "https://www.csfd.cz/seznamy/serialy/?detail=21", "seriál");
  await enrichCSFDItems(page, csfdSeries);
  console.log("[coming] SerialZone premiéry řad…");
  const szSeries = await scrapeSerialZone(3);
  const csfdKeys = new Set(csfdSeries.map((s) => normTitle(s.title)));
  const series = [...csfdSeries, ...szSeries.filter((s) => !csfdKeys.has(normTitle(s.title)))];
  console.log(`[coming] ${series.length} seriálů (${szSeries.length} ze SerialZone)`);

  // Steam
  console.log("[coming] Steam…");
  const games = await scrapeSteamComing(page);
  console.log(`[coming] ${games.length} her`);

  await browser.close();

  // Kosmas preorders
  console.log("[coming] Kosmas předobjednávky…");
  const books = await scrapeKosmasPreorders();
  console.log(`[coming] ${books.length} knih`);

  // Filter out items with premiere dates in the past and sort by date
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  function parseDate(d) {
    if (!d) return null;
    const parts = d.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!parts) return null;
    return new Date(+parts[3], +parts[2] - 1, +parts[1]);
  }
  function isFuture(item) {
    const d = parseDate(item.premiereDate);
    if (d) return d >= cutoff;
    // Has a future premiere date in text but unparsed — keep
    const y = parseInt(item.year);
    if (y && y >= now.getFullYear()) return true;
    // Old year + no future premiere date = already released, skip
    return false;
  }
  function sortByDate(a, b) {
    const da = parseDate(a.premiereDate), db = parseDate(b.premiereDate);
    if (da && db) return da - db;
    if (da) return -1;
    if (db) return 1;
    return (parseInt(a.year) || 9999) - (parseInt(b.year) || 9999);
  }

  const coming = {
    updatedAt: new Date().toISOString(),
    films: films.filter(isFuture).sort(sortByDate).slice(0, 120).map((f) => ({
      title: f.title, year: f.year, type: "film",
      poster: f.poster, url: f.url, genres: f.genres || [],
      country: f.country || null, premiereDate: f.premiereDate || null, vod: f.vod || [],
    })),
    series: series.filter(isFuture).sort(sortByDate).slice(0, 80).map((s) => ({
      title: s.title, year: s.year, type: "seriál", season: s.season || null,
      poster: s.poster, url: s.url, genres: s.genres || [],
      country: s.country || null, premiereDate: s.premiereDate || null, vod: s.vod || [],
    })),
    games: games.sort((a, b) => {
      const CZ_MONTHS = {led:0,úno:1,bře:2,dub:3,kvě:4,čvn:5,čvc:6,srp:7,zář:8,říj:9,lis:10,pro:11};
      function parseCzDate(s) {
        if (!s) return null;
        const m = s.match(/(\d{1,2})\.\s*(\S+)\.\s*(\d{4})/);
        if (!m) { const y = s.match(/\b(20\d{2})\b/); return y ? new Date(+y[1], 6, 1) : null; }
        const mon = Object.entries(CZ_MONTHS).find(([k]) => m[2].startsWith(k));
        return mon ? new Date(+m[3], mon[1], +m[1]) : null;
      }
      const da = parseCzDate(a.released), db = parseCzDate(b.released);
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return 0;
    }).slice(0, 30).map((g) => ({
      title: g.name, released: g.released, image: g.image || null,
      url: g.url, genres: g.genres || [], price: g.price || null,
    })),
    books: books.slice(0, 10).map((b) => ({
      title: b.title, author: b.author, cover: b.cover,
      price: b.price, url: b.url, releaseDate: b.releaseDate,
    })),
  };

  fs.writeFileSync(OUT, JSON.stringify(coming, null, 2));
  console.log(`[coming] hotovo → coming.json (${coming.films.length} filmů, ${coming.series.length} seriálů, ${coming.games.length} her, ${coming.books.length} knih)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
