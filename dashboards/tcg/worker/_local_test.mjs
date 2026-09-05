// node dashboards/tcg/worker/_local_test.mjs
// Covers the /api/refresh auth gate: anonymous POST -> 401, admin token ->
// starts a run, chained resume -> only with the per-run nonce. JustTCG is
// mocked so no network is touched.
import assert from "node:assert/strict";

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) { const v = store.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes("api.justtcg.com")) {
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url);
};

// wrangler resolves the bare JSON import; Node needs an import attribute, so
// test against a temp copy of index.js with the attribute added.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, "_index.test-copy.mjs");
writeFileSync(tmp, readFileSync(join(here, "index.js"), "utf8").replace('from "../data/chase-50-modern-seed.json";', 'from "../data/chase-50-modern-seed.json" with { type: "json" };'));
let worker;
try { worker = (await import(tmp)).default; } finally { unlinkSync(tmp); }
const chained = [];
const env = {
  CHASE_INDEX_KV: makeKV(),
  JUSTTCG_API_KEY: "k",
  TCG_ADMIN_TOKEN: "admin-secret",
  SELF: { fetch: async (url, init) => { chained.push({ url: String(url), headers: init?.headers || {} }); return new Response("{}"); } },
};
const ctx = { waitUntil: (p) => p.catch(() => {}) };
const post = (path, headers = {}) => worker.fetch(new Request(`https://x${path}`, { method: "POST", headers }), env, ctx);

let res = await post("/api/refresh");
assert.equal(res.status, 401, "anonymous fresh run rejected");
res = await post("/api/refresh", { "X-Admin-Token": "wrong" });
assert.equal(res.status, 401, "wrong token rejected");
res = await post("/api/refresh?resume=1");
assert.equal(res.status, 401, "anonymous resume rejected");
res = await post("/api/refresh?resume=1", { "X-Admin-Token": "admin-secret" });
assert.equal(res.status, 401, "admin token does not authorize a resume (nonce only)");
assert.equal(chained.length, 0, "nothing chained yet");

res = await post("/api/refresh", { "X-Admin-Token": "admin-secret" });
assert.equal(res.status, 200, "admin token starts a run");
await new Promise((r) => setTimeout(r, 10));
const progress = await env.CHASE_INDEX_KV.get("refresh:progress", "json");
assert.ok(progress && progress.chainNonce, "progress carries a chain nonce");
assert.equal(chained.length, 1, "first batch chained to resume");
assert.equal(chained[0].headers["X-Refresh-Chain"], progress.chainNonce, "chain presents the nonce");

res = await post("/api/refresh?resume=1", { "X-Refresh-Chain": "not-the-nonce" });
assert.equal(res.status, 401, "wrong nonce rejected");
res = await post("/api/refresh?resume=1", { "X-Refresh-Chain": progress.chainNonce });
assert.equal(res.status, 200, "correct nonce continues the run");

res = await post("/api/refresh", { "X-Admin-Token": "admin-secret" }).then(() => worker.fetch(new Request("https://x/api/refresh", { method: "POST", headers: { "X-Admin-Token": "admin-secret" } }), { ...env, TCG_ADMIN_TOKEN: "" }, ctx));
assert.equal(res.status, 401, "unset secret fails closed");

// Subscriber gate on the index: no key -> teaser only; key/admin -> full.
env.TOME_SUBSCRIBER_KEYS = "sub-a, sub-b";
res = await worker.fetch(new Request("https://x/api/chase-index"), env, ctx);
assert.equal(res.status, 200, "public read still works");
let teaser = await res.json();
assert.equal(teaser.teaser, true, "anonymous gets teaser");
assert.equal(teaser.sets.length, 0, "no candidate pool in teaser");
assert.ok(teaser.topHoldings.length <= 10, "top 10 max");
assert.ok(teaser.topHoldings.every((c) => (c.history || []).length <= 8), "history tail capped");
assert.ok(Array.isArray(teaser.indexHistory), "index series present");
res = await worker.fetch(new Request("https://x/api/chase-index?key=sub-b"), env, ctx);
let full = await res.json();
assert.ok(!full.teaser && full.sets.length > 0, "subscriber key gets the full payload");
res = await worker.fetch(new Request("https://x/api/chase-index", { headers: { "X-Tome-Key": "nope" } }), env, ctx);
assert.equal((await res.json()).teaser, true, "wrong key -> teaser");
res = await worker.fetch(new Request("https://x/api/chase-index", { headers: { "X-Admin-Token": "admin-secret" } }), env, ctx);
assert.ok(!(await res.json()).teaser, "admin token -> full");
res = await worker.fetch(new Request("https://x/api/chase-index?key=sub-b"), { ...env, TOME_SUBSCRIBER_KEYS: "" }, ctx);
assert.equal((await res.json()).teaser, true, "unset subscriber secret -> teaser for everyone");
res = await worker.fetch(new Request("https://x/api/debug-card?raw=1&q=Charizard"), env, ctx);
assert.equal(res.status, 401, "debug proxy needs admin token");
res = await worker.fetch(new Request("https://x/api/chase-index?key=sub-b"), { ...env, PUBLIC_RATE_LIMITER: { limit: async () => ({ success: false }) } }, ctx);
assert.equal(res.status, 429, "rate limited");
console.log("ALL TCG LOCAL TESTS PASSED");
