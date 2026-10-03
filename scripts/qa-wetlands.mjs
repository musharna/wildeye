#!/usr/bin/env node
/**
 * qa-wetlands.mjs — real-browser acceptance for the Wetlands layer (spec 2026-10-01-wetlands-design.md).
 * Run: node scripts/qa-wetlands.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, read 2026-10-01 by a Python probe straight from GLWD v2's 500 m main_class_50pct grid in the pinned
 * figshare zip (not the pipeline's code or tiles): the overlap-area share of each class among the land cells under the
 * level-6 pixel that holds the point, the sea left out. Each point below is one class over 100% of those cells, so any
 * fair mode gives it. Lake Victoria (1°S 33°E): Freshwater lake. Sundarbans (22.0°N 89.4°E): Mangrove. Hudson Bay
 * Lowlands (52.5°N 83.5°W): Arctic/boreal peatland, forested. Sahara (23.5°N 12°E): dryland. The open Pacific (0°,
 * 150°W): sea only, so no data. Mixed pixels were left out: at 21.8°N 89.0°E, 62% mangrove to 38% estuarine river, an
 * area-weighted mode and GDAL's cell-count mode may differ.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodeWetland } from '../src/data/wetlands.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'wetlands';
const KNOWN = {
  victoria: { at: [-1.0, 33.0], text: 'Freshwater lake' },
  sundarbans: { at: [22.0, 89.4], text: 'Mangrove' },
  hudson: { at: [52.5, -83.5], text: 'Arctic/boreal peatland, forested' },
  sahara: { at: [23.5, 12.0], text: 'Mostly dryland' },
  pacific: { at: [0.0, -150.0], nodata: true },
};

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
    if (m.type() === 'error' && /wetland|glwd|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/data/glwd.json')) manifest = await r.json().catch(() => null);
    if (!/\/data\/glwd\/\d+\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had
    if (r.status() === 200 || r.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Share of peat-brown at the globe's centre, rendered and read back in one task.
  const brownPixels = () => page.evaluate(async () => {
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
    // forested boreal peat is (102, 64, 32): red over green over blue; the lowlands' bog and spruce imagery is green
    for (let i = 0; i < d.length; i += 4) if (d[i] > 50 && d[i] - d[i + 1] > 20 && d[i + 1] - d[i + 2] > 15) n += 1;
    return n / (d.length / 4);
  });
  // Wait until wetland tile responses stop arriving (the globe's tilesLoaded is about terrain).
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
  }, KNOWN.hudson.at);
  const before = await brownPixels();
  // Another drape first: switching wetlands on must switch it off (one drape at a time).
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
  const after = await brownPixels();
  const s1 = await stats();
  report('drew', state.on && after - before > 0.3 && !s1?.error && s1?.time === 'GLWD v2' && tiles.ok > 0 && tiles.bad.length === 0,
    { before: before.toFixed(4), after: after.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null;
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const live = await readAll(Object.fromEntries(Object.entries(KNOWN).map(([k, v]) => [k, v.at])));
  for (const name of ['victoria', 'sundarbans', 'hudson', 'sahara']) {
    const r = live[name];
    report(`known-${name}`, r?.status === 'class' && r.date === 'GLWD v2' && r.text === KNOWN[name].text, { got: row(r), want: KNOWN[name].text });
  }
  report('negative-open-pacific', live.pacific?.status === 'nodata' && live.pacific.date === 'GLWD v2', { got: row(live.pacific) });

  // A fixed map: moving the time bar neither redraws it nor changes what it reads. A redraw is told by the imagery
  // layer object, which a redraw replaces: it re-requests the same tile URLs, so counting new URLs cannot see it.
  const imagery = () => page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const ours = [];
    for (let i = 0; i < layers.length; i += 1) if (/data\/glwd\//.test(String(layers.get(i).imageryProvider?.url ?? ''))) ours.push(layers.get(i));
    if (ours.length !== 1) return `imagery layers drawing GLWD tiles: ${ours.length}`;
    if (!window.__qaWetlandsImagery) window.__qaWetlandsImagery = ours[0];
    return window.__qaWetlandsImagery === ours[0] ? 'same' : 'replaced';
  });
  const imageryBefore = await imagery();
  // With no time-aware layer on, the bar has no domain and set() is a no-op: a probe extent gives it one, and the
  // check requires the instant to have moved, so a bar that never moved cannot pass it.
  const moved = await page.evaluate(() => {
    const t = window.__godsEyeView.observedTime;
    t.setLayerExtent('qa-probe', { startMs: Date.parse('2000-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
    t.set('2010-06-01T00:00:00Z');
    return t.get();
  });
  await sleep(3000);
  const s2 = await stats();
  const past = await readAll({ sundarbans: KNOWN.sundarbans.at });
  const imageryAfter = await imagery();
  report('ignores-the-time-bar', moved?.startsWith('2010-06-01') && imageryBefore === 'same' && imageryAfter === 'same' && s2?.time === 'GLWD v2' && !s2?.error && past.sundarbans?.text === 'Mangrove',
    { moved, imageryBefore, imageryAfter, stats: s2, sundarbans: row(past.sundarbans) });
  await page.evaluate(() => {
    window.__godsEyeView.observedTime.set(null);
    window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null);
  });

  // Every pixel of the real level-6 tiles the readouts used, decoded from the file's bytes by the site's own table.
  const urls = [...tiles.urls].filter((u) => /\/glwd\/6\/\d+\/\d+\.png$/.test(u));
  const counts = { class: 0, dryland: 0, nodata: 0 };
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = manifest ? decodeWetland(px, manifest) : { kind: 'unknown' };
      if (v.kind in counts) counts[v.kind] += 1;
      else unknown[px.join(',')] = (unknown[px.join(',')] || 0) + 1;
    }
  }
  report('every-pixel-decodes', !!manifest && urls.length >= 5 && counts.class > 0 && counts.dryland > 0 && counts.nodata > 0 && Object.keys(unknown).length === 0,
    { level6Tiles: urls.length, ...counts, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
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
