// Local verification for the refresh Worker (no Cloudflare account needed):
//   node dashboards/fastbreak-refresh/worker/_local_test.mjs
// Mocks BALLDONTLIE (both league shapes) and KV, then exercises the pure
// helpers plus full resumable day builds for WNBA (PITP day) and a big NBA
// slate that needs several calls to finish under the subrequest ceiling.
import assert from "node:assert/strict";
import worker, { __testables__ as T } from "./index.js";

// -- Mock KV -------------------------------------------------------------------
function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

// -- Mock BALLDONTLIE ------------------------------------------------------------
// Builds a fake league: `numGames` games on `date`, 16 active players/team,
// every team with 12 completed prior games (so L10 + YTD both have data).
function makeLeagueFixture({ league, date, numGames, priorSeason, priorBase }) {
  const teams = [];
  for (let i = 0; i < numGames * 2; i++) teams.push({ id: 100 + i, abbreviation: `T${i}`, full_name: `Team ${i}` });
  const players = [];
  let pid = 1;
  for (const t of teams) {
    for (let k = 0; k < 16; k++) {
      players.push({ id: pid++, first_name: `P${t.id}`, last_name: `N${k}`, team: { id: t.id, abbreviation: t.abbreviation } });
    }
  }
  const todayGames = [];
  for (let g = 0; g < numGames; g++) {
    const home = teams[g * 2];
    const away = teams[g * 2 + 1];
    todayGames.push(rawGame(league, { id: 9000 + g, date, datetime: `${date}T23:30:00.000Z`, home, away, final: false, season: priorSeason + 1 }));
  }
  // 12 prior completed games per team pair, spread over the last 60 days.
  const priorGames = [];
  let gid = 1000;
  for (let g = 0; g < numGames; g++) {
    const home = teams[g * 2];
    const away = teams[g * 2 + 1];
    for (let n = 1; n <= 12; n++) {
      const d = T.addDaysStr(priorBase, -3 * n); // L10/YTD windows always end at the REAL today, so anchor prior games there
      priorGames.push(rawGame(league, { id: gid++, date: d, datetime: `${d}T23:00:00.000Z`, home, away, final: true, season: priorSeason }));
    }
  }
  return { teams, players, todayGames, priorGames };
}
const ALL_STAR_GAME = { id: 77777, date: "2026-07-25", datetime: "2026-07-25T23:00:00.000Z", season: 2026, status: "post", home_team: { id: 900, abbreviation: "COOP", full_name: "TEAM COOP", conference: "" }, visitor_team: { id: 901, abbreviation: "SPO", full_name: "TEAM SPOON", conference: "" }, home_score: 122, away_score: 129 };

function rawGame(league, { id, date, datetime, home, away, final, season }) {
  if (league === "WNBA") {
    return { id, date, datetime, season, status: final ? "post" : "pre", home_team: home, visitor_team: away, home_score: final ? 80 : null, away_score: final ? 75 : null };
  }
  return {
    id,
    date,
    datetime,
    season,
    status: final ? "Final" : "7:30 pm ET",
    status_state: final ? "final" : "pre",
    period: final ? 4 : 0,
    time: final ? "Final" : "",
    home_team: home,
    visitor_team: away,
    home_team_score: final ? 110 : 0,
    visitor_team_score: final ? 104 : 0,
  };
}

function installMockFetch(fixtures) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const league = u.pathname.startsWith("/wnba/") ? "WNBA" : "NBA";
    const fx = fixtures[league];
    const params = u.searchParams;
    const json = (data, meta = {}) => new Response(JSON.stringify({ data, meta }), { status: 200 });
    const allGames = [...fx.todayGames, ...fx.priorGames, ...(league === "WNBA" ? [ALL_STAR_GAME] : [])];

    if (u.pathname.endsWith("/games")) {
      const dates = params.getAll("dates[]");
      const teamIds = params.getAll("team_ids[]").map(Number);
      let games = allGames;
      if (dates.length) games = games.filter((g) => dates.includes(g.date));
      if (params.get("start_date")) games = games.filter((g) => g.date >= params.get("start_date") && g.date <= params.get("end_date"));
      if (teamIds.length) games = games.filter((g) => teamIds.includes(g.home_team.id) || teamIds.includes(g.visitor_team.id));
      return json(games);
    }
    if (u.pathname.endsWith("/players/active")) {
      const teamIds = params.getAll("team_ids[]").map(Number);
      let ps = teamIds.length ? fx.players.filter((p) => teamIds.includes(p.team.id)) : fx.players;
      const cursor = Number(params.get("cursor") || 0);
      const page = ps.slice(cursor, cursor + 100);
      return json(page, cursor + 100 < ps.length ? { next_cursor: cursor + 100 } : {});
    }
    if (u.pathname.endsWith("/player_injuries")) {
      return json([{ player: { id: 1 }, status: "Out", description: "knee" }]);
    }
    if (u.pathname.endsWith("/player_stats") || u.pathname.endsWith("/v1/stats")) {
      const playerIds = params.getAll("player_ids[]").map(Number);
      const gameIds = new Set(params.getAll("game_ids[]").map(Number));
      const rows = [];
      for (const p of fx.players.filter((p) => playerIds.includes(p.id))) {
        for (const g of allGames.filter((g) => gameIds.has(g.id) && (g.home_team.id === p.team.id || g.visitor_team.id === p.team.id))) {
          rows.push({ id: p.id * 100000 + g.id, pts: 10 + (p.id % 7), reb: 4, ast: 3, stl: 1, blk: 1, turnover: 2, fgm: 4, fga: 9, fg3m: 1, fg3a: 3, ftm: 1, fta: 2, oreb: 1, player: { id: p.id }, game: { id: g.id, date: g.date } });
        }
      }
      // Real API: oldest-first, 100/page, cursor pagination.
      rows.sort((a, b) => a.game.date.localeCompare(b.game.date));
      const cursor = Number(params.get("cursor") || 0);
      const page = rows.slice(cursor, cursor + 100);
      return json(page, cursor + 100 < rows.length ? { next_cursor: cursor + 100 } : {});
    }
    if (u.pathname.includes("advanced")) {
      const playerIds = params.getAll("player_ids[]").map(Number);
      const gameIds = new Set(params.getAll("game_ids[]").map(Number));
      const rows = [];
      for (const p of fx.players.filter((p) => playerIds.includes(p.id))) {
        for (const g of allGames.filter((g) => gameIds.has(g.id) && (g.home_team.id === p.team.id || g.visitor_team.id === p.team.id))) {
          rows.push(
            league === "WNBA"
              ? { player: { id: p.id }, game: { id: g.id, date: g.date }, stats: { misc: { points_paint: 6 } } }
              : { player: { id: p.id }, game: { id: g.id, date: g.date }, points_paint: 8 }
          );
        }
      }
      return json(rows);
    }
    return new Response("not found", { status: 404 });
  };
  return calls;
}

// -- Pure helpers ------------------------------------------------------------------
assert.equal(T.colorTier(12.5, 10), "dark-green");
assert.equal(T.colorTier(10, 10), "light-green");
assert.equal(T.colorTier(9, 10), "yellow");
assert.equal(T.colorTier(7.5, 10), "light-yellow");
assert.equal(T.colorTier(7.4, 10), null);
assert.equal(T.LEAGUES.NBA.seasonFor("2026-10-20"), 2026);
assert.equal(T.LEAGUES.NBA.seasonFor("2027-03-01"), 2026);
assert.equal(T.LEAGUES.WNBA.seasonFor("2026-09-17"), 2026);
assert.equal(T.etDateStrForGame({ date: "2026-10-20" }), "2026-10-20", "plain NBA date is not shifted");
assert.equal(T.etDateStrForGame({ datetime: "2026-10-21T02:30:00.000Z" }), "2026-10-20", "late ET tip stays on its ET date");
assert.equal(T.etDateStrForGame({ datetime: "2026-11-10T03:00:00.000Z" }), "2026-11-09", "EST handled after DST ends");
assert.equal(T.dayNumberForDate("WNBA", "2026-09-17"), 1);
assert.equal(T.dayNumberForDate("WNBA", "2026-09-24"), 8);
assert.equal(T.dayNumberForDate("NBA", "2026-10-20"), 1);
assert.equal(T.dayNumberForDate("NBA", "2026-10-26"), 7);
assert.equal(T.isWithinRun("NBA", "2026-10-27"), false);
assert.equal(T.isSeasonActive("NBA", "2026-09-04"), false);
assert.equal(T.isSeasonActive("WNBA", "2026-09-04"), true);
assert.equal(T.LEAGUES.NBA.status({ status: "Final", status_state: "final" }), "post");
assert.equal(T.LEAGUES.NBA.status({ status: "7:00 pm ET", period: 0 }), "pre");
assert.equal(T.LEAGUES.NBA.status({ status: "3rd Qtr", period: 3 }), "in");
assert.equal(T.LEAGUES.WNBA.status({ status: "post" }), "post");
const ranks = T.rankDescending([{ id: "a", value: 5 }, { id: "b", value: 5 }, { id: "c", value: 3 }, { id: "d", value: null }]);
assert.deepEqual([ranks.get("a"), ranks.get("b"), ranks.get("c"), ranks.get("d")], [1, 1, 3, 4]);
assert.throws(() => T.validateObjectives([{ stat: "XYZ", dailyTeamTarget: 5 }]));
// All-Star exhibition games are dropped from every games feed (FB-D1).
const allStar = { id: 77777, date: "2026-07-25", datetime: "2026-07-25T23:00:00.000Z", status: "post", home_team: { id: 900, abbreviation: "COOP", full_name: "TEAM COOP", conference: "" }, visitor_team: { id: 901, abbreviation: "SPO", full_name: "TEAM SPOON", conference: "" }, home_score: 122, away_score: 129 };
assert.equal(T.isExhibitionGame(allStar), true, "TEAM COOP vs TEAM SPOON is an exhibition");
assert.equal(T.isExhibitionGame({ home_team: { id: 1, abbreviation: "LAL", full_name: "Team LeBron" }, visitor_team: { id: 2, abbreviation: "MIL", full_name: "Team Giannis" } }), true, "NBA All-Star squads");
assert.equal(T.isExhibitionGame({ home_team: { id: 1, abbreviation: "ATL", full_name: "Atlanta Dream", conference: "East" }, visitor_team: { id: 2, abbreviation: "TOR", full_name: "Toronto Tempo", conference: "East" } }), false, "real teams pass");
assert.equal(T.isExhibitionGame({ home_team: { id: 1, abbreviation: "T0", full_name: "Team 0" }, visitor_team: { id: 2, abbreviation: "T1", full_name: "Team 1" } }), false, "fixture-style 'Team 0' is not treated as an exhibition");
// Constant-time secret comparison: correct results, and the comparison path
// never short-circuits -- with crypto.subtle.timingSafeEqual present it is
// always called with equal-length buffers (it throws otherwise); without it
// (Node) the XOR fold runs over every byte.
assert.equal(T.secretEquals("abc", "abc"), true);
assert.equal(T.secretEquals("abc", "abd"), false);
assert.equal(T.secretEquals("abc", "abcd"), false, "length mismatch is false");
assert.equal(T.secretEquals("", ""), false, "empty expected never matches");
assert.equal(T.secretEquals("abc", ""), false);
assert.equal(T.secretEquals(undefined, "abc"), false);
assert.equal(T.secretInList("k2", ["k1", "k2", "k3"]), true);
assert.equal(T.secretInList("k4", ["k1", "k2", "k3"]), false);
assert.equal(T.secretInList("k1", []), false);
{
  const calls = [];
  const subtle = globalThis.crypto.subtle;
  const original = subtle.timingSafeEqual;
  Object.defineProperty(subtle, "timingSafeEqual", { configurable: true, value: (a, b) => { calls.push([a.length, b.length]); let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; } });
  try {
    assert.equal(T.secretEquals("secret-token", "secret-token"), true);
    assert.equal(T.secretEquals("secret-tokeX", "secret-token"), false);
    assert.equal(T.secretEquals("short", "secret-token"), false);
    assert.equal(T.secretInList("k9", ["k1", "k2"]), false);
  } finally {
    if (original) Object.defineProperty(subtle, "timingSafeEqual", { configurable: true, value: original }); else delete subtle.timingSafeEqual;
  }
  assert.equal(calls.length, 5, "every comparison (incl. every list candidate) goes through timingSafeEqual");
  assert.ok(calls.every(([x, y]) => x === y), "timingSafeEqual always gets equal-length buffers");
}
console.log("pure helpers ok");

// -- Objectives + projections write paths ------------------------------------------
{
  const env = { FASTBREAK_KV: makeKV(), FASTBREAK_ADMIN_TOKEN: "t" };
  await T.upsertObjectivesDay(env, { league: "NBA", date: "2026-10-20", mode: "Classic", objectives: [{ stat: "PTS", dailyTeamTarget: 100 }] });
  await T.upsertObjectivesDay(env, { league: "NBA", date: "2026-10-20", mode: "Pro", objectives: [{ stat: "3PM", dailyTeamTarget: 12 }], badgeSetName: "Rookie Year" });
  await T.upsertObjectivesDay(env, { league: "WNBA", date: "2026-09-17", mode: "Classic", objectives: [{ stat: "PITP", dailyTeamTarget: 25 }, { stat: "OREB", dailyTeamTarget: 10 }] });
  const s = await T.upsertProjections(env, { league: "NBA", date: "2026-10-20", stat: "PTS", projections: [{ name: "P100 N0", value: 24.5 }] });
  assert.equal(T.objectivesForDate(s, "NBA", "2026-10-20", "Classic")[0].stat, "PTS");
  assert.equal(T.objectivesForDate(s, "NBA", "2026-10-20", "Pro")[0].stat, "3PM");
  assert.equal(s.NBA["2026-10-20"].badgeSetName, "Rookie Year");
  assert.equal(T.objectivesForDate(s, "WNBA", "2026-10-20", "Classic")[0].stat, "PTS", "falls back to default for unset league/date");
  assert.equal(T.projectionsForDate(s, "NBA", "2026-10-20", "PTS")["p100 n0"].value, 24.5);
  await assert.rejects(T.upsertObjectivesDay(env, { league: "XFL", date: "2026-10-20", mode: "Classic", objectives: [{ stat: "PTS", dailyTeamTarget: 1 }] }));
  console.log("objectives/projections ok");
}

// -- Full builds --------------------------------------------------------------------
const NBA_DATE = "2026-10-21";
const WNBA_DATE = "2026-09-17";
const fixtures = {
  // NBA prior games sit before this season's Sept 1 start (i.e. last season), like a real opening week.
  NBA: makeLeagueFixture({ league: "NBA", date: NBA_DATE, numGames: 12, priorSeason: 2025, priorBase: T.addDaysStr(`${T.LEAGUES.NBA.seasonFor(T.todayStr())}-09-01`, -1) }),
  WNBA: makeLeagueFixture({ league: "WNBA", date: WNBA_DATE, numGames: 3, priorSeason: 2026, priorBase: T.todayStr() }),
};
const calls = installMockFetch(fixtures);

function countSince(mark) {
  return calls.length - mark;
}

{
  // NBA: 12 games = 24 teams * 16 = 384 players. Must NOT fit in one call and
  // must NOT drop anyone -- it should finish across several calls, each under
  // the ceiling, then serve from cache with zero BALLDONTLIE calls.
  const env = { FASTBREAK_KV: makeKV(), FASTBREAK_ADMIN_TOKEN: "t", BALLDONTLIE_API_KEY: "k" };
  await T.upsertObjectivesDay(env, { league: "NBA", date: NBA_DATE, mode: "Classic", objectives: [{ stat: "PTS", dailyTeamTarget: 100 }, { stat: "REB", dailyTeamTarget: 40 }] });
  await T.upsertProjections(env, { league: "NBA", date: NBA_DATE, stat: "PTS", projections: [{ name: "P100 N0", value: 30 }, { name: "P101 N1", value: 22 }] });

  let mark = calls.length;
  let payload = await T.buildDashboard(env, { league: "NBA", date: NBA_DATE, mode: "Classic" });
  assert.ok(countSince(mark) <= T.MAX_SUBREQUESTS, `first call used ${countSince(mark)} subrequests`);
  assert.equal(payload.building, true, "big slate is still building after one call");
  assert.equal(payload.progress.total, 384);
  assert.ok(payload.players.length > 0 && payload.players.length < 384, `partial players served (${payload.players.length})`);
  assert.equal(payload.games.length, 12);
  assert.equal(payload.runLabel, "Run 1");
  assert.equal(payload.dayNumber, 2);
  assert.ok(env.FASTBREAK_KV.store.has(T.dayBuildKey(T.LEAGUES.NBA, NBA_DATE)), "build state persisted");

  let rounds = 1;
  while (payload.building && rounds < 10) {
    mark = calls.length;
    payload = await T.buildDashboard(env, { league: "NBA", date: NBA_DATE, mode: "Classic" });
    assert.ok(countSince(mark) <= T.MAX_SUBREQUESTS, `round ${rounds + 1} used ${countSince(mark)}`);
    rounds += 1;
  }
  assert.equal(payload.building, false, "build finishes");
  assert.equal(payload.players.length, 384, "no players dropped");
  assert.ok(rounds >= 2 && rounds <= 4, `finished in ${rounds} rounds`);
  assert.ok(env.FASTBREAK_KV.store.has(T.dayKey(T.LEAGUES.NBA, NBA_DATE)), "snapshot published");
  assert.ok(!env.FASTBREAK_KV.store.has(T.dayBuildKey(T.LEAGUES.NBA, NBA_DATE)), "build key cleared");

  const p1 = payload.players.find((p) => p.name === "P100 N0");
  // Player 1 is "Out" in the mock injury report: shown, but never ranked,
  // sorted last, and excluded from the auto-weight base (FB-F3).
  assert.equal(p1.injuryStatus, "Out");
  assert.equal(p1.availability, "out");
  assert.equal(p1.ovrRank, null, "Out player has no Ovr Rank");
  assert.equal(payload.players[payload.players.length - 1].id, p1.id, "Out player sorted to the bottom");
  assert.ok(payload.players.filter((p) => p.availability !== "out").every((p) => Number.isInteger(p.ovrRank)), "everyone else ranked");
  assert.equal(payload.players[0].ovrRank, 1, "best available player is #1");
  assert.equal(p1.objectives.PTS.proj, 30);
  assert.equal(p1.objectives.PTS.projSource, "rotowire");
  assert.equal(p1.objectives.REB.projSource, "tbd");
  assert.equal(p1.objectives.REB.proj, null);
  assert.equal(p1.objectives.PTS.gamesPlayedL10, 10, "L10 uses last 10 of 12 prior games (prior season)");
  assert.equal(p1.objectives.PTS.ytd, null, "no current-season games yet -> YTD empty");
  assert.equal(p1.injuryStatus, "Out");
  assert.equal(p1.opp, "vs T1");
  assert.equal(payload.objectives.length, 2);
  assert.ok(Math.abs(payload.objectives[0].weight + payload.objectives[1].weight - 1) < 1e-9);
  assert.ok(payload.teamAdvanced.T0?.record, "team advanced metrics computed");
  assert.equal(payload.teamAdvanced.T0.gamesPlayed, 10);

  // Cached: Pro on the same date is pure computation (different objectives).
  await T.upsertObjectivesDay(env, { league: "NBA", date: NBA_DATE, mode: "Pro", objectives: [{ stat: "3PM", dailyTeamTarget: 12 }], badgeSetName: "Rookie Year" });
  mark = calls.length;
  const pro = await T.buildDashboard(env, { league: "NBA", date: NBA_DATE, mode: "Pro" });
  assert.equal(countSince(mark), 0, "cached snapshot serves Pro with no API calls");
  assert.equal(pro.objectives[0].stat, "3PM");
  assert.equal(pro.badgeSetName, "Rookie Year");
  assert.equal(pro.players.length, 384);

  // Adding PITP to a mode invalidates the snapshot (needs the advanced endpoint).
  await T.upsertObjectivesDay(env, { league: "NBA", date: NBA_DATE, mode: "Pro", objectives: [{ stat: "PITP", dailyTeamTarget: 40 }] });
  mark = calls.length;
  const rebuilt = await T.buildDashboard(env, { league: "NBA", date: NBA_DATE, mode: "Pro" });
  assert.ok(countSince(mark) > 0, "PITP change triggers a rebuild");
  assert.equal(rebuilt.building, false, "complete snapshot served, not the partial rebuild");
  assert.equal(rebuilt.players.length, 384, "stale-but-complete snapshot still served while rebuilding");
  assert.ok(rebuilt.refreshing);
  console.log(`NBA big-slate build ok (${rounds} rounds)`);
}

{
  // WNBA: small PITP day finishes in one call; PITP proj falls back to L10.
  const env = { FASTBREAK_KV: makeKV(), FASTBREAK_ADMIN_TOKEN: "t", BALLDONTLIE_API_KEY: "k" };
  await T.upsertObjectivesDay(env, { league: "WNBA", date: WNBA_DATE, mode: "Classic", objectives: [{ stat: "PITP", dailyTeamTarget: 25 }, { stat: "OREB", dailyTeamTarget: 10 }] });
  // 96 players on a PITP day = up to 8 calls/chunk (L10 + 3 YTD pages, x2
  // for the advanced endpoint), so it can take two loads to finish.
  let payload;
  let rounds = 0;
  do {
    const mark = calls.length;
    payload = await T.buildDashboard(env, { league: "WNBA", date: WNBA_DATE, mode: "Classic" });
    assert.ok(countSince(mark) <= T.MAX_SUBREQUESTS, `WNBA round used ${countSince(mark)}`);
    rounds += 1;
  } while (payload.building && rounds < 5);
  assert.equal(payload.building, false);
  assert.ok(rounds <= 3, `WNBA PITP day finished in ${rounds} rounds`);
  assert.equal(payload.league, "WNBA");
  assert.equal(payload.runLabel, "Run 11");
  assert.equal(payload.dayNumber, 1);
  assert.equal(payload.players.length, 96);
  const p = payload.players[0];
  assert.equal(p.objectives.PITP.l10, 6);
  assert.equal(p.objectives.PITP.proj, 6);
  assert.equal(p.objectives.PITP.projSource, "l10-fallback");
  assert.equal(p.objectives.OREB.l10, 1);
  assert.equal(p.objectives.OREB.ytd, 1, "WNBA prior games are the same season -> YTD populated");
  assert.equal(payload.games[0].time, "7:30 PM ET (23:30 UTC)");
  assert.ok(/PITP: no|OREB: no Rotowire/.test(payload.note));

  // No-games date.
  const empty = await T.buildDashboard(env, { league: "WNBA", date: "2026-09-18", mode: "Pro" });
  assert.equal(empty.players.length, 0);
  assert.match(empty.note, /No WNBA games/);
  console.log("WNBA PITP day ok");
}

{
  // HTTP surface: run metadata, league param, historic status, cron dispatch.
  const env = { FASTBREAK_KV: makeKV(), FASTBREAK_ADMIN_TOKEN: "t", BALLDONTLIE_API_KEY: "k", TOME_SUBSCRIBER_KEYS: "sub-old, sub-new" };
  let res = await worker.fetch(new Request("https://x/api/fastbreak/run?league=ALL"), env);
  let body = await res.json();
  assert.equal(body.NBA.runStart, "2026-10-20");
  assert.equal(body.WNBA.runEnd, "2026-09-24");
  assert.equal(body.WNBA.runLength, 8);
  assert.equal(body.NBA.runLength, 7);

  res = await worker.fetch(new Request("https://x/api/fastbreak/objectives/day", { method: "POST", body: JSON.stringify({ league: "nba", date: NBA_DATE, mode: "Classic", objectives: [{ stat: "AST", dailyTeamTarget: 25 }] }) }), env);
  assert.equal(res.status, 401, "admin token required");
  // Password verify route used by the frontend's unlock gate.
  res = await worker.fetch(new Request("https://x/api/fastbreak/admin/verify", { method: "POST" }), env);
  assert.equal(res.status, 401, "verify without token");
  res = await worker.fetch(new Request("https://x/api/fastbreak/admin/verify", { method: "POST", headers: { "X-Admin-Token": "wrong" } }), env);
  assert.equal(res.status, 401, "verify with wrong token");
  res = await worker.fetch(new Request("https://x/api/fastbreak/admin/verify", { method: "POST", headers: { "X-Admin-Token": "t" } }), env);
  assert.equal(res.status, 200, "verify with right token");
  res = await worker.fetch(new Request("https://x/api/fastbreak/admin/verify", { method: "POST", headers: { "X-Admin-Token": "t" } }), { ...env, FASTBREAK_ADMIN_TOKEN: "" });
  assert.equal(res.status, 401, "empty secret never verifies");
  res = await worker.fetch(new Request("https://x/api/fastbreak/objectives/day", { method: "POST", headers: { "X-Admin-Token": "t" }, body: JSON.stringify({ league: "nba", date: NBA_DATE, mode: "Classic", objectives: [{ stat: "AST", dailyTeamTarget: 25 }] }) }), env);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.schedule.NBA[NBA_DATE].objectives.Classic[0].stat, "AST", "lowercase league accepted");

  // Subscriber gate: no key -> 401 (locked), wrong key -> 401, either listed
  // key -> 200, admin token -> 200, secret unset -> 503 (fails closed).
  res = await worker.fetch(new Request(`https://x/api/fastbreak?league=NBA&date=${NBA_DATE}&mode=Classic`), env);
  assert.equal(res.status, 401, "no subscriber key");
  assert.equal((await res.json()).locked, true);
  res = await worker.fetch(new Request(`https://x/api/fastbreak?league=NBA&date=${NBA_DATE}&key=nope`), env);
  assert.equal(res.status, 401, "wrong subscriber key");
  res = await worker.fetch(new Request(`https://x/api/fastbreak?league=NBA&date=${NBA_DATE}`), { ...env, TOME_SUBSCRIBER_KEYS: "" });
  assert.equal(res.status, 503, "unset subscriber secret fails closed");
  for (const p of ["/api/fastbreak/objectives", "/api/fastbreak/fulldata?league=NBA", "/api/fastbreak/historic"]) {
    res = await worker.fetch(new Request(`https://x${p}`), env);
    assert.equal(res.status, 401, `${p} gated`);
  }
  // Public (subscriber) reads are serve-only: nothing cached for this date ->
  // queued stub, zero BALLDONTLIE calls.
  const c0 = calls.length;
  res = await worker.fetch(new Request(`https://x/api/fastbreak?league=NBA&date=${NBA_DATE}&mode=Classic`, { headers: { "X-Tome-Key": "sub-old" } }), env);
  assert.equal(res.status, 200, "old key still valid during rotation overlap");
  body = await res.json();
  assert.equal(body.queued, true, "serve-only read never builds");
  assert.equal(calls.length, c0, "serve-only read made no upstream calls");
  // Admin read builds on demand.
  res = await worker.fetch(new Request(`https://x/api/fastbreak?league=NBA&date=${NBA_DATE}&mode=Classic`, { headers: { "X-Admin-Token": "t" } }), env);
  body = await res.json();
  assert.equal(body.league, "NBA");
  assert.equal(body.objectives[0].stat, "AST");
  assert.ok(calls.length > c0, "admin read built the slate");
  // ...and now the subscriber read is served from the snapshot.
  res = await worker.fetch(new Request(`https://x/api/fastbreak?league=NBA&date=${NBA_DATE}&mode=Classic&key=sub-new`), env);
  body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(!body.queued && body.players.length > 0, "subscriber read served from snapshot");
  // League switch (FB-3): NBA defaults OFF in /run, admin can flip it; key
  // probe reports what the key can read.
  res = await worker.fetch(new Request("https://x/api/fastbreak/run?league=ALL"), env);
  body = await res.json();
  assert.equal(body.NBA.enabled, false, "NBA defaults to disabled");
  assert.equal(body.WNBA.enabled, true, "WNBA defaults to enabled");
  res = await worker.fetch(new Request("https://x/api/fastbreak/league/enable", { method: "POST", body: JSON.stringify({ league: "NBA", enabled: true }) }), env);
  assert.equal(res.status, 401, "league switch needs admin");
  res = await worker.fetch(new Request("https://x/api/fastbreak/league/enable", { method: "POST", headers: { "X-Admin-Token": "t" }, body: JSON.stringify({ league: "NBA", enabled: true }) }), env);
  assert.equal(res.status, 200);
  res = await worker.fetch(new Request("https://x/api/fastbreak/run?league=NBA"), env);
  assert.equal((await res.json()).enabled, true, "NBA switched on");
  res = await worker.fetch(new Request("https://x/api/fastbreak/league/keycheck", { method: "POST", headers: { "X-Admin-Token": "t" }, body: JSON.stringify({ league: "NBA" }) }), env);
  body = await res.json();
  assert.equal(body.entitled, true, "mock key reads both endpoints");
  res = await worker.fetch(new Request("https://x/api/fastbreak/league/status", { headers: { "X-Admin-Token": "t" } }), env);
  body = await res.json();
  assert.equal(body.enabled.NBA, true);
  assert.equal(body.keyCheck.NBA.activePlayers, "ok");
  // Rate limiter binding, when present, is honoured.
  res = await worker.fetch(new Request("https://x/api/fastbreak/run?league=ALL"), { ...env, PUBLIC_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(res.status, 429, "rate limited");

  res = await worker.fetch(new Request("https://x/api/fastbreak/historic/objectives/day", { method: "POST", headers: { "X-Admin-Token": "t" }, body: JSON.stringify({ day: 3, objectives: [{ stat: "REB", dailyTeamTarget: 30 }] }) }), env);
  body = await res.json();
  assert.equal(body.ok, true);
  res = await worker.fetch(new Request("https://x/api/fastbreak/historic/status"), env);
  body = await res.json();
  assert.equal(body.objectivesDays, 1);
  assert.equal(body.objectives[0].objectives[0].type, "REB");

  res = await worker.fetch(new Request("https://x/api/fastbreak/day/invalidate", { method: "POST", headers: { "X-Admin-Token": "t" }, body: JSON.stringify({ league: "NBA", date: NBA_DATE }) }), env);
  assert.equal(res.status, 200);
  assert.ok(!env.FASTBREAK_KV.store.has(T.dayKey(T.LEAGUES.NBA, NBA_DATE)));

  // Cron: NBA tick is a no-op before Oct 15 (today is real ET today, which
  // the harness can't fake, so just assert the WNBA/NBA dispatch strings).
  assert.equal(T.LEAGUE_CRONS.WNBA, "*/30 * * * *");
  assert.equal(T.LEAGUE_CRONS.NBA, "7-59/15 * * * *");
  const before = calls.length;
  await worker.scheduled({ cron: T.LEAGUE_CRONS.NBA }, env);
  if (!T.isSeasonActive("NBA", T.todayStr())) assert.equal(calls.length, before, "NBA cron skipped out of season");
  // WNBA tick (in season): refreshes today's snapshot into fastbreak:latest
  // and advances that league's Full Data build with the leftover budget.
  const mark = calls.length;
  await worker.scheduled({ cron: T.LEAGUE_CRONS.WNBA }, env);
  assert.ok(calls.length - mark <= T.MAX_SUBREQUESTS, `WNBA cron tick used ${calls.length - mark}`);
  assert.ok(env.FASTBREAK_KV.store.has("fastbreak:latest"), "WNBA latest cached by cron");
  // Health route reflects the cron heartbeat and snapshot ages (pure KV, no
  // upstream calls, ungated).
  const hmark = calls.length;
  res = await worker.fetch(new Request("https://x/api/fastbreak/health"), env);
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(calls.length, hmark, "health route makes no upstream calls");
  assert.ok(health.leagues.WNBA.lastCronTickAt, "WNBA cron heartbeat recorded");
  assert.ok(health.leagues.WNBA.lastCronOkAt, "WNBA cron success recorded");
  assert.ok(health.leagues.WNBA.latestAgeMs != null && health.leagues.WNBA.latestAgeMs < 60000, "latest snapshot age reported");
  assert.equal(health.leagues.WNBA.cronIntervalMinutes, 30);
  assert.ok(health.leagues.NBA.lastCronTickAt, "NBA off-season tick still heartbeats");
  assert.equal(health.leagues.NBA.seasonActive, T.isSeasonActive("NBA", T.todayStr()));
  assert.ok(env.FASTBREAK_KV.store.has("fastbreak:fulldata:build"), "WNBA full-data build started by cron");
  // Drive the WNBA Full Data build to completion; the All-Star game in the
  // mock feed must not surface as a team.
  for (let i = 0; i < 20 && !env.FASTBREAK_KV.store.has("fastbreak:fulldata"); i++) {
    await T.advanceFullDataBuild(env, "WNBA", T.MAX_SUBREQUESTS - 4);
  }
  const fd = JSON.parse(env.FASTBREAK_KV.store.get("fastbreak:fulldata"));
  assert.ok(!Object.keys(fd.teams).some((k) => k === "COOP" || k === "SPO"), `All-Star squads excluded from Full Data teams (${Object.keys(fd.teams).join(",")})`);
  assert.ok(!JSON.stringify(fd).includes("TEAM COOP"), "no exhibition team anywhere in Full Data");
  console.log("http surface + cron dispatch ok");
}

console.log("\nALL LOCAL TESTS PASSED");
