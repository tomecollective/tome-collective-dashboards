# Tome Analytics: Pokemon Chase Modern 50 — Prototype

## Major update: no more waiting on history to accumulate
JustTCG retains historical NM (Near Mint) price data server-side on paid plans —
`include_price_history=true` with `priceHistoryDuration` (7d/30d/90d/180d/1y) returns real daily
price points immediately. This means **the chart doesn't need months to become usable** — once
the real API call is wired in (see `worker/index.js` for the exact endpoint and headers), history
is available from day one, backfilled up to a year. The KV/cron snapshot plan from earlier
conversations is no longer needed for chart history specifically — it may still be useful as a
short cache layer to avoid re-fetching JustTCG on every page view, but it's an optimization now,
not a requirement to have a working chart.

## What this is
An open, ungated prototype. No tier-gating logic, since Stripe/tiers aren't live yet — nothing
to check access against tonight. **Vault-exclusive once tiers exist.**

## Page structure
1. **Index Trend** — line chart of index value over time, with a 7D/30D/90D/180D/1Y timeframe
   toggle above it. Right now only 2 seeded cards (Gardevoir ex, Magikarp) have mock daily
   history so the toggle can be tested end to end; the rest show as flat/missing until real data
   is wired in.
2. **Index Holdings** — flat table of the 50 in-index cards
3. **Full Candidate Pool, By Set** — top 5 visible per set, ranks 6-10 behind a "See more"
   toggle (native `<details>`, easy to instrument for click analytics later). Gold = shortlisted
   top 3 per set, bold/green = actually in the final 50.

## Data schema
See `data/chase-index-schema-template.json` for the annotated reference. Each card's `history`
field is `[{date, price}]` — this is what both the index-value chart and any future per-card
detail view will read from. Once the real JustTCG fetch replaces the static seed import, this
populates automatically per card; nothing about the schema needs to change.

## Research workflow (David's part)
Fill in `top_10` per eligible set (Sword & Shield forward, and only sets released 1+ month ago —
see the new-set eligibility rule) with real cards and current pricing. Once all sets are
populated and the top-50-overall selection is finalized, flip `in_index` to `true` on exactly
those 50. Historical `history` arrays can now come directly from JustTCG's API once wired in,
rather than needing manual historical research — that part of the original plan is no longer
necessary given the API's retention capability.

## Steps to run tonight

1. `cd dashboards/tcg`
2. `wrangler login` (if not already done for the Fast Break worker)
3. `wrangler dev` — runs the Worker locally, gives you a `localhost` URL to test
   `/api/chase-index` against before deploying anywhere
4. Once it's returning JSON correctly locally: `wrangler deploy`
5. Copy the deployed URL Wrangler gives you (looks like
   `tome-chase-index.<your-subdomain>.workers.dev`)
6. Open `index.html`, replace `YOUR_SUBDOMAIN` in the `WORKER_URL` constant with the real one
7. Open `index.html` directly in a browser — chart, timeframe toggle, holdings table, and
   candidate-pool grid should all render from the seed data
8. **When ready to go live:** add your JustTCG key via `wrangler secret put JUSTTCG_API_KEY`,
   then swap the static import in `worker/index.js` for the live fetch documented inline there

## Future: usage analytics
Each set's "See ranks 6-10" toggle is a native `<details>` element specifically so it's easy to
instrument later — a `toggle` event listener per element, logged to wherever analytics eventually
lives, tells you exactly which sets people actually dig into vs. which ones nobody expands.

## What's deliberately NOT built tonight
- **Live JustTCG integration** — documented and ready to wire in, but needs your real API key
  added as a Cloudflare secret, which has to happen on your end
- **Tier gating** — intentionally open. Add an access check once Stripe/tiers are live.
- **Full 50-card + full top-10-per-set data** — this is a partial prototype dataset.


