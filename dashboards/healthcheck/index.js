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
const TARGETS = [
  {
    name: "fastbreak",
    url: "https://tome-fastbreak.tomecollective.workers.dev/api/fastbreak",
    path: "/api/fastbreak",
    binding: "FASTBREAK_SERVICE",
    validate: (data) => Array.isArray(data.players),
    scriptName: "tome-fastbreak", // must match the actual Worker's name in Cloudflare
  },
  {
    name: "tcg",
    url: "https://tome-tcg.tomecollective.workers.dev/api/chase-index",
    path: "/api/chase-index",
    binding: "TCG_SERVICE",
    validate: (data) => Array.isArray(data.sets),
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
    const res = await service.fetch(`https://${target.name}${target.path}`, { signal: AbortSignal.timeout(10000) });
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
    const results = await Promise.all(TARGETS.map(t => checkTarget(t, env)));
    return new Response(JSON.stringify({ checked_at: new Date().toISOString(), results }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },

  async scheduled(event, env, ctx) {
    const results = await Promise.all(TARGETS.map(t => checkTarget(t, env)));

    // Log every run to KV, not just failures, so there's a real history.
    const logEntry = { checked_at: new Date().toISOString(), results };
    await env.HEALTHCHECK_KV.put(`check:${Date.now()}`, JSON.stringify(logEntry));

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
