#!/usr/bin/env node
/**
 * qa-gap-layers.mjs — headless smoke for the 2026-09-12 biology gap layers.
 * Loads the REAL built app, enables each layer through the data manager, waits for its
 * first update, and FAILS on: update error, zero features, zero entities in the viewer,
 * or any page error raised while the layer was on. Screenshot per layer to qa-shots/.
 * Run: node scripts/qa-gap-layers.mjs --url http://localhost:4455
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(REPO, 'qa-shots', 'gap-layers');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL = opt('--url', 'http://localhost:4455');
// --set new (default): the 2026-09-12 gap layers. --set old: the earlier biology layers, which never had a
// framed real-app review. --set all: both. --ids overrides the set.
const SETS = {
  new: 'arbonet,phenology,neon-vectors,cetaceans,drought,h5n1,fires,fires@pacific,ecoregions,rivers',
  old: 'occurrences,tracks,birds,aloft,otn,neon,hpai,wastewater,gfw,gfw@pacific,whispers,crw-bleaching,oisst,chlor-a,crw-dhw,crw-hotspot,crw-seaice,ndvi,cmems-o2,cmems-ph,occurrences@pacific',
};
SETS.all = `${SETS.new},${SETS.old}`;
const IDS = opt('--ids', SETS[opt('--set', 'new')] || SETS.new).split(',');
// Camera per shot [lon, lat, height m]: each layer's own region, straight down, so the data is in frame.
// `fires@pacific` looks at a hemisphere with few fires: any dense markers there are drawn THROUGH the globe.
const VIEWS = {
  arbonet: [-97, 39, 7.0e6], phenology: [-97, 39, 7.0e6], 'neon-vectors': [-97, 39, 7.0e6], drought: [-97, 39, 7.0e6],
  h5n1: [-97, 39, 7.0e6], rivers: [-97, 39, 7.0e6], cetaceans: [-68, 42, 2.2e6],
  fires: [20, 2, 1.3e7], 'fires@pacific': [-150, 0, 1.3e7], ecoregions: [20, 10, 1.6e7],
  occurrences: [-40, 30, 1.6e7], 'occurrences@pacific': [-150, 0, 1.3e7], tracks: [-140, 35, 1.3e7],
  birds: [-85, 38, 4.5e6], aloft: [10, 50, 4.5e6], otn: [-60, 42, 6.0e6], neon: [-97, 39, 7.0e6],
  hpai: [-97, 39, 7.0e6], wastewater: [-97, 39, 7.0e6], whispers: [-97, 39, 7.0e6],
  gfw: [-20, 0, 1.6e7], 'gfw@pacific': [-150, 0, 1.3e7],
  'crw-bleaching': [150, -15, 1.3e7], oisst: [-150, 10, 1.6e7], 'chlor-a': [-60, 30, 1.3e7], 'crw-dhw': [150, -15, 1.3e7],
  'crw-hotspot': [150, -15, 1.3e7], 'crw-seaice': [0, 80, 9.0e6], ndvi: [20, 10, 1.6e7], 'cmems-o2': [-150, -20, 1.6e7],
  'cmems-ph': [-150, -20, 1.6e7],
};
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
let pageErrors = [];
// Attribute only what a data layer can cause: uncaught exceptions (e.g. Cesium's render loop
// stopping) and failed requests for data files. The inherited app also calls dev-proxy /api/*
// endpoints that a static Pages host answers 404/405; those are logged separately, not blamed on a layer.
const inheritedApiErrors = new Map();
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
page.on('response', (r) => {
  if (r.status() < 400) return;
  const u = r.url().replace(/[?].*$/, '');
  if (/\/data\//.test(u)) pageErrors.push(`HTTP ${r.status()} ${u}`);
  else inheritedApiErrors.set(`${r.status()} ${u}`, (inheritedApiErrors.get(`${r.status()} ${u}`) || 0) + 1);
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
await new Promise((r) => setTimeout(r, 12000)); // boot flyTo + deferred init
// Dismiss the first-run launcher so it does not cover the frame.
await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
await page.keyboard.press('Escape');
// The launcher removes itself on a 400 ms timer after Escape; under host load a fixed sleep lost that race
// (2026-09-12). Wait for it to be gone, and fail loudly if it never goes.
const launcherGone = await page
  .waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 15000 })
  .then(() => true, () => false);
if (!launcherGone) { console.log('FAIL first-run launcher still visible after 15 s; screenshots would be covered'); process.exit(1); }
const baselineErrors = pageErrors.length;
console.log(`app ready; ${baselineErrors} console/page errors before any gap layer (not attributed)`);
pageErrors = [];

let failures = 0;
for (const shot of IDS) {
  const id = shot.split('@')[0];
  pageErrors = [];
  await page.evaluate(([lon, lat, h]) => {
    const v = window.__godsEyeView.viewer; v.camera.cancelFlight();
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({ longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180, height: h }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, VIEWS[shot] || [-97, 39, 7e6]);
  const t0 = Date.now();
  const res = await page.evaluate(async (id) => {
    const g = window.__godsEyeView; const dm = g.dataManager;
    const known = dm.getAll().some((l) => l.id === id);
    if (!known) return { error: 'not registered' };
    const imagery0 = g.viewer.imageryLayers.length;
    await dm.setEnabled(id, true);
    const deadline = Date.now() + 90000;
    let s;
    while (Date.now() < deadline) {
      s = dm.getAll().find((l) => l.id === id).stats;
      if (s?.lastUpdate || s?.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ds = [];
    for (let i = 0; i < g.viewer.dataSources.length; i++) {
      const d = g.viewer.dataSources.get(i);
      if (d.show && d.entities?.values?.length) ds.push([d.name, d.entities.values.length]);
    }
    g.requestRender?.();
    return { stats: s, dataSources: ds, imageryAdded: g.viewer.imageryLayers.length - imagery0 };
  }, id);
  await new Promise((r) => setTimeout(r, 8000)); // imagery tiles settle at the new view
  await page.screenshot({ path: path.join(SHOTS, `${shot.replace('@', '-')}.png`) });
  const s = res.stats || {};
  const ents = (res.dataSources || []).filter(([n]) => n === id || n.startsWith(id)).reduce((a, [, n]) => a + n, 0);
  const problems = [];
  if (res.error) problems.push(res.error);
  if (s.error) problems.push(`stats.error=${s.error}`);
  if (!s.lastUpdate) problems.push('no lastUpdate');
  if (!(s.count > 0)) problems.push(`count=${s.count}`);
  // Drapes and the bird radar layer draw imagery / point primitives, not entities.
  const drawn = ents > 0 || res.imageryAdded > 0 || s.drapes > 0 || s.particles > 0;
  if (!drawn) problems.push(`nothing drawn: entities=${ents} imageryAdded=${res.imageryAdded} (shown sources: ${JSON.stringify(res.dataSources)})`);
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${shot}: count=${s.count} entities=${ents} imagery+${res.imageryAdded ?? 0} ${Date.now() - t0}ms${problems.length ? ' — ' + problems.join('; ') : ''}`);
  if (problems.length) failures++;
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false), id);
}
await browser.close();
if (inheritedApiErrors.size) console.log(`not attributed (inherited non-data endpoints): ${[...inheritedApiErrors].map(([k, v]) => `${v}× ${k}`).join('; ')}`);
console.log(`${IDS.length - failures}/${IDS.length} passed`);
process.exit(failures ? 1 : 0);
