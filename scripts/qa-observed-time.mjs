#!/usr/bin/env node
/**
 * qa-observed-time.mjs — real-browser checks that the shared observed-time scrubber spans exactly the
 * data the enabled layers hold, and reaches archived birds frames well before the last two nights.
 * Run: node scripts/qa-observed-time.mjs [--url https://musharna.github.io/wildeye/] [--back-days 25] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 *
 * Why this exists, twice over:
 *  - The deploy used to force-push the whole site, so KEEP_NIGHTS pruned the archive to 2 of its 31
 *    nights and the scrubber had data across only its last two days. Nothing failed — the slider still
 *    moved, the label still updated, the layer fell back to live. Catching that needs an assertion that
 *    the page FETCHED a frame from the requested night, not that the UI moved (`deep-history`).
 *  - The bar's span was then a 30-day constant applied to `now`, invented in the store and never
 *    checked against a layer. The birds archive is a fixed backfill, so once it stopped advancing the
 *    slider addressed hours with no frame behind them — 12 of its 30 days by 2026-09-22. Catching that
 *    needs the span compared against the manifest (`domain-matches-data`).
 *
 * The slider's step now scales with the span, so nothing here may assume a notch is an hour: seeks are
 * computed from the live domain and driven through the real range input.
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

/** Read the bar's live state: what it spans, what declared it, and what is on screen. */
const barState = () =>
  page.evaluate(() => {
    const store = window.__godsEyeView?.observedTime;
    const root = document.getElementById('observed-time');
    const range = root?.querySelector('.ot-range');
    const box = root?.getBoundingClientRect();
    const d = store?.domain() || null;
    return {
      domain: d ? { start: d.start, end: d.end, stepMs: d.stepMs } : null,
      extents: store ? [...store.extents()].map(([id, e]) => [id, e]) : [],
      max: Number(range?.max || 0),
      value: Number(range?.value || 0),
      label: root?.querySelector('.ot-label')?.textContent || '',
      onScreen: !!box && box.width > 0 && box.height > 0,
      display: root ? getComputedStyle(root).display : null,
    };
  });

/** Drive the real range input to an instant, computed from the live domain (step-agnostic). */
const seekTo = (targetMs) =>
  page.evaluate((ms) => {
    const store = window.__godsEyeView.observedTime;
    const d = store.domain();
    const range = document.getElementById('observed-time').querySelector('.ot-range');
    const notch = Math.round((ms - d.start) / d.stepMs);
    range.value = String(Math.max(0, Math.min(Number(range.max), notch)));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    return { requested: ms, landedOn: store.get(), notch, max: Number(range.max) };
  }, targetMs);

const waitForFrame = async (from, wantDay, ms = 60000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = frameFetches.slice(from).find((f) => f.url.includes(`/birds_archive/${wantDay}/`));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};

try {
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });

  // Birds alone among the observed layers, so the bar's span has exactly one declared source and the
  // comparison against the manifest is exact rather than a union of many layers' spans.
  const isolated = await page.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    const observed = [...dataManager.layers].filter(([, e]) => typeof e.module.getObservedExtent === 'function').map(([id]) => id);
    for (const id of observed) if (id !== 'birds' && dataManager.isEnabled(id)) await dataManager.setEnabled(id, false);
    await dataManager.setEnabled('birds', true);
    return { observed, stillOn: observed.filter((id) => dataManager.isEnabled(id)) };
  });
  await page.waitForSelector('#observed-time', { timeout: 120000 });
  await page.waitForFunction(() => !!window.__godsEyeView.observedTime.domain(), { timeout: 120000 }).catch(() => {});

  // 1. The archive the manifest advertises is what the site can actually reach.
  const manifest = await page.evaluate(async (site) => {
    const res = await fetch(new URL('data/birds_archive/manifest.json', site).href);
    if (!res.ok) return { fetched: false, status: res.status };
    const m = await res.json();
    const ids = Object.keys(m.frames || {}).sort();
    return { fetched: true, frames: ids.length, nights: new Set(ids.map((i) => i.slice(0, 10))).size,
             first: ids[0], last: ids[ids.length - 1],
             firstMs: Date.parse(`${ids[0]}:00:00Z`), lastMs: Date.parse(`${ids[ids.length - 1]}:00:00Z`) };
  }, SITE);
  report('manifest-span', manifest.fetched && manifest.nights >= 3, manifest);

  // 2. THE SPAN CHECK: with birds the only observed layer on, the bar spans the archive and nothing
  // more. A 30-day window anchored on `now` fails here the moment the archive stops at an older date,
  // which is exactly the state the site was in on 2026-09-22 (archive ended 2026-09-10).
  const state = await barState();
  const endsAtData = state.domain && manifest.lastMs && state.domain.end === manifest.lastMs;
  const startsAtData = state.domain && manifest.firstMs && state.domain.start === manifest.firstMs;
  report('domain-matches-data', !!(endsAtData && startsAtData && state.onScreen), {
    onlyObservedLayerOn: isolated.stillOn,
    domainStart: state.domain && new Date(state.domain.start).toISOString(),
    domainEnd: state.domain && new Date(state.domain.end).toISOString(),
    archiveFirst: manifest.first, archiveLast: manifest.last,
    hoursOfferedPastTheData: state.domain ? Math.round((state.domain.end - manifest.lastMs) / 3600000) : null,
    extents: state.extents, onScreen: state.onScreen,
  });

  // 3. The slider covers the whole span at its own step, and is actually on screen.
  const notchSpan = state.domain ? state.max * state.domain.stepMs : 0;
  const span = state.domain ? state.domain.end - state.domain.start : 0;
  report('slider-domain', !!(state.onScreen && state.max > 0 && Math.abs(notchSpan - span) <= state.domain.stepMs), {
    max: state.max, stepMs: state.domain?.stepMs ?? null, spanHours: Math.round(span / 3600000),
    notchSpanHours: Math.round(notchSpan / 3600000), display: state.display,
  });

  // 4. Scrub back BACK_DAYS and assert the page fetched a frame dated that far back. A site shipping
  // only the newest nights passes every UI assertion and fails this one.
  const targetMs = Date.now() - BACK_DAYS * 86400000;
  const wantDay = new Date(targetMs).toISOString().slice(0, 10).replace(/-/g, '/');
  const before = frameFetches.length;
  const seek = await seekTo(targetMs);
  const hit = await waitForFrame(before, wantDay);
  report('deep-history', !!hit && hit.status === 200, {
    backDays: BACK_DAYS, wantDay, seek, fetched: hit?.url || null, status: hit?.status ?? null,
    label: (await barState()).label,
  });

  // 5. LIVE returns the layer to live data, so a scrub is not a one-way door.
  await page.evaluate(() => document.getElementById('observed-time').querySelector('.ot-live').click());
  const backLive = (await barState()).label.toLowerCase();
  report('live-return', backLive.includes('live') || backLive.trim() === '', { label: backLive });

  // 6. Enable a layer WHILE the bar is already in the past. Until 2026-09-20 this silently showed live
  // data under a past timestamp: the bridge waited for a visibility-transition carrying
  // lifecycleState 'enabled', which the manager never sends (settled visibility is type 'visibility').
  // Order matters — scrub first, enable second — so the layer cannot have been handed the time on the
  // way in. A check that enables first can pass on the broken code. The scrub needs a second layer's
  // extent to stand on, since with birds off its own extent is withdrawn and the bar has no domain.
  await page.evaluate(() => window.__godsEyeView.observedTime.setLayerExtent('qa-probe', { rollingDays: 40 }));
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('birds', false));
  const targetMs2 = Date.now() - (BACK_DAYS - 1) * 86400000;
  const wantDay2 = new Date(targetMs2).toISOString().slice(0, 10).replace(/-/g, '/');
  const seek2 = await seekTo(targetMs2);
  const before2 = frameFetches.length;
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('birds', true));
  const hit2 = await waitForFrame(before2, wantDay2);
  report('enable-while-scrubbed', !!hit2 && hit2.status === 200, {
    wantDay: wantDay2, seek: seek2, fetched: hit2?.url || null, status: hit2?.status ?? null,
  });
  await page.evaluate(() => window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null));

  report('no-page-errors', pageErrors.length === 0, { errors: pageErrors.slice(0, 3) });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/observed-time.png` });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: true, checks: results.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
