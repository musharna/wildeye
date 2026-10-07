#!/usr/bin/env node
/**
 * qa-soil-bacteria.mjs — real-browser acceptance for the modelled soil bacterial richness layer
 * (spec docs/superpowers/specs/2026-10-07-soil-bacteria-design.md).
 * Run: node scripts/qa-soil-bacteria.mjs --truth <json from scripts/qa_soil_bacteria_truth.py> [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from an independent route, not pipeline/soil_bacteria.py: qa_soil_bacteria_truth.py reads the
 * raw netCDF files with xarray (h5netcdf) at each point with .sel(method="nearest"). Coastal points sit 0.04° from
 * their cell's centre toward the sea, on every side of Africa and Australia and on Chile's coast; four sit 0.01° from
 * the antimeridian on either side of it; two are ocean, where the model is blank. The layer is switched on by its share
 * token (#v=2&lat=..&lon=..&l=sb: a share link is read only with a position). Negative controls in the same run: each point's truth with mean and SD swapped, and its
 * inland neighbour's truth, must not match what the site shows; with the layer off the readout has no soil row.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const TRUTH_PATH = arg('--truth', null);
if (!TRUTH_PATH) {
  console.error('usage: node scripts/qa-soil-bacteria.mjs --truth <truth.json> [--url <site>]');
  process.exit(2);
}
const TRUTH = JSON.parse(fs.readFileSync(TRUTH_PATH, 'utf8'));
const ID = 'soil-bacteria';
const NONE = 'No modelled soil estimate';
const DATE = 'Bickel et al. 2026 model';
const n = (v) => v.toLocaleString('en-US');
// the readout line, written here from the spec rather than imported from the layer
const want = (mean, sd) => `≈${n(mean)} bacterial sequence variants per soil sample (model spread ±${n(sd)})`;
const LEVEL3 = /\/soil_bacteria\/3\/(\d+)\/(\d+)\.png(\?|$)/;
const VALUE = /\/soil_bacteria\/value\/(\d+)\/(\d+)\.png(\?|$)/;

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
    if (m.type() === 'error' && /soil|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/data/soil_bacteria.json')) manifest = await r.json().catch(() => null);
    if (!/\/data\/soil_bacteria\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had
    if (r.status() === 200 || r.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  const base = SITE.split('#')[0];
  // central Africa from 600 km, looking straight down: the drape reaches level 3 there
  await page.goto(`${base}#v=2&lat=2&lon=22&alt=600000&heading=0&pitch=-90&roll=0&l=sb`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);
  const stats = () => page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);
  await page.waitForFunction((id) => {
    const l = window.__godsEyeView.dataManager.getAll().find((x) => x.id === id);
    return window.__godsEyeView.dataManager.isEnabled(id) && (l?.stats?.lastUpdate || l?.stats?.error);
  }, { timeout: 60000 }, ID).catch(() => null);
  const s0 = await stats();
  const on = await page.evaluate((id) => window.__godsEyeView.dataManager.isEnabled(id), ID);
  report('share-token-turns-it-on', on && !!s0?.lastUpdate && !s0?.error && !!manifest, { on, stats: s0, manifest: !!manifest });
  const hash = await page.evaluate(() => new URLSearchParams(window.location.hash.slice(1)).get('l'));
  report('share-token-kept', (hash || '').split('.').includes('sb'), { l: hash });

  // Wait until soil tile responses stop arriving (the globe's tilesLoaded is about terrain).
  const settle = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 180 && still < 8; i += 1) {
      await sleep(500);
      const k = tiles.ok + tiles.bad.length;
      still = k > 0 && k === last ? still + 1 : 0;
      last = k;
    }
  };
  // Share of soil-ramp pixels (orange-brown to pale yellow) at the view's centre, rendered and read back in one task.
  const rampPixels = () => page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 100, src.height / 2 - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    let k = 0;
    // red high, red well above blue, green between: the YlOrBr ramp; forest is green-dominant, cloud grey
    for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i] - d[i + 2] > 60 && d[i + 1] > 60 && d[i] >= d[i + 1]) k += 1;
    return k / (d.length / 4);
  });
  await settle();
  const withLayer = await rampPixels();
  const drapeLevel3 = [...tiles.urls].filter((u) => LEVEL3.test(u)).length;
  await page.evaluate(async (id) => { await window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }); }, ID);
  const without = await rampPixels();
  report('drape-draws-the-ramp', withLayer - without > 0.3 && tiles.ok > 0 && tiles.bad.length === 0,
    { withLayer: withLayer.toFixed(4), without: without.toFixed(4), tiles200: tiles.ok });
  // the drape itself, before any readout (a readout fetches only value tiles), must reach level 3
  report('drape-draws-level-3', drapeLevel3 > 0, { drapeLevel3, tiles: tiles.urls.size });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = [];
    for (const p of pts) out.push((await window.__godsEyeView.readoutAt(p.lat, p.lon)).find((r) => r?.id === id) ?? null);
    return out;
  }, ID, points);
  // Negative control: with the layer off, the readout has no soil row at a land point.
  const off = await readAll(TRUTH.points.slice(0, 1));
  report('off-has-no-row', off[0] === null, { got: off[0] });
  // One drape at a time: another drape first, then this one turns it off (and the other way round).
  const drapes = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    const on = (x) => dataManager.isEnabled(x);
    await dataManager.setEnabled('surface-water', true, { origin: 'user' });
    const first = { other: on('surface-water'), soil: on(id) };
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const second = { other: on('surface-water'), soil: on(id) };
    await dataManager.setEnabled('surface-water', true, { origin: 'user' });
    const third = { other: on('surface-water'), soil: on(id) };
    await dataManager.setEnabled(id, true, { origin: 'user' });
    return { first, second, third, last: { other: on('surface-water'), soil: on(id) } };
  }, ID);
  const pairOk = (s, other, soil) => s.other === other && s.soil === soil;
  report('one-drape-at-a-time', pairOk(drapes.first, true, false) && pairOk(drapes.second, false, true) && pairOk(drapes.third, true, false) && pairOk(drapes.last, false, true), drapes);
  await page.waitForFunction((id) => window.__godsEyeView.dataManager.isEnabled(id), { timeout: 30000 }, ID);

  const got = await readAll(TRUTH.points);
  let controlsSeen = 0;
  TRUTH.points.forEach((p, i) => {
    const r = got[i];
    const text = r?.text ?? r?.error ?? null;
    const exact = r?.status === 'value' && r.text === want(p.mean, p.sd) && r.date === DATE;
    // the controls: the swapped pair and the inland neighbour must not read as this point (where they differ)
    const wrong = [want(p.sd, p.mean), p.neighbour && want(...p.neighbour)].filter((w) => w && w !== want(p.mean, p.sd));
    controlsSeen += wrong.length;
    report(`point-${p.name}`, exact && !wrong.includes(text), { lat: p.lat, lon: p.lon, got: text, want: want(p.mean, p.sd), controls: wrong.length });
  });
  report('controls-armed', controlsSeen >= TRUTH.points.length, { controlsSeen, points: TRUTH.points.length });
  const sea = await readAll(TRUTH.ocean);
  TRUTH.ocean.forEach((p, i) => {
    const r = sea[i];
    report(`ocean-${p.name}`, r?.status === 'class' && r.text === NONE && !/\d/.test(r.text), { got: r?.text ?? r?.error ?? null });
  });

  const text = await page.evaluate(() => document.body.textContent);
  const parts = { unit: 'sequence variants per soil sample', reads: '7,500 sequencing reads', locations: '320 sampled locations', r2: 'R² 0.41', model: 'not a survey', ice: 'ice sheet are model extrapolation with no soil samples behind them', paper: 'doi:10.1093/ismeco/ycag266', maps: 'Global maps of soil microbial and plant richness', licence: 'CC BY 4.0' };
  const seen = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, text.includes(v)]));
  report('legend-and-credit', Object.values(seen).every(Boolean), seen);

  // One real click: arm WHAT LIVES HERE, click the globe straight below the camera over the Sahara cell's centre,
  // and the card lists the soil row with the truth's numbers.
  const sahara = TRUTH.points.find((p) => p.name === 'Sahara');
  await page.evaluate(([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 400000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, sahara.cell);
  await page.waitForFunction(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded, { timeout: 60000 });
  await page.evaluate(() => {
    const panel = document.getElementById('species-panel');
    if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
  });
  const armAt = () => {
    const b = document.getElementById('species-what-lives-here');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return r.width > 0 && hit && (hit === b || b.contains(hit)) ? { x, y } : false;
  };
  const arm = await page.waitForFunction(armAt, { timeout: 30000 }).then((h) => h.jsonValue(), () => null);
  if (arm) await page.mouse.click(arm.x, arm.y);
  const centreAt = () => {
    const c = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    const x = c.left + c.width / 2, y = c.top + c.height / 2;
    return document.elementFromPoint(x, y) === window.__godsEyeView.viewer.scene.canvas ? { x, y } : false;
  };
  const centre = await page.waitForFunction(centreAt, { timeout: 30000 }).then((h) => h.jsonValue(), () => null);
  if (centre) await page.mouse.click(centre.x, centre.y);
  const card = await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('#bio-card .bio-card-layers li')].map((li) => li.textContent);
    const soil = items.find((t) => t.includes('bacterial') || t.includes('soil estimate'));
    return soil && !soil.includes('reading…') ? items : false;
  }, { timeout: 30000 }).then((h) => h.jsonValue(), () => page.evaluate(() => [...document.querySelectorAll('#bio-card .bio-card-layers li')].map((li) => li.textContent)));
  report('real-click-card', !!arm && !!centre && Array.isArray(card) && card.some((t) => t.includes(want(sahara.mean, sahara.sd))) && !card.some((t) => t.includes('⚠')),
    { arm: !!arm, centre: !!centre, card, want: want(sahara.mean, sahara.sd) });

  // Every pixel of every value tile the readouts fetched, decoded from the file's bytes, against the display tile at
  // the same place: a value lies in the build's ranges and its display pixel is its bin's colour; blank is transparent.
  const values = [...tiles.urls].filter((u) => VALUE.test(u));
  let counted = 0, blank = 0, misfit = 0;
  const odd = {};
  for (const u of values) {
    const [, x, y] = u.match(VALUE);
    const d = u.replace(VALUE, `/soil_bacteria/3/${x}/${y}.png$3`);
    const [vres, dres] = await Promise.all([fetch(u), fetch(d)]);
    if (!vres.ok || !dres.ok) { odd[`HTTP ${vres.status}/${dres.status} ${u}`] = 1; continue; }
    const { data: v } = await decodePng(new Uint8Array(await vres.arrayBuffer()));
    const { data: s } = await decodePng(new Uint8Array(await dres.arrayBuffer()));
    const { min, step, max } = manifest.display;
    for (let i = 0; i < v.length; i += 4) {
      const [r, g, b, a] = [v[i], v[i + 1], v[i + 2], v[i + 3]];
      if (a === 0 && r + g + b === 0) { blank += 1; if (s[i + 3] !== 0) misfit += 1; continue; }
      if (a !== 255) { odd[[r, g, b, a].join(',')] = (odd[[r, g, b, a].join(',')] || 0) + 1; continue; }
      const mean = r + 256 * (b % 16), sd = g + 256 * Math.floor(b / 16);
      counted += 1;
      const bin = Math.min(1 + Math.floor((mean - min) / step), (max - min) / step);
      const colour = manifest.palette[bin];
      if (mean < manifest.mean[0] || mean > manifest.mean[1] || sd < manifest.sd[0] || sd > manifest.sd[1]
        || s[i + 3] !== 255 || s[i] !== colour[0] || s[i + 1] !== colour[1] || s[i + 2] !== colour[2]) misfit += 1;
    }
  }
  report('every-value-pixel-decodes-and-matches-the-drape', !!manifest && values.length >= 4 && counted > 0 && blank > 0 && misfit === 0 && Object.keys(odd).length === 0,
    { valueTiles: values.length, counted, blank, misfit, odd: Object.fromEntries(Object.entries(odd).slice(0, 5)) });
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
