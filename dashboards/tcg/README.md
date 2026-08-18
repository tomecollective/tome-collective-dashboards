# Tome Analytics: Pokemon Chase Modern EN 50 — Prototype

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
   toggle above it, and hover tooltips (Chart.js's built-in tooltip, themed to match the page)
   showing the exact index value at any point on the line. Right now only 2 seeded cards
   (Gardevoir ex, Magikarp) have mock daily history so the toggle/tooltip can be tested end to
   end; the rest show as flat/missing until real data is wired in.
2. **Index Holdings** — flat table of the 50 in-index cards. It renders every card flagged
   `in_index: true` across all sets, so it scales to the full 50 automatically once research is
   complete — no code change needed. It's sparse today only because most sets are still
   placeholder-only (see below), not because of a display limit.
3. **Full Candidate Pool, By Set** — grouped by era (XY, Sun & Moon, Sword & Shield, Scarlet &
   Violet, Mega Evolution, oldest first), each set shows exactly its top 5 candidates, no more —
   the old "See ranks 6-10" toggle is gone. Within those 5:
   - **Gold** = actually in the final 50-card index. Capped at 3 per set in code (`MAX_GOLD_PER_SET`
     in index.html), not just by convention — even if a set's data flags more than 3 cards
     `in_index: true`, only the top 3 by rank can ever render gold.
   - **Green** = shortlisted (rank 1-3 of the 5 shown) but not in the final index.
   - **Gray** = not shortlisted (rank 4-5 of the 5 shown) — always exactly 2 per set once a set
     has 5 candidates entered; fewer if the set doesn't have 5 yet.

   Shortlist tier is derived purely from rank position in code, not from a hand-set `shortlisted`
   flag in the data — that flag is now legacy/informational only.

## Set eligibility (age gating)
A set's cards can be shown, ranked, and shortlisted (gray/green) as soon as there's any data for
them — no waiting period. But a set can't contribute a **gold** (in-index) card until it's been
out for more than `SET_ELIGIBILITY_DAYS` (30, in index.html) days, based on each set's
`release_date`. A set that's too new shows a visible note on its card explaining why nothing in
it is gold yet. This is what the new Mega Evolution placeholder set demonstrates on the live page.

## Data schema
See `data/chase-index-schema-template.json` for the annotated reference. Each set now carries
`era` and `release_date` fields in addition to the `top_5` array (renamed from `top_10` now that
only 5 candidates are ever shown). Each card's `history` field is `[{date, price}]` — this is what
both the index-value chart and any future per-card detail view will read from. Once the real
JustTCG fetch replaces the static seed import, this populates automatically per card; nothing
about the schema needs to change.

## Era coverage
The index now spans XY forward — XY, Sun & Moon, Sword & Shield, Scarlet & Violet, and Mega
Evolution — closing the previous gap between the Vintage (WOTC) index and this Modern one. The
newly-added XY, Sun & Moon, Sword & Shield, and Mega Evolution sets in
`chase-50-modern-seed.json` are placeholder-only right now (`price: null`, `note: "needs
research"`) — nobody has researched real pricing for them yet. Don't treat those numbers as real;
fill them in via the research workflow below.

## Research workflow (David's part)
Fill in `top_5` per eligible set (XY forward) with real cards and current pricing — replace the
placeholder `"TBD — needs research"` rows as you go, rather than guessing values. Once all sets
are populated and the top-50-overall selection is finalized, flip `in_index` to `true` on exactly
those 50 (subject to the 3-per-set cap and the 30-day age gate, both enforced automatically by the
frontend). Historical `history` arrays can now come directly from JustTCG's API once wired in,
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
The "See ranks 6-10" toggle mentioned in earlier notes has been removed — the candidate pool now
shows a fixed top 5 per set, so there's nothing left to expand.

## What's deliberately NOT built tonight
- **Live JustTCG integration** — documented and ready to wire in, but needs your real API key
  added as a Cloudflare secret, which has to happen on your end
- **Tier gating** — intentionally open. Add an access check once Stripe/tiers are live.
- **Full 50-card + full top-5-per-set data** — this is a partial prototype dataset.
