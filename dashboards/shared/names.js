// Shared player-name normalizer for Tome workers.
// Imported by tome-topshot (dashboards/topshot/worker/worker.js) and
// tome-fastbreak-refresh (dashboards/fastbreak-refresh/worker/index.js) so the
// Pro-night eligibility join matches names the same way on both sides.
//
// Rules: lowercase, strip diacritics, drop periods and commas, collapse
// whitespace. Generational suffixes (Jr, Sr, II, III, IV) are KEPT: Top Shot
// has legends whose sons play today (Tim Hardaway / Tim Hardaway Jr., Gary
// Payton / Gary Payton II, Larry Nance / Larry Nance Jr.), and stripping the
// suffix would hand the son the father's Moments. "Jr." and "Jr" still match
// because periods are dropped.
//   "Luka Dončić"         -> "luka doncic"
//   "Jaren Jackson Jr."   -> "jaren jackson jr"
//   "Gary Trent Jr"       -> "gary trent jr"
//   "Gary Payton II"      -> "gary payton ii"   (not "gary payton")
//   "P.J. Washington"     -> "pj washington"

// Letters NFD can't split into base + accent (Nikola Jokić decomposes; Ø, Ł, Đ don't).
const FOLD = { "ø": "o", "ł": "l", "đ": "d", "æ": "ae", "œ": "oe", "ß": "ss", "ı": "i" };

export function normalizeName(name) {
  const base = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[øłđæœßı]/g, (c) => FOLD[c])
    .replace(/\./g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base;
}
