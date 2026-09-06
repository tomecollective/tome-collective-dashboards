# tome-proxy

Cloudflare Worker that fronts JustTCG for the Tome Intelligence / Tome Vault
dashboards and runs the daily snapshot pipeline.

Live: https://tome-proxy.tomecollective.workers.dev

## Request path (`fetch`)

GET only. Allowed paths: `/cards`, `/sets`, `/v2/cards` (graded data, proxied to
api.justtcg.com without the `/v1` prefix), `/history`, `/graded-prices`.
Responses are edge-cached for 6h (approved by JustTCG). CORS is limited to the
Tome origins in `ALLOWED_ORIGINS`.

Known gap: no subscriber gate or per-IP rate limit on the JustTCG proxy paths
(the same class of issue Fast Break and Chase Index closed in Sept 2026).

## Cron (`scheduled`, daily 14:00 UTC)

1. `captureSnapshot` -- one `snap:<game>:<date>` KV entry per game (NM prices).
2. `captureGradedPrices` -- PSA 7/8/9 prices for the catalog universe, written
   to KV `graded-prices` with a `statusCounts` breakdown of what JustTCG's
   graded endpoint returned (ok / 404 / 429 / 5xx / network_error). That
   breakdown is the diagnostic for the low PSA coverage reading.
3. `captureScoreHistoryAndDigest` -- scores the catalog, logs Watch-tier+
   cards to KV `score-history:<date>`, and posts the top crack-profit targets
   to Discord via `DISCORD_WEBHOOK_URL`.

## Deploy

    cd dashboards/tome-proxy
    npx wrangler deploy

Secrets are set on the Worker and survive deploys.

## Local smoke test

The scheduled handler was verified against a mocked JustTCG / KV / Discord in
Node before the 2026-09-06 deploy (all five KV keys written, statusCounts sums
to cardsChecked, stale listings excluded, digest posted once).
