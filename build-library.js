/**
 * Sáčkův radar – dostupnost e-knih přes Palmknihy pro hlavní knižní žebříček
 * ---------------------------------------------------------------------------
 * Stejná logika jako u knih v backlogu (build-enrich-backlog.js), jen pro
 * books.json - aby stuha/odznak "PŮJČIT" fungovaly i na Bestsellerech a
 * v Novinkách, ne jen u knih, co si někdo přidal do backlogu.
 * Spouštět po build.js, před build-news.js (aby diff do news.json převzal
 * i palmknihy pole u nově přidaných knih).   node build-library.js
 */

const fs = require("fs");
const path = require("path");
const { fetchPalmknihyMatch } = require("./lib-palmknihy");

const BOOKS_FILE = path.join(__dirname, "books.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DELAY = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("[library] start", new Date().toISOString());
  let data;
  try {
    data = JSON.parse(fs.readFileSync(BOOKS_FILE, "utf-8"));
  } catch (e) {
    console.log("[library] books.json nenalezen, končím");
    return;
  }
  const books = data.books || data;
  const toCheck = books.filter((b) => b.palmknihy === undefined);
  if (!toCheck.length) { console.log("[library] vše ověřeno, nic k dělání"); return; }

  console.log(`[library] ${toCheck.length} knih k ověření dostupnosti v knihovně (Palmknihy)`);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: UA });
  let changed = 0;

  for (const b of toCheck) {
    try {
      const match = await fetchPalmknihyMatch(page, b.title, b.author);
      b.palmknihy = match;
      changed++;
      console.log(`  → ${b.title}: ${match ? "✓ k dispozici" : "✗ nenalezeno"}`);
    } catch (e) {
      console.warn(`  → ${b.title}: chyba - ${e.message}`);
    }
    await sleep(DELAY);
  }

  await browser.close();

  if (changed > 0) {
    fs.writeFileSync(BOOKS_FILE, JSON.stringify(data, null, 2));
    console.log(`[library] hotovo: ${changed} knih ověřeno → books.json`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
