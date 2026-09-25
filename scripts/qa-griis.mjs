#!/usr/bin/env node
/**
 * qa-griis.mjs — real-browser acceptance for the GRIIS introduced-species-by-checklist layer
 * (grill_wildeye_next_wave_2026-09-25, GRIIS mini-grill A26). Headless Chrome on swiftshader only.
 * Run: node scripts/qa-griis.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answer, read 2026-09-25 with zipfile + csv straight from the Samoa Darwin Core Archive
 * (GBIF dataset e4942a44…, version 2023-03-19, doi:10.15468/oyhwrm), not through pipeline/griis.py:
 * distribution.txt 386 rows, all Present / Alien; speciesprofile.txt 156 rows "Invasive".
 * Second basis: Belgium (version 2025-12-29) states invasiveness as degreeOfEstablishment, 4,215 / 97.
 * Negative controls: open Atlantic (-20, -30) and Taiwan (23.7, 121.0), land with no GRIIS list.
 * Proof it drew: a render pick at the screen centre over Australia hits a griis: entity with the layer on,
 * and nothing of it with the layer off. Off the time bar: the layer registers no observed extent.
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'griis';
const P = { samoa: [-13.95, -171.75], brussels: [50.85, 4.35], ocean: [-20.0, -30.0], taiwan: [23.7, 121.0] };
const AUS = [-25.0, 134.0];

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
let step = 'launch';
const consoleErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /GRIIS|griis|invasive|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  step = 'load';
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await sleep(12000);
  await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 60000 }).catch(() => {});

  // Entity polygons are tessellated asynchronously (slow under swiftshader, up to ~2 min for gmw), so a hit
  // is polled for up to `waitMs`; the layer-off pick waits a fixed 3 s and must find nothing of this layer.
  const pickCentre = (waitMs = 3000) => page.evaluate(async ([lat, lon], waitMs) => {
    const v = window.__godsEyeView.viewer;
    const c = v.scene.canvas;
    const t0 = Date.now();
    let id = null;
    let raw = null;
    do {
      v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 9000000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      await new Promise((r) => setTimeout(r, 1000));
      v.scene.render();
      const hit = v.scene.pick({ x: c.clientWidth / 2, y: c.clientHeight / 2 });
      id = hit?.id?.id ?? null;
      raw = hit ? (hit.id?.id ?? hit.primitive?.constructor?.name ?? 'unnamed') : null;
    } while (!String(id ?? '').startsWith('griis:') && Date.now() - t0 < waitMs);
    const cc = v.camera.positionCartographic;
    return { id, raw, cam: [+(cc.latitude * 180 / Math.PI).toFixed(2), +(cc.longitude * 180 / Math.PI).toFixed(2), Math.round(cc.height / 1000)], polls: Math.round((Date.now() - t0) / 1000) };
  }, AUS, waitMs);
  step = 'pick-before';
  const before = await pickCentre();
  step = 'enable';
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  step = 'pick-after';
  const after = await pickCentre(240000);
  const s = enabled.stats;
  report('loaded', enabled.on && !s?.error && s?.count === 229 && s?.notDrawn === 78 && s?.protectedAreas === 75,
    { count: s?.count, notDrawn: s?.notDrawn, protectedAreas: s?.protectedAreas, bins: s?.bins, error: s?.error });
  report('drew', !String(before.id ?? '').startsWith('griis:') && String(after.id ?? '').startsWith('griis:'), { before, after });

  step = 'extent';
  const extent = await page.evaluate((id) => window.__godsEyeView.observedTime.extents().get(id) ?? null, ID);
  report('off-the-time-bar', extent === null, { extent });

  step = 'readout';
  const live = await page.evaluate(async (id, points) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, P);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  report('known-samoa', live.samoa?.status === 'class' && live.samoa.date === '2023-03-19'
    && live.samoa.text === 'Introduced species on the GRIIS list: 386 · invasive 156 (evidence of impact) · Samoa list, 2023', { got: row(live.samoa) });
  report('known-belgium-spread', live.brussels?.status === 'class' && live.brussels.date === '2025-12-29'
    && live.brussels.text === 'Introduced species on the GRIIS list: 4,215 · invasive 97 (spreading) · Belgium list, 2025', { got: row(live.brussels) });
  const none = 'Not in an area with a drawn GRIIS list';
  report('negative-ocean', live.ocean?.status === 'class' && live.ocean.text === none, { got: row(live.ocean) });
  report('negative-taiwan', live.taiwan?.status === 'class' && live.taiwan.text === none, { got: row(live.taiwan) });
} catch (e) {
  report('run', false, { step, error: String(e?.message || (typeof e === 'object' ? JSON.stringify(e) : e)).slice(0, 300), stack: String(e?.stack || '').slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
