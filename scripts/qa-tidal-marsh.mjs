#!/usr/bin/env node
/**
 * qa-tidal-marsh.mjs — real-browser acceptance for the Tidal marshes 2020 layer (spec 2026-10-04-tidal-marshes-design.md).
 * Run: node scripts/qa-tidal-marsh.mjs [--url https://musharna.github.io/wildeye/] [--cache ~/.cache/wildeye/tidal_marsh] [--python python3]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from scripts/qa_tidal_marsh_truth.py, which reads the pinned release zip with rasterio and counts
 * the 10 m pixels in each ~150 m cell itself (not pipeline/tidal_marsh.py or the tiles): six cells per region in seven
 * estuaries (highest share, nearest 50% and 30%, an exact n.5%, under 1.5%, none), each with its share in whole percent.
 * One estuary, Adak Island at 177°W, lies in a GeoTIFF the release georeferences at 180-190°E.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { NONE_TEXT, decodeTidalMarsh, shareText } from '../src/data/tidalMarsh.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const CACHE = arg('--cache', path.join(process.env.WILDEYE_CACHE || path.join(os.homedir(), '.cache', 'wildeye'), 'tidal_marsh'));
const PYTHON = arg('--python', 'python3');
const ID = 'tidal-marsh';
const DATE = '2020 (v2.6)';
// the real run of 2026-10-04: painted tiles over all levels
const LISTED = 11253;
// unmapped: north of 60°N; inland: mapped GeoTIFF, no marsh in its tile
const OUTSIDE = [65.0, -20.0];
const INLAND = [52.0, -1.5];

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = spawnSync(PYTHON, ['-B', path.join(import.meta.dirname, 'qa_tidal_marsh_truth.py'), CACHE], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'inherit'] });
if (probe.status !== 0) {
  report('truth', false, { error: `qa_tidal_marsh_truth.py exit ${probe.status}` });
  process.exit(1);
}
const TRUTH = JSON.parse(probe.stdout);
const kinds = ['highest', 'middle', 'near-30', 'exact-half', 'faint', 'clear'];
report('truth', TRUTH.members === 154 && TRUTH.points.length === 42 && kinds.every((k) => TRUTH.points.filter((p) => p.kind === k).length === 7),
  { members: TRUTH.members, points: TRUTH.points.length });

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
    if (m.type() === 'error' && /marsh|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (/\/data\/tidal_marsh\.json(\?|$)/.test(r.url())) manifest = await r.json().catch(() => null);
    if (!/\/data\/tidal_marsh\/\d+\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had; a 200 that is not a PNG is a server's HTML fallback for a
    // missing file (Vite's dev server answers so), which a status check alone reads as a good tile
    const png = r.status() === 304 || /^image\/png/.test(r.headers()['content-type'] ?? '');
    if ((r.status() === 200 || r.status() === 304) && png) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

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
    if (keep) { window.__qaMarshBase = d; return 0; }
    const b = window.__qaMarshBase;
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

  // over Terrebonne Bay's all-marsh cell, 40 km up
  const full = TRUTH.points.find((p) => p.kind === 'highest' && p.region.startsWith('Terrebonne'));
  await page.evaluate(([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 40000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, [full.lat, full.lon]);
  await centreChange(true);
  // Another drape first: switching the marshes on must switch it off (one drape at a time).
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
  const changed = await centreChange(false);
  const s1 = await stats();
  report('drew', state.on && changed > 0.2 && !s1?.error && s1?.time === DATE && s1?.count === 1 && tiles.ok > 0 && tiles.bad.length === 0,
    { changed: changed.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });

  report('manifest-matches-the-release', manifest?.members === TRUTH.members && manifest?.year === 2020 && manifest?.version === '2.6' && manifest?.maxLevel === 9,
    { members: manifest?.members, files: TRUTH.members, year: manifest?.year, version: manifest?.version, maxLevel: manifest?.maxLevel, marshKm2: manifest?.marshKm2 });

  // only tiles the manifest lists were ever requested
  const listed = new Set(Object.entries(manifest?.tiles ?? {}).flatMap(([z, l]) => l.map(([x, y]) => `${z}/${x}/${y}`)));
  const unlisted = [...tiles.urls].map((u) => u.match(/\/data\/tidal_marsh\/(\d+\/\d+\/\d+)\.png/)?.[1]).filter((k) => !listed.has(k));
  report('only-listed-tiles-requested', listed.size === LISTED && tiles.urls.size > 0 && unlisted.length === 0, { listed: listed.size, requested: tiles.urls.size, unlisted: unlisted.slice(0, 5) });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = [];
    for (const [lat, lon] of pts) out.push((await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const got = await readAll(TRUTH.points.map((p) => [p.lat, p.lon]));
  for (const k of kinds) {
    const idx = TRUTH.points.map((p, i) => (p.kind === k ? i : -1)).filter((i) => i >= 0);
    const want = (p) => (p.share ? shareText(p.share) : NONE_TEXT);
    const ok = idx.every((i) => got[i]?.status === 'class' && got[i].date === DATE && got[i].text === want(TRUTH.points[i]));
    report(`${k}-cells`, ok, { got: idx.map((i) => `${TRUTH.points[i].region} ${TRUTH.points[i].marsh}/${TRUTH.points[i].total} → ${want(TRUTH.points[i])}: ${row(got[i])}`) });
  }
  const [outside, inland] = await readAll([OUTSIDE, INLAND]);
  report('outside-and-inland', outside?.status === 'outside' && inland?.status === 'class' && inland.text === NONE_TEXT && inland.date === DATE,
    { outside: row(outside), inland: row(inland) });

  // legend: the five share bins, then the note with the mapped area from the manifest and the authors' estimate
  const legend = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend, ID);
  const note = legend.at(-1)?.label ?? '';
  const km2 = Math.round(manifest?.marshKm2 ?? -1).toLocaleString('en-US');
  report('legend', legend.length === 6 && legend.slice(0, 5).every((l) => / marsh$/.test(l.label)) && note.includes(`${km2} km² mapped`) && note.includes('52,880 km²'),
    { legend: legend.map((l) => l.label) });

  // A fixed map: moving the time bar neither redraws it nor changes what it reads.
  const imagery = () => page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const ours = [];
    for (let i = 0; i < layers.length; i += 1) if (/data\/tidal_marsh\//.test(String(layers.get(i).imageryProvider?.url ?? ''))) ours.push(layers.get(i));
    if (ours.length !== 1) return `imagery layers drawing marsh tiles: ${ours.length}`;
    if (!window.__qaMarshImagery) window.__qaMarshImagery = ours[0];
    return window.__qaMarshImagery === ours[0] ? 'same' : 'replaced';
  });
  const imageryBefore = await imagery();
  // With no time-aware layer on, the bar has no domain: a probe extent gives it one, and the instant must move.
  const moved = await page.evaluate(() => {
    const t = window.__godsEyeView.observedTime;
    t.setLayerExtent('qa-probe', { startMs: Date.parse('2000-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
    t.set('2010-06-01T00:00:00Z');
    return t.get();
  });
  // The bar reaches a layer only through the module's setObservedTime (observedTime.js attachObservedTime), and
  // getObservedExtent gives it a span: no such hook means no push can reach the layer, however late. A time
  // sampler (hansen-loss) is the positive control that the probe sees a hook where there is one.
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
    && imageryBefore === 'same' && imageryAfter === 'same' && s2?.time === DATE && !s2?.error && past?.text === shareText(100),
    { moved, hooks, imageryBefore, imageryAfter, stats: s2, point: row(past) });
  await page.evaluate(() => {
    window.__godsEyeView.observedTime.set(null);
    window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null);
  });

  // Every pixel of the real level-9 tiles the readouts used, decoded from the file's bytes by the site's own table.
  const urls = [...tiles.urls].filter((u) => /\/tidal_marsh\/9\/\d+\/\d+\.png/.test(u));
  const counts = { share: 0, none: 0 };
  const shares = new Set();
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = manifest ? decodeTidalMarsh(px, manifest) : { kind: 'unknown' };
      if (v.kind in counts) counts[v.kind] += 1;
      else unknown[px.join(',')] = (unknown[px.join(',')] || 0) + 1;
      if (v.kind === 'share') shares.add(v.share);
    }
  }
  report('every-pixel-decodes', !!manifest && urls.length >= 10 && counts.none > 0 && [1, 50, 100].every((s) => shares.has(s)) && shares.size > 50 && Object.keys(unknown).length === 0,
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
