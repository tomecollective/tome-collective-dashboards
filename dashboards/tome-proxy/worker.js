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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
const jsonError = (message, status, origin) =>
  new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
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
      let res;
      try {
        res = await fetch(url, { headers: { 'x-api-key': env.JUSTTCG_API_KEY } });
      } catch (e) { break; }
      if (!res.ok) break;
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
const GP_FETCH_CONCURRENCY = 10;   // once/day, off the request path — a bit more generous than the client's 8
async function gpFetchCatalogPage(env, game, offset, order) {
  const slug = GP_GAME_SLUGS[game];
  const upstream = `${JUSTTCG_BASE}/cards?game=${encodeURIComponent(slug)}` +
    `&condition=${encodeURIComponent('Near Mint')}&orderBy=price&order=${order}` +
    `&limit=${GP_PER_GAME_LIMIT}&offset=${offset}`;
  const res = await fetch(upstream, { headers: { 'x-api-key': env.JUSTTCG_API_KEY } });
  if (!res.ok) return [];
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
// UPDATED (diagnostic logging) -- added statusCounts param and per-status tallying.
// The upstream URL below keeps the real "/v2/cards" path exactly as already deployed --
// the original diagnostic patch's "Find" anchor incorrectly assumed a plain "/cards" path
// with no "/v2/" segment. Verified against the live file before applying; do not revert
// this path.
async function gpFetchGraded(env, cardId, statusCounts) {
  try {
    const res = await fetch(
      `${JUSTTCG_BASE_V2}/v2/cards?card_id=${encodeURIComponent(cardId)}&graded=only`,
      { headers: { 'x-api-key': env.JUSTTCG_API_KEY } }
    );
    if (statusCounts) {
      const bucket = res.status === 404 ? '404' : res.status === 429 ? '429'
        : res.status >= 500 ? '5xx' : res.ok ? 'ok' : `other_${res.status}`;
      statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
    }
    if (!res.ok) return null;   // includes the expected 404 "no graded data" case -- statusCounts tells you if that's actually what's happening
    return gpParseGraded(await res.json());
  } catch (e) {
    if (statusCounts) statusCounts.network_error = (statusCounts.network_error || 0) + 1;
    return null;   // one card's network hiccup shouldn't fail the whole run
  }
}
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
// UPDATED (diagnostic logging) -- added statusCounts tally, logged and stored alongside
// the existing snapshot so the breakdown is visible via both Logs and GET /graded-prices.
async function captureGradedPrices(env) {
  const ids = await gpCollectCatalogIds(env);
  const data = {};
  let liveCount = 0;
  const statusCounts = {};   // tally of what JustTCG's graded endpoint actually returned
  await gpMapWithConcurrency(ids, GP_FETCH_CONCURRENCY, async (id) => {
    const g = await gpFetchGraded(env, id, statusCounts);
    if (g) { data[id] = g; liveCount++; }
  });
  console.log('captureGradedPrices status breakdown:', JSON.stringify(statusCounts));   // visible in Observability -> Logs
  await env.SNAPSHOTS.put('graded-prices', JSON.stringify({
    updatedAt: new Date().toISOString(),
    cardsChecked: ids.length,
    liveCount,
    statusCounts,   // also readable via GET /graded-prices without digging through logs
    data,
  }), { expirationTtl: 172800 });   // 2-day safety net: if the cron breaks for 2 days
                                     // straight, /graded-prices starts returning 503
                                     // ("not ready") instead of silently serving very
                                     // stale data forever.
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
  const res = await fetch(upstream, { headers: { 'x-api-key': env.JUSTTCG_API_KEY } });
  if (!res.ok) return [];
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
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const cracked = scored.filter(c => c.crackP8 > 0).sort((a, b) => b.crackP8 - a.crackP8).slice(0, SH_DIGEST_COUNT);
      if (cracked.length) {
        const lines = cracked.map(c => `💎 **${c.name}** — $${c.price.toFixed(2)} raw · crack profit ~$${c.crackP8.toFixed(2)} (PSA 8 basis)`);
        const content = [
          `🔨 **Tome Vault Crack-Profit Targets** — ${today}`,
          ...lines,
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
export default {
  // Cron entry point — Cloudflare invokes this on the schedule you set.
  // UPDATED: now runs sequentially, not fire-and-forget in parallel, because
  // captureScoreHistoryAndDigest reads what captureGradedPrices just wrote.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await captureSnapshot(env);
      await captureGradedPrices(env);
      await captureScoreHistoryAndDigest(env);   // new -- reads the graded-prices snapshot above
    })());
  },
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'GET') return jsonError('Method not allowed', 405, origin);
    if (!env.JUSTTCG_API_KEY)
      return jsonError('Server misconfigured: JUSTTCG_API_KEY secret is not set.', 500, origin);
    const url = new URL(request.url);
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
  },
};
