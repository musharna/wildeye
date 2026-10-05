#!/usr/bin/env node
/**
 * qa-share-drape.mjs — real-browser check that the share link names only the drape on the globe.
 * Run: heavy-run node scripts/qa-share-drape.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Clicks seagrass on, then mammals: the one-drape rule turns seagrass off. Before the fix that disable was
 * passive, so the link and the saved state kept seagrass, and a recipient's restore ended on seagrass (it
 * sorts after mammals) — the opposite of what the sender saw. Mammals is clicked last on purpose: it sorts
 * first, so a stale link restores the wrong drape and the reload check fails too, not only the hash check.
 */
import puppeteer from "puppeteer";
import { bootSettled } from "./bootSettled.mjs";
import { LAYER_STATE_REGISTRY, LAYER_STATE_STORAGE_KEY } from "../src/data/layerState.js";

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const FIRST = "seagrass", LAST = "mammals";
const token = (id) => LAYER_STATE_REGISTRY.find((e) => e.id === id).token;

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

const browser = await puppeteer.launch({
  headless: "new",
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const open = async (url) => {
  // A fresh context per page: the recipient must not inherit the sender's saved state.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.styleManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);
  return page;
};
const state = (page) =>
  page.evaluate((key) => ({
    enabled: [...window.__godsEyeView.dataManager.getEnabledLayerIds()],
    l: new URLSearchParams(window.location.hash.slice(1)).get("l"),
    hash: window.location.hash,
    saved: localStorage.getItem(key),
  }), LAYER_STATE_STORAGE_KEY);
// The row's own toggle button, the one a person clicks (its handler is the origin: 'user' path).
const clickToggle = (page, id) =>
  page.evaluate((layerId) => {
    const btn = document.querySelector(`[data-layer-id="${layerId}"] .data-toggle-btn`);
    if (!btn) throw new Error(`no toggle button for ${layerId}`);
    btn.click();
  }, id);
const waitOn = (page, id, on) =>
  page.waitForFunction((layerId, want) => window.__godsEyeView.dataManager.isEnabled(layerId) === want,
    { timeout: 120000, polling: 250 }, id, on);

try {
  const page = await open(SITE);
  await clickToggle(page, FIRST);
  await waitOn(page, FIRST, true);
  await clickToggle(page, LAST);
  await waitOn(page, LAST, true);
  await waitOn(page, FIRST, false);
  report("rule-turned-first-off", true, { first: FIRST, last: LAST });

  // The link is written on a 500 ms debounce: wait for the state the check is about, fail with what was there.
  const want = (l) => (l || "").split(".").includes(token(LAST)) && !(l || "").split(".").includes(token(FIRST));
  const settled = await page
    .waitForFunction((a, b) => {
      const l = (new URLSearchParams(window.location.hash.slice(1)).get("l") || "").split(".");
      return l.includes(a) && !l.includes(b);
    }, { timeout: 15000, polling: 250 }, token(LAST), token(FIRST))
    .then(() => true, () => false);
  const s = await state(page);
  report("hash-names-only-the-drape-on", settled && want(s.l), { l: s.l });
  const saved = JSON.parse(s.saved || "null")?.l || [];
  report("saved-state-names-only-the-drape-on", saved.includes(LAST) && !saved.includes(FIRST), { saved });

  // The recipient opens the link the sender would copy.
  const page2 = await open(`${new URL(SITE).origin}${new URL(SITE).pathname}${s.hash}`);
  await page2
    .waitForFunction((id) => window.__godsEyeView.dataManager.isEnabled(id), { timeout: 120000, polling: 250 }, LAST)
    .catch(() => {});
  const r = await state(page2);
  report("link-restores-the-drape-the-sender-saw", r.enabled.includes(LAST) && !r.enabled.includes(FIRST), {
    enabled: r.enabled.filter((id) => id === FIRST || id === LAST),
  });
  // Positive control: restoring is passive, the recipient's link stays the one that was sent.
  report("restore-keeps-the-link", r.l === s.l, { sent: s.l, now: r.l });

  report("no-page-errors", pageErrors.length === 0, { errors: pageErrors.slice(0, 3) });
} catch (e) {
  report("run", false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: true, checks: results.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
