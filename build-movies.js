/**
 * Sáčkův radar – ČSFD: nejnavštěvovanější filmy a seriály
 * --------------------------------------------------------
 * Node 18+, playwright.   npm i playwright && npx playwright install chromium && node build-movies.js
 *
 *  - zdroj: csfd.cz homepage – sekce "Nejnavštěvovanější filmy/seriály"
 *  - struktura: section.updated-box > article.article-movie-withposter-small
 *  - z detailu: hodnocení, plakát (og:image), VOD dostupnost
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "movies.json");
const DELAY = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSection(sectionHtml) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(sectionHtml);
  const items = [];
  $("article.article-movie-withposter-small").each((_, el) => {
    const a = $(el).find("a.film-title-name");
    const href = a.attr("href") || "";
    const title = a.text().trim();
    if (!title) return;

    const info = $(el).find(".film-title-info .info").text().trim();
    const yearMatch = info.match(/\b(19|20)\d{2}\b/);

    const originsEl = $(el).find(".film-origins-genres .info");
    const country = originsEl.find(".info-country").text().trim() || null;
    const originsText = originsEl.text().trim();
    let genres = [];
    if (originsText && country) {
      const afterCountry = originsText.replace(country, "").trim();
      genres = afterCountry.split(",").map((g) => g.trim()).filter((g) => g.length > 1);
    }

    const img = $(el).find("figure img");
    let poster = img.attr("src") || "";
    if (poster.startsWith("//")) poster = "https:" + poster;

    const id = (href.match(/\/film\/(\d+)/) || [])[1] || null;

    items.push({
      id,
      title,
      year: yearMatch ? yearMatch[0] : null,
      poster: poster || null,
      url: "https://www.csfd.cz" + href,
      genres,
      country,
    });
  });
  return items;
}

async function main() {
  console.log("[movies] start", new Date().toISOString());
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "cs-CZ",
  });
  const page = await context.newPage();

  await page.goto("https://www.csfd.cz/", { waitUntil: "networkidle", timeout: 30000 });
  await sleep(3000);

  // Extract section HTML for each category
  const sectionsHtml = await page.evaluate(() => {
    const result = {};
    const sections = document.querySelectorAll("section.updated-box");
    sections.forEach((sec) => {
      const h2 = sec.querySelector("h2");
      if (!h2) return;
      const text = h2.textContent.trim();
      if (/Nejnavštěvovanější filmy/i.test(text)) result.films = sec.outerHTML;
      else if (/Nejnavštěvovanější seriály/i.test(text)) result.series = sec.outerHTML;
      else if (/Startuje v kinech/i.test(text)) result.cinema = sec.outerHTML;
      else if (/Startuje na VOD/i.test(text)) result.vod = sec.outerHTML;
    });
    return result;
  });

  const films = sectionsHtml.films ? parseSection(sectionsHtml.films) : [];
  const series = sectionsHtml.series ? parseSection(sectionsHtml.series) : [];
  const cinemaItems = sectionsHtml.cinema ? parseSection(sectionsHtml.cinema) : [];
  const vodItems = sectionsHtml.vod ? parseSection(sectionsHtml.vod) : [];

  console.log(`[movies] ${films.length} filmů, ${series.length} seriálů, ${cinemaItems.length} kino, ${vodItems.length} VOD`);

  const cinemaIds = new Set(cinemaItems.map((i) => i.id).filter(Boolean));
  const vodIds = new Set(vodItems.map((i) => i.id).filter(Boolean));

  const allItems = [
    ...films.map((f) => ({ ...f, type: "film" })),
    ...series.map((s) => ({ ...s, type: "seriál" })),
  ];

  // Enrich from detail pages: rating + VOD info + better poster
  for (const item of allItems) {
    try {
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(DELAY);

      const detail = await page.evaluate(() => {
        const og = (p) => {
          const el = document.querySelector(`meta[property='${p}']`);
          return el ? el.getAttribute("content") : null;
        };
        const poster = og("og:image");

        // Rating
        let rating = null;
        const ratingEls = document.querySelectorAll("[class*='rating']");
        ratingEls.forEach((el) => {
          if (rating != null) return;
          const m = el.textContent.replace(/\s/g, "").match(/(\d{1,3})%/);
          if (m) { const n = parseInt(m[1], 10); if (n >= 0 && n <= 100) rating = n; }
        });

        // VOD platforms from detail page
        const vod = [];
        document.querySelectorAll("[class*='vod'] a, [class*='vod'] img, .box-vod a, [class*='streaming'] a").forEach((el) => {
          const name = (el.getAttribute("title") || el.getAttribute("alt") || el.textContent || "").trim();
          if (name && name.length > 1 && name.length < 40 && !vod.includes(name)) vod.push(name);
        });

        return { poster, rating, vod };
      });

      if (detail.poster) item.poster = detail.poster;
      if (detail.rating != null) item.rating = detail.rating;
      if (detail.vod && detail.vod.length) item.vod = detail.vod.filter((v) => !/^(VOD|více|Koupit|Půjčit)$/i.test(v));

      console.log(`  [+] ${item.title} — ${detail.rating != null ? detail.rating + "%" : "–"}, vod: ${(detail.vod || []).join(", ") || "–"}`);
    } catch (e) {
      console.warn(`  [!] ${item.title} — ${e.message}`);
    }
  }

  await browser.close();

  // Assign VOD/Kino tags
  const movies = allItems.map((item) => {
    let vod = item.vod || [];
    if (!vod.length) {
      if (vodIds.has(item.id)) vod = ["VOD"];
      else if (cinemaIds.has(item.id)) vod = ["Kino"];
      else vod = item.type === "film" ? ["Kino"] : ["VOD"];
    }
    return {
      title: item.title,
      year: item.year,
      type: item.type,
      rating: item.rating || null,
      poster: item.poster || null,
      url: item.url,
      genres: item.genres || [],
      country: item.country || null,
      vod,
    };
  });

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), movies }, null, 2));
  console.log(`[movies] hotovo: ${movies.length} položek → movies.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
