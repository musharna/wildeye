#!/usr/bin/env node
/**
 * qa-mhw.mjs — real-browser acceptance for the marine heatwave drape (rasters.json product `mhw`).
 * Run: node scripts/qa-mhw.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Two halves: (1) the live source still says what rasters.json pins (licence, version, the six category names, a
 * recent day); (2) the site's manifest and image are that product, the drape draws, and the click readout at one
 * point per category on the shown day, plus land, names the category ERDDAP itself returns at that point (a separate
 * point query, not the drape image).
 */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'mhw';
const ERDDAP = 'https://pae-paha.pacioos.hawaii.edu/erddap';
const pinned = JSON.parse(readFileSync(new URL('../pipeline/rasters.json', import.meta.url), 'utf8')).find((p) => p.id === ID);
const LABELS = pinned.classes.map((c) => c.label);

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const json = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.json();
};

// (1) the live source
const info = await json(`${ERDDAP}/info/mhw_5km/index.json`);
const attr = (v, n) => info.table.rows.find((r) => r[0] === 'attribute' && r[1] === v && r[2] === n)?.[4];
const license = attr('NC_GLOBAL', 'license') ?? '';
report('source:licence-and-version', /available for use without restriction/.test(license) && attr('NC_GLOBAL', 'product_version') === '1.0.1',
  { version: attr('NC_GLOBAL', 'product_version'), license: license.slice(0, 90) });
const meanings = (attr('heatwave_category', 'flag_meanings') ?? '').split(' ');
report('source:categories', JSON.stringify(meanings.map((m) => m.replace(/_/g, ' '))) === JSON.stringify(LABELS)
  && attr('heatwave_category', 'flag_values') === '0, 1, 2, 3, 4, 5', { source: meanings, pinned: LABELS });
const end = attr('NC_GLOBAL', 'time_coverage_end');
report('source:recent', Date.now() - Date.parse(end) < 4 * 86400e3, { time_coverage_end: end });

// (2) the site's manifest and image
const manifest = await json(`${SITE}data/rasters.json?t=${Date.now()}`);
const entry = manifest.products.find((p) => p.id === ID);
report('manifest', Boolean(entry) && entry.kind === 'classes' && JSON.stringify(entry.classes) === JSON.stringify(pinned.classes)
  && entry.width === 1440 && entry.height === 720 && entry.history?.length > 1,
  { time: entry?.time, size: entry && `${entry.width}x${entry.height}`, frames: entry?.history?.length });
const png = await fetch(`${SITE}${entry.png}?t=${Date.now()}`);
const img = await decodePng(new Uint8Array(await png.arrayBuffer()));
report('image', png.ok && img.width === entry.width && img.height === entry.height, { status: png.status, size: `${img.width}x${img.height}` });

// one known point per category present on the shown day, and land: the first drape cell of each, read from the image,
// its expected category from ERDDAP's own point value at that cell's centre (every 5th 0.05° cell, as rasters.json asks)
const b = entry.bounds;
const centre = (px, py) => ({ lat: +(b.north - (py + 0.5) * (b.north - b.south) / img.height).toFixed(3), lon: +(b.west + (px + 0.5) * (b.east - b.west) / img.width).toFixed(3) });
const found = new Map();
for (let py = 0; py < img.height; py += 1) for (let px = 0; px < img.width; px += 1) {
  const i = (py * img.width + px) * 4;
  const d = img.data;
  const k = d[i + 3] === 0 && d[i] + d[i + 1] + d[i + 2] === 0 ? 'land'
    : pinned.classes.findIndex((c) => c.rgb[0] === d[i] && c.rgb[1] === d[i + 1] && c.rgb[2] === d[i + 2]);
  if (!found.has(k) && py > 60 && py < img.height - 60) found.set(k, centre(px, py)); // off the poles: sea ice and fill
}
const KNOWN = [];
for (const [k, at] of found) {
  const q = await json(`${ERDDAP}/griddap/mhw_5km.json?heatwave_category%5B(${entry.time})%5D%5B(${at.lat})%5D%5B(${at.lon})%5D`);
  const [, lat, lon, v] = q.table.rows[0];
  KNOWN.push({ ...at, at: `${lat},${lon}`, want: v === null || v === 251 ? 'land' : LABELS[v] });
}
const missing = LABELS.filter((l, k) => !found.has(k));
report('known-points', KNOWN.length >= 4 && found.has('land'), { points: KNOWN.map((k) => `${k.want} ${k.lat},${k.lon}`), notOnThisDay: missing });

// the browser
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
    if (m.type() === 'error' && /mhw|Data:/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: s() };
  }, ID);
  report('loaded', state.on && !state.stats?.error && state.stats?.time === entry.time, { stats: state.stats });

  // drawn: over the first heatwave point the globe shows a category colour
  const hot = KNOWN.find((k) => k.want !== 'land' && k.want !== LABELS[0]);
  const painted = await page.evaluate(async ([lat, lon, rgbs]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 3000000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    for (let i = 0; i < 120 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, Math.round(src.width / 2) - 100, Math.round(src.height / 2) - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    let near = 0;
    for (let i = 0; i < d.length; i += 4) if (rgbs.some((q) => Math.hypot(d[i] - q[0], d[i + 1] - q[1], d[i + 2] - q[2]) < 60)) near += 1;
    return near;
  }, [hot.lat, hot.lon, pinned.classes.filter((c) => !c.hidden).map((c) => c.rgb)]);
  report('drawn', painted > 400, { at: `${hot.lat},${hot.lon}`, pixelsNearACategoryColour: painted });

  const read = await page.evaluate(async (id, points) => {
    const out = [];
    for (const p of points) out.push((await window.__godsEyeView.readoutAt(p.lat, p.lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, KNOWN);
  for (const [i, k] of KNOWN.entries()) {
    const r = read[i];
    const ok = k.want === 'land' ? r?.status === 'nodata' : r?.status === 'value' && r.text === k.want;
    report(`readout ${k.want}`, ok && r.date === entry.time.slice(0, 10), { lat: k.lat, lon: k.lon, erddapAt: k.at, got: r && `${r.status}:${r.text ?? r.error ?? ''} · ${r.date}` });
  }

  const hooks = await page.evaluate((id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    return ['setObservedTime', 'getObservedExtent'].filter((k) => typeof mod?.[k] === 'function');
  }, ID);
  report('on-the-time-bar', hooks.length === 2, { hooks });

  const text = await page.evaluate(() => document.body.textContent);
  const want = {
    legend: LABELS.slice(1).every((l) => text.includes(l)) && text.includes('Hobday et al. 2018 categories'),
    credit: text.includes('marine heatwaves') && text.includes('Marine Heatwave Watch v1.0.1') && text.includes('doi:10.5670/oceanog.2018.205'),
  };
  report('legend-and-credit', Object.values(want).every(Boolean), want);
  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?mh(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });
} catch (e) {
  report('run', false, { error: String(e?.stack || e?.message || e).slice(0, 400) });
} finally {
  await browser.close();
}
report('no-page-or-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
