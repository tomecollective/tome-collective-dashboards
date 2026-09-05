// Headless-Chromium check of index.html against the real Worker code (no
// network): with no subscriber key the Worker's teaser renders (top 10, no
// pool, banner shown); with ?key= the full payload renders.
//   CHROMIUM_PATH=/path/to/chromium node dashboards/tcg/_frontend_test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, "worker", "_index.test-copy.mjs");
writeFileSync(tmp, readFileSync(path.join(here, "worker", "index.js"), "utf8").replace('from "../data/chase-50-modern-seed.json";', 'from "../data/chase-50-modern-seed.json" with { type: "json" };'));
let worker;
try { worker = (await import(tmp)).default; } finally { unlinkSync(tmp); }
const KEY = "local-test-subscriber-key";
const env = { CHASE_INDEX_KV: null, TOME_SUBSCRIBER_KEYS: KEY, TCG_ADMIN_TOKEN: "a" };
const ctx = { waitUntil() {} };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (e) => { throw e; });
await page.route("https://tome-tcg.tomecollective.workers.dev/**", async (route) => {
  const req = route.request();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers())) headers[k] = v;
  const res = await worker.fetch(new Request(req.url(), { method: req.method(), headers }), env, ctx);
  route.fulfill({ status: res.status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: await res.text() });
});
await page.route("https://cdnjs.cloudflare.com/**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "window.Chart=function(){return{destroy(){},update(){}}};" }));
await page.route("**/data/index-history.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

const url = pathToFileURL(path.join(here, "index.html")).href;
await page.goto(url);
await page.waitForFunction(() => getComputedStyle(document.querySelector("#teaser-banner")).display === "block");
const teaserRows = await page.$$eval("#holdings-body tr", (r) => r.length);
assert.ok(teaserRows > 0 && teaserRows <= 10, `teaser shows at most 10 holdings (got ${teaserRows})`);
assert.equal(await page.$eval("#pool-section", (el) => getComputedStyle(el).display), "none", "candidate pool hidden in teaser");
assert.equal(await page.$eval("#export-csv-btn", (el) => getComputedStyle(el).display), "none", "CSV export hidden in teaser");

await page.goto(`${url}?key=${KEY}`);
await page.waitForFunction(() => document.querySelectorAll("#holdings-body tr").length > 10);
assert.ok(!page.url().includes("key="), "key stripped from URL");
assert.equal(await page.evaluate(() => sessionStorage.getItem("tome_key")), KEY, "key in sessionStorage");
assert.equal(await page.$eval("#teaser-banner", (el) => getComputedStyle(el).display), "none", "no teaser banner for subscribers");
assert.ok((await page.$$eval("#sets-by-era .set-card", (r) => r.length)) > 10, "candidate pool rendered");
assert.equal(await page.$eval("#export-csv-btn", (el) => getComputedStyle(el).display !== "none"), true, "CSV export available");

await browser.close();
console.log("ALL TCG FRONTEND TESTS PASSED");
