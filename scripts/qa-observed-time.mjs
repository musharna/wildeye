#!/usr/bin/env node
/**
 * qa-observed-time.mjs — real-browser checks that the shared observed-time scrubber reaches archived
 * birds frames, including nights well before the last two.
 * Run: node scripts/qa-observed-time.mjs [--url https://musharna.github.io/wildeye/] [--back-days 25] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 *
 * Why this exists: the deploy used to force-push the whole site, so KEEP_NIGHTS pruned the archive to 2
 * of its 31 nights and the 30-day scrubber had data only across its last two days. Nothing failed — the
 * slider still moved, the label still updated, and the layer fell back to live. The check that catches
 * that regression has to assert the page FETCHED a frame from the requested night, not that the UI moved.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const BACK_DAYS = Number(arg('--back-days', 25));
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
// `ok` is written LAST on purpose: a detail payload carrying its own `ok` (a fetch result, say) would
// otherwise overwrite the verdict and the check could never fail. It did, until 2026-09-20.
const report = (check, ok, detail) => { const row = { check, ...detail, ok }; results.push(row); console.log(JSON.stringify(row)); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
// Archive frame fetches, with their status: the only evidence that a scrub actually reached a night.
const frameFetches = [];
page.on('response', (r) => { if (r.url().includes('/data/birds_archive/') && !r.url().includes('manifest.json')) frameFetches.push({ url: r.url(), status: r.status() }); });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));

try {
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('birds', true));

  // 1. The scrubber appears for a layer that answers to observed time, and spans the full 30-day domain.
  await page.waitForSelector('#observed-time', { timeout: 120000 });
  // The bar hides itself until a layer that answers to observed time is actually enabled, and it
  // re-renders on the data manager's visibility-transition — which lands after the fade, not on the
  // setEnabled call. Reading `hidden` straight after enabling reads the pre-transition value.
  await page.waitForFunction(() => { const r = document.getElementById('observed-time'); return r && !r.hidden; }, { timeout: 120000 })
    .catch(() => {});
  const domain = await page.evaluate(() => {
    const root = document.getElementById('observed-time');
    const range = root?.querySelector('.ot-range');
    const box = root?.getBoundingClientRect();
    return { hiddenProp: !!root?.hidden, display: root ? getComputedStyle(root).display : null,
             onScreen: !!box && box.width > 0 && box.height > 0,
             max: Number(range?.max || 0), value: Number(range?.value || 0) };
  });
  // Asserts what the user gets: a scrubber on screen spanning 30 days of hourly steps (slack for rounding).
  // NOT root.hidden — that flag is unreliable here and says nothing about visibility: installObservedTimeUi
  // sets inline display:flex, which outranks the UA's [hidden]{display:none}, and the flag is not refreshed
  // when a layer is enabled through dataManager.setEnabled. Reported 2026-09-20; the bar shows regardless.
  report('slider-domain', domain.onScreen && domain.max >= 700 && domain.max <= 745, domain);

  // 2. The archive the manifest advertises is what the site can actually reach.
  const manifest = await page.evaluate(async (site) => {
    const res = await fetch(new URL('data/birds_archive/manifest.json', site).href);
    if (!res.ok) return { ok: false, status: res.status };
    const m = await res.json();
    const ids = Object.keys(m.frames || {}).sort();
    return { ok: true, frames: ids.length, nights: new Set(ids.map((i) => i.slice(0, 10))).size, first: ids[0], last: ids[ids.length - 1] };
  }, SITE);
  report('manifest-span', manifest.ok && manifest.nights >= 3, manifest);

  // 3. THE CHECK: scrub back BACK_DAYS and assert the page fetched a frame dated that far back.
  // A site shipping only the newest nights passes every UI assertion here and fails this one.
  const target = new Date(Date.now() - BACK_DAYS * 86400000);
  const wantDay = target.toISOString().slice(0, 10).replace(/-/g, '/'); // birds_archive/YYYY/MM/DD
  const before = frameFetches.length;
  await page.evaluate((days) => {
    const range = document.getElementById('observed-time').querySelector('.ot-range');
    // The slider's domain ends at "now", so N days back is N*24 hourly steps below its max.
    range.value = String(Math.max(0, Number(range.max) - days * 24));
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }, BACK_DAYS);
  await page.waitForFunction((n) => true, {}, 0).catch(() => {});
  // The layer debounces the seek, then fetches; poll rather than sleep a fixed time.
  const deadline = Date.now() + 60000;
  let hit = null;
  while (Date.now() < deadline && !hit) {
    hit = frameFetches.slice(before).find((f) => f.url.includes(`/birds_archive/${wantDay}/`));
    if (!hit) await new Promise((r) => setTimeout(r, 1000));
  }
  const label = await page.evaluate(() => document.getElementById('observed-time')?.querySelector('.ot-label')?.textContent || '');
  report('deep-history', !!hit && hit.status === 200, { backDays: BACK_DAYS, wantDay, fetched: hit?.url || null, status: hit?.status ?? null, label });

  // 4. LIVE returns the layer to live data, so a scrub is not a one-way door.
  await page.evaluate(() => document.getElementById('observed-time').querySelector('.ot-live').click());
  const backLive = await page.evaluate(() => (document.getElementById('observed-time')?.querySelector('.ot-label')?.textContent || '').toLowerCase());
  report('live-return', backLive.includes('live') || backLive.trim() === '', { label: backLive });

  report('no-page-errors', pageErrors.length === 0, { errors: pageErrors.slice(0, 3) });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/observed-time.png` });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: true, checks: results.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
