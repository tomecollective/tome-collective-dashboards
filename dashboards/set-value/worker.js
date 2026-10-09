// tome-set-value Worker
// "Cost to Complete" - tracks total cost to complete each modern TCG set,
// across Pokemon, Lorcana, and (eventually) One Piece. Gated to Tome Vault,
// same as the Chase Index: tiles (set name, release date) are visible to
// everyone, but the dollar figure itself is locked without Vault access -
// mirrors the Top Shot dashboard's column-lock pattern, not a row-hiding
// teaser.
//
// Data source: JustTCG's GET /sets?game=<game> endpoint, which returns
// EVERY set for that game in one call, each with a pre-computed
// set_value_usd field ("Total estimated value of every card in the set").
// This means the whole pipeline is 3 total JustTCG requests (one per game)
// regardless of update frequency - no per-card resolution needed, unlike
// tome-tcg's Chase Index (a genuinely different data model, which is why
// this is a separate Worker rather than an extension of that one).
//
// set_value_usd was only added to JustTCG's API on Dec 13, 2025 - history
// can only be tracked forward from whenever this Worker first runs, same
// "no backfill exists anywhere" situation as the Top Shot low-ask history.

const JUSTTCG_SETS_URL = "https://api.justtcg.com/v1/sets";
const GAMES = ["pokemon", "disney-lorcana", "one-piece-card-game"];
const HISTORY_CAP = 1500; // ~4 years of daily snapshots

// One daily cron (10:30 UTC) refreshes every game. The earlier weekly per-game
// stagger (Tue/Thu/Sat) was retired on 2026-10-08: a /sets call per game per day
// is three requests, and daily history is what the Spike Reports and Tome Cards
// need to quote a set's cost to complete as of the previous close.

// ---- Auth utilities (copied from tome-tcg's proven, live implementation -
// not reinvented, since this exact code is already tested in production) ---

const __enc = new TextEncoder();
function secretEquals(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || !expected) return false;
  const a = __enc.encode(presented);
  const b = __enc.encode(expected);
  const sameLength = a.length === b.length;
  const cmp = sameLength ? b : a;
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

function checkAdminToken(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  return secretEquals(token, env.SET_VALUE_ADMIN_TOKEN || "");
}

function subscriberKeys(env) {
  return String(env.TOME_SUBSCRIBER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
}

function presentedSubId(request, url) {
  return (request.headers.get("X-Tome-Sub") || url.searchParams.get("sid") || "").trim();
}

const AUTH_PRODUCT = "vault";

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
    return { checked: true, allowed: Boolean(body && body.allowed), reason: body && body.reason || null };
  } catch (e) {
    return { checked: true, allowed: false, reason: "retry" };
  }
}

async function isVaultSubscriber(request, url, env) {
  if (checkAdminToken(request, env)) return true;
  const keys = subscriberKeys(env);
  const presented = request.headers.get("X-Tome-Key") || url.searchParams.get("key") || "";
  if (keys.length > 0 && secretInList(presented, keys)) return true;
  const sub = await subscriptionCheck(request, url, env);
  return sub.allowed;
}

// ---- JustTCG fetch ----------------------------------------------------------

async function fetchSetsForGame(env, game) {
  const url = `${JUSTTCG_SETS_URL}?game=${encodeURIComponent(game)}`;
  const res = await fetch(url, { headers: { "x-api-key": env.JUSTTCG_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`JustTCG ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
}

// ---- Snapshot logic ---------------------------------------------------------

function setKey(game, setId) {
  return `set:${game}:${setId}`;
}
function indexKey(game) {
  return `index:${game}`;
}

async function snapshotSetValues(env, game) {
  const kv = env.SET_VALUE_KV;
  const sets = await fetchSetsForGame(env, game);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const setIds = [];
  let skippedNoValue = 0;

  for (const s of sets) {
    setIds.push(s.id);
    // set_value_usd is documented as Optional - not every set has it
    // (likely sparse for very new or obscure sets). Skip recording a
    // snapshot entirely rather than writing a misleading $0.
    if (typeof s.set_value_usd !== "number") {
      skippedNoValue++;
      continue;
    }
    const raw = await kv.get(setKey(game, s.id));
    const record = raw ? JSON.parse(raw) : {
      id: s.id,
      name: s.name,
      game,
      release_date: s.release_date || null,
      history: [],
    };
    record.name = s.name; // keep name/date fresh in case JustTCG corrects them
    record.release_date = s.release_date || record.release_date;
    record.current_value = s.set_value_usd;
    record.variants_count = s.variants_count ?? null;

    const lastEntry = record.history[record.history.length - 1];
    if (!lastEntry || lastEntry.date !== today) {
      record.history.push({ date: today, value: s.set_value_usd });
      if (record.history.length > HISTORY_CAP) {
        record.history = record.history.slice(-HISTORY_CAP);
      }
    } else {
      lastEntry.value = s.set_value_usd; // same-day re-run - update, don't duplicate
    }

    await kv.put(setKey(game, s.id), JSON.stringify(record));
  }

  await kv.put(indexKey(game), JSON.stringify(setIds));
  return { game, setsFound: sets.length, snapshotted: sets.length - skippedNoValue, skippedNoValue };
}

// ---- HTTP surface -----------------------------------------------------------

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, X-Tome-Key, X-Tome-Sub");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    const status = {};
    for (const game of GAMES) {
      const raw = await env.SET_VALUE_KV.get(indexKey(game));
      status[game] = raw ? JSON.parse(raw).length : 0;
    }
    return Response.json({ ok: true, setsTracked: status });
  }

  if (url.pathname === "/admin/snapshot" && request.method === "POST") {
    if (!checkAdminToken(request, env)) {
      return Response.json({ error: "Invalid or missing admin token." }, { status: 401 });
    }
    const game = url.searchParams.get("game");
    if (!GAMES.includes(game)) {
      return Response.json({ error: `game must be one of: ${GAMES.join(", ")}` }, { status: 400 });
    }
    const result = await snapshotSetValues(env, game);
    return Response.json(result);
  }

  if (url.pathname === "/api/sets") {
    const game = url.searchParams.get("game");
    if (!GAMES.includes(game)) {
      return Response.json({ error: `game must be one of: ${GAMES.join(", ")}` }, { status: 400 });
    }
    const hasVault = await isVaultSubscriber(request, url, env);
    const idsRaw = await env.SET_VALUE_KV.get(indexKey(game));
    const ids = idsRaw ? JSON.parse(idsRaw) : [];
    const sets = [];
    for (const id of ids) {
      const raw = await env.SET_VALUE_KV.get(setKey(game, id));
      if (!raw) continue;
      const record = JSON.parse(raw);
      sets.push({
        id: record.id,
        name: record.name,
        release_date: record.release_date,
        // Every set tile is visible to everyone (the marketing surface) -
        // only the dollar figure itself is locked, matching how Top Shot
        // keeps gated column headers visible with a lock icon instead of
        // hiding rows entirely.
        current_value: hasVault ? record.current_value : null,
      });
    }
    sets.sort((a, b) => (b.release_date || "").localeCompare(a.release_date || ""));
    return Response.json({ game, locked: !hasVault, count: sets.length, sets });
  }

  if (url.pathname.startsWith("/api/sets/") && url.pathname.endsWith("/history")) {
    const game = url.searchParams.get("game");
    if (!GAMES.includes(game)) {
      return Response.json({ error: `game must be one of: ${GAMES.join(", ")}` }, { status: 400 });
    }
    const hasVault = await isVaultSubscriber(request, url, env);
    if (!hasVault) {
      return Response.json({ error: "History requires Tome Vault access.", locked: true }, { status: 403 });
    }
    const setId = url.pathname.split("/")[3];
    const raw = await env.SET_VALUE_KV.get(setKey(game, setId));
    if (!raw) return Response.json({ error: "Set not found." }, { status: 404 });
    const record = JSON.parse(raw);
    return Response.json({ id: record.id, name: record.name, history: record.history });
  }

  return new Response("tome-set-value: Cost to Complete indexer", { status: 200 });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { for (const game of GAMES) { try { await snapshotSetValues(env, game); } catch (e) { console.error(`set-value snapshot failed for ${game}:`, e); } } })());
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    const response = await handleRequest(request, env);
    return withCors(response);
  },
};
