// Tome Analytics -- Health Check & Auto-Rollback
//
// Runs on a Cron Trigger (configured in Cloudflare dashboard, not in this file --
// browser-based setup, see monitoring/healthcheck/README.md).
//
// What this does, in order, every run:
//   1. Pings all three dashboard Worker APIs
//   2. Validates each response is not just HTTP 200, but actually shaped correctly
//      (has the expected top-level data key with real content)
//   3. Logs the result to KV so there's a status history, not just "last known state"
//   4. On any failure, posts a Discord alert with specifics (which dashboard, what
//      went wrong, when)
//   5. Attempts an automated rollback of the failing Worker to its last known-good
//      deployed version
//
// Step 5 (rollback) has been live-tested: a dashboard Worker was deliberately
// broken, the scheduled handler was triggered manually, and the Deployments tab
// confirmed traffic reverted to the prior known-good version. See the README for
// the exact procedure to re-run this test after future changes.
// If the rollback call fails for any reason, this still completes steps 1-4, so a
// human still gets alerted even if the auto-fix itself doesn't work.

// NOTE: url is kept only for logging/reference -- actual requests go through the
// service binding (see `binding` below), not a public fetch. Workers on
// *.workers.dev cannot fetch() other Workers' *.workers.dev URLs directly
// (Cloudflare blocks this as an anti-loop protection -- error 1042 / HTTP 404
// with no invocation of the target Worker). Service bindings route the request
// Worker-to-Worker internally and bypass that restriction entirely.
// The dashboard data routes are subscriber-gated (X-Tome-Key). This Worker
// presents TOME_SUBSCRIBER_KEY (encrypted variable) so the shape checks see
// the real payload; a missing/wrong key surfaces as a failure here rather
// than silently passing on a 401 or a teaser.
const TARGETS = [
  {
    name: "fastbreak",
    url: "https://tome-fastbreak.tomecollective.workers.dev/api/fastbreak",
    path: "/api/fastbreak",
    binding: "FASTBREAK_SERVICE",
    gated: true,
    validate: (data) => Array.isArray(data.players),
    scriptName: "tome-fastbreak", // must match the actual Worker's name in Cloudflare
  },
  {
    name: "tcg",
    url: "https://tome-tcg.tomecollective.workers.dev/api/chase-index",
    path: "/api/chase-index",
    binding: "TCG_SERVICE",
    gated: true,
    // A teaser (no/invalid key) has sets: [] -- treat that as a failure.
    validate: (data) => Array.isArray(data.sets) && data.sets.length > 0 && !data.teaser,
    scriptName: "tome-tcg",
  },
  {
    name: "topshot",
    url: "https://tome-topshot.tomecollective.workers.dev/api/topshot",
    path: "/api/topshot",
    binding: "TOPSHOT_SERVICE",
    validate: (data) => Array.isArray(data.moments),
    scriptName: "tome-topshot",
  },
];

async function checkTarget(target, env) {
  try {
    const service = env[target.binding];
    if (!service) {
      return { name: target.name, healthy: false, reason: `Missing service binding ${target.binding} -- bind it in Settings > Bindings` };
    }
    // Service binding fetch: routed Worker-to-Worker internally, not over the
    // public network, so the workers.dev-to-workers.dev restriction doesn't apply.
    const headers = {};
    if (target.gated) {
      if (!env.TOME_SUBSCRIBER_KEY) {
        return { name: target.name, healthy: false, reason: "TOME_SUBSCRIBER_KEY variable is not set on the healthcheck Worker (data routes are subscriber-gated)" };
      }
      headers["X-Tome-Key"] = env.TOME_SUBSCRIBER_KEY;
    }
    const res = await service.fetch(`https://${target.name}${target.path}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return { name: target.name, healthy: false, reason: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!target.validate(data)) {
      return { name: target.name, healthy: false, reason: "Response shape invalid -- got 200 but data doesn't match expected structure" };
    }
    return { name: target.name, healthy: true, reason: null };
  } catch (err) {
    return { name: target.name, healthy: false, reason: err.message || "Request failed or timed out" };
  }
}

// -- Freshness checks (alert only, never rollback) -----------------------------
// A stopped cron or a refresh that keeps failing leaves the data routes
// returning perfectly well-shaped, stale payloads -- invisible to the checks
// above. These read the pipelines' own status endpoints. Rolling back a
// deployment doesn't fix "the cron didn't run", so these only alert.
const FRESHNESS = [
  {
    name: "fastbreak-refresh",
    binding: "FASTBREAK_REFRESH_SERVICE", // -> tome-fastbreak-refresh
    path: "/api/fastbreak/health",
    check: (h) => {
      const problems = [];
      for (const [league, s] of Object.entries(h.leagues || {})) {
        const intervalMs = (s.cronIntervalMinutes || 30) * 60 * 1000;
        const window = 2 * intervalMs + 5 * 60 * 1000; // two ticks + slack
        if (s.lastCronTickAgeMs == null) problems.push(`${league}: cron has never ticked`);
        else if (s.lastCronTickAgeMs > window) problems.push(`${league}: cron last ticked ${Math.round(s.lastCronTickAgeMs / 60000)} min ago (expected every ${s.cronIntervalMinutes} min)`);
        if (!s.seasonActive) continue;
        if (s.lastCronError) problems.push(`${league}: last cron error: ${s.lastCronError}`);
        if (s.latestAgeMs == null) problems.push(`${league}: no latest snapshot in KV`);
        else if (s.latestAgeMs > window) problems.push(`${league}: latest snapshot is ${Math.round(s.latestAgeMs / 60000)} min old`);
        if (s.fulldataAgeMs != null && s.fulldataAgeMs > 30 * 60 * 60 * 1000) problems.push(`${league}: Full Data is ${Math.round(s.fulldataAgeMs / 3600000)} h old (rebuilds ~daily)`);
      }
      return problems;
    },
  },
  {
    name: "tcg-refresh",
    binding: "TCG_SERVICE",
    path: "/api/refresh-status",
    check: (st) => {
      const problems = [];
      if (!st || !st.ranAt) return ["no refresh has ever run (refresh:last_status missing)"];
      const ageMs = Date.now() - Date.parse(`${st.ranAt}T13:00:00Z`); // cron is 13:00 UTC
      if (st.published !== true) problems.push(`last run on ${st.ranAt} did not publish (${st.reason || `${st.failed}/${st.total} cards failed`})`);
      if (ageMs > 36 * 60 * 60 * 1000) problems.push(`last run was ${st.ranAt}, more than 36h ago`);
      return problems;
    },
  },
];

async function checkFreshness(target, env) {
  try {
    const service = env[target.binding];
    if (!service) return { name: target.name, healthy: false, reason: `Missing service binding ${target.binding} -- bind it in Settings > Bindings` };
    const res = await service.fetch(`https://${target.name}${target.path}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { name: target.name, healthy: false, reason: `HTTP ${res.status} from ${target.path}` };
    const problems = target.check(await res.json());
    return problems.length ? { name: target.name, healthy: false, reason: problems.join("; ") } : { name: target.name, healthy: true, reason: null };
  } catch (err) {
    return { name: target.name, healthy: false, reason: err.message || "Request failed or timed out" };
  }
}

async function alertDiscordFreshness(webhookUrl, failures) {
  const lines = failures.map(f => `- **${f.name}**: ${f.reason}`).join("\n");
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: `Tome Analytics data freshness warning (no rollback -- pipeline/cron issue, needs a look)\n${lines}` }),
  });
}

async function alertDiscord(webhookUrl, failures) {
  const lines = failures.map(f => `- **${f.name}**: ${f.reason}`).join("\n");
  const body = {
    content: `Tome Analytics health check failure\n${lines}\n\nAttempting automated rollback where possible -- check this channel for a follow-up message confirming whether that worked.`,
  };
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function alertDiscordRollbackResult(webhookUrl, target, success, detail) {
  const body = {
    content: success
      ? `Auto-rollback succeeded for **${target}** -- reverted to last known-good deployment.`
      : `Auto-rollback did NOT succeed for **${target}**: ${detail}\nThis needs a human to look at it directly.`,
  };
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Live-tested against Cloudflare's current Worker deployments API: a dashboard
// Worker was deliberately deployed with a broken response, the scheduled handler
// was triggered manually, and the Deployments tab confirmed traffic was actually
// reverted to the prior known-good version. See README for the test procedure.
async function attemptRollback(env, scriptName) {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    return { success: false, detail: "Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID env variable" };
  }

  try {
    // List deployments, find the second-most-recent (the last known-good one,
    // assuming the most recent is the one that just broke).
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
      { headers: { "Authorization": `Bearer ${apiToken}` } }
    );
    const listData = await listRes.json();
    if (!listData.success || !listData.result?.deployments?.length) {
      return { success: false, detail: "Could not list deployments -- check API token permissions (needs Workers Scripts edit)" };
    }

    const deployments = listData.result.deployments;
    if (deployments.length < 2) {
      return { success: false, detail: "No prior deployment to roll back to -- this is the first version" };
    }

    // [0] is the current/broken deployment, [1] is the last known-good one.
    const previousVersionId = deployments[1].versions?.[0]?.version_id;
    if (!previousVersionId) {
      return { success: false, detail: "Could not find a version_id on the previous deployment -- check the deployments API response shape" };
    }

    const rollbackRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          strategy: "percentage",
          versions: [{ version_id: previousVersionId, percentage: 100 }],
        }),
      }
    );
    const rollbackData = await rollbackRes.json();
    if (!rollbackData.success) {
      return { success: false, detail: JSON.stringify(rollbackData.errors || "Unknown API error") };
    }
    return { success: true, detail: null };
  } catch (err) {
    return { success: false, detail: err.message };
  }
}

export default {
  async fetch(request, env, ctx) {
    // Manual trigger for testing -- visit this Worker's URL directly to run a
    // check on demand instead of waiting for the next scheduled run.
    const [results, freshness] = await Promise.all([
      Promise.all(TARGETS.map(t => checkTarget(t, env))),
      Promise.all(FRESHNESS.map(t => checkFreshness(t, env))),
    ]);
    return new Response(JSON.stringify({ checked_at: new Date().toISOString(), results, freshness }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },

  async scheduled(event, env, ctx) {
    const [results, freshness] = await Promise.all([
      Promise.all(TARGETS.map(t => checkTarget(t, env))),
      Promise.all(FRESHNESS.map(t => checkFreshness(t, env))),
    ]);

    // Log every run to KV, not just failures, so there's a real history.
    const logEntry = { checked_at: new Date().toISOString(), results, freshness };
    await env.HEALTHCHECK_KV.put(`check:${Date.now()}`, JSON.stringify(logEntry));

    // Freshness problems: alert only. Re-alert at most once per 6 hours per
    // problem set so a stale pipeline doesn't spam the channel every hour.
    const staleFailures = freshness.filter(r => !r.healthy);
    if (staleFailures.length && env.DISCORD_WEBHOOK_URL) {
      const signature = staleFailures.map(f => `${f.name}:${f.reason}`).join("|");
      const last = await env.HEALTHCHECK_KV.get("freshness:last_alert", "json");
      if (!last || last.signature !== signature || Date.now() - last.at > 6 * 60 * 60 * 1000) {
        await alertDiscordFreshness(env.DISCORD_WEBHOOK_URL, staleFailures);
        await env.HEALTHCHECK_KV.put("freshness:last_alert", JSON.stringify({ signature, at: Date.now() }));
      }
    }

    const failures = results.filter(r => !r.healthy);
    if (failures.length === 0) return; // all healthy, nothing to do

    if (env.DISCORD_WEBHOOK_URL) {
      await alertDiscord(env.DISCORD_WEBHOOK_URL, failures);
    }

    for (const failure of failures) {
      const target = TARGETS.find(t => t.name === failure.name);
      const rollbackResult = await attemptRollback(env, target.scriptName);
      if (env.DISCORD_WEBHOOK_URL) {
        await alertDiscordRollbackResult(env.DISCORD_WEBHOOK_URL, failure.name, rollbackResult.success, rollbackResult.detail);
      }
    }
  },
};
