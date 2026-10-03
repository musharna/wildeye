#!/usr/bin/env node
/**
 * qa-bii.mjs — real-browser acceptance for the Biodiversity Intactness Index layer (spec 2026-10-03-bii-design.md).
 * Run: node scripts/qa-bii.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, read 2026-10-03 by a Python probe straight from the release's GeoTIFFs (NHM v2.1.1 zip, sha256
 * 4bcc68c5…; rasterio's own transform, not the pipeline's code or tiles), at cell centres: a level-4 pixel holds one
 * 5' source cell by nearest neighbour, so the readout bin must be floor(value) exactly.
 *   2020: Amazon 95.0, Siberia 93.76, Iowa 15.33, Paris 0.99, Rondônia 39.82; 2010: Amazon 95.79, Rondônia 40.21;
 *   2000: Rondônia 40.72. Mid-Pacific: no data.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodeFootprint as decodePixel } from '../src/data/humanFootprint.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'bii';
const AT = {
  amazon: [-3.5417, -62.4583],
  siberia: [61.9583, 105.0417],
  iowa: [41.9583, -93.4583],
  paris: [48.875, 2.375],
  rondonia: [-10.0417, -63.0417],
  pacific: [0.0417, -149.9583],
};
const BIN_2020 = { amazon: 95, siberia: 93, iowa: 15, paris: 0, rondonia: 39 };
const BIN_2010 = { amazon: 95, rondonia: 40 };
const BIN_2000 = { rondonia: 40 };
const DOI = '10.5519/k33reyb6';

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const binOf = (r) => Number(/^BII (\d+)–\d+%$/.exec(r?.text ?? '')?.[1]);

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
    if (m.type() === 'error' && /bii|intactness|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/data/bii.json')) manifest = await r.json().catch(() => null);
    if (!/\/data\/bii\/\d{4}\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had
    if (r.status() === 200 || r.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Share of pale yellow-green (the ramp's low end) at the globe's centre, rendered and read back in one task.
  const palePixels = () => page.evaluate(async () => {
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
    // YlGn bins ~0–30: red and green both high, blue well below them; farmland imagery is darker
    for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] > 190 && d[i + 1] - d[i + 2] > 25) n += 1;
    return n / (d.length / 4);
  });
  // Wait until BII tile responses stop arriving (the globe's tilesLoaded is about terrain).
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
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 400000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, AT.iowa);
  const before = await palePixels();
  // Another drape first: switching BII on must switch it off (one drape at a time).
  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('human-footprint', true, { origin: 'user' });
    const otherOn = dataManager.isEnabled('human-footprint');
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled('human-footprint') };
  }, ID);
  await settle();
  const after = await palePixels();
  const s1 = await stats();
  report('drew-pale-over-iowa', state.on && after - before > 0.2 && !s1?.error && s1?.time === '2020' && tiles.ok > 0 && tiles.bad.length === 0,
    { before: before.toFixed(4), after: after.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { footprintBefore: state.otherOn, footprintAfter: state.otherAfter });
  report('live-draws-2020', [...tiles.urls].length > 0 && [...tiles.urls].every((u) => u.includes('/data/bii/2020/')), { years: [...new Set([...tiles.urls].map((u) => /bii\/(\d{4})\//.exec(u)[1]))] });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null;
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const live = await readAll(AT);
  for (const [name, want] of Object.entries(BIN_2020)) {
    const r = live[name];
    report(`known-${name}-2020`, r?.status === 'value' && r.date === '2020' && binOf(r) === want, { got: row(r), want });
  }
  const b = Object.fromEntries(Object.keys(BIN_2020).map((k) => [k, binOf(live[k])]));
  report('contrast-wild-over-farmed-over-city', Math.min(b.amazon, b.siberia) > b.iowa && b.iowa > b.paris, { bins: b });
  report('negative-open-pacific', live.pacific?.status === 'nodata' && live.pacific.date === '2020', { got: row(live.pacific) });

  // The time bar: it reaches back to 2000, and an instant between snapshots draws the one at or before it.
  const domainStart = await page.evaluate(() => window.__godsEyeView.observedTime.domain()?.start ?? null);
  report('time-bar-reaches-2000', domainStart !== null && domainStart <= Date.UTC(2000, 0, 1), { domainStart: domainStart && new Date(domainStart).toISOString() });
  const seen = new Set(tiles.urls);
  await page.evaluate(() => window.__godsEyeView.observedTime.set('2012-06-01T00:00:00Z'));
  await settle();
  const s2 = await stats();
  const fresh = [...tiles.urls].filter((u) => !seen.has(u));
  const mid = await readAll({ amazon: AT.amazon, rondonia: AT.rondonia });
  report('time-bar-steps-to-2010', s2?.time === '2010' && !s2?.error && fresh.length > 0 && fresh.every((u) => u.includes('/data/bii/2010/'))
    && mid.amazon?.date === '2010' && binOf(mid.amazon) === BIN_2010.amazon && binOf(mid.rondonia) === BIN_2010.rondonia,
  { stats: s2, newTiles: fresh.length, newYears: [...new Set(fresh.map((u) => /bii\/(\d{4})\//.exec(u)[1]))], amazon: row(mid.amazon), rondonia: row(mid.rondonia) });
  await page.evaluate(() => window.__godsEyeView.observedTime.set('2000-06-01T00:00:00Z'));
  const first = await readAll({ rondonia: AT.rondonia });
  report('rondonia-frontier-2000-over-2020', first.rondonia?.date === '2000' && binOf(first.rondonia) === BIN_2000.rondonia && binOf(first.rondonia) > b.rondonia,
    { y2000: row(first.rondonia), y2020: row(live.rondonia) });
  await page.evaluate(() => window.__godsEyeView.observedTime.set(null));

  const text = await page.evaluate(() => document.body.textContent);
  report('legend-and-credit', text.includes('modelled share of the original species abundance remaining') && text.includes(`doi:${DOI}`) && text.includes('CC BY-NC-SA 4.0'),
    { legend: text.includes('modelled share of the original species abundance remaining'), doi: text.includes(`doi:${DOI}`) });

  // Every pixel of the real level-4 tiles the readouts used, decoded from the file's bytes by the site's own table.
  const urls = [...tiles.urls].filter((u) => /\/bii\/\d{4}\/4\/\d+\/\d+\.png$/.test(u));
  let land = 0, empty = 0;
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = decodePixel(px, manifest?.palette ?? []);
      if (v.kind === 'value') land += 1;
      else if (v.kind === 'none') empty += 1;
      else unknown[px.join(',')] = (unknown[px.join(',')] || 0) + 1;
    }
  }
  report('every-pixel-decodes', !!manifest && urls.length >= 4 && land > 0 && empty > 0 && Object.keys(unknown).length === 0,
    { level4Tiles: urls.length, landPixels: land, noDataPixels: empty, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
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
