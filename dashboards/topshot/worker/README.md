# tome-topshot

Indexes NBA Top Shot low ask / last sale / circulation / discount-to-market
directly off the Flow blockchain. No third-party API dependency - everything
comes from Flow's public Access API (Cadence scripts + on-chain events).

## Architecture

- **Circulation & tier**: pulled from the TopShot contract (`getSetData`).
  Tier is a Set-level property (confirmed from Top Shot's own developer docs)
  classified by circulation band, with a small manual override list for
  pre-tier-system Series 1 anomalies (Genesis, Holo MMXX).
- **Low ask / last sale**: pulled from `NFTStorefrontV2.ListingAvailable` and
  `ListingCompleted` events, filtered to the TopShot contract type (so Disney
  Pinnacle and anything else riding the same storefront standard is excluded
  by contract address, not by name-matching).
- **Discount to market**: median of the last 20 sales per edition vs. current
  low ask.
- Storage is Cloudflare KV, one record per **edition** (Set+Play combo, e.g.
  "LeBron James dunk, Base Set") rather than per individual serial - this
  matches how collectors actually browse (low ask = cheapest active listing
  across all copies of that edition; last sale = most recent sale of any
  copy).

## Built this pass (image, 30D sales, badges, filters)

- **Moment image**: pulled once per edition via `MetadataViews.Display` in the
  same call that resolves a new moment's identity (no extra round-trip),
  cached permanently like everything else.
- **30-day sales count/volume**: computed from `salesHistory`. Caveat worth
  knowing: sales history is capped at the last 20 sales per edition
  (`SALES_HISTORY_CAP`), so a high-volume edition with 20+ sales in 30 days
  will undercount - it's really "however many of the last 20 sales fall in
  the last 30 days," not a true unbounded 30-day window. Fine for anything
  below ~20 sales/month; worth widening the cap if a specific edition runs
  hotter than that.
- **Rookie Year badge**: no raw on-chain flag exists for this - derived from
  `TotalYearsExperience == "0"` on the play metadata (confirmed real field).
- **League tag (NBA/WNBA)**: no raw on-chain league field either - derived by
  matching the team name against the current WNBA franchise list.
- **Filters added**: season, tier (now multi-select checkboxes instead of a
  single dropdown), league quick-toggle, min price / hide-sub-$1.

## Built this pass (price history chart, low-ask tracking, ASP, confidence)

- **Low-ask history**: daily snapshots, starting from whenever this code
  first runs - there is no way to backfill what low ask was before that.
  Recorded opportunistically (only when an edition is touched by a real
  event), so low-liquidity editions will show gaps on inactive days rather
  than a continuous daily line. Capped at ~120 days.
- **Price history chart**: click "Chart" on any edition to see sales
  (individual points) and low-ask history (a line) plotted together on the
  same timeframe - "price vs. reality," per your framing. Built with
  Chart.js (CDN, no build step needed).
- **ASP (Average Sale Price)**: the conventional mean, added alongside the
  existing median (`marketValue`, used for discount-to-market since median
  resists outlier skew better). Both are shown in the expanded chart panel.
- **Confidence tag** (High/Some/Thin, by sales sample size: 10+/3-9/0-2):
  matches the same tiers already used on the TCG Chase Index's Tome Score,
  rather than inventing a new framework. This is deliberately *not* a
  fancier price formula - with only up to 20 sales ever tracked, and
  history only starting today, a more complex estimate (e.g.
  recency-weighting) wouldn't have enough real date-spread to behave
  differently from the median for a while. Flagging confidence honestly is
  more useful right now than a formula upgrade.

## Built this pass (circulation, sales history, cap fix)

- **Exact per-edition circulation**: previously only set-wide min/max was
  kept (for tier classification) and the specific play's own count was
  discarded. Now the full per-play breakdown is stored in `sets:inventory`
  and joined into each edition at read time - "Circulation" was one of the
  four original core asks and wasn't actually reaching the dashboard until
  this fix.
- **Tier join bug fixed**: tier lives on the *set*, not the edition - it
  was never being attached to individual editions at all, which would have
  made the tier checkbox filter match nothing. Fixed the same way as
  circulation, via a read-time join against `sets:inventory`.
- **Sales price history**: exposed via an expandable "History" row per
  edition (last up to 20 tracked sales, price + date, newest first).
- **30D sales cap fixed**: shows "20+" instead of a bare number when every
  one of the 20 tracked sales falls within the last 30 days (the point
  where we genuinely can't tell if there were more that got evicted from
  history).
- **`/admin/reset-editions`**: wipes `edition:`/`moment:` KV records (never
  `sets:inventory` or the checkpoint) so old records missing the newer
  schema fields rebuild fresh. Safe pre-launch only - discards accumulated
  history if run later.

## Still missing vs. otmnft.com (not built, real gaps)

- **Ownership percentage** (circulating/claimed vs. still in packs): would
  need to track unique current holders per edition, which isn't built -
  circulation (mint count) is not the same thing as how many are actually
  out and tradeable.
- **Low-ask-over-time, historical depth**: now tracked going forward (see
  above), but only from whenever this code first ran - no backfilled
  history, and real gaps likely on days with zero listing activity for a
  given edition. A true continuous historical chart the way otmnft can show
  it (going back to a set's release) isn't achievable without that backfill,
  which doesn't exist for past data.

## Known non-starter (flagged, not built)

**Active offers / current high offer**: confirmed excluded per your call -
NBA Top Shot's real "Offers" feature runs on Dapper Balance, which reads as
an off-chain ledger, not an open on-chain contract like `NFTStorefrontV2`.
Not attempted.

## Known gap in this first draft (deliberate, not an oversight)

Listing events only carry `nftID`, not `setID`/`playID` - so every
newly-seen moment needs one follow-up on-chain lookup to resolve its
identity. That resolution is cached permanently in KV (`moment:<nftID>`)
since a moment's set/play/serial never change, so it's a one-time cost per
moment, not a recurring one.

**Now built:**
- Player/team/game/season identity per edition (`playerName`, `team`,
  `playCategory`, `dateOfMoment`, `nbaSeason`, `matchup`) - pulled once per
  playID from `getPlayMetaDataByField` and cached permanently on the edition
  record, same as the set-level identity
- Edge-tier subscriber gating on `/api/topshot/editions`, mirroring the
  X-Tome-Sub / X-Tome-Key pattern from tome-fastbreak and tome-tcg: shared
  key first, then a service-binding call to tome-proxy's
  `/auth/subscription?need=edge`. Ungated requests get a 10-edition teaser
  (name, player, team, season, tier, low ask only - no sales history, no
  discount-to-market)

Still not built:
- Frontend - this Worker only exposes raw JSON

## Tome Score - identifying real deals, not just raw discount

Raw discount-to-market can be misleading on its own: a 70% "discount" backed
by one stale sale from months ago isn't a real, actionable deal the way a
20% discount backed by consistent recent trading is. Tome Score adjusts the
raw discount by two factors:

- **Confidence multiplier** (same High/Some/Thin tiers as `valueConfidence`):
  High = 1.0, Some = 0.7, Thin = 0.4
- **Liquidity multiplier**: `min(1, 0.5 + sales30d * 0.1)` - rewards editions
  that are actually trading right now, since a "deal" nobody's buying isn't
  very actionable

`tomeScore = round(discountToMarket * 100 * confidenceMultiplier * liquidityMultiplier)`

Roughly a 0-100+ scale. Negative means priced *above* market (not a deal at
all, but still real information, so it isn't clamped away). `null` when
there's no sales history to compute a discount from at all.

## Filters added this pass

- **Price range**: min and max (previously min-only)
- **Set search**: substring match on set name, separate from player search

## Known limitation: current-season Ultimate-tier content

Confirmed via direct investigation (network inspection of the live
marketplace): flagship Ultimate-tier drops (Kingmaker, Supernova, and
similar) run through a separate backend Dapper Labs built for the 2025-26
season - `api.production.atlas.dapperlabs.com` - not the classic on-chain
TopShot contract this dashboard queries. That endpoint is Cloudflare-protected
the same way the original marketplace GraphQL API is, so it's out of scope
by the same principle: this dashboard doesn't build around bypassing
security measures a platform put up on purpose. Everything else - the full
Common/Fandom/Rare/Legendary catalog, every season including the current
one - is unaffected and fully covered. This is stated directly in the
dashboard UI, not just here.

## Tier fix: name-pattern classification (real, sourced)

The full 400-set sweep surfaced a serious accuracy problem: 146 of 278 real
sets (over half) landed in the numeric-band fallback, most incorrectly
labeled "Fandom." Circulation bands drift too much across Top Shot's
multi-year history for one static threshold to work - a 2020 "Common" and a
2024 "Common" don't share a circulation range.

Fixed the flagship recurring templates using NBA Top Shot's own blog
copy, which states what each release type is *designed* to be rather than
inferring it from numbers: **Base Set = Common**, **Metallic Gold LE = Rare**
("the standard Rare Set every season"), and **Throwdowns, For the Win,
Denied!, Video Game Numbers, Fresh Threads** are all Rare too (grouped
explicitly under "Rare Sets" in the same source). This resolves roughly
38 of the 146 previously-mislabeled sets - the most frequently recurring
ones, not all of them.

Worth noting: many of the *remaining* Fandom-bucketed sets (NBA Cup, dated
Playoffs/All-Star sets, "The Finals") are plausibly correct - genuine
event/promotional drops are exactly what Fandom means. The real problem was
specifically the flagship templates being swept into that bucket, not every
long-tail set. Longer-tail one-off sets would need individual research if
full accuracy across all 278 sets matters.

**Also worth flagging**: NBA Top Shot's own copy states rarity is a 4-tier
system (Common/Fandom/Rare/Legendary). "Ultimate" (used here for Platinum
Ice and Genesis) is a real but historical, auction-only designation that
sits outside that ongoing system - not a live 5th tier collectors see
today. Worth confirming this matches your own understanding before relying
on it further.

## Known limitation: circulation doesn't account for burns

`numberMintedPerPlay` (used for both the circulation figure and tier
classification) is the historical gross mint count - it's permanent
on-chain data that never changes, even after moments are destroyed. Dapper
Labs has run real burn events (e.g. 7,962 Platinum Ice moments burned in
2023), so for sets with burn history the true current circulating supply
can be lower than what this dashboard shows. Burn tracking would need its
own on-chain event listener (similar shape to the listing/sale indexer,
watching for `TopShot.MomentDestroyed` or equivalent) - not built yet.
Tier classification itself isn't affected by this (it's based on original
edition size, which is what the tier was always defined by), but the raw
circulation number shown to users could read as more available than
actually exists for any set with a burn history.

## Endpoints

- `GET /api/topshot/editions` - the main feed. Query params: `season`
  (e.g. `2025-26`), `tier` (e.g. `Legendary`), `sort` (`lowAsk` default, or
  `discount` for biggest-bargain-first - the "why visit this dashboard"
  view, since discount-to-market was the original point). Edge-gated: no
  key/sid gets a 10-row teaser (name, player, team, season, tier, low ask
  only); a valid key/sid gets the full feed including sales history and
  discount-to-market.
- `GET /api/topshot/sets` - the swept set inventory (name, tier, circulation
  stats). Query param: `tier` to filter. Ungated - this is reference data,
  not the live market data that's the actual product.
- `GET /health` - event checkpoint, for the healthcheck Worker to poll
- `POST /admin/run-index` - manually trigger an index pass (normally runs on
  the 5-minute cron)
- `POST /admin/sweep-sets?maxSetID=N` - rebuild the set inventory

## Correctness note (fixed before first deploy, not after)

KV's `list()` caps at 1000 keys per call. Top Shot has well over 1000
distinct editions once this has run a while, so the editions read path
pages through the cursor (`listAllKeys`) rather than taking the first page
and silently truncating everything past it. Worth knowing this exists if
you ever add another KV-scanning endpoint later - the single-call version
looks fine in testing (low key count) and only breaks once the dataset is
actually large enough to matter.

## Deploy steps

1. Create the KV namespace: `wrangler kv:namespace create TOPSHOT_KV`
2. Paste the returned id into `wrangler.toml` (replaces
   `REPLACE_WITH_REAL_KV_NAMESPACE_ID`)
3. Set secrets (same values already used on the other dashboards):
   `wrangler secret put TOME_SUBSCRIBER_KEYS` and
   `wrangler secret put TOME_INTERNAL_TOKEN`
4. Confirm the `[[services]]` binding to `tome-proxy` resolves - it must
   already have the `/auth/subscription?need=<tier>` route live (it does,
   per the Sept 9 build) for Edge gating to work
5. `wrangler deploy`
6. Run the initial set inventory sweep (one-time, ~400 sets - budget a few
   minutes): `curl -X POST https://tome-topshot.<account>.workers.dev/admin/sweep-sets?maxSetID=400`
7. Check `/health` for the event checkpoint once the cron has ticked a few
   times
8. Spot-check `/api/topshot/editions` for real data, with and without a
   valid key/sid, to confirm the teaser gate behaves as expected

## Tuning knobs

- Cron interval is `*/5 * * * *` (every 5 minutes) - untested against real
  sustained event volume, may need adjustment once live
- `MAX_EVENTS_PER_RUN` (400) and `MAX_BLOCK_RANGE` (250, this is Flow's own
  hard API limit) cap how much a single cron tick processes - if there's ever
  a backlog, the checkpoint just picks up where it left off on the next tick
- `SALES_HISTORY_CAP` (20) controls the discount-to-market baseline window
