// Shared player-name normalizer for Tome workers.
// Imported by tome-topshot (dashboards/topshot/worker/worker.js) and
// tome-fastbreak-refresh (dashboards/fastbreak-refresh/worker/index.js) so the
// Pro-night eligibility join matches names the same way on both sides.
//
// Rules: lowercase, strip diacritics, drop periods, drop generational
// suffixes (Jr, Sr, II, III, IV), collapse whitespace.
//   "Luka Dončić"         -> "luka doncic"
//   "Jaren Jackson Jr."   -> "jaren jackson"
//   "Gary Trent Jr"       -> "gary trent"
//   "Robert Williams III" -> "robert williams"
//   "P.J. Washington"     -> "pj washington"

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
// Letters NFD can't split into base + accent (Nikola Jokić decomposes; Ø, Ł, Đ don't).
const FOLD = { "ø": "o", "ł": "l", "đ": "d", "æ": "ae", "œ": "oe", "ß": "ss", "ı": "i" };

export function normalizeName(name) {
  const base = String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[øłđæœßı]/g, (c) => FOLD[c])
    .replace(/\./g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "";
  const parts = base.split(" ");
  // Only strip a suffix when something is left (a player literally named "Ii" stays).
  while (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}
