// tome-topshot worker — patched 2026-09-24
// Change from the live version: the scheduled run no longer rebuilds the whole
// editions snapshot (which read every edition key on every run, ~7M KV reads/day).
// It now patches only the editions it touched into the stored snapshot.
// Full rebuilds remain on /admin/rebuild-snapshot and /admin/sweep-sets.
// 2026-10-20: + GET /api/topshot/eligible (Pro-night set eligibility, internal)
//             + POST /admin/sweep-sets-range (incremental set sweep)

import { normalizeName } from "../../shared/names.js";

var FLOW_REST = "https://rest-mainnet.onflow.org/v1";
var TOPSHOT_ADDR = "0x0b2a3299cc857e29";
var STOREFRONT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2";
var NFT_TYPE_MATCH = "TopShot";
var MAX_BLOCK_RANGE = 250;
var MAX_EVENTS_PER_RUN = 400;
var SALES_HISTORY_CAP = 20;
var FREE_TEASER_LIMIT = 10;
var EDITIONS_SNAPSHOT_KEY = "editions:snapshot";
var SNAPSHOT_READ_CONCURRENCY = 25;
var NAME_PATTERN_TIERS = [
  { pattern: /^(WNBA )?Base Set$/i, tier: "Common", source: `Top Shot blog: "The 'Base Set' is the standard Common Set every season"` },
  { pattern: /^(WNBA )?Metallic Gold LE\b/i, tier: "Rare", source: `Top Shot blog: "'Metallic Gold LE' is the standard Rare Set every season"` },
  { pattern: /^Throwdowns\d*$/i, tier: "Rare", source: 'Top Shot blog: grouped under "Rare Sets" alongside Metallic Gold LE' },
  { pattern: /^For [Tt]he Win$/i, tier: "Rare", source: 'Top Shot blog: grouped under "Rare Sets" alongside Metallic Gold LE' },
  { pattern: /^Denied!?$/i, tier: "Rare", source: 'Top Shot blog: grouped under "Rare Sets" alongside Metallic Gold LE' },
  { pattern: /^(WNBA )?Video Game Numbers$/i, tier: "Rare", source: 'Top Shot blog: grouped under "Rare Sets" alongside Metallic Gold LE' },
  { pattern: /^Fresh Threads$/i, tier: "Rare", source: 'Top Shot blog: grouped under "Rare Sets" alongside Metallic Gold LE' }
];
function classifyByNamePattern(name) {
  for (const { pattern, tier } of NAME_PATTERN_TIERS) {
    if (pattern.test(name)) return tier;
  }
  return null;
}
var ROOKIE_DEBUT_PATTERN = /^(WNBA )?Rookie (Debut|Revelation)$/i;
function isRookieDebutSet(setName) {
  return ROOKIE_DEBUT_PATTERN.test(setName || "");
}
var TIER_OVERRIDES = {
  1: "Founders",
  2: "Common",
  3: "Ultimate",
  4: "Legendary"
};
function classifyTier(counts) {
  if (!counts || counts.length === 0) return "Unknown";
  const freq = new Map();
  for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
  let typical = counts[0];
  let bestCount = -1;
  for (const [c, n] of freq) {
    if (n > bestCount || n === bestCount && c > typical) {
      typical = c;
      bestCount = n;
    }
  }
  if (typical <= 3) return "Ultimate";
  if (typical <= 125) return "Legendary";
  if (typical >= 500 && typical <= 2022) return "Rare";
  if (typical >= 4e3) return "Common";
  return "Fandom";
}
function base64ToUtf8(b64) {
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
async function flowScript(script, args) {
  const body = JSON.stringify({
    script: btoa(script),
    arguments: args.map((a) => btoa(JSON.stringify(a)))
  });
  const res = await fetch(`${FLOW_REST}/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Flow script non-JSON response: ${text.slice(0, 300)}`);
  }
  if (typeof parsed !== "string") {
    throw new Error(`Flow script error: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return JSON.parse(base64ToUtf8(parsed));
}
async function latestSealedHeight() {
  const res = await fetch(`${FLOW_REST}/blocks?height=sealed`);
  const blocks = await res.json();
  return parseInt(blocks[0].header.height, 10);
}
async function getEvents(eventType, startHeight, endHeight) {
  const res = await fetch(
    `${FLOW_REST}/events?type=${eventType}&start_height=${startHeight}&end_height=${endHeight}`
  );
  const blocks = await res.json();
  if (blocks.code) throw new Error(`Flow events error: ${JSON.stringify(blocks)}`);
  const events = [];
  for (const block of blocks) {
    for (const ev of block.events || []) {
      const payload = JSON.parse(atob(ev.payload));
      const fields = {};
      for (const f of payload.value.fields) fields[f.name] = f.value;
      events.push({ blockHeight: block.block_height, blockTimestamp: block.block_timestamp, fields });
    }
  }
  return events;
}
function fieldStr(fields, name) {
  const f = fields[name];
  if (!f) return null;
  return f.value != null ? f.value.toString() : null;
}
function isTopShotEvent(fields) {
  const t = fields.nftType?.value?.staticType?.typeID || "";
  return t.includes(NFT_TYPE_MATCH);
}
async function resolveMomentIdentity(ownerAddress, nftID) {
  const script = `
import TopShot from ${TOPSHOT_ADDR}
import MetadataViews from 0x1d7e57aa55817448
import ViewResolver from 0x1d7e57aa55817448

access(all) fun main(account: Address, id: UInt64): {String: String}? {
    let acct = getAccount(account)
    let collectionRef = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
    if collectionRef == nil { return nil }
    let token = collectionRef!.borrowMoment(id: id)
    if token == nil { return nil }
    let result: {String: String} = {
        "setID": token!.data.setID.toString(),
        "playID": token!.data.playID.toString(),
        "serialNumber": token!.data.serialNumber.toString()
    }
    let nft = token! as &{ViewResolver.Resolver}
    let displayView = nft.resolveView(Type<MetadataViews.Display>())
    if displayView != nil {
        let d = displayView! as! MetadataViews.Display
        result["imageURL"] = d.thumbnail.uri()
    }
    return result
}`;
  const result = await flowScript(script, [
    { type: "Address", value: ownerAddress },
    { type: "UInt64", value: String(nftID) }
  ]);
  if (!result.value) return null;
  const dictEntries = result.value.value;
  const out = {};
  for (const entry of dictEntries) out[entry.key.value] = entry.value.value;
  return {
    setID: parseInt(out.setID, 10),
    playID: parseInt(out.playID, 10),
    serialNumber: parseInt(out.serialNumber, 10),
    imageURL: out.imageURL || null
  };
}
async function getSetName(setID) {
  const script = `
import TopShot from ${TOPSHOT_ADDR}
access(all) fun main(setID: UInt32): String? {
    return TopShot.getSetName(setID: setID)
}`;
  const result = await flowScript(script, [{ type: "UInt32", value: String(setID) }]);
  return result.value ? result.value.value : null;
}
async function getSetCirculationStats(setID) {
  const script = `
import TopShot from ${TOPSHOT_ADDR}
access(all) fun main(setID: UInt32): TopShot.QuerySetData? {
    return TopShot.getSetData(setID: setID)
}`;
  const result = await flowScript(script, [{ type: "UInt32", value: String(setID) }]);
  if (!result.value) return null;
  const structValue = result.value.value;
  const fields = {};
  for (const f of structValue.fields) fields[f.name] = f.value;
  const nmpp = fields.numberMintedPerPlay?.value || [];
  const circulationByPlay = {};
  for (const entry of nmpp) circulationByPlay[entry.key.value] = parseInt(entry.value.value, 10);
  const counts = Object.values(circulationByPlay);
  if (counts.length === 0) return null;
  return {
    minCirc: Math.min(...counts),
    maxCirc: Math.max(...counts),
    playCount: counts.length,
    circulationByPlay
  };
}
var WNBA_TEAMS = new Set([
  "Aces", "Dream", "Fever", "Liberty", "Lynx", "Mercury", "Mystics",
  "Sky", "Sparks", "Storm", "Sun", "Valkyries", "Wings"
]);
function deriveLeague(setName, teamName) {
  if (setName && /^WNBA\b/i.test(setName.trim())) return "WNBA";
  if (!teamName) return null;
  const lastWord = teamName.trim().split(/\s+/).pop();
  return WNBA_TEAMS.has(lastWord) ? "WNBA" : "NBA";
}
async function getPlayIdentity(playID) {
  const script = `
import TopShot from ${TOPSHOT_ADDR}
access(all) fun main(playID: UInt32): {String: String} {
    let result: {String: String} = {}
    let fields = ["FullName", "TeamAtMoment", "PlayCategory", "PlayType", "DateOfMoment", "NbaSeason", "AwayTeamName", "HomeTeamName", "TotalYearsExperience", "JerseyNumber"]
    for field in fields {
        if let v = TopShot.getPlayMetaDataByField(playID: playID, field: field) {
            result[field] = v
        }
    }
    return result
}`;
  const result = await flowScript(script, [{ type: "UInt32", value: String(playID) }]);
  const out = {};
  for (const entry of result.value) out[entry.key.value] = entry.value.value;
  return {
    playerName: out.FullName || null,
    team: out.TeamAtMoment || null,
    playCategory: out.PlayCategory || out.PlayType || null,
    dateOfMoment: out.DateOfMoment || null,
    isRookieYear: out.TotalYearsExperience === "0",
    nbaSeason: out.NbaSeason || null,
    matchup: out.AwayTeamName && out.HomeTeamName ? `${out.AwayTeamName} @ ${out.HomeTeamName}` : null,
    jerseyNumber: /^\d+$/.test(out.JerseyNumber || "") ? parseInt(out.JerseyNumber, 10) : null
  };
}
function editionKey(setID, playID) {
  return `edition:${setID}_${playID}`;
}
async function loadEdition(kv, setID, playID, imageURL) {
  const raw = await kv.get(editionKey(setID, playID));
  if (raw) return JSON.parse(raw);
  const [setName, playIdentity] = await Promise.all([getSetName(setID), getPlayIdentity(playID)]);
  return {
    setID,
    playID,
    setName,
    imageURL: imageURL || null,
    ...playIdentity,
    league: deriveLeague(setName, playIdentity.team),
    activeListings: {},
    salesHistory: [],
    lowAsk: null,
    lastSale: null,
    lastSaleDate: null
  };
}
var LOW_ASK_HISTORY_CAP = 120;
async function saveEdition(kv, edition) {
  const prices = Object.values(edition.activeListings).map((l) => l.price);
  edition.lowAsk = prices.length ? Math.min(...prices) : null;
  edition.activeListingCount = prices.length;
  edition.lowAskSerial = null;
  edition.lowAskNftID = null;
  if (edition.lowAsk != null) {
    const cheapest = Object.entries(edition.activeListings).find(([, l]) => l.price === edition.lowAsk);
    edition.lowAskSerial = cheapest?.[1]?.serial ?? null;
    edition.lowAskNftID = cheapest?.[0] ?? null;
  }
  if (!edition.lowAskHistory) edition.lowAskHistory = [];
  const today = new Date().toISOString().slice(0, 10);
  const lastEntry = edition.lowAskHistory[edition.lowAskHistory.length - 1];
  if (edition.lowAsk != null && (!lastEntry || lastEntry.date !== today)) {
    edition.lowAskHistory.push({ date: today, lowAsk: edition.lowAsk });
    if (edition.lowAskHistory.length > LOW_ASK_HISTORY_CAP) {
      edition.lowAskHistory = edition.lowAskHistory.slice(-LOW_ASK_HISTORY_CAP);
    }
  } else if (edition.lowAsk != null && lastEntry && lastEntry.date === today) {
    lastEntry.lowAsk = edition.lowAsk;
  }
  let dealScore = null;
  if (edition.salesHistory.length) {
    const recent = edition.salesHistory.slice(-SALES_HISTORY_CAP);
    edition.salesHistory = recent;
    const salePrices = recent.map((s) => s.price);
    const sorted = [...salePrices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    edition.marketValue = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    edition.avgSalePrice = salePrices.reduce((sum, p) => sum + p, 0) / salePrices.length;
    edition.valueConfidence = salePrices.length >= 10 ? "High" : salePrices.length >= 3 ? "Some" : "Thin";
    if (edition.lowAsk != null && edition.marketValue) {
      edition.discountToMarket = (edition.marketValue - edition.lowAsk) / edition.marketValue;
    }
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1e3;
    const salesLast30d = recent.filter((s) => new Date(s.date).getTime() >= thirtyDaysAgo);
    edition.sales30d = salesLast30d.length;
    edition.volume30d = salesLast30d.reduce((sum, s) => sum + s.price, 0);
    edition.sales30dCapped = salesLast30d.length === SALES_HISTORY_CAP;
    if (edition.discountToMarket != null) {
      const confidenceMultiplier = edition.valueConfidence === "High" ? 1 : edition.valueConfidence === "Some" ? 0.7 : 0.4;
      const liquidityMultiplier = Math.min(1, 0.5 + edition.sales30d * 0.1);
      dealScore = edition.discountToMarket * 100 * confidenceMultiplier * liquidityMultiplier;
    }
  }
  let bumps = 0;
  const bumpReasons = [];
  if (edition.isSuperstar) { bumps += 20; bumpReasons.push("Superstar"); }
  if (edition.isRookieDebut) { bumps += 15; bumpReasons.push("Rookie Debut"); }
  if (edition.jerseyNumber != null && edition.lowAskSerial === edition.jerseyNumber) { bumps += 15; bumpReasons.push("Jersey Match"); }
  if (edition.lowAskSerial === 1) { bumps += 15; bumpReasons.push("#1 Serial"); }
  if (edition.circulation != null && edition.lowAskSerial === edition.circulation) { bumps += 10; bumpReasons.push("Perfect Serial"); }
  if (edition.isRookieYear) { bumps += 5; bumpReasons.push("Rookie Year"); }
  edition.tomeScoreBumps = bumpReasons;
  edition.tomeScore = dealScore != null || bumps > 0 ? Math.round((dealScore || 0) + bumps) : null;
  await kv.put(editionKey(edition.setID, edition.playID), JSON.stringify(edition));
}
async function runIndexPass(env) {
  const kv = env.TOPSHOT_KV;
  const latest = await latestSealedHeight();
  const checkpointRaw = await kv.get("checkpoint:events");
  let start = checkpointRaw ? parseInt(checkpointRaw, 10) + 1 : latest - 50;
  if (start > latest) return { skipped: true, reason: "no new blocks", touched: [] };
  let end = Math.min(start + MAX_BLOCK_RANGE - 1, latest);
  const [available, completed] = await Promise.all([
    getEvents(`${STOREFRONT_TYPE}.ListingAvailable`, start, end),
    getEvents(`${STOREFRONT_TYPE}.ListingCompleted`, start, end)
  ]);
  let processed = 0;
  const identityCache = {};
  const editionCache = {};
  async function getIdentity(nftID, ownerAddress) {
    if (identityCache[nftID]) return identityCache[nftID];
    const kvHit = await kv.get(`moment:${nftID}`);
    if (kvHit) {
      identityCache[nftID] = JSON.parse(kvHit);
      return identityCache[nftID];
    }
    const resolved = await resolveMomentIdentity(ownerAddress, nftID);
    if (resolved) {
      await kv.put(`moment:${nftID}`, JSON.stringify(resolved));
      identityCache[nftID] = resolved;
    }
    return resolved;
  }
  async function getEditionCached(setID, playID, imageURL) {
    const key = `${setID}_${playID}`;
    if (!editionCache[key]) editionCache[key] = await loadEdition(kv, setID, playID, imageURL);
    return editionCache[key];
  }
  for (const ev of available) {
    if (processed >= MAX_EVENTS_PER_RUN) break;
    if (!isTopShotEvent(ev.fields)) continue;
    const nftID = fieldStr(ev.fields, "nftID");
    const sellerAddress = fieldStr(ev.fields, "storefrontAddress");
    const price = parseFloat(fieldStr(ev.fields, "salePrice"));
    if (!nftID || price == null || isNaN(price)) continue;
    const identity = await getIdentity(nftID, sellerAddress);
    if (!identity) continue;
    const edition = await getEditionCached(identity.setID, identity.playID, identity.imageURL);
    edition.activeListings[nftID] = { price, sellerAddress, blockTimestamp: ev.blockTimestamp, serial: identity.serialNumber };
    processed++;
  }
  for (const ev of completed) {
    if (processed >= MAX_EVENTS_PER_RUN) break;
    if (!isTopShotEvent(ev.fields)) continue;
    const purchasedField = ev.fields.purchased;
    const purchased = purchasedField?.value === true || purchasedField?.value === "true";
    const nftID = fieldStr(ev.fields, "nftID");
    if (!nftID) continue;
    const kvHit = await kv.get(`moment:${nftID}`);
    const identity = kvHit ? JSON.parse(kvHit) : identityCache[nftID];
    if (!identity) continue;
    const edition = await getEditionCached(identity.setID, identity.playID);
    delete edition.activeListings[nftID];
    if (purchased) {
      const price = parseFloat(fieldStr(ev.fields, "salePrice"));
      if (price != null && !isNaN(price)) {
        edition.salesHistory.push({ price, date: ev.blockTimestamp, nftID, serial: identity.serialNumber });
        edition.lastSale = price;
        edition.lastSaleDate = ev.blockTimestamp;
      }
    }
    processed++;
  }
  const inventoryRaw = await kv.get("sets:inventory");
  const inventory = inventoryRaw ? JSON.parse(inventoryRaw) : {};
  const playerIndexRaw = await kv.get("players:index");
  const playerIndex = playerIndexRaw ? JSON.parse(playerIndexRaw) : {};
  for (const e of Object.values(editionCache)) {
    e.circulation = inventory[e.setID]?.circulationByPlay?.[String(e.playID)] ?? null;
    e.isSuperstar = playerIndex[e.playerName]?.isSuperstar ?? false;
    e.isRookieDebut = isRookieDebutSet(e.setName);
  }
  await Promise.all(Object.values(editionCache).map((e) => saveEdition(kv, e)));
  await kv.put("checkpoint:events", String(end));
  return {
    fromHeight: start,
    toHeight: end,
    latest,
    eventsAvailable: available.length,
    eventsCompleted: completed.length,
    processed,
    editionsTouched: Object.keys(editionCache).length,
    touched: Object.values(editionCache)
  };
}
var SUPERSTAR_MIN_COMMONS = 2;
var SUPERSTAR_PERCENTILE = 0.9;
async function buildPlayerIndex(env) {
  const kv = env.TOPSHOT_KV;
  const editions = await loadAllEditions(kv);
  const inventoryRaw = await kv.get("sets:inventory");
  const inventory = inventoryRaw ? JSON.parse(inventoryRaw) : {};
  const byPlayer = {};
  for (const e of editions) {
    const tier = inventory[e.setID]?.tier;
    if (tier !== "Common" || !e.playerName) continue;
    const value = e.marketValue ?? e.lowAsk;
    if (value == null) continue;
    if (!byPlayer[e.playerName]) byPlayer[e.playerName] = [];
    byPlayer[e.playerName].push(value);
  }
  const playerMedians = [];
  for (const [playerName, values] of Object.entries(byPlayer)) {
    if (values.length < SUPERSTAR_MIN_COMMONS) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    playerMedians.push({ playerName, median, sampleSize: values.length });
  }
  playerMedians.sort((a, b) => a.median - b.median);
  const thresholdIndex = Math.floor(playerMedians.length * SUPERSTAR_PERCENTILE);
  const thresholdValue = playerMedians[thresholdIndex]?.median ?? Infinity;
  const playerIndex = {};
  for (const p of playerMedians) {
    playerIndex[p.playerName] = {
      commonMedianValue: p.median,
      sampleSize: p.sampleSize,
      isSuperstar: p.median >= thresholdValue
    };
  }
  await kv.put("players:index", JSON.stringify(playerIndex));
  return {
    playersRanked: playerMedians.length,
    superstarCount: Object.values(playerIndex).filter((p) => p.isSuperstar).length,
    thresholdValue
  };
}
async function runSetSweep(env, maxSetID) {
  const kv = env.TOPSHOT_KV;
  const inventory = {};
  for (let setID = 1; setID <= maxSetID; setID++) {
    const name = await getSetName(setID);
    if (!name) continue;
    const stats = await getSetCirculationStats(setID);
    const tier = TIER_OVERRIDES[setID] || classifyByNamePattern(name) || (stats ? classifyTier(Object.values(stats.circulationByPlay)) : "Unknown");
    inventory[setID] = { name, tier, ...stats };
  }
  await kv.put("sets:inventory", JSON.stringify(inventory));
  return { setsFound: Object.keys(inventory).length };
}
async function checkEdgeAccess(request, env) {
  const sharedKeys = (env.TOME_SUBSCRIBER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  const providedKey = request.headers.get("X-Tome-Key") || new URL(request.url).searchParams.get("key");
  if (providedKey && sharedKeys.includes(providedKey)) return true;
  const sid = request.headers.get("X-Tome-Sub") || new URL(request.url).searchParams.get("sid");
  if (!sid || !env.AUTH) return false;
  try {
    const res = await env.AUTH.fetch(
      `https://internal/auth/subscription?sid=${encodeURIComponent(sid)}&need=edge`,
      { headers: { "X-Internal-Token": env.TOME_INTERNAL_TOKEN } }
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.authorized === true;
  } catch {
    return false;
  }
}
function checkAdminAuth(request, env) {
  if (!env.TOME_ADMIN_TOKEN) return false;
  const token = request.headers.get("X-Admin-Token") || new URL(request.url).searchParams.get("adminToken");
  return !!token && token === env.TOME_ADMIN_TOKEN;
}
async function listAllKeys(kv, prefix) {
  let keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    keys = keys.concat(page.keys);
    cursor = page.list_complete ? void 0 : page.cursor;
  } while (cursor);
  return keys;
}
async function loadAllEditions(kv) {
  const keys = await listAllKeys(kv, "edition:");
  const editions = [];
  for (let i = 0; i < keys.length; i += SNAPSHOT_READ_CONCURRENCY) {
    const batch = keys.slice(i, i + SNAPSHOT_READ_CONCURRENCY);
    const raws = await Promise.all(batch.map((key) => kv.get(key.name)));
    for (const raw of raws) {
      if (raw) editions.push(JSON.parse(raw));
    }
  }
  return editions;
}
// NEW: patch only the touched editions into the stored snapshot (a few KV reads per run).
async function updateEditionsSnapshot(env, touched) {
  const kv = env.TOPSHOT_KV;
  if (!touched || !touched.length) return { skipped: true, reason: "no editions touched" };
  const [raw, inventoryRaw] = await Promise.all([
    kv.get(EDITIONS_SNAPSHOT_KEY),
    kv.get("sets:inventory")
  ]);
  const snapshot = raw ? JSON.parse(raw) : { editions: [] };
  const inventory = inventoryRaw ? JSON.parse(inventoryRaw) : {};
  const byKey = new Map(snapshot.editions.map((e) => [e.setID + "_" + e.playID, e]));
  for (const e of touched) {
    byKey.set(e.setID + "_" + e.playID, {
      ...e,
      tier: inventory[e.setID]?.tier || "Unknown",
      circulation: inventory[e.setID]?.circulationByPlay?.[String(e.playID)] ?? null
    });
  }
  snapshot.editions = [...byKey.values()];
  snapshot.builtAt = new Date().toISOString();
  await kv.put(EDITIONS_SNAPSHOT_KEY, JSON.stringify(snapshot));
  return { editionsSnapshotted: snapshot.editions.length, patched: touched.length };
}
// Full rebuild: admin routes only.
async function rebuildEditionsSnapshot(env) {
  const kv = env.TOPSHOT_KV;
  const editions = await loadAllEditions(kv);
  const inventoryRaw = await kv.get("sets:inventory");
  const inventory = inventoryRaw ? JSON.parse(inventoryRaw) : {};
  for (const e of editions) {
    e.tier = inventory[e.setID]?.tier || "Unknown";
    e.circulation = inventory[e.setID]?.circulationByPlay?.[String(e.playID)] ?? null;
  }
  await kv.put(EDITIONS_SNAPSHOT_KEY, JSON.stringify({ builtAt: new Date().toISOString(), editions }));
  return { editionsSnapshotted: editions.length };
}
// ---- Pro-night set eligibility (internal) ------------------------------------
// GET /api/topshot/eligible?sets=A,B&season=2026-27[&league=NBA]
// GET /api/topshot/eligible?badge=rookie_debut|rookie_year&season=2026-27[&league=NBA]
// Internal only: X-Tome-Internal must equal TOME_INTERNAL_TOKEN.
//
// Coverage: the editions snapshot only knows editions that have been LISTED
// since the indexer started, so it can't answer "does a Moment exist". The set
// sweep (sets:inventory) knows every playID minted into every set, straight
// from Flow. So: set name -> setIDs (inventory) -> playIDs -> play identity.
// Identities come from the editions snapshot when present, then a permanent
// play:<playID> cache, then Flow (getPlayIdentity), at most
// ELIG_PLAY_BUDGET Flow calls per request. Until every candidate play is
// resolved the answer is complete:false (not cached) and the caller treats the
// night as unverified; repeated calls finish the job.
var ELIG_CACHE_PREFIX = "elig:";
var ELIG_CACHE_TTL_S = 6 * 60 * 60;
var ELIG_PLAY_BUDGET = 40; // Flow script calls per request (stays under the Free plan's 50 subrequests)
var PLAY_CACHE_PREFIX = "play:";
var RESOLVABLE_BADGES = new Set(["rookie_debut", "rookie_year"]);

function eligJson(body, status = 200) {
  return Response.json(body, { status });
}

function parseEligibleQuery(url) {
  const sets = (url.searchParams.get("sets") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const season = (url.searchParams.get("season") || "").trim() || null;
  const badge = (url.searchParams.get("badge") || "").trim().toLowerCase() || null;
  const leagueRaw = (url.searchParams.get("league") || "").trim().toUpperCase();
  const league = leagueRaw === "NBA" || leagueRaw === "WNBA" ? leagueRaw : null;
  return { sets, season, badge, league };
}

function eligCacheKey(q) {
  const sets = q.sets.map((s) => s.toLowerCase()).sort().join("|");
  return `${ELIG_CACHE_PREFIX}${sets}#${q.season || ""}#${q.badge || ""}#${q.league || ""}`;
}

async function handleEligible(request, env, url) {
  const token = request.headers.get("X-Tome-Internal");
  if (!env.TOME_INTERNAL_TOKEN || !token || token !== env.TOME_INTERNAL_TOKEN) {
    return eligJson({ error: "unauthorized" }, 401);
  }
  const q = parseEligibleQuery(url);
  if (!q.sets.length && !q.badge) return eligJson({ error: "pass sets= or badge=" }, 400);
  if (q.badge && !RESOLVABLE_BADGES.has(q.badge)) {
    // Challenge / Leaderboard / Crafting reward badges aren't in the index.
    return eligJson({ resolvable: false, badge: q.badge, reason: "badge is not resolvable from the Top Shot index" });
  }
  if (q.badge === "rookie_year" && !q.season) {
    return eligJson({ error: "badge=rookie_year needs season=" }, 400);
  }

  const kv = env.TOPSHOT_KV;
  const cacheKey = eligCacheKey(q);
  const cached = await kv.get(cacheKey);
  if (cached && url.searchParams.get("fresh") !== "1") return new Response(cached, { headers: { "Content-Type": "application/json" } });

  const inventoryRaw = await kv.get("sets:inventory");
  const inventory = inventoryRaw ? JSON.parse(inventoryRaw) : {};
  const snapshotRaw = await kv.get(EDITIONS_SNAPSHOT_KEY);
  const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;

  // Known play identities from the editions snapshot (keyed by playID).
  const known = new Map();
  for (const e of snapshot?.editions || []) {
    if (e.playID != null && e.playerName && !known.has(String(e.playID))) {
      known.set(String(e.playID), { playerName: e.playerName, team: e.team || null, nbaSeason: e.nbaSeason || null, isRookieYear: !!e.isRookieYear });
    }
  }

  // Candidate sets.
  const wanted = new Set(q.sets.map((s) => s.toLowerCase()));
  const candidateSets = [];
  const matchedNames = new Set();
  for (const [setID, s] of Object.entries(inventory)) {
    const name = String(s.name || "").trim();
    let take = false;
    if (q.sets.length && wanted.has(name.toLowerCase())) take = true;
    if (q.badge === "rookie_debut" && isRookieDebutSet(name)) take = true;
    if (q.badge === "rookie_year") {
      // Sets that contain at least one known play from the requested season.
      take = Object.keys(s.circulationByPlay || {}).some((pid) => known.get(pid)?.nbaSeason === q.season);
    }
    if (q.league && take && deriveLeague(name, null) === "WNBA" && q.league === "NBA") take = false;
    if (take) {
      candidateSets.push({ setID: Number(setID), name, playIDs: Object.keys(s.circulationByPlay || {}) });
      matchedNames.add(name.toLowerCase());
    }
  }
  const unknownSets = q.sets.filter((s) => !matchedNames.has(s.toLowerCase()));

  // Resolve every candidate play's identity (snapshot -> play: cache -> Flow).
  let flowCalls = 0;
  let pending = 0;
  const identities = new Map();
  for (const cs of candidateSets) {
    for (const pid of cs.playIDs) {
      if (identities.has(pid)) continue;
      let id = known.get(pid) || null;
      if (!id) {
        const raw = await kv.get(PLAY_CACHE_PREFIX + pid);
        if (raw) id = JSON.parse(raw);
      }
      if (!id && flowCalls < ELIG_PLAY_BUDGET) {
        try {
          flowCalls++;
          const p = await getPlayIdentity(Number(pid));
          id = { playerName: p.playerName, team: p.team, nbaSeason: p.nbaSeason, isRookieYear: !!p.isRookieYear };
          await kv.put(PLAY_CACHE_PREFIX + pid, JSON.stringify(id));
        } catch (err) {
          id = null;
        }
      }
      if (id) identities.set(pid, id);
      else pending++;
    }
  }

  // Join.
  const byName = new Map();
  for (const cs of candidateSets) {
    for (const pid of cs.playIDs) {
      const id = identities.get(pid);
      if (!id || !id.playerName) continue;
      if (q.season && id.nbaSeason !== q.season) continue;
      if (q.badge === "rookie_year" && !id.isRookieYear) continue;
      if (q.league && deriveLeague(cs.name, id.team) !== q.league) continue;
      const key = normalizeName(id.playerName);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, { name: id.playerName, team: id.team || null, sets: [] });
      const rec = byName.get(key);
      if (!rec.sets.includes(cs.name)) rec.sets.push(cs.name);
    }
  }
  const players = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const complete = pending === 0;
  // Players found per requested set name (after season/league filters), so a
  // caller can tell "set exists but has no Moments for this season yet".
  const setCounts = {};
  for (const name of q.sets) setCounts[name] = 0;
  for (const rec of players) {
    for (const sn of rec.sets) {
      const req = q.sets.find((n) => n.toLowerCase() === sn.toLowerCase());
      if (req) setCounts[req]++;
    }
  }
  const body = {
    resolvable: true,
    complete,
    pending,
    sets: q.sets,
    badge: q.badge,
    season: q.season,
    league: q.league,
    matchedSets: candidateSets.map((c) => ({ setID: c.setID, name: c.name, plays: c.playIDs.length })),
    unknownSets,
    setCounts,
    players,
    count: players.length,
    indexedAt: snapshot?.builtAt || null,
    inventorySets: Object.keys(inventory).length,
    generatedAt: new Date().toISOString(),
  };
  const text = JSON.stringify(body);
  if (complete) await kv.put(cacheKey, text, { expirationTtl: ELIG_CACHE_TTL_S });
  return new Response(text, { headers: { "Content-Type": "application/json" } });
}

// Incremental set sweep: adds/refreshes setIDs [from, to] in sets:inventory
// without re-reading every older set (new seasons' sets land at the top).
// POST /admin/sweep-sets-range?from=280&to=320   (X-Admin-Token)
async function runSetSweepRange(env, fromID, toID) {
  const kv = env.TOPSHOT_KV;
  const raw = await kv.get("sets:inventory");
  const inventory = raw ? JSON.parse(raw) : {};
  let added = 0;
  let calls = 0;
  for (let setID = fromID; setID <= toID && calls < 44; setID++) {
    calls++;
    const name = await getSetName(setID);
    if (!name) continue;
    calls++;
    const stats = await getSetCirculationStats(setID);
    const tier = TIER_OVERRIDES[setID] || classifyByNamePattern(name) || (stats ? classifyTier(Object.values(stats.circulationByPlay)) : "Unknown");
    inventory[setID] = { name, tier, ...stats };
    added++;
  }
  await kv.put("sets:inventory", JSON.stringify(inventory));
  return { from: fromID, to: toID, setsAdded: added, flowCalls: calls, inventorySets: Object.keys(inventory).length, stoppedEarly: calls >= 44 };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Tome-Key, X-Tome-Sub, X-Admin-Token");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await runIndexPass(env);
      await updateEditionsSnapshot(env, result.touched);
    })());
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    const response = await handleRequest(request, env);
    return withCors(response);
  }
};
async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    const checkpoint = await env.TOPSHOT_KV.get("checkpoint:events");
    const snapshotRaw = await env.TOPSHOT_KV.get(EDITIONS_SNAPSHOT_KEY);
    const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;
    return Response.json({
      ok: true,
      checkpoint,
      snapshotEditions: snapshot?.editions?.length ?? null,
      snapshotBuiltAt: snapshot?.builtAt ?? null
    });
  }
  if (url.pathname === "/admin/run-index" && request.method === "POST") {
    if (!checkAdminAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const result = await runIndexPass(env);
    const snap = await updateEditionsSnapshot(env, result.touched);
    delete result.touched;
    return Response.json({ ...result, snapshot: snap });
  }
  if (url.pathname === "/api/topshot/eligible" && request.method === "GET") {
    return handleEligible(request, env, url);
  }
  if (url.pathname === "/admin/sweep-sets-range" && request.method === "POST") {
    if (!checkAdminAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const fromID = parseInt(url.searchParams.get("from") || "0", 10);
    const toID = parseInt(url.searchParams.get("to") || "0", 10);
    if (!fromID || !toID || toID < fromID) return Response.json({ error: "pass from= and to= setIDs" }, { status: 400 });
    const result = await runSetSweepRange(env, fromID, toID);
    return Response.json(result);
  }
  if (url.pathname === "/admin/sweep-sets" && request.method === "POST") {
    if (!checkAdminAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const maxSetID = parseInt(url.searchParams.get("maxSetID") || "400", 10);
    const result = await runSetSweep(env, maxSetID);
    await rebuildEditionsSnapshot(env);
    return Response.json(result);
  }
  if (url.pathname === "/admin/build-player-index" && request.method === "POST") {
    if (!checkAdminAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const result = await buildPlayerIndex(env);
    return Response.json(result);
  }
  if (url.pathname === "/admin/reset-editions" && request.method === "POST") {
    if (!checkAdminAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const kv = env.TOPSHOT_KV;
    const [editionKeys, momentKeys] = await Promise.all([
      listAllKeys(kv, "edition:"),
      listAllKeys(kv, "moment:")
    ]);
    await Promise.all([...editionKeys, ...momentKeys].map((k) => kv.delete(k.name)));
    await kv.delete(EDITIONS_SNAPSHOT_KEY);
    return Response.json({ editionsCleared: editionKeys.length, momentsCleared: momentKeys.length });
  }
  if (url.pathname === "/admin/rebuild-snapshot" && request.method === "POST") {
    if (!checkAdminAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const result = await rebuildEditionsSnapshot(env);
    return Response.json(result);
  }
  if (url.pathname === "/api/topshot/sets") {
    const raw = await env.TOPSHOT_KV.get("sets:inventory");
    const inventory = raw ? JSON.parse(raw) : {};
    const tierFilter = url.searchParams.get("tier");
    let sets = Object.entries(inventory).map(([setID, data]) => ({ setID: parseInt(setID, 10), ...data }));
    if (tierFilter) sets = sets.filter((s) => s.tier?.toLowerCase() === tierFilter.toLowerCase());
    return Response.json({ count: sets.length, sets });
  }
  if (url.pathname === "/api/topshot/editions") {
    const hasEdgeAccess = await checkEdgeAccess(request, env);
    const snapshotRaw = await env.TOPSHOT_KV.get(EDITIONS_SNAPSHOT_KEY);
    const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;
    let editions = snapshot?.editions || [];
    const seasonFilter = url.searchParams.get("season");
    const tierFilter = url.searchParams.get("tier");
    const leagueFilter = url.searchParams.get("league");
    const minPrice = url.searchParams.get("minPrice");
    const maxPrice = url.searchParams.get("maxPrice");
    const setFilter = url.searchParams.get("set");
    if (seasonFilter) editions = editions.filter((e) => e.nbaSeason === seasonFilter);
    if (tierFilter) {
      const tiers = tierFilter.split(",").map((t) => t.trim().toLowerCase());
      editions = editions.filter((e) => tiers.includes((e.tier || "").toLowerCase()));
    }
    if (leagueFilter) editions = editions.filter((e) => e.league?.toLowerCase() === leagueFilter.toLowerCase());
    if (minPrice) {
      const min = parseFloat(minPrice);
      editions = editions.filter((e) => e.lowAsk == null || e.lowAsk >= min);
    }
    if (maxPrice) {
      const max = parseFloat(maxPrice);
      editions = editions.filter((e) => e.lowAsk == null || e.lowAsk <= max);
    }
    if (setFilter) {
      const needle = setFilter.trim().toLowerCase();
      editions = editions.filter((e) => (e.setName || "").toLowerCase().includes(needle));
    }
    const sortBy = url.searchParams.get("sort") || "lowAsk";
    if (sortBy === "discount") {
      editions = editions.filter((e) => e.discountToMarket != null).sort((a, b) => b.discountToMarket - a.discountToMarket);
    } else if (sortBy === "tomeScore") {
      editions = editions.filter((e) => e.tomeScore != null).sort((a, b) => b.tomeScore - a.tomeScore);
    } else {
      editions.sort((a, b) => (b.lowAsk || 0) - (a.lowAsk || 0));
    }
    if (!hasEdgeAccess) {
      const teaser = editions.slice(0, FREE_TEASER_LIMIT).map((e) => ({
        setName: e.setName,
        playerName: e.playerName,
        team: e.team,
        league: e.league,
        nbaSeason: e.nbaSeason,
        tier: e.tier,
        circulation: e.circulation,
        isRookieYear: e.isRookieYear,
        imageURL: e.imageURL,
        lowAsk: e.lowAsk
      }));
      return Response.json({ locked: true, count: teaser.length, editions: teaser });
    }
    return Response.json({ locked: false, count: editions.length, editions });
  }
  return new Response("tome-topshot indexer", { status: 200 });
}
