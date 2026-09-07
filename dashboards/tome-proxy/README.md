# tome-proxy

Cloudflare Worker that fronts JustTCG for the Tome Intelligence / Tome Vault
dashboards and runs the daily snapshot pipeline.

Live: https://tome-proxy.tomecollective.workers.dev

## Request path (`fetch`)

Every request is rate-limited per IP (PUBLIC_RATE_LIMITER, 60/min) and then gated
behind the Tome Vault subscriber key: the `X-Tome-Key` header (or `?key=`) must match
one of the comma-separated `TOME_SUBSCRIBER_KEYS` values, or the Worker answers
`401 {locked:true}` (`503` if the secret is unset, i.e. it fails closed). The key is
stripped before anything is forwarded to JustTCG.

GET paths: `/cards`, `/sets`, `/v2/cards` (graded data, proxied to api.justtcg.com
without the `/v1` prefix), `/history`, `/graded-prices`. Responses are edge-cached
for 6h (approved by JustTCG). CORS is limited to the Tome origins in `ALLOWED_ORIGINS`.

POST `/report`: the dashboard's Report-an-issue modal. Gated and rate-limited, fields
length-capped, forwarded to Discord via `DISCORD_WEBHOOK_URL`.

The frontend (tomecollective/tome-intelligence, index.html) reads the key from the
Dashboards-page link, keeps it in sessionStorage, and sends it as the header.

## Cron (`scheduled`, daily 14:00 UTC)

1. `captureSnapshot` -- one `snap:<game>:<date>` KV entry per game (NM prices).
2. `captureGradedPrices` -- PSA 7/8/9 prices for one third of the catalog per day
   (cards bucketed by a stable hash of their ID, so every card is refreshed every
   3 days), merged over the previous `graded-prices` snapshot. All cron-path
   JustTCG calls go through a shared limiter (80/min, concurrency 4) with 429
   retry honoring Retry-After. The snapshot carries a `statusCounts` breakdown
   (ok / 404 / 429 / 429_retried / 5xx / network_error) plus bucket metadata.

   History: the 2026-09-06 diagnostic run showed {404:171, 429:1190, ok:39} on
   1,400 unpaced graded lookups at concurrency 10 -- JustTCG rate limiting, not
   data availability, was the 1.8% PSA coverage reading.
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
