// Smoke test v6: /feed tag-filtered RSS.
let calls = 0;
const posts = [
  { id: 'p1', title: 'NFL · Recap & Results', subtitle: 'Seahawks 13, Patriots 10', web_url: 'https://read.tomecollective.com/p/nfl-recap-results-september-9-2026', publish_date: 1757500000, platform: 'web', hidden_from_feed: false, content_tags: ['Recap', 'NFL', '2026 NFL Season'], thumbnail_url: 'https://x/a.png' },
  { id: 'p2', title: 'NFL · Preview & Predictions', subtitle: '49ers-Rams', web_url: 'https://read.tomecollective.com/p/nfl-preview-predictions-september-10-2026', publish_date: 1757400000, platform: 'web', hidden_from_feed: false, content_tags: ['Preview', 'NFL'] },
  { id: 'p3', title: 'Dashboards', web_url: 'https://read.tomecollective.com/p/dashboards', publish_date: 1757300000, platform: 'web', hidden_from_feed: true, content_tags: ['Dashboards'] },
  { id: 'p4', title: 'WNBA · Recap & Results', web_url: 'https://read.tomecollective.com/p/wnba-recap-results-august-30-2026', publish_date: 1756500000, platform: 'web', hidden_from_feed: false, content_tags: ['WNBA', 'Recap'] },
  { id: 'p5', title: 'Email only', web_url: 'https://read.tomecollective.com/p/x', publish_date: 1756400000, platform: 'email', hidden_from_feed: false, content_tags: ['NFL', 'Recap'] },
];
globalThis.fetch = async (url) => {
  const u = new URL(url); calls++;
  if (u.hostname === 'api.beehiiv.com') {
    const want = u.searchParams.getAll('content_tags[]');
    return Response.json({ data: posts.filter(p => want.every(t => p.content_tags.map(x => x.toLowerCase()).includes(t))) });
  }
  return Response.json({ data: [] });
};
globalThis.caches = { default: { async match() {}, async put() {} } };
const mod = await import('./worker.js');
const kv = new Map();
const KV = { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
const env = { JUSTTCG_API_KEY: 'j', SNAPSHOTS: KV, BEEHIIV_API_KEY: 'b', BEEHIIV_PUBLICATION_ID: 'pub_x', TOME_SUBSCRIBER_KEYS: 'k', PUBLIC_RATE_LIMITER: { async limit() { return { success: true }; } } };
const pending = [];
const call = (path) => mod.default.fetch(new Request('https://tome-proxy.test' + path), env, { waitUntil(p) { pending.push(p); } });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); };

let r = await call('/feed?tags=nfl,recap'); let x = await r.text(); await Promise.all(pending);
assert(r.status === 200 && r.headers.get('content-type').startsWith('application/rss+xml'), '/feed returns RSS without any key or sid');
assert(x.includes('nfl-recap-results-september-9-2026') && !x.includes('nfl-preview') && !x.includes('wnba-recap'), 'tags are ANDed, case-insensitive');
assert(!x.includes('/p/dashboards'), 'hidden_from_feed posts are skipped');
assert(!x.includes('Email only'), 'email-only posts are skipped');
assert(x.includes('<category><![CDATA[Recap]]></category>') && x.includes('<enclosure'), 'categories + thumbnail enclosure present for the Squarespace filters');
const before = calls; r = await call('/feed?tags=nfl,recap'); await r.text();
assert(calls === before && kv.has('feed:nfl,recap:30'), 'second call served from KV cache');
r = await call('/feed?tags=wnba'); x = await r.text();
assert(x.includes('wnba-recap-results-august-30-2026') && !x.includes('nfl-'), 'wnba feed only returns wnba posts');
r = await call('/feed'); x = await r.text();
assert((x.match(/<item>/g) || []).length === 3, 'untagged feed lists every public web post');
r = await call('/feed?tags=nfl', ); assert(r.status === 200, 'single tag ok');
r = await mod.default.fetch(new Request('https://tome-proxy.test/feed?tags=nfl'), { ...env, BEEHIIV_API_KEY: '' }, { waitUntil() {} });
assert(r.status === 503, '503 when Beehiiv not configured');
r = await mod.default.fetch(new Request('https://tome-proxy.test/feed?tags=nfl'), { ...env, PUBLIC_RATE_LIMITER: { async limit() { return { success: false }; } } }, { waitUntil() {} });
assert(r.status === 429, '/feed is behind the per-IP limiter');
console.log('done');
