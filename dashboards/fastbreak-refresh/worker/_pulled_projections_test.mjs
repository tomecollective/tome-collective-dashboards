// Local check for the D1 pulled-projections overlay (no Cloudflare needed):
//   node dashboards/fastbreak-refresh/worker/_pulled_projections_test.mjs
import assert from "node:assert/strict";
import { __testables__ as T } from "./index.js";

function fakeDB(rows, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            async all() {
              if (fail) throw new Error("D1 down");
              return { results: rows.filter((r) => r.league === args[0] && r.date === args[1]) };
            },
          };
        },
      };
    },
  };
}

const rows = [
  { league: "NBA", date: "2026-11-18", stat: "PTS", name: "Nikola Jokić", value: 27.4 },
  { league: "NBA", date: "2026-11-18", stat: "PTS", name: "Jaren Jackson Jr.", value: "19.1" },
  { league: "NBA", date: "2026-11-18", stat: "REB", name: "Nikola Jokić", value: 12.2 },
  { league: "NBA", date: "2026-11-18", stat: "XYZ", name: "Bad Stat", value: 1 },
  { league: "NBA", date: "2026-11-18", stat: "PTS", name: "No Value", value: "n/a" },
  { league: "NBA", date: "2026-11-17", stat: "PTS", name: "Other Day", value: 10 },
];

// No binding -> null (KV only).
assert.equal(await T.loadPulledProjections({}, "NBA", "2026-11-18"), null);

// Query is scoped to league/date; bad stat codes and non-numbers are skipped.
const db = fakeDB(rows);
const pulled = await T.loadPulledProjections({ PROJECTIONS_DB: db }, "NBA", "2026-11-18");
assert.deepEqual(db.calls[0].args, ["NBA", "2026-11-18"]);
assert.deepEqual(Object.keys(pulled).sort(), ["PTS", "REB"]);
assert.deepEqual(pulled.PTS["nikola jokić"], { name: "Nikola Jokić", value: 27.4 });
assert.equal(pulled.PTS["jaren jackson jr."].value, 19.1);
assert.equal(Object.keys(pulled.PTS).length, 2);

// A failing D1 query falls back to KV only instead of breaking the build.
const origErr = console.error;
console.error = () => {};
assert.equal(await T.loadPulledProjections({ PROJECTIONS_DB: fakeDB(rows, { fail: true }) }, "NBA", "2026-11-18"), null);
console.error = origErr;

// Overlay: pulled wins per name, manual-only names survive, other stats/dates untouched.
const schedule = {
  NBA: {
    "2026-11-18": {
      objectives: { Classic: [{ stat: "PTS", label: "PTS", dailyTeamTarget: 100 }] },
      projections: {
        PTS: { "nikola jokić": { name: "Nikola Jokić", value: 25 }, "manual only": { name: "Manual Only", value: 8 } },
        AST: { "x": { name: "X", value: 5 } },
      },
    },
    "2026-11-17": { objectives: {}, projections: { PTS: { "old": { name: "Old", value: 1 } } } },
  },
  WNBA: { "2026-11-18": { objectives: {} } },
};
const before = JSON.stringify(schedule);
const merged = T.mergePulledProjections(schedule, "NBA", "2026-11-18", pulled);
assert.equal(JSON.stringify(schedule), before, "input schedule is not mutated");
const day = merged.NBA["2026-11-18"];
assert.equal(day.projections.PTS["nikola jokić"].value, 27.4, "pulled value wins");
assert.equal(day.projections.PTS["manual only"].value, 8, "manual-only player kept");
assert.equal(day.projections.REB["nikola jokić"].value, 12.2, "new stat added");
assert.deepEqual(day.projections.AST, schedule.NBA["2026-11-18"].projections.AST, "unpulled stat untouched");
assert.deepEqual(day.objectives, schedule.NBA["2026-11-18"].objectives, "objectives untouched");
assert.equal(merged.NBA["2026-11-17"], schedule.NBA["2026-11-17"], "other dates untouched");
assert.equal(merged.WNBA, schedule.WNBA, "other league untouched");

// Date with no KV entry at all still gets the pulled projections.
const fresh = T.mergePulledProjections({}, "NBA", "2026-11-18", pulled);
assert.equal(fresh.NBA["2026-11-18"].projections.PTS["nikola jokić"].value, 27.4);
assert.deepEqual(fresh.NBA["2026-11-18"].objectives, {});

// Nothing pulled -> same object back.
assert.equal(T.mergePulledProjections(schedule, "NBA", "2026-11-18", null), schedule);
assert.equal(T.mergePulledProjections(schedule, "NBA", "2026-11-18", {}), schedule);

console.log("pulled projections overlay: all checks passed");
