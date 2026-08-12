const BALLDONTLIE_BASE = "https://api.balldontlie.io/wnba/v1";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
};

function bdlHeaders(env) {
    return { "Authorization": env.BALLDONTLIE_API_KEY };
}

async function bdlFetch(path, env) {
    const res = await fetch(`${BALLDONTLIE_BASE}${path}`, { headers: bdlHeaders(env) });
    if (!res.ok) {
          throw new Error(`BALLDONTLIE ${path} failed: ${res.status}`);
    }
    return res.json();
}

async function getTodaysGames(env) {
    const today = new Date().toISOString().slice(0, 10);
    const data = await bdlFetch(`/games?dates[]=${today}`, env);
    return data.data || [];
}

async function getTeamPlayers(teamId, env) {
    const data = await bdlFetch(`/players?team_ids[]=${teamId}&per_page=100`, env);
    return data.data || [];
}

async function getPlayerLast10Stats(playerId, env) {
    const data = await bdlFetch(`/player_stats?player_ids[]=${playerId}&per_page=10`, env);
    return data.data || [];
}

async function getPlayerLast10Advanced(playerId, env) {
    const data = await bdlFetch(`/player_game_advanced_stats?player_ids[]=${playerId}&per_page=10`, env);
    return data.data || [];
}

function average(nums) {
    if (!nums.length) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export default {
    async fetch(request, env) {
          const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/api/fastbreak") {
              try {
                        const games = await getTodaysGames(env);
                        const teamIds = new Set();
                        games.forEach((g) => {
                                    if (g.home_team?.id) teamIds.add(g.home_team.id);
                                    if (g.visitor_team?.id) teamIds.add(g.visitor_team.id);
                        });

                const players = [];
                        for (const teamId of teamIds) {
                                    const teamPlayers = await getTeamPlayers(teamId, env);
                                    for (const player of teamPlayers) {
                                                  const statLines = await getPlayerLast10Stats(player.id, env);
                                                  const advLines = await getPlayerLast10Advanced(player.id, env);

                                      const pts = average(statLines.map((s) => s.pts || 0));
                                                  const pitp = average(advLines.map((a) => a.misc?.points_paint || 0));

                                      players.push({
                                                      name: `${player.first_name} ${player.last_name}`,
                                                      team: player.team?.abbreviation || "",
                                                      l10: Math.round(pts * 10) / 10,
                                                      pitp_l10: Math.round(pitp * 10) / 10,
                                                      gamesPlayed: statLines.length,
                                      });
                                    }
                        }

                                                return new Response(
                                                            JSON.stringify({
                                                                          dashboard_name: "Tome Edge: Fast Break",
                                                                          last_updated: new Date().toISOString().slice(0, 10),
                                                                          objective: "PTS",
                                                                          note: "Live BALLDONTLIE data. PITP derived from player_game_advanced_stats.misc.points_paint, averaged over last 10 games.",
                                                                          players,
                                                            }),
                                                  { headers: corsHeaders }
                                                          );
              } catch (err) {
                        return new Response(JSON.stringify({ error: err.message }), {
                                    status: 500,
                                    headers: corsHeaders,
                        });
              }
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });
    },
};
