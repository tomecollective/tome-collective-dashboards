// Smoke test v5: /health + cron:last recording.
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'discord.test') return new Response(null, { status: 204 });
  return Response.json({ data: [] });
};
globalThis.caches = { default: { async match() {}, async put() {} } };
const mod = await import('./worker.js');
const kv = new Map();
const KV = { async get(k, t) { const v = kv.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); }, async list({ prefix }) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
const env = { JUSTTCG_API_KEY: 'j', SNAPSHOTS: KV, DISCORD_WEBHOOK_URL: 'https://discord.test/h', TOME_SUBSCRIBER_KEYS: 'k', PUBLIC_RATE_LIMITER: { async limit() { return { success: false }; } } };
const call = (path) => mod.default.fetch(new Request('https://tome-proxy.test' + path), env, { waitUntil() {} });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };

let r = await call('/health'); let j = await r.json();
assert(r.status === 200 && j.ok === false && j.problems.some(p => p.includes('never recorded')), '/health before any run: not ok, explains why');
assert(r.status === 200, '/health bypasses the per-IP limiter (limiter stub denies everything)');

let done; await mod.default.scheduled({}, env, { waitUntil(p) { done = p; } }); await done;
const cron = JSON.parse(kv.get('cron:last'));
assert(cron.ok === true && cron.steps.length === 3 && cron.steps.every(s => s.ok), 'cron:last records a successful 3-step run');
r = await call('/health'); j = await r.json();
assert(j.cron.ok === true && j.graded && j.graded.ageMs < 5000 && j.scoreHistory && j.scoreHistory.ageDays === 0, '/health after a run: fresh graded + score-history');
assert(!('data' in (j.graded || {})), '/health never includes price data');

// Force step 3 to throw (KV write of the score-history entry fails)
const KV2 = { ...KV, async put(k, v) { if (k.startsWith('score-history:')) throw new Error('KV quota exceeded'); kv.set(k, v); } };
await mod.default.scheduled({}, { ...env, SNAPSHOTS: KV2 }, { waitUntil(p) { done = p; } }); await done;
const cron2 = JSON.parse(kv.get('cron:last'));
assert(cron2.ok === false && cron2.step === 'captureScoreHistoryAndDigest' && /KV quota exceeded/.test(cron2.error) && cron2.steps.length === 3 && cron2.steps[2].ok === false, 'failing step recorded with name + error');
r = await call('/health'); j = await r.json();
assert(j.ok === false && j.problems.some(p => p.includes('last run failed at captureScoreHistoryAndDigest')), '/health surfaces the failed step');

// Stale + rate-limited snapshot
kv.set('graded-prices', JSON.stringify({ updatedAt: new Date(Date.now() - 40 * 3600000).toISOString(), cardsChecked: 500, bucketLive: 3, liveCount: 40, statusCounts: { ok: 3, '429': 400 }, data: {} }));
r = await call('/health'); j = await r.json();
assert(j.problems.some(p => p.includes('h old')) && j.problems.some(p => p.includes('rate-limited')), 'stale + rate-limited snapshot both flagged');
console.log('done');
