// node dashboards/healthcheck/_local_test.mjs
// Exercises the healthcheck Worker with fake service bindings: gated shape
// checks send the subscriber key and reject a teaser; freshness checks flag a
// stopped cron / unpublished refresh and alert (once) without rolling back.
import assert from "node:assert/strict";
const worker = (await import("./index.js")).default;

const posts = [];
let analytics = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ dimensions: { scriptName: "tome-tcg" }, sum: { requests: 100, errors: 0 } }] }] } } };
globalThis.fetch = async (url, init) => {
  posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  if (String(url).includes("/graphql")) return new Response(JSON.stringify(analytics), { status: 200 });
  return new Response("{}", { status: 200 });
};
const kvStore = new Map();
const kv = { get: async (k, t) => { const v = kvStore.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k, v) => kvStore.set(k, String(v)) };
const svc = (handler) => ({ fetch: async (url, init) => handler(new URL(url), init?.headers || {}) });
const ok = (b) => new Response(JSON.stringify(b), { status: 200 });

function makeEnv({ fresh = true, tcgPublished = true, fbLatestAgeMin = 5 } = {}) {
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
console.log("ALL HEALTHCHECK LOCAL TESTS PASSED");
