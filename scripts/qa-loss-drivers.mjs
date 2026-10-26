#!/usr/bin/env node
/**
 * qa-loss-drivers.mjs — real-browser acceptance for the forest loss drivers drape (src/data/lossDrivers.js).
 * Run: node scripts/qa-loss-drivers.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Two halves: (1) the live sources still say what lossDrivers.js pins (the dataset's licence and version, GFW's
 * renderer colours, a level-12 tile); (2) the site draws the tiles, turns forest loss off, and the click readout at a
 * known point per driver, and at a no-driver point, names the class the raw GeoTIFF has there
 * (docs/analysis/loss_drivers_samples.tsv, read from the raw data by analysis/loss_drivers_tiles_vs_raw.py).
 */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { DRIVERS, MAX_LEVEL, driversTileUrl } from '../src/data/lossDrivers.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'loss-drivers';
const OTHER = 'hansen-loss';
const PREFIX = driversTileUrl('{z}', '{x}', '{y}').slice(0, driversTileUrl('{z}', '{x}', '{y}').indexOf('{z}'));
const RENDERER = 'https://raw.githubusercontent.com/wri/gfw-tile-cache/production/app/routes/titiler/algorithms/tree_cover_loss_drivers.py';

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (1) the live sources
const meta = (await (await fetch('https://data-api.globalforestwatch.org/dataset/wri_google_tree_cover_loss_drivers')).json()).data;
report('source:licence-and-version', /^CC by 4\.0$/i.test(meta.metadata.license) && meta.versions.includes('v1.13'),
  { license: meta.metadata.license, versions: meta.versions });
const code = await (await fetch(RENDERER)).text();
const served = Object.fromEntries([...code.matchAll(/(\d): Colors\((\d+), (\d+), (\d+)\)/g)].map((m) => [Number(m[1]), [m[2], m[3], m[4]].map(Number)]));
const pinned = Object.fromEntries(DRIVERS.map((d) => [d.code, [...d.rgb]]));
report('source:renderer-colours', JSON.stringify(served) === JSON.stringify(pinned), { served, pinned });
const t12 = await fetch(driversTileUrl(12, 1365, 2082));
const img = t12.ok ? await decodePng(new Uint8Array(await t12.arrayBuffer())) : null;
report('source:level-12-tile', t12.status === 200 && img?.width === 512, { status: t12.status, size: img && `${img.width}x${img.height}` });

// known points: per driver the first sample where the raw class is that driver, plus the first no-driver sample
const [head, ...rows] = readFileSync(new URL('../docs/analysis/loss_drivers_samples.tsv', import.meta.url), 'utf8').trim().split('\n');
const keys = head.split('\t');
const samples = rows.map((r) => Object.fromEntries(r.split('\t').map((v, i) => [keys[i], v])));
const KNOWN = [
  ...DRIVERS.map((d) => ({ want: d.name, s: samples.find((s) => Number(s.raw) === d.code) })),
  // no driver: 0, or the GeoTIFF's no-data 255 (all the sampled ones); the renderer draws both black
  { want: 'No loss driver mapped', s: samples.find((s) => [0, 255].includes(Number(s.raw))) },
].filter((k) => k.s).map((k) => ({ want: k.want, lat: Number(k.s.lat), lon: Number(k.s.lon), region: k.s.region }));
report('known-points', KNOWN.length === DRIVERS.length + 1, { points: KNOWN.map((k) => `${k.want} ${k.lat},${k.lon}`) });

// (2) the site
const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
const tiles = { ok: 0, bad: [], levels: new Set(), drawn: 0 };
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /loss-drivers|drivers|Data:/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('requestfinished', (req) => {
    const url = req.url();
    if (!url.startsWith(PREFIX)) return;
    const r = req.response();
    tiles.levels.add(Number(url.slice(PREFIX.length).split('/')[0]));
    if ((r?.status() === 200 && /^image\/png/.test(r.headers()['content-type'] ?? '')) || r?.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r?.status()} ${url}`);
  });
  page.on('requestfailed', (req) => {
    if (req.url().startsWith(PREFIX)) tiles.bad.push(`failed ${req.failure()?.errorText ?? ''} ${req.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const look = (lat, lon, h) => page.evaluate(async ([lat, lon, h]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, h), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < 120 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
  }, [lat, lon, h]);

  const tilesBefore = tiles.ok + tiles.bad.length;
  const state = await page.evaluate(async ([id, other]) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(other, true, { origin: 'user' });
    const otherOn = dataManager.isEnabled(other);
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled(other) };
  }, [ID, OTHER]);
  report('not-fetched-before-on', tilesBefore === 0, { tilesBefore });
  report('one-drape-at-a-time', state.on && state.otherOn === true && state.otherAfter === false, { hansenBefore: state.otherOn, hansenAfter: state.otherAfter, on: state.on });

  // drawn: over Rondônia's agricultural frontier the drape loads tiles and paints driver colours on the globe
  await look(-10.5, -62.5, 400000);
  const painted = await page.evaluate((rgbs) => {
    const v = window.__godsEyeView.viewer;
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, Math.round(src.width / 2) - 100, Math.round(src.height / 2) - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    let near = 0;
    for (let i = 0; i < d.length; i += 4) if (rgbs.some((q) => Math.hypot(d[i] - q[0], d[i + 1] - q[1], d[i + 2] - q[2]) < 30)) near += 1;
    return near;
  }, DRIVERS.map((d) => [...d.rgb]));
  report('drawn', tiles.ok > 0 && painted > 400, { tiles200: tiles.ok, pixelsNearADriverColour: painted });

  const read = await page.evaluate(async (id, points) => {
    const out = [];
    for (const p of points) out.push((await window.__godsEyeView.readoutAt(p.lat, p.lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, KNOWN);
  for (const [i, k] of KNOWN.entries()) {
    const r = read[i];
    report(`readout ${k.want} (${k.region})`, r?.status === 'class' && r.text === k.want && r.date === '2001–2025',
      { lat: k.lat, lon: k.lon, got: r && `${r.status}:${r.text ?? r.error} · ${r.date}` });
  }

  const levels = [...tiles.levels].sort((a, b) => a - b);
  const s1 = await page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);
  report('tiles', tiles.ok > 0 && tiles.bad.length === 0 && levels.at(-1) <= MAX_LEVEL && !s1?.error,
    { tiles200: tiles.ok, tilesBad: tiles.bad.length, badSample: tiles.bad.slice(0, 3), levels, stats: s1 });

  const hooks = await page.evaluate((id) => {
    const mod = (lid) => window.__godsEyeView.dataManager.layers.get(lid)?.module;
    const has = (lid) => ['setObservedTime', 'getObservedExtent'].filter((k) => typeof mod(lid)?.[k] === 'function');
    return { ours: has(id), sampler: has('hansen-loss') };
  }, ID);
  report('not-on-the-time-bar', hooks.ours.length === 0 && hooks.sampler.includes('setObservedTime'), hooks);

  const text = await page.evaluate(() => document.body.textContent);
  const want = {
    legend: DRIVERS.every((d) => text.includes(d.name)) && text.includes('1 km cell, 2001–2025, 30% canopy'),
    displayCredit: text.includes('“Tree cover loss by dominant driver”. WRI/Google DeepMind.'),
    citation: text.includes('Global Drivers of Forest Loss at 1 Km Resolution') && text.includes('Sims, M.J., R. Stanimirova'),
  };
  report('legend-and-credit', Object.values(want).every(Boolean), want);
  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?ld(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });
} catch (e) {
  report('run', false, { error: String(e?.stack || e?.message || e).slice(0, 400) });
} finally {
  await browser.close();
}
report('no-page-or-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
await sleep(0);
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok, tilesBad: tiles.bad.length }));
process.exit(failed ? 1 : 0);
