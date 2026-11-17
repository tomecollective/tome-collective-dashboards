// Offline check of the value-upgrade rule. Run: node _value_tier_test.mjs
import { valueTier, effectiveTier, VALUE_TIER_MIN_PRICE, __collectionTestables__ as T } from "./collection.js";
let fails = 0;
const eq = (name, got, want) => { if (got !== want) { fails++; console.error("FAIL", name, "got", got, "want", want); } else console.log("ok  ", name); };

// Calibration points from the Nov 17 2026 wallet check (game discount in comments).
eq("Fandom $15 -> Rare (game 10%)", effectiveTier("Fandom", 15), "Rare");
eq("Fandom $5.50 -> Rare (game 10%)", effectiveTier("Fandom", 5.5), "Rare");
eq("Fandom $6.75 -> Rare (game 10%)", effectiveTier("Fandom", 6.75), "Rare");
eq("Common $4.99 stays Common (game 5%)", effectiveTier("Common", 4.99), "Common");
eq("Common $0.20 stays Common (game 5%)", effectiveTier("Common", 0.2), "Common");
eq("Fandom no price stays Fandom", effectiveTier("Fandom", null), "Fandom");
// Value never lowers a tier.
eq("Legendary $0.10 stays Legendary", effectiveTier("Legendary", 0.1), "Legendary");
eq("Ultimate $1 stays Ultimate", effectiveTier("Ultimate", 1), "Ultimate");
eq("Rare $1000 stays Rare until Legendary cutoff is known", effectiveTier("Rare", 1000), "Rare");
eq("Unknown set tier + $20 -> Rare", effectiveTier("Unknown", 20), "Rare");

// If Legendary/Ultimate cutoffs are set later, higher cutoffs win first.
VALUE_TIER_MIN_PRICE.Legendary = 100; VALUE_TIER_MIN_PRICE.Ultimate = 500;
eq("with cutoffs: Rare $150 -> Legendary", effectiveTier("Rare", 150), "Legendary");
eq("with cutoffs: Rare $600 -> Ultimate", effectiveTier("Rare", 600), "Ultimate");
eq("with cutoffs: Legendary $20 stays Legendary", effectiveTier("Legendary", 20), "Legendary");
VALUE_TIER_MIN_PRICE.Legendary = null; VALUE_TIER_MIN_PRICE.Ultimate = null;

// End to end through buildCollection: best Moment per player uses the effective tier.
const body = T.buildCollection({
  address: "0xabc", username: null, total: 3,
  moments: [
    { id: "1", setID: 1, playID: 10, serial: 142 },   // Fandom, $15 -> Rare
    { id: "2", setID: 2, playID: 10, serial: 9000 },  // Common, $0.30
    { id: "3", setID: 2, playID: 11, serial: 455 },   // Common, $4.99
  ],
  inventory: { 1: { name: "Run It Back: Phantom Threads", tier: "Fandom" }, 2: { name: "Archive Set", tier: "Common" } },
  snapshot: { editions: [
    { setID: 1, playID: 10, playerName: "Allen Iverson", avgSalePrice: 15, lowAsk: 15 },
    { setID: 2, playID: 10, playerName: "Allen Iverson", lowAsk: 0.3 },
    { setID: 2, playID: 11, playerName: "Artis Gilmore", lowAsk: 4.99 },
  ] },
  playsIndex: {},
});
const ai = body.players.find((p) => p.name === "Allen Iverson");
const ag = body.players.find((p) => p.name === "Artis Gilmore");
eq("Iverson best tier", ai.best.tier, "Rare");
eq("Iverson best came from value", ai.moments[0].tierSource, "value");
eq("Gilmore best tier", ag.best.tier, "Common");
if (fails) { console.error(fails + " failure(s)"); process.exit(1); }
console.log("ALL VALUE-TIER TESTS PASSED");
