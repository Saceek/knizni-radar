/**
 * Sáčkův radar – ruční tabulka relativního herního výkonu GPU/CPU
 * -------------------------------------------------------------------
 * PassMark (videocardbenchmark.net / cpubenchmark.net) blokuje scraping (403),
 * takže místo denně stahovaných čísel používáme jednorázově sestavenou tabulku
 * relativních tříd výkonu (0–100, čím víc tím rychlejší) sestavenou z veřejně
 * známých žebříčků výkonu. Není to laboratorní přesnost, ale pro "zelená/oranžová/
 * červená" odhad stačí – přesně jako ProtonDB dělá "hraje/nehraje", ne přesná FPS.
 *
 * Xbox Ally X (ASUS ROG Xbox Ally X, 2025): AMD Ryzen AI Z2 Extreme (Zen 5, 8 jader)
 * + integrovaná grafika Radeon 890M (RDNA 3.5, 16 CU). Ukotveno v tabulkách níž.
 */

const ALLY_X_GPU_SCORE = 30;   // Radeon 890M
const ALLY_X_CPU_SCORE = 26;   // Ryzen AI Z2 Extreme

// Řazeno od nejslabší po nejsilnější v každé generaci; matching hledá NEJDELŠÍ shodu
// podstring v textu požadavků, takže pořadí v poli nevadí.
const GPU_TIERS = [
  ["intel hd graphics", 2], ["intel uhd graphics", 3], ["intel iris xe", 12],
  ["geforce 210", 2], ["gt 710", 3], ["gt 730", 4], ["gtx 650", 6],
  ["gtx 750 ti", 8], ["gtx 750", 7], ["radeon hd 7750", 6], ["radeon r7 260", 8],
  ["gtx 950", 10], ["radeon r9 380", 10], ["radeon rx 460", 9], ["radeon rx 560", 10],
  ["gtx 960", 11], ["gtx 1050 ti", 13], ["gtx 1050", 12], ["radeon rx 570", 15],
  ["gtx 1060", 18], ["radeon rx 580", 17], ["radeon rx 590", 19],
  ["gtx 1650 super", 21], ["gtx 1650", 19], ["radeon rx 5500 xt", 22],
  ["gtx 1660 super", 26], ["gtx 1660 ti", 26], ["gtx 1660", 24],
  ["radeon 780m", 20], ["radeon 880m", 23], ["radeon 890m", ALLY_X_GPU_SCORE],
  ["gtx 1080 ti", 33], ["gtx 1080", 28], ["gtx 1070 ti", 27], ["gtx 1070", 25],
  ["rtx 2060 super", 33], ["rtx 2060", 30], ["radeon rx 5600 xt", 27],
  ["radeon rx 5700 xt", 35], ["radeon rx 5700", 31], ["rtx 2070 super", 37],
  ["rtx 2070", 34], ["rtx 2080 super", 40], ["rtx 2080 ti", 44], ["rtx 2080", 38],
  ["rtx 3050", 25], ["rtx 3060 ti", 42], ["rtx 3060", 36],
  ["radeon rx 6600 xt", 34], ["radeon rx 6650 xt", 35], ["radeon rx 6600", 32],
  ["radeon rx 6700 xt", 43], ["radeon rx 6700", 38], ["radeon rx 6750 xt", 44],
  ["rtx 3070 ti", 48], ["rtx 3070", 46], ["radeon rx 6800 xt", 53], ["radeon rx 6800", 49],
  ["rtx 3080 ti", 58], ["rtx 3080", 55], ["radeon rx 6900 xt", 56], ["radeon rx 6950 xt", 57],
  ["rtx 3090 ti", 62], ["rtx 3090", 60],
  ["radeon rx 7600 xt", 35], ["radeon rx 7600", 33], ["rtx 4060 ti", 42], ["rtx 4060", 37],
  ["radeon rx 7700 xt", 46], ["rtx 4070 ti super", 62], ["rtx 4070 ti", 58],
  ["rtx 4070 super", 56], ["rtx 4070", 52], ["radeon rx 7800 xt", 50],
  ["radeon rx 7900 gre", 55], ["radeon rx 7900 xt", 60], ["radeon rx 7900 xtx", 64],
  ["rtx 4080 super", 70], ["rtx 4080", 68], ["rtx 4090", 85],
  ["rtx 5070 ti", 66], ["rtx 5070", 58], ["rtx 5080", 75], ["rtx 5090", 95],
];

const CPU_TIERS = [
  ["fx-4300", 8], ["fx-6300", 9], ["fx-8350", 11],
  ["core i3-3", 8], ["core i5-3", 10], ["core i5-4", 12], ["core i7-4", 15],
  ["core i5-6", 13], ["core i7-6", 16], ["ryzen 3 1200", 11], ["ryzen 3 1300x", 12],
  ["ryzen 5 1600", 16], ["ryzen 7 1700", 17], ["core i5-7", 14], ["core i7-7700", 17],
  ["ryzen 5 2600", 18], ["ryzen 7 2700", 19], ["core i5-8400", 18], ["core i7-8700", 21],
  ["ryzen 5 3600", 22], ["ryzen 7 3700x", 25], ["ryzen 9 3900x", 29],
  ["core i5-9400", 19], ["core i7-9700", 21], ["core i9-9900", 23],
  ["core i5-10400", 21], ["core i7-10700", 24], ["core i9-10900", 26],
  ["ryzen 5 5600x", 27], ["ryzen 5 5600", 26], ["ryzen ai z2 extreme", ALLY_X_CPU_SCORE],
  ["ryzen z1 extreme", 21], ["ryzen z1", 18],
  ["ryzen 7 5700x", 28], ["ryzen 7 5800x", 29], ["ryzen 9 5900x", 33], ["ryzen 9 5950x", 35],
  ["core i5-11400", 23], ["core i7-11700", 25], ["core i9-11900", 27],
  ["core i5-12400", 26], ["core i7-12700", 34], ["core i9-12900", 38],
  ["ryzen 7 7700x", 35], ["ryzen 9 7900x", 40], ["ryzen 9 7950x", 43],
  ["core i5-13400", 29], ["core i7-13700", 40], ["core i9-13900", 44],
  ["core i5-14400", 30], ["core i7-14700", 41], ["core i9-14900", 45],
  ["ryzen 9 9950x", 46], ["ryzen 7 9700x", 37],
];

function normalize(s) {
  return (s || "").toLowerCase().replace(/[®™©]/g, "").replace(/\s+/g, " ").trim();
}

// Steam řádky typu "GTX 1050 (2GB), Radeon R9 380 (2GB)" nabízí VÝBĚR - stačí splnit
// jednu z variant, takže bereme tu SLABŠÍ (to je skutečná laťka "recommended").
// Krátké/obecné shody (typ "gt 730" uvnitř "radeon rx 7300") navíc filtrujeme pryč
// tak, že mezi více shodami se stejným prefixem necháme jen tu nejdelší/nejspecifičtější.
function matchTier(text, tiers) {
  const norm = normalize(text);
  const hits = tiers.filter(([name]) => norm.includes(name));
  if (!hits.length) return null;
  const nonSubsumed = hits.filter(([name]) => !hits.some(([other]) => other !== name && other.includes(name)));
  const weakest = nonSubsumed.reduce((min, cur) => (cur[1] < min[1] ? cur : min));
  return { name: weakest[0], score: weakest[1] };
}

function matchGpuTier(text) { return matchTier(text, GPU_TIERS); }
function matchCpuTier(text) { return matchTier(text, CPU_TIERS); }

module.exports = { ALLY_X_GPU_SCORE, ALLY_X_CPU_SCORE, matchGpuTier, matchCpuTier };
