// tome-fastbreak-refresh
// Scheduled Worker: pulls live BALLDONTLIE data, builds the Fast Break dashboard
// payload (schedule tiles, per-objective Proj/YTD/L10 + color tiers, auto-
// weighted Ovr Rank), and caches it in KV for the public-facing tome-fastbreak
// Worker (and the GitHub Pages frontend) to serve. Also owns the objectives
// schedule (viewable by anyone, editable only with the admin password).
//
// LEAGUES: WNBA and NBA both run through the same live pipeline; everything
// league-specific (API base, score/status field shapes, season numbering,
// run window, KV keys) lives in the LEAGUES table below. NBA Historic is a
// separate simulated pipeline in ./historic.js.
//
// RUN model: objectives/games/badge info are scheduled per calendar date
// across a multi-day "Run" per league (WNBA Run 11: Sept 17-24, 2026; NBA
// Run 1: Oct 20-26, 2026). Each date carries a separate Classic objective set
// and Pro objective set (Pro also carries an optional Top Shot badge/set
// name). Rotowire projections are uploaded once per league/date and shared
// by Classic and Pro (a player's projected PTS doesn't depend on the mode).
//
// RESUMABLE DAY BUILD: a full NBA slate can be 10-15 games = 300-450 active
// players, which is ~80 BALLDONTLIE calls -- well past the Cloudflare Free
// plan's 50-subrequests-per-invocation ceiling. Instead of dropping players
// to fit (the old behavior), each (league, date) build is persisted in KV as
// it goes and resumed by the next request or cron tick until every player
// is loaded. The finished snapshot is published under its own KV key and
// served (fresh for DAY_CACHE_FRESH_MS) to every viewer without re-fetching,
// so on-demand page loads are cheap and no player is ever silently cut.

import {
  simulateHistoricDay,
  buildHistoricDashboard,
  seedHistoric,
  getCurrentHistoricDay,
  setCurrentHistoricDay,
  upsertHistoricObjectivesDay,
  getHistoricStatus,
} from "./historic.js";

const BDL_ROOT = "https://api.balldontlie.io";
const PLAYER_CHUNK_SIZE = 10; // per_page max is 100, so 10 players * 10 games/player = 100 rows
const MAX_SUBREQUESTS = 45; // stay under Cloudflare Free plan's 50 subrequests/invocation ceiling
const RECENT_GAMES_MAX_PAGES = 5; // safety cap on pagination (500 games) to bound subrequest cost
const YTD_MAX_PAGES = 6; // safety cap on season-long game-id pagination for YTD
const DAY_CACHE_FRESH_MS = 30 * 60 * 1000; // a finished day snapshot is served as-is for 30 min
const PAST_DAY_CACHE_FRESH_MS = 6 * 60 * 60 * 1000; // a past date's finals don't move: 6 hours
const ET_TZ = "America/New_York";

// -- Leagues --------------------------------------------------------------------
// Everything that differs between the two live BALLDONTLIE leagues. Add a
// league here (and in the frontend's MODES table) to bring another one online.
const LEAGUES = {
  WNBA: {
    key: "WNBA",
    base: `${BDL_ROOT}/wnba/v1`,
    statsPath: "/player_stats",
    advancedUrl: `${BDL_ROOT}/wnba/v1/player_game_advanced_stats`,
    // Run 11: the post-World-Cup regular-season finish, Day 1 = Sept 17 through
    // Day 8 = Sept 24, 2026 (inclusive). Playoffs (Sept 27+) will be a new run.
    run: { label: "Run 11", start: "2026-09-17", end: "2026-09-24" },
    // Cron refreshes only run while a league is in season (playoffs included).
    seasonActive: { start: "2026-05-01", end: "2026-10-31" },
    // How far back to look for a team's last 10 completed games. WNBA plays
    // roughly every other day, so 45 days comfortably covers 10 games + byes.
    recentLookbackDays: 45,
    // BALLDONTLIE numbers a WNBA season by its calendar year.
    seasonFor: (dateStr) => Number(dateStr.slice(0, 4)),
    homeScore: (g) => (typeof g.home_score === "number" ? g.home_score : null),
    awayScore: (g) => (typeof g.away_score === "number" ? g.away_score : null),
    // Live-confirmed: WNBA uses "pre" / "in" / "post".
    status: (g) => (g.status === "post" || g.status === "in" || g.status === "pre" ? g.status : "pre"),
    minutesPerGame: 40,
    keys: {
      latest: "fastbreak:latest",
      fulldata: "fastbreak:fulldata",
      fulldataBuild: "fastbreak:fulldata:build",
      dayPrefix: "fastbreak:day:",
    },
    noGamesNote: "No WNBA games scheduled on this date.",
  },
  NBA: {
    key: "NBA",
    base: `${BDL_ROOT}/v1`,
    statsPath: "/stats",
    // v2 advanced stats carries points_paint (flat, top-level). GOAT tier.
    advancedUrl: `${BDL_ROOT}/nba/v2/stats/advanced`,
    // Run 1 (2026-27 season): opening night Tue Oct 20 through Mon Oct 26.
    run: { label: "Run 1", start: "2026-10-20", end: "2026-10-26" },
    seasonActive: { start: "2026-10-15", end: "2027-06-30" },
    // At season start there are no current-season games yet, so L10 has to
    // reach back into last season (which ended in June). 240 days covers it.
    recentLookbackDays: 240,
    // BALLDONTLIE numbers an NBA season by its starting year: 2026 = 2026-27.
    seasonFor: (dateStr) => {
      const y = Number(dateStr.slice(0, 4));
      const m = Number(dateStr.slice(5, 7));
      return m >= 8 ? y : y - 1;
    },
    homeScore: (g) => (typeof g.home_team_score === "number" ? g.home_team_score : null),
    awayScore: (g) => (typeof g.visitor_team_score === "number" ? g.visitor_team_score : null),
    // NBA status is a display string ("Final", "1st Qtr", "7:00 pm ET", ...)
    // plus a newer status_state field. Normalize to the WNBA vocabulary.
    status: (g) => {
      const st = String(g.status_state || "").toLowerCase();
      if (st === "final" || st === "post") return "post";
      if (st === "in" || st === "in_progress" || st === "live") return "in";
      if (st === "pre" || st === "scheduled") return "pre";
      const s = String(g.status || "");
      if (/^final/i.test(s)) return "post";
      if (typeof g.period === "number" && g.period > 0) return "in";
      return "pre";
    },
    minutesPerGame: 48,
    keys: {
      latest: "fastbreak:nba:latest",
      fulldata: "fastbreak:nba:fulldata",
      fulldataBuild: "fastbreak:nba:fulldata:build",
      dayPrefix: "fastbreak:nba:day:",
    },
    noGamesNote: "No NBA games scheduled on this date.",
  },
};
const SUPPORTED_LEAGUES = Object.keys(LEAGUES);
const DEFAULT_LEAGUE = "WNBA";
const SUPPORTED_MODES = ["Classic", "Pro"];

function leagueConfig(league) {
  return LEAGUES[league] || LEAGUES[DEFAULT_LEAGUE];
}

function dayNumberForDate(league, dateStr) {
  const start = new Date(`${leagueConfig(league).run.start}T00:00:00Z`);
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((d - start) / 86400000) + 1;
}

function isWithinRun(league, dateStr) {
  const run = leagueConfig(league).run;
  return dateStr >= run.start && dateStr <= run.end;
}

function isSeasonActive(league, dateStr) {
  const s = leagueConfig(league).seasonActive;
  return dateStr >= s.start && dateStr <= s.end;
}

// -- Objective -> stat field mapping ------------------------------------------
// Fields read from the slim per-game rows this Worker stores in its day
// cache (see slimStatRow / slimAdvRow). `source: "stats"` rows come from the
// box-score endpoint; `source: "advanced"` rows come from the advanced-stats
// endpoint (needed for PITP, which isn't a standard box-score stat).
const STAT_FIELD_MAP = {
  PTS: { source: "stats", field: (s) => s.pts, label: "PTS" },
  REB: { source: "stats", field: (s) => s.reb, label: "REB" },
  AST: { source: "stats", field: (s) => s.ast, label: "AST" },
  STL: { source: "stats", field: (s) => s.stl, label: "STL" },
  BLK: { source: "stats", field: (s) => s.blk, label: "BLK" },
  TOV: { source: "stats", field: (s) => s.turnover, label: "TOV" },
  FGM: { source: "stats", field: (s) => s.fgm, label: "FGM" },
  FGA: { source: "stats", field: (s) => s.fga, label: "FGA" },
  "3PM": { source: "stats", field: (s) => s.fg3m, label: "3PM" },
  "3PA": { source: "stats", field: (s) => s.fg3a, label: "3PA" },
  FTM: { source: "stats", field: (s) => s.ftm, label: "FTM" },
  FTA: { source: "stats", field: (s) => s.fta, label: "FTA" },
  OREB: { source: "stats", field: (s) => s.oreb, label: "OREB" },
  PITP: { source: "advanced", field: (a) => a.pitp, label: "PITP" },
};
const BOX_STAT_KEYS = ["pts", "reb", "ast", "stl", "blk", "turnover", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb"];

// Defaults when a date in the run has no admin-set objectives yet.
const DEFAULT_OBJECTIVES = {
  Classic: [{ stat: "PTS", label: "PTS", dailyTeamTarget: 80 }],
  Pro: [{ stat: "PTS", label: "PTS", dailyTeamTarget: 80 }],
};

// -- BALLDONTLIE plumbing ---------------------------------------------------------

function bdlHeaders(env) {
  return { Authorization: env.BALLDONTLIE_API_KEY };
}

async function bdlFetch(url, env) {
  const res = await fetch(url, { headers: bdlHeaders(env) });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`BALLDONTLIE ${url.replace(BDL_ROOT, "")} failed: ${res.status} | body=${bodyText.slice(0, 200)}`);
  }
  return res.json();
}

function leagueFetch(cfg, path, env) {
  return bdlFetch(`${cfg.base}${path}`, env);
}

// -- Dates (Eastern Time, via Intl -- handles the EDT/EST switch) ----------------

function etDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function etHour(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, hour: "numeric", hour12: false }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  return h === 24 ? 0 : h;
}

// "Today" for every build is the ET calendar date, not UTC -- a 9pm CT cron
// tick is already "tomorrow" in UTC and used to build the wrong day.
function todayStr() {
  return etDateStr(new Date());
}

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A game's real ET calendar date from its tip-off datetime. A plain
// YYYY-MM-DD (NBA's `date` field, which is already the ET calendar date) is
// returned as-is rather than being parsed as UTC midnight (which would shift
// it to the previous ET day). Returns null when nothing parseable exists.
function etDateStrForGame(g) {
  const iso = g.datetime || g.date;
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return etDateStr(d);
}

// BUG FIX (verified live 2026-08-22): BALLDONTLIE's `dates[]=` filter buckets
// WNBA games by the UTC calendar date of their actual tip-off time, not by
// the Run's ET calendar date, so a 9-10pm ET game surfaces under the next
// UTC date. Fix: query both UTC dates a full ET day can straddle, then keep
// only games whose real ET calendar date equals dateStr. Applied to both
// leagues -- for NBA (whose `date` is already ET) it is a harmless no-op.
async function getGamesForDate(cfg, dateStr, env) {
  const nextDateStr = addDaysStr(dateStr, 1);
  const [dataA, dataB] = await Promise.all([
    leagueFetch(cfg, `/games?dates[]=${dateStr}&per_page=100`, env),
    leagueFetch(cfg, `/games?dates[]=${nextDateStr}&per_page=100`, env),
  ]);
  const seen = new Set();
  const games = [];
  for (const g of dataA.data || []) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const etDate = etDateStrForGame(g);
    if (etDate == null || etDate === dateStr) games.push(g);
  }
  for (const g of dataB.data || []) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const etDate = etDateStrForGame(g);
    if (etDate === dateStr) games.push(g);
  }
  return games.map((g) => slimGame(cfg, g));
}

// One league-neutral shape for a game, so nothing downstream needs to know
// about home_score vs home_team_score or "post" vs "Final".
function slimGame(cfg, g) {
  return {
    id: g.id,
    date: g.date || null,
    datetime: g.datetime || null,
    season: g.season ?? null,
    status: cfg.status(g),
    homeId: g.home_team?.id ?? null,
    homeAbbr: g.home_team?.abbreviation || "",
    homeName: g.home_team?.full_name || "",
    awayId: g.visitor_team?.id ?? null,
    awayAbbr: g.visitor_team?.abbreviation || "",
    awayName: g.visitor_team?.full_name || "",
    homeScore: cfg.homeScore(g),
    awayScore: cfg.awayScore(g),
  };
}

async function getTeamRosters(cfg, teamIds, env) {
  // Live-confirmed: plain /players returns every player EVER on a team,
  // oldest-first. /players/active returns only currently active players.
  // A 15-game NBA slate is 30 teams * ~17 = ~500 active players, so follow
  // the cursor (capped) instead of trusting one page of 100.
  const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");
  let players = [];
  let cursor = null;
  let requestsUsed = 0;
  for (let page = 0; page < 6; page++) {
    const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
    const data = await leagueFetch(cfg, `/players/active?${qs}&per_page=100${cursorQs}`, env);
    requestsUsed += 1;
    const pageData = data.data || [];
    players = players.concat(pageData);
    const nextCursor = data.meta?.next_cursor;
    if (!nextCursor || pageData.length < 100) break;
    cursor = nextCursor;
  }
  return { players, requestsUsed };
}

// Current injury reports for the teams playing today (ALL-STAR tier). Fails
// soft (empty list) rather than breaking the whole build.
async function getInjuriesForTeams(cfg, teamIds, env) {
  const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");
  try {
    const data = await leagueFetch(cfg, `/player_injuries?${qs}&per_page=100`, env);
    return (data.data || []).map((inj) => ({
      playerId: inj.player?.id ?? null,
      status: inj.status || null,
      note: inj.description || inj.comment || inj.return_date || null,
    }));
  } catch (err) {
    console.error(`player_injuries fetch failed (continuing without injury data): ${err.message}`);
    return [];
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Games in a date window for a set of teams (or leaguewide when teamIds is
// empty). Live-confirmed: returns OLDEST-FIRST and caps at per_page=100, so
// follow meta.next_cursor (capped at maxPages) and sort ourselves.
async function getGamesInWindow(cfg, teamIds, env, { startStr, endStr, maxPages }) {
  const teamQs = teamIds.map((id) => `team_ids[]=${id}`).join("&");
  let games = [];
  let cursor = null;
  let requestsUsed = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
    const data = await leagueFetch(
      cfg,
      `/games?${teamQs ? teamQs + "&" : ""}start_date=${startStr}&end_date=${endStr}&per_page=100${cursorQs}`,
      env
    );
    requestsUsed += 1;
    const pageData = (data.data || []).map((g) => slimGame(cfg, g));
    games = games.concat(pageData);
    const nextCursor = data.meta?.next_cursor;
    if (!nextCursor || pageData.length < 100) {
      cursor = null;
      break;
    }
    cursor = nextCursor;
    if (page === maxPages - 1) truncated = true;
  }

  return { games, requestsUsed, truncated };
}

function gameSortDate(g) {
  return new Date(g.datetime || g.date || 0);
}

// Group by team, sort each team's completed games by date descending, take the
// most recent `n` per team.
function pickLastNGameIdsPerTeam(games, teamIds, n) {
  const byTeam = new Map(teamIds.map((id) => [id, []]));
  for (const g of games) {
    if (g.status !== "post") continue;
    if (g.homeId != null && byTeam.has(g.homeId)) byTeam.get(g.homeId).push(g);
    if (g.awayId != null && byTeam.has(g.awayId)) byTeam.get(g.awayId).push(g);
  }
  const gameIds = new Set();
  for (const [, teamGames] of byTeam) {
    teamGames.sort((a, b) => gameSortDate(b) - gameSortDate(a));
    for (const g of teamGames.slice(0, n)) gameIds.add(g.id);
  }
  return gameIds;
}

function buildQs(parts) {
  return parts.filter(Boolean).join("&");
}

function seasonsQs(seasons) {
  return [...new Set(seasons.filter((s) => s != null))].map((s) => `seasons[]=${s}`).join("&");
}

// Both stat endpoints return rows OLDEST-FIRST and cap at per_page=100. An
// L10-scoped query (10 players x 10 games) always fits one page; a season-
// scoped (YTD) query does not once teams pass 10 games, so it follows the
// cursor up to `maxPages` (see YTD_STAT_PAGES_PER_CHUNK). Returns
// { rows, requestsUsed, truncated }.
async function fetchStatPages(url, env, { maxPages }) {
  let rows = [];
  let cursor = null;
  let requestsUsed = 0;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
    const data = await bdlFetch(`${url}${cursorQs}`, env);
    requestsUsed += 1;
    const pageData = data.data || [];
    rows = rows.concat(pageData);
    const nextCursor = data.meta?.next_cursor;
    if (!nextCursor || pageData.length < 100) break;
    cursor = nextCursor;
    if (page === maxPages - 1) truncated = true;
  }
  return { rows, requestsUsed, truncated };
}

function getStatsForChunk(cfg, playerIds, seasons, gameIds, env, { maxPages = 1 } = {}) {
  const playerQs = playerIds.map((id) => `player_ids[]=${id}`).join("&");
  const gameQs = [...gameIds].map((id) => `game_ids[]=${id}`).join("&");
  const qs = buildQs([playerQs, seasonsQs(seasons), gameQs, "per_page=100"]);
  return fetchStatPages(`${cfg.base}${cfg.statsPath}?${qs}`, env, { maxPages });
}

function getAdvancedForChunk(cfg, playerIds, seasons, gameIds, env, { maxPages = 1 } = {}) {
  const playerQs = playerIds.map((id) => `player_ids[]=${id}`).join("&");
  const gameQs = [...gameIds].map((id) => `game_ids[]=${id}`).join("&");
  // period=0 = full game, avoids duplicate rows from quarter-level breakdowns.
  const qs = buildQs([playerQs, seasonsQs(seasons), gameQs, "period=0", "per_page=100"]);
  return fetchStatPages(`${cfg.advancedUrl}?${qs}`, env, { maxPages });
}

// Pages allowed per YTD-scoped stats query per 10-player chunk: 3 pages = 300
// rows = 10 players x 30 games. Past that (deep into an NBA season) YTD is
// best-effort from the earliest games in the window and the payload says so.
const YTD_STAT_PAGES_PER_CHUNK = 3;

// Slim per-game rows stored in the day cache. Keeping only the numbers we
// use keeps a 450-player NBA day well under KV's value size limit.
function slimStatRow(row) {
  const out = {
    gid: row.game?.id ?? row.game_id,
    date: row.game?.date || null,
  };
  for (const k of BOX_STAT_KEYS) out[k] = typeof row[k] === "number" ? row[k] : null;
  return out;
}

function slimAdvRow(row) {
  // WNBA: stats.misc.points_paint. NBA v2: flat points_paint.
  const pitp = row.points_paint ?? row.stats?.misc?.points_paint ?? row.misc?.points_paint;
  return {
    gid: row.game?.id ?? row.game_id,
    date: row.game?.date || null,
    pitp: typeof pitp === "number" ? pitp : null,
  };
}

function average(nums) {
  const clean = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

// Defensive: sort a player's rows by game date descending and cap at `n`
// before averaging, never trusting API default ordering.
function lastNByDate(lines, n) {
  return [...lines].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, n);
}

// -- Full Data (leaguewide L10/YTD for every active player) -------------------
// Resumes across scheduled ticks, persisting progress in KV, and only
// replaces the published cache once a full pass finishes. Per league.
const FULLDATA_REBUILD_INTERVAL_MS = 20 * 60 * 60 * 1000; // rebuild roughly once/day
const FULLDATA_ROSTER_MAX_PAGES = 6; // 6 * 100 = room for an NBA-sized active pool
const FULLDATA_STAT_CODES = Object.keys(STAT_FIELD_MAP).filter((code) => STAT_FIELD_MAP[code].source === "stats");
const TEAM_BOX_CODES = ["REB", "OREB", "AST", "STL", "BLK", "TOV", "FGM", "FGA", "3PM", "3PA"];

async function getAllActivePlayers(cfg, env, { maxPages }) {
  let players = [];
  let cursor = null;
  let requestsUsed = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
    const data = await leagueFetch(cfg, `/players/active?per_page=100${cursorQs}`, env);
    requestsUsed += 1;
    const pageData = data.data || [];
    players = players.concat(pageData);
    const nextCursor = data.meta?.next_cursor;
    if (!nextCursor || pageData.length < 100) {
      cursor = null;
      break;
    }
    cursor = nextCursor;
    if (page === maxPages - 1) truncated = true;
  }

  return { players, requestsUsed, truncated };
}

// Each team's PPG/PAPG from completed games in the window -- no extra calls.
function computeTeamScoring(games) {
  const byTeam = new Map();
  for (const g of games) {
    if (g.status !== "post") continue;
    if (typeof g.homeScore !== "number" || typeof g.awayScore !== "number") continue;
    if (g.homeId != null) {
      if (!byTeam.has(g.homeId)) byTeam.set(g.homeId, { abbr: g.homeAbbr, name: g.homeName, ptsFor: [], ptsAgainst: [] });
      byTeam.get(g.homeId).ptsFor.push(g.homeScore);
      byTeam.get(g.homeId).ptsAgainst.push(g.awayScore);
    }
    if (g.awayId != null) {
      if (!byTeam.has(g.awayId)) byTeam.set(g.awayId, { abbr: g.awayAbbr, name: g.awayName, ptsFor: [], ptsAgainst: [] });
      byTeam.get(g.awayId).ptsFor.push(g.awayScore);
      byTeam.get(g.awayId).ptsAgainst.push(g.homeScore);
    }
  }
  const result = {};
  for (const [, t] of byTeam) {
    result[t.abbr] = {
      team: t.name,
      gamesPlayed: t.ptsFor.length,
      ppg: round1(average(t.ptsFor)),
      papg: round1(average(t.ptsAgainst)),
    };
  }
  return result;
}

async function loadJSON(env, key, fallback = null) {
  const raw = await env.FASTBREAK_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJSON(env, key, value) {
  await env.FASTBREAK_KV.put(key, JSON.stringify(value));
}

async function advanceFullDataBuild(env, league, budget) {
  const cfg = leagueConfig(league);
  if (budget < 4) return { advanced: false, reason: "budget too small this tick" };

  let state = await loadJSON(env, cfg.keys.fulldataBuild);
  let used = 0;

  const isStale = state?.status === "done" && Date.now() - (state.finishedAt || 0) > FULLDATA_REBUILD_INTERVAL_MS;
  const needsFreshStart = !state || state.status !== "building";

  if (needsFreshStart) {
    if (state?.status === "done" && !isStale) {
      return { advanced: false, reason: "last build is still fresh" };
    }

    const setupCeiling = FULLDATA_ROSTER_MAX_PAGES + RECENT_GAMES_MAX_PAGES + YTD_MAX_PAGES;
    if (budget < setupCeiling) {
      return { advanced: false, reason: `budget too small to start a fresh build (need ~${setupCeiling})` };
    }

    const rosterResult = await getAllActivePlayers(cfg, env, { maxPages: FULLDATA_ROSTER_MAX_PAGES });
    used += rosterResult.requestsUsed;

    const today = todayStr();
    const season = cfg.seasonFor(today);
    const recentResult = await getGamesInWindow(cfg, [], env, {
      startStr: addDaysStr(today, -cfg.recentLookbackDays),
      endStr: today,
      maxPages: RECENT_GAMES_MAX_PAGES,
    });
    used += recentResult.requestsUsed;

    const ytdResult = await getGamesInWindow(cfg, [], env, {
      startStr: seasonStartStr(cfg, season),
      endStr: today,
      maxPages: YTD_MAX_PAGES,
    });
    used += ytdResult.requestsUsed;

    const teamIds = [...new Set(rosterResult.players.map((p) => p.team?.id).filter((id) => id != null))];
    const last10GameIds = [...pickLastNGameIdsPerTeam(recentResult.games, teamIds, 10)];
    const ytdGameIds = [...new Set(ytdResult.games.filter((g) => g.status === "post").map((g) => g.id))];
    const teamScoring = computeTeamScoring(ytdResult.games);
    const seasons = [...new Set([...recentResult.games, ...ytdResult.games].map((g) => g.season).filter((s) => s != null))];

    const rosterById = {};
    for (const p of rosterResult.players) {
      rosterById[p.id] = { id: p.id, name: `${p.first_name} ${p.last_name}`, team: p.team?.abbreviation || "" };
    }
    const playerIds = Object.keys(rosterById).map(Number);

    state = {
      status: "building",
      league,
      season,
      seasons: seasons.length ? seasons : [season],
      startedAt: Date.now(),
      rosterById,
      last10GameIds,
      ytdGameIds,
      teamScoring,
      pendingChunks: chunk(playerIds, PLAYER_CHUNK_SIZE),
      results: {},
      teamBoxSums: {},
      truncatedRoster: rosterResult.truncated,
      truncatedRecent: recentResult.truncated,
      truncatedYtd: ytdResult.truncated,
    };
  }

  const remaining = budget - used;
  const last10Set = new Set(state.last10GameIds);
  const ytdSet = new Set(state.ytdGameIds);
  // Early in a season YTD is a subset of L10, so one query covers both.
  const ytdIsSubset = [...ytdSet].every((id) => last10Set.has(id));
  const perChunk = ytdIsSubset ? 1 : 1 + YTD_STAT_PAGES_PER_CHUNK;
  const chunksThisTick = Math.max(0, Math.floor(remaining / perChunk));

  let processedChunks = 0;
  while (processedChunks < chunksThisTick && state.pendingChunks.length > 0) {
    const c = state.pendingChunks.shift();
    const recentRes = await getStatsForChunk(cfg, c, state.seasons, last10Set, env);
    used += recentRes.requestsUsed;
    const recentStats = recentRes.rows.map((r) => ({ pid: r.player?.id, ...slimStatRow(r) }));
    let ytdStats = [];
    if (!ytdIsSubset) {
      const ytdRes = await getStatsForChunk(cfg, c, state.seasons, ytdSet, env, { maxPages: YTD_STAT_PAGES_PER_CHUNK });
      used += ytdRes.requestsUsed;
      if (ytdRes.truncated) state.truncatedYtdStats = true;
      ytdStats = ytdRes.rows.map((r) => ({ pid: r.player?.id, ...slimStatRow(r) }));
    }

    const byPlayer = new Map();
    for (const row of [...recentStats, ...ytdStats]) {
      if (!byPlayer.has(row.pid)) byPlayer.set(row.pid, new Map());
      byPlayer.get(row.pid).set(row.gid, row);
    }

    for (const pid of c) {
      const player = state.rosterById[pid];
      if (!player) continue;
      const rows = [...(byPlayer.get(pid)?.values() || [])];
      const l10Rows = lastNByDate(rows.filter((r) => last10Set.has(r.gid)), 10);
      const ytdRows = rows.filter((r) => ytdSet.has(r.gid));
      const stats = {};
      for (const code of FULLDATA_STAT_CODES) {
        const def = STAT_FIELD_MAP[code];
        const valueOf = (row) => {
          const v = def.field(row);
          return typeof v === "number" ? v : null;
        };
        stats[code] = {
          l10: round1(average(l10Rows.map(valueOf))),
          ytd: round1(average(ytdRows.map(valueOf))),
          gamesPlayedL10: l10Rows.length,
        };
      }
      state.results[pid] = { id: pid, name: player.name, team: player.team, stats };

      if (player.team) {
        if (!state.teamBoxSums[player.team]) {
          state.teamBoxSums[player.team] = { REB: 0, OREB: 0, AST: 0, STL: 0, BLK: 0, TOV: 0, FGM: 0, FGA: 0, "3PM": 0, "3PA": 0 };
        }
        const sums = state.teamBoxSums[player.team];
        for (const code of TEAM_BOX_CODES) {
          const def = STAT_FIELD_MAP[code];
          for (const row of ytdRows) {
            const v = def.field(row);
            if (typeof v === "number") sums[code] += v;
          }
        }
      }
    }

    processedChunks += 1;
  }

  const finished = state.pendingChunks.length === 0;
  if (finished) {
    const players = Object.values(state.results).sort((a, b) => a.name.localeCompare(b.name));

    const teamsDetail = {};
    for (const [abbr, scoring] of Object.entries(state.teamScoring)) {
      const sums = state.teamBoxSums[abbr] || { REB: 0, OREB: 0, AST: 0, STL: 0, BLK: 0, TOV: 0, FGM: 0, FGA: 0, "3PM": 0, "3PA": 0 };
      const gp = scoring.gamesPlayed || 0;
      const perGame = (code) => (gp > 0 ? round1(sums[code] / gp) : null);
      teamsDetail[abbr] = {
        team: scoring.team,
        gamesPlayed: gp,
        ppg: scoring.ppg,
        papg: scoring.papg,
        reb: perGame("REB"),
        oreb: perGame("OREB"),
        ast: perGame("AST"),
        stl: perGame("STL"),
        blk: perGame("BLK"),
        tov: perGame("TOV"),
        fgm: perGame("FGM"),
        fga: perGame("FGA"),
        fgPct: sums.FGA > 0 ? round1((sums.FGM / sums.FGA) * 100) : null,
        fg3m: perGame("3PM"),
        fg3a: perGame("3PA"),
        fg3Pct: sums["3PA"] > 0 ? round1((sums["3PM"] / sums["3PA"]) * 100) : null,
      };
    }

    const payload = {
      dashboard_name: "Fast Break Full Data",
      league,
      season: state.season,
      generated_at: new Date().toISOString(),
      statCodes: FULLDATA_STAT_CODES,
      teams: state.teamScoring,
      teamsDetail,
      players,
      note:
        `Leaguewide L10/YTD for every active ${league} player across all Fast Break-relevant box-score stats. PITP is intentionally excluded here (it lives under a separate advanced-stats endpoint) to stay within the BALLDONTLIE subrequest budget across the full roster. L10 reaches back into the prior season when the current one has fewer than 10 games played; YTD is the current season only. Team PPG/PAPG are computed directly from this season's final scores.` +
        (state.truncatedRoster ? " NOTE: roster pagination hit its safety cap; some players may be missing." : "") +
        (state.truncatedRecent || state.truncatedYtd ? " NOTE: league game-window pagination hit its safety cap; some players' windows may be incomplete." : "") +
        (state.truncatedYtdStats ? " NOTE: YTD for some players is based on the earliest games of the season only (stat pagination cap)." : ""),
    };
    await saveJSON(env, cfg.keys.fulldata, payload);
    state = { status: "done", league, finishedAt: Date.now() };
  }

  await saveJSON(env, cfg.keys.fulldataBuild, state);
  return { advanced: true, finished, chunksProcessed: processedChunks, subrequestsUsed: used };
}

// The first calendar day of a numbered season, for YTD windows. NBA seasons
// start in the fall of their numbering year; WNBA seasons are one calendar year.
function seasonStartStr(cfg, season) {
  return cfg.key === "NBA" ? `${season}-09-01` : `${season}-01-01`;
}

// -- Objectives schedule (admin-managed, stored in KV) ------------------------
// Shape: { [league]: { [date]: { objectives: { Classic: [...], Pro: [...] },
//   badgeSetName, projections: { [stat]: { [normalizedName]: {name, value} } } } } }
// Objectives are per mode; projections are per league/date (shared by
// Classic and Pro -- a player's projected PTS doesn't depend on the mode).

const OBJECTIVES_KV_KEY = "fastbreak:objectives";

async function loadObjectivesSchedule(env) {
  return (await loadJSON(env, OBJECTIVES_KV_KEY, {})) || {};
}

function validateObjectives(objectives) {
  if (!Array.isArray(objectives) || objectives.length < 1 || objectives.length > 2) {
    throw new Error("objectives must be an array of 1 or 2 entries");
  }
  for (const o of objectives) {
    if (!o.stat || !STAT_FIELD_MAP[o.stat]) {
      throw new Error(`unknown stat code: ${o.stat}`);
    }
    if (typeof o.dailyTeamTarget !== "number" || o.dailyTeamTarget <= 0) {
      throw new Error(`dailyTeamTarget must be a positive number for ${o.stat}`);
    }
  }
}

function validateLeague(league) {
  if (!SUPPORTED_LEAGUES.includes(league)) throw new Error(`league must be one of ${SUPPORTED_LEAGUES.join(", ")}`);
}

// Auto-computed weighting: for a 2-objective day, the objective with FEWER
// players projected at >=100% of their per-player target gets the HIGHER
// weight. A single-objective day is always weight 1.
function computeAutoWeights(objectives, playerBase) {
  if (objectives.length === 1) {
    return [{ ...objectives[0], weight: 1 }];
  }
  const total = playerBase.length || 1;
  const fractions = objectives.map((o) => {
    const hit = playerBase.filter((p) => {
      const tier = p.objectives[o.stat]?.colorProj;
      return tier === "dark-green" || tier === "light-green";
    }).length;
    return hit / total;
  });
  const epsilon = 1 / (2 * total);
  const raw = fractions.map((f) => 1 / Math.max(f, epsilon));
  const sum = raw[0] + raw[1];
  return objectives.map((o, i) => ({ ...o, weight: raw[i] / sum, _hitFraction: fractions[i] }));
}

// -- Projections (manual, Rotowire-sourced where available) ------------------
// PITP is the one confirmed exception -- Rotowire doesn't project it, so it
// always falls back to the L10 average. Every other stat with no uploaded
// override shows Proj as TBD rather than silently defaulting to L10.
function normalizePlayerName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function upsertProjections(env, { league, date, stat, projections }) {
  validateLeague(league);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("date must be YYYY-MM-DD");
  if (!stat || !STAT_FIELD_MAP[stat]) throw new Error(`unknown stat code: ${stat}`);
  if (!Array.isArray(projections) || !projections.length) {
    throw new Error("projections must be a non-empty array of {name, value}");
  }
  const values = {};
  for (const p of projections) {
    if (!p || !p.name || typeof p.value !== "number" || Number.isNaN(p.value)) {
      throw new Error(`each projection needs a name and a numeric value (got ${JSON.stringify(p)})`);
    }
    values[normalizePlayerName(p.name)] = { name: p.name, value: p.value };
  }

  const schedule = await loadObjectivesSchedule(env);
  if (!schedule[league]) schedule[league] = {};
  if (!schedule[league][date]) schedule[league][date] = { objectives: {} };
  if (!schedule[league][date].projections) schedule[league][date].projections = {};
  schedule[league][date].projections[stat] = values;
  await saveJSON(env, OBJECTIVES_KV_KEY, schedule);
  return schedule;
}

function projectionsForDate(schedule, league, date, stat) {
  return schedule?.[league]?.[date]?.projections?.[stat] || null;
}

async function upsertObjectivesDay(env, { league, date, mode, objectives, badgeSetName }) {
  validateLeague(league);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("date must be YYYY-MM-DD");
  if (!SUPPORTED_MODES.includes(mode)) throw new Error(`mode must be one of ${SUPPORTED_MODES.join(", ")}`);
  validateObjectives(objectives);

  const schedule = await loadObjectivesSchedule(env);
  if (!schedule[league]) schedule[league] = {};
  const existing = schedule[league][date] || {};
  const existingObjectives = existing.objectives || {};
  const cleanObjectives = objectives.map(({ stat, label, dailyTeamTarget }) => ({
    stat,
    label: label || stat,
    dailyTeamTarget,
  }));
  schedule[league][date] = {
    ...existing,
    objectives: { ...existingObjectives, [mode]: cleanObjectives },
    badgeSetName: mode === "Pro" && badgeSetName ? badgeSetName : existing.badgeSetName || null,
  };
  await saveJSON(env, OBJECTIVES_KV_KEY, schedule);
  return schedule;
}

function objectivesForDate(schedule, league, date, mode) {
  const entry = schedule?.[league]?.[date];
  const list = entry?.objectives?.[mode];
  if (list && list.length) return list.map((o) => ({ ...o }));
  return DEFAULT_OBJECTIVES[mode].map((o) => ({ ...o }));
}

function badgeSetNameForDate(schedule, league, date) {
  return schedule?.[league]?.[date]?.badgeSetName || null;
}

// -- Ranking + color tiers -----------------------------------------------------

// Standard competition ranking (1224-style).
function rankDescending(values) {
  const withValue = values.filter((v) => v.value != null);
  const withoutValue = values.filter((v) => v.value == null);
  withValue.sort((a, b) => b.value - a.value);

  const ranks = new Map();
  let rank = 0;
  let prevValue = null;
  withValue.forEach((v, i) => {
    if (prevValue === null || v.value !== prevValue) {
      rank = i + 1;
      prevValue = v.value;
    }
    ranks.set(v.id, rank);
  });
  const worstRank = withValue.length + 1;
  withoutValue.forEach((v) => ranks.set(v.id, worstRank));
  return ranks;
}

// >=125% dark green, >=100% light green, >=90% yellow, >=75% light yellow, else none.
function colorTier(value, perPlayerTarget) {
  if (value == null || !perPlayerTarget) return null;
  const pct = value / perPlayerTarget;
  if (pct >= 1.25) return "dark-green";
  if (pct >= 1.0) return "light-green";
  if (pct >= 0.9) return "yellow";
  if (pct >= 0.75) return "light-yellow";
  return null;
}

// -- Schedule tiles -------------------------------------------------------------

function formatGameTime(game) {
  if (game.status === "post") return "Final";
  if (game.status === "in") return "In Progress";
  const iso = game.datetime;
  if (!iso) return "TBD";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "TBD";
    const etStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: ET_TZ });
    const utcStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC", hour12: false });
    return `${etStr} ET (${utcStr} UTC)`;
  } catch {
    return "TBD";
  }
}

function buildScheduleTiles(games) {
  return games.map((g) => ({
    id: g.id,
    awayAbbr: g.awayAbbr,
    awayName: g.awayName,
    homeAbbr: g.homeAbbr,
    homeName: g.homeName,
    time: formatGameTime(g),
    status: g.status || "pre",
    awayScore: g.awayScore,
    homeScore: g.homeScore,
  }));
}

// L10 advanced team metrics (ORtg/DRtg/Pace/eFG%/TOV%/OREB%(est.)/record) for
// the day's playing teams, from data the build already holds -- zero extra
// BALLDONTLIE calls. Possessions estimated per game (FGA - OREB + TOV +
// 0.44*FTA). OREB% is approximated as OREB / (FGA - FGM) and labeled "(est.)".
// Pace is raw estimated possessions per game (not per-48/per-40).
function computeTeamAdvancedMetrics(teamIds, roster, statsByPlayer, recentGames, last10GameIds) {
  const result = {};
  const rosterByTeam = new Map();
  for (const p of roster) {
    const tid = p.teamId;
    if (tid == null) continue;
    if (!rosterByTeam.has(tid)) rosterByTeam.set(tid, []);
    rosterByTeam.get(tid).push(p.id);
  }

  for (const teamId of teamIds) {
    const teamGames = recentGames
      .filter((g) => g.status === "post" && last10GameIds.has(g.id) && (g.homeId === teamId || g.awayId === teamId))
      .sort((a, b) => gameSortDate(b) - gameSortDate(a))
      .slice(0, 10);

    if (teamGames.length === 0) continue;

    const abbr = teamGames[0].homeId === teamId ? teamGames[0].homeAbbr : teamGames[0].awayAbbr;
    const teamPlayerIds = rosterByTeam.get(teamId) || [];

    let sumTeamPts = 0;
    let sumOppPts = 0;
    let sumPoss = 0;
    let sumFGM = 0;
    let sumFGA = 0;
    let sumFG3M = 0;
    let sumOREB = 0;
    let sumTOV = 0;
    let wins = 0;
    let losses = 0;
    let gamesCounted = 0;

    for (const g of teamGames) {
      if (typeof g.homeScore !== "number" || typeof g.awayScore !== "number") continue;
      const isHome = g.homeId === teamId;
      const teamPts = isHome ? g.homeScore : g.awayScore;
      const oppPts = isHome ? g.awayScore : g.homeScore;

      let gFGM = 0;
      let gFGA = 0;
      let gFG3M = 0;
      let gOREB = 0;
      let gTOV = 0;
      let gFTA = 0;
      for (const pid of teamPlayerIds) {
        const row = statsByPlayer[pid]?.[g.id];
        if (!row) continue;
        if (typeof row.fgm === "number") gFGM += row.fgm;
        if (typeof row.fga === "number") gFGA += row.fga;
        if (typeof row.fg3m === "number") gFG3M += row.fg3m;
        if (typeof row.oreb === "number") gOREB += row.oreb;
        if (typeof row.turnover === "number") gTOV += row.turnover;
        if (typeof row.fta === "number") gFTA += row.fta;
      }
      const gPoss = gFGA - gOREB + gTOV + 0.44 * gFTA;

      sumTeamPts += teamPts;
      sumOppPts += oppPts;
      sumPoss += gPoss;
      sumFGM += gFGM;
      sumFGA += gFGA;
      sumFG3M += gFG3M;
      sumOREB += gOREB;
      sumTOV += gTOV;
      gamesCounted += 1;
      if (teamPts > oppPts) wins += 1;
      else if (teamPts < oppPts) losses += 1;
    }

    if (gamesCounted === 0) continue;

    const missedFG = sumFGA - sumFGM;
    result[abbr] = {
      gamesPlayed: gamesCounted,
      l10Ppg: round1(sumTeamPts / gamesCounted),
      l10Papg: round1(sumOppPts / gamesCounted),
      offRtg: sumPoss > 0 ? round1((100 * sumTeamPts) / sumPoss) : null,
      defRtg: sumPoss > 0 ? round1((100 * sumOppPts) / sumPoss) : null,
      pace: round1(sumPoss / gamesCounted),
      efgPct: sumFGA > 0 ? round1(((sumFGM + 0.5 * sumFG3M) / sumFGA) * 100) : null,
      tovPct: sumPoss > 0 ? round1((sumTOV / sumPoss) * 100) : null,
      orebPctEst: missedFG > 0 ? round1((sumOREB / missedFG) * 100) : null,
      record: `${wins}-${losses}`,
    };
  }

  return result;
}

// -- Day build (resumable, cached per league + date) ----------------------------
//
// KV keys (per league, see LEAGUES[].keys.dayPrefix):
//   <dayPrefix><date>         published, finished snapshot of raw inputs
//   <dayPrefix><date>:build   in-progress state (pending player chunks etc.)
//
// The snapshot holds league-neutral raw inputs (games, roster, injuries,
// slim per-game stat rows) rather than a rendered payload, so one snapshot
// serves both Classic and Pro -- the mode only changes which objectives are
// applied on top (renderDayPayload below), which is pure computation.

function dayKey(cfg, date) {
  return `${cfg.keys.dayPrefix}${date}`;
}
function dayBuildKey(cfg, date) {
  return `${cfg.keys.dayPrefix}${date}:build`;
}

// Does any mode's objective set for this date need the advanced endpoint?
// Decided once per snapshot so it can serve both modes.
function dateNeedsAdvanced(schedule, league, date) {
  return SUPPORTED_MODES.some((mode) =>
    objectivesForDate(schedule, league, date, mode).some((o) => STAT_FIELD_MAP[o.stat]?.source === "advanced")
  );
}

function snapshotIsFresh(snapshot, date) {
  if (!snapshot || snapshot.status !== "done") return false;
  const age = Date.now() - (snapshot.finishedAt || 0);
  const ttl = date < todayStr() ? PAST_DAY_CACHE_FRESH_MS : DAY_CACHE_FRESH_MS;
  return age < ttl;
}

// Starts a fresh build state for (league, date): the day's games, both
// rosters, injuries, and the L10/YTD game-id windows. Costs ~5-15 calls.
async function startDayBuild(cfg, env, { date, schedule }) {
  let subrequests = 0;
  const today = todayStr();
  const games = await getGamesForDate(cfg, date, env);
  subrequests += 2;

  const teamIds = [...new Set(games.flatMap((g) => [g.homeId, g.awayId]).filter((id) => id != null))];
  const state = {
    status: "building",
    league: cfg.key,
    date,
    startedAt: Date.now(),
    games,
    teamIds,
    roster: [],
    injuries: [],
    last10GameIds: [],
    ytdGameIds: [],
    seasons: [cfg.seasonFor(date)],
    recentGames: [],
    needsAdvanced: dateNeedsAdvanced(schedule, cfg.key, date),
    pendingChunks: [],
    stats: {},
    adv: {},
    truncatedRecent: false,
    truncatedYtd: false,
    subrequestsUsed: 0,
    totalPlayers: 0,
  };

  if (teamIds.length === 0) {
    state.subrequestsUsed = subrequests;
    return state;
  }

  const rosterResult = await getTeamRosters(cfg, teamIds, env);
  subrequests += rosterResult.requestsUsed;
  state.roster = rosterResult.players.map((p) => ({
    id: p.id,
    name: `${p.first_name} ${p.last_name}`,
    teamId: p.team?.id ?? null,
    team: p.team?.abbreviation || "",
  }));
  state.injuries = await getInjuriesForTeams(cfg, teamIds, env);
  subrequests += 1;

  // Last-10 / YTD windows are always computed relative to the REAL today
  // (current known form), regardless of which run date is being viewed.
  const recentResult = await getGamesInWindow(cfg, teamIds, env, {
    startStr: addDaysStr(today, -cfg.recentLookbackDays),
    endStr: today,
    maxPages: RECENT_GAMES_MAX_PAGES,
  });
  subrequests += recentResult.requestsUsed;
  const last10GameIds = pickLastNGameIdsPerTeam(recentResult.games, teamIds, 10);

  const season = cfg.seasonFor(today);
  const ytdResult = await getGamesInWindow(cfg, teamIds, env, {
    startStr: seasonStartStr(cfg, season),
    endStr: today,
    maxPages: YTD_MAX_PAGES,
  });
  subrequests += ytdResult.requestsUsed;
  const ytdGameIds = new Set(ytdResult.games.filter((g) => g.status === "post").map((g) => g.id));

  state.last10GameIds = [...last10GameIds];
  state.ytdGameIds = [...ytdGameIds];
  state.seasons = [...new Set([season, ...recentResult.games.map((g) => g.season), ...ytdResult.games.map((g) => g.season)].filter((s) => s != null))];
  state.recentGames = recentResult.games.filter((g) => last10GameIds.has(g.id));
  state.truncatedRecent = recentResult.truncated;
  state.truncatedYtd = ytdResult.truncated;
  const playerIds = [...new Set(state.roster.map((p) => p.id))];
  state.totalPlayers = playerIds.length;
  state.pendingChunks = chunk(playerIds, PLAYER_CHUNK_SIZE);
  state.subrequestsUsed = subrequests;
  return state;
}

// Works through pending player chunks with the given call budget. Two
// narrower queries per chunk (L10-scoped, YTD-scoped) rather than one
// season-wide one, because the API returns rows OLDEST-FIRST and caps at 100
// per page -- see the 2026-08-21 bug note in the repo history. When YTD is a
// subset of L10 (early season), one query covers both.
async function advanceDayBuild(cfg, env, state, budget) {
  let used = 0;
  const last10Set = new Set(state.last10GameIds);
  const ytdSet = new Set(state.ytdGameIds);
  const ytdIsSubset = [...ytdSet].every((id) => last10Set.has(id));
  // Worst-case calls per chunk: L10 page + YTD pages, doubled when PITP needs
  // the advanced endpoint too. Early in a season YTD is a subset of L10, so
  // the YTD queries are skipped entirely.
  const perChunk = (ytdIsSubset ? 1 : 1 + YTD_STAT_PAGES_PER_CHUNK) * (state.needsAdvanced ? 2 : 1);

  while (state.pendingChunks.length > 0 && used + perChunk <= budget) {
    const c = state.pendingChunks[0];
    const scopes = ytdIsSubset ? [[last10Set, 1]] : [[last10Set, 1], [ytdSet, YTD_STAT_PAGES_PER_CHUNK]];
    for (const [scope, maxPages] of scopes) {
      const statRes = await getStatsForChunk(cfg, c, state.seasons, scope, env, { maxPages });
      used += statRes.requestsUsed;
      if (statRes.truncated) state.truncatedYtdStats = true;
      for (const r of statRes.rows) {
        const pid = r.player?.id ?? r.player_id;
        if (pid == null) continue;
        if (!state.stats[pid]) state.stats[pid] = {};
        const slim = slimStatRow(r);
        state.stats[pid][slim.gid] = slim;
      }
      if (state.needsAdvanced) {
        try {
          const advRes = await getAdvancedForChunk(cfg, c, state.seasons, scope, env, { maxPages });
          used += advRes.requestsUsed - 1;
          for (const r of advRes.rows) {
            const pid = r.player?.id ?? r.player_id;
            if (pid == null) continue;
            if (!state.adv[pid]) state.adv[pid] = {};
            const slim = slimAdvRow(r);
            state.adv[pid][slim.gid] = slim;
          }
        } catch (err) {
          // PITP needs a higher BALLDONTLIE tier on the NBA side; fail soft
          // (PITP shows "--") rather than sinking the whole build.
          state.advancedError = err.message;
        }
        used += 1;
      }
    }
    state.pendingChunks.shift();
  }

  state.subrequestsUsed = (state.subrequestsUsed || 0) + used;
  if (state.pendingChunks.length === 0) {
    state.status = "done";
    state.finishedAt = Date.now();
  }
  return used;
}

// Pure: turns a snapshot (finished or partial) plus the requested mode's
// objectives into the dashboard payload the frontend renders.
function renderDayPayload(cfg, snapshot, { mode, schedule }) {
  const league = cfg.key;
  const date = snapshot.date;
  const objectives = objectivesForDate(schedule, league, date, mode);
  const badgeSetName = mode === "Pro" ? badgeSetNameForDate(schedule, league, date) : null;
  const building = snapshot.status !== "done";
  const loadedPlayers = snapshot.totalPlayers - snapshot.pendingChunks.reduce((n, c) => n + c.length, 0);

  const baseReturn = {
    dashboard_name: "Fast Break Dashboard",
    league,
    mode,
    date,
    dayNumber: dayNumberForDate(league, date),
    runLength: dayNumberForDate(league, cfg.run.end),
    runLabel: cfg.run.label,
    last_updated: todayStr(),
    objectives,
    badgeSetName,
    games: buildScheduleTiles(snapshot.games),
    building,
    progress: { loaded: loadedPlayers, total: snapshot.totalPlayers },
  };

  if (!snapshot.teamIds.length) {
    return { ...baseReturn, note: cfg.noGamesNote, players: [], teamAdvanced: {} };
  }

  const opponentByTeam = new Map();
  for (const g of snapshot.games) {
    if (g.homeId != null) opponentByTeam.set(g.homeId, `vs ${g.awayAbbr}`);
    if (g.awayId != null) opponentByTeam.set(g.awayId, `@ ${g.homeAbbr}`);
  }
  const last10Set = new Set(snapshot.last10GameIds);
  const ytdSet = new Set(snapshot.ytdGameIds);
  const injuryByPlayerId = new Map(snapshot.injuries.map((inj) => [inj.playerId, inj]));
  const pendingIds = new Set(snapshot.pendingChunks.flat());

  const projectionOverrides = {};
  for (const obj of objectives) {
    projectionOverrides[obj.stat] = projectionsForDate(schedule, league, date, obj.stat) || {};
  }

  const playerBase = snapshot.roster
    .filter((p) => !pendingIds.has(p.id))
    .map((p) => {
      const nameKey = normalizePlayerName(p.name);
      const objectiveValues = {};
      for (const obj of objectives) {
        const def = STAT_FIELD_MAP[obj.stat];
        const rowsByGame = (def.source === "advanced" ? snapshot.adv[p.id] : snapshot.stats[p.id]) || {};
        const lines = Object.values(rowsByGame);
        const l10Lines = lastNByDate(lines.filter((l) => last10Set.has(l.gid)), 10);
        const ytdLines = lines.filter((l) => ytdSet.has(l.gid));
        const statValue = (line) => {
          const v = def.field(line);
          return typeof v === "number" ? v : null;
        };
        const l10 = round1(average(l10Lines.map(statValue)));
        const ytd = round1(average(ytdLines.map(statValue)));

        const override = projectionOverrides[obj.stat]?.[nameKey];
        let proj;
        let projSource;
        if (override != null) {
          proj = round1(override.value);
          projSource = "rotowire";
        } else if (obj.stat === "PITP") {
          proj = l10;
          projSource = "l10-fallback";
        } else {
          proj = null;
          projSource = "tbd";
        }

        const perPlayerTarget = obj.dailyTeamTarget / 5;
        objectiveValues[obj.stat] = {
          stat: obj.stat,
          label: obj.label || obj.stat,
          dailyTeamTarget: obj.dailyTeamTarget,
          perPlayerTarget: round1(perPlayerTarget),
          proj,
          projSource,
          ytd,
          l10,
          gamesPlayedL10: l10Lines.length,
          colorProj: colorTier(proj, perPlayerTarget),
          colorYtd: colorTier(ytd, perPlayerTarget),
          colorL10: colorTier(l10, perPlayerTarget),
        };
      }
      const injury = injuryByPlayerId.get(p.id);
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        opp: opponentByTeam.get(p.teamId) || "",
        injuryStatus: injury?.status || null,
        injuryNote: injury?.note || null,
        objectives: objectiveValues,
      };
    });

  const weightedObjectives = computeAutoWeights(objectives, playerBase);
  for (const p of playerBase) {
    for (const wo of weightedObjectives) {
      if (p.objectives[wo.stat]) p.objectives[wo.stat].weight = wo.weight;
    }
  }

  // Weighted Ovr Rank: rank within each objective by Proj (desc), combine
  // ranks by the day's auto-computed weights. Lower combined score = better.
  const rankMaps = weightedObjectives.map((obj) =>
    rankDescending(playerBase.map((p) => ({ id: p.id, value: p.objectives[obj.stat].proj })))
  );
  const combinedScores = playerBase.map((p) => {
    const score = weightedObjectives.reduce((sum, obj, i) => sum + rankMaps[i].get(p.id) * obj.weight, 0);
    return { id: p.id, value: -score };
  });
  const ovrRankMap = rankDescending(combinedScores);
  const players = playerBase.map((p) => ({ ...p, ovrRank: ovrRankMap.get(p.id) }));
  players.sort((a, b) => a.ovrRank - b.ovrRank);

  const teamAdvanced = computeTeamAdvancedMetrics(snapshot.teamIds, snapshot.roster, snapshot.stats, snapshot.recentGames, last10Set);

  const notes = [
    `Live BALLDONTLIE ${league} data. YTD/L10 always reflect current form (as of today), regardless of which run date is selected; L10 reaches back into last season when fewer than 10 games have been played this season. PITP (when an objective) comes from the advanced-stats endpoint and always uses the L10 average as Proj (Rotowire doesn't project it). Every other objective shows Proj as TBD until that date's Rotowire projections are uploaded for this league -- it never silently falls back to L10. Weight is auto-computed from the share of players projected to clear 100% of target -- the rarer objective carries more weight.`,
  ];
  for (const obj of weightedObjectives) {
    const overrides = projectionOverrides[obj.stat] || {};
    const overrideCount = Object.keys(overrides).length;
    if (overrideCount > 0) {
      const matched = playerBase.filter((p) => p.objectives[obj.stat]?.projSource === "rotowire").length;
      notes.push(`${obj.stat}: ${overrideCount} uploaded Rotowire projection(s), ${matched} matched a player on this slate.`);
    } else if (obj.stat !== "PITP") {
      notes.push(`${obj.stat}: no Rotowire projections uploaded yet for this date -- Proj shows TBD.`);
    }
  }
  if (snapshot.advancedError) {
    notes.push(`NOTE: advanced stats (PITP) could not be fetched for this league (${snapshot.advancedError.slice(0, 80)}); PITP shows "--".`);
  }
  if (building) {
    notes.push(`LOADING: ${loadedPlayers} of ${snapshot.totalPlayers} players loaded so far -- large slates finish over a couple of refreshes.`);
  }
  if (snapshot.truncatedRecent || snapshot.truncatedYtd) {
    notes.push("NOTE: game-window pagination hit its safety cap; some players' YTD/L10 windows may be based on an incomplete range.");
  }
  if (snapshot.truncatedYtdStats) {
    notes.push("NOTE: YTD for some players is based on the earliest games of the season only (stat pagination cap); L10 is always complete.");
  }

  return {
    ...baseReturn,
    objectives: weightedObjectives,
    note: notes.join(" "),
    players,
    teamAdvanced,
    _subrequests_used: snapshot.subrequestsUsed,
    _generated_at: new Date(snapshot.finishedAt || snapshot.startedAt).toISOString(),
  };
}

// Serve-or-advance: returns the best available payload for (league, date,
// mode), spending up to `budget` BALLDONTLIE calls to start/continue the
// day's build when the published snapshot is missing or stale.
async function buildDashboard(env, { league, date, mode, budget = MAX_SUBREQUESTS } = {}) {
  const cfg = leagueConfig(SUPPORTED_LEAGUES.includes(league) ? league : DEFAULT_LEAGUE);
  const targetDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayStr();
  const targetMode = SUPPORTED_MODES.includes(mode) ? mode : "Classic";
  const schedule = await loadObjectivesSchedule(env);

  const published = await loadJSON(env, dayKey(cfg, targetDate));
  const publishedOk = published && published.needsAdvanced === dateNeedsAdvanced(schedule, cfg.key, targetDate);
  if (publishedOk && snapshotIsFresh(published, targetDate)) {
    return renderDayPayload(cfg, published, { mode: targetMode, schedule });
  }

  let state = await loadJSON(env, dayBuildKey(cfg, targetDate));
  const buildUsable = state && state.status === "building" && state.needsAdvanced === dateNeedsAdvanced(schedule, cfg.key, targetDate);
  let used = 0;
  if (!buildUsable) {
    state = await startDayBuild(cfg, env, { date: targetDate, schedule });
    used += state.subrequestsUsed;
    if (state.pendingChunks.length === 0) {
      state.status = "done";
      state.finishedAt = Date.now();
    }
  }
  if (state.status === "building") {
    used += await advanceDayBuild(cfg, env, state, Math.max(0, budget - used));
  }

  if (state.status === "done") {
    await saveJSON(env, dayKey(cfg, targetDate), state);
    await env.FASTBREAK_KV.delete(dayBuildKey(cfg, targetDate));
    return renderDayPayload(cfg, state, { mode: targetMode, schedule });
  }

  await saveJSON(env, dayBuildKey(cfg, targetDate), state);
  // While a refresh is in flight, keep serving the last complete snapshot
  // (with a "refreshing" note) rather than a half-loaded slate -- even when
  // it predates a PITP objective change (PITP shows "--" until the rebuild
  // lands, which beats showing a third of the slate).
  if (published && published.status === "done") {
    const payload = renderDayPayload(cfg, published, { mode: targetMode, schedule });
    payload.refreshing = true;
    payload.note += " Refreshing in the background.";
    return payload;
  }
  return renderDayPayload(cfg, state, { mode: targetMode, schedule });
}

async function refreshAndStore(env, league) {
  const cfg = leagueConfig(league);
  const dashboard = await buildDashboard(env, { league, date: todayStr(), mode: "Classic" });
  if (!dashboard.building) await saveJSON(env, cfg.keys.latest, dashboard);
  return dashboard;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: corsHeaders });
}

function checkAdminToken(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  return Boolean(env.FASTBREAK_ADMIN_TOKEN) && token === env.FASTBREAK_ADMIN_TOKEN;
}

function unauthorized() {
  return json({ error: "Invalid or missing admin password." }, 401);
}

function leagueParam(url) {
  const raw = (url.searchParams.get("league") || DEFAULT_LEAGUE).toUpperCase();
  return SUPPORTED_LEAGUES.includes(raw) ? raw : DEFAULT_LEAGUE;
}

function runInfo(league) {
  const cfg = leagueConfig(league);
  return {
    league,
    runLabel: cfg.run.label,
    runStart: cfg.run.start,
    runEnd: cfg.run.end,
    runLength: dayNumberForDate(league, cfg.run.end),
    seasonActive: cfg.seasonActive,
    todayET: todayStr(),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Live view for a given league/date/mode (defaults to WNBA/today/Classic).
    // Serves the cached day snapshot when fresh; otherwise spends this
    // request's BALLDONTLIE budget starting/continuing the build.
    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/api/fastbreak") {
      try {
        const league = leagueParam(url);
        const date = url.searchParams.get("date") || todayStr();
        const mode = url.searchParams.get("mode") || "Classic";
        const dashboard = await buildDashboard(env, { league, date, mode });
        if (date === todayStr() && mode === "Classic" && !dashboard.building) {
          await saveJSON(env, leagueConfig(league).keys.latest, dashboard);
        }
        return json(dashboard);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // Run metadata for one league (or all) -- the frontend builds its day
    // toggle from this instead of hardcoding the windows.
    if (url.pathname === "/api/fastbreak/run" && request.method === "GET") {
      if (url.searchParams.get("league") === "ALL") {
        return json(Object.fromEntries(SUPPORTED_LEAGUES.map((l) => [l, runInfo(l)])));
      }
      return json(runInfo(leagueParam(url)));
    }

    // Objectives schedule: viewable by anyone (a locked *view*), editable
    // only with the admin password. Whole schedule (all leagues) is returned.
    if (url.pathname === "/api/fastbreak/objectives" && request.method === "GET") {
      const schedule = await loadObjectivesSchedule(env);
      return json({ leagues: SUPPORTED_LEAGUES, modes: SUPPORTED_MODES, schedule });
    }

    if (url.pathname === "/api/fastbreak/objectives/day" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return unauthorized();
      try {
        const body = await request.json();
        const schedule = await upsertObjectivesDay(env, {
          league: (body.league || DEFAULT_LEAGUE).toUpperCase(),
          date: body.date,
          mode: body.mode || "Classic",
          objectives: body.objectives,
          badgeSetName: body.badgeSetName,
        });
        return json({ ok: true, schedule });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    // Bulk-load Rotowire Proj values for one stat on one league/date. Shared
    // by Classic and Pro for that league.
    if (url.pathname === "/api/fastbreak/objectives/day/projections" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return unauthorized();
      try {
        const body = await request.json();
        const schedule = await upsertProjections(env, {
          league: (body.league || DEFAULT_LEAGUE).toUpperCase(),
          date: body.date,
          stat: body.stat,
          projections: body.projections,
        });
        return json({ ok: true, schedule });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    // Admin: force a day's snapshot to rebuild on the next load (e.g. after
    // changing a day's objectives from non-PITP to PITP, or a roster move).
    if (url.pathname === "/api/fastbreak/day/invalidate" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return unauthorized();
      try {
        const body = await request.json();
        const cfg = leagueConfig((body.league || DEFAULT_LEAGUE).toUpperCase());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")) throw new Error("date must be YYYY-MM-DD");
        await env.FASTBREAK_KV.delete(dayKey(cfg, body.date));
        await env.FASTBREAK_KV.delete(dayBuildKey(cfg, body.date));
        return json({ ok: true, league: cfg.key, date: body.date });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    // Full Data tab: cached leaguewide L10/YTD snapshot (plain KV read).
    if (url.pathname === "/api/fastbreak/fulldata" && request.method === "GET") {
      const cfg = leagueConfig(leagueParam(url));
      const cached = await env.FASTBREAK_KV.get(cfg.keys.fulldata);
      if (!cached) {
        return json({ error: `${cfg.key} Full Data hasn't finished its first build yet -- check back shortly.` }, 503);
      }
      return new Response(cached, { headers: corsHeaders });
    }

    if (url.pathname === "/api/fastbreak/fulldata/build" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return unauthorized();
      try {
        const league = leagueParam(url);
        const result = await advanceFullDataBuild(env, league, MAX_SUBREQUESTS - 4);
        return json({ ok: true, league, ...result });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/fastbreak/fulldata/status" && request.method === "GET") {
      const cfg = leagueConfig(leagueParam(url));
      const state = await loadJSON(env, cfg.keys.fulldataBuild);
      const cached = await loadJSON(env, cfg.keys.fulldata);
      return json({
        league: cfg.key,
        buildStatus: state?.status || "not started",
        pendingChunks: state?.pendingChunks?.length ?? null,
        totalPlayersCached: cached?.players?.length ?? 0,
        lastGeneratedAt: cached?.generated_at ?? null,
      });
    }

    // -- NBA Historic (simulated season) -----------------------------------
    // Separate code path: reads/writes only "fastbreak:historic:*" keys and
    // never touches BALLDONTLIE. Advancing a day is an explicit admin action.

    if (url.pathname === "/api/fastbreak/historic" && request.method === "GET") {
      try {
        const dayParam = url.searchParams.get("day");
        const day = dayParam ? Number(dayParam) : undefined;
        return json(await buildHistoricDashboard(env, { day }));
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/fastbreak/historic/status" && request.method === "GET") {
      try {
        return json(await getHistoricStatus(env));
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/fastbreak/historic/seed" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return unauthorized();
      try {
        const body = await request.json();
        return json(await seedHistoric(env, { players: body.players, schedule: body.schedule, objectives: body.objectives }));
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    // Admin: set one Historic day's objectives (same 1-2 objective shape as
    // the live leagues, keyed by day number instead of calendar date).
    if (url.pathname === "/api/fastbreak/historic/objectives/day" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return unauthorized();
      try {
        const body = await request.json();
        return json(await upsertHistoricObjectivesDay(env, { day: body.day, date: body.date, objectives: body.objectives }));
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    if (url.pathname === "/api/fastbreak/historic/advance" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return unauthorized();
      try {
        const body = await request.json().catch(() => ({}));
        const nextDay = body.day || (await getCurrentHistoricDay(env)) + (body.fromCurrent === false ? 0 : 1);
        const simResult = await simulateHistoricDay(env, nextDay);
        await setCurrentHistoricDay(env, nextDay);
        return json({ ok: true, day: nextDay, ...simResult });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  // Two cron expressions in wrangler.toml, one per league (offset so they
  // never share an invocation's subrequest budget). Each tick refreshes
  // today's day snapshot for its league (only while that league is in
  // season) and spends the leftover budget on that league's Full Data build.
  async scheduled(event, env) {
    const league = event.cron === LEAGUE_CRONS.NBA ? "NBA" : "WNBA";
    const today = todayStr();
    if (!isSeasonActive(league, today)) {
      console.log(`${league} not in season on ${today}; skipping cron refresh.`);
      return;
    }

    let dashboard = null;
    try {
      dashboard = await refreshAndStore(env, league);
    } catch (err) {
      console.error(`fastbreak-refresh ${league} scheduled run failed:`, err.message);
    }

    const usedByDashboard = dashboard?._subrequests_used || 0;
    const fullDataBudget = MAX_SUBREQUESTS - usedByDashboard - 4;
    if (fullDataBudget > 0) {
      try {
        await advanceFullDataBuild(env, league, fullDataBudget);
      } catch (err) {
        console.error(`${league} full-data build tick failed (continuing):`, err.message);
      }
    }
    // NBA Historic is NOT advanced here -- see /api/fastbreak/historic/advance.
  },
};

// Keep in sync with [triggers] crons in wrangler.toml.
const LEAGUE_CRONS = {
  WNBA: "*/15 * * * *",
  NBA: "7-59/15 * * * *",
};

// Exported for local/unit testing only (not used by the Worker runtime).
export const __testables__ = {
  LEAGUES,
  SUPPORTED_LEAGUES,
  SUPPORTED_MODES,
  STAT_FIELD_MAP,
  average,
  round1,
  rankDescending,
  colorTier,
  computeAutoWeights,
  validateObjectives,
  objectivesForDate,
  formatGameTime,
  pickLastNGameIdsPerTeam,
  buildDashboard,
  renderDayPayload,
  normalizePlayerName,
  upsertProjections,
  upsertObjectivesDay,
  projectionsForDate,
  dayNumberForDate,
  isWithinRun,
  isSeasonActive,
  getGamesForDate,
  etDateStrForGame,
  etDateStr,
  etHour,
  todayStr,
  addDaysStr,
  slimGame,
  computeTeamScoring,
  computeTeamAdvancedMetrics,
  advanceFullDataBuild,
  FULLDATA_STAT_CODES,
  TEAM_BOX_CODES,
  OBJECTIVES_KV_KEY,
  dayKey,
  dayBuildKey,
  LEAGUE_CRONS,
  MAX_SUBREQUESTS,
};
