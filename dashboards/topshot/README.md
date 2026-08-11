# Tome Edge: NBA Top Shot — Prototype

## What this is
NBA/WNBA toggle, filters (player search, team, season, tier), sortable results table showing
population, burned count, circulating supply (population minus burned), last sale, and 30-day
average sale price per moment.

## Data status
Seed data only — 6 sample moments (3 NBA, 3 WNBA) for testing the toggle, filters, and sort
logic. Real population/burned/sale data requires read-only Cadence scripts against the TopShot
smart contract, scoped as its own dedicated build session in the roadmap (`worker/index.js` has
the exact handoff note for where that plugs in). The frontend and Worker response shape are
built to not need changes when real data replaces the seed — same `moments` array shape either
way.

## My Collection (wallet lookup)
Text field for a Flow wallet address, "Look Up Value" button, computes a total using 30-day
average sale price. **Demo only today** — no real address-to-holdings mapping exists yet, so it
always shows the same demo result using the seed moments, clearly labeled as a demo so nobody
mistakes it for a real lookup of their actual wallet. Real version needs the Cadence script work
to query a specific account's actual on-chain holdings, same scoped build as the aggregate data.

Also supports a `?wallet=0x...` URL parameter — pre-fills and auto-runs the lookup. This is the
hook for a future personalized-link flow (e.g. a Beehiiv email with each subscriber's saved
wallet baked into their link), not wired to Beehiiv yet. A `Flow Wallet Address` custom field
already exists on the Beehiiv side, ready whenever that gets built.

## Filters implemented
- **League toggle** (NBA / WNBA) — filters which moments are visible and repopulates the
  Team/Season dropdowns to match, so you don't see WNBA teams while browsing NBA
- **Player name search** — live, case-insensitive substring match
- **Team** — dropdown, populated dynamically from whichever league is active
- **Season** — same, dynamic per league
- **Tier** — Common / Rare / Legendary
- All columns sortable by clicking the header, same click-to-toggle-direction pattern as the
  Fast Break dashboard

## Steps to run
1. `cd dashboards/topshot`
2. `wrangler dev` to test locally against seed data
3. `wrangler deploy` once confirmed working
4. Swap `YOUR_SUBDOMAIN` in `index.html` for the real deployed URL

## Not built yet
- Live Cadence/Flow data (the actual point of this dashboard — scoped separately)
- Tier gating (Edge-exclusive once Stripe/tiers are live — open for now, same as other dashboards)
- NFL All Day / Disney Pinnacle — parked per the roadmap until their data situations are clearer
