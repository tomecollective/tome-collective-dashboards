// Headless-Chromium check of index.html against mocked Worker responses:
//   node dashboards/fastbreak/_frontend_test.mjs
// Covers: single-select six-way toggle, per-league run days + label, NBA
// league param on data fetches, building->done polling, Historic greyed out,
// Full Data league sub-toggle, and the five-mode Objectives Admin (scope
// labels, per-league schedule table, league+mode in save payloads, Historic
// panel + seed/advance calls).
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = "https://tome-fastbreak-refresh.tomecollective.workers.dev";

function player(name, team, opp, rank, proj) {
  return {
    id: name, name, team, opp, ovrRank: rank, injuryStatus: null,
    objectives: { PTS: { stat: "PTS", label: "PTS", dailyTeamTarget: 100, perPlayerTarget: 20, proj, projSource: proj == null ? "tbd" : "rotowire", ytd: 18.2, l10: 21.5, colorProj: proj != null && proj >= 20 ? "light-green" : null, colorYtd: null, colorL10: "light-green", weight: 1 } },
  };
}

const requests = [];
const posts = [];
let nbaBuildCalls = 0;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
page.on("pageerror", (e) => { throw e; });

const TEST_ADMIN_TOKEN = "local-test-admin-token";
const TEST_SUB_KEY = "local-test-subscriber-key";
const keyedReads = []; // GET requests that carried the subscriber key
let nbaEnabled = false; // the Worker's league switch (FB-3); flipped on mid-test
await page.route(`${WORKER}/**`, async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  requests.push(`${req.method()} ${url.pathname}${url.search}`);
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: JSON.stringify(body) });
  // Subscriber gate, same contract as the Workers: gated reads 401 {locked}
  // without X-Tome-Key (admin token also passes); /run is ungated.
  const GATED = ["/api/fastbreak", "/api/fastbreak/objectives", "/api/fastbreak/fulldata", "/api/fastbreak/historic"];
  if (req.method() === "GET" && GATED.includes(url.pathname)) {
    const key = req.headers()["x-tome-key"];
    const admin = req.headers()["x-admin-token"];
    if (key === TEST_SUB_KEY) keyedReads.push(url.pathname);
    if (key !== TEST_SUB_KEY && admin !== TEST_ADMIN_TOKEN) return json({ error: "This data is for Tome Edge subscribers.", locked: true }, 401);
  }
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" } });
  if (req.method() === "POST") {
    posts.push({ path: url.pathname, body: JSON.parse(req.postData() || "{}"), token: req.headers()["x-admin-token"] });
    if (url.pathname.endsWith("/admin/verify")) {
      // Server-side password check: the page must not know the password.
      return req.headers()["x-admin-token"] === TEST_ADMIN_TOKEN ? json({ ok: true }) : json({ error: "Invalid or missing admin password." }, 401);
    }
    if (url.pathname.endsWith("/historic/seed")) return json({ ok: true, playersLoaded: 150, scheduleDaysLoaded: 90, objectivesDaysLoaded: 90 });
    if (url.pathname.endsWith("/historic/advance")) return json({ ok: true, day: 2, added: 300 });
    return json({ ok: true, schedule: {} });
  }
  if (url.pathname === "/api/fastbreak/run") {
    return json({
      WNBA: { league: "WNBA", runLabel: "Run 11", runStart: "2026-09-17", runEnd: "2026-09-24", runLength: 8, enabled: true },
      NBA: { league: "NBA", runLabel: "Run 1", runStart: "2026-10-20", runEnd: "2026-10-26", runLength: 7, enabled: nbaEnabled },
    });
  }
  if (url.pathname === "/api/fastbreak/league/status") {
    return json({ enabled: { WNBA: true, NBA: nbaEnabled }, keyCheck: {} });
  }
  if (url.pathname === "/api/fastbreak") {
    const league = url.searchParams.get("league");
    const mode = url.searchParams.get("mode");
    const date = url.searchParams.get("date");
    if (league === "NBA") {
      nbaBuildCalls += 1;
      const building = nbaBuildCalls === 1;
      return json({
        league, mode, date, dayNumber: 1, runLabel: "Run 1", building, progress: { loaded: building ? 120 : 384, total: 384 },
        objectives: [{ stat: "PTS", label: "PTS", dailyTeamTarget: 100, weight: 1 }],
        games: [{ awayAbbr: "BOS", homeAbbr: "DET", time: "3:00 PM ET (19:00 UTC)", status: "pre" }],
        players: building ? [player("Jayson Tatum", "BOS", "@ DET", 1, 27.5)] : [player("Jayson Tatum", "BOS", "@ DET", 1, 27.5), player("Cade Cunningham", "DET", "vs BOS", 2, null)],
        note: "nba note", teamAdvanced: {}, badgeSetName: mode === "Pro" ? "Rookie Year" : null,
      });
    }
    return json({
      league, mode, date, dayNumber: 1, runLabel: "Run 11", building: false,
      objectives: [{ stat: "PTS", label: "PTS", dailyTeamTarget: 100, weight: 1 }],
      games: [{ awayAbbr: "MIN", homeAbbr: "ATL", time: "7:30 PM ET (23:30 UTC)", status: "pre" }],
      players: [
        { ...player("Star Out", "MIN", "@ ATL", null, 30.0), injuryStatus: "Out", injuryNote: "knee", availability: "out" },
        player("Napheesa Collier", "MIN", "@ ATL", 1, 24.1),
        { ...player("Rhyne Howard", "ATL", "vs MIN", 2, 19.2), injuryStatus: "Day-To-Day", availability: "dtd" },
      ],
      note: "wnba note", teamAdvanced: {}, badgeSetName: mode === "Pro" ? "Sapphire" : null,
    });
  }
  if (url.pathname === "/api/fastbreak/fulldata") {
    const league = url.searchParams.get("league");
    return json({ league, statCodes: ["PTS"], generated_at: "2026-09-04T12:00:00Z", note: `${league} full data`, teams: { MIN: { ppg: 88.1, papg: 80.2, gamesPlayed: 30 } }, teamsDetail: {}, players: [{ id: 1, name: league === "NBA" ? "Nba Player" : "Wnba Player", team: "MIN", stats: { PTS: { l10: 10, ytd: 11 } } }] });
  }
  if (url.pathname === "/api/fastbreak/objectives") {
    return json({ leagues: ["WNBA", "NBA"], modes: ["Classic", "Pro"], schedule: {
      WNBA: { "2026-09-17": { objectives: { Classic: [{ stat: "PTS", dailyTeamTarget: 100 }] }, badgeSetName: null, projections: { PTS: { a: {}, b: {} } } } },
      NBA: { "2026-10-20": { objectives: { Classic: [{ stat: "REB", dailyTeamTarget: 40 }], Pro: [{ stat: "3PM", dailyTeamTarget: 12 }] }, badgeSetName: "Rookie Year" } },
    } });
  }
  if (url.pathname === "/api/fastbreak/historic/status") {
    return json({ currentDay: 1, playersLoaded: 150, activePlayers: 150, scheduleDays: 90, objectivesDays: 90, simulatedDays: [1], objectives: [{ day: 1, date: "Oct 24", objectives: [{ type: "REB", dailyTeamTarget: 30 }] }], scheduleDates: [{ day: 1, date: "2027-10-24", games: 15 }, { day: 2, date: "2027-10-25", games: 15 }] });
  }
  if (url.pathname === "/api/fastbreak/historic") return json({ league: "NBA", mode: "Historic", day: 1, objectives: [], games: [], players: [], note: "historic" });
  return json({ error: `unmocked ${url.pathname}` }, 404);
});

// Without a key: the lock panel shows and the dashboard is hidden.
await page.goto(pathToFileURL(path.join(here, "index.html")).href);
await page.waitForFunction(() => getComputedStyle(document.querySelector("#locked-panel")).display === "block");
assert.equal(await page.$eval("#view-main", (el) => getComputedStyle(el).display), "none", "dashboard hidden when locked");

// With ?key= on the embed URL: key is sent as X-Tome-Key, stripped from the
// address bar, kept in sessionStorage only.
requests.length = 0;
await page.goto(pathToFileURL(path.join(here, "index.html")).href + `?key=${TEST_SUB_KEY}`);
await page.waitForSelector("#players-body tr");
assert.ok(!page.url().includes("key="), "key stripped from the URL");
assert.equal(await page.evaluate(() => sessionStorage.getItem("tome_key")), TEST_SUB_KEY, "key kept in sessionStorage");
assert.equal(await page.evaluate(() => { try { return localStorage.getItem("tome_key"); } catch { return null; } }), null, "key never in localStorage");
assert.ok(keyedReads.includes("/api/fastbreak"), "dashboard read carried the subscriber key");
assert.equal(await page.$eval("#locked-panel", (el) => getComputedStyle(el).display), "none", "lock panel hidden with a valid key");

// Default: WNBA Classic, Run 11 label, league param on the fetch.
assert.equal(await page.textContent("#run-label"), "WNBA Run 11");

// Out player: bottom row, "OUT" instead of a rank, no tier colours. DTD:
// ranked, hatched tier cells.
const rows = await page.$$eval("#players-body tr", (trs) => trs.map((tr) => ({ cls: tr.className, first: tr.cells[0].textContent, rank: tr.cells[3].textContent.trim(), projCls: tr.cells[4].className })));
assert.equal(rows[rows.length - 1].rank, "OUT", "Out player shows OUT, not a rank");
assert.equal(rows[rows.length - 1].cls, "row-out");
assert.ok(rows[rows.length - 1].first.startsWith("Star Out"), "Out player sorted to the bottom");
assert.ok(!rows[rows.length - 1].projCls.includes("tier-"), "Out player has no tier colour");
const dtdRow = rows.find((r) => r.first.startsWith("Rhyne"));
assert.equal(dtdRow.cls, "row-dtd");
assert.ok(dtdRow.projCls.includes("tier-risk"), "DTD tier cell is hatched");
assert.equal(dtdRow.rank, "2", "DTD player keeps rank");
// Sorting by Proj descending still keeps the Out player last.
await page.click('#table-head th[data-key="base:ovrRank"]');
await page.click('#table-head th[data-key="base:ovrRank"]');
const rows2 = await page.$$eval("#players-body tr", (trs) => trs.map((tr) => tr.cells[3].textContent.trim()));
assert.equal(rows2[rows2.length - 1], "OUT", "Out player stays last after re-sort");
assert.ok(requests.some((r) => r.includes("/api/fastbreak?league=WNBA&") && r.includes("mode=Classic")), "WNBA Classic fetched with league param");
assert.equal((await page.$$("#mode-toggle button")).length, 6, "six single-select buttons");
assert.equal(await page.getAttribute('#mode-toggle button[data-mode="Historic"]', "disabled"), "", "Historic greyed out by default");
const runBtns = await page.$$eval("#run-days .run-day-btn", (els) => els.map((e) => e.textContent));
assert.ok(runBtns.length >= 1 && runBtns.length <= 8 && /Day \d+ - Sep \d+/.test(runBtns[0]), `WNBA run days: ${runBtns.join(", ")}`);
assert.match(await page.textContent("#players-body"), /Napheesa Collier/);
assert.equal(await page.textContent("#pg-eye"), "Tome Collective · WNBA · Fast Break");

// WNBA Pro: same league, badge tile shows.
await page.click('#mode-toggle button[data-league="WNBA"][data-mode="Pro"]');
await page.waitForFunction(() => document.querySelector("#objective-tiles")?.textContent.includes("Sapphire"));
assert.match(await page.textContent("#mode-note"), /WNBA Pro/);

// FB-3: with the NBA switch OFF, NBA Classic/Pro are greyed out like Historic.
assert.equal(await page.$eval('#mode-toggle button[data-league="NBA"][data-mode="Classic"]', (b) => b.disabled), true, "NBA Classic disabled while the league is off");
assert.equal(await page.$eval('#mode-toggle button[data-league="NBA"][data-mode="Pro"]', (b) => b.disabled), true, "NBA Pro disabled while the league is off");
assert.equal(await page.$eval('#mode-toggle button[data-league="WNBA"][data-mode="Pro"]', (b) => b.disabled), false, "WNBA stays enabled");
// Flip the switch on the Worker and re-sync (what the admin panel does).
nbaEnabled = true;
await page.evaluate(() => { RUNS.NBA.enabled = true; syncLeagueToggles(); });
assert.equal(await page.$eval('#mode-toggle button[data-league="NBA"][data-mode="Classic"]', (b) => b.disabled), false, "NBA enabled after the switch");

// NBA Classic: run label/days switch, league=NBA fetch, building -> polls -> done.
await page.click('#mode-toggle button[data-league="NBA"][data-mode="Classic"]');
await page.waitForFunction(() => document.querySelector("#run-label")?.textContent === "NBA Run 1");
const nbaDays = await page.$$eval("#run-days .run-day-btn", (els) => els.map((e) => e.textContent));
assert.equal(nbaDays.length, 7, `NBA run has 7 days (${nbaDays.join(", ")})`);
assert.equal(nbaDays[0], "Day 1 - Oct 20");
assert.equal(nbaDays[6], "Day 7 - Oct 26");
assert.ok(requests.some((r) => r.includes("/api/fastbreak?league=NBA&date=2026-10-20&mode=Classic")), "NBA Day 1 fetched");
await page.waitForFunction(() => document.querySelector("#loading-banner")?.textContent.includes("120 of 384"));
// Subscriber (non-admin) pages poll an in-flight build every 20s, so the
// scheduled updater does the work and the page never hammers the Worker.
await page.waitForFunction(() => !document.querySelector("#loading-banner") && document.querySelectorAll("#players-body tr").length === 2, null, { timeout: 30000 });
assert.ok(nbaBuildCalls >= 2, "polled the Worker until the build finished");
assert.equal(await page.textContent("#pg-eye"), "Tome Collective · NBA · Fast Break");
assert.match(await page.textContent("#players-body"), /TBD/, "TBD shown for missing projection");
assert.ok(requests.some((r) => r.includes("/api/fastbreak/fulldata?league=NBA")), "NBA full data warmed for team tooltips");

// Day 3 click carries league + date.
await page.click('#run-days .run-day-btn[data-date="2026-10-22"]');
await page.waitForFunction(() => document.querySelector('#run-days .run-day-btn[data-date="2026-10-22"]')?.classList.contains("active"));
await page.waitForTimeout(100);
assert.ok(requests.some((r) => r.includes("league=NBA&date=2026-10-22&mode=Classic")));

// Full Data: league sub-toggle.
await page.click('#mode-toggle button[data-mode="FullData"]');
await page.waitForFunction(() => document.querySelector("#fd-players-body")?.textContent.includes("Wnba Player"));
await page.click('#fd-league-toggle button[data-fdleague="NBA"]');
await page.waitForFunction(() => document.querySelector("#fd-players-body")?.textContent.includes("Nba Player"));
assert.match(await page.textContent("#fd-meta"), /^NBA/);

// Admin: picker drives scope + schedule table; saves carry league + mode.
await page.click("#admin-toggle-btn");
await page.waitForFunction(() => document.querySelector("#admin-schedule-body")?.textContent.includes("2026-09-17"));
assert.equal((await page.$$("#admin-mode-picker button")).length, 5, "five admin modes");
assert.match(await page.textContent("#admin-schedule-body"), /PTS \(2\)/, "projection upload counts shown");
// Password gate: nothing hardcoded in the page; wrong password is rejected by
// the Worker, right password unlocks and is only ever held in memory.
assert.ok(!(await page.content()).includes(TEST_ADMIN_TOKEN), "admin password must not appear in page source");
await page.fill("#admin-password-input", "wrong-password");
await page.click("#admin-unlock-btn");
await page.waitForFunction(() => document.querySelector("#admin-gate-status")?.textContent === "Incorrect password.");
assert.equal(await page.$eval("#admin-locked-content", (el) => getComputedStyle(el).display), "none", "still locked after wrong password");
await page.fill("#admin-password-input", TEST_ADMIN_TOKEN);
await page.click("#admin-unlock-btn");
await page.waitForFunction(() => getComputedStyle(document.querySelector("#admin-locked-content")).display === "block");
assert.equal(await page.inputValue("#admin-password-input"), "", "password field cleared after unlock");
assert.equal(await page.evaluate(() => { try { return Object.keys(localStorage).length + Object.keys(sessionStorage).filter((k) => k !== "tome_key").length; } catch { return 0; } }), 0, "password never persisted to web storage");
assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(TEST_ADMIN_TOKEN), "password value absent from web storage");

await page.click('#admin-mode-picker button[data-league="NBA"][data-mode="Pro"]');
await page.waitForFunction(() => document.querySelector("#admin-schedule-body")?.textContent.includes("2026-10-20"));
assert.equal(await page.textContent("#admin-obj-scope"), "NBA Pro");
assert.equal(await page.textContent("#admin-proj-scope"), "NBA (Classic + Pro)");
assert.match(await page.textContent("#admin-schedule-body"), /3PM \(12\)/);
assert.match(await page.textContent("#admin-schedule-body"), /Day 1/);
assert.equal(await page.$eval("#admin-badge-name", (el) => getComputedStyle(el).display), "block", "badge field visible for Pro");
assert.equal(await page.inputValue("#admin-date"), "2026-10-20", "date defaults into the NBA run window");

await page.fill("#admin-date", "2026-10-21");
await page.selectOption("#admin-stat-1", "AST");
await page.fill("#admin-target-1", "25");
await page.fill("#admin-badge-name", "Metallic Gold LE");
await page.click("#admin-save-btn");
await page.waitForFunction(() => document.querySelector("#admin-status")?.textContent.includes("Saved NBA Pro"));
const objPost = posts.find((p) => p.path.endsWith("/objectives/day"));
assert.deepEqual({ league: objPost.body.league, mode: objPost.body.mode, date: objPost.body.date, badge: objPost.body.badgeSetName, stat: objPost.body.objectives[0].stat }, { league: "NBA", mode: "Pro", date: "2026-10-21", badge: "Metallic Gold LE", stat: "AST" });
assert.equal(objPost.token, TEST_ADMIN_TOKEN, "saves carry the verified password as X-Admin-Token");

await page.fill("#proj-date", "2026-10-21");
await page.fill("#proj-rows", "Player\tTeam\tPTS\tREB\nJayson Tatum\tBOS\t27.5\t8.1\n");
await page.click("#proj-save-btn");
await page.waitForFunction(() => document.querySelector("#proj-status")?.textContent.includes("Loaded NBA projections"));
const projPosts = posts.filter((p) => p.path.endsWith("/projections"));
assert.equal(projPosts.length, 2, "one request per recognized stat column");
assert.ok(projPosts.every((p) => p.body.league === "NBA" && p.body.date === "2026-10-21"));

await page.fill("#inv-date", "2026-10-21");
await page.click("#inv-btn");
await page.waitForFunction(() => document.querySelector("#inv-status")?.textContent.includes("will rebuild"));
assert.ok(posts.some((p) => p.path.endsWith("/day/invalidate") && p.body.league === "NBA"));

// Historic admin panel.
await page.click('#admin-mode-picker button[data-mode="Historic"]');
await page.waitForFunction(() => document.querySelector("#admin-historic-body")?.textContent.includes("Day 1 (current)"));
assert.equal(await page.$eval("#admin-live-forms", (el) => getComputedStyle(el).display), "none");
assert.equal(await page.$eval("#admin-historic-forms", (el) => getComputedStyle(el).display), "block");
assert.match(await page.textContent("#admin-historic-status"), /Public Historic tab is OFF/);
await page.fill("#hist-day", "2");
await page.selectOption("#hist-stat-1", "AST");
await page.fill("#hist-target-1", "20");
await page.click("#hist-save-btn");
await page.waitForFunction(() => document.querySelector("#hist-status")?.textContent.includes("Saved Historic Day 2"));
const histPost = posts.find((p) => p.path.endsWith("/historic/objectives/day"));
assert.deepEqual(histPost.body, { day: 2, objectives: [{ stat: "AST", dailyTeamTarget: 20 }] });
await page.fill("#hist-seed-json", JSON.stringify({ objectives: [{ day: 1, objectives: [{ type: "REB", dailyTeamTarget: 30 }] }] }));
await page.click("#hist-seed-btn");
await page.waitForFunction(() => document.querySelector("#hist-seed-status")?.textContent.includes("Loaded"));
assert.ok(posts.some((p) => p.path.endsWith("/historic/seed") && p.body.objectives && !p.body.players));
await page.click("#hist-advance-btn");
await page.waitForFunction(() => document.querySelector("#hist-advance-status")?.textContent.includes("Simulated Day 2"));

// Back to dashboard restores the last selected mode view.
await page.click("#admin-toggle-btn");
assert.equal(await page.$eval("#view-fulldata", (el) => el.style.display), "block");

await browser.close();
console.log("ALL FRONTEND TESTS PASSED");
