// tome-topshot Worker
// Indexes NBA Top Shot low ask / last sale / circulation / discount-to-market
// directly from the Flow blockchain (no third-party API dependency).

const FLOW_REST = "https://rest-mainnet.onflow.org/v1";
const TOPSHOT_ADDR = "0x0b2a3299cc857e29";
const STOREFRONT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2";
const NFT_TYPE_MATCH = "TopShot"; // filters out Disney Pinnacle / MFLPack / anything else on the same storefront standard
const MAX_BLOCK_RANGE = 250; // Flow Access API hard limit per request
const MAX_EVENTS_PER_RUN = 400; // safety cap so a single cron tick can't run long
const SALES_HISTORY_CAP = 20; // trailing sales kept per edition for the discount-to-market baseline
const FREE_TEASER_LIMIT = 10; // ungated response shows this many editions, no history

// ---- Tier classification -------------------------------------------------
// Confirmed from Top Shot's own developer docs: tier is a Set-level property.
// Bands below are Top Shot's official published edition-size ranges, validated
// against real on-chain data (see build notes). Sets that don't cleanly fit
// (pre-tier-system Series 1 anomalies) are hard-overridden here rather than
// mis-bucketed by the generic rule.
// Name-pattern classification for flagship recurring set templates, sourced
// from NBA Top Shot's own blog rather than inferred from circulation bands
// (which drift too much across eras to trust alone - see build notes).
// Checked BEFORE numeric banding, since these confirmed patterns are more
// reliable than a threshold guess. Note: Top Shot's own copy states rarity
// is a 4-tier system (Common/Fandom/Rare/Legendary) - "Ultimate" (below) is
// a historical, auction-only designation outside that ongoing system, not a
// live 5th tier collectors see today.
const NAME_PATTERN_TIERS = [
  { pattern: /^(WNBA )?Base Set$/i, tier: "Common", source: "Top Shot blog: \"The 'Base Set' is the standard Common Set every season\"" },
  { pattern: /^(WNBA )?Metallic Gold LE\b/i, tier: "Rare", source: "Top Shot blog: \"'Metallic Gold LE' is the standard Rare Set every season\"" },
  { pattern: /^Throwdowns\d*$/i, tier: "Rare", source: "Top Shot blog: grouped under \"Rare Sets\" alongside Metallic Gold LE" },
  { pattern: /^For [Tt]he Win$/i, tier: "Rare", source: "Top Shot blog: grouped under \"Rare Sets\" alongside Metallic Gold LE" },
  { pattern: /^Denied!?$/i, tier: "Rare", source: "Top Shot blog: grouped under \"Rare Sets\" alongside Metallic Gold LE" },
  { pattern: /^(WNBA )?Video Game Numbers$/i, tier: "Rare", source: "Top Shot blog: grouped under \"Rare Sets\" alongside Metallic Gold LE" },
  { pattern: /^Fresh Threads$/i, tier: "Rare", source: "Top Shot blog: grouped under \"Rare Sets\" alongside Metallic Gold LE" },
];

function classifyByNamePattern(name) {
  for (const { pattern, tier } of NAME_PATTERN_TIERS) {
    if (pattern.test(name)) return tier;
  }
  return null;
}

const TIER_OVERRIDES = {
  1: "Founders", // Genesis - 1-of-1-per-play, predates the tier system entirely
  2: "Common", // Base Set (Series 1) - confirmed via live nbatopshot.com marketplace listing ("Common" label);
              // circulation (1000-3999) undercuts the current official Common floor of 10,000+, Series 1-era
              // commons ran smaller than later eras
  3: "Ultimate", // Platinum Ice - confirmed via Dapper Labs' own blog (edition size of 3, "Ultimate Tier");
                // NOTE: 7,962 Platinum Ice moments were burned in 2023 per that same post - the circulation
                // number here is the historical gross mint count, NOT current net circulating supply.
                // Burn tracking isn't built yet (see README) - this tier label is solid, the raw count may not be.
  4: "Legendary", // Holo MMXX - circulation (25-50) undercuts the official Legendary floor
};

function classifyTier(minCirc, maxCirc) {
  if (maxCirc <= 3) return "Ultimate";
  if (maxCirc <= 125) return "Legendary";
  if (minCirc >= 500 && maxCirc <= 2022) return "Rare";
  if (minCirc >= 4000) return "Common";
  return "Fandom"; // doesn't fit a clean numeric band - promotional/event sets land here
}

// ---- Flow Access API helpers ----------------------------------------------

// atob() only decodes base64 into a Latin-1 "binary string" (one char per
// byte, 0-255) - it does NOT understand UTF-8. Flow's JSON-Cadence responses
// contain real UTF-8 (accented player names like Nurkic, Doncic, Jokic are
// common on NBA/WNBA rosters), so decoding with plain atob() silently
// mangles them into mojibake. This decodes the base64 into raw bytes first,
// then properly UTF-8-decodes those bytes into text.
function base64ToUtf8(b64) {
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

async function flowScript(script, args) {
  const body = JSON.stringify({
    script: btoa(script),
    arguments: args.map((a) => btoa(JSON.stringify(a))),
  });
  const res = await fetch(`${FLOW_REST}/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
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

// Resolve a moment's setID/playID/serialNumber by borrowing it from its
// current owner's public collection. Only needed once per nftID ever -
// results are cached permanently in KV.
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
    { type: "UInt64", value: String(nftID) },
  ]);
  if (!result.value) return null; // already moved on (sold/transferred) - skip, will resolve next time it surfaces
  // Optional<Dictionary> -> {type:"Optional", value: null | {type:"Dictionary", value:[{key,value},...]}}
  const dictEntries = result.value.value;
  const out = {};
  for (const entry of dictEntries) out[entry.key.value] = entry.value.value;
  return {
    setID: parseInt(out.setID, 10),
    playID: parseInt(out.playID, 10),
    serialNumber: parseInt(out.serialNumber, 10),
    imageURL: out.imageURL || null,
  };
}

async function getSetName(setID) {
  const script = `
import TopShot from ${TOPSHOT_ADDR}
access(all) fun main(setID: UInt32): String? {
    return TopShot.getSetName(setID: setID)
}`;
  const result = await flowScript(script, [{ type: "UInt32", value: String(setID) }]);
  // Optional<String> -> {type:"Optional", value: null | {type:"String", value:"Genesis"}}
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
  // Optional<Struct> -> {type:"Optional", value: null | {type:"Struct", value:{id, fields:[...]}}}
  const structValue = result.value.value;
  const fields = {};
  for (const f of structValue.fields) fields[f.name] = f.value;
  const nmpp = fields.numberMintedPerPlay?.value || [];
  // per-play breakdown, keyed by playID as a string (JSON object keys are always strings) -
  // this is what lets an individual edition show its own exact circulation, not just the
  // set-wide min/max used for tier classification
  const circulationByPlay = {};
  for (const entry of nmpp) circulationByPlay[entry.key.value] = parseInt(entry.value.value, 10);
  const counts = Object.values(circulationByPlay);
  if (counts.length === 0) return null;
  return {
    minCirc: Math.min(...counts),
    maxCirc: Math.max(...counts),
    playCount: counts.length,
    circulationByPlay,
  };
}

// Play-level identity: player name, team, category, game date, NBA season.
// This is the same for every copy of an edition, so it's fetched once per
// playID (not per moment) and cached permanently.
// 2026 WNBA franchise names - used to tag league since there's no raw
// on-chain "league" field; team name is the only reliable signal.
const WNBA_TEAMS = new Set([
  "Aces", "Dream", "Fever", "Liberty", "Lynx", "Mercury", "Mystics",
  "Sky", "Sparks", "Storm", "Sun", "Valkyries", "Wings",
]);

function deriveLeague(teamName) {
  if (!teamName) return null;
  const lastWord = teamName.trim().split(/\s+/).pop();
  return WNBA_TEAMS.has(lastWord) ? "WNBA" : "NBA";
}

async function getPlayIdentity(playID) {
  const script = `
import TopShot from ${TOPSHOT_ADDR}
access(all) fun main(playID: UInt32): {String: String} {
    let result: {String: String} = {}
    let fields = ["FullName", "TeamAtMoment", "PlayCategory", "PlayType", "DateOfMoment", "NbaSeason", "AwayTeamName", "HomeTeamName", "TotalYearsExperience"]
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
    league: deriveLeague(out.TeamAtMoment),
    playCategory: out.PlayCategory || out.PlayType || null,
    dateOfMoment: out.DateOfMoment || null,
    // "0" total years experience at the time of this play means this
    // specific highlight happened during the player's rookie season -
    // there's no raw "Rookie Year" flag on-chain, this is the real proxy.
    isRookieYear: out.TotalYearsExperience === "0",
    nbaSeason: out.NbaSeason || null, // e.g. "2025-26" - this is the season filter dimension
    matchup: out.AwayTeamName && out.HomeTeamName ? `${out.AwayTeamName} @ ${out.HomeTeamName}` : null,
  };
}

// ---- KV-backed edition record ---------------------------------------------

function editionKey(setID, playID) {
  return `edition:${setID}_${playID}`;
}

async function loadEdition(kv, setID, playID, imageURL) {
  const raw = await kv.get(editionKey(setID, playID));
  if (raw) return JSON.parse(raw);
  // brand-new edition - pull its identity once now, permanently cached from here on
  const [setName, playIdentity] = await Promise.all([getSetName(setID), getPlayIdentity(playID)]);
  return {
    setID,
    playID,
    setName,
    imageURL: imageURL || null,
    ...playIdentity,
    activeListings: {},
    salesHistory: [],
    lowAsk: null,
    lastSale: null,
    lastSaleDate: null,
  };
}

const LOW_ASK_HISTORY_CAP = 120; // ~4 months of daily snapshots

async function saveEdition(kv, edition) {
  const prices = Object.values(edition.activeListings).map((l) => l.price);
  edition.lowAsk = prices.length ? Math.min(...prices) : null;
  edition.activeListingCount = prices.length;

  // Daily low-ask snapshot - opportunistic: only recorded when this edition
  // is actually touched by an event (a new listing or sale), not on a fixed
  // schedule for every tracked edition. This means low-liquidity editions
  // will have gaps on days with zero activity - that's a real, honest
  // limitation, not continuous tracking. Also: this can only track forward
  // from whenever this code first ran - there is no way to backfill what
  // low ask was before that.
  if (!edition.lowAskHistory) edition.lowAskHistory = [];
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastEntry = edition.lowAskHistory[edition.lowAskHistory.length - 1];
  if (edition.lowAsk != null && (!lastEntry || lastEntry.date !== today)) {
    edition.lowAskHistory.push({ date: today, lowAsk: edition.lowAsk });
    if (edition.lowAskHistory.length > LOW_ASK_HISTORY_CAP) {
      edition.lowAskHistory = edition.lowAskHistory.slice(-LOW_ASK_HISTORY_CAP);
    }
  } else if (edition.lowAsk != null && lastEntry && lastEntry.date === today) {
    lastEntry.lowAsk = edition.lowAsk; // same day, multiple touches - keep the latest, not the first
  }

  if (edition.salesHistory.length) {
    const recent = edition.salesHistory.slice(-SALES_HISTORY_CAP);
    edition.salesHistory = recent;
    const salePrices = recent.map((s) => s.price);

    const sorted = [...salePrices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    edition.marketValue = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    // ASP - Average Sale Price, the conventional mean (distinct from the
    // median used for marketValue/discount-to-market - median resists
    // outlier skew, ASP is the standard reported figure people expect).
    edition.avgSalePrice = salePrices.reduce((sum, p) => sum + p, 0) / salePrices.length;

    // Confidence tag based on sample size, not a fancier price formula -
    // matches the High/Some/Thin tiers already used on the TCG Chase Index,
    // so it's consistent with how Tome Collective already communicates this
    // exact problem (thin sales data = a number that looks precise but
    // isn't trustworthy) rather than a new framework.
    edition.valueConfidence = salePrices.length >= 10 ? "High" : salePrices.length >= 3 ? "Some" : "Thin";

    if (edition.lowAsk != null && edition.marketValue) {
      edition.discountToMarket = (edition.marketValue - edition.lowAsk) / edition.marketValue;
    }
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const salesLast30d = recent.filter((s) => new Date(s.date).getTime() >= thirtyDaysAgo);
    edition.sales30d = salesLast30d.length;
    edition.volume30d = salesLast30d.reduce((sum, s) => sum + s.price, 0);
    // If every single tracked sale (all 20, the cap) falls within 30 days,
    // there could be more we evicted from history - we genuinely don't know,
    // so this is a floor ("20+"), not an exact count.
    edition.sales30dCapped = salesLast30d.length === SALES_HISTORY_CAP;

    // Tome Score - identifies real, actionable deals, not just the raw
    // biggest-discount number. Raw discountToMarket alone can be misleading:
    // a 70% "discount" based on one stale sale from months ago isn't a real
    // deal the way a 20% discount backed by consistent recent trading is.
    // Two adjustments on top of the raw discount:
    //   - Confidence multiplier: discounts a discount that's based on thin
    //     sales data (same High/Some/Thin tiers as valueConfidence above)
    //   - Liquidity multiplier: rewards editions that are actually trading
    //     right now (sales30d), since a "deal" nobody's buying isn't very
    //     actionable
    // Result is roughly a 0-100+ scale; negative means priced ABOVE market
    // (not a deal at all, but still real information, so not clamped away).
    if (edition.discountToMarket != null) {
      const confidenceMultiplier =
        edition.valueConfidence === "High" ? 1.0 : edition.valueConfidence === "Some" ? 0.7 : 0.4;
      const liquidityMultiplier = Math.min(1, 0.5 + edition.sales30d * 0.1);
      edition.tomeScore = Math.round(edition.discountToMarket * 100 * confidenceMultiplier * liquidityMultiplier);
    } else {
      edition.tomeScore = null;
    }
  }
  await kv.put(editionKey(edition.setID, edition.playID), JSON.stringify(edition));
}

// ---- Main indexing pass ----------------------------------------------------

async function runIndexPass(env) {
  const kv = env.TOPSHOT_KV;
  const latest = await latestSealedHeight();
  const checkpointRaw = await kv.get("checkpoint:events");
  let start = checkpointRaw ? parseInt(checkpointRaw, 10) + 1 : latest - 50; // first run: last ~50 blocks only
  if (start > latest) return { skipped: true, reason: "no new blocks" };

  let end = Math.min(start + MAX_BLOCK_RANGE - 1, latest);
  const [available, completed] = await Promise.all([
    getEvents(`${STOREFRONT_TYPE}.ListingAvailable`, start, end),
    getEvents(`${STOREFRONT_TYPE}.ListingCompleted`, start, end),
  ]);

  let processed = 0;
  const identityCache = {}; // nftID -> {setID, playID, serialNumber}, this run only (KV is the durable cache)
  const editionCache = {}; // `${setID}_${playID}` -> edition record, this run only (avoids repeat KV reads/writes within one pass)

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
    if (!identity) continue; // already resold before we could resolve it - fine, skip
    const edition = await getEditionCached(identity.setID, identity.playID, identity.imageURL);
    edition.activeListings[nftID] = { price, sellerAddress, blockTimestamp: ev.blockTimestamp };
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
    if (!identity) continue; // never resolved a listing for this one - nothing to update
    const edition = await getEditionCached(identity.setID, identity.playID);
    delete edition.activeListings[nftID]; // listing is resolved either way (bought, cancelled, or expired)
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
  };
}

// ---- Set inventory + tier sweep (run on demand, not every cron tick) ------

async function runSetSweep(env, maxSetID) {
  const kv = env.TOPSHOT_KV;
  const inventory = {};
  for (let setID = 1; setID <= maxSetID; setID++) {
    const name = await getSetName(setID);
    if (!name) continue; // no set at this ID
    const stats = await getSetCirculationStats(setID);
    // Priority: individual setID override > confirmed name pattern > numeric
    // band inference. Name patterns beat circulation bands because they're
    // sourced from Top Shot's own descriptions of what each release TYPE is
    // designed to be, not inferred from numbers that drift across eras.
    const tier = TIER_OVERRIDES[setID]
      || classifyByNamePattern(name)
      || (stats ? classifyTier(stats.minCirc, stats.maxCirc) : "Unknown");
    inventory[setID] = { name, tier, ...stats };
  }
  await kv.put("sets:inventory", JSON.stringify(inventory));
  return { setsFound: Object.keys(inventory).length };
}

// ---- Subscriber gating (Tome Edge) -----------------------------------------
// Mirrors the X-Tome-Sub / X-Tome-Key pattern from tome-fastbreak and
// tome-tcg: resolve via tome-proxy's /auth/subscription over a service
// binding, shared key as fallback. Requires the "edge" tier or above.

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

// KV list() caps at 1000 keys per call - Top Shot easily has more distinct
// editions than that once this has run a while, so every listing read must
// page through the cursor or results silently truncate.
async function listAllKeys(kv, prefix) {
  let keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    keys = keys.concat(page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function loadAllEditions(kv) {
  const keys = await listAllKeys(kv, "edition:");
  const editions = [];
  for (const key of keys) {
    const raw = await kv.get(key.name);
    if (raw) editions.push(JSON.parse(raw));
  }
  return editions;
}

// ---- HTTP surface -----------------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIndexPass(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const checkpoint = await env.TOPSHOT_KV.get("checkpoint:events");
      return Response.json({ ok: true, checkpoint });
    }

    if (url.pathname === "/admin/run-index" && request.method === "POST") {
      const result = await runIndexPass(env);
      return Response.json(result);
    }

    if (url.pathname === "/admin/sweep-sets" && request.method === "POST") {
      const maxSetID = parseInt(url.searchParams.get("maxSetID") || "400", 10);
      const result = await runSetSweep(env, maxSetID);
      return Response.json(result);
    }

    if (url.pathname === "/admin/reset-editions" && request.method === "POST") {
      // Wipes edition: and moment: records only (never sets:inventory or the
      // event checkpoint) so they rebuild fresh with the current schema.
      // Safe pre-launch; do NOT run this after real usage/history matters,
      // since it discards accumulated sales history and low-ask state.
      const kv = env.TOPSHOT_KV;
      const [editionKeys, momentKeys] = await Promise.all([
        listAllKeys(kv, "edition:"),
        listAllKeys(kv, "moment:"),
      ]);
      await Promise.all([...editionKeys, ...momentKeys].map((k) => kv.delete(k.name)));
      return Response.json({ editionsCleared: editionKeys.length, momentsCleared: momentKeys.length });
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
      let editions = await loadAllEditions(env.TOPSHOT_KV);

      // Tier lives on the SET (from the separate sets:inventory sweep), not
      // on individual edition records - join it in here at read time. This
      // is cheap (one KV read total) and, importantly, fixes tier for every
      // edition regardless of when it was created, not just new ones.
      const inventoryRaw = await env.TOPSHOT_KV.get("sets:inventory");
      const inventory = inventoryRaw ? JSON.parse(inventoryRaw) : {};
      for (const e of editions) {
        e.tier = inventory[e.setID]?.tier || "Unknown";
        e.circulation = inventory[e.setID]?.circulationByPlay?.[String(e.playID)] ?? null;
      }

      // filters - available to everyone, gating happens on which fields/rows come back
      const seasonFilter = url.searchParams.get("season");
      const tierFilter = url.searchParams.get("tier"); // comma-separated, e.g. tier=Common,Rare
      const leagueFilter = url.searchParams.get("league"); // "NBA" or "WNBA"
      const minPrice = url.searchParams.get("minPrice");
      const maxPrice = url.searchParams.get("maxPrice");
      const setFilter = url.searchParams.get("set"); // substring match, case-insensitive
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
        // biggest bargains first - the whole point of tracking discount-to-market.
        // Requires Edge access below; ungated requests fall back to lowAsk sort
        // since the teaser strips discountToMarket entirely anyway.
        editions = editions
          .filter((e) => e.discountToMarket != null)
          .sort((a, b) => b.discountToMarket - a.discountToMarket);
      } else if (sortBy === "tomeScore") {
        // the refined "best deals" view - confidence- and liquidity-adjusted,
        // not just raw discount percentage
        editions = editions
          .filter((e) => e.tomeScore != null)
          .sort((a, b) => b.tomeScore - a.tomeScore);
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
          isRookieYear: e.isRookieYear,
          imageURL: e.imageURL,
          lowAsk: e.lowAsk,
        }));
        return Response.json({ locked: true, count: teaser.length, editions: teaser });
      }

      return Response.json({ locked: false, count: editions.length, editions });
    }

    return new Response("tome-topshot indexer", { status: 200 });
  },
};
