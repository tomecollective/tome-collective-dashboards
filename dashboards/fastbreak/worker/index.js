// tome-fastbreak
// Public-facing Worker. Serves the cached dashboard payload (built by the
// tome-fastbreak-refresh Worker on a cron schedule) and proxies the admin
// objectives-schedule endpoints from the same KV namespace. This Worker never
// calls BALLDONTLIE directly -- it only ever reads/writes FASTBREAK_KV, so it
// stays fast and cheap regardless of refresh cadence.
//
// NOTE: the frontend's live per-day/per-mode Run views call the
// tome-fastbreak-refresh Worker directly (it can build any date on demand).
// This Worker remains a cheap fallback that serves whatever the refresh
// Worker's cron last cached for a league (today, Classic).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const OBJECTIVES_KV_KEY = "fastbreak:objectives";
// Kept in sync with LEAGUES[].keys.latest / STAT_FIELD_MAP in the refresh
// Worker. Duplicated here (rather than shared via an import) because these
// two Workers deploy independently with no build step between them.
const LATEST_KEYS = { WNBA: "fastbreak:latest", NBA: "fastbreak:nba:latest" };
const SUPPORTED_LEAGUES = Object.keys(LATEST_KEYS);
const DEFAULT_LEAGUE = "WNBA";
const SUPPORTED_MODES = ["Classic", "Pro"];
const VALID_STAT_CODES = ["PTS", "REB", "AST", "STL", "BLK", "TOV", "FGM", "FGA", "3PM", "3PA", "FTM", "FTA", "OREB", "PITP"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function checkAdminToken(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  return Boolean(env.FASTBREAK_ADMIN_TOKEN) && token === env.FASTBREAK_ADMIN_TOKEN;
}

function normalizeLeague(raw) {
  const league = String(raw || DEFAULT_LEAGUE).toUpperCase();
  if (!SUPPORTED_LEAGUES.includes(league)) throw new Error(`league must be one of ${SUPPORTED_LEAGUES.join(", ")}`);
  return league;
}

function validateObjectivesPayload(objectives) {
  if (!Array.isArray(objectives) || objectives.length < 1 || objectives.length > 2) {
    throw new Error("objectives must be an array of 1 or 2 entries");
  }
  for (const o of objectives) {
    if (!o.stat || !VALID_STAT_CODES.includes(o.stat)) throw new Error(`unknown stat code: ${o.stat}`);
    if (typeof o.dailyTeamTarget !== "number" || o.dailyTeamTarget <= 0) {
      throw new Error(`dailyTeamTarget must be a positive number for ${o.stat}`);
    }
  }
}

async function loadSchedule(env) {
  const raw = await env.FASTBREAK_KV.get(OBJECTIVES_KV_KEY);
  return raw ? JSON.parse(raw) : {};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/api/fastbreak") {
      let league;
      try {
        league = normalizeLeague(url.searchParams.get("league"));
      } catch (err) {
        return json({ error: err.message }, 400);
      }
      const cached = await env.FASTBREAK_KV.get(LATEST_KEYS[league]);
      if (!cached) {
        return json(
          {
            error: `No cached ${league} data yet. The tome-fastbreak-refresh Worker populates this KV store on a cron schedule -- wait for its first run, or trigger it manually to test.`,
          },
          503
        );
      }
      return new Response(cached, { headers: corsHeaders });
    }

    // Objectives schedule -- same KV object the refresh Worker owns, keyed
    // by league then date. GET is public; POST requires the admin password.
    if (url.pathname === "/api/fastbreak/objectives" && request.method === "GET") {
      const schedule = await loadSchedule(env);
      return json({ leagues: SUPPORTED_LEAGUES, modes: SUPPORTED_MODES, schedule });
    }

    if (url.pathname === "/api/fastbreak/objectives/day" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return json({ error: "Invalid or missing admin password." }, 401);
      try {
        const body = await request.json();
        if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error("date must be YYYY-MM-DD");
        const mode = body.mode || "Classic";
        if (!SUPPORTED_MODES.includes(mode)) throw new Error(`mode must be one of ${SUPPORTED_MODES.join(", ")}`);
        validateObjectivesPayload(body.objectives);
        const league = normalizeLeague(body.league);
        const schedule = await loadSchedule(env);
        if (!schedule[league]) schedule[league] = {};
        const existing = schedule[league][body.date] || {};
        const existingObjectives = existing.objectives || {};
        const cleanObjectives = body.objectives.map(({ stat, label, dailyTeamTarget }) => ({
          stat,
          label: label || stat,
          dailyTeamTarget,
        }));
        schedule[league][body.date] = {
          ...existing,
          objectives: { ...existingObjectives, [mode]: cleanObjectives },
          badgeSetName: mode === "Pro" && body.badgeSetName ? body.badgeSetName : existing.badgeSetName || null,
        };
        await env.FASTBREAK_KV.put(OBJECTIVES_KV_KEY, JSON.stringify(schedule));
        return json({ ok: true, schedule });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    // Rotowire projections for one stat on one league/date (shared by that
    // league's Classic and Pro). PITP never gets an override (L10 fallback).
    if (url.pathname === "/api/fastbreak/objectives/day/projections" && request.method === "POST") {
      if (!checkAdminToken(request, env)) return json({ error: "Invalid or missing admin password." }, 401);
      try {
        const body = await request.json();
        if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error("date must be YYYY-MM-DD");
        if (!body.stat || !VALID_STAT_CODES.includes(body.stat)) throw new Error(`unknown stat code: ${body.stat}`);
        if (!Array.isArray(body.projections) || !body.projections.length) {
          throw new Error("projections must be a non-empty array of {name, value}");
        }
        const values = {};
        for (const p of body.projections) {
          if (!p || !p.name || typeof p.value !== "number" || Number.isNaN(p.value)) {
            throw new Error(`each projection needs a name and a numeric value (got ${JSON.stringify(p)})`);
          }
          values[String(p.name).trim().toLowerCase().replace(/\s+/g, " ")] = { name: p.name, value: p.value };
        }
        const league = normalizeLeague(body.league);
        const schedule = await loadSchedule(env);
        if (!schedule[league]) schedule[league] = {};
        if (!schedule[league][body.date]) schedule[league][body.date] = { objectives: {} };
        if (!schedule[league][body.date].projections) schedule[league][body.date].projections = {};
        schedule[league][body.date].projections[body.stat] = values;
        await env.FASTBREAK_KV.put(OBJECTIVES_KV_KEY, JSON.stringify(schedule));
        return json({ ok: true, schedule });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
