// node dashboards/fastbreak/worker/_local_test.mjs -- subscriber gate + admin verify on the public Worker.
import assert from "node:assert/strict";
const worker = (await import("./index.js")).default;
const store = new Map([["fastbreak:latest", JSON.stringify({ league: "WNBA", players: [1] })]]);
const env = { FASTBREAK_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) }, FASTBREAK_ADMIN_TOKEN: "t", TOME_SUBSCRIBER_KEYS: "s1" };
let r = await worker.fetch(new Request("https://x/api/fastbreak"), env); assert.equal(r.status, 401);
r = await worker.fetch(new Request("https://x/api/fastbreak?key=s1"), env); assert.equal(r.status, 200);
r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Tome-Key": "s1" } }), env); assert.equal(r.status, 200);
r = await worker.fetch(new Request("https://x/api/fastbreak", { headers: { "X-Admin-Token": "t" } }), env); assert.equal(r.status, 200);
r = await worker.fetch(new Request("https://x/api/fastbreak"), { ...env, TOME_SUBSCRIBER_KEYS: "" }); assert.equal(r.status, 503);
r = await worker.fetch(new Request("https://x/api/fastbreak/objectives"), env); assert.equal(r.status, 401);
r = await worker.fetch(new Request("https://x/api/fastbreak/admin/verify", { method: "POST", headers: { "X-Admin-Token": "t" } }), env); assert.equal(r.status, 200);
r = await worker.fetch(new Request("https://x/api/fastbreak?key=s1"), { ...env, PUBLIC_RATE_LIMITER: { limit: async () => ({ success: false }) } }); assert.equal(r.status, 429);
console.log("public worker gate ok");
