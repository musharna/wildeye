#!/usr/bin/env node
/**
 * qa-movebank.mjs — real-browser acceptance for the Movebank shelf in the animal-tracks layer
 * (grill_wildeye_next_wave_2026-09-25, Movebank mini-grill A37). Headless Chrome on swiftshader only.
 * Run: node scripts/qa-movebank.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answer, read 2026-09-25 with urllib + csv straight from the Movebank direct-read CSV
 * (study 19411459, jaguars, Pantanal, CC0; GPS events 2014-12-01..2015-12-01, 27,451 rows),
 * not through pipeline/movebank.py: Fera has the most fixes (8,156); first visible fix
 * 2014-12-05 17:58:00 at -57.4350692, -16.8760631 (next fix 2 min later, so segment 0 is drawn);
 * last 2015-11-30 23:00:13 at -57.4139944, -16.8777967. The file rounds to 4 decimals and keeps
 * both endpoints through thinning.
 * Negative controls: nothing outside the jaguar window; no '?' animal; the CC BY copy of the lion
 * study (3809257699) absent; a wildebeest capped by the 12-animal rule (Kayioni) absent.
 * Proof it drew: a render pick on Fera's first fix hits her track with the layer on, nothing with it off,
 * and the track is painted in the land-mammal colour.
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'tracks';
const FERA = { dataset: 'mb:19411459:Fera', first: '2014-12-05T17:58:00Z', firstAt: [-57.4351, -16.8761], last: '2015-11-30T23:00:13Z', lastAt: [-57.414, -16.8778] };
const WINDOW = ['2014-12-01T00:00:00Z', '2015-12-01T00:00:00Z'];
const GROUPS = ['WHALES & DOLPHINS', 'SEALS', 'LAND MAMMALS', 'BIRDS', 'REPTILES'];

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
    if (m.type() === 'error' && /Tracks|tracks|Movebank|Data/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  step = 'load';
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await sleep(12000);
  await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 60000 }).catch(() => {});

  // A polyline is 2-3 px wide: pick a 9x9 px box at the centre, camera straight down on the fix.
  const pickAt = (waitMs = 3000) => page.evaluate(async ([lon, lat], waitMs, prefix) => {
    const v = window.__godsEyeView.viewer;
    const c = v.scene.canvas;
    const t0 = Date.now();
    let ids = [];
    let color = null;
    do {
      v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 20000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      await new Promise((r) => setTimeout(r, 1000));
      v.scene.render();
      const hits = v.scene.drillPick({ x: c.clientWidth / 2, y: c.clientHeight / 2 }, 20, 9, 9);
      ids = hits.map((h) => String(h?.id?.id ?? '')).filter(Boolean);
      const mine = hits.find((h) => String(h?.id?.id ?? '').startsWith(prefix) && h.id.polyline);
      if (mine) color = mine.id.polyline.material.getValue(v.clock.currentTime).color.withAlpha(1).toCssHexString();
    } while (!ids.some((i) => i.startsWith(prefix)) && Date.now() - t0 < waitMs);
    return { ids: ids.slice(0, 6), color, polls: Math.round((Date.now() - t0) / 1000) };
  }, FERA.firstAt, waitMs, `trk:${FERA.dataset}:`);
  step = 'pick-before';
  const before = await pickAt();
  step = 'enable';
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    const rc = dataManager.layers.get(id)?.module?.getRowControls?.() ?? null;
    return { on: dataManager.isEnabled(id), stats: stats() ?? null, chips: rc?.chips?.map((c) => c.label.replace(/ \d+$/, '')) ?? null };
  }, ID);
  const s = enabled.stats;
  report('loaded', enabled.on && !s?.error && s?.count > 0 && s?.species >= 20,
    { count: s?.count, species: s?.species, error: s?.error });
  report('group-chips', JSON.stringify(enabled.chips) === JSON.stringify(GROUPS), { chips: enabled.chips });
  step = 'pick-after';
  const after = await pickAt(240000);
  const landMammal = '#ffb74d';
  report('drew', !before.ids.some((i) => i.startsWith(`trk:${FERA.dataset}:`)) && after.ids.some((i) => i.startsWith(`trk:${FERA.dataset}:`)) && after.color === landMammal,
    { before, after, expectColor: landMammal });

  step = 'file';
  const f = await page.evaluate(async (fera, win) => {
    const gj = await (await fetch(`data/tracks.geojson?t=${Date.now()}`)).json();
    const P = gj.features.map((x) => x.properties);
    const mine = gj.features.filter((x) => x.properties.dataset === fera.dataset);
    const all = mine.flatMap((x) => x.properties.times.map((t, i) => [t, x.geometry.coordinates[i]])).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const jag = P.filter((p) => String(p.dataset).startsWith('mb:19411459:')).flatMap((p) => p.times);
    return {
      segments: mine.length,
      first: all[0] ?? null,
      last: all.at(-1) ?? null,
      outside: jag.filter((t) => t < win[0] || t >= win[1]).length,
      jagFixes: jag.length,
      unknown: P.filter((p) => String(p.dataset).startsWith('mb:') && /:\?$/.test(p.dataset)).length,
      dupLion: P.filter((p) => String(p.dataset).startsWith('mb:3809257699:')).length,
      capped: P.filter((p) => p.dataset === 'mb:208413731:Kayioni').length,
      wildebeest: new Set(P.filter((p) => String(p.dataset).startsWith('mb:208413731:')).map((p) => p.dataset)).size,
      humans: P.filter((p) => /^homo sapiens/i.test(p.sci ?? '')).length,
      groups: gj.groups,
    };
  }, FERA, WINDOW);
  report('known-fera-first-fix', f.first?.[0] === FERA.first && JSON.stringify(f.first?.[1]) === JSON.stringify(FERA.firstAt), { got: f.first, segments: f.segments });
  report('known-fera-last-fix', f.last?.[0] === FERA.last && JSON.stringify(f.last?.[1]) === JSON.stringify(FERA.lastAt), { got: f.last });
  report('negative-window', f.jagFixes > 0 && f.outside === 0, { jagFixes: f.jagFixes, outside: f.outside });
  report('negative-excluded', f.unknown === 0 && f.dupLion === 0 && f.capped === 0 && f.wildebeest === 12 && f.humans === 0,
    { unknown: f.unknown, dupLion: f.dupLion, capped: f.capped, wildebeestKept: f.wildebeest, humans: f.humans });
} catch (e) {
  report('run', false, { step, error: String(e?.message || (typeof e === 'object' ? JSON.stringify(e) : e)).slice(0, 300), stack: String(e?.stack || '').slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
