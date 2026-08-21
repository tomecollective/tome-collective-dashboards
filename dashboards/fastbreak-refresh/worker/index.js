// tome-fastbreak-refresh
// Scheduled Worker: pulls live BALLDONTLIE data, builds the Fast Break dashboard
// payload (schedule tiles, per-objective Proj/YTD/L10 + color tiers, weighted
// Ovr Rank), and caches it in KV for the public-facing tome-fastbreak Worker to
// serve. Also owns the admin objectives schedule (viewable by anyone, editable
// only with the admin token) that this build reads from KV.

const BALLDONTLIE_BASE = "https://api.balldontlie.io/wnba/v1";
const PLAYER_CHUNK_SIZE = 10; // per_page max is 100, so 10 players * 10 games/player = 100 rows
const MAX_SUBREQUESTS = 45; // stay under Cloudflare Free plan's 50 subrequests/invocation ceiling
const RECENT_GAMES_LOOKBACK_DAYS = 45; // roughly weekly cadence + byes; combined with full
// pagination below (not just page 1), this reliably captures >=10 games/team.
const RECENT_GAMES_MAX_PAGES = 5; // safety cap on pagination (500 games) to bound subrequest cost
const YTD_MAX_PAGES = 6; // safety cap on season-long game-id pagination for YTD

// -- League / mode -----------------------------------------------------------
// Only WNBA has live data right now. NBA (season not in progress) and Historic
// (no historical pipeline built yet) are disabled in the frontend toggle; this
// worker only ever builds WNBA. `mode` (Classic/Pro) is accepted and echoed
// back but does not yet change which data is pulled -- both modes read the
// same live BALLDONTLIE pipeline today.
// TODO(mode): once Classic vs. Pro diverge in scope (e.g. Pro unlocking Top
// Shot badge/set filtering once the Cadence/Flow moment-ownership integration
// exists), branch on `mode` here.
const SUPPORTED_LEAGUE = "WNBA";

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
  "3PM": { source: "stats", field: (s) => s.fg3m, label: "3PM" },
  "3PA": { source: "stats", field: (s) => s.fg3a, label: "3PA" },
  FTM: { source: "stats", field: (s) => s.ftm, label: "FTM" },
  FTA: { source: "stats", field: (s) => s.fta, label: "FTA" },
  // PITP: points in the paint. Not a standard box-score stat -- lives under
  // player_game_advanced_stats.stats.misc.points_paint. Confirmed working
  // against the live endpoint.
  PITP: {
    source: "advanced",
    field: (a) => a.stats?.misc?.points_paint ?? a.misc?.points_paint,
    label: "PITP",
  },
};

const DEFAULT_OBJECTIVES = [{ stat: "PTS", label: "PTS", dailyTeamTarget: 80, weight: 1 }];

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

async function getTodaysGames(env) {
  const data = await bdlFetch(`/games?dates[]=${todayStr()}`, env);
  return data.data || [];
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
    if (typeof o.weight !== "number" || o.weight <= 0) {
      throw new Error(`weight must be a positive number for ${o.stat}`);
    }
  }
  if (objectives.length === 2) {
    const sum = objectives[0].weight + objectives[1].weight;
    // Weights are entered as e.g. 78.31 / 21.69 (percent) or 0.7831 / 0.2169
    // (fraction) -- accept either, just require they sum close to "whole".
    const wholeUnit = sum > 1.5 ? 100 : 1;
    if (Math.abs(sum - wholeUnit) > 0.05 * wholeUnit) {
      throw new Error(`objective weights must sum to ~100% (got ${sum})`);
    }
  }
}

function normalizeWeights(objectives) {
  if (objectives.length === 1) return [{ ...objectives[0], weight: 1 }];
  const sum = objectives[0].weight + objectives[1].weight;
  return objectives.map((o) => ({ ...o, weight: o.weight / sum }));
}

async function upsertObjectivesDay(env, { league, date, objectives }) {
  if (league !== SUPPORTED_LEAGUE) throw new Error(`unsupported league: ${league}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  validateObjectives(objectives);

  const schedule = await loadObjectivesSchedule(env);
  if (!schedule[league]) schedule[league] = {};
  schedule[league][date] = { objectives: normalizeWeights(objectives) };
  await env.FASTBREAK_KV.put(OBJECTIVES_KV_KEY, JSON.stringify(schedule));
  return schedule;
}

function objectivesForDate(schedule, league, date) {
  const entry = schedule?.[league]?.[date];
  if (entry?.objectives?.length) return normalizeWeights(entry.objectives);
  return normalizeWeights(DEFAULT_OBJECTIVES);
}

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

function formatGameTime(game) {
  // BALLDONTLIE's WNBA game rows carry a pre-tip time in `status` (e.g. "7:00
  // PM ET") until the game goes live, at which point `status` becomes an
  // in-progress marker ("in") and score fields populate. Fall back to the
  // ISO `date`/`datetime` field if `status` isn't a clock-like string.
  if (game.status && /\d/.test(game.status) && /[ap]m/i.test(game.status)) {
    return game.status;
  }
  if (game.status === "post") return "Final";
  if (game.status === "in") return "In Progress";
  const iso = game.datetime || game.date;
  if (!iso) return "TBD";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
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

async function buildDashboard(env) {
  let subrequests = 0;
  const today = todayStr();
  const schedule = await loadObjectivesSchedule(env);
  const objectives = objectivesForDate(schedule, SUPPORTED_LEAGUE, today);

  const games = await getTodaysGames(env);
  subrequests += 1;

  const teamIds = [...new Set(games.flatMap((g) => [g.home_team?.id, g.visitor_team?.id]).filter(Boolean))];
  const scheduleTiles = buildScheduleTiles(games);

  if (teamIds.length === 0) {
    return {
      dashboard_name: "Tome Edge: Fast Break",
      league: SUPPORTED_LEAGUE,
      last_updated: today,
      objectives,
      games: [],
      note: "No WNBA games scheduled today.",
      players: [],
    };
  }

  const opponentByTeam = new Map();
  for (const g of games) {
    if (g.home_team?.id && g.visitor_team) opponentByTeam.set(g.home_team.id, `vs ${g.visitor_team.abbreviation}`);
    if (g.visitor_team?.id && g.home_team) opponentByTeam.set(g.visitor_team.id, `@ ${g.home_team.abbreviation}`);
  }

  const roster = await getTeamRosters(teamIds, env);
  subrequests += 1;
  const season = currentSeason();

  // Last-10 window (existing, confirmed-working approach).
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

  // Reserve 2 subrequests per player chunk (stats + advanced, if PITP is one of
  // today's objectives). If the full player list would exceed the Free-plan
  // subrequest ceiling, trim it and say so honestly rather than silently
  // dropping players or crashing mid-run.
  const needsAdvanced = objectives.some((o) => STAT_FIELD_MAP[o.stat].source === "advanced");
  const perChunkRequests = needsAdvanced ? 2 : 1;
  const chunksNeeded = Math.ceil(playerIds.length / PLAYER_CHUNK_SIZE) * perChunkRequests;
  let droppedCount = 0;
  if (subrequests + chunksNeeded > MAX_SUBREQUESTS) {
    const maxPlayers =
      Math.floor((MAX_SUBREQUESTS - subrequests) / perChunkRequests) * PLAYER_CHUNK_SIZE;
    droppedCount = playerIds.length - maxPlayers;
    playerIds = playerIds.slice(0, Math.max(0, maxPlayers));
  }

  const playerChunks = chunk(playerIds, PLAYER_CHUNK_SIZE);
  const statsByPlayer = new Map();
  const advByPlayer = new Map();

  for (const c of playerChunks) {
    const stats = await getStatsForChunk(c, season, allGameIds, env);
    subrequests += 1;
    for (const s of stats) {
      const pid = s.player?.id ?? s.player_id;
      if (!statsByPlayer.has(pid)) statsByPlayer.set(pid, []);
      statsByPlayer.get(pid).push(s);
    }

    if (needsAdvanced) {
      const adv = await getAdvancedForChunk(c, season, allGameIds, env);
      subrequests += 1;
      for (const a of adv) {
        const pid = a.player?.id ?? a.player_id;
        if (!advByPlayer.has(pid)) advByPlayer.set(pid, []);
        advByPlayer.get(pid).push(a);
      }
    }
  }

  const rosterById = new Map(roster.map((p) => [p.id, p]));

  function rowsForObjective(stat, pid) {
    const def = STAT_FIELD_MAP[stat];
    const lines = def.source === "advanced" ? advByPlayer.get(pid) || [] : statsByPlayer.get(pid) || [];
    return { def, lines };
  }

  function statValue(def, line) {
    const v = def.field(line);
    return typeof v === "number" ? v : null;
  }

  const playerBase = playerIds.map((pid) => {
    const player = rosterById.get(pid);
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
      // TODO(projections): Proj is currently a straight L10-average
      // passthrough -- matches what's being done manually today. A real
      // projection model (weighting recent form vs. season average, back-
      // to-backs, pace/matchup context) is real sports-analytics judgment
      // that deserves its own dedicated, separately-scoped build. Do not
      // treat this as the final projection methodology.
      const proj = l10;

      const perPlayerTarget = obj.dailyTeamTarget / 5;
      objectiveValues[obj.stat] = {
        stat: obj.stat,
        label: obj.label || obj.stat,
        weight: obj.weight,
        dailyTeamTarget: obj.dailyTeamTarget,
        perPlayerTarget: round1(perPlayerTarget),
        proj,
        ytd,
        l10,
        gamesPlayedL10: l10Lines.length,
        colorProj: colorTier(proj, perPlayerTarget),
        colorYtd: colorTier(ytd, perPlayerTarget),
        colorL10: colorTier(l10, perPlayerTarget),
      };
    }

    return {
      id: pid,
      name: `${player.first_name} ${player.last_name}`,
      team: player.team?.abbreviation || "",
      opp: opponentByTeam.get(player.team?.id) || "",
      objectives: objectiveValues,
    };
  });

  // Weighted Ovr Rank: rank players within each objective by Proj (desc,
  // standard competition ranking), then combine ranks using that day's
  // objective weights. Lower combined score = better = Ovr Rank 1.
  const rankMaps = objectives.map((obj) =>
    rankDescending(playerBase.map((p) => ({ id: p.id, value: p.objectives[obj.stat].proj })))
  );

  const combinedScores = playerBase.map((p) => {
    const score = objectives.reduce((sum, obj, i) => sum + rankMaps[i].get(p.id) * obj.weight, 0);
    return { id: p.id, value: -score }; // negate: rankDescending expects "higher = better"
  });
  const ovrRankMap = rankDescending(combinedScores);

  const players = playerBase.map((p) => ({ ...p, ovrRank: ovrRankMap.get(p.id) }));
  players.sort((a, b) => a.ovrRank - b.ovrRank);

  const baseNote =
    "Live BALLDONTLIE data. YTD/L10 use trusted, client-sorted game windows (never API default ordering). PITP (when an objective) is derived from player_game_advanced_stats.stats.misc.points_paint. Proj is currently the L10 average (see TODO in worker source) -- an in-house pace/matchup/usage-adjusted model is planned as a future, separately-scoped enhancement.";

  const notes = [baseNote];
  if (droppedCount > 0) {
    notes.push(`NOTE: ${droppedCount} players were dropped this run to stay under the Cloudflare Free-plan subrequest limit.`);
  }
  if (recentResult.truncated || ytdResult.truncated) {
    notes.push("NOTE: game-window pagination hit its safety cap; some players' YTD/L10 windows may be based on an incomplete range.");
  }

  return {
    dashboard_name: "Tome Edge: Fast Break",
    league: SUPPORTED_LEAGUE,
    last_updated: today,
    objectives,
    games: scheduleTiles,
    note: notes.join(" "),
    players,
    _subrequests_used: subrequests,
    _generated_at: new Date().toISOString(),
  };
}

async function refreshAndStore(env) {
  const dashboard = await buildDashboard(env);
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

    // Manual trigger for testing -- runs the same logic as the cron handler
    // and returns the freshly built dashboard so it can be verified end to end.
    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/api/fastbreak") {
      try {
        const dashboard = await refreshAndStore(env);
        return new Response(JSON.stringify(dashboard, null, 2), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Admin objectives schedule: viewable by anyone (it's a locked *view*, not
    // a secret), editable only with the admin token. Real edits happen through
    // this upload/input endpoint, never by hand-editing page content.
    if (url.pathname === "/api/fastbreak/objectives" && request.method === "GET") {
      const schedule = await loadObjectivesSchedule(env);
      return new Response(JSON.stringify({ league: SUPPORTED_LEAGUE, schedule }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/fastbreak/objectives/day" && request.method === "POST") {
      if (!checkAdminToken(request, env)) {
        return new Response(JSON.stringify({ error: "Invalid or missing admin token." }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      try {
        const body = await request.json();
        const schedule = await upsertObjectivesDay(env, {
          league: body.league || SUPPORTED_LEAGUE,
          date: body.date,
          objectives: body.objectives,
        });
        return new Response(JSON.stringify({ ok: true, schedule }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    try {
      await refreshAndStore(env);
    } catch (err) {
      // Best-effort: leave the previously cached KV data in place if this run
      // fails, rather than wiping out good data with a failed refresh.
      console.error("fastbreak-refresh scheduled run failed:", err.message);
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
  normalizeWeights,
  validateObjectives,
  objectivesForDate,
  formatGameTime,
  pickLastNGameIdsPerTeam,
  buildDashboard,
};
