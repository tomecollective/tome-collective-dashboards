// Tome Vault: Pokemon Chase Modern EN 50 -- live JustTCG-backed worker
//
// Two entry points:
//   - fetch(): serves GET /api/chase-index from KV (fast path), falling back
//     to the bundled seed JSON if KV hasn't been populated yet (first deploy,
//     or before the first scheduled run has completed). The fallback payload
//     is flagged as STALE in its `note` field so a cold start is obvious in
//     the API response itself, not just silently serving old numbers.
//   - scheduled(): runs on the Cron Trigger defined in wrangler.toml. Kicks
//     off processBatch(), which works through the ~295 cards in small
//     batches (see BATCH_SIZE below) to stay under Cloudflare's per-
//     invocation subrequest limit, chaining itself batch by batch until
//     every card is refreshed, then recomputes the shortlist/gold index
//     using the same rules the 2026-08-14 manual pass used and writes the
//     result to KV.
//   - POST /api/refresh: manually kicks off the same batched run on demand,
//     without waiting for the cron -- same pattern the healthcheck worker's
//     README documents for testing its own scheduled handler. Requires the
//     X-Admin-Token header (== the TCG_ADMIN_TOKEN secret); without it the
//     route answers 401 so strangers can't burn JustTCG quota. One POST
//     starts the chain; it finishes itself over several batches a few
//     seconds apart. Add ?resume=1 to continue an in-progress run instead of
//     restarting from card 0 (this is what the worker passes to itself).
//
// Why this fixes the Aug 15-18 gap: JustTCG retains real daily NM prices
// server-side (up to 180 days on paid plans). Requesting
// priceHistoryDuration=90d pulls back real, verified prices for every day in
// that window in a single call -- so even a multi-day gap in when this cron
// actually ran gets backfilled with real data next time it *does* run,
// instead of leaving a permanent hole in the chart the way the static seed
// file did.
//
// Verified against JustTCG's public docs/blog posts as of 2026-08-19
// (https://justtcg.com/docs, the justtcg-js README, and the "New Payload
// Controls" / "Unlocking 180-Day Price History" posts on their blog):
//   - auth header is `x-api-key`, not Bearer (the old TODO comment in this
//     file had this wrong)
//   - search is GET /v1/cards?q=<name>&set=<set>&game=pokemon
//   - price history request: include_price_history=true&priceHistoryDuration=
//     7d|30d|90d|180d
//   - each priceHistory point is {t: <epoch seconds>, p: <price>} -- NOT
//     {date, price}, hence the toHistory() conversion below
//   - condition is filterable via condition=NM / "Near Mint"
// What ISN'T independently confirmed: the exact top-level response envelope
// (whether matches come back under a `data` array or as a bare array) and
// the definitive shape of the batch POST endpoint (docs mention "POST batch,
// <=200 cards" but don't show its payload). This file defends against both
// envelope shapes it's plausible for GET to use, but you should fire one
// real request (curl or /api/refresh with just a couple of cards) and eyeball
// the response before trusting this at scale -- see DEPLOY.md.
//
// The batch POST endpoint would cut ~250 requests/run down to ~2, which
// matters once you're paying for API calls per card per day -- worth wiring
// in once its payload shape is confirmed against a real response, but not
// guessed at here.

import chaseIndexData from "../data/chase-50-modern-seed.json";

const JUSTTCG_BASE = "https://api.justtcg.com/v1/cards";
const GAME = "pokemon";
const CONDITION = "NM"; // Near Mint -- matches what this index has always tracked
const PRICE_HISTORY_DURATION = "90d"; // wide enough to backfill a multi-day outage
const SET_ELIGIBILITY_DAYS = 90; // must match index.html's SET_ELIGIBILITY_DAYS
const MAX_GOLD_PER_SET = 3; // must match index.html's MAX_GOLD_PER_SET
const TOP_N = 50;

const CACHE_KEY_LATEST = "latest";
const RESOLVE_PREFIX = "resolved:"; // resolved:<name>|<set_name> -> {cardId, variantId}
const KEY_PROGRESS = "refresh:progress"; // in-flight batch state between chained invocations
const SELF_URL = "https://tome-tcg.tomecollective.workers.dev"; // used by scheduled() to call itself

// Cloudflare Workers cap outbound requests (fetch calls AND KV operations
// both count) at 50 per single invocation on the Free plan (1000 on Workers
// Paid). Each card can use up to 3 of those (a KV read to check the resolved-
// id cache, a JustTCG search if not cached, a JustTCG price fetch) -- so
// refreshing ~295 cards in one invocation blows past 50 well before finishing
// and everything after that point silently keeps its last known price. This
// worker instead processes BATCH_SIZE cards per invocation, saves progress to
// KV, and fires the next batch as a brand-new invocation (its own fresh
// subrequest budget) via a self-fetch -- so the whole run completes across
// several chained invocations instead of exceeding the limit in one.
const BATCH_SIZE = 12;

// If more than this fraction of cards fail to refresh in a run (e.g. the
// JustTCG API key is rejected, or the API is down), the run's result is
// mostly-empty/placeholder data, not a real daily update. Publishing it
// anyway would stamp today's date on the index and overwrite the accumulated
// price history with the failed run's near-empty state -- worse than just
// leaving yesterday's good data live for one more day. See freshProgress()
// and the publish gate at the end of processBatch().
const MAX_FAILURE_RATE_TO_PUBLISH = 0.5;

const KEY_LAST_STATUS = "refresh:last_status"; // small always-written diagnostic record, see processBatch()

function resolveKey(name, setName) {
  return `${RESOLVE_PREFIX}${name}|${setName}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// JustTCG rate-limits requests (429 "Rate limit exceeded"). A batch of 12
// sequential calls with no spacing was enough to trip it partway through a
// run, after which every remaining card in that run kept failing too since
// nothing backed off. This adds a fixed pause before every call, plus a
// retry-with-backoff specifically for 429s (transient by nature -- the
// request itself is fine, it just needs to wait its turn).
const REQUEST_DELAY_MS = 350;
const MAX_429_RETRIES = 3;

async function justtcgFetch(env, params) {
  const url = `${JUSTTCG_BASE}?${new URLSearchParams(params).toString()}`;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await sleep(REQUEST_DELAY_MS);
    const res = await fetch(url, {
      headers: { "x-api-key": env.JUSTTCG_API_KEY },
    });
    if (res.status === 429) {
      if (attempt === MAX_429_RETRIES) {
        const body = await res.text().catch(() => "");
        throw new Error(`JustTCG 429 (gave up after ${MAX_429_RETRIES} retries) for ${url}: ${body.slice(0, 300)}`);
      }
      await sleep(REQUEST_DELAY_MS * 2 ** attempt * 4); // 1.4s, 2.8s, 5.6s
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`JustTCG ${res.status} for ${url}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
}

function firstMatch(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (Array.isArray(data?.data)) return data.data[0] || null;
  return data || null;
}

function matchList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function normalizeSetName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Our seed data's collector number is embedded in the card name, e.g.
// "M Charizard EX (X) (Secret) - 108/106" -> "108/106". Some entries have a
// second trailing "- 108/106" too (copy/paste artifact in the seed file);
// this grabs the LAST NNN/NNN-shaped token in the string either way.
function extractNumber(name) {
  const matches = [...name.matchAll(/(\d{1,4}\/\d{1,4})/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

// Resolve a card's JustTCG identity once, then cache it in KV so day-to-day
// refreshes don't re-search. Manual override: if the seed data carries a
// `justtcg_card_id` (optionally `justtcg_variant_id`), trust it directly
// instead of fuzzy name/set search -- use this for any card the search picks
// wrong. Alt-art / secret-rare / alternate-full-art printings are exactly
// the cases a text search is likely to confuse with the "plain" version of
// the same card, so spot-check the first refresh against real market prices
// before assuming every match is correct.
//
// IMPORTANT: this does NOT pass JustTCG's `set` query param. Testing showed
// it expects an internal slug (e.g. "arceus-pokemon") that has no
// predictable relationship to the human-readable set names this project
// uses (JustTCG calls our "Flashfire" set "XY - Flashfire", for example) --
// passing our set name as that filter silently matched zero cards for
// almost every set. Instead this searches by name only and filters/ranks
// the results in-process against our own set_name and collector number.
async function resolveCardId(env, card, setName) {
  if (card.justtcg_card_id) {
    return { cardId: card.justtcg_card_id, variantId: card.justtcg_variant_id || null };
  }
  const cacheKey = resolveKey(card.name, setName);
  if (env.CHASE_INDEX_KV) {
    const cached = await env.CHASE_INDEX_KV.get(cacheKey, "json");
    if (cached) return cached;
  }
  const searchName = card.name.split(" - ")[0].trim(); // strip trailing "- NNN/NNN" collector numbers
  const wantedNumber = extractNumber(card.name);
  const wantedSet = normalizeSetName(setName);

  const data = await justtcgFetch(env, { q: searchName, game: GAME, limit: "25" });
  const results = matchList(data);

  let candidates = results.filter((r) => {
    const rs = normalizeSetName(r.set_name);
    return rs && (rs.includes(wantedSet) || wantedSet.includes(rs));
  });
  if (wantedNumber) {
    const withNumber = candidates.filter((r) => (r.number || "").replace(/\s/g, "") === wantedNumber);
    if (withNumber.length) candidates = withNumber;
  }
  // If set-name matching found nothing (an even less predictable JustTCG
  // naming quirk than the ones already seen), fall back to matching on
  // collector number alone across ALL results for this name -- still a real
  // signal, just a weaker one.
  if (!candidates.length && wantedNumber) {
    candidates = results.filter((r) => (r.number || "").replace(/\s/g, "") === wantedNumber);
  }

  const match = candidates[0] || null;
  if (!match) return null;
  const resolved = { cardId: match.id || match.cardId, variantId: null };
  if (env.CHASE_INDEX_KV) {
    await env.CHASE_INDEX_KV.put(cacheKey, JSON.stringify(resolved));
  }
  return resolved;
}

function toHistory(priceHistory) {
  if (!Array.isArray(priceHistory)) return [];
  return priceHistory
    .filter((point) => point && typeof point.t === "number" && typeof point.p === "number")
    .map((point) => ({
      date: new Date(point.t * 1000).toISOString().slice(0, 10),
      price: point.p,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Merge new points into existing history by date, so a re-run never loses a
// day that's already been captured, and a day that gets corrected upstream
// (JustTCG revises a price) picks up the newer value.
function mergeHistory(existing, incoming) {
  const byDate = new Map((existing || []).map((p) => [p.date, p.price]));
  for (const p of incoming) byDate.set(p.date, p.price);
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, price]) => ({ date, price }));
}

async function refreshCard(env, card, setName) {
  const resolved = await resolveCardId(env, card, setName);
  if (!resolved) {
    return { ...card, note: card.note || "JustTCG match not found -- add justtcg_card_id override" };
  }
  const params = {
    cardId: resolved.cardId,
    condition: CONDITION,
    include_price_history: "true",
    priceHistoryDuration: PRICE_HISTORY_DURATION,
  };
  if (resolved.variantId) params.variantId = resolved.variantId;

  const data = await justtcgFetch(env, params);
  const cardData = firstMatch(data);
  if (!cardData) return { ...card, note: "JustTCG returned no data for resolved cardId" };

  const variant = Array.isArray(cardData.variants)
    ? cardData.variants.find((v) => v.condition === "Near Mint" || v.condition === CONDITION) || cardData.variants[0]
    : cardData;
  if (!variant) return card;

  const incomingHistory = toHistory(variant.priceHistory);
  return {
    ...card,
    price: typeof variant.price === "number" ? variant.price : card.price,
    history: mergeHistory(card.history, incomingHistory),
    note: undefined,
  };
}

function isEligible(set, computeDate) {
  const release = new Date(set.release_date);
  const days = (computeDate - release) / (1000 * 60 * 60 * 24);
  return days > SET_ELIGIBILITY_DAYS;
}

// Recompute shortlist (top 3 of 5 by price, per set) and the final gold-50
// (top 50 by price across all eligible sets' shortlists, capped at
// MAX_GOLD_PER_SET per set) -- the same rule the 2026-08-14 manual note
// described. Mutates `sets` in place and returns it.
function recomputeIndex(sets, computeDateStr) {
  const computeDate = new Date(computeDateStr);
  const candidates = [];

  for (const set of sets) {
    for (const c of set.top_5) {
      c.shortlisted = false;
      c.in_index = false;
    }
    const top3 = [...set.top_5]
      .filter((c) => typeof c.price === "number")
      .sort((a, b) => b.price - a.price)
      .slice(0, 3);
    top3.forEach((c) => (c.shortlisted = true));
    if (isEligible(set, computeDate)) {
      top3.forEach((c) => candidates.push({ card: c, setName: set.set_name }));
    }
  }

  candidates.sort((a, b) => b.card.price - a.card.price);
  const perSetCount = {};
  let taken = 0;
  for (const { card, setName } of candidates) {
    if (taken >= TOP_N) break;
    perSetCount[setName] = perSetCount[setName] || 0;
    if (perSetCount[setName] >= MAX_GOLD_PER_SET) continue;
    card.in_index = true;
    perSetCount[setName] += 1;
    taken += 1;
  }
  return sets;
}

// Flat list of {si, ci, setName} pointers into a `sets` array, one per card
// that actually has real data to refresh (skips placeholder "needs research"
// rows). Order is stable across calls since it's derived from the same
// bundled seed structure every time.
function flattenRefs(sets) {
  const refs = [];
  sets.forEach((set, si) => {
    set.top_5.forEach((card, ci) => {
      if (card.price !== null && card.note !== "needs research") {
        refs.push({ si, ci, setName: set.set_name });
      }
    });
  });
  return refs;
}

// Starting point for a brand-new run's working data. Prefers the last
// SUCCESSFULLY PUBLISHED payload in KV -- so a card that fails to refresh
// today keeps yesterday's real price/history instead of being reset to the
// bundled seed's static placeholder (price stub, empty history). Only falls
// back to the raw seed if KV has never been populated yet (first deploy).
async function freshProgress(env) {
  const today = new Date().toISOString().slice(0, 10);
  if (env.CHASE_INDEX_KV) {
    const publishedRaw = await env.CHASE_INDEX_KV.get(CACHE_KEY_LATEST);
    if (publishedRaw) {
      try {
        const published = JSON.parse(publishedRaw);
        if (Array.isArray(published.sets)) {
          return { today, sets: published.sets, offset: 0, failures: [] };
        }
      } catch {
        // fall through to seed below -- malformed KV value shouldn't crash the run
      }
    }
  }
  return {
    today,
    // Deep clone so this run's edits don't mutate the imported seed module
    // (which stays shared across invocations in the same isolate).
    sets: JSON.parse(JSON.stringify(chaseIndexData.sets)),
    offset: 0,
    failures: [],
    // Per-run secret the batch chain presents on its resume=1 calls, so the
    // chain keeps working without exposing an unauthenticated /api/refresh.
    chainNonce: crypto.randomUUID(),
  };
}

// -- Subscriber gate for GET /api/chase-index --------------------------------
// The full payload (all 50 holdings with 90-day histories + the whole
// candidate pool) is the product. Without a valid X-Tome-Key (or ?key=)
// matching one of the comma-separated TOME_SUBSCRIBER_KEYS values, the route
// serves a teaser: index value series, top 10 holdings with an 8-day history
// tail, no candidate pool. Admin token also unlocks the full payload. Unset
// secret => everyone gets the teaser (fails closed on the paid part).
const TEASER_TOP_N = 10;
const TEASER_HISTORY_DAYS = 8;

function subscriberKeys(env) {
  return String(env.TOME_SUBSCRIBER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
}


// -- Subscription-id gate (Beehiiv subscription via tome-proxy) ------------------
// The Dashboards post fills {{api_subscription_id}} into each subscriber's Open
// button, so the page can present X-Tome-Sub: sub_<uuid> (or ?sid=). This Worker
// asks tome-proxy over the AUTH service binding (wrangler.toml [[services]])
// whether that subscription is active on a tier that includes this product;
// tome-proxy owns the Beehiiv lookup, KV cache, and webhook invalidation. The
// call is authenticated by the shared TOME_INTERNAL_TOKEN secret. Absent
// binding or token = the sid path is simply not checked (shared key still works).
const AUTH_PRODUCT = "vault";
function presentedSubId(request, url) {
  return (request.headers.get("X-Tome-Sub") || url.searchParams.get("sid") || "").trim();
}
async function subscriptionCheck(request, url, env) {
  const sid = presentedSubId(request, url);
  if (!sid || !env.AUTH || !env.TOME_INTERNAL_TOKEN) return { checked: false, allowed: false, reason: null };
  try {
    const res = await env.AUTH.fetch(new Request(
      "https://tome-proxy/auth/subscription?sid=" + encodeURIComponent(sid) + "&need=" + AUTH_PRODUCT,
      { headers: { "X-Tome-Internal": env.TOME_INTERNAL_TOKEN } }
    ));
    if (res.status === 503) return { checked: true, allowed: false, reason: "retry" };
    if (!res.ok) return { checked: true, allowed: false, reason: "unknown" };
    const body = await res.json();
    return { checked: true, allowed: Boolean(body && body.allowed), reason: (body && body.reason) || null };
  } catch (e) {
    return { checked: true, allowed: false, reason: "retry" };
  }
}

async function isSubscriber(request, url, env) {
  if (checkAdminToken(request, env)) return true;
  const keys = subscriberKeys(env);
  const presented = request.headers.get("X-Tome-Key") || url.searchParams.get("key") || "";
  if (keys.length > 0 && secretInList(presented, keys)) return true;
  const sub = await subscriptionCheck(request, url, env);
  return sub.allowed;
}

function buildTeaser(payload) {
  const holdings = [];
  for (const set of payload.sets || []) {
    for (const c of set.top_5 || []) {
      if (c.in_index) holdings.push({ ...c, set_name: set.set_name, era: set.era, release_date: set.release_date });
    }
  }
  // Index value series: sum over all index cards, only on dates every card
  // has a point (same rule as index.html so the two never disagree).
  const totals = {};
  const counts = {};
  for (const c of holdings) {
    for (const pt of c.history || []) {
      totals[pt.date] = (totals[pt.date] || 0) + pt.price;
      counts[pt.date] = (counts[pt.date] || 0) + 1;
    }
  }
  const indexHistory = Object.keys(totals)
    .filter((d) => counts[d] === holdings.length)
    .sort()
    .map((date) => ({ date, total: Math.round(totals[date] * 100) / 100 }));
  const top = holdings
    .filter((c) => typeof c.price === "number")
    .sort((a, b) => b.price - a.price)
    .slice(0, TEASER_TOP_N)
    .map((c) => ({
      name: c.name,
      set_name: c.set_name,
      rarity: c.rarity,
      price: c.price,
      history: (c.history || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-TEASER_HISTORY_DAYS),
    }));
  return {
    index_name: payload.index_name,
    last_updated: payload.last_updated,
    note: payload.note,
    teaser: true,
    holdingsCount: holdings.length,
    setsCount: (payload.sets || []).length,
    indexHistory,
    topHoldings: top,
    sets: [],
    lockedNote: `Showing the index value and the top ${TEASER_TOP_N} of ${holdings.length} holdings. The full holdings table, per-card 90-day price history and the ${(payload.sets || []).length}-set candidate pool are for Tome Edge subscribers.`,
  };
}

async function rateLimited(request, env, corsHeaders) {
  if (!env.PUBLIC_RATE_LIMITER) return null;
  try {
    const { success } = await env.PUBLIC_RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return new Response(JSON.stringify({ error: "Too many requests -- slow down." }), { status: 429, headers: corsHeaders });
  } catch (err) {
    console.error("rate limiter error (allowing request):", err.message);
  }
  return null;
}

// -- Admin auth for POST /api/refresh -----------------------------------------
// A fresh run may only be started by the cron (scheduled(), no HTTP) or by an
// admin presenting X-Admin-Token == TCG_ADMIN_TOKEN. Batch continuations
// (?resume=1) are authenticated by the per-run chainNonce stored in KV
// progress and sent back as X-Refresh-Chain -- never by the admin token, so
// the chain works even if the secret is rotated mid-run.
// -- Constant-time secret comparison --------------------------------------------
// Plain `===` short-circuits on the first differing byte, which leaks how many
// leading characters of a guess match. Both branches below are constant-time:
// crypto.subtle.timingSafeEqual (Workers runtime) when available, otherwise a
// data-independent XOR fold over every byte. Length mismatches are handled by
// comparing the guess against itself so the work done is the same either way.
const __enc = new TextEncoder();
function secretEquals(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || !expected) return false;
  const a = __enc.encode(presented);
  const b = __enc.encode(expected);
  const sameLength = a.length === b.length;
  const cmp = sameLength ? b : a; // always run a full comparison of a.length bytes
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

// True when `presented` equals ANY of `candidates`. Every candidate is
// compared (no early exit), so the timing doesn't reveal which one matched.
function secretInList(presented, candidates) {
  let found = false;
  for (const c of candidates) found = secretEquals(presented, c) || found;
  return found;
}

function checkAdminToken(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  return secretEquals(token, env.TCG_ADMIN_TOKEN || "");
}

async function checkChainNonce(request, env) {
  const presented = request.headers.get("X-Refresh-Chain") || "";
  if (!presented || !env.CHASE_INDEX_KV) return false;
  const progress = await env.CHASE_INDEX_KV.get(KEY_PROGRESS, "json");
  return Boolean(progress && progress.chainNonce) && secretEquals(presented, progress.chainNonce);
}

// Processes one BATCH_SIZE-sized slice of cards, then either chains itself
// to the next batch (fire-and-forget, via ctx.waitUntil so it doesn't block
// this invocation's response) or, once every card has been visited,
// recomputes the index and publishes the final payload to KV.
async function processBatch(env, origin, resume, ctx) {
  let progress = resume ? await env.CHASE_INDEX_KV.get(KEY_PROGRESS, "json") : null;
  if (!progress) progress = await freshProgress(env);

  const refs = flattenRefs(progress.sets);
  const total = refs.length;
  const slice = refs.slice(progress.offset, progress.offset + BATCH_SIZE);

  for (const ref of slice) {
    const set = progress.sets[ref.si];
    const card = set.top_5[ref.ci];
    try {
      set.top_5[ref.ci] = await refreshCard(env, card, ref.setName);
    } catch (err) {
      progress.failures.push(`${card.name} (${ref.setName}): ${err.message}`);
    }
  }
  progress.offset += slice.length;

  if (progress.offset < total) {
    // Chain to the next batch via the SELF service binding, NOT a plain
    // fetch() to our own workers.dev URL -- Cloudflare silently blocks a
    // worker from fetch()-ing its own *.workers.dev URL as anti-loop
    // protection (error 1042/404, request never actually invoked), which is
    // exactly what made the first version of this chain die after batch 1
    // with no visible error. Service bindings route worker-to-worker
    // internally and aren't subject to that restriction -- see wrangler.toml.
    if (!progress.chainNonce) progress.chainNonce = crypto.randomUUID(); // progress written before this field existed
    await env.CHASE_INDEX_KV.put(KEY_PROGRESS, JSON.stringify(progress));
    ctx.waitUntil(
      env.SELF.fetch(`${origin}/api/refresh?resume=1`, { method: "POST", headers: { "X-Refresh-Chain": progress.chainNonce } })
    );
    return { done: false, progress: `${progress.offset}/${total}`, message: "batch complete, next batch chaining automatically" };
  }

  recomputeIndex(progress.sets, progress.today);

  const failureRate = total > 0 ? progress.failures.length / total : 0;
  const status = {
    ranAt: progress.today,
    total,
    failed: progress.failures.length,
    failureRate: Math.round(failureRate * 100) / 100,
    sampleFailures: progress.failures.slice(0, 5),
  };

  // Guard: a run where most cards failed (bad/expired API key, JustTCG
  // outage, etc.) produces mostly placeholder data, not a real update.
  // Publishing it would stamp today's date on the index AND overwrite the
  // good, accumulated history from previous runs -- turning a one-day API
  // outage into a permanent data loss. Skip the publish and leave the last
  // good payload live instead; `refresh:last_status` still records that this
  // run happened and failed, so it's visible via GET /api/refresh-status
  // instead of silently vanishing.
  if (failureRate > MAX_FAILURE_RATE_TO_PUBLISH) {
    await env.CHASE_INDEX_KV.put(KEY_LAST_STATUS, JSON.stringify({ ...status, published: false }));
    await env.CHASE_INDEX_KV.delete(KEY_PROGRESS);
    return {
      done: true,
      published: false,
      reason: `${progress.failures.length}/${total} cards failed to refresh (>${Math.round(MAX_FAILURE_RATE_TO_PUBLISH * 100)}% threshold) -- kept yesterday's published data instead of overwriting it`,
      status,
    };
  }

  const payload = {
    index_name: chaseIndexData.index_name,
    last_updated: progress.today,
    sets: progress.sets,
    note:
      `Auto-refreshed ${progress.today} via JustTCG (condition=${CONDITION}, ` +
      `priceHistoryDuration=${PRICE_HISTORY_DURATION}), processed in batches of ` +
      `${BATCH_SIZE} to stay under Cloudflare's per-invocation subrequest limit. ` +
      `Eligibility gate: ${SET_ELIGIBILITY_DAYS} days. Max ${MAX_GOLD_PER_SET} gold per set.` +
      (progress.failures.length
        ? ` ${progress.failures.length} card(s) failed to refresh and kept their last known price: ${progress.failures.slice(0, 5).join("; ")}${progress.failures.length > 5 ? "..." : ""}`
        : ""),
  };
  await env.CHASE_INDEX_KV.put(CACHE_KEY_LATEST, JSON.stringify(payload));
  await env.CHASE_INDEX_KV.put(KEY_LAST_STATUS, JSON.stringify({ ...status, published: true }));
  await env.CHASE_INDEX_KV.delete(KEY_PROGRESS);
  return { done: true, total, published: true, payload };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, X-Tome-Key, X-Tome-Sub",
      "Content-Type": "application/json",
    };

    if (request.method !== "OPTIONS") {
      const limited = await rateLimited(request, env, corsHeaders);
      if (limited) return limited;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/chase-index") {
      const cached = env.CHASE_INDEX_KV ? await env.CHASE_INDEX_KV.get(CACHE_KEY_LATEST) : null;
      // Cold start / KV not populated yet -- serve the bundled seed so the
      // page still renders, but flag it so a stale response is obvious from
      // the API itself rather than silently passing as live data.
      const payload = cached
        ? JSON.parse(cached)
        : {
            ...chaseIndexData,
            note: `${chaseIndexData.note} [STALE: serving bundled seed data, no KV cache yet -- POST /api/refresh or wait for the next cron run]`,
          };
      if (await isSubscriber(request, url, env)) return new Response(JSON.stringify(payload), { headers: corsHeaders });
      return new Response(JSON.stringify(buildTeaser(payload)), { headers: corsHeaders });
    }

    // Quick health check for the daily refresh, independent of the cron's
    // fire-and-forget ctx.waitUntil() (which has no other visible output).
    // Written on every run, success or failure -- see processBatch().
    if (url.pathname === "/api/refresh-status") {
      const status = env.CHASE_INDEX_KV ? await env.CHASE_INDEX_KV.get(KEY_LAST_STATUS, "json") : null;
      return new Response(JSON.stringify(status || { note: "no refresh has run yet" }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      const resume = url.searchParams.get("resume") === "1";
      const authorized = resume ? await checkChainNonce(request, env) : checkAdminToken(request, env);
      if (!authorized) {
        return new Response(JSON.stringify({ error: "Invalid or missing admin token." }), { status: 401, headers: corsHeaders });
      }
      if (!env.JUSTTCG_API_KEY) {
        return new Response(JSON.stringify({ error: "JUSTTCG_API_KEY not set -- wrangler secret put JUSTTCG_API_KEY" }), {
          status: 500,
          headers: corsHeaders,
        });
      }
      if (!env.CHASE_INDEX_KV) {
        return new Response(JSON.stringify({ error: "CHASE_INDEX_KV not bound -- check wrangler.toml" }), {
          status: 500,
          headers: corsHeaders,
        });
      }
      // ?resume=1 continues a chained run already in progress (this is what
      // the worker calls on itself between batches); no resume param means
      // "start a fresh run from card 0", which is what you want the first
      // time you POST here by hand (with the X-Admin-Token header).
      const result = await processBatch(env, url.origin, resume, ctx);
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    // Cron runs every 30 minutes. If an earlier run today got cut off
    // partway through (Cloudflare's per-invocation limits, a transient
    // error, etc.), the next tick picks up where it stopped instead of
    // restarting from card 0, so the run still reaches completion within
    // the same day instead of endlessly resetting itself. (Merged in from
    // a live-only edit made directly in the Cloudflare dashboard that had
    // drifted out of sync with this repo -- see KEY_PROGRESS above.)
    const today = new Date().toISOString().slice(0, 10);
    const existing = env.CHASE_INDEX_KV ? await env.CHASE_INDEX_KV.get(KEY_PROGRESS, "json") : null;
    const resume = !!(existing && existing.today === today);
    ctx.waitUntil(processBatch(env, SELF_URL, resume, ctx));
  },
};

// Note: SELF_URL is still used as the base for building the /api/refresh?
// resume=1 URL passed to env.SELF.fetch() -- the service binding needs a
// full Request/URL, it just doesn't route over the public network the way a
// bare global fetch() to that same URL would.
