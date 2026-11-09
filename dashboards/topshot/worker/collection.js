// Collection reader for tome-topshot.
// GET /api/topshot/collection?user=<Top Shot username | 0x Flow address>[&refresh=1]
//
// Read-only. A Top Shot collection is public on Flow: the account publishes
// &{TopShot.MomentCollectionPublic} at /public/MomentCollection, so any
// address can be read with a script -- no sign-in, no signature. Nothing is
// stored server-side except a 1-hour cache keyed by Flow address
// (coll:<address>) and a username -> address lookup (tsuser:<username>).
// Addresses are never logged next to subscription ids.
//
// Join: each Moment's (setID, playID) -> set name + tier from sets:inventory,
// player identity from the editions snapshot or the plays:index map (both
// built by the indexer / eligibility route), low ask from the snapshot.
import { normalizeName } from "../../shared/names.js";

const TOPSHOT_CONTRACT = "0x0b2a3299cc857e29"; // same import as the editions indexer
const FLOW_REST_URL = "https://rest-mainnet.onflow.org/v1";
const COLL_CACHE_PREFIX = "coll:";
const COLL_CACHE_TTL_S = 60 * 60;
const COLL_REFRESH_MIN_MS = 10 * 60 * 1000; // ?refresh=1 at most once per 10 min per address
const COLL_RL_PREFIX = "collrl:";
const USER_CACHE_PREFIX = "tsuser:";
const USER_CACHE_TTL_S = 7 * 24 * 60 * 60;
const MAX_MOMENTS = 5000;
const PLAY_LOOKUP_BUDGET = 30; // Flow calls per read for plays the indexes don't know yet (cached forever)
const PARTIAL_CACHE_TTL_S = 5 * 60; // a read with plays still pending is cached briefly
const ID_CHUNK = 500;
const TIER_RANK = { Ultimate: 4, Legendary: 3, Rare: 2, Fandom: 1, Common: 1 };
const ROOKIE_DEBUT_RE = /^(WNBA )?Rookie (Debut|Revelation)$/i;

const ADDRESS_HELP =
  "We couldn't look up that Top Shot username. Enter your Flow address instead: in Top Shot, open your profile menu, go to Settings, and copy the Flow address (it starts with 0x).";

// ---- Username -> Flow address -------------------------------------------------
// The ONE place that talks to Top Shot. If Top Shot changes its public API,
// this is the only function to fix. Returns an address string or null.
// Verified Oct 26 2026: public-api.nbatopshot.com/graphql answered a Cloudflare
// 1033 (tunnel down) and nbatopshot.com/marketplace/graphql sits behind a bot
// challenge, so this currently returns null and readers use the address path.
async function resolveTopShotUsername(username) {
  const endpoints = ["https://public-api.nbatopshot.com/graphql"];
  const query = `query ($u: String!) { getUserProfileByUsername(input: { username: $u }) { publicInfo { flowAddress username } } }`;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables: { u: username } }),
      });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      const info = body?.data?.getUserProfileByUsername?.publicInfo;
      const addr = info?.flowAddress ? String(info.flowAddress) : null;
      if (addr) return { address: addr.startsWith("0x") ? addr : `0x${addr}`, username: info.username || username };
    } catch (err) {
      // fall through to the next endpoint / null
    }
  }
  return null;
}

function isFlowAddress(s) {
  return /^0x[0-9a-fA-F]{16}$/.test(s);
}

// ---- Flow scripts ---------------------------------------------------------------
async function runScript(code, args) {
  const body = JSON.stringify({
    script: btoa(code),
    arguments: args.map((a) => btoa(JSON.stringify(a))),
  });
  const res = await fetch(`${FLOW_REST_URL}/scripts`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`Flow script non-JSON response: ${text.slice(0, 200)}`); }
  if (typeof parsed !== "string") throw new Error(`Flow script error: ${JSON.stringify(parsed).slice(0, 200)}`);
  const bin = atob(parsed);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

const SCRIPT_IDS = `import TopShot from ${TOPSHOT_CONTRACT}
access(all) fun main(account: Address): [UInt64]? {
  let ref = getAccount(account).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if ref == nil { return nil }
  return ref!.getIDs()
}`;

const SCRIPT_DATA = `import TopShot from ${TOPSHOT_CONTRACT}
access(all) struct M {
  access(all) let id: UInt64
  access(all) let setID: UInt32
  access(all) let playID: UInt32
  access(all) let serialNumber: UInt32
  init(id: UInt64, setID: UInt32, playID: UInt32, serialNumber: UInt32) {
    self.id = id; self.setID = setID; self.playID = playID; self.serialNumber = serialNumber
  }
}
access(all) fun main(account: Address, ids: [UInt64]): [M] {
  let ref = getAccount(account).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if ref == nil { return [] }
  let out: [M] = []
  for id in ids {
    if let m = ref!.borrowMoment(id: id) {
      out.append(M(id: id, setID: m.data.setID, playID: m.data.playID, serialNumber: m.data.serialNumber))
    }
  }
  return out
}`;

async function readMomentIds(address) {
  const r = await runScript(SCRIPT_IDS, [{ type: "Address", value: address }]);
  if (!r || r.value == null) return null; // no published collection
  const arr = r.value.value || r.value; // Optional<[UInt64]>
  return (Array.isArray(arr) ? arr : []).map((x) => String(x.value));
}

async function readMomentData(address, ids) {
  const r = await runScript(SCRIPT_DATA, [
    { type: "Address", value: address },
    { type: "Array", value: ids.map((id) => ({ type: "UInt64", value: id })) },
  ]);
  return (r.value || []).map((s) => {
    const f = {};
    for (const fld of s.value.fields) f[fld.name] = fld.value.value;
    return { id: String(f.id), setID: Number(f.setID), playID: Number(f.playID), serial: Number(f.serialNumber) };
  });
}

// ---- Join -----------------------------------------------------------------------
function buildCollection({ address, username, moments, total, inventory, snapshot, playsIndex }) {
  const editions = new Map();
  for (const e of snapshot?.editions || []) editions.set(`${e.setID}_${e.playID}`, e);
  const byPlayer = new Map();
  const unindexedMoments = [];
  for (const m of moments) {
    const ed = editions.get(`${m.setID}_${m.playID}`);
    const set = inventory[m.setID] || inventory[String(m.setID)] || null;
    const play = ed || playsIndex[String(m.playID)] || null;
    const playerName = play?.playerName || null;
    if (!playerName) {
      unindexedMoments.push({ id: m.id, setID: m.setID, playID: m.playID, serial: m.serial });
      continue;
    }
    const setName = ed?.setName || set?.name || null;
    const tier = set?.tier || ed?.tier || "Unknown";
    const moment = {
      id: m.id,
      setName,
      tier,
      serial: m.serial,
      nbaSeason: play.nbaSeason || null,
      lowAsk: ed?.lowAsk ?? null,
      isRookieYear: !!play.isRookieYear,
      isRookieDebut: ROOKIE_DEBUT_RE.test(setName || ""),
    };
    const key = normalizeName(playerName);
    if (!byPlayer.has(key)) byPlayer.set(key, { name: playerName, team: play.team || null, moments: [] });
    byPlayer.get(key).moments.push(moment);
  }
  const players = [...byPlayer.values()].map((p) => {
    let best = null;
    for (const m of p.moments) {
      const r = TIER_RANK[m.tier] || 0;
      const br = best ? TIER_RANK[best.tier] || 0 : -1;
      if (!best || r > br || (r === br && (m.lowAsk ?? -1) > (best.lowAsk ?? -1))) best = m;
    }
    p.moments.sort((a, b) => (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0) || (b.lowAsk ?? -1) - (a.lowAsk ?? -1));
    return { name: p.name, team: p.team, best: { tier: best.tier, setName: best.setName, lowAsk: best.lowAsk }, moments: p.moments };
  });
  players.sort((a, b) => a.name.localeCompare(b.name));
  return {
    resolved: true,
    address,
    username: username || null,
    count: moments.length,
    totalOwned: total,
    truncated: total > moments.length,
    unindexed: unindexedMoments.length,
    unindexedMoments,
    updatedAt: new Date().toISOString(),
    indexedAt: snapshot?.builtAt || null,
    players,
  };
}

// ---- Route ----------------------------------------------------------------------
// gate(request, url, env) -> Response | null (null = allowed)
// helpers: { getPlayIdentity(playID), getSetName(setID) } from worker.js
export async function handleCollection(request, env, url, gate, helpers = {}) {
  const json = (body, status = 200) => Response.json(body, { status });
  const denied = await gate(request, url, env);
  if (denied) return denied;

  const raw = String(url.searchParams.get("user") || "").trim().replace(/^@/, "");
  if (!raw) return json({ error: "pass user= (a Top Shot username or a 0x Flow address)" }, 400);
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw) || raw.split(/\s+/).length >= 12) {
    return json({ error: "That looks like a private key or recovery phrase. Never share it. Enter a username or a Flow address only." }, 400);
  }
  const kv = env.TOPSHOT_KV;

  let address = null;
  let username = null;
  if (raw.toLowerCase().startsWith("0x")) {
    if (!isFlowAddress(raw)) return json({ resolved: false, message: "A Flow address is 0x followed by 16 letters and numbers." }, 200);
    address = raw.toLowerCase();
  } else {
    if (!/^[A-Za-z0-9_.-]{2,40}$/.test(raw)) return json({ resolved: false, message: ADDRESS_HELP }, 200);
    username = raw;
    const cached = await kv.get(USER_CACHE_PREFIX + raw.toLowerCase());
    if (cached) address = cached;
    else {
      const r = await resolveTopShotUsername(raw);
      if (!r) return json({ resolved: false, username: raw, message: ADDRESS_HELP }, 200);
      address = r.address.toLowerCase();
      username = r.username;
      await kv.put(USER_CACHE_PREFIX + raw.toLowerCase(), address, { expirationTtl: USER_CACHE_TTL_S });
    }
  }

  const cacheKey = COLL_CACHE_PREFIX + address;
  const wantRefresh = url.searchParams.get("refresh") === "1" && !!(request.headers.get("X-Tome-Sub") || request.headers.get("X-Admin-Token"));
  if (!wantRefresh) {
    const hit = await kv.get(cacheKey);
    if (hit) {
      const body = JSON.parse(hit);
      if (username && !body.username) body.username = username;
      return json({ ...body, cached: true });
    }
  } else {
    // Per-address rate limit on forced re-reads (a whale is up to 11 Flow calls).
    const last = Number((await kv.get(COLL_RL_PREFIX + address)) || 0);
    if (Date.now() - last < COLL_REFRESH_MIN_MS) {
      const hit = await kv.get(cacheKey);
      // A read that still has plays to look up may re-read right away.
      if (hit && !(JSON.parse(hit).pendingPlays > 0)) return json({ ...JSON.parse(hit), cached: true, refreshLimited: true });
    }
  }

  let ids;
  try {
    ids = await readMomentIds(address);
  } catch (err) {
    return json({ error: "Couldn't read that account from Flow right now. Try again in a minute." }, 502);
  }
  if (ids == null) {
    return json({ resolved: false, address, message: "That Flow address has no public Top Shot collection. Check the address in Top Shot settings." }, 200);
  }
  const total = ids.length;
  const take = ids.slice(0, MAX_MOMENTS);
  const moments = [];
  try {
    for (let i = 0; i < take.length; i += ID_CHUNK) {
      moments.push(...(await readMomentData(address, take.slice(i, i + ID_CHUNK))));
    }
  } catch (err) {
    return json({ error: "Couldn't read that collection from Flow right now. Try again in a minute." }, 502);
  }

  const [inventoryRaw, snapshotRaw, playsRaw] = await Promise.all([
    kv.get("sets:inventory"),
    kv.get("editions:snapshot"),
    kv.get("plays:index"),
  ]);
  const inventory = inventoryRaw ? JSON.parse(inventoryRaw) : {};
  const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;
  const playsIndex = playsRaw ? JSON.parse(playsRaw) : {};

  // Plays neither index knows yet (new editions, or plays added to a set after
  // the last sweep): look them up on Flow, a few per read, and keep them in
  // plays:index for everyone after.
  const known = new Set((snapshot?.editions || []).map((e) => String(e.playID)));
  const missing = [...new Set(moments.map((m) => String(m.playID)).filter((pid) => !known.has(pid) && !playsIndex[pid]))];
  let lookups = 0;
  if (helpers.getPlayIdentity) {
    for (const pid of missing) {
      if (lookups >= PLAY_LOOKUP_BUDGET) break;
      lookups++;
      try {
        const p = await helpers.getPlayIdentity(Number(pid));
        if (p?.playerName) playsIndex[pid] = { playerName: p.playerName, team: p.team, nbaSeason: p.nbaSeason, isRookieYear: !!p.isRookieYear };
      } catch {}
    }
    if (lookups) await kv.put("plays:index", JSON.stringify(playsIndex));
  }
  // Sets newer than the last sweep: fetch the name so Moments still show one.
  const unknownSets = [...new Set(moments.map((m) => m.setID).filter((id) => !inventory[id] && !inventory[String(id)]))].slice(0, 5);
  for (const id of unknownSets) {
    try {
      const name = helpers.getSetName ? await helpers.getSetName(id) : null;
      if (name) inventory[id] = { name, tier: "Unknown" };
    } catch {}
  }
  const pendingPlays = Math.max(0, missing.length - lookups);

  const body = buildCollection({ address, username, moments, total, inventory, snapshot, playsIndex });
  body.pendingPlays = pendingPlays;
  await kv.put(cacheKey, JSON.stringify(body), { expirationTtl: pendingPlays ? PARTIAL_CACHE_TTL_S : COLL_CACHE_TTL_S });
  await kv.put(COLL_RL_PREFIX + address, String(Date.now()), { expirationTtl: 3600 });
  return json({ ...body, cached: false });
}

export const __collectionTestables__ = { buildCollection, readMomentIds, readMomentData, resolveTopShotUsername };
