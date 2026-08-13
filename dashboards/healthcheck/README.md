# Tome Analytics -- Health Check & Auto-Rollback

## What this is
A fourth Worker, separate from the three dashboards, that runs on a schedule and checks whether
the other three are actually working -- not just "responding," but returning real, correctly
shaped data. On failure, it posts to Discord and attempts to automatically roll the broken
Worker back to its last known-good version.

## Status as of 2026-08-13: live-tested end to end. Detection, alerting, and rollback all work.

**Confident, verified working:** the health-check logic (steps 1-3) and Discord alerting
(step 4). Live-tested against the real fastbreak/tcg/topshot Workers -- detection correctly
reported tcg and topshot healthy, and correctly caught a real fastbreak failure (an upstream
BALLDONTLIE API rate limit) as `HTTP 500`. Discord alerts posted correctly in both the failure
and rollback-result messages.

**Now confirmed working: the automated rollback (step 5).** This was previously broken --
`attemptRollback()` sent `{ deployment_id, strategy, force }`, which the Cloudflare Workers
Deployments API rejects outright (`code 10210: Invalid deployment: The value "[]" is invalid
for field "versions"`). Root cause: the API does not accept a `deployment_id` field. It requires
a `versions` array, e.g.:

```json
{ "strategy": "percentage", "versions": [{ "version_id": "<version-id>", "percentage": 100 }] }
```

`attemptRollback()` was updated to build the request this way, using the previous deployment's
`version_id` (read from `deployments[1].versions[0].version_id` in the deployments list). This
was then live-tested (see "How rollback was tested" below) -- the scheduled handler correctly
detected a deliberately-broken dashboard Worker and reverted it to its last known-good version,
confirmed via that Worker's own Deployments tab showing the prior version active again.

## Additional setup this file didn't originally mention

Two pieces of required setup were missing from the original plan and had to be added directly
in the Cloudflare dashboard -- the Worker will error without them:

- **A KV namespace bound as `HEALTHCHECK_KV`.** The `scheduled` handler writes every check
  result to KV for history; without this binding it throws before ever reaching the
  rollback/alert logic. Create a namespace (e.g. `tome_healthcheck_kv`) and bind it as
  `HEALTHCHECK_KV` under the Worker's Bindings tab.
- **Three Service Bindings**, one per dashboard: `FASTBREAK_SERVICE` -> `tome-fastbreak`,
  `TCG_SERVICE` -> `tome-tcg`, `TOPSHOT_SERVICE` -> `tome-topshot`. Workers on `*.workers.dev`
  cannot call other Workers' `*.workers.dev` URLs via a plain `fetch()` -- Cloudflare blocks this
  as anti-loop protection (error 1042 / HTTP 404, with the target Worker never actually
  invoked). Service Bindings route the request Worker-to-Worker internally and bypass that
  restriction, which is why `index.js` uses `env[target.binding].fetch(...)` instead of
  `fetch(target.url)`.

## Setup (browser-based, no CLI -- same pattern as the other three Workers)

1. **Create a Discord webhook** (free, ~2 minutes): in any Discord server you control, go to a
   channel's Settings -> Integrations -> Webhooks -> New Webhook. Copy the webhook URL.
2. **Create a Cloudflare API token** with Workers Scripts edit permission: Cloudflare dashboard
   -> My Profile -> API Tokens -> Create Token -> use the "Edit Cloudflare Workers" template, or a
   custom token scoped to Account.Workers Scripts.Edit only (don't use a token with broader
   permissions than this needs).
3. **Find your Cloudflare Account ID**: visible on the right sidebar of any Worker's overview
   page in the dashboard.
4. Create a new Worker named something like `tome-healthcheck`, paste in `index.js`'s contents.
5. In that Worker's Settings -> Variables, add three **encrypted** variables:
   - `DISCORD_WEBHOOK_URL`
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
6. Create a KV namespace and bind it as `HEALTHCHECK_KV` (see "Additional setup" above).
7. Add three Service Bindings -- `FASTBREAK_SERVICE`, `TCG_SERVICE`, `TOPSHOT_SERVICE` -- pointing
   at the `tome-fastbreak`, `tome-tcg`, and `tome-topshot` Workers respectively (see "Additional
   setup" above).
8. In that Worker's Settings -> Trigger events -> Cron Triggers, add a schedule (e.g. `0 * * * *`
   for hourly).
9. Confirm the `TARGETS` array in `index.js` matches your real deployed Worker URLs and exact
   script names -- this is what rollback uses to find the right deployment to revert, so it has
   to be exact.

## How rollback was tested (and how to re-test after future changes)

1. Picked topshot as the test subject and noted its currently-active version ID on its
   Deployments tab (the last known-good version to watch for).
2. In topshot's Quick Edit, added one deliberate, obviously-temporary line to `/api/topshot`
   that returns `HTTP 500` with a clearly-labeled test error body, and deployed it -- this created
   a new, intentionally-broken version.
3. Confirmed the break was actually live by fetching topshot's public URL directly.
4. Opened the healthcheck Worker's Quick Edit page -> the "Schedule" tab in the preview panel ->
   **Trigger scheduled event**. This manually invokes the `scheduled` handler on demand, without
   needing to wait for or change the real cron schedule.
5. Checked topshot's Deployments tab: the **prior known-good version was active again**, with
   100% traffic, deployed moments after the trigger -- the rollback genuinely reverted it, not
   just logged an attempt.
6. Re-fetched topshot's public URL directly and confirmed it was serving real, correctly-shaped
   data again, not the test error.

## What this doesn't do

- Doesn't fix anything genuinely new -- a rollback only helps when the *previous* version was
  working. A bug that's been broken since it was first deployed, or an external API that changed
  its contract entirely, still needs a real diagnostic pass (same as tonight's rate-limit work).
- Doesn't replace the diagnostic-prompt library idea -- rollback handles "this specific thing
  regressed," not "here's a new kind of failure nobody's seen before."
