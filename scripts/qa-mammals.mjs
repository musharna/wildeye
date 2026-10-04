#!/usr/bin/env node
/**
 * qa-mammals.mjs — real-browser acceptance for the mammal richness layer (spec 2026-10-04-mammal-richness-design.md).
 * Run: node scripts/qa-mammals.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, fixed 2026-10-04 before the full release was tiled: at 0.1° cell centres, the MDD v1.2 ranges (the
 * GeoPackages in Zenodo 6644198's MDD_Mammalia.zip, read with sqlite + shapely, not through pipeline/mammals.py) whose
 * raw shape intersects the cell, by group: rodents, bats, primates, other. The last three are manatee coasts.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodeCount } from '../src/data/reptiles.js';
import { countText } from '../src/data/mammals.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'mammals';
const CELLS = {
  albertineRift: [[-1.05, 29.55], [67, 60, 14, 68]],
  centralAmazon: [[-3.05, -60.05], [26, 97, 11, 41]],
  andesEcuador: [[-0.95, -77.85], [50, 93, 8, 52]],
  borneo: [[1.05, 114.05], [31, 42, 9, 32]],
  madagascar: [[-18.95, 47.55], [2, 12, 0, 10]],
  texas: [[30.25, -97.75], [18, 10, 0, 20]],
  tasmania: [[-42.05, 146.55], [3, 7, 0, 20]],
  siberia: [[60.05, 100.05], [12, 2, 0, 25]],
  sahara: [[23.05, 10.05], [5, 2, 0, 9]],
  greenlandIce: [[72.05, -40.05], [0, 0, 0, 2]],
  midPacific: [[0.05, -149.95], [0, 0, 0, 25]],
  floridaBay: [[25.05, -80.75], [8, 10, 0, 46]],
  amazonAtSantarem: [[-2.45, -54.75], [31, 97, 9, 41]],
  saloumDelta: [[13.85, -16.65], [19, 31, 3, 37]],
};
const NONE = { antarctica: [-80.05, 0.05] };
// the richest cell: the drape must turn the view the ramp's rich end
const DRAPE = 'albertineRift';
const want = ([r, b, p, o]) => countText(r + b + p + o, [r, b, p]);
const LEVEL3 = /\/mammals\/3\/\d+\/\d+\.png(\?|$)/;

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
    if (m.type() === 'error' && /mammal|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/data/mammals.json')) manifest = await r.json().catch(() => null);
    if (!/\/data\/mammals\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had
    if (r.status() === 200 || r.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Share of the ramp's rich end (teal-green to pale yellow, above ~120 species) at the globe's centre, rendered and
  // read back in one task.
  const richPixels = () => page.evaluate(async () => {
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
    // green high and above blue, blue held down: rainforest imagery is dark green, cloud is grey-white
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 150 && d[i + 1] - d[i + 2] > 12 && d[i + 2] < 180) n += 1;
    return n / (d.length / 4);
  });
  // Wait until mammal tile responses stop arriving (the globe's tilesLoaded is about terrain).
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
  }, CELLS[DRAPE][0]);
  const before = await richPixels();
  const tilesBefore = tiles.urls.size;
  // Another drape first: switching mammals on must switch it off (one drape at a time).
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
  const after = await richPixels();
  const s1 = await stats();
  report('not-fetched-before-on', tilesBefore === 0, { tilesBefore });
  report(`drew-rich-over-${DRAPE}`, state.on && after - before > 0.2 && !s1?.error && tiles.ok > 0 && tiles.bad.length === 0,
    { before: before.toFixed(4), after: after.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  // The drape itself, before any readout (a readout fetches level-3 tiles on its own), must reach the exact level.
  const drapeLevel3 = [...tiles.urls].filter((u) => LEVEL3.test(u)).length;
  report('drape-draws-level-3', drapeLevel3 > 0, { drapeLevel3, tiles: tiles.urls.size });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null;
    return out;
  }, ID, points);
  const got = await readAll(Object.fromEntries(Object.entries(CELLS).map(([k, [p]]) => [k, p])));
  for (const [name, [, counts]] of Object.entries(CELLS)) {
    const r = got[name];
    report(`cell-${name}`, r?.status === 'value' && r.text === want(counts) && r.date === 'MDD v1.2 maps', { got: r?.text ?? r?.error ?? null, want: want(counts) });
  }
  const none = await readAll(NONE);
  for (const name of Object.keys(NONE)) {
    report(`none-${name}`, none[name]?.status === 'class' && none[name].text === 'No mapped mammal range', { got: none[name]?.text ?? none[name]?.error ?? null });
  }

  const text = await page.evaluate(() => document.body.textContent);
  report('legend-and-credit', text.includes('range overlaps each 0.1° cell') && text.includes('doi:10.1111/jbi.14330') && text.includes('Mammal Diversity Database v1.2') && text.includes('CC BY 4.0'),
    { legend: text.includes('range overlaps each 0.1° cell'), paper: text.includes('doi:10.1111/jbi.14330'), maps: text.includes('Mammal Diversity Database v1.2') });
  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?md(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });

  // Every pixel of the real level-3 tiles fetched, decoded from the file's bytes by the site's own table, against
  // the matching group tile: a count decodes, and rodents + bats + primates never exceed it.
  const level3 = [...tiles.urls].filter((u) => LEVEL3.test(u));
  let counted = 0, empty = 0, misfit = 0;
  const unknown = {};
  for (const u of level3) {
    const [res, gres] = await Promise.all([fetch(u), fetch(u.replace('/mammals/3/', '/mammals/groups/'))]);
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
