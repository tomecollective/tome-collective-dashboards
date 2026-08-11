const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba";
const ESPN_GAMELOG_BASE = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes";

// Confirmed working live tonight, no API key required:
//   - /scoreboard              -> today's games + team IDs
//   - /teams/{id}/roster       -> player IDs for a team
//   - athletes/{id}/gamelog    -> per-game stat rows for L10/YTD averaging
// This is the same underlying source the open-source `wehoop` project wraps.
// Unofficial/undocumented endpoint - stable in practice, but no vendor SLA.

async function getTodaysTeamIds() {
  const res = await fetch(`${ESPN_BASE}/scoreboard`);
  const data = await res.json();
  const teamIds = new Set();
  (data.events || []).forEach(e => {
    (e.competitions?.[0]?.competitors || []).forEach(c => teamIds.add(c.team.id));
  });
  return [...teamIds];
}

async function getRoster(teamId) {
  const res = await fetch(`${ESPN_BASE}/teams/${teamId}/roster`);
  const data = await res.json();
  return data.athletes || [];
}

async function getPlayerAverages(playerId) {
  const res = await fetch(`${ESPN_GAMELOG_BASE}/${playerId}/gamelog`);
  const data = await res.json();
  const labels = data.labels || [];
  const minIdx = labels.indexOf("MIN");
  const ptsIdx = labels.indexOf("PTS");
  const rebIdx = labels.indexOf("REB");
  const astIdx = labels.indexOf("AST");

  // Regular season events only, most recent season type
  const regSeason = (data.seasonTypes || []).find(st => st.displayName?.includes("Regular"));
  const events = regSeason?.categories?.[0]?.events || [];
  if (!events.length) return null;

  const toNum = v => parseFloat(v) || 0;
  const avg = idx => events.reduce((sum, e) => sum + toNum(e.stats[idx]), 0) / events.length;
  const last10 = events.slice(0, 10);
  const avgLast10 = idx => last10.reduce((sum, e) => sum + toNum(e.stats[idx]), 0) / last10.length;

  return {
    gamesPlayed: events.length,
    ytd: { min: avg(minIdx), pts: avg(ptsIdx), reb: avg(rebIdx), ast: avg(astIdx) },
    l10: { min: avgLast10(minIdx), pts: avgLast10(ptsIdx), reb: avgLast10(rebIdx), ast: avgLast10(astIdx) },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/fastbreak") {
      try {
        const teamIds = await getTodaysTeamIds();
        if (!teamIds.length) {
          return new Response(JSON.stringify({ players: [], note: "No games today" }), { headers: corsHeaders });
        }

        // Prototype scope: first team playing today only, to keep this fast
        // and stay well under free-tier request limits while testing tonight.
        // Expand to all teamIds once this is confirmed working end to end -
        // each additional team adds ~13 gamelog fetches (one per roster spot).
        const roster = await getRoster(teamIds[0]);
        const players = [];
        for (const athlete of roster.slice(0, 8)) {
          const stats = await getPlayerAverages(athlete.id);
          if (!stats) continue;
          players.push({
            name: athlete.displayName,
            team: teamIds[0],
            opp: teamIds[1] || "TBD",
            proj: null, // in-house projection model, not built yet - see conversation
            ytd: Math.round(stats.ytd.pts * 10) / 10,
            l10: Math.round(stats.l10.pts * 10) / 10,
            gamesPlayed: stats.gamesPlayed,
          });
        }

        return new Response(JSON.stringify({
          dashboard_name: "Tome Edge: Fast Break",
          last_updated: new Date().toISOString().slice(0, 10),
          objective: "PTS",
          note: "Live ESPN data. PITP not yet derived - needs shot-location data from play-by-play, not in standard box score labels. Proj not yet built - in-house pace/matchup model, see conversation.",
          players,
        }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
