// Local verification for the Historic box-score automation (no Cloudflare account needed):
//   node dashboards/fastbreak-refresh/worker/_historic_auto_test.mjs
// Uses the real Nov 17 Historic box scores (run-fb-historic-2026-11-16-v2-d2,
// read from Top Shot's public page) and a page fixture shaped like the live one.
import assert from "node:assert/strict";
import worker, { __testables__ as T } from "./index.js";
import * as A from "./historic-auto.js";

const validate = T.validateHistoricOptimizer;

// -- Real Nov 17 box scores (Player, MIN, PTS, FG, 3PT, FT, REB, AST, STL, BLK) ----
const D2_BOX = `TOR|home|Tracy McGrady,36:00,24,9-19,2-5,4-5,5,6,2,0;Chris Bosh,36:00,18,8-14,0-0,2-3,9,3,1,0;Serge Ibaka,36:00,17,7-12,1-2,2-2,10,0,1,2;José Calderón,36:00,12,5-11,2-6,0-0,4,9,3,0;Andrea Bargnani,36:00,11,4-11,1-1,2-2,4,2,0,3
NYK|away|Allan Houston,36:00,20,7-14,1-2,5-5,3,5,1,0;Amar'e Stoudemire,36:00,19,8-12,1-3,2-4,9,1,1,0;Walt Frazier,36:00,17,8-16,0-0,1-1,6,3,1,0;Patrick Ewing,36:00,12,4-14,0-0,4-5,12,3,0,4;Charles Oakley,36:00,7,3-6,0-0,1-2,5,2,4,0
MIN|home|Kevin Garnett,36:00,26,12-22,0-2,2-3,12,5,0,0;Gorgui Dieng,36:00,20,9-11,0-0,2-3,11,0,1,0;Wally Szczerbiak,36:00,19,7-16,2-5,3-3,7,3,0,0;Stephon Marbury,36:00,14,5-11,1-1,3-4,4,6,0,0;Ricky Rubio,36:00,9,2-10,1-4,4-4,2,8,3,0
POR|away|Clyde Drexler,36:00,20,8-14,1-3,3-3,14,6,1,0;Brandon Roy,36:00,16,6-16,0-3,4-5,4,2,0,1;Clifford Robinson,36:00,14,6-11,1-1,1-3,3,6,3,0;LaMarcus Aldridge,36:00,13,5-16,0-2,3-4,8,0,0,0;Arvydas Sabonis,36:00,13,6-11,0-0,1-1,9,5,0,3
SAS|home|Manu Ginóbili,36:00,26,10-15,5-6,1-2,7,7,2,1;Michael Finley,36:00,14,5-14,0-6,4-4,1,3,1,0;Terry Cummings,36:00,13,5-15,0-0,3-5,16,2,0,0;David Robinson,36:00,12,5-12,0-0,2-2,10,1,2,3;Alvin Robertson,36:00,3,1-10,0-0,1-1,9,3,1,0
DET|away|Bob Lanier,36:00,19,8-23,0-0,3-4,16,1,0,6;Isiah Thomas,36:00,16,5-12,1-1,5-5,6,7,2,0;Richard Hamilton,36:00,12,5-17,0-1,2-5,9,3,0,0;Grant Hill,36:00,12,4-10,0-1,4-4,8,2,3,3;Ben Wallace,36:00,10,5-6,0-0,0-1,9,1,1,2
LAC|home|Blake Griffin,36:00,22,8-11,1-2,5-6,5,4,0,0;Elton Brand,36:00,20,9-11,0-0,2-3,9,1,0,2;Bob McAdoo,36:00,20,8-18,0-0,4-6,12,2,1,0;Ron Harper,36:00,13,5-9,0-2,3-4,4,5,2,1;Cuttino Mobley,36:00,12,5-9,1-2,1-1,4,4,1,1
UTA|away|Adrian Dantley,36:00,25,10-16,0-0,5-7,5,4,2,0;Karl Malone,36:00,23,9-21,0-2,5-7,10,3,1,1;Deron Williams,36:00,13,4-8,1-3,4-4,2,7,0,0;Darrell Griffith,36:00,12,5-14,1-3,1-1,1,4,3,1;Mark Eaton,36:00,6,3-7,0-0,0-0,8,0,1,3
LAL|home|Michael Cooper,36:00,19,7-10,3-3,2-5,2,3,2,0;Lamar Odom,36:00,16,5-15,1-2,5-7,14,4,1,0;Vlade Divac,36:00,14,5-14,0-0,4-5,20,4,0,1;James Worthy,36:00,10,4-17,1-2,1-2,5,2,2,2;Derek Fisher,36:00,9,3-10,2-7,1-2,5,3,1,0
CHA|away|Kemba Walker,36:00,24,9-22,3-7,3-4,2,3,1,1;Gerald Wallace,36:00,23,10-17,3-6,0-0,5,0,3,0;Cody Zeller,36:00,10,3-8,1-1,3-4,13,1,2,0;Larry Johnson,36:00,10,5-11,0-1,0-1,10,6,1,2;Muggsy Bogues,36:00,7,3-11,0-0,1-1,6,9,3,0`;
const HEAD = ["PLAYER", "MIN", "PTS", "FG", "3PT", "FT", "REB", "AST", "STL", "BLK"];
const teamsOut = D2_BOX.split("\n").map((line) => {
  const [abbr, side, rows] = line.split("|");
  return {
    abbr, side, head: HEAD,
    rows: rows.split(";").map((r) => {
      const [name, ...cells] = r.split(",");
      const row = { name, short: name, cells };
      HEAD.slice(1).forEach((h, i) => (row[h] = cells[i]));
      return row;
    }),
  };
});
const BOX = { errors: [], games: [0, 1, 2, 3, 4].map((i) => ({ index: i, teams: [teamsOut[2 * i], teamsOut[2 * i + 1]] })) };

// -- Public page fixture (same shape as nbatopshot.com/fastbreak?league=simulation) --
const ts = (s) => ({ $typeName: "google.protobuf.Timestamp", seconds: `$n${s}`, nanos: 0 });
const game = (id, start, status) => ({ $typeName: "atlas.v1.SlateGame", gameId: id, homeTeamId: "1610612761", awayTeamId: "1610612752", status, scheduledAt: ts(start) });
const contest = (d, locks, ends, games, status) => ({
  $typeName: "atlas.v1.Contest", id: `run-fb-historic-2026-11-16-v2-${d}`, runId: "run-fb-historic-2026-11-16-v2", product: 2, league: "simulation",
  name: `HISTORIC - RUN 3 - 2026-27 SEASON Day ${d.slice(1)}`, status, slots: [{ $typeName: "atlas.v1.Slot", index: 0, label: "Slot 1" }],
  slateGames: games, opensAt: ts(1794787200), locksAt: ts(locks), endsAt: ts(ends),
});
const D2_LAST = 1794974400; // Nov 17, 11:00 PM ET
function pageHtml({ d3Final = false } = {}) {
  const data = {
    contests: [
      contest("d1", 1794888000, 1794909600, [game("h3b-g1", 1794873600, 3), game("h3b-g8", 1794888000, 3)], 5),
      contest("d2", D2_LAST, 1794996000, [
        game("h3b-g11", 1794961800, 3), game("h3b-g12", 1794963600, 3), game("h3b-g13", 1794963601, 3), game("h3b-g10", 1794972600, 3), game("h3b-g9", D2_LAST, 3),
      ], 5),
      contest("d3", 1795057201, 1795078801, [game("h3b-g24", 1795046400, d3Final ? 3 : 1), game("h3b-g19", 1795057200, d3Final ? 3 : 1)], 2),
    ],
  };
  const flight = JSON.stringify(JSON.stringify(data)).slice(1, -1); // one level of JS-string escaping, as on the live page
  return `<html><body><script nonce="x">self.__next_f.push([1,"${flight}"])</script></body></html>`;
}

// -- Mocks -----------------------------------------------------------------------
function makeKV() {
  const store = new Map();
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
}
const browserCalls = [];
const BROWSER = {
  async quickAction(action, opts) {
    browserCalls.push({ action, opts });
    const html = `<html><body><div>page</div><script type="application/json" id="tome-historic-bs">${JSON.stringify(BOX)}</script></body></html>`;
    return new Response(JSON.stringify({ success: true, result: html }), { status: 200 });
  },
};
const fetchPage = async () => new Response(pageHtml(), { status: 200 });

// Dataset in the manual JSON's shape: every box-score player but Muggsy Bogues,
// two earlier games each, plus one player who did not play.
function makeDataset() {
  const players = [];
  for (const t of teamsOut) for (const r of t.rows) {
    if (r.name === "Muggsy Bogues") continue;
    players.push({ n: r.name, t: t.abbr, rp: 60, avg: 30.5, g: [30, 28.5], s: [[20, 5, 4, 1, 0, 1], [18, 6, 4, 1, 0, 1]] });
  }
  players.push({ n: "Bill Russell", t: "BOS", rp: 70, avg: 35, g: [40], s: [[10, 20, 3, 0, 0, 0]] });
  return {
    players, slates: [{ label: "Wed, Nov 18 (Run 3, Day 3)", teams: ["BOS"], players: ["Bill Russell"] }],
    statCodes: ["PTS", "REB", "AST", "STL", "BLK", "3PM"], scoring: "2026-27", updated: "Wed, Nov 18 (Run 3, Day 3)", kPrior: 4, halfLife: 5, budget: 350, version: 2,
  };
}
const get = async (env, k) => JSON.parse(await env.FASTBREAK_KV.get(k));

// -- Schedule parsing --------------------------------------------------------------
const contests = A.parseHistoricSchedule(pageHtml());
assert.deepEqual(contests.map((c) => c.id.slice(-2)), ["d1", "d2", "d3"]);
const d2 = contests[1];
assert.equal(d2.games.length, 5);
assert.equal(d2.lastStart, D2_LAST);
assert.equal(A.allFinal(d2), true);
assert.equal(A.allFinal(contests[2]), false);
assert.equal(new Date(A.dueAtMs(d2)).toISOString(), "2026-11-18T04:15:00.000Z", "due 15 min after the last tip");

// -- Scoring matches build_historic_day.py ---------------------------------------------
const codes = ["PTS", "REB", "AST", "STL", "BLK", "3PM"];
assert.equal(A.rescore(codes, [24, 5, 6, 2, 0, 2]), 46.5, "McGrady: 24+5+12+6+1-1.5");
assert.equal(A.rescore(codes, [17, 10, 0, 1, 2, 1]), 40, "Ibaka double-double: 17+10+3+6+0.5+5-1.5");
assert.equal(A.rescore(codes, [14, 10, 10, 1, 0, 0]), 60.5, "triple-double stacks DD and TD: 14+10+20+3+5+10-1.5");
assert.equal(A.statFor("3PM", { "3PT": "2-5" }), 2);
assert.equal(A.statFor("FGA", { FG: "9-19" }), 19);
assert.equal(A.statFor("MIN", { MIN: "36:30" }), 36.5);

// -- First tick ever: past contests are marked, not backfilled ---------------------------
{
  const env = { FASTBREAK_KV: makeKV(), BROWSER };
  await env.FASTBREAK_KV.put("fastbreak:historic:optimizer", JSON.stringify(makeDataset()));
  const now = A.dueAtMs(d2) + 10 * 60 * 1000;
  const r = await A.runHistoricAutoTick(env, { validate, now, fetchImpl: fetchPage });
  assert.equal(r.action, "idle");
  const st = await get(env, A.HISTORIC_AUTO_STATE_KEY);
  assert.ok(st.done["run-fb-historic-2026-11-16-v2-d2"].skipped, "d2 ended before the first run: skipped");
  assert.equal(st.nextContest.id, "run-fb-historic-2026-11-16-v2-d3");
  assert.equal(st.nextContest.dueAt, "2026-11-19T03:15:00.000Z");
  assert.equal(browserCalls.length, 0, "no browser time spent");
  assert.deepEqual(await get(env, "fastbreak:historic:optimizer"), makeDataset(), "dataset untouched");
  // Quiet ticks before the next due time do not even fetch the page.
  let fetched = 0;
  const r2 = await A.runHistoricAutoTick(env, { validate, now: now + 5 * 60 * 1000, fetchImpl: async () => { fetched++; return fetchPage(); } });
  assert.equal(r2.action, "waiting");
  assert.equal(fetched, 0);
}

// -- Normal night: Nov 17 loads 15 min after the last tip ------------------------------------
{
  const env = { FASTBREAK_KV: makeKV(), BROWSER };
  const before = makeDataset();
  await env.FASTBREAK_KV.put("fastbreak:historic:optimizer", JSON.stringify(before));
  await env.FASTBREAK_KV.put(A.HISTORIC_AUTO_STATE_KEY, JSON.stringify({ startedAt: "2026-11-17T12:00:00Z", done: { "run-fb-historic-2026-11-16-v2-d1": { skipped: "x" } }, attempts: {} }));

  // 14 minutes after the last tip: not yet.
  let r = await A.runHistoricAutoTick(env, { validate, now: D2_LAST * 1000 + 14 * 60 * 1000, fetchImpl: fetchPage });
  assert.equal(r.action, "idle");
  assert.equal(browserCalls.length, 0);

  // 15 minutes after: loads.
  const st0 = await get(env, A.HISTORIC_AUTO_STATE_KEY);
  st0.waitUntil = null;
  await env.FASTBREAK_KV.put(A.HISTORIC_AUTO_STATE_KEY, JSON.stringify(st0));
  r = await A.runHistoricAutoTick(env, { validate, now: A.dueAtMs(d2) + 60 * 1000, fetchImpl: fetchPage });
  assert.equal(r.action, "ingested", JSON.stringify(r));
  assert.equal(r.games, 5);
  assert.equal(r.rows, 50);
  assert.equal(r.appended, 49);
  assert.deepEqual(r.unmatched, ["Muggsy Bogues (CHA)"]);
  assert.equal(browserCalls.length, 1);
  assert.equal(browserCalls[0].action, "content");
  assert.equal(browserCalls[0].opts.url, "https://nbatopshot.com/fastbreak?league=simulation&contest=run-fb-historic-2026-11-16-v2-d2");

  const after = await get(env, "fastbreak:historic:optimizer");
  assert.equal(validate(after), null, "saved dataset passes the upload validator");
  // Same shape as the manual JSON: same top-level keys plus the two result markers.
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), "boxScoreContests", "boxScoresUpdated", "boxScoresUpdatedAt"].sort());
  assert.deepEqual(after.slates, before.slates, "slates untouched");
  const mc = after.players.find((p) => p.n === "Tracy McGrady");
  assert.deepEqual(Object.keys(mc).sort(), ["avg", "g", "n", "rp", "s", "t"]);
  assert.equal(mc.rp, 60);
  assert.deepEqual(mc.s.at(-1), [24, 5, 6, 2, 0, 2]);
  assert.equal(mc.g.at(-1), 46.5);
  assert.equal(mc.g.length, 3);
  const ib = after.players.find((p) => p.n === "Serge Ibaka");
  assert.equal(ib.g.at(-1), 40);
  const manu = after.players.find((p) => p.n === "Manu Ginóbili");
  assert.deepEqual(manu.s.at(-1), [26, 7, 7, 2, 1, 5]);
  const russell = after.players.find((p) => p.n === "Bill Russell");
  assert.equal(russell.g.length, 1, "player who did not play gets no game");
  assert.deepEqual(after.boxScoreContests, ["run-fb-historic-2026-11-16-v2-d2"]);

  // Never twice: a later tick and a manual run both leave it alone.
  const st = await get(env, A.HISTORIC_AUTO_STATE_KEY);
  st.waitUntil = null;
  await env.FASTBREAK_KV.put(A.HISTORIC_AUTO_STATE_KEY, JSON.stringify(st));
  r = await A.runHistoricAutoTick(env, { validate, now: A.dueAtMs(d2) + 20 * 60 * 1000, fetchImpl: fetchPage });
  assert.equal(r.action, "idle");
  const again = await A.ingestContest(env, d2, { validate });
  assert.equal(again.skipped, "already in dataset");
  assert.equal(browserCalls.length, 1);
  assert.equal((await get(env, "fastbreak:historic:optimizer")).players.find((p) => p.n === "Tracy McGrady").g.length, 3);
}

// -- Dry run previews without saving --------------------------------------------------------
{
  const env = { FASTBREAK_KV: makeKV(), BROWSER };
  await env.FASTBREAK_KV.put("fastbreak:historic:optimizer", JSON.stringify(makeDataset()));
  const r = await A.ingestContest(env, d2, { validate, dryRun: true });
  assert.equal(r.appended, 49);
  assert.equal(r.dryRun, true);
  assert.deepEqual(await get(env, "fastbreak:historic:optimizer"), makeDataset());
}

// -- Games not final yet: waits; no binding: fails safely and gives up --------------------------
{
  const env = { FASTBREAK_KV: makeKV(), BROWSER };
  await env.FASTBREAK_KV.put("fastbreak:historic:optimizer", JSON.stringify(makeDataset()));
  await env.FASTBREAK_KV.put(A.HISTORIC_AUTO_STATE_KEY, JSON.stringify({ startedAt: "x", done: { "run-fb-historic-2026-11-16-v2-d1": {}, "run-fb-historic-2026-11-16-v2-d2": {} }, attempts: {} }));
  const d3 = contests[2];
  const r = await A.runHistoricAutoTick(env, { validate, now: A.dueAtMs(d3) + 60 * 1000, fetchImpl: fetchPage });
  assert.equal(r.action, "waiting-for-finals");

  const noBrowser = { FASTBREAK_KV: env.FASTBREAK_KV };
  const finalPage = async () => new Response(pageHtml({ d3Final: true }), { status: 200 });
  for (let i = 1; i <= 4; i++) {
    const t = await A.runHistoricAutoTick(noBrowser, { validate, now: A.dueAtMs(d3) + i * 5 * 60 * 1000, fetchImpl: finalPage });
    assert.equal(t.action, "error");
    assert.match(t.error, /BROWSER binding is not configured/);
  }
  const t5 = await A.runHistoricAutoTick(noBrowser, { validate, now: A.dueAtMs(d3) + 30 * 60 * 1000, fetchImpl: finalPage });
  assert.equal(t5.action, "gave-up");
  assert.deepEqual(await get(env, "fastbreak:historic:optimizer"), makeDataset(), "nothing written on failure");
}

// -- A short read (fewer box scores than games) is refused ------------------------------------
{
  const env = {
    FASTBREAK_KV: makeKV(),
    BROWSER: { async quickAction() { const b = { errors: ["game 3: box score did not open"], games: BOX.games.slice(0, 3) }; return new Response(JSON.stringify({ success: true, result: `<script type="application/json" id="tome-historic-bs">${JSON.stringify(b)}</script>` })); } },
  };
  await env.FASTBREAK_KV.put("fastbreak:historic:optimizer", JSON.stringify(makeDataset()));
  await assert.rejects(A.ingestContest(env, d2, { validate }), /read 3 of 5 box scores: game 3/);
  assert.deepEqual(await get(env, "fastbreak:historic:optimizer"), makeDataset());
}

// -- The Worker routes the Historic cron to this module only --------------------------------------
{
  const env = { FASTBREAK_KV: makeKV(), BROWSER };
  await env.FASTBREAK_KV.put("fastbreak:historic:optimizer", JSON.stringify(makeDataset()));
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return fetchPage(); };
  try {
    await worker.scheduled({ cron: A.HISTORIC_AUTO_CRON }, env);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, [A.HISTORIC_PAGE], "only the public Historic page is fetched");
  assert.ok(await env.FASTBREAK_KV.get(A.HISTORIC_AUTO_STATE_KEY));
  assert.equal(await env.FASTBREAK_KV.get("fastbreak:cron:WNBA"), null, "no league tick ran");
}

// -- The page script is valid JavaScript --------------------------------------------------------
new Function(A.BOX_SCORE_PAGE_SCRIPT);

// -- wrangler.toml lists the cron and the binding -------------------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.ok(toml.includes(`"${A.HISTORIC_AUTO_CRON}"`), "cron string matches HISTORIC_AUTO_CRON");
  assert.match(toml, /\[browser\]\s*\nbinding = "BROWSER"/);
}

console.log("historic-auto: all checks passed");
