/**
 * Sdílená normalizace + matching pro porovnání "je hra v PC Game Passu?"
 * Steam a Microsoft katalog často pojmenovávají tu samou hru mírně jinak
 * (edice, platforma v názvu) – normalizace obojí na stejný tvar to sjednotí.
 */

const fs = require("fs");
const path = require("path");

const EDITION_RE = /\b(standard|deluxe|ultimate|complete|goty|game of the year|anniversary|enhanced|definitive|premium|digital)\s+edition\b/gi;
const SUFFIX_RE = /\s*[-–]?\s*\b(windows( edition)?|game preview|pc)\b\s*$/gi;

function normalizeGameTitle(s) {
  if (!s) return "";
  return s
    .replace(/[™®©]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(EDITION_RE, "")
    .replace(SUFFIX_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadGamePassSet(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir || __dirname, "gamepass.json"), "utf-8"));
    return new Set((data.titles || []).map(normalizeGameTitle));
  } catch {
    return new Set();
  }
}

function isInGamePass(name, gamePassSet) {
  return gamePassSet.has(normalizeGameTitle(name));
}

module.exports = { normalizeGameTitle, loadGamePassSet, isInGamePass };
