const cheerio = require("cheerio");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

(async () => {
  const title = "Plukovnice lidských duší";
  const url = `https://www.kosmas.cz/hledej/?q=${encodeURIComponent(title)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs" } });
  const html = await res.text();
  const $ = cheerio.load(html);
  console.log("grid-items:", $(".grid-item").length);
  $(".grid-item").slice(0,3).each((i, el) => {
    const titleEl = $(el).find("a.title, .book__title a, h3 a, a[title], a[href*='/knihy/']").first();
    const price = $(el).find(".price__default, .price__invalid").first().text().trim();
    const href = $(el).find("a[href*='/knihy/']").first().attr("href");
    console.log(`\n[${i}] title: "${titleEl.text().trim()}" | price: "${price}" | href: ${href}`);
    console.log("  all text:", $(el).text().replace(/\s+/g," ").trim().slice(0,200));
  });
})();
