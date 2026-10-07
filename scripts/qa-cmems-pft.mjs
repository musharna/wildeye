#!/usr/bin/env node
/**
 * qa-cmems-pft.mjs — real-browser acceptance for the dominant phytoplankton group layer
 * (spec docs/superpowers/specs/2026-10-07-cmems-phytoplankton-types.md).
 * Run: node scripts/qa-cmems-pft.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, fixed 2026-10-07 for the September 2026 mean from an independent route, not pipeline/cmems_pft.py:
 * analysis/pft_cells.py selects each cell's 4 km pixels from the raw Copernicus dataset with xarray, keeps those where
 * all five groups exist, averages and takes the largest (docs/analysis/pft_cells.md). The clicks are read with the
 * time bar on 2026-09-15, so they keep reading the September frame after newer months arrive (frames are kept ~13
 * months). Proof it drew: the drape is in the globe's imagery stack once on, and not before.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'cmems-pft';
const MONTH = 'September 2026';
const OBSERVED = '2026-09-15T12:00:00Z';
const LABEL = {
  DIATO: 'diatoms',
  DINO: 'dinoflagellates',
  HAPTO: 'haptophytes (coccolithophores and relatives)',
  GREEN: 'green algae and prochlorophytes',
  PROKAR: 'prokaryotes (cyanobacteria)',
  clear: 'no satellite estimate: land, or no clear view this month (cloud, sea ice, polar night)',
};
// [lat, lon] of the cell centre, raw-derived group
const CELLS = {
  southernOcean: [-44.875, 20.125, 'DIATO'],
  southPacificGyre: [-24.875, -119.875, 'PROKAR'],
  northAtlanticGyre: [25.125, -49.875, 'PROKAR'],
  benguela: [-22.875, 14.125, 'DIATO'],
  peru: [-14.875, -75.875, 'GREEN'],
  arabianSea: [15.125, 62.125, 'HAPTO'],
  norwegianSea: [68.125, 5.125, 'DIATO'],
  beringShelf: [58.125, -169.875, 'DIATO'],
  javaSea: [-4.125, 111.125, 'HAPTO'],
  gulfOfGuinea: [-8.625, -5.625, 'GREEN'],
  weddellSea: [-71.875, -39.875, 'clear'],
  alps: [46.125, 10.125, 'clear'],
};
const LEGEND = [
  'diatoms',
  'dinoflagellates',
  'haptophytes (coccolithophores and relatives)',
  'green algae and prochlorophytes',
  'prokaryotes (cyanobacteria)',
  'group with the most chlorophyll in each cell, satellite estimate, monthly mean; clear = no satellite view',
];

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /phyto|pft|cmems|copernicus|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const onGlobe = () => page.evaluate((id) => window.__godsEyeView.drapeStack().some((d) => d.id === id && d.onGlobe), ID);
  const before = await onGlobe();
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  const s = enabled.stats;
  report('loaded', enabled.on && !s?.error && s?.count === 1 && /^\d{4}-\d{2}-01T00:00:00Z$/.test(s?.latest ?? '') && s?.frames >= 1,
    { latest: s?.latest, frames: s?.frames, error: s?.error });
  const after = await onGlobe();
  report('drawn-once-on', !before && after, { before, after });

  const read = (observed) => page.evaluate(async (id, cells, observed) => {
    const g = window.__godsEyeView;
    g.observedTime.set(observed);
    for (let i = 0; i < 40 && g.dataManager.getAll().find((l) => l.id === id)?.stats?.observed !== g.observedTime.get(); i += 1) await new Promise((r) => setTimeout(r, 100));
    const out = { bar: g.observedTime.get() };
    for (const [name, [lat, lon]] of Object.entries(cells)) {
      const rows = await g.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, CELLS, observed);

  const got = await read(OBSERVED);
  for (const [name, [, , want]] of Object.entries(CELLS)) {
    const r = got[name];
    report(`cell-${name}`, r?.status === 'class' && r.text === LABEL[want] && r.date === MONTH, { got: r?.text ?? r?.error ?? r?.status ?? null, date: r?.date ?? null, want: LABEL[want], bar: got.bar });
  }
  // Live (no time selected) reads the newest month; while that is September it must agree with the bar's reading.
  const live = await read(null);
  if (live.arabianSea?.date === MONTH) report('live-is-september', live.arabianSea.text === LABEL.HAPTO, { got: live.arabianSea.text });
  else report('live-newer-month', live.arabianSea?.status === 'class' && /^[A-Z][a-z]+ \d{4}$/.test(live.arabianSea?.date ?? ''), { got: live.arabianSea });

  // Read each where it is shown: the legend in this layer's own row, the credit in Cesium's credit display.
  const shown = await page.evaluate((id) => {
    const items = [...document.querySelectorAll(`.data-toggle-row[data-layer-id="${id}"] .data-toggle-legend-item`)].map((e) => e.textContent.trim());
    const nodes = [...document.querySelectorAll('[class*="credit"]')].filter((e) => !e.closest('.bio-card'));
    const credits = nodes.map((e) => e.textContent).join(' ');
    const links = nodes.flatMap((e) => [...e.querySelectorAll('a[href]')].map((a) => a.href));
    return { items, credits, links };
  }, ID);
  report('legend', JSON.stringify(shown.items) === JSON.stringify(LEGEND), { items: shown.items });
  report('credit', shown.credits.includes('Phytoplankton groups: Generated using E.U. Copernicus Marine Service Information')
    && shown.credits.includes('Global Ocean Colour (Copernicus-GlobColour)') && shown.links.includes('https://doi.org/10.48670/moi-00279'), {});

  // The share link is written on a debounce after the toggle (about 1-3 s, probed 2026-10-07): wait for it, not a sleep.
  const tokenRe = '[#&]l=([^&]*\\.)?pf(\\.|&|$)';
  await page.waitForFunction((re) => new RegExp(re).test(decodeURIComponent(location.href)), { timeout: 15000 }, tokenRe).catch(() => null);
  const share = await page.evaluate(() => location.href);
  report('share-token', new RegExp(tokenRe).test(decodeURIComponent(share)), { url: share.slice(0, 220) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
