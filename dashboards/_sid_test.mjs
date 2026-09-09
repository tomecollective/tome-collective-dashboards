// node dashboards/_sid_test.mjs -- subscription-id path on tome-fastbreak,
// tome-fastbreak-refresh, and tome-tcg with a stubbed AUTH service binding.
import assert from "node:assert/strict";
const SID = "sub_5dc5a2a7-2029-4e37-99a1-ea357f68c9ad";
const calls = [];
function authStub(answer) {
  return { fetch: async (req) => { calls.push({ url: req.url, tok: req.headers.get("X-Tome-Internal") });
    if (answer === "down") return new Response("{}", { status: 503 });
    return Response.json(answer); } };
}
const ok = (m) => console.log("ok:", m);

// -- tome-fastbreak (relay) --
{
  const worker = (await import("./fastbreak/worker/index.js")).default;
  const store = new Map([["fastbreak:latest", JSON.stringify({ league: "WNBA", players: [1] })]]);
  const base = { FASTBREAK_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) }, FASTBREAK_ADMIN_TOKEN: "t", TOME_SUBSCRIBER_KEYS: "s1", TOME_INTERNAL_TOKEN: "itok" };
  let env = { ...base, AUTH: authStub({ allowed: true, reason: null }) };
  let r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Tome-Sub": SID } }), env);
  assert.equal(r.status, 200); ok("fastbreak: allowed sid -> 200");
  assert.ok(calls.at(-1).url.includes(`sid=${encodeURIComponent(SID)}`) && calls.at(-1).url.includes("need=edge") && calls.at(-1).tok === "itok"); ok("fastbreak: asks tome-proxy with need=edge + internal token");
  r = await worker.fetch(new Request(`https://x/api/fastbreak?sid=${SID}`), env); assert.equal(r.status, 200); ok("fastbreak: ?sid= accepted");
  env = { ...base, AUTH: authStub({ allowed: false, reason: "tier" }) };
  r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Tome-Sub": SID } }), env);
  let j = await r.json(); assert.equal(r.status, 401); assert.equal(j.reason, "tier"); assert.equal(j.locked, true); ok("fastbreak: Vault-only sid -> 401 reason=tier");
  r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Tome-Sub": SID, "X-Tome-Key": "s1" } }), env);
  assert.equal(r.status, 200); ok("fastbreak: denied sid + valid key -> key rescues");
  env = { ...base, AUTH: authStub("down") };
  r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Tome-Sub": SID } }), env);
  j = await r.json(); assert.equal(r.status, 503); assert.equal(j.retry, true); ok("fastbreak: tome-proxy down -> 503 retry");
  env = { ...base, TOME_SUBSCRIBER_KEYS: "", AUTH: authStub({ allowed: true }) };
  r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Tome-Sub": SID } }), env);
  assert.equal(r.status, 200); ok("fastbreak: keys unset but sid allowed -> 200 (keys can be retired)");
  env = { ...base, AUTH: undefined };
  r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Tome-Sub": SID } }), env);
  assert.equal(r.status, 401); ok("fastbreak: no AUTH binding -> sid ignored, 401");
  r = await worker.fetch(new Request("https://x/api/fastbreak", { method: "OPTIONS" }), env);
  assert.ok(r.headers.get("Access-Control-Allow-Headers").includes("X-Tome-Sub")); ok("fastbreak: CORS allows X-Tome-Sub");
}

// -- tome-fastbreak-refresh (what the page calls) --
{
  const worker = (await import("./fastbreak-refresh/worker/index.js")).default;
  const store = new Map([["fastbreak:latest", JSON.stringify({ league: "WNBA", players: [1] })], ["fastbreak:latest:WNBA", JSON.stringify({ league: "WNBA", players: [1] })]]);
  const base = { FASTBREAK_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v), delete: async () => {} }, FASTBREAK_ADMIN_TOKEN: "t", TOME_SUBSCRIBER_KEYS: "s1", TOME_INTERNAL_TOKEN: "itok", BALLDONTLIE_API_KEY: "b" };
  let env = { ...base, AUTH: authStub({ allowed: true }) };
  let r = await worker.fetch(new Request("https://x/api/fastbreak/objectives", { headers: { "X-Tome-Sub": SID } }), env, { waitUntil() {} });
  assert.equal(r.status, 200); ok("refresh: allowed sid -> 200 on /objectives");
  env = { ...base, AUTH: authStub({ allowed: false, reason: "inactive" }) };
  r = await worker.fetch(new Request("https://x/api/fastbreak/objectives", { headers: { "X-Tome-Sub": SID } }), env, { waitUntil() {} });
  const j = await r.json(); assert.equal(r.status, 401); assert.equal(j.reason, "inactive"); ok("refresh: inactive sid -> 401 reason=inactive");
  r = await worker.fetch(new Request("https://x/api/fastbreak/objectives", { headers: { "X-Tome-Key": "s1" } }), env, { waitUntil() {} });
  assert.equal(r.status, 200); ok("refresh: shared key still works");
}

// -- tome-tcg (full payload vs teaser) --
{
  // Node needs an import attribute on the seed JSON that wrangler resolves bare (same trick as tcg/worker/_local_test.mjs).
  const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
  const tmp = new URL("./tcg/worker/_index.sid-test-copy.mjs", import.meta.url);
  writeFileSync(tmp, readFileSync(new URL("./tcg/worker/index.js", import.meta.url), "utf8").replace('from "../data/chase-50-modern-seed.json";', 'from "../data/chase-50-modern-seed.json" with { type: "json" };'));
  let worker;
  try { worker = (await import(tmp)).default; } finally { unlinkSync(tmp); }
  const payload = { holdings: Array.from({ length: 50 }, (_, i) => ({ name: "c" + i, history: [] })), sets: [], index: [] };
  const base = { CHASE_INDEX_KV: { get: async (k) => k.includes("latest") ? JSON.stringify(payload) : null, put: async () => {}, delete: async () => {} }, TCG_ADMIN_TOKEN: "t", TOME_SUBSCRIBER_KEYS: "s1", TOME_INTERNAL_TOKEN: "itok", JUSTTCG_API_KEY: "j" };
  let env = { ...base, AUTH: authStub({ allowed: true }) };
  let r = await worker.fetch(new Request("https://x/api/chase-index", { headers: { "X-Tome-Sub": SID } }), env, { waitUntil() {} });
  let j = await r.json(); assert.equal(r.status, 200); assert.ok(!j.teaser); ok("tcg: allowed sid -> full payload");
  assert.ok(calls.at(-1).url.includes("need=vault")); ok("tcg: asks with need=vault");
  env = { ...base, AUTH: authStub({ allowed: false, reason: "tier" }) };
  r = await worker.fetch(new Request("https://x/api/chase-index", { headers: { "X-Tome-Sub": SID } }), env, { waitUntil() {} });
  j = await r.json(); assert.equal(j.teaser, true); ok("tcg: Edge-only sid -> teaser");
  r = await worker.fetch(new Request("https://x/api/chase-index", { headers: { "X-Tome-Sub": SID, "X-Tome-Key": "s1" } }), env, { waitUntil() {} });
  j = await r.json(); assert.ok(!j.teaser); ok("tcg: key still unlocks full payload");
}
console.log("ALL SID TESTS PASSED");
