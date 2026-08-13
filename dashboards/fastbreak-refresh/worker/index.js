const BALLDONTLIE_BASE = "https://api.balldontlie.io/wnba/v1";
const PLAYER_CHUNK_SIZE = 10; // per_page max is 100, so 10 players * 10 games/player = 100 rows
const MAX_SUBREQUESTS = 45; // stay under Cloudflare Free plan's 50 subrequests/invocation ceiling

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

async function getTodaysGames(env) {
  const today = new Date().toISOString().slice(0, 10);
  const data = await bdlFetch(`/games?dates[]=${today}`, env);
  return data.data || [];
}

async function getTeamRosters(teamIds, env) {
  const qs = teamIds.map((id) => `team_ids[]=${id}`).join("&");
  const data = await bdlFetch(`/players?${qs}&per_page=100`, env);
  return data.data || [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getStatsForChunk(playerIds, env) {
  const qs = playerIds.map((id) => `player_ids[]=${id}`).join("&");
  const data = await bdlFetch(`/player_stats?${qs}&per_page=100`, env);
  return data.data || [];
}

async function getAdvancedForChunk(playerIds, env) {
  const qs = playerIds.map((id) => `player_ids[]=${id}`).join("&");
  const data = await bdlFetch(`/player_game_advanced_stats?${qs}&per_page=100`, env);
  return data.data || [];
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
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
    const stats = await getStatsForChunk(c, env);
    subrequests += 1;
    for (const s of stats) {
      const pid = s.player?.id ?? s.player_id;
      if (!statsByPlayer.has(pid)) statsByPlayer.set(pid, []);
      statsByPlayer.get(pid).push(s);
    }

    const adv = await getAdvancedForChunk(c, env);
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
    const statLines = statsByPlayer.get(pid) || [];
    const advLines = advByPlayer.get(pid) || [];
    const pts = average(statLines.map((s) => s.pts || 0));
    const pitp = average(advLines.map((a) => a.misc?.points_paint || 0));
    return {
      name: `${player.first_name} ${player.last_name}`,
      team: player.team?.abbreviation || "",
      l10: Math.round(pts * 10) / 10,
      pitp_l10: Math.round(pitp * 10) / 10,
      gamesPlayed: statLines.length,
    };
  });

  const baseNote =
    "Live BALLDONTLIE data. PITP derived from player_game_advanced_stats.misc.points_paint, averaged over last 10 games.";

  return {
    dashboard_name: "Tome Edge: Fast Break",
    last_updated: new Date().toISOString().slice(0, 10),
    objective: "PTS",
    note:
      droppedCount > 0
        ? `${baseNote} NOTE: ${droppedCount} players were dropped this run to stay under the Cloudflare Free-plan subrequest limit.`
        : baseNote,
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
