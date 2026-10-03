# tome-set-value ("Cost to Complete")

Tracks what it actually costs to complete every modern set across Pokemon,
Lorcana, and (eventually) One Piece. Gated to Tome Vault: every set tile is
visible to everyone (name, release date - the marketing surface), but the
dollar figure and historical trend are locked without Vault access, same
visible-but-locked pattern as the Top Shot dashboard (not a row-hiding
teaser like Chase Index).

## Why this is a separate Worker from tome-tcg

Checked tome-tcg's real live source before building this. Its entire
architecture (per-card resolution via name/number search+match, batch
self-chaining to stay under Cloudflare's subrequest limit, eligibility
gating for a 50-card shortlist) solves a genuinely different problem and
shares almost no code path with this feature. This pulls from JustTCG's
`/sets` endpoint, not `/cards` - a set-value total, not individual card
prices. Bolting a different data model and a different cron cadence onto
tome-tcg's already-intricate working file would have been the wrong call.
Reused directly: the `JUSTTCG_API_KEY` secret value, and the proven
`secretEquals`/`subscriptionCheck`/`isSubscriber` auth utilities, copied
verbatim from tome-tcg's live code rather than reinvented.

## Architecture

- **Data source**: `GET https://api.justtcg.com/v1/sets?game=<game>` -
  returns EVERY set for that game in one call, each with a pre-computed
  `set_value_usd` field ("Total estimated value of every card in the
  set"). This means the whole pipeline is **3 total JustTCG requests**
  (one per game), regardless of update frequency - no per-card resolution
  needed at all.
- **Cadence**: weekly per game, staggered one day before that game's Spike
  Report capture day - Lorcana Tuesday, One Piece Thursday, Pokemon
  Saturday (`0 14 * * 2/4/6` respectively). Three separate cron entries;
  `event.cron` tells the scheduled handler which game to snapshot.
- **Storage**: one KV record per set (`set:<game>:<setId>`) holding
  current value + a running history array (`{date, value}`, capped at 208
  entries - about 4 years of weekly snapshots), plus one index list per
  game (`index:<game>`) so the API can list all sets without a KV `list()`
  scan (same reasoning as the Top Shot build - `list()` caps at 1000 keys
  per call).
- **History starts now, not before**: `set_value_usd` was only added to
  JustTCG's API on Dec 13, 2025 - there's no backfill available from
  JustTCG or anywhere else. Same honest limitation as Top Shot's low-ask
  history.
- **`set_value_usd` is Optional** per JustTCG's schema - not guaranteed on
  every set. Sets without it are skipped during snapshotting (not written
  with a misleading `$0`) and tracked in the `skippedNoValue` count the
  admin endpoint returns, so real coverage gaps are visible, not silent.

## Gating

Mirrors Top Shot's column-lock pattern exactly:
- `/api/sets` returns every set's `id`/`name`/`release_date` to everyone;
  `current_value` is `null` for non-Vault requests, the real number for
  Vault. The frontend shows a locked state in place of the number rather
  than hiding the tile.
- `/api/sets/:id/history` is Vault-only outright (403 for everyone else) -
  this is the deeper paid insight, not part of the free marketing surface.
- Auth checks shared key (`TOME_SUBSCRIBER_KEYS`) first, then a Beehiiv
  subscription check via the `AUTH` service binding to `tome-proxy`
  (`need=vault`), same two-path pattern as every other gated dashboard.

## Deploy steps

1. KV namespace already created: `SET_VALUE_KV` ->
   `f1bcbe15c77b4d9da98573cb0fb9d1d6` (already in `wrangler.toml`)
2. Set secrets (reuse the SAME values already used elsewhere - these are
   separate Cloudflare secrets per Worker even when the value is
   identical, so each needs its own `wrangler secret put`):
   - `JUSTTCG_API_KEY` (same value as tome-tcg)
   - `TOME_SUBSCRIBER_KEYS` (same value as tome-tcg/tome-topshot)
   - `TOME_INTERNAL_TOKEN` (same value as tome-tcg/tome-topshot)
   - `SET_VALUE_ADMIN_TOKEN` (can be a new value, or reuse tome-tcg's
     `TCG_ADMIN_TOKEN` value - your call)
3. Confirm the `[[services]]` binding to `tome-proxy` resolves (it will -
   confirmed live and working for tome-tcg already)
4. `wrangler deploy`
5. Trigger an initial snapshot per game (don't wait for the staggered
   cron days to find out if it works):
   ```
   curl -X POST "https://tome-set-value.tomecollective.workers.dev/admin/snapshot?game=pokemon" -H "X-Admin-Token: <token>"
   curl -X POST "https://tome-set-value.tomecollective.workers.dev/admin/snapshot?game=disney-lorcana" -H "X-Admin-Token: <token>"
   curl -X POST "https://tome-set-value.tomecollective.workers.dev/admin/snapshot?game=one-piece-card-game" -H "X-Admin-Token: <token>"
   ```
6. Check `/health` for set counts per game, then `/api/sets?game=pokemon`
   to confirm real data
7. Push `index.html` + `favicon.svg` to the dashboards repo (same pattern
   as every other dashboard), update `API_BASE` in `index.html` if the
   Worker's actual URL differs from `tome-set-value.tomecollective.workers.dev`

## Not built yet (explicitly out of scope for this phase)

- **Phase 2**: printable checklist per set (every card in it), sourced from
  JustTCG's `/cards?set=` filter, long-term KV cached since set contents
  rarely change
- **Phase 3**: persisted owned/checked tracking across visits (needs
  accounts or local storage - a real step up in scope, not part of this
  build)
- Spike Report integration itself (the featured-set callout + link into
  this dashboard) - that's a content/editorial change on the Beehiiv side,
  not something this Worker does
