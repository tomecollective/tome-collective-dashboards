// ─── TOME COLLECTIVE — CLOUDFLARE WORKER (proxy + daily snapshot pipeline) ───
// SETUP (one-time, ~5 min):
//   1. Workers & Pages → tome-proxy → Settings → Variables: secret JUSTTCG_API_KEY (already set)
//   2. Storage & Databases → KV → Create namespace: 'TOME_SNAPSHOTS'
//   3. Worker → Settings → Bindings → Add → KV Namespace:
//        Variable name: SNAPSHOTS   Namespace: TOME_SNAPSHOTS
//   4. Worker → Settings → Triggers → Cron Triggers → Add:
//        0 14 * * *        (daily at 14:00 UTC ≈ 9am Central)
//   5. Paste this file over the worker code → Deploy
// Every day the cron stores one compact price snapshot per game (3 KV writes/day —
// far under the 1,000/day free-tier write limit). /history serves the accumulated series.
const ALLOWED_ORIGINS = [
  'https://tomecollective.github.io',
  'https://tomecollective.com',
  'https://www.tomecollective.com',
  'https://read.tomecollective.com',
];
const ALLOWED_PATHS = ['/cards', '/sets', '/history', '/v2/cards', '/graded-prices'];
const JUSTTCG_BASE = 'https://api.justtcg.com/v1';
const JUSTTCG_BASE_V2 = 'https://api.justtcg.com';   // graded-card data lives here, not /v1
const CACHE_TTL = 21600; // 6h — approved by JustTCG in writing
const SNAP_GAMES = ['pokemon', 'disney-lorcana', 'one-piece-card-game'];
const SNAP_PAGES = { 'pokemon': 20, 'disney-lorcana': 4, 'one-piece-card-game': 5 };
const HISTORY_DAYS = 120;   // serve up to 120 days once accumulated
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Tome-Key, X-Tome-Sub',
    'Access-Control-Max-Age': '86400',
  };
}
const jsonError = (message, status, origin, extra) =>
  new Response(JSON.stringify({ error: message, ...(extra || {}) }), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });

// ═══ SUBSCRIBER GATE (Tome Vault) ═══════════════════════════════════════════════
// Same pattern as Fast Break and Chase Index: every data read requires a valid
// X-Tome-Key (or ?key=) matching one of the comma-separated TOME_SUBSCRIBER_KEYS
// values. Unset secret = 503 (fails closed). Comparisons are constant-time and
// every candidate is compared, so timing never reveals a partial match.
const __enc = new TextEncoder();
function secretEquals(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = __enc.encode(presented);
  const b = __enc.encode(expected);
  const sameLength = a.length === b.length;
  const cmp = sameLength ? b : a;   // always do a.length bytes of work
  let equal;
  if (globalThis.crypto?.subtle?.timingSafeEqual) {
    equal = crypto.subtle.timingSafeEqual(a, cmp);
  } else {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ cmp[i];
    equal = diff === 0;
  }
  return sameLength && equal;
}
function secretInList(presented, candidates) {
  let found = false;
  for (const c of candidates) found = secretEquals(presented, c) || found;
  return found;
}
function subscriberKeys(env) {
  return String(env.TOME_SUBSCRIBER_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
}
// ═══ SUBSCRIBER IDENTITY (Beehiiv subscription id) ══════════════════════════════
// The Dashboards post renders {{api_subscription_id}} into each subscriber's Open
// button (Beehiiv fills merge tags on the web view for logged-in readers), so the
// dashboard can present X-Tome-Sub: sub_<uuid> instead of the shared key. The Worker
// resolves that id against the Beehiiv API, caches the answer in KV (sub:<id>), and
// grants access when the subscription is active on an allowed tier. Beehiiv webhooks
// (POST /hooks/beehiiv/<BEEHIIV_WEBHOOK_TOKEN>) evict the cache entry the moment a
// tier changes, so cancellations take effect immediately; the TTL is the backstop.
// Secrets: BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID, BEEHIIV_WEBHOOK_TOKEN.
// Optional var TOME_ALLOWED_TIERS (comma-separated tier ids) overrides the default.
const BEEHIIV_API = 'https://api.beehiiv.com/v2';
const TIER_VAULT  = 'tier_66e3700d-872f-4fab-bdb5-539420e34e12';   // Tome Vault
const TIER_EDGE   = 'tier_c63b9d3e-154e-433c-8e05-a7e70c07e283';   // Tome Edge
const TIER_BUNDLE = 'tier_df25929b-65f3-46ba-9443-d23ce4f19ae2';   // Tome Edge + Tome Vault Bundle
// Which tiers unlock which product. tome-proxy itself is a Vault product; the
// other Workers ask /auth/subscription with need=edge or need=vault.
const PRODUCT_TIERS = {
  vault: [TIER_VAULT, TIER_BUNDLE],
  edge:  [TIER_EDGE, TIER_BUNDLE],
};
const PRODUCT_TIER_NAMES = {
  vault: ['tome vault', 'tome edge + tome vault bundle'],
  edge:  ['tome edge', 'tome edge + tome vault bundle'],
};
const DEFAULT_ALLOWED_TIERS = PRODUCT_TIERS.vault;
const SUB_CACHE_FRESH_MS = 6 * 3600 * 1000;      // re-check Beehiiv after 6h (webhooks evict sooner)
const SUB_CACHE_NEGATIVE_MS = 30 * 60 * 1000;    // unknown / inactive ids are re-checked after 30 min
const SUB_CACHE_KV_TTL = 7 * 86400;              // KV expiry: stale entries are grace-served only during a Beehiiv outage
const SUB_ID_RE = /^sub_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeSubId(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (!s.startsWith('sub_')) s = 'sub_' + s;      // tolerate a bare uuid
  return SUB_ID_RE.test(s) ? s : null;
}
function allowedTiers(env) {
  const custom = String(env.TOME_ALLOWED_TIERS || '').split(',').map(t => t.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_ALLOWED_TIERS;
}
function beehiivConfigured(env) {
  return !!(env.BEEHIIV_API_KEY && env.BEEHIIV_PUBLICATION_ID && env.SNAPSHOTS);
}
// Normalises the Beehiiv subscription payload into {status, tiers:[ids], names:[]}.
// Tolerates both the expanded premium_tiers array and the bare
// subscription_premium_tier_names list, so an API shape change degrades to name matching.
function summarizeSubscription(data) {
  const d = data || {};
  const tiers = [], names = [];
  for (const t of (Array.isArray(d.premium_tiers) ? d.premium_tiers : [])) {
    if (t && typeof t === 'object') {
      if (t.id) tiers.push(String(t.id));
      if (t.name) names.push(String(t.name));
    } else if (typeof t === 'string') names.push(t);
  }
  for (const n of (Array.isArray(d.subscription_premium_tier_names) ? d.subscription_premium_tier_names : []))
    if (!names.includes(n)) names.push(String(n));
  return { status: String(d.status || 'unknown'), tiers, names, tier: d.subscription_tier || null };
}
async function fetchBeehiivSubscription(subId, env) {
  const url = `${BEEHIIV_API}/publications/${encodeURIComponent(env.BEEHIIV_PUBLICATION_ID)}` +
    `/subscriptions/${encodeURIComponent(subId)}?expand[]=premium_tiers`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.BEEHIIV_API_KEY}`, Accept: 'application/json' } });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`Beehiiv ${res.status}`);
  const body = await res.json();
  return { found: true, ...summarizeSubscription(body && body.data) };
}
// product: 'vault' (default, tome-proxy's own gate) or 'edge' (asked by the Fast Break Workers).
function subscriptionAllowed(entry, env, product = 'vault') {
  if (!entry || !entry.found) return false;
  if (String(entry.status).toLowerCase() !== 'active') return false;
  const allowed = product === 'vault' ? allowedTiers(env) : (PRODUCT_TIERS[product] || []);
  if ((entry.tiers || []).some(t => allowed.includes(t))) return true;
  // Name fallback only if the API returned no ids at all (shape change), never as a second chance.
  if (!(entry.tiers || []).length) {
    const want = PRODUCT_TIER_NAMES[product] || PRODUCT_TIER_NAMES.vault;
    return (entry.names || []).some(n => want.includes(String(n).toLowerCase()));
  }
  return false;
}
function denialReason(r) {
  return !r.entry || !r.entry.found ? 'unknown'
    : String(r.entry.status).toLowerCase() !== 'active' ? 'inactive' : 'tier';
}
// GET /auth/subscription?sid=sub_...&need=edge|vault -- internal identity service
// for the other Tome Workers (tome-tcg, tome-fastbreak, tome-fastbreak-refresh),
// reached over a service binding and authenticated by the shared
// TOME_INTERNAL_TOKEN secret (X-Tome-Internal). Runs BEFORE the per-IP rate
// limiter because service-binding calls carry no client IP. Unset token = 404.
async function handleAuthSubscription(request, url, env, ctx, origin) {
  const presented = request.headers.get('X-Tome-Internal') || '';
  if (!env.TOME_INTERNAL_TOKEN || !secretEquals(presented, env.TOME_INTERNAL_TOKEN))
    return jsonError('Not found', 404, origin);
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(origin) };
  const product = (url.searchParams.get('need') || 'vault').toLowerCase();
  if (!PRODUCT_TIERS[product]) return jsonError('need must be edge or vault', 400, origin);
  if (!beehiivConfigured(env)) return jsonError('Subscription lookup is not configured.', 503, origin, { retry: true });
  const subId = normalizeSubId(url.searchParams.get('sid') || '');
  if (!subId) return new Response(JSON.stringify({ allowed: false, reason: 'unknown', sub: null }), { status: 200, headers });
  const r = await resolveSubscriber(subId, env, ctx);
  if (r.source === 'error' && !r.entry)
    return jsonError('Could not verify the subscription right now.', 503, origin, { retry: true });
  const allowed = subscriptionAllowed(r.entry, env, product);
  return new Response(JSON.stringify({
    allowed, reason: allowed ? null : denialReason(r), sub: subId, product,
    status: r.entry && r.entry.status || null, tiers: r.entry && r.entry.tiers || [], source: r.source,
  }), { status: 200, headers });
}
// Returns {allowed, entry, source}. Never throws: a Beehiiv outage serves the last
// cached answer (any age) and otherwise fails closed.
async function resolveSubscriber(subId, env, ctx) {
  const key = `sub:${subId}`;
  const now = Date.now();
  let cached = null;
  try { cached = await env.SNAPSHOTS.get(key, 'json'); } catch (e) {}
  if (cached && typeof cached.at === 'number') {
    const age = now - cached.at;
    const fresh = cached.found ? age < SUB_CACHE_FRESH_MS : age < SUB_CACHE_NEGATIVE_MS;
    if (fresh) return { allowed: subscriptionAllowed(cached, env), entry: cached, source: 'cache' };
  }
  try {
    const live = await fetchBeehiivSubscription(subId, env);
    const entry = { ...live, at: now };
    const put = env.SNAPSHOTS.put(key, JSON.stringify(entry), { expirationTtl: SUB_CACHE_KV_TTL });
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    return { allowed: subscriptionAllowed(entry, env), entry, source: 'beehiiv' };
  } catch (e) {
    console.error('resolveSubscriber: Beehiiv lookup failed', e && e.message);
    if (cached) return { allowed: subscriptionAllowed(cached, env), entry: cached, source: 'stale' };
    return { allowed: false, entry: null, source: 'error' };
  }
}
// Returns null when the request may proceed (and fills auth.{via, sub}), otherwise the Response.
// Order of acceptance: subscription id (X-Tome-Sub / ?sid=) first, so a subscriber's
// My Cards sync works even when the Dashboards button also carries the shared key as
// a fallback; then the shared key (X-Tome-Key / ?key=). Retire the key later simply by
// unsetting TOME_SUBSCRIBER_KEYS.
async function subscriberGate(request, url, env, origin, ctx, auth) {
  const keys = subscriberKeys(env);
  const beehiiv = beehiivConfigured(env);
  if (!keys.length && !beehiiv)
    return jsonError('Dashboard unavailable: subscriber access is not configured.', 503, origin);
  const presentedKey = request.headers.get('X-Tome-Key') || url.searchParams.get('key') || '';
  const keyOk = !!presentedKey && keys.length > 0 && secretInList(presentedKey, keys);
  const subId = normalizeSubId(request.headers.get('X-Tome-Sub') || url.searchParams.get('sid') || '');
  let subDenied = null;
  if (subId && beehiiv) {
    const r = await resolveSubscriber(subId, env, ctx);
    if (r.allowed) { auth.via = 'sub'; auth.sub = subId; return null; }
    if (r.source === 'error') {
      if (keyOk) { auth.via = 'key'; return null; }
      return jsonError('Could not verify your subscription right now. Try again in a minute.', 503, origin, { retry: true });
    }
    const reason = denialReason(r);
    subDenied = jsonError('Tome Vault subscribers only. Open the dashboard from the Dashboards page.', 401, origin, { locked: true, reason });
  }
  if (keyOk) { auth.via = 'key'; return null; }
  return subDenied || jsonError('Tome Vault subscribers only. Open the dashboard from the Dashboards page.', 401, origin, { locked: true });
}
// POST /hooks/beehiiv/<token> -- Beehiiv webhook receiver. Evicts the cached
// subscription entry so the next dashboard request re-checks the live tier.
// Subscribe it to: Subscription Tier Added / Paused / Resumed / Deleted,
// Subscription Deleted / Paused / Resumed / Upgraded / Downgraded.
async function handleBeehiivWebhook(request, url, env, origin) {
  const token = url.pathname.slice('/hooks/beehiiv/'.length);
  if (!env.BEEHIIV_WEBHOOK_TOKEN || !secretEquals(token, env.BEEHIIV_WEBHOOK_TOKEN))
    return jsonError('Not found', 404, origin);
  let body = null;
  try { body = await request.json(); } catch (e) { return jsonError('Invalid JSON body.', 400, origin); }
  const d = (body && (body.data || body)) || {};
  const subId = normalizeSubId(d.id || d.subscription_id || d.api_subscription_id || '');
  let evicted = false;
  if (subId && env.SNAPSHOTS) {
    try { await env.SNAPSHOTS.delete(`sub:${subId}`); evicted = true; } catch (e) {}
  }
  console.log(`beehiiv webhook ${body && body.event_type || '?'}: ${subId || 'no-sub-id'} evicted=${evicted}`);
  return new Response(JSON.stringify({ ok: true, evicted }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
// ═══ MY CARDS SYNC ═══════════════════════════════════════════════════════════════
// GET /mycards  -> {cards:[ids], updatedAt}  (404-free: an unknown subscriber gets an empty list)
// PUT /mycards  <- {cards:[ids]}              (last write wins; the client merges before writing)
// Requires a subscription id (auth.via === 'sub'); shared-key sessions get {sync:false}
// so the frontend keeps using localStorage. Stored at mycards:<sub_id>.
const MYCARDS_MAX = 500, MYCARDS_ID_MAX = 120;
async function handleMyCards(request, env, origin, auth) {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(origin) };
  if (auth.via !== 'sub') return new Response(JSON.stringify({ sync: false, cards: null }), { status: 200, headers });
  if (!env.SNAPSHOTS) return jsonError('Sync unavailable: storage not configured.', 503, origin);
  const key = `mycards:${auth.sub}`;
  if (request.method === 'GET') {
    const stored = (await env.SNAPSHOTS.get(key, 'json')) || { cards: [], updatedAt: null };
    return new Response(JSON.stringify({ sync: true, cards: stored.cards || [], updatedAt: stored.updatedAt || null }), { status: 200, headers });
  }
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch (e) { return jsonError('Invalid JSON body.', 400, origin); }
    if (!body || !Array.isArray(body.cards)) return jsonError('cards must be an array.', 400, origin);
    const cards = [...new Set(body.cards.filter(c => typeof c === 'string').map(c => c.trim()).filter(c => c && c.length <= MYCARDS_ID_MAX))];
    if (cards.length > MYCARDS_MAX) return jsonError(`Too many cards (max ${MYCARDS_MAX}).`, 400, origin);
    const updatedAt = new Date().toISOString();
    await env.SNAPSHOTS.put(key, JSON.stringify({ cards, updatedAt }));
    return new Response(JSON.stringify({ sync: true, ok: true, count: cards.length, updatedAt }), { status: 200, headers });
  }
  return jsonError('Method not allowed', 405, origin);
}
// Daily aggregate of what subscribers are watching (cron). Writes mycards-agg and
// returns the top entries so the digest can mention them. Reads every mycards:* key;
// fine at newsletter scale (one KV read per subscriber who uses My Cards).
async function aggregateMyCards(env) {
  if (!env.SNAPSHOTS) return null;
  const counts = new Map();
  let users = 0, cursor;
  do {
    const page = await env.SNAPSHOTS.list({ prefix: 'mycards:', cursor });
    for (const k of page.keys) {
      const v = await env.SNAPSHOTS.get(k.name, 'json');
      if (!v || !Array.isArray(v.cards) || !v.cards.length) continue;
      users++;
      for (const id of v.cards) counts.set(id, (counts.get(id) || 0) + 1);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id, count]) => ({ id, count }));
  const agg = { date: new Date().toISOString().slice(0, 10), users, distinct: counts.size, top };
  await env.SNAPSHOTS.put('mycards-agg', JSON.stringify(agg));
  return agg;
}
// Per-IP rate limit (Workers Rate Limiting binding; see wrangler.toml). Allows the
// request if the binding is missing or errors, so a limiter outage never takes the
// dashboard down -- the subscriber gate is the real access control.
// The outcome is also exposed as an X-Tome-RL response header (off / ok / denied /
// error) so the limiter can be verified from outside without reading logs.
async function rateLimited(request, origin, env, rl) {
  if (!env.PUBLIC_RATE_LIMITER) { rl.state = 'off'; return null; }
  try {
    const { success } = await env.PUBLIC_RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    rl.state = success ? 'ok' : 'denied';
    if (!success) return jsonError('Too many requests. Slow down.', 429, origin);
  } catch (e) {
    rl.state = 'error';
    console.error('rate limiter error (allowing request):', e && e.message);
  }
  return null;
}
// POST /report -- the dashboard's "Report an issue" modal. Subscriber-gated and
// rate-limited (free text into Discord is otherwise a spam vector). Fields are
// length-capped; the honeypot check lives client-side.
const REPORT_MAX = { card: 200, message: 1500, page: 300 };
async function handleReport(request, origin, env) {
  if (!env.DISCORD_WEBHOOK_URL) return jsonError('Reporting is not configured.', 503, origin);
  let body;
  try { body = await request.json(); } catch (e) { return jsonError('Invalid JSON body.', 400, origin); }
  const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const card = clip(body.card, REPORT_MAX.card);
  const message = clip(body.message, REPORT_MAX.message);
  const page = clip(body.page, REPORT_MAX.page);
  if (!message) return jsonError('message is required.', 400, origin);
  const content = [
    '🚩 **TCG Arbitrage report**',
    card ? `**Card / area:** ${card}` : null,
    `**Issue:** ${message}`,
    page ? `**Page:** ${page}` : null,
  ].filter(Boolean).join('\n').slice(0, 1900);
  try {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!res.ok) return jsonError('Could not deliver the report.', 502, origin);
  } catch (e) {
    return jsonError('Could not deliver the report.', 502, origin);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
const dateKey = (d) => d.toISOString().slice(0, 10);
// ── Daily snapshot: fetch the NM universe per game, store {cardId: price} maps ──
async function captureSnapshot(env) {
  const today = dateKey(new Date());
  for (const game of SNAP_GAMES) {
    const prices = {};
    const cap = SNAP_PAGES[game] || 3;
    for (let i = 0; i < cap; i++) {
      const url = `${JUSTTCG_BASE}/cards?game=${encodeURIComponent(game)}` +
        `&condition=${encodeURIComponent('Near Mint')}` +
        `&orderBy=price&order=desc&limit=100&offset=${i * 100}` +
        `&include_price_history=false`;
      const res = await jtFetch(env, url);
      if (!res || !res.ok) break;
      const json = await res.json();
      const cards = json.data || [];
      if (!cards.length) break;
      let cheapest = Infinity;
      for (const c of cards) {
        const nm = (c.variants || []).find(v => v.condition === 'Near Mint');
        if (!nm) continue;
        const p = parseFloat(nm.price);
        if (!p) continue;
        prices[c.id] = p;
        if (p < cheapest) cheapest = p;
      }
      if (cheapest < 10) break;   // below the tracked universe
    }
    // One KV write per game per day. Auto-expire after ~13 months.
    await env.SNAPSHOTS.put(
      `snap:${game}:${today}`,
      JSON.stringify(prices),
      { expirationTtl: 60 * 60 * 24 * 400 }
    );
  }
}
// ── /history?game=pokemon&id=<cardId> → { id, prices: [{date, price}] } ────────
async function serveHistory(url, origin, env) {
  const game = url.searchParams.get('game');
  const id = url.searchParams.get('id');
  if (!game || !id) return jsonError('game and id parameters required', 400, origin);
  if (!SNAP_GAMES.includes(game)) return jsonError('unknown game', 400, origin);
  const out = [];
  const now = new Date();
  // Read day-keys newest→oldest; stop after HISTORY_DAYS
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    const raw = await env.SNAPSHOTS.get(`snap:${game}:${dateKey(d)}`);
    if (!raw) continue;
    try {
      const prices = JSON.parse(raw);
      if (prices[id] != null) out.push({ date: dateKey(d), price: prices[id] });
    } catch (e) { /* skip bad day */ }
  }
  out.reverse(); // oldest → newest for charting
  return new Response(JSON.stringify({ id, game, prices: out }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=21600',
      ...corsHeaders(origin),
    },
  });
}
// ═══ DAILY GRADED-PRICE SNAPSHOT ══════════════════════════════════════════════
// Mirrors index.html's catalog pagination exactly, so this enriches the same card
// universe visitors see. If that pagination logic changes client-side, update here too.
const GP_GAME_SLUGS = { 'Pokemon': 'pokemon', 'Lorcana': 'disney-lorcana', 'One Piece': 'one-piece-card-game' };
const GP_PAGE_CAP = { 'Pokemon': 20, 'Lorcana': 4, 'One Piece': 5 };
const GP_ASC_SHARE = 0.5;
const GP_UNIVERSE_FLOOR = 10;
const GP_HARD_PRICE_FLOOR = 10;
const GP_PER_GAME_LIMIT = 100;
const GP_FETCH_CONCURRENCY = 4;    // pacing is enforced by jtFetch's limiter; this just bounds in-flight requests
async function gpFetchCatalogPage(env, game, offset, order) {
  const slug = GP_GAME_SLUGS[game];
  const upstream = `${JUSTTCG_BASE}/cards?game=${encodeURIComponent(slug)}` +
    `&condition=${encodeURIComponent('Near Mint')}&orderBy=price&order=${order}` +
    `&limit=${GP_PER_GAME_LIMIT}&offset=${offset}`;
  const res = await jtFetch(env, upstream);
  if (!res || !res.ok) return [];
  const json = await res.json();
  return (json.data || [])
    .map(c => {
      const variants = (c.variants || []).filter(v => v.condition !== 'Sealed');
      if (!variants.length) return null;
      const nm = variants.find(v => v.condition === 'Near Mint') || variants[0];
      const raw = parseFloat(nm.price);
      if (!raw || raw < GP_HARD_PRICE_FLOOR) return null;
      return { id: c.id, raw };
    })
    .filter(Boolean);
}
// Collects the same ~1,400 unique card IDs index.html's loadLiveData() would show.
async function gpCollectCatalogIds(env) {
  const games = ['Pokemon', 'Lorcana', 'One Piece'];
  const results = await Promise.allSettled(games.map(async g => {
    const cap = GP_PAGE_CAP[g] || 3;
    const ascPages = Math.max(1, Math.round(cap * GP_ASC_SHARE));
    const descPages = Math.max(0, cap - ascPages);
    const seen = new Set();
    const out = [];
    const add = list => { for (const c of list) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } };
    for (let i = 0; i < ascPages; i++) {
      const page = await gpFetchCatalogPage(env, g, i * GP_PER_GAME_LIMIT, 'asc');
      add(page);
      if (!page.length) break;
    }
    for (let i = 0; i < descPages; i++) {
      const page = await gpFetchCatalogPage(env, g, i * GP_PER_GAME_LIMIT, 'desc');
      if (!page.length) break;
      const cheapest = Math.min(...page.map(c => c.raw));
      add(page);
      if (cheapest < GP_UNIVERSE_FLOOR) break;
    }
    return out;
  }));
  const ids = new Set();
  results.forEach(r => { if (r.status === 'fulfilled') r.value.forEach(c => ids.add(c.id)); });
  return [...ids];
}
// Same parsing logic as the client's parseGradedResponse (verified against a live
// response on 2026-08-23) — kept in sync manually since this runs server-side now.
function gpParseGraded(json) {
  if (!json) return null;
  const card = Array.isArray(json.data) ? json.data[0] : (json.data || json);
  if (!card || !Array.isArray(card.variants)) return null;
  const out = {};
  for (const v of card.variants) {
    if (v.type !== 'graded' || v.grading?.company !== 'PSA') continue;
    const grade = v.grading?.grade;
    const price = v.markets?.find(m => m.region === 'US')?.price ?? v.markets?.[0]?.price;
    if (price == null) continue;
    if (grade === 7) out.p7 = parseFloat(price);
    else if (grade === 8) out.p8 = parseFloat(price);
    else if (grade === 9) out.p9 = parseFloat(price);
  }
  return Object.keys(out).length ? out : null;
}
// ═══ RATE-LIMITED JUSTTCG FETCH (cron path only) ═════════════════════════════════
// 2026-09-06 diagnostic run: {"404":171,"429":1190,"ok":39} on 1,400 graded lookups.
// The Worker was firing at concurrency 10 with no pacing, so after the first ~200
// calls JustTCG's per-minute limiter closed and 85% of the run was thrown away.
// That -- not data availability -- was the 1.8% PSA coverage reading.
//
// Plan: Professional = 100 req/min, 5,000/day. Pace to 80/min so the request-path
// proxy (same key, 6h edge cache misses) keeps headroom, and retry 429s honoring
// Retry-After with exponential backoff + jitter, per JustTCG's own guidance.
const JT_RATE_PER_MIN = 80;
const JT_MAX_ATTEMPTS = 4;
const JT_BACKOFF_BASE_MS = 1000;
const JT_BACKOFF_CAP_MS = 30000;
const jtLimiter = { nextSlot: 0 };   // module-level token pacing (one isolate per cron run)
const jtSleep = ms => new Promise(r => setTimeout(r, ms));
async function jtAcquireSlot() {
  const interval = 60000 / JT_RATE_PER_MIN;
  const now = Date.now();
  const slot = Math.max(now, jtLimiter.nextSlot);
  jtLimiter.nextSlot = slot + interval;
  if (slot > now) await jtSleep(slot - now);
}
// Returns the final Response (ok or not) or null on network failure after retries.
// statusCounts (optional) is tallied: ok / 404 / 429 (gave up) / 429_retried
// (recovered on a later attempt) / 5xx / other_NNN / network_error.
async function jtFetch(env, url, statusCounts) {
  let res = null;
  for (let attempt = 1; attempt <= JT_MAX_ATTEMPTS; attempt++) {
    await jtAcquireSlot();
    try {
      res = await fetch(url, { headers: { 'x-api-key': env.JUSTTCG_API_KEY } });
    } catch (e) {
      res = null;
      if (attempt === JT_MAX_ATTEMPTS) break;
      await jtSleep(Math.min(JT_BACKOFF_CAP_MS, JT_BACKOFF_BASE_MS * 2 ** (attempt - 1)) * (0.5 + Math.random()));
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === JT_MAX_ATTEMPTS) break;
    if (res.status === 429 && statusCounts) statusCounts['429_retried'] = (statusCounts['429_retried'] || 0) + 1;
    const retryAfter = parseFloat(res.headers.get('Retry-After'));
    const backoff = Math.min(JT_BACKOFF_CAP_MS, JT_BACKOFF_BASE_MS * 2 ** (attempt - 1)) * (0.5 + Math.random());
    await jtSleep(Number.isFinite(retryAfter) ? Math.max(retryAfter * 1000, backoff) : backoff);
  }
  if (statusCounts) {
    const bucket = !res ? 'network_error'
      : res.status === 404 ? '404' : res.status === 429 ? '429'
      : res.status >= 500 ? '5xx' : res.ok ? 'ok' : `other_${res.status}`;
    statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
  }
  return res;
}
// The upstream URL below keeps the real "/v2/cards" path exactly as deployed -- an
// earlier diagnostic patch's "Find" anchor wrongly assumed a plain "/cards" path.
// Do not revert this path.
async function gpFetchGraded(env, cardId, statusCounts) {
  try {
    const res = await jtFetch(env,
      `${JUSTTCG_BASE_V2}/v2/cards?card_id=${encodeURIComponent(cardId)}&graded=only`,
      statusCounts);
    if (!res || !res.ok) return null;   // 404 = no graded data for this card (expected for most)
    return gpParseGraded(await res.json());
  } catch (e) {
    return null;   // one card's parse failure shouldn't fail the whole run
  }
}
// ═══ CATALOG ROTATION ═══════════════════════════════════════════════════════════
// Enrich a third of the catalog per day instead of all 1,400 cards: ~470 graded calls
// paced at 80/min is ~6 min of cron time and ~12% of the daily quota. Bucket by a
// stable hash of the card ID (not list position) so a card keeps its bucket as the
// catalog churns, and every card is refreshed every 3 days.
const GP_ROTATION_BUCKETS = 3;
function gpBucketOf(cardId) {
  let h = 2166136261;                       // FNV-1a
  for (let i = 0; i < cardId.length; i++) { h ^= cardId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % GP_ROTATION_BUCKETS;
}
const gpTodayBucket = (now = Date.now()) => Math.floor(now / 86400000) % GP_ROTATION_BUCKETS;
async function gpMapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
// Rotating, merging enrichment: today's bucket is re-fetched and replaces its prior
// entries (including clearing cards that now return nothing); the other buckets are
// carried forward from the previous snapshot; cards no longer in the catalog are
// pruned. Per-card {p7,p8,p9} shape is unchanged for index.html.
async function captureGradedPrices(env) {
  const ids = await gpCollectCatalogIds(env);
  const bucket = gpTodayBucket();
  const todayIds = ids.filter(id => gpBucketOf(id) === bucket);
  const catalogSet = new Set(ids);
  let prior = null;
  try { prior = await env.SNAPSHOTS.get('graded-prices', 'json'); } catch (e) { prior = null; }
  const data = {};
  for (const [id, g] of Object.entries((prior && prior.data) || {})) {
    if (catalogSet.has(id) && gpBucketOf(id) !== bucket) data[id] = g;   // carry forward other buckets
  }
  const statusCounts = {};   // tally of what JustTCG's graded endpoint actually returned today
  let bucketLive = 0;
  await gpMapWithConcurrency(todayIds, GP_FETCH_CONCURRENCY, async (id) => {
    const g = await gpFetchGraded(env, id, statusCounts);
    if (g) { data[id] = g; bucketLive++; }
  });
  const liveCount = Object.keys(data).length;
  console.log(`captureGradedPrices bucket ${bucket}/${GP_ROTATION_BUCKETS}: ${todayIds.length} checked, ` +
    `${bucketLive} live today, ${liveCount} live total; status breakdown: ${JSON.stringify(statusCounts)}`);
  await env.SNAPSHOTS.put('graded-prices', JSON.stringify({
    updatedAt: new Date().toISOString(),
    cardsChecked: todayIds.length,   // today's bucket only
    catalogSize: ids.length,
    bucket, bucketSize: todayIds.length, bucketLive,
    liveCount,                        // across all buckets (carried forward + today)
    statusCounts,   // today's bucket; also readable via GET /graded-prices
    data,
  }), { expirationTtl: 172800 });   // key is rewritten daily, so the 2-day TTL still
                                     // means: if the cron dies for 2 days straight,
                                     // /graded-prices returns 503 instead of silently
                                     // serving stale data forever.
}
// ═══ DAILY TOME SCORE TRACK RECORD + CRACK-PROFIT DIGEST ════════════════════════
// Runs after captureGradedPrices (see scheduled() below) so it can read the graded-price
// snapshot that job just wrote, instead of re-fetching PSA data twice.
const SH_EST_MODERN = { p10: 5.5, p9: 1.7, p8: 1.05, p7: 0.95 };
const SH_SALE_RATE = 0.80;   // mirrors index.html's SALE_RATE
const SH_FEE_TIERS = [
  { fee: 80, cap: 1500 }, { fee: 150, cap: 2500 }, { fee: 350, cap: 5000 },
  { fee: 600, cap: 10000 }, { fee: 1000, cap: 25000 }, { fee: 2000, cap: 50000 },
  { fee: 3000, cap: 100000 }, { fee: 5000, cap: 250000 }, { fee: 10000, cap: Infinity },
];
const SH_MOM_VOLUME_CONFIDENCE_FLOOR = 4;   // mirrors index.html
const SH_LOG_THRESHOLD = 55;                // only log Watch-tier+
const SH_DIGEST_COUNT = 5;
// Data-quality filter -- hard-excludes ONLY genuinely stale listings (JustTCG hasn't
// refreshed in 30+ days). Deliberately does NOT exclude zero-30d-activity cards -- reverted
// after review confirmed that removed ~27% of the catalog, disproportionately the rare/
// high-value end this tool exists to surface. Those cards flow through to scoring normally
// and land in "Thin"/"Some" confidence via the existing hasVolume check below.
const SH_MAX_AGE_DAYS = 30;
function shDataQualityIssue(c) {
  if (c.lastUpdated) {
    const ageDays = (Date.now() / 1000 - c.lastUpdated) / 86400;
    if (ageDays > SH_MAX_AGE_DAYS) return `stale (${Math.round(ageDays)}d since last update)`;
  }
  return null;
}
function shLerp(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return last[1];
}
const shTsValue = gp => gp <= 0
  ? shLerp(gp, [[-500, 2], [0, 15]])
  : shLerp(Math.log1p(gp), [[Math.log1p(0),15],[Math.log1p(50),40],[Math.log1p(200),63],[Math.log1p(1200),83],[Math.log1p(5000),93],[Math.log1p(15000),100]]);
const shTsMom = m => shLerp(m, [[-0.30,5],[-0.15,20],[-0.05,40],[0.05,60],[0.10,80],[0.20,100]]);
const shTsEnt = p => shLerp(p, [[0,100],[5,100],[15,80],[40,60],[100,40],[250,20],[600,5]]);
function shFeeFor(v) { return (SH_FEE_TIERS.find(t => v <= t.cap) || SH_FEE_TIERS[SH_FEE_TIERS.length - 1]).fee; }
// Same catalog pagination as gpCollectCatalogIds, but keeps raw price + 30d momentum
// fields instead of discarding everything but the ID.
async function shFetchCatalogPage(env, game, offset, order) {
  const slug = GP_GAME_SLUGS[game];
  const upstream = `${JUSTTCG_BASE}/cards?game=${encodeURIComponent(slug)}` +
    `&condition=${encodeURIComponent('Near Mint')}&orderBy=price&order=${order}` +
    `&limit=${GP_PER_GAME_LIMIT}&offset=${offset}`;
  const res = await jtFetch(env, upstream);
  if (!res || !res.ok) return [];
  const json = await res.json();
  return (json.data || []).map(c => {
    const variants = (c.variants || []).filter(v => v.condition !== 'Sealed');
    if (!variants.length) return null;
    const nm = variants.find(v => v.condition === 'Near Mint') || variants[0];
    const raw = parseFloat(nm.price);
    if (!raw || raw < GP_HARD_PRICE_FLOOR) return null;
    return {
      id: c.id,
      name: c.name,
      raw,
      mom: (nm.priceChange30d != null && nm.priceChange30d !== '' && !isNaN(parseFloat(nm.priceChange30d)))
        ? parseFloat(nm.priceChange30d) / 100 : null,
      chgCount30d: nm.priceChangesCount30d || 0,
      lastUpdated: nm.lastUpdated || null,
    };
  }).filter(Boolean);
}
async function shCollectCatalog(env) {
  const games = ['Pokemon', 'Lorcana', 'One Piece'];
  const results = await Promise.allSettled(games.map(async g => {
    const cap = GP_PAGE_CAP[g] || 3;
    const ascPages = Math.max(1, Math.round(cap * GP_ASC_SHARE));
    const descPages = Math.max(0, cap - ascPages);
    const seen = new Set();
    const out = [];
    const add = list => { for (const c of list) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } };
    for (let i = 0; i < ascPages; i++) {
      const page = await shFetchCatalogPage(env, g, i * GP_PER_GAME_LIMIT, 'asc');
      add(page);
      if (!page.length) break;
    }
    for (let i = 0; i < descPages; i++) {
      const page = await shFetchCatalogPage(env, g, i * GP_PER_GAME_LIMIT, 'desc');
      if (!page.length) break;
      const cheapest = Math.min(...page.map(c => c.raw));
      add(page);
      if (cheapest < GP_UNIVERSE_FLOOR) break;
    }
    return out;
  }));
  const out = [];
  results.forEach(r => { if (r.status === 'fulfilled') out.push(...r.value); });
  return out;
}
async function captureScoreHistoryAndDigest(env) {
  if (!env.SNAPSHOTS) return;
  const [rawCatalog, gradedSnapshot] = await Promise.all([
    shCollectCatalog(env),
    env.SNAPSHOTS.get('graded-prices', 'json'),
  ]);
  const graded = (gradedSnapshot && gradedSnapshot.data) || {};
  let staleCount = 0;
  const catalog = rawCatalog.filter(c => {
    if (shDataQualityIssue(c)) { staleCount++; return false; }
    return true;
  });
  const scored = catalog.map(c => {
    const g = graded[c.id];
    const est = { p10: c.raw*SH_EST_MODERN.p10, p9: c.raw*SH_EST_MODERN.p9, p8: c.raw*SH_EST_MODERN.p8, p7: c.raw*SH_EST_MODERN.p7 };
    const liveP7 = g?.p7, liveP8 = g?.p8, liveP9 = g?.p9;
    const cand9 = liveP9 ?? est.p9, cand8 = liveP8 ?? est.p8, cand7 = liveP7 ?? est.p7;
    const monotonic = cand7 <= cand8 && cand8 <= cand9;
    const p9 = monotonic ? cand9 : est.p9;
    const p8 = monotonic ? cand8 : est.p8;
    const p9Live = monotonic && liveP9 != null;
    const feeUsed = shFeeFor(est.p10);
    const gradeProfitTypical = parseFloat(((p9 * SH_SALE_RATE) - c.raw - feeUsed).toFixed(2));
    const crackP8 = parseFloat(((c.raw * SH_SALE_RATE) - p8).toFixed(2));
    const momConfidence = Math.min(1, (c.chgCount30d || 0) / SH_MOM_VOLUME_CONFIDENCE_FLOOR);
    const momScore = c.mom == null ? 50 : 50 + (shTsMom(c.mom) - 50) * momConfidence;
    const tomeScore = Math.round((
      shTsValue(gradeProfitTypical) * 0.40 + momScore * 0.40 + shTsEnt(c.raw) * 0.20
    ) * 10) / 10;
    const hasVolume = (c.chgCount30d || 0) >= SH_MOM_VOLUME_CONFIDENCE_FLOOR;
    let confidence = 'Some';
    if (p9Live && hasVolume) confidence = 'High';
    else if (!p9Live && !hasVolume) confidence = 'Thin';
    return { id: c.id, name: c.name, price: c.raw, tomeScore, confidence, crackP8 };
  });
  const today = new Date().toISOString().slice(0, 10);
  const confidenceCounts = scored.reduce((acc, c) => { acc[c.confidence] = (acc[c.confidence] || 0) + 1; return acc; }, {});
  console.log(`captureScoreHistoryAndDigest: scored ${scored.length}/${rawCatalog.length} catalog cards ` +
    `(excluded ${staleCount} stale-listing), confidence breakdown: ${JSON.stringify(confidenceCounts)}`);
  const toLog = scored.filter(c => c.tomeScore >= SH_LOG_THRESHOLD)
    .map(({ id, tomeScore, confidence, price }) => ({ id, tomeScore, confidence, price }));
  await env.SNAPSHOTS.put(`score-history:${today}`, JSON.stringify({ date: today, count: toLog.length, cards: toLog }));
  let watched = null;
  try { watched = await aggregateMyCards(env); } catch (e) { console.error('aggregateMyCards failed', e && e.message); }
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const cracked = scored.filter(c => c.crackP8 > 0).sort((a, b) => b.crackP8 - a.crackP8).slice(0, SH_DIGEST_COUNT);
      if (cracked.length) {
        const lines = cracked.map(c => `💎 **${c.name}** — $${c.price.toFixed(2)} raw · crack profit ~$${c.crackP8.toFixed(2)} (PSA 8 basis)`);
        const nameOf = new Map(scored.map(c => [c.id, c.name]));
        const watchLines = watched && watched.users
          ? [`👀 **Most watched** (${watched.users} subscriber${watched.users === 1 ? '' : 's'} using My Cards): ` +
             watched.top.slice(0, 5).map(t => `${nameOf.get(t.id) || t.id} (${t.count})`).join(' · ')]
          : [];
        const content = [
          `🔨 **Tome Vault Crack-Profit Targets** — ${today}`,
          ...lines,
          ...(watchLines.length ? ['', ...watchLines] : []),
          '',
          'Full breakdown (all PSA tiers, Tome Score, confidence) → https://tomecollective.github.io/tome-intelligence/',
        ].join('\n').slice(0, 1900);
        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
        });
      }
    } catch (e) { /* best-effort -- never let a Discord hiccup block the KV log above */ }
  }
}
// ═══ CRON STATUS + HEALTH ═══════════════════════════════════════════════════════
// The daily pipeline records where it got to (cron:last) so a step that throws is
// visible instead of silently leaving yesterday's snapshot in place. GET /health
// (ungated; read by tome-healthcheck over a service binding) reports that record
// plus the graded snapshot's age and status counts and the latest score-history
// date. Metadata only: no prices, no keys, no subscriber data.
async function runDailyPipeline(env) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const status = { startedAt, finishedAt: null, durationMs: null, ok: false, step: null, error: null, steps: [] };
  const record = async () => { if (env.SNAPSHOTS) { try { await env.SNAPSHOTS.put('cron:last', JSON.stringify(status)); } catch (e) {} } };
  const steps = [
    ['captureSnapshot', () => captureSnapshot(env)],
    ['captureGradedPrices', () => captureGradedPrices(env)],
    ['captureScoreHistoryAndDigest', () => captureScoreHistoryAndDigest(env)],   // reads what the step above wrote
  ];
  for (const [name, fn] of steps) {
    status.step = name;
    const s0 = Date.now();
    try {
      await fn();
      status.steps.push({ name, ok: true, ms: Date.now() - s0 });
    } catch (e) {
      status.steps.push({ name, ok: false, ms: Date.now() - s0 });
      status.error = `${name}: ${(e && e.message) || String(e)}`.slice(0, 500);
      console.error('daily pipeline failed at', name, e);
      status.finishedAt = new Date().toISOString(); status.durationMs = Date.now() - t0;
      await record();
      return;
    }
  }
  status.ok = true; status.step = null;
  status.finishedAt = new Date().toISOString(); status.durationMs = Date.now() - t0;
  await record();
}
const HEALTH_GRADED_STALE_MS = 30 * 3600 * 1000;   // cron is daily at 14:00 UTC; 30h = one missed run + slack
async function handleHealth(env, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) };
  const now = Date.now();
  if (!env.SNAPSHOTS)
    return new Response(JSON.stringify({ ok: false, problems: ['SNAPSHOTS KV binding missing'] }), { status: 200, headers });
  const [cron, graded, agg] = await Promise.all([
    env.SNAPSHOTS.get('cron:last', 'json').catch(() => null),
    env.SNAPSHOTS.get('graded-prices', 'json').catch(() => null),
    env.SNAPSHOTS.get('mycards-agg', 'json').catch(() => null),
  ]);
  // Latest score-history day: today or yesterday (UTC) is healthy; older means the digest step is not running.
  let scoreHistory = null;
  for (let back = 0; back < 4 && !scoreHistory; back++) {
    const d = new Date(now - back * 86400000).toISOString().slice(0, 10);
    const sh = await env.SNAPSHOTS.get(`score-history:${d}`, 'json').catch(() => null);
    if (sh) scoreHistory = { date: d, count: sh.count ?? (sh.cards || []).length, ageDays: back };
  }
  const problems = [];
  if (!cron) problems.push('daily pipeline has never recorded a run (cron:last missing)');
  else {
    if (!cron.ok) problems.push(`last run failed at ${cron.step}: ${cron.error}`);
    const age = cron.finishedAt ? now - Date.parse(cron.finishedAt) : null;
    if (age != null && age > HEALTH_GRADED_STALE_MS) problems.push(`last run finished ${Math.round(age / 3600000)} h ago`);
  }
  let gradedMeta = null;
  if (!graded) problems.push('no graded-prices snapshot in KV');
  else {
    const age = graded.updatedAt ? now - Date.parse(graded.updatedAt) : null;
    gradedMeta = {
      updatedAt: graded.updatedAt || null, ageMs: age, bucket: graded.bucket ?? null, cardsChecked: graded.cardsChecked ?? null,
      bucketLive: graded.bucketLive ?? null, liveCount: graded.liveCount ?? null, catalogSize: graded.catalogSize ?? null,
      statusCounts: graded.statusCounts || null,
    };
    if (age == null || age > HEALTH_GRADED_STALE_MS) problems.push(`graded snapshot is ${age == null ? 'undated' : Math.round(age / 3600000) + ' h old'}`);
    const sc = graded.statusCounts || {};
    if ((sc['429'] || 0) > (sc.ok || 0)) problems.push(`JustTCG rate-limited the graded run (${sc['429']} x 429 vs ${sc.ok || 0} ok)`);
    if (graded.cardsChecked > 0 && (graded.bucketLive || 0) === 0) problems.push(`graded run checked ${graded.cardsChecked} cards and found no live PSA data`);
  }
  if (!scoreHistory) problems.push('no score-history entry in the last 4 days');
  else if (scoreHistory.ageDays > 1) problems.push(`latest score-history is ${scoreHistory.ageDays} days old`);
  return new Response(JSON.stringify({
    ok: problems.length === 0, checkedAt: new Date(now).toISOString(), problems,
    cron: cron || null, graded: gradedMeta, scoreHistory,
    myCards: agg ? { date: agg.date, users: agg.users, distinct: agg.distinct } : null,
    beehiiv: { configured: beehiivConfigured(env), internalAuth: !!env.TOME_INTERNAL_TOKEN },
  }), { status: 200, headers });
}
export default {
  // Cron entry point — Cloudflare invokes this on the schedule you set.
  // UPDATED: now runs sequentially, not fire-and-forget in parallel, because
  // captureScoreHistoryAndDigest reads what captureGradedPrices just wrote.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyPipeline(env));
  },
  async fetch(request, env, ctx) {
    // X-Tome-RL diagnostic header retired (limiter verified from outside on Sept 7).
    return handleRequest(request, env, ctx, { state: 'off' });
  },
};
async function handleRequest(request, env, ctx, rl) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    const url = new URL(request.url);
    // Internal identity service for the other Tome Workers (service binding + shared token).
    if (request.method === 'GET' && url.pathname === '/auth/subscription')
      return handleAuthSubscription(request, url, env, ctx, origin);
    // Ungated pipeline health (metadata only); also before the limiter so tome-healthcheck's
    // service-binding calls (no client IP) never share one bucket with the public.
    if (request.method === 'GET' && url.pathname === '/health') return handleHealth(env, origin);
    // Order: rate limit -> subscriber gate -> route. Everything below the gate is
    // Tome Vault product data (or writes to Discord), so nothing is served without a key.
    const limited = await rateLimited(request, origin, env, rl);
    if (limited) return limited;
    // Beehiiv webhook: authenticated by its own secret path token, not by a subscriber.
    if (request.method === 'POST' && url.pathname.startsWith('/hooks/beehiiv/'))
      return handleBeehiivWebhook(request, url, env, origin);
    const auth = { via: null, sub: null };
    const gated = await subscriberGate(request, url, env, origin, ctx, auth);
    if (gated) return gated;
    if (url.pathname === '/mycards') return handleMyCards(request, env, origin, auth);
    if (request.method === 'POST' && url.pathname === '/report') return handleReport(request, origin, env);
    if (request.method !== 'GET') return jsonError('Method not allowed', 405, origin);
    if (!env.JUSTTCG_API_KEY)
      return jsonError('Server misconfigured: JUSTTCG_API_KEY secret is not set.', 500, origin);
    if (!ALLOWED_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p + '/')))
      return jsonError(`Endpoint not permitted. Allowed: ${ALLOWED_PATHS.join(', ')}`, 403, origin);
    // History endpoint (requires the KV binding)
    if (url.pathname === '/history') {
      if (!env.SNAPSHOTS)
        return jsonError('History unavailable: SNAPSHOTS KV binding not configured.', 503, origin);
      return serveHistory(url, origin, env);
    }
    // Graded-price snapshot endpoint — serves whatever the daily cron last wrote to KV.
    // No live JustTCG calls happen on this path; it's a straight KV read.
    if (url.pathname === '/graded-prices') {
      if (!env.SNAPSHOTS)
        return jsonError('Graded-price data unavailable: SNAPSHOTS KV binding not configured.', 503, origin);
      const cached = await env.SNAPSHOTS.get('graded-prices');
      if (!cached)
        return jsonError('No graded-price snapshot yet — check back after the next daily run (14:00 UTC).', 503, origin);
      const resp = new Response(cached, { status: 200 });
      resp.headers.set('Content-Type', 'application/json');
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => resp.headers.set(k, v));
      return resp;
    }
    // ── JustTCG proxy with edge cache ──
    const upstreamBase = url.pathname.startsWith('/v2/') ? JUSTTCG_BASE_V2 : JUSTTCG_BASE;
    url.searchParams.delete('key');   // never forward a subscriber key to JustTCG (or into the cache key)
    url.searchParams.delete('sid');   // ...nor a subscription id
    const upstream = `${upstreamBase}${url.pathname}${url.search}`;
    const cache = caches.default;
    const cacheKey = new Request(upstream, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => resp.headers.set(k, v));
      resp.headers.set('X-Tome-Cache', 'HIT');
      return resp;
    }
    let apiRes;
    try {
      apiRes = await fetch(upstream, {
        headers: { 'x-api-key': env.JUSTTCG_API_KEY, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return jsonError(`Upstream request to JustTCG failed: ${err.message}`, 502, origin);
    }
    const body = await apiRes.text();
    const response = new Response(body, {
      status: apiRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
        'X-Tome-Cache': 'MISS',
        ...corsHeaders(origin),
      },
    });
    if (apiRes.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
}
