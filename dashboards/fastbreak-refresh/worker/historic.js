// historic.js
// ------------------------------------------------------------------
// NBA Historic mode for Fast Break. Historic has no live game feed --
// unlike WNBA Classic/Pro (buildDashboard in index.js, backed by
// BALLDONTLIE), it runs on a simulated season seeded from last
// season's fastbreak_historic_stats sheet (see the "Historic Fast
// Break Pipeline" spec + prototype pipeline shared alongside this
// PR). This module ports that Node prototype into the Worker: same
// math (average/round1/tierColor mirror the WNBA worker's
// average/round1/colorTier exactly), same shape of output, but reads
// from KV instead of a live API and instead of local JSON files.
//
// All state lives under the "fastbreak:historic:*" KV key prefix, so
// none of this can collide with or affect the existing WNBA keys
// (fastbreak:latest, fastbreak:objectives, fastbreak:fulldata, ...)
// in the same FASTBREAK_KV namespace.
//
// KV layout:
//   fastbreak:historic:players     -> [{ player_id, name, team, active, reference_szn }]
//   fastbreak:historic:schedule    -> [{ day, date, matchups: [[team,team], ...] }]
//   fastbreak:historic:objectives  -> [{ day, date, objectives: [{type, dailyTeamTarget}] }]
//   fastbreak:historic:boxscores   -> [{ day, date, player_id, team, opp, stats }]  (append-only)
//   fastbreak:historic:day         -> { current: <int> }  (which day is "today" for the public view)
//
// None of this is wired into buildDashboard/refreshAndStore/the cron
// scheduled() handler in index.js -- see the two small call-outs in
// index.js's fetch() and scheduled() for the only integration points.

const HISTORIC_PLAYERS_KEY = "fastbreak:historic:players";
const HISTORIC_SCHEDULE_KEY = "fastbreak:historic:schedule";
const HISTORIC_OBJECTIVES_KEY = "fastbreak:historic:objectives";
const HISTORIC_BOXSCORES_KEY = "fastbreak:historic:boxscores";
const HISTORIC_DAY_KEY = "fastbreak:historic:day";

const STAT_MAP = {
  PTS: "pts", REB: "reb", OREB: "oreb", DREB: "dreb", AST: "ast",
  STL: "stl", BLK: "blk", TOV: "tov", PF: "pf", PITP: "pitp",
  FGM: "fgm", FGA: "fga", FTM: "ftm", FTA: "fta",
  "3PM": "fg3m", "3PA": "fg3a",
};
const SIM_STAT_KEYS = [
  "pts", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta",
  "reb", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf", "pitp",
];

function round1(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}
function average(nums) {
  const v = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
// Same >=125/100/90/75% tiers as WNBA's colorTier in index.js -- kept as an
// independent copy here (rather than importing it) so historic.js stays a
// single self-contained module that's easy to lift out later.
function tierColor(value, perPlayerTarget) {
  if (value == null || !perPlayerTarget) return null;
  const pct = value / perPlayerTarget;
  if (pct >= 1.25) return "dark-green";
  if (pct >= 1.0) return "light-green";
  if (pct >= 0.9) return "yellow";
  if (pct >= 0.75) return "light-yellow";
  return null;
}

// Cloudflare Workers' JS runtime has no seedable Math.random, so use the
// same tiny deterministic PRNG as the prototype pipeline -- re-running the
// same day with the same seed reproduces the same boxscores, which is what
// makes this safe to re-invoke without drifting the "season" on retries.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Samples one game's line around a player's reference_szn baseline.
// Triangular-ish jitter (sum of 3 uniforms) keeps most games close to the
// mean with occasional bigger/off nights. See the pipeline README for
// rationale -- this is a defensible starting model, not a final one.
function simulateLine(baseline, rng) {
  const line = {};
  for (const key of SIM_STAT_KEYS) {
    const mean = baseline[key] ?? 0;
    if (mean === 0) {
      line[key] = 0;
      continue;
    }
    const noise = (rng() + rng() + rng() - 1.5) / 1.5;
    const jitterPct = key === "pts" || key === "reb" || key === "ast" ? 0.28 : 0.35;
    line[key] = Math.max(0, round1(mean * (1 + noise * jitterPct)));
  }
  line.fgm = Math.min(line.fgm, line.fga);
  line.fg3m = Math.min(line.fg3m, line.fg3a);
  line.ftm = Math.min(line.ftm, line.fta);
  line.oreb = Math.min(line.oreb, line.reb);
  return line;
}

async function getJSON(env, key, fallback) {
  const raw = await env.FASTBREAK_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function putJSON(env, key, value) {
  await env.FASTBREAK_KV.put(key, JSON.stringify(value));
}

async function getCurrentHistoricDay(env) {
  const state = await getJSON(env, HISTORIC_DAY_KEY, { current: 1 });
  return state.current;
}
async function setCurrentHistoricDay(env, day) {
  await putJSON(env, HISTORIC_DAY_KEY, { current: day });
}

// Stage 1: simulate one day's box scores and append them to
// fastbreak:historic:boxscores. Idempotent per day -- if that day is
// already present, this is a no-op (never re-rolls a day that's been
// simulated, same append-only rule as the prototype pipeline).
async function simulateHistoricDay(env, day) {
  const players = (await getJSON(env, HISTORIC_PLAYERS_KEY, [])).filter(
    (p) => p.active && p.reference_szn
  );
  const schedule = await getJSON(env, HISTORIC_SCHEDULE_KEY, []);
  const daySchedule = schedule.find((s) => s.day === day);
  if (!daySchedule) {
    return { ok: false, error: `No schedule entry for day ${day}` };
  }

  const boxscores = await getJSON(env, HISTORIC_BOXSCORES_KEY, []);
  if (boxscores.some((r) => r.day === day)) {
    return { ok: true, alreadySimulated: true, day };
  }

  const playersByTeam = new Map();
  for (const p of players) {
    if (!playersByTeam.has(p.team)) playersByTeam.set(p.team, []);
    playersByTeam.get(p.team).push(p);
  }

  // Seed varies by day so different days don't replay identical noise, but
  // stays fixed per day so re-simulating (accidentally hitting an already-
  // simulated day, which the guard above blocks anyway) would reproduce.
  const rng = mulberry32(424242 + day * 97);

  let added = 0;
  for (const [teamA, teamB] of daySchedule.matchups) {
    for (const [team, opp] of [[teamA, teamB], [teamB, teamA]]) {
      for (const player of playersByTeam.get(team) || []) {
        boxscores.push({
          day,
          date: daySchedule.date || null,
          player_id: player.player_id,
          team,
          opp,
          stats: simulateLine(player.reference_szn, rng),
        });
        added += 1;
      }
    }
  }

  await putJSON(env, HISTORIC_BOXSCORES_KEY, boxscores);
  return { ok: true, day, added };
}

function computeYTD(rowsForPlayer, statKey, throughDay) {
  const rows = rowsForPlayer.filter((r) => r.day <= throughDay);
  return round1(average(rows.map((r) => r.stats[statKey])));
}
function computeL10(rowsForPlayer, statKey, throughDay) {
  const rows = rowsForPlayer
    .filter((r) => r.day <= throughDay)
    .sort((a, b) => b.day - a.day)
    .slice(0, 10);
  return round1(average(rows.map((r) => r.stats[statKey])));
}

// Stages 2-4: read boxscores + that day's objectives, compute YTD/L10 per
// player per objective stat, tier-color each, rank players. Output shape
// intentionally mirrors buildDashboard()'s WNBA payload (objectives/games/
// players/note) so the existing frontend table rendering needs no new
// parsing logic -- see the PR description for the couple of fields that
// differ (no injuries/badge/proj-source-rotowire, since none of that
// applies to a simulated season).
async function buildHistoricDashboard(env, { day } = {}) {
  const players = await getJSON(env, HISTORIC_PLAYERS_KEY, []);
  const schedule = await getJSON(env, HISTORIC_SCHEDULE_KEY, []);
  const objectivesByDay = new Map(
    (await getJSON(env, HISTORIC_OBJECTIVES_KEY, [])).map((o) => [o.day, o])
  );
  const boxscores = await getJSON(env, HISTORIC_BOXSCORES_KEY, []);

  const targetDay = day || (await getCurrentHistoricDay(env));
  const todaysObjectives = objectivesByDay.get(targetDay);
  const todaysSchedule = schedule.find((s) => s.day === targetDay);

  if (!todaysObjectives || !todaysSchedule) {
    return {
      dashboard_name: "Fast Break Dashboard",
      league: "NBA",
      mode: "Historic",
      day: targetDay,
      objectives: [],
      games: [],
      players: [],
      note: `No historic data found for day ${targetDay}. Run /api/fastbreak/historic/advance to simulate it first.`,
    };
  }

  const opponentByTeam = new Map();
  const scheduleTiles = [];
  for (const [a, b] of todaysSchedule.matchups) {
    opponentByTeam.set(a, b);
    opponentByTeam.set(b, a);
    scheduleTiles.push({ awayAbbr: b, homeAbbr: a, status: "post", time: "Final" });
  }

  const rowsByPlayer = new Map();
  for (const row of boxscores) {
    if (!rowsByPlayer.has(row.player_id)) rowsByPlayer.set(row.player_id, []);
    rowsByPlayer.get(row.player_id).push(row);
  }

  const activePlayers = players.filter((p) => p.active);
  const playerRows = [];
  for (const player of activePlayers) {
    const opp = opponentByTeam.get(player.team);
    if (!opp) continue;
    const rows = rowsByPlayer.get(player.player_id) || [];

    const objectiveValues = {};
    for (const obj of todaysObjectives.objectives) {
      const statKey = STAT_MAP[obj.type];
      if (!statKey) continue;
      const perPlayerTarget = round1(obj.dailyTeamTarget / 5);
      const ytd = computeYTD(rows, statKey, targetDay);
      const l10 = computeL10(rows, statKey, targetDay);
      const proj = l10; // no external projection source for a simulated season
      objectiveValues[obj.type] = {
        stat: obj.type,
        label: obj.type,
        dailyTeamTarget: obj.dailyTeamTarget,
        perPlayerTarget,
        proj,
        projSource: "l10-fallback",
        ytd,
        l10,
        colorProj: tierColor(proj, perPlayerTarget),
        colorYtd: tierColor(ytd, perPlayerTarget),
        colorL10: tierColor(l10, perPlayerTarget),
      };
    }

    playerRows.push({
      id: player.player_id,
      name: player.name,
      team: player.team,
      opp: `vs ${opp}`,
      objectives: objectiveValues,
    });
  }

  // Ovr Rank: equal-weight average of L10-vs-target% across today's
  // objectives. WNBA's computeAutoWeights (share of players clearing 100%)
  // is worth porting once there's a real multi-day run to weight against --
  // noted in the pipeline README as a follow-up, not done here.
  const scored = playerRows.map((p) => {
    const pcts = Object.values(p.objectives)
      .filter((o) => o.perPlayerTarget)
      .map((o) => (o.l10 ?? 0) / o.perPlayerTarget);
    const score = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
    return { ...p, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);
  scored.forEach((p, i) => (p.ovrRank = i + 1));
  scored.forEach((p) => delete p._score);

  return {
    dashboard_name: "Fast Break Dashboard",
    league: "NBA",
    mode: "Historic",
    day: targetDay,
    date: todaysSchedule.date || todaysObjectives.date || null,
    objectives: todaysObjectives.objectives.map((o) => ({ stat: o.type, label: o.type, dailyTeamTarget: o.dailyTeamTarget })),
    games: scheduleTiles,
    players: scored,
    note:
      "Simulated NBA Historic season -- players are last season's historic-player-pool assignments (see fastbreak_historic_stats sheet), box scores are generated around each player's real full-season baseline, not live data. YTD/L10 are computed the same way as WNBA Classic/Pro, just from simulated box scores instead of BALLDONTLIE.",
  };
}

// Seeds players/schedule/objectives from an admin-supplied payload (the
// build_players.js/build_schedule.js/build_objectives.js output from the
// prototype pipeline, pasted in as JSON). Additive/overwrite-in-place on
// the historic:* keys only -- never touches any WNBA key.
async function seedHistoric(env, { players, schedule, objectives }) {
  if (players) await putJSON(env, HISTORIC_PLAYERS_KEY, players);
  if (schedule) await putJSON(env, HISTORIC_SCHEDULE_KEY, schedule);
  if (objectives) await putJSON(env, HISTORIC_OBJECTIVES_KEY, objectives);
  return {
    ok: true,
    playersLoaded: players ? players.length : null,
    scheduleDaysLoaded: schedule ? schedule.length : null,
    objectivesDaysLoaded: objectives ? objectives.length : null,
  };
}

// Admin: set (or replace) one Historic day's objectives. Same 1-2 objective
// shape as the live leagues' admin form, keyed by day number. Accepts either
// {stat, dailyTeamTarget} (frontend form) or {type, dailyTeamTarget} (seed
// file) entries and stores the seed-file shape.
async function upsertHistoricObjectivesDay(env, { day, date, objectives }) {
  const dayNum = Number(day);
  if (!Number.isInteger(dayNum) || dayNum < 1) throw new Error("day must be a positive integer");
  if (!Array.isArray(objectives) || objectives.length < 1 || objectives.length > 2) {
    throw new Error("objectives must be an array of 1 or 2 entries");
  }
  const clean = objectives.map((o) => {
    const type = o.type || o.stat;
    if (!type || !STAT_MAP[type]) throw new Error(`unknown stat code: ${type}`);
    if (typeof o.dailyTeamTarget !== "number" || o.dailyTeamTarget <= 0) {
      throw new Error(`dailyTeamTarget must be a positive number for ${type}`);
    }
    return { type, dailyTeamTarget: o.dailyTeamTarget };
  });
  const all = await getJSON(env, HISTORIC_OBJECTIVES_KEY, []);
  const existing = all.find((o) => o.day === dayNum);
  const schedule = await getJSON(env, HISTORIC_SCHEDULE_KEY, []);
  const scheduleDay = schedule.find((s) => s.day === dayNum);
  const entry = {
    day: dayNum,
    date: date || existing?.date || scheduleDay?.date || null,
    objectives: clean,
  };
  const next = all.filter((o) => o.day !== dayNum).concat([entry]).sort((a, b) => a.day - b.day);
  await putJSON(env, HISTORIC_OBJECTIVES_KEY, next);
  return { ok: true, day: dayNum, objectives: clean, objectivesDaysLoaded: next.length };
}

// Admin/status view: what's seeded, what's been simulated, which day is live.
async function getHistoricStatus(env) {
  const players = await getJSON(env, HISTORIC_PLAYERS_KEY, []);
  const schedule = await getJSON(env, HISTORIC_SCHEDULE_KEY, []);
  const objectives = await getJSON(env, HISTORIC_OBJECTIVES_KEY, []);
  const boxscores = await getJSON(env, HISTORIC_BOXSCORES_KEY, []);
  const simulatedDays = [...new Set(boxscores.map((r) => r.day))].sort((a, b) => a - b);
  return {
    league: "NBA",
    mode: "Historic",
    currentDay: await getCurrentHistoricDay(env),
    playersLoaded: players.length,
    activePlayers: players.filter((p) => p.active).length,
    scheduleDays: schedule.length,
    objectivesDays: objectives.length,
    simulatedDays,
    objectives: objectives.map((o) => ({ day: o.day, date: o.date || null, objectives: o.objectives })),
    scheduleDates: schedule.map((s) => ({ day: s.day, date: s.date || null, games: (s.matchups || []).length })),
  };
}

export {
  HISTORIC_PLAYERS_KEY,
  HISTORIC_SCHEDULE_KEY,
  HISTORIC_OBJECTIVES_KEY,
  HISTORIC_BOXSCORES_KEY,
  HISTORIC_DAY_KEY,
  simulateHistoricDay,
  buildHistoricDashboard,
  seedHistoric,
  getCurrentHistoricDay,
  setCurrentHistoricDay,
  upsertHistoricObjectivesDay,
  getHistoricStatus,
  round1,
  average,
  tierColor,
};
