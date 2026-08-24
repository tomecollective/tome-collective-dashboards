// tome-fastbreak-refresh
// Scheduled Worker: pulls live BALLDONTLIE data, builds the Fast Break dashboard
// payload (schedule tiles, per-objective Proj/YTD/L10 + color tiers, auto-
// weighted Ovr Rank), and caches it in KV for the public-facing tome-fastbreak
// Worker to serve. Also owns the objectives schedule (viewable by anyone,
// editable only with the admin password) that this build reads from KV.
//
// RUN model: objectives/games/badge info are scheduled per calendar date
// across a multi-day "Run" (Run 10: Aug 19-30, 2026). Each date can carry a
// separate Classic objective set and Pro objective set (Pro also carries an
// optional Top Shot badge/set name). The frontend's day toggle asks this
// Worker to build any date in that window on demand.

const BALLDONTLIE_BASE = "https://api.balldontlie.io/wnba/v1";
const PLAYER_CHUNK_SIZE = 10; // per_page max is 100, so 10 players * 10 games/player = 100 rows
const MAX_SUBREQUESTS = 45; // stay under Cloudflare Free plan's 50 subrequests/invocation ceiling
const RECENT_GAMES_LOOKBACK_DAYS = 45; // roughly weekly cadence + byes; combined with full
// pagination below (not just page 1), this reliably captures >=10 games/team.
const RECENT_GAMES_MAX_PAGES = 5; // safety cap on pagination (500 games) to bound subrequest cost
const YTD_MAX_PAGES = 6; // safety cap on season-long game-id pagination for YTD

// -- Run schedule --------------------------------------------------------------
// Run 10: Day 1 = Aug 19, 2026 through Day 12 = Aug 30, 2026 (inclusive).
const RUN_START = "2026-08-19";
const RUN_END = "2026-08-30";

function dayNumberForDate(dateStr) {
  const start = new Date(`${RUN_START}T00:00:00Z`);
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((d - start) / 86400000) + 1;
}

function isWithinRun(dateStr) {
  return dateStr >= RUN_START && dateStr <= RUN_END;
}

// -- League / mode -----------------------------------------------------------
// Only WNBA has live data right now. NBA (season not in progress) and Historic
// (no historical pipeline built yet) are disabled in the frontend toggle.
// Classic and Pro each carry their own objective set for a given date (see
// objectivesForDate below) -- Pro additionally carries a Top Shot badge/set
// requirement (badgeSetName).
const SUPPORTED_LEAGUE = "WNBA";
const SUPPORTED_MODES = ["Classic", "Pro"];

// -- Objective -> stat field mapping ------------------------------------------
// `source: "stats"` reads from /player_stats. `source: "advanced"` reads from
// /player_game_advanced_stats (needed for PITP, which isn't a standard
// box-score stat). Add new objective codes here as they come up.
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
  // PITP: points in the paint. Not a standard box-score stat -- lives under
  // player_game_advanced_stats.stats.misc.points_paint. Confirmed working
  // against the live endpoint.
  PITP: {
    source: "advanced",
    field: (a) => a.stats?.misc?.points_paint ?? a.misc?.points_paint,
    label: "PITP",
  },
};

// Defaults when a date in the run has no admin-set objectives yet.
const DEFAULT_OBJECTIVES = {
  Classic: [{ stat: "PTS", label: "PTS", dailyTeamTarget: 80 }],
  Pro: [{ stat: "PTS", label: "PTS", dailyTeamTarget: 80 }],
};

function bdlHeaders(env) {
  return { Authorization: env.BALLDONTLIE_API_KEY };
}

async function bdlFetch(path, env) {
  const res = await fetch(`${BALLDONTLIE_BASE}${path}`, { headers: bdlHeaders(env) });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`BALLDONTLIE ${path} failed: ${res.status} | body=${bodyText.slice(0, 200)}`);
  }
  return res.json();
}

function currentSeason() {
  return new Date().getFullYear();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Derives a game's real ET calendar date from its tip-off datetime, using
// the same fixed ET_OFFSET_HOURS used for display. Returns null when no
// parseable datetime is available.
function etDateStrForGame(g) {
  const iso = g.datetime || g.date;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const et = new Date(d.getTime() + ET_OFFSET_HOURS * 3600 * 1000);
  return et.toISOString().slice(0, 10);
}

// BUG FIX (verified live 2026-08-22): BALLDONTLIE's `dates[]=` filter buckets
// games by the UTC calendar date of their actual tip-off time, not by the
// Run's ET calendar date. A 9-10pm ET game tips off after midnight UTC -- on
// the *next* UTC date -- so a naive dates[]=dateStr query silently dropped
// those late games from "today" (they surfaced under tomorrow's query
// instead) and could pull in the tail end of a prior ET night's late game
// that happened to cross into today's UTC date. Confirmed live: Aug 22's
// true ET slate (IND@NY 7pm, CON@LAS 9pm, ATL@PHX 10pm) was split across the
// Aug 22 and Aug 23 UTC-date queries, while a leftover Aug 21 late game
// (POR@TOR) leaked into the Aug 22 UTC bucket.
//
// Fix: query both UTC dates a full ET day can straddle (dateStr and the day
// after), then keep only games whose real ET calendar date -- derived from
// their tip-off datetime -- actually equals dateStr. When a game has no
// parseable datetime (defensive fallback only), trust whichever original
// UTC-date query bucket it came from rather than dropping it.
async function getGamesForDate(dateStr, env) {
  const nextDateStr = addDaysStr(dateStr, 1);
  const [dataA, dataB] = await Promise.all([
    bdlFetch(`/games?dates[]=${dateStr}`, env),
    bdlFetch(`/games?dates[]=${nextDateStr}`, env),
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
  return games;
}

async function getTeamRosters(teamIds, env) {
  // Live-confirmed: plain /players returns every player EVER on a team, sorted
  // oldest-first by id. With per_page=100, teams with a long history fill the
  // page with retired/legacy players before ever reaching current roster
  // members. /players/active returns only currently active players.
  const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");
  const data = await bdlFetch(`/players/active?${qs}&per_page=100`, env);
  return data.data || [];
}

// Current injury reports for the teams playing today. player_injuries always
// returns live data (never historical), and status values seen in the wild
// include "Out", "Day-To-Day", and "Questionable" -- the frontend maps those
// to a red ("Out") or yellow (everything else, i.e. probable/questionable/
// day-to-day) pill next to the player name. Requires ALL-STAR tier or higher
// on the BALLDONTLIE key; if the key lacks access, this fails soft (empty
// map) rather than breaking the whole dashboard build.
async function getInjuriesForTeams(teamIds, env) {
  const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");
  try {
    const data = await bdlFetch(`/player_injuries?${qs}&per_page=100`, env);
    return data.data || [];
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

// Batched call(s) across ALL relevant teams to get real recent games we trust, so
// we can sort/pick "last 10" ourselves instead of relying on default API ordering.
// Live-confirmed bug: this endpoint returns games OLDEST-FIRST and caps at
// per_page=100. Fix: follow meta.next_cursor and fetch every page in the window
// (capped at maxPages as a subrequest-budget safety valve), then sort ourselves.
async function getGamesForTeamsInWindow(teamIds, env, { startStr, endStr, maxPages }) {
  const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");

  let games = [];
  let cursor = null;
  let requestsUsed = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
    const data = await bdlFetch(
      `/games?${qs}&start_date=${startStr}&end_date=${endStr}&per_page=100${cursorQs}`,
      env
    );
    requestsUsed += 1;
    const pageData = data.data || [];
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

// Group by team, sort each team's games by date descending ourselves (never
// trust API default ordering), take the most recent `n` completed games/team.
function pickLastNGameIdsPerTeam(games, teamIds, n) {
  const byTeam = new Map(teamIds.map((id) => [id, []]));
  for (const g of games) {
    // Live-confirmed: BALLDONTLIE uses "post" (not "Final") for completed
    // games, "in" for in-progress, "pre" for upcoming. Only completed games count.
    if (g.status && g.status !== "post") continue;
    const homeId = g.home_team?.id;
    const visId = g.visitor_team?.id;
    if (homeId && byTeam.has(homeId)) byTeam.get(homeId).push(g);
    if (visId && byTeam.has(visId)) byTeam.get(visId).push(g);
  }
  const gameIds = new Set();
  for (const [, teamGames] of byTeam) {
    teamGames.sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const g of teamGames.slice(0, n)) gameIds.add(g.id);
  }
  return gameIds;
}

function buildQs(parts) {
  return parts.filter(Boolean).join("&");
}

async function getStatsForChunk(playerIds, season, gameIds, env) {
  const playerQs = playerIds.map((id) => `player_ids[]=${id}`).join("&");
  const gameQs = [...gameIds].map((id) => `game_ids[]=${id}`).join("&");
  const qs = buildQs([playerQs, `seasons[]=${season}`, gameQs, "per_page=100"]);
  const data = await bdlFetch(`/player_stats?${qs}`, env);
  return data.data || [];
}

async function getAdvancedForChunk(playerIds, season, gameIds, env) {
  const playerQs = playerIds.map((id) => `player_ids[]=${id}`).join("&");
  const gameQs = [...gameIds].map((id) => `game_ids[]=${id}`).join("&");
  // period=0 = full game, avoids duplicate rows from quarter-level breakdowns.
  const qs = buildQs([playerQs, `seasons[]=${season}`, gameQs, "period=0", "per_page=100"]);
  const data = await bdlFetch(`/player_game_advanced_stats?${qs}`, env);
  return data.data || [];
}

function average(nums) {
  const clean = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

// Defensive: even with explicit game_ids[] filtering upstream, sort each
// player's returned rows by game date descending and cap at `n` before
// averaging. Belt-and-suspenders against ever trusting API default ordering.
function lastNByDate(lines, n) {
  return [...lines].sort((a, b) => new Date(b.game?.date || 0) - new Date(a.game?.date || 0)).slice(0, n);
}

// -- Full Data (leaguewide L10/YTD for every active player) -------------------
// A separate build from the day's Fast Break slate: instead of ~2 teams'
// rosters, this covers every active WNBA player and every Fast Break-relevant
// box-score stat, not just the day's 1-2 objectives. That is roughly 13-15x
// more player-chunks than a normal day build, which does not fit in one
// invocation's subrequest budget -- so this build resumes across multiple
// scheduled ticks, persisting progress in KV between ticks (see
// advanceFullDataBuild below), and only replaces the published cache once a
// full pass finishes. Team PPG/PAPG are computed directly from this season's
// final scores (data already fetched for stat-window scoping) rather than
// from BALLDONTLIE's team_season_stats/team_season_advanced_stats endpoints,
// which require GOAT tier -- this dashboard runs on an ALL-STAR key.
const FULLDATA_KV_KEY = "fastbreak:fulldata";
const FULLDATA_BUILD_KV_KEY = "fastbreak:fulldata:build";
const FULLDATA_REBUILD_INTERVAL_MS = 20 * 60 * 60 * 1000; // rebuild roughly once/day
const FULLDATA_ROSTER_MAX_PAGES = 4; // safety cap: 4 * per_page(100) = room for 400 active players
// Basic box-score stats only (excludes PITP, which lives under the separate
// player_game_advanced_stats endpoint and would double the per-chunk request
// cost across the whole league roster).
const FULLDATA_STAT_CODES = Object.keys(STAT_FIELD_MAP).filter((code) => STAT_FIELD_MAP[code].source === "stats");

// All active players leaguewide (no team filter), paginated -- a full WNBA
// roster is 150-200+ active players, well past the per_page=100 cap that the
// day-view's team-scoped getTeamRosters never has to worry about.
async function getAllActivePlayers(env, { maxPages }) {
  let players = [];
  let cursor = null;
  let requestsUsed = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
    const data = await bdlFetch(`/players/active?per_page=100${cursorQs}`, env);
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

// Leaguewide games in a date window (no team filter) -- same
// oldest-first/pagination behavior as getGamesForTeamsInWindow above, just
// without scoping to a specific slate's teams.
async function getLeagueGamesInWindow(env, { startStr, endStr, maxPages }) {
  let games = [];
  let cursor = null;
  let requestsUsed = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
    const data = await bdlFetch(`/games?start_date=${startStr}&end_date=${endStr}&per_page=100${cursorQs}`, env);
    requestsUsed += 1;
    const pageData = data.data || [];
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

// Each team's PPG/PAPG (points allowed per game), computed directly from
// completed games in the YTD window -- no BALLDONTLIE calls beyond the games
// fetch already needed for stat-window scoping.
function computeTeamScoring(games) {
  const byTeam = new Map(); // team id -> {abbr, name, ptsFor:[], ptsAgainst:[]}
  for (const g of games) {
    if (g.status !== "post") continue;
    if (typeof g.home_team_score !== "number" || typeof g.visitor_team_score !== "number") continue;
    const home = g.home_team;
    const away = g.visitor_team;
    if (home?.id != null) {
      if (!byTeam.has(home.id)) byTeam.set(home.id, { abbr: home.abbreviation, name: home.full_name, ptsFor: [], ptsAgainst: [] });
      byTeam.get(home.id).ptsFor.push(g.home_team_score);
      byTeam.get(home.id).ptsAgainst.push(g.visitor_team_score);
    }
    if (away?.id != null) {
      if (!byTeam.has(away.id)) byTeam.set(away.id, { abbr: away.abbreviation, name: away.full_name, ptsFor: [], ptsAgainst: [] });
      byTeam.get(away.id).ptsFor.push(g.visitor_team_score);
      byTeam.get(away.id).ptsAgainst.push(g.home_team_score);
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

async function loadFullDataBuildState(env) {
  const raw = await env.FASTBREAK_KV.get(FULLDATA_BUILD_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveFullDataBuildState(env, state) {
  await env.FASTBREAK_KV.put(FULLDATA_BUILD_KV_KEY, JSON.stringify(state));
}

// Advances the leaguewide Full Data build by at most `budget` BALLDONTLIE
// subrequests. On a fresh start (no build in progress, or the last completed
// build is stale) it fetches the full roster plus leaguewide recent/YTD game
// windows and stores that as resumable state; on later calls it works
// through the player-chunk queue left over from last time. The published
// cache (FULLDATA_KV_KEY) is only overwritten once every chunk is processed,
// so the Full Data tab always serves the last *complete* snapshot rather
// than a partial one mid-build.
async function advanceFullDataBuild(env, budget) {
  if (budget < 4) return { advanced: false, reason: "budget too small this tick" };

  let state = await loadFullDataBuildState(env);
  let used = 0;

  const isStale = state?.status === "done" && Date.now() - (state.finishedAt || 0) > FULLDATA_REBUILD_INTERVAL_MS;
  const needsFreshStart = !state || state.status !== "building";

  if (needsFreshStart) {
    if (state?.status === "done" && !isStale) {
      return { advanced: false, reason: "last build is still fresh" };
    }

    // Setup costs roster pagination + both league game-window fetches.
    const setupCeiling = FULLDATA_ROSTER_MAX_PAGES + RECENT_GAMES_MAX_PAGES + YTD_MAX_PAGES;
    if (budget < setupCeiling) {
      return { advanced: false, reason: `budget too small to start a fresh build (need ~${setupCeiling})` };
    }

    const rosterResult = await getAllActivePlayers(env, { maxPages: FULLDATA_ROSTER_MAX_PAGES });
    used += rosterResult.requestsUsed;

    const today = todayStr();
    const recentEnd = new Date();
    const recentStart = new Date(recentEnd.getTime() - RECENT_GAMES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const recentResult = await getLeagueGamesInWindow(env, {
      startStr: recentStart.toISOString().slice(0, 10),
      endStr: recentEnd.toISOString().slice(0, 10),
      maxPages: RECENT_GAMES_MAX_PAGES,
    });
    used += recentResult.requestsUsed;

    const season = currentSeason();
    const ytdResult = await getLeagueGamesInWindow(env, {
      startStr: `${season}-01-01`,
      endStr: today,
      maxPages: YTD_MAX_PAGES,
    });
    used += ytdResult.requestsUsed;

    const teamIds = [...new Set(rosterResult.players.map((p) => p.team?.id).filter(Boolean))];
    const last10GameIds = [...pickLastNGameIdsPerTeam(recentResult.games, teamIds, 10)];
    const ytdGameIds = [...new Set(ytdResult.games.filter((g) => g.status === "post").map((g) => g.id))];
    const teamScoring = computeTeamScoring(ytdResult.games);

    const rosterById = {};
    for (const p of rosterResult.players) {
      rosterById[p.id] = {
        id: p.id,
        name: `${p.first_name} ${p.last_name}`,
        team: p.team?.abbreviation || "",
      };
    }
    const playerIds = Object.keys(rosterById).map(Number);

    state = {
      status: "building",
      season,
      startedAt: Date.now(),
      rosterById,
      last10GameIds,
      ytdGameIds,
      teamScoring,
      pendingChunks: chunk(playerIds, PLAYER_CHUNK_SIZE),
      results: {},
      truncatedRoster: rosterResult.truncated,
      truncatedRecent: recentResult.truncated,
      truncatedYtd: ytdResult.truncated,
    };
  }

  const remaining = budget - used;
  const chunksThisTick = Math.max(0, Math.floor(remaining / 2));
  const last10Set = new Set(state.last10GameIds);
  const ytdSet = new Set(state.ytdGameIds);

  let processedChunks = 0;
  while (processedChunks < chunksThisTick && state.pendingChunks.length > 0) {
    const c = state.pendingChunks.shift();
    const recentStats = await getStatsForChunk(c, state.season, last10Set, env);
    used += 1;
    const ytdStats = await getStatsForChunk(c, state.season, ytdSet, env);
    used += 1;

    const byPlayerRecent = new Map();
    const byPlayerYtd = new Map();
    for (const row of recentStats) {
      const pid = row.player?.id;
      if (!byPlayerRecent.has(pid)) byPlayerRecent.set(pid, []);
      byPlayerRecent.get(pid).push(row);
    }
    for (const row of ytdStats) {
      const pid = row.player?.id;
      if (!byPlayerYtd.has(pid)) byPlayerYtd.set(pid, []);
      byPlayerYtd.get(pid).push(row);
    }

    for (const pid of c) {
      const player = state.rosterById[pid];
      if (!player) continue;
      const l10Rows = lastNByDate((byPlayerRecent.get(pid) || []).filter((r) => last10Set.has(r.game?.id)), 10);
      const ytdRows = (byPlayerYtd.get(pid) || []).filter((r) => ytdSet.has(r.game?.id));
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
    }

    processedChunks += 1;
  }

  const finished = state.pendingChunks.length === 0;
  if (finished) {
    const players = Object.values(state.results).sort((a, b) => a.name.localeCompare(b.name));
    const payload = {
      dashboard_name: "Fast Break Full Data",
      league: SUPPORTED_LEAGUE,
      season: state.season,
      generated_at: new Date().toISOString(),
      statCodes: FULLDATA_STAT_CODES,
      teams: state.teamScoring,
      players,
      note:
        "Leaguewide L10/YTD for every active WNBA player across all Fast Break-relevant box-score stats. PITP is intentionally excluded here (it lives under a separate advanced-stats endpoint) to stay within the ALL-STAR-tier BALLDONTLIE key's subrequest budget across the full roster. Team PPG/PAPG are computed directly from this season's final scores, not from BALLDONTLIE's GOAT-tier team season stats endpoints." +
        (state.truncatedRoster ? " NOTE: roster pagination hit its safety cap; some players may be missing." : "") +
        (state.truncatedRecent || state.truncatedYtd ? " NOTE: league game-window pagination hit its safety cap; some players' windows may be incomplete." : ""),
    };
    await env.FASTBREAK_KV.put(FULLDATA_KV_KEY, JSON.stringify(payload));
    state = { status: "done", finishedAt: Date.now() };
  }

  await saveFullDataBuildState(env, state);
  return { advanced: true, finished, chunksProcessed: processedChunks, subrequestsUsed: used };
}

// -- Objectives schedule (admin-managed, stored in KV) ------------------------

const OBJECTIVES_KV_KEY = "fastbreak:objectives";

async function loadObjectivesSchedule(env) {
  const raw = await env.FASTBREAK_KV.get(OBJECTIVES_KV_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Weight is no longer entered manually -- see computeAutoWeights, which
// derives it at build time from how many players are projected to clear
// 100% of the per-player target. validateObjectives only checks the shape
// of what an admin *can* set: stat code + a positive daily team target,
// plus an optional badgeSetName string (Pro mode only).
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

// Auto-computed weighting: for a 2-objective day, the objective with FEWER
// players projected at >=100% of their per-player target gets the HIGHER
// weight (it's the harder objective to clear, so hitting it says more).
// Example from spec: 3PM has 10/50 players clearing 100%, 3PA has 25/50 -->
// 3PM (the rarer feat) gets the higher weight. A single-objective day is
// always weight 1 (100%).
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
  // Guard against a 0% fraction producing an infinite weight -- floor it at
  // "as if 1 more player than actually cleared it" cleared it instead.
  const epsilon = 1 / (2 * total);
  const raw = fractions.map((f) => 1 / Math.max(f, epsilon));
  const sum = raw[0] + raw[1];
  return objectives.map((o, i) => ({ ...o, weight: raw[i] / sum, _hitFraction: fractions[i] }));
}

// -- Projections (manual, Rotowire-sourced where available) ------------------
// BALLDONTLIE has no projections endpoint, so real Proj values come from a
// manual admin upload (David sources them from Rotowire via spreadsheet).
// Confirmed per-objective: 3PM, 3PA, and OREB all have genuine Rotowire
// projections that are NOT the same as L10 and must be preserved exactly as
// given. PITP is the one confirmed exception -- neither Rotowire nor standard
// WNBA stats sites project it, so PITP intentionally has no override entry
// and always falls back to the L10 average (see the lookup in buildDashboard
// below). Do not "fix" that by requiring an override for every stat.
function normalizePlayerName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function upsertProjections(env, { league, date, stat, projections }) {
  if (league !== SUPPORTED_LEAGUE) throw new Error(`unsupported league: ${league}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
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
  await env.FASTBREAK_KV.put(OBJECTIVES_KV_KEY, JSON.stringify(schedule));
  return schedule;
}

function projectionsForDate(schedule, league, date, stat) {
  return schedule?.[league]?.[date]?.projections?.[stat] || null;
}

async function upsertObjectivesDay(env, { league, date, mode, objectives, badgeSetName }) {
  if (league !== SUPPORTED_LEAGUE) throw new Error(`unsupported league: ${league}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  if (!SUPPORTED_MODES.includes(mode)) throw new Error(`mode must be one of ${SUPPORTED_MODES.join(", ")}`);
  validateObjectives(objectives);

  const schedule = await loadObjectivesSchedule(env);
  if (!schedule[league]) schedule[league] = {};
  const existing = schedule[league][date] || {};
  const existingObjectives = existing.objectives || {};
  // Strip any legacy/incoming weight field -- weight is always recomputed.
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
  await env.FASTBREAK_KV.put(OBJECTIVES_KV_KEY, JSON.stringify(schedule));
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

// FUTURE ENHANCEMENT (not built): badgeSetName is currently just an admin-
// typed label ("Rookie Year") shown on the Pro objective tile -- it doesn't
// know which *players* actually own a moment from that badge/set. Integrating
// with Flow/Cadence (the blockchain NBA Top Shot moments live on) could let
// this Worker look up real moment ownership per player and automatically
// flag/filter who qualifies, instead of the badge/set name being purely
// informational text.

// FUTURE ENHANCEMENT (not built): NBA Top Shot's own Fast Break page surfaces
// which players are being utilized most heavily (i.e. picked into the most
// lineups). Worth investigating whether that utilization signal -- or a
// Cadence/Flow-sourced equivalent -- could be captured and surfaced here as
// a "Top 10 Players by Utilization" tile/graphic alongside the objectives.

// -- Ranking + color tiers -----------------------------------------------------

// Standard competition ranking (1224-style): equal values share the lower
// rank, and the next distinct value's rank skips the tied slots.
function rankDescending(values) {
  // values: array of {id, value}. Returns Map(id -> rank), null values sink to
  // the bottom (they didn't play / no data, so they can't be "likeliest").
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

// Eastern Time, with UTC in parentheses. Run 10 (Aug 19-30, 2026) falls
// entirely in EDT (UTC-4), so a fixed offset is safe here without pulling in
// a full timezone library.
const ET_OFFSET_HOURS = -4;

function formatGameTime(game) {
  const iso = game.datetime || game.date;
  if (game.status === "post") return "Final";
  if (game.status === "in") return "In Progress";
  if (!iso) return "TBD";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "TBD";
    const et = new Date(d.getTime() + ET_OFFSET_HOURS * 3600 * 1000);
    const etStr = et.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    const utcStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC", hour12: false });
    return `${etStr} ET (${utcStr} UTC)`;
  } catch {
    return "TBD";
  }
}

function buildScheduleTiles(games) {
  return games.map((g) => ({
    id: g.id,
    awayAbbr: g.visitor_team?.abbreviation || "",
    awayName: g.visitor_team?.full_name || "",
    homeAbbr: g.home_team?.abbreviation || "",
    homeName: g.home_team?.full_name || "",
    time: formatGameTime(g),
    status: g.status || "pre",
    awayScore: g.visitor_team_score ?? null,
    homeScore: g.home_team_score ?? null,
  }));
}

// -- Main build -----------------------------------------------------------------

async function buildDashboard(env, { date, mode } = {}) {
  let subrequests = 0;
  const targetDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayStr();
  const targetMode = SUPPORTED_MODES.includes(mode) ? mode : "Classic";
  const today = todayStr();
  const schedule = await loadObjectivesSchedule(env);
  const objectives = objectivesForDate(schedule, SUPPORTED_LEAGUE, targetDate, targetMode);
  const badgeSetName = targetMode === "Pro" ? badgeSetNameForDate(schedule, SUPPORTED_LEAGUE, targetDate) : null;

  const games = await getGamesForDate(targetDate, env);
  subrequests += 2; // two UTC-date queries -- see getGamesForDate's ET-bucketing fix

  const teamIds = [...new Set(games.flatMap((g) => [g.home_team?.id, g.visitor_team?.id]).filter(Boolean))];
  const scheduleTiles = buildScheduleTiles(games);

  const baseReturn = {
    dashboard_name: "Fast Break Dashboard",
    league: SUPPORTED_LEAGUE,
    mode: targetMode,
    date: targetDate,
    dayNumber: dayNumberForDate(targetDate),
    runLength: dayNumberForDate(RUN_END),
    last_updated: today,
    objectives,
    badgeSetName,
    games: scheduleTiles,
  };

  if (teamIds.length === 0) {
    return { ...baseReturn, note: "No WNBA games scheduled on this date.", players: [] };
  }

  const opponentByTeam = new Map();
  for (const g of games) {
    if (g.home_team?.id && g.visitor_team) opponentByTeam.set(g.home_team.id, `vs ${g.visitor_team.abbreviation}`);
    if (g.visitor_team?.id && g.home_team) opponentByTeam.set(g.visitor_team.id, `@ ${g.home_team.abbreviation}`);
  }

  const roster = await getTeamRosters(teamIds, env);
  subrequests += 1;
  const injuries = await getInjuriesForTeams(teamIds, env);
  subrequests += 1;
  const injuryByPlayerId = new Map(injuries.map((inj) => [inj.player?.id, inj]));
  const season = currentSeason();

  // Last-10 / YTD windows are always computed relative to the REAL today
  // (current known form), regardless of which scheduled date is being
  // viewed -- a future run day shows today's YTD/L10 plus that day's games;
  // BALLDONTLIE has no future stats to show.
  const recentEnd = new Date();
  const recentStart = new Date(recentEnd.getTime() - RECENT_GAMES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const recentResult = await getGamesForTeamsInWindow(teamIds, env, {
    startStr: recentStart.toISOString().slice(0, 10),
    endStr: recentEnd.toISOString().slice(0, 10),
    maxPages: RECENT_GAMES_MAX_PAGES,
  });
  subrequests += recentResult.requestsUsed;
  const last10GameIds = pickLastNGameIdsPerTeam(recentResult.games, teamIds, 10);

  // YTD window: full season to date.
  const seasonStartStr = `${season}-01-01`;
  const ytdResult = await getGamesForTeamsInWindow(teamIds, env, {
    startStr: seasonStartStr,
    endStr: today,
    maxPages: YTD_MAX_PAGES,
  });
  subrequests += ytdResult.requestsUsed;
  const ytdGameIds = new Set(
    ytdResult.games.filter((g) => g.status === "post").map((g) => g.id)
  );
  // Union of L10 + YTD game ids -- one set of stat calls covers both windows;
  // per-player averaging below re-slices L10 vs. season out of the same rows.
  const allGameIds = new Set([...last10GameIds, ...ytdGameIds]);

  let playerIds = [...new Set(roster.map((p) => p.id))];

  // Reserve 2 subrequests per player chunk for stats (recent-scoped + YTD-
  // scoped, see fix note below), plus 2 more for advanced stats if PITP is
  // one of today's objectives. If the full player list would exceed the
  // Free-plan subrequest ceiling, trim it and say so honestly rather than
  // silently dropping players or crashing mid-run.
  const needsAdvanced = objectives.some((o) => STAT_FIELD_MAP[o.stat].source === "advanced");
  const perChunkRequests = needsAdvanced ? 4 : 2;
  const chunksNeeded = Math.ceil(playerIds.length / PLAYER_CHUNK_SIZE) * perChunkRequests;
  let droppedCount = 0;
  if (subrequests + chunksNeeded > MAX_SUBREQUESTS) {
    const maxPlayers =
      Math.floor((MAX_SUBREQUESTS - subrequests) / perChunkRequests) * PLAYER_CHUNK_SIZE;
    droppedCount = playerIds.length - maxPlayers;
    playerIds = playerIds.slice(0, Math.max(0, maxPlayers));
  }

  // BUG FIX (verified live 2026-08-21): a single combined query scoped to
  // `allGameIds` (L10 union YTD, i.e. the whole season) silently overflowed the
  // API's per_page=100 cap for any chunk with real game history -- and since
  // /player_stats and /player_game_advanced_stats return rows OLDEST-FIRST
  // (same ordering quirk documented above for /games), the surviving page-1
  // rows skewed toward early-season games. YTD still looked "plausible" off
  // that partial sample, but L10 -- which specifically needs the most recent
  // games -- came back empty for every player. Fix: issue two narrower,
  // separately-scoped queries per chunk. The last10GameIds-scoped query is
  // guaranteed to fit one page (PLAYER_CHUNK_SIZE=10 players * 10 games =
  // <=100 rows), so L10 is always complete. The ytdGameIds-scoped query keeps
  // the prior single-page best-effort behavior (unchanged from before this
  // fix) for season-long rows. Rows are deduped per (player, game) since the
  // two scopes overlap on a player's most recent games.
  const playerChunks = chunk(playerIds, PLAYER_CHUNK_SIZE);
  const statsByPlayer = new Map();
  const advByPlayer = new Map();

  function mergeRows(targetMap, rows) {
    for (const row of rows) {
      const pid = row.player?.id ?? row.player_id;
      const gid = row.game?.id ?? row.game_id;
      if (!targetMap.has(pid)) targetMap.set(pid, new Map());
      targetMap.get(pid).set(gid, row);
    }
  }

  for (const c of playerChunks) {
    const recentStats = await getStatsForChunk(c, season, last10GameIds, env);
    subrequests += 1;
    mergeRows(statsByPlayer, recentStats);
    const ytdStats = await getStatsForChunk(c, season, ytdGameIds, env);
    subrequests += 1;
    mergeRows(statsByPlayer, ytdStats);

    if (needsAdvanced) {
      const recentAdv = await getAdvancedForChunk(c, season, last10GameIds, env);
      subrequests += 1;
      mergeRows(advByPlayer, recentAdv);
      const ytdAdv = await getAdvancedForChunk(c, season, ytdGameIds, env);
      subrequests += 1;
      mergeRows(advByPlayer, ytdAdv);
    }
  }

  const rosterById = new Map(roster.map((p) => [p.id, p]));

  function rowsForObjective(stat, pid) {
    const def = STAT_FIELD_MAP[stat];
    const byGame = def.source === "advanced" ? advByPlayer.get(pid) : statsByPlayer.get(pid);
    const lines = byGame ? [...byGame.values()] : [];
    return { def, lines };
  }

  function statValue(def, line) {
    const v = def.field(line);
    return typeof v === "number" ? v : null;
  }

  // Load any admin-uploaded Rotowire projections for this date's objective(s).
  // Keyed by stat -> { normalizedName: {name, value} }. See upsertProjections.
  const projectionOverrides = {};
  for (const obj of objectives) {
    projectionOverrides[obj.stat] = projectionsForDate(schedule, SUPPORTED_LEAGUE, targetDate, obj.stat) || {};
  }

  const playerBase = playerIds.map((pid) => {
    const player = rosterById.get(pid);
    const playerName = `${player.first_name} ${player.last_name}`;
    const nameKey = normalizePlayerName(playerName);
    const objectiveValues = {};

    for (const obj of objectives) {
      const { def, lines } = rowsForObjective(obj.stat, pid);
      const l10Lines = lastNByDate(
        lines.filter((l) => last10GameIds.has(l.game?.id)),
        10
      );
      const ytdLines = lines.filter((l) => ytdGameIds.has(l.game?.id));

      const l10 = round1(average(l10Lines.map((l) => statValue(def, l))));
      const ytd = round1(average(ytdLines.map((l) => statValue(def, l))));

      // Proj: real Rotowire-sourced value when the admin has uploaded one for
      // this stat/date (confirmed distinct from L10 for 3PM/3PA/OREB -- never
      // overwrite those with an L10 passthrough). Falls back to the L10
      // average only when no override exists, which today is PITP's
      // intentional, documented case (Rotowire and standard WNBA stats sites
      // don't project PITP) -- not a general default.
      const override = projectionOverrides[obj.stat]?.[nameKey];
      const proj = override != null ? round1(override.value) : l10;

      const perPlayerTarget = obj.dailyTeamTarget / 5;
      objectiveValues[obj.stat] = {
        stat: obj.stat,
        label: obj.label || obj.stat,
        dailyTeamTarget: obj.dailyTeamTarget,
        perPlayerTarget: round1(perPlayerTarget),
        proj,
        projSource: override != null ? "rotowire" : "l10-fallback",
        ytd,
        l10,
        gamesPlayedL10: l10Lines.length,
        colorProj: colorTier(proj, perPlayerTarget),
        colorYtd: colorTier(ytd, perPlayerTarget),
        colorL10: colorTier(l10, perPlayerTarget),
      };
    }

    const injury = injuryByPlayerId.get(pid);
    return {
      id: pid,
      name: playerName,
      team: player.team?.abbreviation || "",
      opp: opponentByTeam.get(player.team?.id) || "",
      injuryStatus: injury?.status || null,
      injuryNote: injury?.description || injury?.comment || injury?.return_date || null,
      objectives: objectiveValues,
    };
  });

  // Auto-computed weighting (replaces manual entry): derived from how many
  // players are projected to clear >=100% of their per-player target for
  // each objective. Rarer feat -> higher weight, relative to the other
  // objective on a 2-objective day.
  const weightedObjectives = computeAutoWeights(objectives, playerBase);
  for (const p of playerBase) {
    for (const wo of weightedObjectives) {
      if (p.objectives[wo.stat]) p.objectives[wo.stat].weight = wo.weight;
    }
  }

  // Weighted Ovr Rank: rank players within each objective by Proj (desc,
  // standard competition ranking), then combine ranks using that day's
  // auto-computed objective weights. Lower combined score = better = Ovr Rank 1.
  const rankMaps = weightedObjectives.map((obj) =>
    rankDescending(playerBase.map((p) => ({ id: p.id, value: p.objectives[obj.stat].proj })))
  );

  const combinedScores = playerBase.map((p) => {
    const score = weightedObjectives.reduce((sum, obj, i) => sum + rankMaps[i].get(p.id) * obj.weight, 0);
    return { id: p.id, value: -score }; // negate: rankDescending expects "higher = better"
  });
  const ovrRankMap = rankDescending(combinedScores);

  const players = playerBase.map((p) => ({ ...p, ovrRank: ovrRankMap.get(p.id) }));
  players.sort((a, b) => a.ovrRank - b.ovrRank);

  const baseNote =
    "Live BALLDONTLIE data. YTD/L10 always reflect current form (as of today), regardless of which run date is selected. PITP (when an objective) is derived from player_game_advanced_stats.stats.misc.points_paint. Proj uses admin-uploaded Rotowire projections where available; it falls back to the L10 average only where no projection was uploaded (PITP's documented, intentional case). Weight is auto-computed from the share of players projected to clear 100% of target -- the rarer objective carries more weight.";

  const notes = [baseNote];
  for (const obj of weightedObjectives) {
    const overrides = projectionOverrides[obj.stat] || {};
    const overrideCount = Object.keys(overrides).length;
    if (overrideCount > 0) {
      const matched = playerBase.filter((p) => p.objectives[obj.stat]?.projSource === "rotowire").length;
      notes.push(
        `${obj.stat}: ${overrideCount} uploaded Rotowire projection(s), ${matched} matched a player on today's roster.`
      );
    }
  }
  if (droppedCount > 0) {
    notes.push(`NOTE: ${droppedCount} players were dropped this run to stay under the Cloudflare Free-plan subrequest limit.`);
  }
  if (recentResult.truncated || ytdResult.truncated) {
    notes.push("NOTE: game-window pagination hit its safety cap; some players' YTD/L10 windows may be based on an incomplete range.");
  }

  return {
    ...baseReturn,
    objectives: weightedObjectives,
    note: notes.join(" "),
    players,
    _subrequests_used: subrequests,
    _generated_at: new Date().toISOString(),
  };
}

async function refreshAndStore(env) {
  const dashboard = await buildDashboard(env, { date: todayStr(), mode: "Classic" });
  await env.FASTBREAK_KV.put("fastbreak:latest", JSON.stringify(dashboard));
  return dashboard;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function checkAdminToken(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  return Boolean(env.FASTBREAK_ADMIN_TOKEN) && token === env.FASTBREAK_ADMIN_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Live build for a given date/mode (defaults to today/Classic). Every hit
    // here calls BALLDONTLIE live -- this is also what the cron handler uses,
    // and what the frontend's Run day-toggle calls directly for any day in
    // the Aug 19-30 window.
    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/api/fastbreak") {
      try {
        const date = url.searchParams.get("date") || todayStr();
        const mode = url.searchParams.get("mode") || "Classic";
        const dashboard = await buildDashboard(env, { date, mode });
        if (date === todayStr() && mode === "Classic") {
          await env.FASTBREAK_KV.put("fastbreak:latest", JSON.stringify(dashboard));
        }
        return new Response(JSON.stringify(dashboard, null, 2), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Run schedule metadata (start/end/day numbers) -- lets the frontend build
    // its day toggle without hardcoding the run window.
    if (url.pathname === "/api/fastbreak/run" && request.method === "GET") {
      return new Response(
        JSON.stringify({ runStart: RUN_START, runEnd: RUN_END, runLength: dayNumberForDate(RUN_END) }),
        { headers: corsHeaders }
      );
    }

    // Admin objectives schedule: viewable by anyone (it's a locked *view*, not
    // a secret), editable only with the admin password. Real edits happen
    // through this upload/input endpoint, never by hand-editing page content.
    if (url.pathname === "/api/fastbreak/objectives" && request.method === "GET") {
      const schedule = await loadObjectivesSchedule(env);
      return new Response(JSON.stringify({ league: SUPPORTED_LEAGUE, schedule }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/fastbreak/objectives/day" && request.method === "POST") {
      if (!checkAdminToken(request, env)) {
        return new Response(JSON.stringify({ error: "Invalid or missing admin password." }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      try {
        const body = await request.json();
        const schedule = await upsertObjectivesDay(env, {
          league: body.league || SUPPORTED_LEAGUE,
          date: body.date,
          mode: body.mode || "Classic",
          objectives: body.objectives,
          badgeSetName: body.badgeSetName,
        });
        return new Response(JSON.stringify({ ok: true, schedule }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // Bulk-load real, manually-sourced (Rotowire) Proj values for one stat on
    // one date. Admin-password gated, same as the objectives/day write above.
    // Never used for PITP -- there's no Rotowire (or standard WNBA stats
    // site) projection for it, so PITP intentionally has no override entries
    // and always falls back to the L10 average in buildDashboard.
    if (url.pathname === "/api/fastbreak/objectives/day/projections" && request.method === "POST") {
      if (!checkAdminToken(request, env)) {
        return new Response(JSON.stringify({ error: "Invalid or missing admin password." }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      try {
        const body = await request.json();
        const schedule = await upsertProjections(env, {
          league: body.league || SUPPORTED_LEAGUE,
          date: body.date,
          stat: body.stat,
          projections: body.projections,
        });
        return new Response(JSON.stringify({ ok: true, schedule }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // Full Data tab: serves the cached leaguewide L10/YTD snapshot (built
    // incrementally by advanceFullDataBuild, see above). This is a plain KV
    // read -- it never calls BALLDONTLIE directly, so it's cheap regardless
    // of traffic.
    if (url.pathname === "/api/fastbreak/fulldata" && request.method === "GET") {
      const cached = await env.FASTBREAK_KV.get(FULLDATA_KV_KEY);
      if (!cached) {
        return new Response(
          JSON.stringify({ error: "Full Data hasn't finished its first build yet -- check back shortly." }),
          { status: 503, headers: corsHeaders }
        );
      }
      return new Response(cached, { headers: corsHeaders });
    }

    // Manual trigger + progress check for the Full Data build -- admin-gated
    // so public traffic can't burn subrequests forcing rebuilds. Useful for
    // kicking off (or speeding up) a build without waiting on cron ticks.
    if (url.pathname === "/api/fastbreak/fulldata/build" && request.method === "POST") {
      if (!checkAdminToken(request, env)) {
        return new Response(JSON.stringify({ error: "Invalid or missing admin password." }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      try {
        const result = await advanceFullDataBuild(env, MAX_SUBREQUESTS - 4);
        return new Response(JSON.stringify({ ok: true, ...result }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === "/api/fastbreak/fulldata/status" && request.method === "GET") {
      const state = await loadFullDataBuildState(env);
      const cachedRaw = await env.FASTBREAK_KV.get(FULLDATA_KV_KEY);
      const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
      return new Response(
        JSON.stringify({
          buildStatus: state?.status || "not started",
          pendingChunks: state?.pendingChunks?.length ?? null,
          totalPlayersCached: cached?.players?.length ?? 0,
          lastGeneratedAt: cached?.generated_at ?? null,
        }),
        { headers: corsHeaders }
      );
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    let dashboard = null;
    try {
      dashboard = await refreshAndStore(env);
    } catch (err) {
      // Best-effort: leave the previously cached KV data in place if this run
      // fails, rather than wiping out good data with a failed refresh.
      console.error("fastbreak-refresh scheduled run failed:", err.message);
    }

    // Spend whatever's left of this tick's subrequest budget advancing the
    // leaguewide Full Data build (see advanceFullDataBuild above). Reserves
    // a small margin for this tick's own KV reads/writes on top of what the
    // day-view build above already used.
    const usedByDashboard = dashboard?._subrequests_used || 0;
    const fullDataBudget = MAX_SUBREQUESTS - usedByDashboard - 4;
    if (fullDataBudget > 0) {
      try {
        await advanceFullDataBuild(env, fullDataBudget);
      } catch (err) {
        console.error("full-data build tick failed (continuing):", err.message);
      }
    }
  },
};

// Exported for local/unit testing only (not used by the Worker runtime).
export const __testables__ = {
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
  normalizePlayerName,
  upsertProjections,
  projectionsForDate,
  dayNumberForDate,
  isWithinRun,
  RUN_START,
  RUN_END,
  getGamesForDate,
  etDateStrForGame,
  addDaysStr,
  computeTeamScoring,
  advanceFullDataBuild,
  loadFullDataBuildState,
  FULLDATA_STAT_CODES,
  FULLDATA_KV_KEY,
  FULLDATA_BUILD_KV_KEY,
};
