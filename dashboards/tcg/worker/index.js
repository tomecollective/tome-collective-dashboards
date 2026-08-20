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
//     README documents for testing its own scheduled handler. One POST
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

// Resolve a card's JustTCG identity once, then cache it in KV so day-to-day
// refreshes don't re-search. Manual override: if the seed data carries a
// `justtcg_card_id` (optionally `justtcg_variant_id`), trust it directly
// instead of fuzzy name/set search -- use this for any card the search picks
// wrong. Alt-art / secret-rare / alternate-full-art printings are exactly
// the cases a text search is likely to confuse with the "plain" version of
// the same card, so spot-check the first refresh against real market prices
// before assuming every match is correct.
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
  const data = await justtcgFetch(env, { q: searchName, set: setName, game: GAME, limit: "5" });
  const match = firstMatch(data);
  if (!match) return null;
  const resolved = { cardId: match.cardId || match.id, variantId: match.variantId || null };
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

function freshProgress() {
  return {
    today: new Date().toISOString().slice(0, 10),
    // Deep clone so this run's edits don't mutate the imported seed module
    // (which stays shared across invocations in the same isolate).
    sets: JSON.parse(JSON.stringify(chaseIndexData.sets)),
    offset: 0,
    failures: [],
  };
}

// Processes one BATCH_SIZE-sized slice of cards, then either chains itself
// to the next batch (fire-and-forget, via ctx.waitUntil so it doesn't block
// this invocation's response) or, once every card has been visited,
// recomputes the index and publishes the final payload to KV.
async function processBatch(env, origin, resume, ctx) {
  let progress = resume ? await env.CHASE_INDEX_KV.get(KEY_PROGRESS, "json") : null;
  if (!progress) progress = freshProgress();

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
    await env.CHASE_INDEX_KV.put(KEY_PROGRESS, JSON.stringify(progress));
    // Chain to the next batch via the SELF service binding, NOT a plain
    // fetch() to our own workers.dev URL -- Cloudflare silently blocks a
    // worker from fetch()-ing its own *.workers.dev URL as anti-loop
    // protection (error 1042/404, request never actually invoked), which is
    // exactly what made the first version of this chain die after batch 1
    // with no visible error. Service bindings route worker-to-worker
    // internally and aren't subject to that restriction -- see wrangler.toml.
    ctx.waitUntil(env.SELF.fetch(`${origin}/api/refresh?resume=1`, { method: "POST" }));
    return { done: false, progress: `${progress.offset}/${total}`, message: "batch complete, next batch chaining automatically" };
  }

  recomputeIndex(progress.sets, progress.today);
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
  await env.CHASE_INDEX_KV.delete(KEY_PROGRESS);
  return { done: true, total, payload };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/chase-index") {
      const cached = env.CHASE_INDEX_KV ? await env.CHASE_INDEX_KV.get(CACHE_KEY_LATEST) : null;
      if (cached) return new Response(cached, { headers: corsHeaders });
      // Cold start / KV not populated yet -- serve the bundled seed so the
      // page still renders, but flag it so a stale response is obvious from
      // the API itself rather than silently passing as live data.
      const stale = {
        ...chaseIndexData,
        note: `${chaseIndexData.note} [STALE: serving bundled seed data, no KV cache yet -- POST /api/refresh or wait for the next cron run]`,
      };
      return new Response(JSON.stringify(stale), { headers: corsHeaders });
    }

    // TEMPORARY diagnostic endpoint -- returns JustTCG's raw response for one
    // card so the actual field names can be confirmed (the blog-post-derived
    // {t, p} priceHistory shape this file assumed turned out to be wrong: real
    // runs update `price` fine but `history` comes back empty). The API key
    // stays server-side; nothing secret is exposed by hitting this URL.
    // Remove this block once toHistory()/refreshCard() are fixed and verified.
    if (url.pathname === "/api/debug-card") {
      if (!env.JUSTTCG_API_KEY) {
        return new Response(JSON.stringify({ error: "JUSTTCG_API_KEY not set" }), { status: 500, headers: corsHeaders });
      }
      const name = url.searchParams.get("name") || "M Charizard EX (X) (Secret) - 108/106";
      const setName = url.searchParams.get("set") || "Flashfire";
      const cached = env.CHASE_INDEX_KV ? await env.CHASE_INDEX_KV.get(resolveKey(name, setName), "json") : null;
      if (!cached) {
        return new Response(JSON.stringify({ error: "no cached resolution for that name/set -- pass ?name=&set= matching a card already refreshed at least once" }), {
          status: 404,
          headers: corsHeaders,
        });
      }
      const params = {
        cardId: cached.cardId,
        condition: CONDITION,
        include_price_history: "true",
        priceHistoryDuration: PRICE_HISTORY_DURATION,
      };
      if (cached.variantId) params.variantId = cached.variantId;
      const res = await fetch(`${JUSTTCG_BASE}?${new URLSearchParams(params).toString()}`, {
        headers: { "x-api-key": env.JUSTTCG_API_KEY },
      });
      const body = await res.text();
      return new Response(body, { status: res.status, headers: corsHeaders });
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
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
      // time you POST here by hand.
      const resume = url.searchParams.get("resume") === "1";
      const result = await processBatch(env, url.origin, resume, ctx);
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processBatch(env, SELF_URL, false, ctx));
  },
};

// Note: SELF_URL is still used as the base for building the /api/refresh?
// resume=1 URL passed to env.SELF.fetch() -- the service binding needs a
// full Request/URL, it just doesn't route over the public network the way a
// bare global fetch() to that same URL would.
