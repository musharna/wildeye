#!/usr/bin/env node
/**
 * qa-reptiles.mjs — real-browser acceptance for the reptile richness layer (spec 2026-10-03-reptile-richness-design.md).
 * Run: node scripts/qa-reptiles.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, fixed 2026-10-03 before the layer was written: at 0.1° cell centres, the GARD 1.7 ranges (Zenodo
 * 6499637 shapefile, read with pyshp + shapely, not through pipeline/reptiles.py) whose raw shape intersects the cell,
 * by group: lizards, snakes, turtles, other. Greenland's ice, Antarctica and the open Pacific have none.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { countText, decodeCount } from '../src/data/reptiles.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'reptiles';
const CELLS = {
  malaysia: [[3.75, 101.75], [68, 102, 17, 2]],
  amazon: [[-3.05, -60.05], [47, 113, 13, 7]],
  australia: [[-25.05, 133.05], [82, 22, 0, 0]],
  madagascar: [[-18.95, 47.55], [20, 12, 1, 0]],
  texas: [[30.25, -97.75], [17, 37, 15, 1]],
  northlandTuatara: [[-35.45, 174.75], [7, 0, 0, 1]],
  sahara: [[23.05, 10.05], [14, 7, 0, 0]],
};
const NONE = { greenland: [72.05, -40.05], antarctica: [-80.05, 0.05], pacific: [0.05, -149.95] };
const want = ([l, s, t, o]) => countText(l + s + t + o, [l, s, t]);

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
const tiles = { ok: 0, bad: [], urls: new Set() };
let manifest = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /reptile|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/data/reptiles.json')) manifest = await r.json().catch(() => null);
    if (!/\/data\/reptiles\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had
    if (r.status() === 200 || r.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Share of warm yellow-orange (the ramp's rich end) at the globe's centre, rendered and read back in one task.
  const warmPixels = () => page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 100, src.height / 2 - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    let n = 0;
    // inferno above ~120 species: red high, green well up, blue below both; rainforest imagery is dark green
    for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] > 110 && d[i] - d[i + 2] > 60) n += 1;
    return n / (d.length / 4);
  });
  // Wait until reptile tile responses stop arriving (the globe's tilesLoaded is about terrain).
  const settle = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 180 && still < 8; i += 1) {
      await sleep(500);
      const n = tiles.ok + tiles.bad.length;
      still = n > 0 && n === last ? still + 1 : 0;
      last = n;
    }
  };
  const stats = () => page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);

  await page.evaluate(([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 600000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, CELLS.malaysia[0]);
  const before = await warmPixels();
  const tilesBefore = tiles.urls.size;
  // Another drape first: switching reptiles on must switch it off (one drape at a time).
  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('surface-water', true, { origin: 'user' });
    const otherOn = dataManager.isEnabled('surface-water');
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled('surface-water') };
  }, ID);
  await settle();
  const after = await warmPixels();
  const s1 = await stats();
  report('not-fetched-before-on', tilesBefore === 0, { tilesBefore });
  report('drew-warm-over-malaysia', state.on && after - before > 0.2 && !s1?.error && tiles.ok > 0 && tiles.bad.length === 0,
    { before: before.toFixed(4), after: after.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null;
    return out;
  }, ID, points);
  const got = await readAll(Object.fromEntries(Object.entries(CELLS).map(([k, [p]]) => [k, p])));
  for (const [name, [, counts]] of Object.entries(CELLS)) {
    const r = got[name];
    report(`cell-${name}`, r?.status === 'value' && r.text === want(counts) && r.date === 'GARD 1.7', { got: r?.text ?? r?.error ?? null, want: want(counts) });
  }
  const none = await readAll(NONE);
  for (const name of Object.keys(NONE)) {
    report(`none-${name}`, none[name]?.status === 'class' && none[name].text === 'No mapped reptile range', { got: none[name]?.text ?? none[name]?.error ?? null });
  }

  const text = await page.evaluate(() => document.body.textContent);
  report('legend-and-credit', text.includes('range overlaps each 0.1° cell') && text.includes('doi:10.1038/s41559-017-0332-2') && text.includes('doi:10.1371/journal.pbio.3001544') && text.includes('CC0 1.0'),
    { legend: text.includes('range overlaps each 0.1° cell'), roll: text.includes('doi:10.1038/s41559-017-0332-2'), caetano: text.includes('doi:10.1371/journal.pbio.3001544') });
  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?rp(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });

  // Every pixel of the real level-3 tiles fetched, decoded from the file's bytes by the site's own table, against
  // the matching group tile: a count decodes, and lizards + snakes + turtles never exceed it.
  const level3 = [...tiles.urls].filter((u) => /\/reptiles\/3\/\d+\/\d+\.png$/.test(u));
  let counted = 0, empty = 0, misfit = 0;
  const unknown = {};
  for (const u of level3) {
    const [res, gres] = await Promise.all([fetch(u), fetch(u.replace('/reptiles/3/', '/reptiles/groups/'))]);
    if (!res.ok || !gres.ok) { unknown[`HTTP ${res.status}/${gres.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    const { data: g } = await decodePng(new Uint8Array(await gres.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const v = decodeCount([data[i], data[i + 1], data[i + 2], data[i + 3]], manifest?.palette ?? []);
      if (v.kind === 'value') { counted += 1; if (g[i] + g[i + 1] + g[i + 2] > v.n || g[i + 3] !== 255) misfit += 1; }
      else if (v.kind === 'none') { empty += 1; if (g[i] + g[i + 1] + g[i + 2] !== 0) misfit += 1; }
      else unknown[data.slice(i, i + 4).join(',')] = (unknown[data.slice(i, i + 4).join(',')] || 0) + 1;
    }
  }
  report('every-pixel-decodes-and-fits', !!manifest && level3.length >= 1 && counted > 0 && empty > 0 && misfit === 0 && Object.keys(unknown).length === 0,
    { level3Tiles: level3.length, counted, empty, misfit, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-404-or-console-errors', tiles.bad.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
  { tilesBad: tiles.bad.slice(0, 5), consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok, tilesBad: tiles.bad.length }));
process.exit(failed ? 1 : 0);
