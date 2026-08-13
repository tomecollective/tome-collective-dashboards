# Tome Analytics — Health Check & Auto-Rollback

## What this is
A fourth Worker, separate from the three dashboards, that runs on a schedule and checks whether
the other three are actually working — not just "responding," but returning real, correctly
shaped data. On failure, it posts to Discord and attempts to automatically roll the broken
Worker back to its last known-good version.

## Status as of 2026-08-12: live-tested. Detection and alerting work. Rollback is confirmed broken.

**Confident, verified working:** the health-check logic (steps 1-3) and Discord alerting
(step 4). Live-tested against the real fastbreak/tcg/topshot Workers — detection correctly
reported tcg and topshot healthy, and correctly caught a real fastbreak failure (an upstream
BALLDONTLIE API rate limit) as `HTTP 500`. Discord alerts posted correctly in both the failure
and rollback-result messages.

**Confirmed NOT working: the automated rollback (step 5).** Live-tested by deploying a harmless
change to fastbreak and manually triggering the `scheduled` handler. The rollback call failed
with:

```
code 10210: Invalid deployment: The value "[]" is invalid for field "versions" - check the
request details and try again.
```

Root cause: the Cloudflare Workers Deployments API does **not** accept a `deployment_id` field
when creating a new deployment. It requires a `versions` array, e.g.:

```json
{ "strategy": "percentage", "versions": [{ "version_id": "<version-id>", "percentage": 100 }] }
```

`index.js`'s `attemptRollback()` currently sends `{ deployment_id, strategy, force }`, which the
API rejects outright — it never even attempts the rollback. **Fix needed before relying on this
in a real incident:** change the POST body to the `versions` array format above, using the
previous deployment's version ID. Steps 1-4 (detection + alerting) still complete fine even
with this bug, so you'll always get alerted to a real failure — you just won't get the
auto-fix until this is patched.

## Additional setup this file didn't originally mention

Two pieces of required setup were missing from the original plan and had to be added directly
in the Cloudflare dashboard — the Worker will error without them:

- **A KV namespace bound as `HEALTHCHECK_KV`.** The `scheduled` handler writes every check
  result to KV for history; without this binding it throws before ever reaching the
  rollback/alert logic. Create a namespace (e.g. `tome_healthcheck_kv`) and bind it as
  `HEALTHCHECK_KV` under the Worker's Bindings tab.
- **Three Service Bindings**, one per dashboard: `FASTBREAK_SERVICE` → `tome-fastbreak`,
  `TCG_SERVICE` → `tome-tcg`, `TOPSHOT_SERVICE` → `tome-topshot`. Workers on `*.workers.dev`
  cannot call other Workers' `*.workers.dev` URLs via a plain `fetch()` — Cloudflare blocks this
  as anti-loop protection (error 1042 / HTTP 404, with the target Worker never actually
  invoked). Service Bindings route the request Worker-to-Worker internally and bypass that
  restriction, which is why `index.js` uses `env[target.binding].fetch(...)` instead of
  `fetch(target.url)`.

## Setup (browser-based, no CLI — same pattern as the other three Workers)

1. **Create a Discord webhook** (free, ~2 minutes): in any Discord server you control, go to a
   channel's Settings → Integrations → Webhooks → New Webhook. Copy the webhook URL.
2. **Create a Cloudflare API token** with Workers Scripts edit permission: Cloudflare dashboard
   → My Profile → API Tokens → Create Token → use the "Edit Cloudflare Workers" template, or a
   custom token scoped to Account.Workers Scripts.Edit only (don't use a token with broader
   permissions than this needs).
3. **Find your Cloudflare Account ID**: visible on the right sidebar of any Worker's overview
   page in the dashboard.
4. Create a new Worker named something like `tome-healthcheck`, paste in `index.js`'s contents.
5. In that Worker's Settings → Variables, add three **encrypted** variables:
   - `DISCORD_WEBHOOK_URL`
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
6. Create a KV namespace and bind it as `HEALTHCHECK_KV` (see "Additional setup" above).
7. Add three Service Bindings — `FASTBREAK_SERVICE`, `TCG_SERVICE`, `TOPSHOT_SERVICE` — pointing
   at the `tome-fastbreak`, `tome-tcg`, and `tome-topshot` Workers respectively (see "Additional
   setup" above).
8. In that Worker's Settings → Trigger events → Cron Triggers, add a schedule (e.g. `0 * * * *`
   for hourly).
9. Confirm the `TARGETS` array in `index.js` matches your real deployed Worker URLs and exact
   script names — this is what rollback uses to find the right deployment to revert, so it has
   to be exact.

## How rollback was tested (and how to re-test after fixing the bug above)

1. Picked fastbreak as the test subject.
2. Made a small, harmless change (a comment) in Quick Edit and deployed it — this created a new
   version to potentially roll back from.
3. Visited the healthcheck Worker's own URL directly — this runs the `fetch` handler, which is
   safe to run anytime (no rollback/alert side effects).
4. To test rollback specifically, opened the healthcheck Worker's Quick Edit page → the
   "Schedule" tab in the preview panel → **Trigger scheduled event**. This manually invokes the
   `scheduled` handler on demand, without needing to wait for or change the real cron schedule.
5. Checked fastbreak's Deployments tab: the harmless test version was **still active** — the
   rollback did not revert it. Cross-checked against the Discord alert, which correctly reported
   `"Auto-rollback did NOT succeed"` with the exact API error rather than failing silently.
6. Manually rolled fastbreak back to its pre-test version via the dashboard's own (working)
   rollback UI to restore it, confirming the Cloudflare rollback feature itself works fine — the
   bug is specifically in how `attemptRollback()` calls the API (see "Status" above).

## What this doesn't do

- Doesn't fix anything genuinely new — a rollback only helps when the *previous* version was
  working. A bug that's been broken since it was first deployed, or an external API that changed
  its contract entirely, still needs a real diagnostic pass (same as tonight's rate-limit work).
- Doesn't replace the diagnostic-prompt library idea — rollback handles "this specific thing
  regressed," not "here's a new kind of failure nobody's seen before."
