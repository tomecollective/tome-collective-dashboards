// Automatic nightly box-score load for the Historic optimizer dataset.
//
// What it does, once per Historic contest day:
//   1. Reads the Historic contest schedule from Top Shot's PUBLIC Fast Break
//      page (plain fetch, no sign-in, no API token). The page embeds every
//      contest of the run with its games, start times and statuses.
//   2. Waits until 15 minutes after the day's last game starts (the contest's
//      locksAt, which Top Shot sets to the last tip) and every game is Final.
//   3. Opens the same public page in Cloudflare Browser Run (the BROWSER
//      binding, Quick Actions "content"), clicks each game's "Box score"
//      button and reads the tables (MIN PTS FG 3PT FT REB AST STL BLK).
//   4. Appends one stat row (s) and one rescored game (g) to every matched
//      player in fastbreak:historic:optimizer, validates and saves.
//
// Never touches prices (rp/avg) or slates: the next day's roster and prices
// still come from the roster-builder paste (build_historic_day.py).
// Each contest is applied once: the dataset carries boxScoreContests, and
// fastbreak:historic:auto keeps the run log. Contests that had already ended
// when the automation first ran are marked as skipped, never backfilled.

import { normalizeName } from "../../shared/names.js";
import { prepareHistoric, optimizeSlate } from "./exports.js";

export const HISTORIC_AUTO_CRON = "3-58/5 0-9 * * *"; // every 5 min, 00:03-09:58 UTC (evening ET)
export const HISTORIC_AUTO_STATE_KEY = "fastbreak:historic:auto";
export const HISTORIC_PAGE = "https://nbatopshot.com/fastbreak?league=simulation";
export const DELAY_AFTER_LAST_TIP_MS = 15 * 60 * 1000;
// One record per Historic day (ET date of the contest lock), written when its box
// scores load: every player's line and Fast Break score that night, plus the
// lineup the data had on top before the games (no collector discount).
export const HISTORIC_RESULTS_PREFIX = "fastbreak:historic:results:";
const MAX_BROWSER_ATTEMPTS = 4; // per contest; keeps a bad night well inside Browser Run's free 10 min/day
const MAX_AGE_AFTER_LOCK_MS = 36 * 3600 * 1000; // never chase a contest older than this
const RESULT_ID = "tome-historic-bs";

// Same weights as dashboards/lines/build_historic_day.py (2026-27 scoring).
// Turnovers are not in Top Shot's box score, so the 1.5 estimate stays.
const W = { PTS: 1, REB: 1, AST: 2, STL: 3, BLK: 3, "3PM": 0.5, DD: 5, TD: 10 };
const TOV_EST = 1.5;
const DEFAULT_CODES = ["PTS", "REB", "AST", "STL", "BLK", "3PM"];

export function rescore(codes, line) {
  const v = {};
  codes.forEach((c, i) => (v[c] = line[i] || 0));
  const cats = ["PTS", "REB", "AST", "STL", "BLK"].filter((k) => (v[k] || 0) >= 10).length;
  let pts = 0;
  for (const k of ["PTS", "REB", "AST", "STL", "BLK", "3PM"]) pts += W[k] * (v[k] || 0);
  const total = pts + (cats >= 2 ? W.DD : 0) + (cats >= 3 ? W.TD : 0) - TOV_EST;
  return Math.round(total * 10) / 10;
}

// -- Schedule (public page HTML) ---------------------------------------------

const tsSeconds = (t) => {
  if (!t) return null;
  const n = Number(String(t.seconds ?? t).replace(/^\$n/, ""));
  return Number.isFinite(n) ? n : null;
};

// Returns the JSON text of the object/array starting at s[i].
function grabBalanced(s, i) {
  let depth = 0, inStr = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (c === "\\") { j++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (!depth) return s.slice(i, j + 1);
    }
  }
  return null;
}

// The page ships its data as a Next.js flight payload: JSON inside a JS string,
// so quotes arrive as \". Unescape until the contest objects read as JSON.
export function parseHistoricSchedule(html) {
  let h = String(html || "");
  for (let n = 0; n < 4 && !h.includes('{"$typeName":"atlas.v1.Contest"'); n++) {
    h = h.replace(/\\(["\\/])/g, "$1");
  }
  const marker = '{"$typeName":"atlas.v1.Contest","id":"';
  const contests = new Map();
  let at = h.indexOf(marker);
  while (at !== -1) {
    const txt = grabBalanced(h, at);
    if (txt) {
      try {
        const c = JSON.parse(txt);
        if (/^run-fb-historic-/.test(c.id) && Array.isArray(c.slateGames) && !contests.has(c.id)) {
          const games = c.slateGames.map((g) => ({
            gameId: g.gameId,
            home: String(g.homeTeamId || ""),
            away: String(g.awayTeamId || ""),
            status: g.status,
            startsAt: tsSeconds(g.scheduledAt),
          }));
          const starts = games.map((g) => g.startsAt).filter((x) => x != null);
          contests.set(c.id, {
            id: c.id,
            runId: c.runId,
            name: c.name || c.id,
            status: c.status,
            locksAt: tsSeconds(c.locksAt) ?? (starts.length ? Math.max(...starts) : null),
            endsAt: tsSeconds(c.endsAt),
            lastStart: starts.length ? Math.max(...starts) : null,
            games,
          });
        }
      } catch {
        /* not a complete contest object; keep scanning */
      }
    }
    at = h.indexOf(marker, at + marker.length);
  }
  return [...contests.values()].sort((a, b) => (a.locksAt || 0) - (b.locksAt || 0));
}

const GAME_FINAL = 3;
export const allFinal = (c) => c.games.length > 0 && c.games.every((g) => g.status === GAME_FINAL);
export const dueAtMs = (c) => ((c.lastStart ?? c.locksAt) || 0) * 1000 + DELAY_AFTER_LAST_TIP_MS;

// -- Box scores (Browser Run) --------------------------------------------------

// Runs inside the rendered page. Clicks each game's "Box score" button, reads
// the dialog's tables, closes it, and leaves the result as JSON in a script
// tag that the Quick Action waits for. Reads only; it never signs in.
export const BOX_SCORE_PAGE_SCRIPT = `(async () => {
  const out = { games: [], errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => ((el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().toLowerCase());
  const finish = () => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "${RESULT_ID}";
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  try {
    let buttons = [];
    for (let i = 0; i < 60 && !buttons.length; i++) {
      buttons = [...document.querySelectorAll("button")].filter((b) => label(b) === "box score" && !b.closest("[role=dialog]"));
      if (!buttons.length) await sleep(500);
    }
    if (!buttons.length) out.errors.push("no Box score buttons found");
    const sig = (d) => [...d.querySelectorAll("tbody tr button")].map((b) => b.getAttribute("aria-label")).join("|");
    const seen = new Set();
    for (let gi = 0; gi < buttons.length; gi++) {
      // Let the previous dialog finish closing before opening the next one.
      for (let i = 0; i < 40 && document.querySelector("[role=dialog] table"); i++) await sleep(150);
      buttons[gi].click();
      let dlg = null;
      for (let i = 0; i < 40; i++) {
        dlg = [...document.querySelectorAll("[role=dialog]")].find((d) => d.querySelectorAll("table tbody tr").length && !seen.has(sig(d)));
        if (dlg) break;
        await sleep(250);
      }
      if (dlg) seen.add(sig(dlg));
      if (!dlg) { out.errors.push("game " + gi + ": box score did not open"); continue; }
      const teams = [];
      for (const table of dlg.querySelectorAll("table")) {
        const head = [...table.querySelectorAll("thead th, thead [role=columnheader]")].map((th) => th.textContent.trim().toUpperCase());
        // The team header ("TOR Home") comes just before its table.
        let hm = null;
        for (let a = table.parentElement, k = 0; a && a !== dlg && k < 4 && !hm; a = a.parentElement, k++) {
          const t = a.textContent || "";
          const at = t.indexOf(table.textContent);
          hm = (at > 0 ? t.slice(0, at) : "").match(/([A-Z]{2,4})\\s*(Home|Away)\\s*$/);
        }
        const abbr = hm ? hm[1] : null, side = hm ? hm[2].toLowerCase() : null;
        const rows = [];
        for (const tr of table.querySelectorAll("tbody tr")) {
          const btn = tr.querySelector("button");
          const aria = (btn && btn.getAttribute("aria-label")) || "";
          const m = aria.match(/^Show (.+?)(?:'s|')\\s+detail$/);
          const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
          const row = { name: m ? m[1] : "", short: btn ? btn.textContent.trim() : "", cells };
          head.slice(1).forEach((h, i) => (row[h] = cells[i]));
          rows.push(row);
        }
        teams.push({ abbr, side, head, rows });
      }
      out.games.push({ index: gi, teams });
      const close = [...dlg.querySelectorAll("button")].find((b) => label(b) === "close");
      if (close) close.click();
      else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      for (let i = 0; i < 20 && document.querySelector("[role=dialog] table"); i++) await sleep(150);
    }
  } catch (e) {
    out.errors.push(String(e && e.message || e));
  }
  finish();
})();`;

export function contestPageUrl(contestId) {
  return `${HISTORIC_PAGE}&contest=${encodeURIComponent(contestId)}`;
}

export async function fetchBoxScores(env, contestId) {
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") {
    throw new Error("BROWSER binding is not configured (add [browser] binding = \"BROWSER\" in wrangler.toml)");
  }
  const res = await env.BROWSER.quickAction("content", {
    url: contestPageUrl(contestId),
    gotoOptions: { waitUntil: "networkidle2", timeout: 45000 },
    addScriptTag: [{ content: BOX_SCORE_PAGE_SCRIPT }],
    waitForSelector: { selector: `#${RESULT_ID}`, timeout: 60000 },
    rejectResourceTypes: ["image", "media", "font"],
  });
  if (!res.ok) throw new Error(`Browser Run ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!body.success || typeof body.result !== "string") throw new Error("Browser Run returned no page content");
  return parseBoxScoreResult(body.result);
}

export function parseBoxScoreResult(html) {
  const m = String(html).match(new RegExp(`<script[^>]*id="${RESULT_ID}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) throw new Error("box score result block missing from the rendered page");
  return JSON.parse(m[1]);
}

// -- Applying one day to the dataset ---------------------------------------------

const made = (v) => {
  const m = String(v || "").match(/^(\d+)\s*-\s*(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const minutes = (v) => {
  const m = String(v || "").match(/^(\d+):(\d+)$/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : num(v);
};

// One stat value for a dataset statCode from a box-score row.
export function statFor(code, row) {
  switch (code) {
    case "PTS": case "REB": case "AST": case "STL": case "BLK": return num(row[code]);
    case "3PM": return made(row["3PT"])[0];
    case "3PA": return made(row["3PT"])[1];
    case "FGM": return made(row.FG)[0];
    case "FGA": return made(row.FG)[1];
    case "FTM": return made(row.FT)[0];
    case "FTA": return made(row.FT)[1];
    case "MIN": return Math.round(minutes(row.MIN) * 10) / 10;
    default: return 0;
  }
}

export function applyBoxScores(dataset, contest, box) {
  const D = dataset;
  const codes = Array.isArray(D.statCodes) && D.statCodes.length ? D.statCodes : DEFAULT_CODES;
  const byName = new Map();
  for (const p of D.players) {
    const k = normalizeName(p.n);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  const unmatched = [];
  const appended = [];
  const lines = []; // every row read, for the day's results record
  // A player who isn't in the dataset yet (no roster-builder price) has nowhere to go, so
  // their line is held in pendingBoxScores. build_historic_day.py moves the held games onto the
  // player the first time they show up in a roster paste, so no game is lost.
  const pending = Array.isArray(D.pendingBoxScores) ? D.pendingBoxScores : [];
  const held = [];
  const seen = new Set();
  let rows = 0;
  for (const game of box.games || []) {
    for (const team of game.teams || []) {
      for (const r of team.rows || []) {
        rows++;
        const key = normalizeName(r.name);
        let cands = byName.get(key) || [];
        if (!cands.length && key) {
          const line = codes.map((c) => statFor(c, r));
          let h = pending.find((x) => normalizeName(x.n) === key && (!x.t || !team.abbr || x.t === team.abbr));
          if (!h) { h = { n: r.name, t: team.abbr || "", g: [], s: [] }; pending.push(h); }
          h.s.push(line);
          h.g.push(rescore(codes, line));
          lines.push({ n: r.name, t: team.abbr || "", fbp: h.g[h.g.length - 1], s: line, held: true });
          held.push(`${r.name} (${team.abbr || "?"})`);
          continue;
        }
        if (cands.length > 1 && team.abbr) cands = cands.filter((p) => p.t === team.abbr);
        const p = cands.length === 1 ? cands[0] : null;
        if (!p || seen.has(p)) {
          unmatched.push(`${r.name || r.short} (${team.abbr || "?"})`);
          continue;
        }
        seen.add(p);
        const line = codes.map((c) => statFor(c, r));
        if (!Array.isArray(p.s)) p.s = p.g.map(() => codes.map(() => 0)); // keep s aligned with g
        p.s.push(line);
        p.g.push(rescore(codes, line));
        lines.push({ n: p.n, t: p.t || team.abbr || "", fbp: p.g[p.g.length - 1], s: line });
        appended.push(p.n);
      }
    }
  }
  if (pending.length) D.pendingBoxScores = pending;
  D.boxScoreContests = [...(D.boxScoreContests || []), contest.id].slice(-120);
  D.boxScoresUpdated = contest.name;
  D.boxScoresUpdatedAt = new Date().toISOString();
  return { rows, appended: appended.length, held, unmatched, lines };
}

// ET calendar date (YYYY-MM-DD) of a contest, from its lock (the last tip).
export function contestDateET(contest) {
  const sec = contest.locksAt ?? contest.lastStart;
  if (!sec) return null;
  return new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// The day's results record. `before` is the dataset as it stood before the
// box scores were added, so dataTopLineup is what the data had on top going in.
export function buildResultsRecord(before, contest, result) {
  const date = contestDateET(contest);
  const slate = (before.slates || []).find((s) => s.date && s.date === date) || null;
  let dataTopLineup = null;
  if (slate) {
    try {
      const D = prepareHistoric(before);
      const byName = Object.fromEntries(D.players.map((p) => [p.n, p]));
      const pool = slate.players.map((n) => byName[n]).filter(Boolean);
      const best = optimizeSlate(D, pool).best;
      if (best.length) dataTopLineup = { players: best.map((p) => p.n), rpUsed: best.reduce((a, p) => a + p.rp, 0), projected: Math.round(best.reduce((a, p) => a + p.blend, 0) * 10) / 10 };
    } catch {
      dataTopLineup = null;
    }
  }
  return {
    contest: contest.id,
    name: contest.name || contest.id,
    date,
    slateLabel: slate ? slate.label || null : null,
    statCodes: Array.isArray(before.statCodes) && before.statCodes.length ? before.statCodes : DEFAULT_CODES,
    loadedAt: new Date().toISOString(),
    players: result.lines,
    dataTopLineup,
  };
}

// -- Cron tick ----------------------------------------------------------------------

async function loadJSON(env, key) {
  const raw = await env.FASTBREAK_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const saveJSON = (env, key, v) => env.FASTBREAK_KV.put(key, JSON.stringify(v));

export async function fetchSchedule(env, fetchImpl = fetch) {
  const res = await fetchImpl(HISTORIC_PAGE, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TomeCollective-FastBreak/1.0)" } });
  if (!res.ok) throw new Error(`Top Shot page returned ${res.status}`);
  const contests = parseHistoricSchedule(await res.text());
  if (!contests.length) throw new Error("no Historic contests found on the public page");
  return contests;
}

// Load one contest's box scores into the dataset. dryRun returns the preview
// without saving. Used by the cron tick and by the admin run route.
export async function ingestContest(env, contest, { validate, dryRun = false } = {}) {
  const D = await loadJSON(env, "fastbreak:historic:optimizer");
  if (!D) throw new Error("Historic optimizer data has not been uploaded yet");
  if ((D.boxScoreContests || []).includes(contest.id)) return { skipped: "already in dataset", contest: contest.id };
  const box = await fetchBoxScores(env, contest.id);
  const gotGames = (box.games || []).filter((g) => (g.teams || []).some((t) => (t.rows || []).length)).length;
  if (gotGames < contest.games.length) {
    throw new Error(`read ${gotGames} of ${contest.games.length} box scores${box.errors?.length ? ": " + box.errors.slice(0, 3).join("; ") : ""}`);
  }
  const before = JSON.parse(JSON.stringify(D));
  const { lines, ...result } = applyBoxScores(D, contest, box);
  const problem = validate ? validate(D) : null;
  if (problem) throw new Error(`dataset failed validation: ${problem}`);
  const record = buildResultsRecord(before, contest, { lines });
  if (!dryRun) {
    await saveJSON(env, "fastbreak:historic:optimizer", D);
    if (record.date) await saveJSON(env, HISTORIC_RESULTS_PREFIX + record.date, record);
  }
  return { contest: contest.id, name: contest.name, games: gotGames, ...result, resultsDate: record.date, dataTopLineup: record.dataTopLineup, dryRun };
}

export async function runHistoricAutoTick(env, { validate, now = Date.now(), fetchImpl = fetch } = {}) {
  const state = (await loadJSON(env, HISTORIC_AUTO_STATE_KEY)) || { done: {}, attempts: {} };
  state.done ||= {};
  state.attempts ||= {};
  state.lastTickAt = new Date(now).toISOString();
  if (state.waitUntil && now < Date.parse(state.waitUntil)) {
    await saveJSON(env, HISTORIC_AUTO_STATE_KEY, state);
    return { action: "waiting", until: state.waitUntil };
  }

  let contests;
  try {
    contests = await fetchSchedule(env, fetchImpl);
    state.lastScheduleOkAt = state.lastTickAt;
  } catch (err) {
    state.lastError = `${state.lastTickAt} schedule: ${err.message}`.slice(0, 300);
    state.waitUntil = new Date(now + 30 * 60 * 1000).toISOString();
    await saveJSON(env, HISTORIC_AUTO_STATE_KEY, state);
    return { action: "schedule-error", error: err.message };
  }

  // First run ever: everything already past its due time is history the
  // manual flow handled. Mark it, never backfill it.
  if (!state.startedAt) {
    state.startedAt = state.lastTickAt;
    for (const c of contests) if (dueAtMs(c) <= now) state.done[c.id] = { skipped: "ended before automation started" };
  }

  const pending = contests.filter((c) => !state.done[c.id] && c.locksAt);
  const due = pending.find((c) => dueAtMs(c) <= now && now - dueAtMs(c) < MAX_AGE_AFTER_LOCK_MS);
  let result = { action: "idle" };

  if (due) {
    const endsMs = (due.endsAt || 0) * 1000;
    if (!allFinal(due) && now < endsMs) {
      state.waitUntil = null; // check again next tick
      result = { action: "waiting-for-finals", contest: due.id };
    } else if ((state.attempts[due.id] || 0) >= MAX_BROWSER_ATTEMPTS) {
      state.done[due.id] = { failed: `gave up after ${MAX_BROWSER_ATTEMPTS} attempts`, lastError: state.lastError };
      result = { action: "gave-up", contest: due.id };
    } else {
      state.attempts[due.id] = (state.attempts[due.id] || 0) + 1;
      try {
        const r = await ingestContest(env, due, { validate });
        state.done[due.id] = { at: state.lastTickAt, ...r, unmatched: (r.unmatched || []).slice(0, 30) };
        state.lastOkAt = state.lastTickAt;
        state.lastError = null;
        result = { action: "ingested", ...r };
      } catch (err) {
        state.lastError = `${state.lastTickAt} ${due.id}: ${err.message}`.slice(0, 300);
        result = { action: "error", contest: due.id, error: err.message };
      }
    }
  }

  // Sleep until the next contest is due, so quiet ticks cost one KV read.
  if (result.action === "idle" || result.action === "ingested" || result.action === "gave-up") {
    const next = contests.filter((c) => !state.done[c.id] && dueAtMs(c) > now).sort((a, b) => dueAtMs(a) - dueAtMs(b))[0];
    // Re-read the schedule at least every 6 hours in case Top Shot moves a day.
    const wake = next ? Math.min(dueAtMs(next), now + 6 * 3600 * 1000) : now + 6 * 3600 * 1000;
    state.waitUntil = new Date(wake).toISOString();
    state.nextContest = next ? { id: next.id, name: next.name, dueAt: new Date(dueAtMs(next)).toISOString() } : null;
  }

  // Keep the log small: drop entries for contests no longer on the page.
  const live = new Set(contests.map((c) => c.id));
  for (const k of Object.keys(state.done)) if (!live.has(k) && Object.keys(state.done).length > 60) delete state.done[k];
  for (const k of Object.keys(state.attempts)) if (state.done[k]) delete state.attempts[k];

  await saveJSON(env, HISTORIC_AUTO_STATE_KEY, state);
  return result;
}

export async function historicAutoStatus(env) {
  const s = await loadJSON(env, HISTORIC_AUTO_STATE_KEY);
  if (!s) return { enabled: Boolean(env.BROWSER), started: false };
  const last = Object.entries(s.done || {}).filter(([, v]) => v.at).sort((a, b) => (a[1].at < b[1].at ? 1 : -1))[0];
  return {
    enabled: Boolean(env.BROWSER),
    started: true,
    lastTickAt: s.lastTickAt || null,
    lastOkAt: s.lastOkAt || null,
    lastError: s.lastError || null,
    nextContest: s.nextContest || null,
    lastIngested: last ? { contest: last[0], name: last[1].name, appended: last[1].appended, held: last[1].held, unmatched: last[1].unmatched } : null,
  };
}
