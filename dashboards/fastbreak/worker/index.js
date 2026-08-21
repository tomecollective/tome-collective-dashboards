// tome-fastbreak
// Public-facing Worker. Serves the cached dashboard payload (built by the
// tome-fastbreak-refresh Worker on a cron schedule) and proxies the admin
// objectives-schedule endpoints from the same KV namespace. This Worker never
// calls BALLDONTLIE directly -- it only ever reads/writes FASTBREAK_KV, so it
// stays fast and cheap regardless of refresh cadence.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const OBJECTIVES_KV_KEY = "fastbreak:objectives";
const SUPPORTED_LEAGUE = "WNBA";
// Kept in sync with STAT_FIELD_MAP in the fastbreak-refresh Worker. Duplicated
// here (rather than shared via an import) because these two Workers deploy
// independently with no build step between them.
const VALID_STAT_CODES = ["PTS", "REB", "AST", "STL", "BLK", "TOV", "3PM", "3PA", "FTM", "FTA", "PITP"];

function checkAdminToken(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  return Boolean(env.FASTBREAK_ADMIN_TOKEN) && token === env.FASTBREAK_ADMIN_TOKEN;
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
    if (typeof o.weight !== "number" || o.weight <= 0) {
      throw new Error(`weight must be a positive number for ${o.stat}`);
    }
  }
  if (objectives.length === 2) {
    const sum = objectives[0].weight + objectives[1].weight;
    const wholeUnit = sum > 1.5 ? 100 : 1;
    if (Math.abs(sum - wholeUnit) > 0.05 * wholeUnit) {
      throw new Error(`objective weights must sum to ~100% (got ${sum})`);
    }
  } else {
    objectives[0] = { ...objectives[0], weight: 1 };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/api/fastbreak") {
      const cached = await env.FASTBREAK_KV.get("fastbreak:latest");
      if (!cached) {
        return new Response(
          JSON.stringify({
            error:
              "No cached data yet. The tome-fastbreak-refresh Worker populates this KV store on a cron schedule -- wait for its first run, or trigger it manually to test.",
          }),
          { status: 503, headers: corsHeaders }
        );
      }
      return new Response(cached, { headers: corsHeaders });
    }

    // Admin objectives schedule -- proxied straight through to the same KV
    // namespace the refresh Worker owns. GET is public (it's a locked *view*,
    // not a secret); POST requires the admin token.
    if (url.pathname === "/api/fastbreak/objectives" && request.method === "GET") {
      const raw = await env.FASTBREAK_KV.get(OBJECTIVES_KV_KEY);
      const schedule = raw ? JSON.parse(raw) : {};
      return new Response(JSON.stringify({ league: SUPPORTED_LEAGUE, schedule }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/fastbreak/objectives/day" && request.method === "POST") {
      if (!checkAdminToken(request, env)) {
        return new Response(JSON.stringify({ error: "Invalid or missing admin token." }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      // Forward the write to the refresh Worker's own endpoint isn't possible
      // from here without its URL wired in as a secret, so this Worker writes
      // directly to the shared KV namespace and lets the next scheduled (or
      // manually triggered) refresh pick it up on the following build.
      try {
        const body = await request.json();
        if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
          throw new Error("date must be YYYY-MM-DD");
        }
        validateObjectivesPayload(body.objectives);
        const league = body.league || SUPPORTED_LEAGUE;
        const raw = await env.FASTBREAK_KV.get(OBJECTIVES_KV_KEY);
        const schedule = raw ? JSON.parse(raw) : {};
        if (!schedule[league]) schedule[league] = {};
        const existing = schedule[league][body.date] || {};
        schedule[league][body.date] = { ...existing, objectives: body.objectives };
        await env.FASTBREAK_KV.put(OBJECTIVES_KV_KEY, JSON.stringify(schedule));
        return new Response(JSON.stringify({ ok: true, schedule }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // Bulk-load real, manually-sourced (Rotowire) Proj values for one stat on
    // one date -- same write-through-to-shared-KV pattern as the objectives
    // write above. PITP intentionally never gets an override (see the refresh
    // Worker's buildDashboard, which falls back to L10 when none exists).
    if (url.pathname === "/api/fastbreak/objectives/day/projections" && request.method === "POST") {
      if (!checkAdminToken(request, env)) {
        return new Response(JSON.stringify({ error: "Invalid or missing admin token." }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      try {
        const body = await request.json();
        if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
          throw new Error("date must be YYYY-MM-DD");
        }
        if (!body.stat || !VALID_STAT_CODES.includes(body.stat)) {
          throw new Error(`unknown stat code: ${body.stat}`);
        }
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
        const league = body.league || SUPPORTED_LEAGUE;
        const raw = await env.FASTBREAK_KV.get(OBJECTIVES_KV_KEY);
        const schedule = raw ? JSON.parse(raw) : {};
        if (!schedule[league]) schedule[league] = {};
        if (!schedule[league][body.date]) schedule[league][body.date] = { objectives: [] };
        if (!schedule[league][body.date].projections) schedule[league][body.date].projections = {};
        schedule[league][body.date].projections[body.stat] = values;
        await env.FASTBREAK_KV.put(OBJECTIVES_KV_KEY, JSON.stringify(schedule));
        return new Response(JSON.stringify({ ok: true, schedule }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
