#!/usr/bin/env node
/**
 * qa-gmw.mjs — real-browser acceptance for the mangrove-extent-by-country layer (grill_wildeye_next_wave_2026-09-25 Q11, 3a).
 * Run: node scripts/qa-gmw.mjs [--url https://musharna.github.io/wildeye/] [--seed]
 * One JSON line per check; exits 1 when any check fails. --seed: the site serves the 20-country seed, so the
 * country count is not checked against 125 (Indonesia and Australia are in the seed).
 *
 * Known answers, read 2026-09-25 with openpyxl straight from the Zenodo xlsx (record 21346457, md5 3080…7a2),
 * not through pipeline/gmw.py: Indonesia 3,146,543.5 ha in 2025 (95%: 2,934,771.9–3,448,602.0), 3,391,813.9 ha in
 * 1995, 3,350,915.5 ha in 1985 → −6.1% and +1.2%. Negative controls: open Atlantic (-20, -30) and Mongolia
 * (47, 103), which has no mangrove. Proof it drew: a render pick at the screen centre over Australia hits a
 * gmw: entity with the layer on, and nothing of it with the layer off.
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const SEED = argv.includes('--seed');
const ID = 'gmw';
const P = { idn: [-1.5, 113.5], ocean: [-20.0, -30.0], mongolia: [47.0, 103.0] };
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
const consoleErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /GMW|gmw|mangrove|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await sleep(12000);
  await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 60000 }).catch(() => {});

  // Entity polygons are tessellated asynchronously (slow under swiftshader), so a hit is polled for up to
  // `waitMs`; the layer-off pick waits a fixed 3 s and must find nothing of this layer.
  // The view is set on every poll (app code may move the camera after load) and reported with the pick.
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
    } while (!String(id ?? '').startsWith('gmw:') && Date.now() - t0 < waitMs);
    const cc = v.camera.positionCartographic;
    return { id, raw, cam: [+(cc.latitude * 180 / Math.PI).toFixed(2), +(cc.longitude * 180 / Math.PI).toFixed(2), Math.round(cc.height / 1000)], polls: Math.round((Date.now() - t0) / 1000) };
  }, AUS, waitMs);
  const before = await pickCentre();
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  const after = await pickCentre(90000);
  const s = enabled.stats;
  report('loaded', enabled.on && !s?.error && (SEED ? s?.count >= 10 : s?.count === 125 && s?.missing === 4) && s?.year === 2025,
    { count: s?.count, missing: s?.missing, year: s?.year, version: s?.version, error: s?.error, classes: s?.classes });
  report('drew', !String(before.id ?? '').startsWith('gmw:') && String(after.id ?? '').startsWith('gmw:AUS:'), { before, after });

  const extent = await page.evaluate((id) => {
    const t = window.__godsEyeView.observedTime;
    return { mine: t.extents().get(id) ?? null, domainStart: t.domain()?.start ?? null };
  }, ID);
  report('time-bar-reaches-1985', extent.mine?.startMs === Date.UTC(1985, 0, 1) && extent.domainStart !== null && extent.domainStart <= Date.UTC(1985, 0, 1),
    { extent: extent.mine, domainStart: extent.domainStart && new Date(extent.domainStart).toISOString() });

  const read = (points) => page.evaluate(async (id, points) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const live = await read(P);
  report('known-2025', live.idn?.status === 'class' && live.idn.date === '2025' && live.idn.text === 'Indonesia: 3,146,544 ha (95%: 2,934,772–3,448,602), −6.1% since 1985', { got: row(live.idn) });
  const none = 'Not in a country with mapped mangroves';
  report('negative-ocean', live.ocean?.status === 'class' && live.ocean.text === none, { got: row(live.ocean) });
  report('negative-mongolia', live.mongolia?.status === 'class' && live.mongolia.text === none, { got: row(live.mongolia) });

  const year = await page.evaluate(async (id) => {
    const { dataManager, observedTime } = window.__godsEyeView;
    observedTime.set('1995-06-01T00:00:00Z');
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 40 && stats()?.year !== 1995; i += 1) await new Promise((r) => setTimeout(r, 250));
    return stats()?.year ?? null;
  }, ID);
  const past = await read({ idn: P.idn });
  await page.evaluate(() => window.__godsEyeView.observedTime.set(null));
  report('scrub-1995', year === 1995 && past.idn?.date === '1995' && /^Indonesia: 3,391,814 ha .*\+1\.2% since 1985$/.test(past.idn?.text ?? ''), { year, got: row(past.idn) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
