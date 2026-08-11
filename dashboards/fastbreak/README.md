# Tome Analytics: Fast Break — Prototype

## Update: live ESPN data, no subscription needed
Tested and confirmed working tonight, no API key, no cost: ESPN's public API (the same
underlying source the open-source `wehoop` project wraps) provides everything needed except
PITP specifically. Full pipeline is wired into `worker/index.js`:
1. `/scoreboard` -> today's games and team IDs
2. `/teams/{id}/roster` -> player IDs for a team
3. `athletes/{id}/gamelog` -> per-game stat rows, aggregated here into YTD and L10 averages

This replaces the original 3-source plan (Rotowire + WNBA standard stats + WNBA misc endpoint)
entirely for everything except PITP and forward projections. One endpoint family, one data
shape, no per-source integration work.

**What this doesn't solve yet:**
- **PITP** — not a standard box-score stat anywhere. Needs shot-location data from
  play-by-play (`plays` array is present in ESPN's game summary endpoint, unexplored so far —
  next step is checking whether it includes court coordinates to filter paint-area makes).
- **Proj** — Rotowire's actual projections were confirmed unreachable (client-side rendered,
  no scrapable API). Plan is an in-house model instead: `Projected Points = Minutes × Points
  Per Minute`, adjusted for pace, matchup, and usage/role shifts — the standard DFS industry
  formula, not proprietary, well-documented. Not built yet, `proj` currently returns `null`.

**Caveat worth knowing:** this is an unofficial, undocumented ESPN endpoint. No vendor SLA, but
stable enough that `wehoop` and many hobbyist tools have relied on it for years.

## What this is
Open, ungated prototype (Edge tier once Stripe is live). Sortable table, click any column
header to sort.

## Steps to run tonight
1. `cd dashboards/fastbreak`
2. `wrangler dev` — test locally against live ESPN data (real requests, no seed file anymore)
3. `wrangler deploy` once confirmed working
4. Swap `YOUR_SUBDOMAIN` in `index.html` for the real deployed URL

## Scope tonight vs. later
- Currently pulls **one team's roster only** (first team playing today, first 8 players) to
  stay fast and under reasonable request volume while testing. Expand to all of today's teams
  once confirmed stable — each added team is roughly 13 additional gamelog requests.
- The daily objective swap stays a manual input, not automated — that's a business decision
  each day, not something to encode into logic.
- Tier gating: intentionally open, add once Stripe/tiers are live.
