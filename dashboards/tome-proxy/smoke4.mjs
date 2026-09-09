// Smoke test v4: subscription-id gate, KV cache + webhook eviction, /mycards, aggregate.
const upstreamUrls = [];
const beehiivCalls = [];
const discordPosts = [];
let beehiivMode = 'vault';   // vault | edge | inactive | missing | down
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'discord.test') { discordPosts.push(JSON.parse(opts.body)); return new Response(null, { status: 204 }); }
  if (u.hostname === 'api.beehiiv.com') {
    beehiivCalls.push(url);
    if (beehiivMode === 'down') return new Response('nope', { status: 500 });
    if (beehiivMode === 'missing') return new Response('{}', { status: 404 });
    const tier = beehiivMode === 'edge'
      ? { id: 'tier_c63b9d3e-154e-433c-8e05-a7e70c07e283', name: 'Tome Edge' }
      : { id: 'tier_66e3700d-872f-4fab-bdb5-539420e34e12', name: 'Tome Vault' };
    return Response.json({ data: { id: 'sub_x', status: beehiivMode === 'inactive' ? 'inactive' : 'active', premium_tiers: [tier] } });
  }
  upstreamUrls.push(url);
  return Response.json({ data: [] });
};
globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };

const mod = await import('./worker.js');
const kv = new Map();
const KV = {
  async get(k, type) { const v = kv.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
};
const env = {
  JUSTTCG_API_KEY: 'jt', DISCORD_WEBHOOK_URL: 'https://discord.test/hook',
  TOME_SUBSCRIBER_KEYS: 'shared-key',
  BEEHIIV_API_KEY: 'bh', BEEHIIV_PUBLICATION_ID: 'pub_1', BEEHIIV_WEBHOOK_TOKEN: 'hooktoken',
  SNAPSHOTS: KV,
};
const ctx = { waitUntil(p) { this.p = p; } };
const BASE = 'https://tome-proxy.test';
const SID = 'sub_5dc5a2a7-2029-4e37-99a1-ea357f68c9ad';
const call = (path, init = {}) => mod.default.fetch(new Request(BASE + path, { headers: { Origin: 'https://tomecollective.github.io', ...(init.headers || {}) }, ...init }), env, ctx);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };

let r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID } });
assert(r.status === 200, 'active Vault subscription id -> 200');
assert(beehiivCalls.length === 1 && beehiivCalls[0].includes(`/publications/pub_1/subscriptions/${SID}?expand`), 'Beehiiv looked up once with expand');
await ctx.p;
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID } });
assert(r.status === 200 && beehiivCalls.length === 1, 'second request served from KV cache (no Beehiiv call)');
assert(kv.has(`sub:${SID}`), 'cache entry written to KV');

upstreamUrls.length = 0;
r = await call(`/cards?game=pokemon&sid=${SID}`);
assert(r.status === 200 && upstreamUrls.length === 1 && !upstreamUrls[0].includes('sid='), '?sid= accepted and scrubbed before JustTCG');

r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': 'sub_not-a-uuid' } });
assert(r.status === 401, 'malformed id -> 401 without calling Beehiiv');
assert(beehiivCalls.length === 1, 'malformed id did not hit Beehiiv');

r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': '5dc5a2a7-2029-4e37-99a1-ea357f68c9ad' } });
assert(r.status === 200, 'bare uuid normalised to sub_ and accepted from cache');

// Webhook eviction then tier downgrade
r = await call('/hooks/beehiiv/wrong', { method: 'POST', body: JSON.stringify({ data: { id: SID } }) });
assert(r.status === 404, 'webhook with wrong token -> 404');
r = await call('/hooks/beehiiv/hooktoken', { method: 'POST', body: JSON.stringify({ event_type: 'subscription.tier.deleted', data: { id: SID } }) });
let j = await r.json();
assert(r.status === 200 && j.evicted === true && !kv.has(`sub:${SID}`), 'webhook with token evicts the cache entry');
beehiivMode = 'edge';
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID } });
j = await r.json();
assert(r.status === 401 && j.locked && j.reason === 'tier', 'Edge-only subscription -> 401 reason=tier');
await ctx.p;
kv.delete(`sub:${SID}`);
beehiivMode = 'inactive';
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID } });
j = await r.json();
assert(r.status === 401 && j.reason === 'inactive', 'inactive subscription -> 401 reason=inactive');
await ctx.p;
kv.delete(`sub:${SID}`);
beehiivMode = 'missing';
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID } });
j = await r.json();
assert(r.status === 401 && j.reason === 'unknown', 'unknown subscription -> 401 reason=unknown');
await ctx.p;
kv.delete(`sub:${SID}`);
beehiivMode = 'down';
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID } });
j = await r.json();
assert(r.status === 503 && j.retry === true, 'Beehiiv down with no cache -> 503 retry (fails closed)');
// Stale-serve during outage
kv.set(`sub:${SID}`, JSON.stringify({ found: true, status: 'active', tiers: ['tier_66e3700d-872f-4fab-bdb5-539420e34e12'], names: [], at: Date.now() - 48 * 3600 * 1000 }));
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID } });
assert(r.status === 200, 'Beehiiv down but a stale cache entry exists -> served (grace)');
beehiivMode = 'vault';

// Shared key still works and takes precedence
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Key': 'shared-key' } });
assert(r.status === 200, 'shared key still accepted');

// My Cards
r = await call('/mycards', { headers: { 'X-Tome-Key': 'shared-key' } });
j = await r.json();
assert(r.status === 200 && j.sync === false, 'shared-key session: /mycards says sync:false');
r = await call('/mycards', { headers: { 'X-Tome-Sub': SID } });
j = await r.json();
assert(r.status === 200 && j.sync === true && Array.isArray(j.cards) && j.cards.length === 0, 'new subscriber: empty list');
r = await call('/mycards', { method: 'PUT', headers: { 'X-Tome-Sub': SID, 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: ['a1', 'a1', ' b2 ', 7, ''] }) });
j = await r.json();
assert(r.status === 200 && j.ok && j.count === 2, 'PUT dedupes/trims and stores 2 cards');
r = await call('/mycards', { headers: { 'X-Tome-Sub': SID } });
j = await r.json();
assert(j.cards.join(',') === 'a1,b2' && j.updatedAt, 'GET returns stored cards + updatedAt');
r = await call('/mycards', { method: 'PUT', headers: { 'X-Tome-Sub': SID }, body: JSON.stringify({ cards: Array.from({ length: 501 }, (_, i) => 'c' + i) }) });
assert(r.status === 400, 'PUT over 500 cards -> 400');
r = await call('/mycards', { method: 'PUT', headers: { 'X-Tome-Sub': SID }, body: JSON.stringify({ cards: 'x' }) });
assert(r.status === 400, 'PUT non-array -> 400');
r = await call('/mycards', { method: 'DELETE', headers: { 'X-Tome-Sub': SID } });
assert(r.status === 405, 'DELETE /mycards -> 405');
r = await call('/mycards');
assert(r.status === 401, '/mycards without credentials -> 401');

// Aggregate
kv.set('mycards:sub_other', JSON.stringify({ cards: ['a1', 'z9'], updatedAt: 'x' }));
r = await call('/cards', { method: 'OPTIONS' });
assert(r.headers.get('Access-Control-Allow-Headers').includes('X-Tome-Sub') && r.headers.get('Access-Control-Allow-Methods').includes('PUT'), 'CORS allows X-Tome-Sub and PUT');
assert(!r.headers.has('X-Tome-RL'), 'X-Tome-RL diagnostic header removed');
console.log('beehiiv calls:', beehiivCalls.length);
// Precedence: sub id wins over key when both present; key rescues a denied/unknown sub.
beehiivMode = 'vault'; kv.delete(`sub:${SID}`);
r = await call('/mycards', { headers: { 'X-Tome-Sub': SID, 'X-Tome-Key': 'shared-key' } });
j = await r.json();
assert(r.status === 200 && j.sync === true, 'both credentials: subscription wins (sync on)');
await ctx.p;
kv.delete(`sub:${SID}`); beehiivMode = 'missing';
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID, 'X-Tome-Key': 'shared-key' } });
assert(r.status === 200, 'unknown sub + valid key -> key rescues (200)');
await ctx.p;
kv.delete(`sub:${SID}`); beehiivMode = 'down';
r = await call('/cards?game=pokemon', { headers: { 'X-Tome-Sub': SID, 'X-Tome-Key': 'shared-key' } });
assert(r.status === 200, 'Beehiiv down + valid key -> key rescues (200)');
beehiivMode = 'vault';
