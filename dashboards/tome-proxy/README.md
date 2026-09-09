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

## Subscriber identity (Beehiiv subscription id)

Besides the shared `X-Tome-Key`, the Worker accepts `X-Tome-Sub: sub_<uuid>` (or `?sid=`), the
reader's own Beehiiv subscription id. The Dashboards post fills it in with the
`{{api_subscription_id}}` merge tag, which Beehiiv renders on the web view for logged-in readers.

- Lookup: `GET /v2/publications/{BEEHIIV_PUBLICATION_ID}/subscriptions/{id}?expand[]=premium_tiers`,
  cached in KV as `sub:<id>` (fresh 6h, negative 30 min, stale entries grace-served only if Beehiiv is down).
- Access: status `active` and a tier in `TOME_ALLOWED_TIERS` (default: Tome Vault, Edge + Vault Bundle).
- Webhooks: `POST /hooks/beehiiv/<BEEHIIV_WEBHOOK_TOKEN>` evicts the cache entry for `data.id`.
  Subscribe it to Subscription Tier Added / Paused / Resumed / Deleted and Subscription Deleted / Paused / Resumed / Upgraded / Downgraded.
- 401 responses carry `reason`: `unknown`, `inactive`, or `tier`; a Beehiiv outage with no cache is 503 `{retry:true}`.
- Secrets: `BEEHIIV_API_KEY`, `BEEHIIV_PUBLICATION_ID`, `BEEHIIV_WEBHOOK_TOKEN` (`wrangler secret put`).

## My Cards sync

`GET /mycards` -> `{sync, cards, updatedAt}`; `PUT /mycards {cards:[ids]}` (max 500). Requires a
subscription id; shared-key sessions get `{sync:false}` and the dashboard stays on localStorage.
Stored at `mycards:<sub_id>`. The daily cron aggregates all lists into `mycards-agg`
(users, distinct cards, top 25) and adds a "Most watched" line to the Discord digest.

## Internal identity service (other Tome Workers)

`GET /auth/subscription?sid=sub_...&need=edge|vault` with header `X-Tome-Internal: <TOME_INTERNAL_TOKEN>`
returns `{allowed, reason, sub, product, status, tiers, source}`. tome-tcg, tome-fastbreak, and
tome-fastbreak-refresh call it over an `AUTH` service binding (see their wrangler.toml) so they
share one Beehiiv lookup, cache, and webhook invalidation. Handled before the per-IP limiter
(service-binding calls carry no client IP). Unset or wrong token = 404. Edge products need
Tome Edge or the Bundle; Vault products need Tome Vault or the Bundle. The same
`TOME_INTERNAL_TOKEN` value must be set on all four Workers.

## Health

`GET /health` (ungated, metadata only, before the limiter): `{ok, problems[], cron, graded, scoreHistory, myCards, beehiiv}`.
`cron` is the `cron:last` record the daily pipeline writes (started/finished, per-step ok + ms, failing step and error).
`graded` is the snapshot minus its data (updatedAt, age, bucket, cardsChecked, bucketLive, liveCount, statusCounts).
tome-healthcheck reads this over its `PROXY_SERVICE` binding and relays `problems` to Discord.
