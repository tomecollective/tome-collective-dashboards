const BALLDONTLIE_BASE = "https://api.balldontlie.io/wnba/v1";
const PLAYER_CHUNK_SIZE = 10; // per_page max is 100, so 10 players * 10 games/player = 100 rows
const MAX_SUBREQUESTS = 45; // stay under Cloudflare Free plan's 50 subrequests/invocation ceiling
const RECENT_GAMES_LOOKBACK_DAYS = 45; // roughly weekly cadence + byes; combined with full
// pagination below (not just page 1), this reliably captures >=10 games/team.
const RECENT_GAMES_MAX_PAGES = 5; // safety cap on pagination (500 games) to bound subrequest cost

function bdlHeaders(env) {
  return { "Authorization": env.BALLDONTLIE_API_KEY };
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

async function getTodaysGames(env) {
  const today = new Date().toISOString().slice(0, 10);
  const data = await bdlFetch(`/games?dates[]=${today}`, env);
  return data.data || [];
}

async function getTeamRosters(teamIds, env) {
  // Live-confirmed: plain /players returns every player EVER on a team, sorted
// oldest-first by id. With per_page=100, teams with a long history fill the
// page with retired/legacy players (e.g. a 2008-season entry) before ever
// reaching current roster members -- this was silently starving the L10 fix of
// any real 2026 data. /players/active returns only currently active players.
const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");
  const data = await bdlFetch(`/players/active?${qs}&per_page=100`, env);
  return data.data || [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Batched call(s) across ALL relevant teams to get real recent games we trust, so we
// can sort/pick "last 10" ourselves instead of relying on default API ordering again.
// Live-confirmed bug: this endpoint returns games OLDEST-FIRST and caps at per_page=100.
// A single page silently truncates the most recent games off the end once the window
// contains >100 combined games across all of today's teams -- widening the lookback
// window alone made this WORSE (more old games competing for the same 100 slots), not
// better. Fix: follow meta.next_cursor and fetch every page in the window (capped at
// RECENT_GAMES_MAX_PAGES as a subrequest-budget safety valve), then sort ourselves.
async function getRecentGamesForTeams(teamIds, env) {
  const end = new Date();
  const start = new Date(end.getTime() - RECENT_GAMES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");

let games = [];
  let cursor = null;
  let requestsUsed = 0;
  let truncated = false;

for (let page = 0; page < RECENT_GAMES_MAX_PAGES; page++) {
  const cursorQs = cursor != null ? `&cursor=${cursor}` : "";
  const data = await bdlFetch(`/games?${qs}&start_date=${startStr}&end_date=${endStr}&per_page=100${cursorQs}`, env);
  requestsUsed += 1;
  const pageData = data.data || [];
  games = games.concat(pageData);
  const nextCursor = data.meta?.next_cursor;
  if (!nextCursor || pageData.length < 100) {
    cursor = null;
    break;
  }
  cursor = nextCursor;
  if (page === RECENT_GAMES_MAX_PAGES - 1) truncated = true;
}

return { games, requestsUsed, truncated };
}

// Group by team, sort each team's games by date descending ourselves (never trust
// API default ordering), take the most recent 10 completed games per team.
function pickLast10GameIdsPerTeam(recentGames, teamIds) {
  const byTeam = new Map(teamIds.map((id) => [id, []]));
  for (const g of recentGames) {
    // Live-confirmed: BALLDONTLIE uses "post" (not "Final") for completed games,
  // "in" for in-progress, "pre" for upcoming. Only completed games count for L10.
  if (g.status && g.status !== "post") continue;
    const homeId = g.home_team?.id;
    const visId = g.visitor_team?.id;
    if (homeId && byTeam.has(homeId)) byTeam.get(homeId).push(g);
    if (visId && byTeam.has(visId)) byTeam.get(visId).push(g);
  }
  const gameIds = new Set();
  for (const [, teamGames] of byTeam) {
    teamGames.sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const g of teamGames.slice(0, 10)) gameIds.add(g.id);
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
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Defensive: even with explicit game_ids[] filtering upstream, sort each player's
// returned rows by game date descending and cap at 10 before averaging. Belt-and-
// suspenders against ever trusting an API's default ordering again.
function last10ByDate(lines) {
  return [...lines]
  .sort((a, b) => new Date(b.game?.date || 0) - new Date(a.game?.date || 0))
  .slice(0, 10);
}

async function buildDashboard(env) {
  let subrequests = 0;

const games = await getTodaysGames(env);
  subrequests += 1;

const teamIds = [...new Set(games.flatMap((g) => [g.home_team?.id, g.visitor_team?.id]).filter(Boolean))];

if (teamIds.length === 0) {
  return {
    dashboard_name: "Tome Edge: Fast Break",
    last_updated: new Date().toISOString().slice(0, 10),
    objective: "PTS",
    note: "No WNBA games scheduled today.",
    players: [],
  };
}

const roster = await getTeamRosters(teamIds, env);
  subrequests += 1;

const recentGamesResult = await getRecentGamesForTeams(teamIds, env);
  subrequests += recentGamesResult.requestsUsed;
  const last10GameIds = pickLast10GameIdsPerTeam(recentGamesResult.games, teamIds);
  const season = currentSeason();

let playerIds = [...new Set(roster.map((p) => p.id))];

// Reserve 2 subrequests per player chunk (stats + advanced). If the full player
// list would exceed the Free-plan subrequest ceiling, trim it and say so honestly
// rather than silently dropping players or crashing mid-run.
const chunksNeeded = Math.ceil(playerIds.length / PLAYER_CHUNK_SIZE) * 2;
  let droppedCount = 0;
  if (subrequests + chunksNeeded > MAX_SUBREQUESTS) {
    const maxPlayers = Math.floor((MAX_SUBREQUESTS - subrequests) / 2) * PLAYER_CHUNK_SIZE;
    droppedCount = playerIds.length - maxPlayers;
    playerIds = playerIds.slice(0, maxPlayers);
  }

const playerChunks = chunk(playerIds, PLAYER_CHUNK_SIZE);

const statsByPlayer = new Map();
  const advByPlayer = new Map();

for (const c of playerChunks) {
  const stats = await getStatsForChunk(c, season, last10GameIds, env);
  subrequests += 1;
  for (const s of stats) {
    const pid = s.player?.id ?? s.player_id;
    if (!statsByPlayer.has(pid)) statsByPlayer.set(pid, []);
    statsByPlayer.get(pid).push(s);
  }

  const adv = await getAdvancedForChunk(c, season, last10GameIds, env);
  subrequests += 1;
  for (const a of adv) {
    const pid = a.player?.id ?? a.player_id;
    if (!advByPlayer.has(pid)) advByPlayer.set(pid, []);
    advByPlayer.get(pid).push(a);
  }
}

const rosterById = new Map(roster.map((p) => [p.id, p]));

const players = playerIds.map((pid) => {
  const player = rosterById.get(pid);
  const statLines = last10ByDate(statsByPlayer.get(pid) || []);
  const advLines = last10ByDate(advByPlayer.get(pid) || []);
  const pts = average(statLines.map((s) => s.pts || 0));
  // Schema has advanced metrics nested under `stats`; fall back to the old flat
                              // path defensively in case older rows or a schema variant lack the nesting.
                              const pitp = average(advLines.map((a) => a.stats?.misc?.points_paint ?? a.misc?.points_paint ?? 0));
  return {
    name: `${player.first_name} ${player.last_name}`,
    team: player.team?.abbreviation || "",
    l10: Math.round(pts * 10) / 10,
    pitp_l10: Math.round(pitp * 10) / 10,
    gamesPlayed: statLines.length,
  };
});

const baseNote =
  "Live BALLDONTLIE data. PITP derived from player_game_advanced_stats.stats.misc.points_paint, averaged over the last 10 completed games (game_ids derived from trusted schedule data, sorted and capped client-side, scoped to the current season).";

const notes = [baseNote];
  if (droppedCount > 0) {
    notes.push(`NOTE: ${droppedCount} players were dropped this run to stay under the Cloudflare Free-plan subrequest limit.`);
  }
  if (recentGamesResult.truncated) {
    notes.push(`NOTE: recent-games pagination hit its ${RECENT_GAMES_MAX_PAGES}-page safety cap; some teams' last-10 game selection may be based on an incomplete window.`);
  }

return {
  dashboard_name: "Tome Edge: Fast Break",
  last_updated: new Date().toISOString().slice(0, 10),
  objective: "PTS",
  note: notes.join(" "),
  players,
  _subrequests_used: subrequests,
  _recent_games_pages_used: recentGamesResult.requestsUsed,
  _generated_at: new Date().toISOString(),
};
}

async function refreshAndStore(env) {
  const dashboard = await buildDashboard(env);
  await env.FASTBREAK_KV.put("fastbreak:latest", JSON.stringify(dashboard));
  return dashboard;
}

export default {
  async fetch(request, env) {
    // Manual trigger for testing -- runs the same logic as the cron handler and
  // returns the freshly built dashboard so you can verify it end to end.
  try {
    const dashboard = await refreshAndStore(env);
    return new Response(JSON.stringify(dashboard, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  },

  async scheduled(event, env, ctx) {
    try {
      await refreshAndStore(env);
    } catch (err) {
      // Best-effort: leave the previously cached KV data in place if this run fails,
    // rather than wiping out good data with a failed refresh.
    console.error("fastbreak-refresh scheduled run failed:", err.message);
    }
  },
};
