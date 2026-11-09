// Collection route check. Run before each deploy against `wrangler dev --remote`
// (your local code, the real KV), and after deploy against production.
//
//   node _collection_test.mjs <base-url> <username-or-0xaddress>
//   e.g.  node _collection_test.mjs http://localhost:8787 0x1234abcd5678ef90
//         node _collection_test.mjs https://tome-topshot.tomecollective.workers.dev Witty
//
// Auth: set TOME_ADMIN_TOKEN (topshot admin token) or TOME_KEY (a subscriber
// key) in the environment. Prints counts only, never Moment ids.
// Asserts: the account resolves, has Moments, and >95% of them join to the
// index (player identity found). Re-reads until no plays are pending, since a
// first read of a large collection may still be looking up new plays.

const [base, user] = process.argv.slice(2);
if (!base || !user) {
  console.error("usage: node _collection_test.mjs <base-url> <username-or-0xaddress>");
  process.exit(2);
}
const headers = {};
if (process.env.TOME_ADMIN_TOKEN) headers["X-Admin-Token"] = process.env.TOME_ADMIN_TOKEN;
if (process.env.TOME_KEY) headers["X-Tome-Key"] = process.env.TOME_KEY;

async function read(refresh) {
  const u = `${base.replace(/\/$/, "")}/api/topshot/collection?user=${encodeURIComponent(user)}${refresh ? "&refresh=1" : ""}`;
  const res = await fetch(u, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let { status, body } = await read(false);
for (let i = 0; i < 6 && status === 200 && body.pendingPlays > 0; i++) {
  ({ status, body } = await read(true));
}
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
if (status !== 200) fail(`HTTP ${status}: ${body.error || JSON.stringify(body).slice(0, 200)}`);
if (!body.resolved) fail(`not resolved: ${body.message}`);
const joined = body.count - body.unindexed;
const rate = body.count ? joined / body.count : 0;
console.log(JSON.stringify({
  resolved: body.resolved,
  username: body.username,
  count: body.count,
  totalOwned: body.totalOwned,
  truncated: body.truncated,
  unindexed: body.unindexed,
  pendingPlays: body.pendingPlays,
  players: body.players.length,
  joinRate: `${(rate * 100).toFixed(1)}%`,
  cached: body.cached,
  updatedAt: body.updatedAt,
}, null, 2));
if (!body.count) fail("collection is empty");
if (rate <= 0.95) fail(`join rate ${(rate * 100).toFixed(1)}% is not above 95%`);
console.log("PASS");
