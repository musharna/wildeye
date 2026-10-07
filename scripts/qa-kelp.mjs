#!/usr/bin/env node
/**
 * qa-kelp.mjs — real-browser acceptance for the Floating kelp forests layer (spec 2026-10-07-kelp-forests-design.md).
 * Run: node scripts/qa-kelp.mjs [--url https://musharna.github.io/wildeye/] [--cache ~/.cache/wildeye/kelp] [--python python3]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from scripts/qa_kelp_truth.py, which reads the pinned release zip itself (not pipeline/kelp.py
 * or the tiles) and gives each QA cell's exact kelp share by polygon intersection on an equal-area projection: the
 * densest cell and a cell on a polygon edge in California, southern Chile, Tasmania and South Africa, the densest in
 * the Falklands and Peru, the densest near the antimeridian, a clear cell in a written tile and one in the open sea.
 * The layer is switched on by its share token in the link (#v=2&l=kp), the way a recipient opens it. A readout must
 * match the truth within the spec's bound (2 percentage points; "under 1.5%" within 3.5%); a cell with no kelp must
 * read none. The dense cells reading at least 50% in the same run are the positive control.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { EDITION, NONE_TEXT, PAPER_KM2, shareText } from '../src/data/kelp.js';
import { decodeTidalMarsh as decodeShare } from '../src/data/tidalMarsh.js';
import { decodePng } from '../src/data/pngDecode.js';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const CACHE = arg('--cache', path.join(process.env.WILDEYE_CACHE || path.join(os.homedir(), '.cache', 'wildeye'), 'kelp'));
const PYTHON = arg('--python', 'python3');
const ID = 'kelp';
const TOKEN = LAYER_STATE_REGISTRY.find((e) => e.id === ID)?.token;
// the spec's stated bound: |readout - true share| <= 2 pp (1.04 pp sampling measured + 0.5 pp whole-percent rounding)
const TOL_PP = 2;
// the real run of 2026-10-07: painted tiles over all levels
const LISTED = 2476;
const FEATURES = 426489;
// camera height over the all-kelp cell: the 200 px centre sample then spans a few cells of the Monterey bed
const ALT = 8000;

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = spawnSync(PYTHON, ['-B', path.join(import.meta.dirname, 'qa_kelp_truth.py'), CACHE], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'inherit'] });
if (probe.status !== 0) {
  report('truth', false, { error: `qa_kelp_truth.py exit ${probe.status}` });
  process.exit(1);
}
const TRUTH = JSON.parse(probe.stdout);
const kinds = ['densest', 'edge', 'clear-in-written-tile', 'open-sea'];
const count = (k) => TRUTH.points.filter((p) => p.kind === k).length;
report('truth', TRUTH.features === FEATURES && TRUTH.points.length === 13 && count('densest') === 7 && count('edge') === 4
  && TRUTH.points.filter((p) => p.share === 0).length === 2 && TRUTH.points.some((p) => p.lat > 0) && TRUTH.points.some((p) => p.lat < 0),
  { features: TRUTH.features, points: TRUTH.points.length, kinds: Object.fromEntries(kinds.map((k) => [k, count(k)])) });
report('share-token', TOKEN === 'kp', { token: TOKEN });

/** The share a readout states (1 means "under 1.5%"), 0 for none, null for anything else. */
const stated = (r) => {
  if (r?.status !== 'class' || r.date !== EDITION) return null;
  if (r.text === NONE_TEXT) return 0;
  for (let s = 1; s <= 100; s += 1) if (r.text === shareText(s)) return s;
  return null;
};
const within = (p, r) => {
  const n = stated(r);
  if (n === null) return false;
  if (p.share === 0) return n === 0;
  if (n === 0) return false;
  return n === 1 ? p.share < 1.5 + TOL_PP : Math.abs(n - p.share) <= TOL_PP;
};

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
    if (m.type() === 'error' && /kelp|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (/\/data\/kelp\.json(\?|$)/.test(r.url())) manifest = await r.json().catch(() => null);
    if (!/\/data\/kelp\/\d+\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had; a 200 that is not a PNG is a server's HTML fallback for a
    // missing file, which a status check alone reads as a good tile
    const png = r.status() === 304 || /^image\/png/.test(r.headers()['content-type'] ?? '');
    if ((r.status() === 200 || r.status() === 304) && png) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  // a recipient opening a share link that names only this layer, over Monterey's all-kelp cell (a link needs lat and
  // lon: src/sharelink.js parseInitialHash ignores a hash without them)
  const full = TRUTH.points.find((p) => p.kind === 'densest' && p.region.startsWith('Monterey'));
  const link = `${SITE.split('#')[0]}#v=2&lat=${full.lat.toFixed(5)}&lon=${full.lon.toFixed(5)}&alt=${ALT}&heading=0&pitch=-90&roll=0&l=${TOKEN}`;
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);
  const restored = await page.waitForFunction((id) => {
    const dm = window.__godsEyeView.dataManager;
    return dm.isEnabled(id) && dm.getAll().find((l) => l.id === id)?.stats?.lastUpdate ? [...dm.getEnabledLayerIds()] : false;
  }, { timeout: 120000, polling: 250 }, ID).then((h) => h.jsonValue(), () => null);
  report('on-from-the-share-link', Array.isArray(restored) && restored.includes(ID), { link, enabled: restored });

  // The globe's centre, rendered and read back in one task: kept as the baseline, or the share of pixels that moved
  // by more than 60 (summed over RGB) from it.
  const centreChange = (keep) => page.evaluate(async (keep) => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 100, src.height / 2 - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    if (keep) { window.__qaKelpBase = d; return 0; }
    const b = window.__qaKelpBase;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - b[i]) + Math.abs(d[i + 1] - b[i + 1]) + Math.abs(d[i + 2] - b[i + 2]) > 60) n += 1;
    return n / (d.length / 4);
  }, keep);
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
  const setOn = (id, on) => page.evaluate(async (lid, want) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(lid, want, { origin: 'user' });
    return dataManager.isEnabled(lid);
  }, id, on);

  // over Monterey's all-kelp cell: off for a baseline, then on
  await page.evaluate(([lat, lon, alt]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, alt), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, [full.lat, full.lon, ALT]);
  await setOn(ID, false);
  await centreChange(true);
  // Another drape first: switching kelp on must switch it off (one drape at a time).
  const otherOn = await setOn('surface-water', true);
  const on = await setOn(ID, true);
  const otherAfter = await page.evaluate(() => window.__godsEyeView.dataManager.isEnabled('surface-water'));
  await settle();
  const changed = await centreChange(false);
  const s1 = await stats();
  report('drew', on && changed > 0.2 && !s1?.error && s1?.time === EDITION && s1?.count === 1 && tiles.ok > 0 && tiles.bad.length === 0,
    { changed: changed.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', otherOn === true && otherAfter === false, { surfaceWaterBefore: otherOn, surfaceWaterAfter: otherAfter });

  report('manifest-matches-the-release', manifest?.features === TRUTH.features && manifest?.maxLevel === 9 && manifest?.subpixels === 64
    && Math.abs(manifest?.kelpKm2 / PAPER_KM2 - 1) < 0.005 && Math.abs(manifest?.drawnKm2 / manifest?.kelpKm2 - 1) < 0.005,
    { features: manifest?.features, truthFeatures: TRUTH.features, maxLevel: manifest?.maxLevel, kelpKm2: manifest?.kelpKm2, drawnKm2: manifest?.drawnKm2, paperKm2: PAPER_KM2, tileBytes: manifest?.tileBytes });

  // only tiles the manifest lists were ever requested
  const listed = new Set(Object.entries(manifest?.tiles ?? {}).flatMap(([z, l]) => l.map(([x, y]) => `${z}/${x}/${y}`)));
  const unlisted = [...tiles.urls].map((u) => u.match(/\/data\/kelp\/(\d+\/\d+\/\d+)\.png/)?.[1]).filter((k) => !listed.has(k));
  report('only-listed-tiles-requested', listed.size === LISTED && tiles.urls.size > 0 && unlisted.length === 0, { listed: listed.size, requested: tiles.urls.size, unlisted: unlisted.slice(0, 5) });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = [];
    for (const [lat, lon] of pts) out.push((await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const got = await readAll(TRUTH.points.map((p) => [p.lat, p.lon]));
  TRUTH.points.forEach((p, i) => {
    const n = stated(got[i]);
    report(`cell ${p.region} ${p.kind}`, within(p, got[i]),
      { truth: p.share, read: n, diffPp: n === null ? null : +(n - p.share).toFixed(2), rigorousBoundPp: p.boundPp, readout: row(got[i]) });
  });
  const dense = TRUTH.points.map((p, i) => [p, got[i]]).filter(([p]) => p.kind === 'densest' && p.share >= 50);
  report('positive-control-dense-cells-read-high', dense.length >= 5 && dense.every(([, r]) => (stated(r) ?? 0) >= 50),
    { cells: dense.map(([p, r]) => `${p.region}: ${row(r)}`) });

  // legend: the five share bins, then the note with the mapped area from the manifest and the authors' total
  const legend = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend, ID);
  const note = legend.at(-1)?.label ?? '';
  const km2 = (manifest?.kelpKm2 ?? -1).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  report('legend', legend.length === 6 && legend.slice(0, 5).every((l) => / kelp$/.test(l.label)) && note.includes(`${km2} km² mapped`)
    && note.includes('2,216.6 km²') && /Canada, Chile and New Zealand are underestimated/.test(note) && /floating-canopy kelps only/.test(note),
    { legend: legend.map((l) => l.label) });

  // A fixed map: moving the time bar neither redraws it nor changes what it reads.
  const imagery = () => page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const ours = [];
    for (let i = 0; i < layers.length; i += 1) if (/data\/kelp\//.test(String(layers.get(i).imageryProvider?.url ?? ''))) ours.push(layers.get(i));
    if (ours.length !== 1) return `imagery layers drawing kelp tiles: ${ours.length}`;
    if (!window.__qaKelpImagery) window.__qaKelpImagery = ours[0];
    return window.__qaKelpImagery === ours[0] ? 'same' : 'replaced';
  });
  const imageryBefore = await imagery();
  const moved = await page.evaluate(() => {
    const t = window.__godsEyeView.observedTime;
    t.setLayerExtent('qa-probe', { startMs: Date.parse('2000-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
    t.set('2010-06-01T00:00:00Z');
    return t.get();
  });
  // a time sampler (hansen-loss) is the positive control that the probe sees a hook where there is one
  const hooks = await page.evaluate((id) => {
    const mod = (lid) => window.__godsEyeView.dataManager.layers.get(lid)?.module;
    const has = (lid) => ['setObservedTime', 'getObservedExtent'].filter((k) => typeof mod(lid)?.[k] === 'function');
    return { ours: has(id), sampler: has('hansen-loss') };
  }, ID);
  await settle(); // tile traffic quiet: a redraw re-requests tiles
  const s2 = await stats();
  const [past] = await readAll([[full.lat, full.lon]]);
  const imageryAfter = await imagery();
  report('ignores-the-time-bar', moved?.startsWith('2010-06-01') && hooks.ours.length === 0 && hooks.sampler.includes('setObservedTime')
    && imageryBefore === 'same' && imageryAfter === 'same' && s2?.time === EDITION && !s2?.error && within(full, past),
    { moved, hooks, imageryBefore, imageryAfter, stats: s2, point: row(past) });
  await page.evaluate(() => {
    window.__godsEyeView.observedTime.set(null);
    window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null);
  });

  // Every pixel of the real level-9 tiles the readouts used, decoded from the file's bytes by the site's own table.
  const urls = [...tiles.urls].filter((u) => /\/kelp\/9\/\d+\/\d+\.png/.test(u));
  const counts = { share: 0, none: 0 };
  const shares = new Set();
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = manifest ? decodeShare(px, manifest) : { kind: 'unknown' };
      if (v.kind in counts) counts[v.kind] += 1;
      else unknown[px.join(',')] = (unknown[px.join(',')] || 0) + 1;
      if (v.kind === 'share') shares.add(v.share);
    }
  }
  report('every-pixel-decodes', !!manifest && urls.length >= 1 && counts.none > 0 && [1, 100].every((s) => shares.has(s)) && shares.size > 30 && Object.keys(unknown).length === 0,
    { level9Tiles: urls.length, ...counts, distinctShares: shares.size, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
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
