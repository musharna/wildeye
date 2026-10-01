#!/usr/bin/env node
/**
 * qa-human-footprint.mjs — real-browser acceptance for the Human Footprint layer (spec 2026-10-01-human-footprint-design.md).
 * Run: node scripts/qa-human-footprint.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, read 2026-10-01 by a Python probe straight from the 1 km Mollweide GeoTIFFs (figshare v8; not the
 * pipeline's code or tiles): the overlap-weighted mean of the 1 km cells under each ~5 km level-4 pixel, from 60 × 60
 * lon/lat samples inside it (Mollweide is equal-area, so this is the area average the pixel holds). Central London,
 * 2024: 46.06–49.45, mean 47.01; 2006: mean 46.99. Deep Amazon (3°S 66°W), 2024: 0.56–6.07, mean 3.65. Lagos, 2024:
 * 19.48–42.0, mean 37.85 (a lagoon-edge gradient; the 3 × 3 pixels around it all read floor(mean)). The open Pacific
 * (0°, 150°W): no data. A readout passes when its bin lies inside the range and within one of the mean's bin, for a
 * mean on a bin edge (London's two). A bounding-box mean of whole cells was not precise enough: at Lagos it read 39.53.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodeFootprint } from '../src/data/humanFootprint.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'human-footprint';
const KNOWN = {
  london: { at: [51.5074, -0.1278], min: 46.06, mean: 47.01, max: 49.45 },
  amazon: { at: [-3.0, -66.0], min: 0.56, mean: 3.65, max: 6.07 },
  lagos: { at: [6.455, 3.3841], min: 19.48, mean: 37.85, max: 42.0 },
  pacific: { at: [0.0, -150.0], nodata: true },
};
const LONDON_2006 = { min: 46.06, mean: 46.99, max: 49.32 };

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const binOf = (r) => Number(/^Human footprint (\d+)–\d+ of 50$/.exec(r?.text ?? '')?.[1]);
const fits = (bin, k) => Number.isInteger(bin) && bin >= Math.floor(k.min) && bin <= Math.min(49, Math.floor(k.max)) && Math.abs(bin - Math.floor(k.mean)) <= 1;

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
    if (m.type() === 'error' && /footprint|hfp|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/data/hfp.json')) manifest = await r.json().catch(() => null);
    if (!/\/data\/hfp\/\d{4}\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had
    if (r.status() === 200 || r.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Share of footprint orange-red at the globe's centre, rendered and read back in one task.
  const redPixels = () => page.evaluate(async () => {
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
    // YlOrRd from bin ~15 up: red well above green and blue; England's fields and towns are not
    for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i] - d[i + 1] > 70 && d[i] - d[i + 2] > 70) n += 1;
    return n / (d.length / 4);
  });
  // Wait until footprint tile responses stop arriving (the globe's tilesLoaded is about terrain).
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
  }, KNOWN.london.at);
  const before = await redPixels();
  // Another drape first: switching the footprint on must switch it off (one drape at a time).
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
  const after = await redPixels();
  const s1 = await stats();
  report('drew', state.on && after - before > 0.2 && !s1?.error && s1?.time === '2024' && tiles.ok > 0 && tiles.bad.length === 0,
    { before: before.toFixed(4), after: after.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });
  report('live-draws-2024', [...tiles.urls].length > 0 && [...tiles.urls].every((u) => u.includes('/data/hfp/2024/')), { years: [...new Set([...tiles.urls].map((u) => /hfp\/(\d{4})\//.exec(u)[1]))] });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null;
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const live = await readAll(Object.fromEntries(Object.entries(KNOWN).map(([k, v]) => [k, v.at])));
  for (const name of ['london', 'amazon', 'lagos']) {
    const r = live[name];
    report(`known-${name}`, r?.status === 'value' && r.date === '2024' && fits(binOf(r), KNOWN[name]), { got: row(r), source: KNOWN[name] });
  }
  report('negative-open-pacific', live.pacific?.status === 'nodata' && live.pacific.date === '2024', { got: row(live.pacific) });

  // The time bar: it reaches back to the first snapshot, and an instant between snapshots draws the one at or before it.
  const domainStart = await page.evaluate(() => window.__godsEyeView.observedTime.domain()?.start ?? null);
  report('time-bar-reaches-2000', domainStart !== null && domainStart <= Date.UTC(2000, 0, 1), { domainStart: domainStart && new Date(domainStart).toISOString() });
  const seen = new Set(tiles.urls);
  await page.evaluate(() => window.__godsEyeView.observedTime.set('2010-06-01T00:00:00Z'));
  await settle();
  const s2 = await stats();
  const fresh = [...tiles.urls].filter((u) => !seen.has(u));
  const past = await readAll({ london: KNOWN.london.at });
  report('time-bar-steps-to-2006', s2?.time === '2006' && !s2?.error && fresh.length > 0 && fresh.every((u) => u.includes('/data/hfp/2006/'))
    && past.london?.date === '2006' && fits(binOf(past.london), LONDON_2006),
  { stats: s2, newTiles: fresh.length, newYears: [...new Set(fresh.map((u) => /hfp\/(\d{4})\//.exec(u)[1]))], london: row(past.london) });
  await page.evaluate(() => window.__godsEyeView.observedTime.set(null));

  // Every pixel of the real level-4 tiles the readouts used, decoded from the file's bytes by the site's own table.
  const urls = [...tiles.urls].filter((u) => /\/hfp\/\d{4}\/4\/\d+\/\d+\.png$/.test(u));
  let land = 0, empty = 0;
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = decodeFootprint(px, manifest?.palette ?? []);
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
