#!/usr/bin/env node
/**
 * qa-ifl.mjs — real-browser acceptance for the Intact forest landscapes layer (spec 2026-10-04-ifl-design.md).
 * Run: node scripts/qa-ifl.mjs [--url https://musharna.github.io/wildeye/] [--cache ~/.cache/wildeye/ifl] [--python python3]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from scripts/qa_ifl_truth.py, which reads the five pinned GeoPackages with sqlite3 and shapely
 * (not pipeline/ifl.py or the tiles): each edition's patch count and stated area, three points per class from the
 * unsimplified polygons, each checked against every edition, and four points no edition covers.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { NONE_TEXT, decodeIfl } from '../src/data/ifl.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const CACHE = arg('--cache', path.join(process.env.WILDEYE_CACHE || path.join(os.homedir(), '.cache', 'wildeye'), 'ifl'));
const PYTHON = arg('--python', 'python3');
const ID = 'ifl';
const DATE = 'IFL 2000–2025';

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = spawnSync(PYTHON, ['-B', path.join(import.meta.dirname, 'qa_ifl_truth.py'), CACHE], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'inherit'] });
if (probe.status !== 0) {
  report('truth', false, { error: `qa_ifl_truth.py exit ${probe.status}` });
  process.exit(1);
}
const TRUTH = JSON.parse(probe.stdout);
report('truth', TRUTH.points.length === 15 && TRUTH.never.length === 4, { points: TRUTH.points.length, never: TRUTH.never.length });

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
    if (m.type() === 'error' && /ifl|intact|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (/\/data\/ifl\.json(\?|$)/.test(r.url())) manifest = await r.json().catch(() => null);
    if (!/\/data\/ifl\/\d+\//.test(r.url())) return;
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

  // Share of the 2025 class green at the globe's centre, rendered and read back in one task.
  const greenPixels = () => page.evaluate(async () => {
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
    // (56, 158, 56), allowing for shading; satellite forest is far darker in green
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 56) < 30 && Math.abs(d[i + 1] - 158) < 35 && Math.abs(d[i + 2] - 56) < 30) n += 1;
    return n / (d.length / 4);
  });
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

  // over the class-5 point in the Bolivian Andes foothills, 300 km up
  const green = TRUTH.points.find((p) => p.class === 5);
  await page.evaluate(([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 300000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, [green.lat, green.lon]);
  const before = await greenPixels();
  // Another drape first: switching IFL on must switch it off (one drape at a time).
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
  const after = await greenPixels();
  const s1 = await stats();
  report('drew', state.on && after - before > 0.2 && !s1?.error && s1?.time === DATE && s1?.count === 2014 && tiles.ok > 0 && tiles.bad.length === 0,
    { before: before.toFixed(4), after: after.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });

  // the manifest's editions against the raw files
  const eds = manifest?.editions ?? [];
  const same = TRUTH.editions.every((t, i) => eds[i]?.year === t.year && eds[i].patches === t.patches && eds[i].areaHa === t.areaHa);
  const ratios = eds.map((e) => e.burnedKm2 / (e.areaHa / 100));
  report('editions-equal-the-files', same && ratios.length === 5 && ratios.every((r) => Math.abs(r - 1) < 0.005),
    { files: TRUTH.editions.map((t) => [t.year, t.patches, t.areaHa]), manifest: eds.map((e) => [e.year, e.patches, e.areaHa]), burnedOverStated: ratios.map((r) => r.toFixed(4)) });

  // only tiles the manifest lists were ever requested
  const listed = new Set(Object.entries(manifest?.tiles ?? {}).flatMap(([z, l]) => l.map(([x, y]) => `${z}/${x}/${y}`)));
  const unlisted = [...tiles.urls].map((u) => u.match(/\/data\/ifl\/(\d+\/\d+\/\d+)\.png/)?.[1]).filter((k) => !listed.has(k));
  report('only-listed-tiles-requested', listed.size === 3439 && tiles.urls.size > 0 && unlisted.length === 0, { listed: listed.size, requested: tiles.urls.size, unlisted: unlisted.slice(0, 5) });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = [];
    for (const [lat, lon] of pts) out.push((await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const labels = Object.fromEntries((manifest?.classes ?? []).map((c) => [c.index, c.label]));
  const got = await readAll(TRUTH.points.map((p) => [p.lat, p.lon]));
  for (let k = 1; k <= 5; k += 1) {
    const idx = TRUTH.points.map((p, i) => (p.class === k ? i : -1)).filter((i) => i >= 0);
    const ok = idx.every((i) => got[i]?.status === 'class' && got[i].date === DATE && got[i].text === labels[k]);
    report(`class-${k}-points`, !!labels[k] && ok, { want: labels[k], got: idx.map((i) => `${TRUTH.points[i].id} ${TRUTH.points[i].lat},${TRUTH.points[i].lon}: ${row(got[i])}`) });
  }
  const never = await readAll(TRUTH.never.map((p) => [p.lat, p.lon]));
  report('never-intact-points', never.every((r) => r?.status === 'class' && r.text === NONE_TEXT && r.date === DATE),
    { got: TRUTH.never.map((p, i) => `${p.name}: ${row(never[i])}`) });

  // legend: the classes in order, then the note with the 2025 totals and the new ground summed from the manifest
  const legend = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend, ID);
  const outside = eds.reduce((s, e) => s + e.burnedKm2NotInPrevious, 0).toLocaleString('en-US');
  const last = TRUTH.editions.at(-1);
  const note = legend.at(-1)?.label ?? '';
  report('legend', legend.length === 6 && legend.slice(0, 5).every((l, i) => l.label === labels[i + 1])
    && note.includes(`${last.patches.toLocaleString('en-US')} landscapes, ${Math.round(last.areaHa / 100).toLocaleString('en-US')} km² in 2025`)
    && note.includes(`${outside} km² of later editions lie outside the edition before`), { legend: legend.map((l) => l.label) });

  // A fixed map: moving the time bar neither redraws it nor changes what it reads.
  const imagery = () => page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const ours = [];
    for (let i = 0; i < layers.length; i += 1) if (/data\/ifl\//.test(String(layers.get(i).imageryProvider?.url ?? ''))) ours.push(layers.get(i));
    if (ours.length !== 1) return `imagery layers drawing IFL tiles: ${ours.length}`;
    if (!window.__qaIflImagery) window.__qaIflImagery = ours[0];
    return window.__qaIflImagery === ours[0] ? 'same' : 'replaced';
  });
  const imageryBefore = await imagery();
  // With no time-aware layer on, the bar has no domain: a probe extent gives it one, and the instant must move.
  const moved = await page.evaluate(() => {
    const t = window.__godsEyeView.observedTime;
    t.setLayerExtent('qa-probe', { startMs: Date.parse('2000-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
    t.set('2010-06-01T00:00:00Z');
    return t.get();
  });
  await sleep(3000);
  const s2 = await stats();
  const [past] = await readAll([[green.lat, green.lon]]);
  const imageryAfter = await imagery();
  report('ignores-the-time-bar', moved?.startsWith('2010-06-01') && imageryBefore === 'same' && imageryAfter === 'same' && s2?.time === DATE && !s2?.error && past?.text === labels[5],
    { moved, imageryBefore, imageryAfter, stats: s2, point: row(past) });
  await page.evaluate(() => {
    window.__godsEyeView.observedTime.set(null);
    window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null);
  });

  // Every pixel of the real level-7 tiles the readouts used, decoded from the file's bytes by the site's own table.
  const urls = [...tiles.urls].filter((u) => /\/ifl\/7\/\d+\/\d+\.png/.test(u));
  const counts = { class: 0, none: 0 };
  const byClass = {};
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = manifest ? decodeIfl(px, manifest) : { kind: 'unknown' };
      if (v.kind in counts) counts[v.kind] += 1;
      else unknown[px.join(',')] = (unknown[px.join(',')] || 0) + 1;
      if (v.kind === 'class') byClass[v.index] = (byClass[v.index] || 0) + 1;
    }
  }
  report('every-pixel-decodes', !!manifest && urls.length >= 10 && counts.none > 0 && [1, 2, 3, 4, 5].every((k) => byClass[k] > 0) && Object.keys(unknown).length === 0,
    { level7Tiles: urls.length, ...counts, byClass, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
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
