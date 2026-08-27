/**
 * Sdílená logika pro ověření dostupnosti e-knihy přes Palmknihy v katalogu
 * Městské knihovny Rokycany (katalog.rokyknih.cz - VuFind, chráněný Anubis
 * JS výzvou jako ČSFD, proto Playwright). Používá build-enrich-backlog.js
 * (knihy v backlogu) i build-library.js (knihy v hlavním žebříčku/Novinkách).
 */

const cheerio = require("cheerio");
const { normalizeGameTitle: normalizeTitle } = require("./gamepass-match");

const PALMKNIHY_WAIT = 6000;

async function fetchPalmknihyMatch(page, title, author) {
  const url = `https://katalog.rokyknih.cz/Search/Results?lookfor=${encodeURIComponent(title)}&type=Title&filter%5B%5D=format%3A%22eBook%22&filter%5B%5D=building%3A%22palmknihy%22`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(PALMKNIHY_WAIT);
  const html = await page.content();
  const $ = cheerio.load(html);
  const wanted = normalizeTitle(`${title} ${author || ""}`).split(" ").filter((w) => w.length > 2);
  if (!wanted.length) return null;
  let best = null, bestScore = 0;
  $(".result").each((_, el) => {
    const id = $(el).find(".hiddenId").first().attr("value");
    if (!id || !id.startsWith("PALMKNIHY.")) return;
    const linkText = $(el).find(`a[href="/Record/${id}"]`).first().text().trim();
    if (!linkText) return;
    const norm = normalizeTitle(linkText);
    const matches = wanted.filter((w) => norm.includes(w)).length;
    const score = matches / wanted.length;
    if (score > bestScore) { bestScore = score; best = id; }
  });
  if (!best || bestScore < 0.6) return null;
  return { url: `https://katalog.rokyknih.cz/Record/${best}` };
}

module.exports = { fetchPalmknihyMatch };
