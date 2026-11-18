// Local verification for the table exports (no Cloudflare account needed):
//   node dashboards/fastbreak-refresh/worker/_exports_test.mjs
// Checks worker/exports.js against the page's own Historic math (pulled out of
// dashboards/fastbreak/index.html at test time, so the two can't drift apart
// unnoticed), checks the optimizer against brute force, and exercises the
// export routes and their key gate with a mock KV.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "./index.js";
import * as X from "./exports.js";

// -- Fixture: an optimizer dataset shaped like fastbreak:historic:optimizer ----
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const teams = ["BOS", "LAL", "CHI", "DET", "NYK", "SAS", "PHX", "MIA"];
const players = [];
for (let i = 0; i < 48; i++) {
  const avg = Math.round((20 + rnd() * 40) * 10) / 10;
  const games = Math.floor(rnd() * 14);
  const g = Array.from({ length: games }, () => Math.round((avg + (rnd() - 0.5) * 30) * 10) / 10);
  players.push({ n: `Player ${i}`, t: teams[i % teams.length], rp: 30 + Math.floor(rnd() * 90), avg, g, s: g.map(() => [0, 0, 0, 0, 0, 0, 0]) });
}
const slateA = players.filter((p, i) => i % 8 < 4).map((p) => p.n);
const slateB = players.filter((p, i) => i % 8 >= 4).map((p) => p.n);
const DATA = {
  players,
  slates: [
    { label: "Day 2", date: "2026-11-17", teams: teams.slice(0, 4), players: slateA },
    { label: "Day 3", date: "2026-11-18", teams: teams.slice(4), players: slateB },
  ],
  statCodes: ["PTS", "REB", "AST", "STL", "BLK", "3PM", "TOV"],
  scoring: "2026-27",
  updated: "2026-11-18T05:00:00Z",
  budget: 350,
  lineup: 5,
};

// -- The page's own functions -------------------------------------------------------
const html = readFileSync(fileURLToPath(new URL("../../fastbreak/index.html", import.meta.url)), "utf8");
const between = (a, b) => {
  const i = html.indexOf(a), j = html.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `page snippet not found: ${a}`);
  return html.slice(i, j);
};
const pageSrc = [
  between("const hxPct = ", "function hxSaveDisc"),
  between("function hxPrepare(D) {", "let hxDataPromise"),
  between("function hxBest(pool, ban) {", "function hxDiscButtons"),
  between("const hxPPR = ", "const hxPPRCell"),
].join("\n");
const page = new Function("hx", "HX_PCTS", `${pageSrc}; return { hxPrepare, hxBest, hxOptimize, hxRP, hxPPR, hxSum, hxVal };`);

function pageRun(dataset, slateIdx) {
  const D = JSON.parse(JSON.stringify(dataset));
  const hx = { data: null, players: [], byName: {}, slateIdx, rating: "blend", disc: {}, excluded: new Set(), result: null };
  const P = page(hx, [0, 5, 10, 15, 20]);
  hx.data = P.hxPrepare(D);
  hx.players = hx.data.players;
  hx.byName = Object.fromEntries(hx.players.map((p) => [p.n, p]));
  // hxSlatePlayers() as on the page
  globalThis.hxSlatePlayers = () => hx.data.slates[hx.slateIdx].players.map((n) => hx.byName[n]).filter(Boolean);
  P.hxOptimize();
  return { hx, P };
}

// 1) Blend / range numbers match the page exactly.
{
  const { hx } = pageRun(DATA, 1);
  const mine = X.prepareHistoric(DATA);
  for (const p of mine.players) {
    const q = hx.byName[p.n];
    for (const k of ["blend", "mean", "l10", "floor", "ceil", "lo", "hi"]) assert.equal(p[k], q[k], `${p.n} ${k}`);
  }
  assert.equal(mine.shift, hx.data.shift);
}

// 2) No-discount lineup and alternates match the page's optimizer.
for (const idx of [0, 1]) {
  const { hx, P } = pageRun(DATA, idx);
  const out = X.historicExport(DATA, { slateIndex: idx });
  const names = (l) => l.map((p) => p.n).sort();
  assert.deepEqual(out.lineup.players.map((p) => p.name).sort(), names(hx.result.best), `slate ${idx} best`);
  assert.equal(out.alternates.length, hx.result.alts.length);
  out.alternates.forEach((a, i) => assert.deepEqual(a.players.map((p) => p.name).sort(), names(hx.result.alts[i])));
  assert.equal(out.lineup.rpUsed, P.hxSum(hx.result.best, P.hxRP));
  // Slate table Pts/RP and RP match the page at no discount.
  for (const r of out.slateTable.rows) {
    const q = hx.byName[r[0]];
    assert.equal(r[3], P.hxRP(q));
    assert.equal(r[7], P.hxPPR(q) == null ? "" : P.hxPPR(q).toFixed(3));
  }
}

// 3) Brute force: the lineup is the best 5 under 350 RP.
{
  const D = X.prepareHistoric(DATA);
  const pool = DATA.slates[1].players.map((n) => D.players.find((p) => p.n === n));
  let best = -Infinity;
  const n = pool.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
    const L = [pool[a], pool[b], pool[c], pool[d], pool[e]];
    if (L.reduce((s, p) => s + p.rp, 0) <= 350) best = Math.max(best, L.reduce((s, p) => s + p.blend, 0));
  }
  const got = X.bestLineup(pool, 350, 5).reduce((s, p) => s + p.blend, 0);
  assert.ok(Math.abs(got - best) < 1e-9, `brute force ${best} vs ${got}`);
}

// 4) Default slate follows the page's day picker.
assert.equal(X.defaultSlateIndex(DATA.slates, "2026-11-18"), 1);
assert.equal(X.defaultSlateIndex(DATA.slates, "2026-11-10"), 0);
assert.equal(X.defaultSlateIndex(DATA.slates, "2026-12-01"), 1);
assert.equal(X.historicExport(DATA, { date: "2026-11-17" }).slateIndex, 0);
assert.throws(() => X.historicExport(DATA, { date: "2026-11-30" }));

// 5) Classic/Pro table: page columns, Ovr Rank order, OUT last, Pro filter.
{
  const dash = {
    mode: "Pro", proEligibility: "verified",
    objectives: [{ stat: "PTS", label: "Points" }, { stat: "PITP" }],
    players: [
      { name: "C", team: "BOS", opp: "LAL", ovrRank: 2, objectives: { PTS: { proj: 20, ytd: 18.2, l10: 19 }, PITP: { projSource: "tbd", ytd: 8, l10: 9 } } },
      { name: "A, Jr.", team: "LAL", opp: "BOS", ovrRank: 1, objectives: { PTS: { proj: 25, ytd: 24, l10: 26 } } },
      { name: "Out Guy", team: "LAL", availability: "out", ovrRank: null, objectives: {} },
      { name: "No Set", team: "BOS", ovrRank: 3, proEligible: false, objectives: {} },
    ],
  };
  const t = X.dayTable(dash);
  assert.deepEqual(t.headers, ["Player", "Team", "Opp", "Ovr Rank", "Points Proj", "Points YTD", "Points L10", "PITP Proj", "PITP YTD", "PITP L10"]);
  assert.deepEqual(t.rows.map((r) => r[0]), ["A, Jr.", "C", "Out Guy"]);
  assert.equal(t.rows[1][7], "TBD");
  assert.equal(t.rows[2][3], "OUT");
  assert.equal(X.toCSV(t.headers, t.rows).split("\n")[1].slice(0, 10), '"A, Jr.",L');
  assert.equal(X.dayTable({ ...dash, mode: "Classic" }).rows.length, 4);
}

// -- Routes with a mock KV ---------------------------------------------------------
function makeKV() {
  const store = new Map();
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
}
const KV = makeKV();
await KV.put("fastbreak:historic:optimizer", JSON.stringify(DATA));
const env = { FASTBREAK_KV: KV, TOME_SUBSCRIBER_KEYS: "sub-key", TOME_EXPORT_KEYS: "export-key", FASTBREAK_ADMIN_TOKEN: "admin" };
const call = (path) => worker.fetch(new Request("https://w.example" + path), env);

assert.equal((await call("/api/fastbreak/export/today.md")).status, 401);
assert.equal((await call("/api/fastbreak/export/today.md?key=wrong")).status, 401);
// The export key opens the exports only, not the rest of the data.
assert.equal((await call("/api/fastbreak/historic/optimizer?key=export-key")).status, 401);
assert.equal((await call("/api/fastbreak/historic/optimizer?key=sub-key")).status, 200);

{
  const r = await call("/api/fastbreak/export/historic-slate.csv?key=export-key&date=2026-11-18");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Type"), /text\/csv/);
  const lines = (await r.text()).split("\n");
  assert.equal(lines[0], "Player,Team,Base RP,Your RP,Discount %,AVG,Blend,Pts/RP,Obs. avg,Last 10,Floor,Ceiling,Low,High,Skipped");
  assert.equal(lines.length, 1 + slateB.length);
}
{
  const r = await call("/api/fastbreak/export/historic-lineup.json?key=sub-key&date=2026-11-18");
  const b = await r.json();
  assert.equal(b.lineup.players.length, 5);
  assert.ok(b.lineup.rpUsed <= 350);
  const csv = await (await call("/api/fastbreak/export/historic-lineup.csv?key=export-key&date=2026-11-18")).text();
  assert.match(csv.split("\n")[1], /^Top,/);
}
{
  const r = await call("/api/fastbreak/export/historic-players.json?key=export-key");
  const b = await r.json();
  assert.equal(b.rows.length, players.length);
}
{
  // No Classic/Pro snapshot cached for this date: the export says so instead of building.
  const r = await call("/api/fastbreak/export/today.md?key=export-key&league=NBA&date=2026-11-18");
  assert.equal(r.status, 200);
  const md = await r.text();
  assert.match(md, /# Fast Break data, NBA 2026-11-18/);
  assert.match(md, /Not built yet/);
  assert.match(md, /### Top projected lineup/);
  assert.doesNotMatch(md, /\b(bet|odds|wager|buy|sell)\b/i);
  const j = await (await call("/api/fastbreak/export/today.json?key=export-key&league=NBA&date=2026-11-18")).json();
  assert.equal(j.classic.queued, true);
  assert.equal(j.historic.slate.label, "Day 3");
}
assert.equal((await call("/api/fastbreak/export/nope.csv?key=export-key")).status, 404);
assert.equal((await call("/api/fastbreak/export/today.csv?key=export-key")).status, 400);
assert.equal((await call("/api/fastbreak/export/classic.csv?key=export-key&date=11-18")).status, 400);
{
  // WNBA bundle has no Historic section.
  const j = await (await call("/api/fastbreak/export/today.json?key=export-key&league=WNBA&date=2026-11-18")).json();
  assert.equal(j.historic, null);
}

console.log("exports: all checks passed");
