// node dashboards/healthcheck/_local_test.mjs
// Exercises the healthcheck Worker with fake service bindings: gated shape
// checks send the subscriber key and reject a teaser; freshness checks flag a
// stopped cron / unpublished refresh and alert (once) without rolling back.
import assert from "node:assert/strict";
const worker = (await import("./index.js")).default;

const posts = [];
let analytics = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ dimensions: { scriptName: "tome-tcg" }, sum: { requests: 100, errors: 0 } }] }] } } };
// Simulated Cloudflare deployments: newest first, [0] is live. A rollback POST
// moves the deployed version to the front, like the real API does.
let deployments = [{ versions: [{ version_id: "vB-new" }] }, { versions: [{ version_id: "vA-old" }] }];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const rec = { url: u, body: init?.body ? JSON.parse(init.body) : null };
  posts.push(rec); allPosts.push(rec);
  if (u.includes("/graphql")) return new Response(JSON.stringify(analytics), { status: 200 });
  if (u.includes("/deployments")) {
    if (init?.method === "POST") {
      const id = JSON.parse(init.body).versions[0].version_id;
      deployments = [{ versions: [{ version_id: id }] }, ...deployments.filter(d => d.versions[0].version_id !== id)];
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: { deployments } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};
const kvStore = new Map();
const kv = { get: async (k, t) => { const v = kvStore.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k, v) => kvStore.set(k, String(v)) };
const allPosts = [];
const rollbackPosts = () => posts.filter((p) => p.url.includes("/deployments") && p.body);
const allRollbacks = () => allPosts.filter((p) => p.url.includes("/deployments") && p.body);
const resetRollbackState = () => { allPosts.length = 0; for (const k of [...kvStore.keys()]) if (k.startsWith("rollback:")) kvStore.delete(k); deployments = [{ versions: [{ version_id: "vB-new" }] }, { versions: [{ version_id: "vA-old" }] }]; };
const svc = (handler) => ({ fetch: async (url, init) => handler(new URL(url), init?.headers || {}) });
const ok = (b) => new Response(JSON.stringify(b), { status: 200 });

function makeEnv({ fresh = true, tcgPublished = true, fbLatestAgeMin = 5, proxyProblems = [] } = {}) {
  return {
    HEALTHCHECK_KV: kv,
    DISCORD_WEBHOOK_URL: "https://discord.test/hook",
    CLOUDFLARE_API_TOKEN: "tok",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    TOME_SUBSCRIBER_KEY: "sub",
    FASTBREAK_SERVICE: svc((u, h) => (h["X-Tome-Key"] === "sub" ? ok({ players: [] }) : new Response(JSON.stringify({ locked: true }), { status: 401 }))),
    TCG_SERVICE: svc((u, h) => {
      if (u.pathname === "/api/refresh-status") return ok({ ranAt: new Date().toISOString().slice(0, 10), total: 295, failed: 0, published: tcgPublished, reason: tcgPublished ? undefined : "too many failures" });
      return h["X-Tome-Key"] === "sub" ? ok({ sets: [{ set_name: "x" }] }) : ok({ teaser: true, sets: [] });
    }),
    TOPSHOT_SERVICE: svc(() => ok({ moments: [] })),
    PROXY_SERVICE: svc((u) => (u.pathname === "/health" ? ok({ ok: proxyProblems.length === 0, problems: proxyProblems }) : new Response("{}", { status: 404 }))),
    FASTBREAK_REFRESH_SERVICE: svc(() => ok({ leagues: {
      WNBA: { seasonActive: true, cronIntervalMinutes: 30, lastCronTickAgeMs: fresh ? 10 * 60000 : 5 * 3600000, latestAgeMs: fbLatestAgeMin * 60000, lastCronError: null, fulldataAgeMs: 3600000 },
      NBA: { seasonActive: false, cronIntervalMinutes: 15, lastCronTickAgeMs: 10 * 60000, latestAgeMs: null },
    } })),
  };
}

// Healthy: shape checks pass with the key, freshness passes, no alerts.
let res = await worker.fetch(new Request("https://hc/"), makeEnv(), {});
let body = await res.json();
assert.ok(body.results.every((r) => r.healthy), JSON.stringify(body.results));
assert.ok(body.freshness.every((r) => r.healthy), JSON.stringify(body.freshness));

// Missing key: gated targets fail loudly (not silently on a 401/teaser).
res = await worker.fetch(new Request("https://hc/"), { ...makeEnv(), TOME_SUBSCRIBER_KEY: "" }, {});
body = await res.json();
assert.ok(body.results.filter((r) => !r.healthy).map((r) => r.name).includes("tcg"), "tcg teaser rejected");
assert.ok(body.results.filter((r) => !r.healthy).map((r) => r.name).includes("fastbreak"), "fastbreak 401 rejected");

// Wrong key -> teaser for tcg must fail validation.
res = await worker.fetch(new Request("https://hc/"), { ...makeEnv(), TOME_SUBSCRIBER_KEY: "wrong" }, {});
body = await res.json();
assert.equal(body.results.find((r) => r.name === "tcg").healthy, false, "teaser is not a healthy payload");

// tome-proxy relays its own problem list; a bad shape is a failure too.
res = await worker.fetch(new Request("https://hc/"), makeEnv({ proxyProblems: ["graded snapshot is 41 h old"] }), {});
body = await res.json();
assert.equal(body.freshness.find((r) => r.name === "tome-proxy").healthy, false, "tome-proxy problem relayed");
assert.match(body.freshness.find((r) => r.name === "tome-proxy").reason, /41 h old/);
res = await worker.fetch(new Request("https://hc/"), { ...makeEnv(), PROXY_SERVICE: svc(() => ok({ hello: 1 })) }, {});
body = await res.json();
assert.equal(body.freshness.find((r) => r.name === "tome-proxy").healthy, false, "bad /health shape is unhealthy");

// Stopped cron + unpublished tcg run: freshness alert, no rollback attempt.
posts.length = 0;
await worker.scheduled({}, makeEnv({ fresh: false, tcgPublished: false, fbLatestAgeMin: 300 }), {});
const alerts = posts.filter((p) => p.url.includes("discord.test"));
assert.equal(alerts.length, 1, "exactly one freshness alert");
assert.match(alerts[0].body.content, /pipeline warning/);
assert.match(alerts[0].body.content, /WNBA: cron last ticked/);
assert.match(alerts[0].body.content, /latest snapshot is/);
assert.match(alerts[0].body.content, /did not publish/);
assert.ok(!posts.some((p) => p.url.includes("/deployments")), "no rollback for freshness problems");
// Same problem again within 6h: no re-alert.
posts.length = 0;
await worker.scheduled({}, makeEnv({ fresh: false, tcgPublished: false, fbLatestAgeMin: 300 }), {});
assert.equal(posts.filter((p) => p.url.includes("discord.test")).length, 0, "freshness alert de-duplicated");

// Error-rate check: 5%+ and >=3 errors in the last hour -> alert (only), token
// without analytics permission -> surfaced as a problem, not silently ignored.
kvStore.delete("freshness:last_alert");
analytics = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ dimensions: { scriptName: "tome-fastbreak-refresh" }, sum: { requests: 40, errors: 6 } }, { dimensions: { scriptName: "tome-tcg" }, sum: { requests: 100, errors: 1 } }] }] } } };
posts.length = 0;
await worker.scheduled({}, makeEnv(), {});
let er = posts.filter((p) => p.url.includes("discord.test"));
assert.equal(er.length, 1, "error-rate alert sent");
assert.match(er[0].body.content, /tome-fastbreak-refresh: 6 errors \/ 40 invocations/);
assert.ok(!er[0].body.content.includes("tome-tcg:"), "1% error rate does not alert");
assert.ok(!posts.some((p) => p.url.includes("/deployments")), "no rollback for error-rate problems");
analytics = { errors: [{ message: "authentication error" }] };
kvStore.delete("freshness:last_alert");
posts.length = 0;
await worker.scheduled({}, makeEnv(), {});
er = posts.filter((p) => p.url.includes("discord.test"));
assert.match(er[0].body.content, /Account Analytics: Read/, "missing analytics permission is reported");

// -- Rollback guards (2026-11-05) ------------------------------------------------
analytics = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } };
const timeoutSvc = svc(async () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; });
const brokenSvc = svc(() => ok({ nope: true })); // 200 but wrong shape
const fiveHundredSvc = svc(() => new Response("boom", { status: 500 }));

// 1. A timeout never rolls back, no matter how many times in a row.
resetRollbackState(); kvStore.delete("freshness:last_alert");
for (let i = 0; i < 3; i++) { posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: timeoutSvc }, {}); }
assert.equal(allRollbacks().length, 0, "timeout must not trigger a rollback");
assert.match(posts.find((p) => p.url.includes("discord.test")).body.content, /no rollback: timeout/);
assert.match(posts.find((p) => p.url.includes("discord.test")).body.content, /25s/, "timeout reason reports the 25s limit");

// 2. One shape failure: alert, no rollback. Second consecutive: rollback to vA-old.
resetRollbackState();
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: brokenSvc }, {});
assert.equal(rollbackPosts().length, 0, "first shape failure does not roll back");
assert.match(posts.find((p) => p.url.includes("discord.test")).body.content, /1\/2 consecutive/);
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: brokenSvc }, {});
assert.equal(rollbackPosts().length, 1, "second consecutive shape failure rolls back");
assert.equal(rollbackPosts()[0].body.versions[0].version_id, "vA-old");
assert.equal(deployments[0].versions[0].version_id, "vA-old", "vA-old is now live");
assert.deepEqual(kvStore.get("rollback:bad_versions:tome-fastbreak") && JSON.parse(kvStore.get("rollback:bad_versions:tome-fastbreak")), ["vB-new"], "rolled-back-from version remembered");

// 3. Ping-pong: still failing after the rollback. "Previous" is now vB-new, which
//    is known-bad, so there is no eligible candidate -> no deploy, human alert.
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: brokenSvc }, {});
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: brokenSvc }, {});
assert.equal(allRollbacks().length, 1, "never redeploys a version it already rolled back from (still just the one deploy)");
assert.equal(deployments[0].versions[0].version_id, "vA-old", "live version unchanged");
const refused = posts.filter((p) => p.url.includes("discord.test")).map((p) => p.body.content).join("\n");
assert.match(refused, /No eligible prior version/, "refusal is explained");
assert.match(refused, /needs a human/);

// 4. Equality guard: if the list somehow shows the same version twice, skip it.
resetRollbackState();
deployments = [{ versions: [{ version_id: "vSame" }] }, { versions: [{ version_id: "vSame" }] }, { versions: [{ version_id: "vOlder" }] }];
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: fiveHundredSvc }, {});
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: fiveHundredSvc }, {});
assert.equal(rollbackPosts().length, 1, "5xx twice rolls back");
assert.equal(rollbackPosts()[0].body.versions[0].version_id, "vOlder", "skips a candidate equal to the live version");

// 5. A healthy run resets the counter: fail, pass, fail -> no rollback.
resetRollbackState();
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: brokenSvc }, {});
await worker.scheduled({}, makeEnv(), {});
posts.length = 0; await worker.scheduled({}, { ...makeEnv(), FASTBREAK_SERVICE: brokenSvc }, {});
assert.equal(allRollbacks().length, 0, "a healthy run between failures resets the count");

// 6. 4xx (bad key) never rolls back.
resetRollbackState();
for (let i = 0; i < 3; i++) { posts.length = 0; await worker.scheduled({}, { ...makeEnv(), TOME_SUBSCRIBER_KEY: "wrong" }, {}); }
assert.equal(allRollbacks().length, 0, "4xx/teaser is a key problem, not a deploy problem");
assert.match(posts.find((p) => p.url.includes("discord.test")).body.content, /no rollback: auth/);

console.log("ALL HEALTHCHECK LOCAL TESTS PASSED (incl. rollback guards)");
