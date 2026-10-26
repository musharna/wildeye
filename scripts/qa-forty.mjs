#!/usr/bin/env node
/**
 * qa-forty.mjs — real-browser acceptance for the Forest types 2020 (ForTy) layer.
 * Run: node scripts/qa-forty.mjs [--url https://musharna.github.io/wildeye/] [--samples docs/analysis/forty_samples.tsv]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from analysis/forty_drape_vs_native.py, which recomputes each sampled pixel's type from the
 * full-resolution COGs (not pipeline/forty.py's overview reads, not the tiles). The readout is checked at the samples
 * where that route and the drawn tile agree with a margin above 0.2, and at samples the native data calls clear.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { NONE_TEXT, decodeForty } from '../src/data/forty.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const SAMPLES = arg('--samples', path.join(import.meta.dirname, '..', 'docs', 'analysis', 'forty_samples.tsv'));
const ID = 'forty';
const DATE = 'ForTy 2020';

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [head, ...body] = readFileSync(SAMPLES, 'utf8').trim().split('\n');
const cols = head.split('\t');
const samples = body.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
const sure = samples.filter((s) => s.drawn === s.native && s.drawn !== 'clear' && Number(s.margin) > 0.2);
const clear = samples.filter((s) => s.drawn === 'clear' && s.native === 'clear');
report('truth', sure.length >= 100 && clear.length >= 20, { samples: samples.length, sureTypes: sure.length, clear: clear.length });

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
    if (m.type() === 'error' && /forty|forest|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (/\/data\/forty\.json(\?|$)/.test(r.url())) manifest = await r.json().catch(() => null);
    if (!/\/data\/forty\/\d+\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // a 200 that is not a PNG is a server's HTML fallback for a missing file (Vite's dev server answers so)
    const png = r.status() === 304 || /^image\/png/.test(r.headers()['content-type'] ?? '');
    if ((r.status() === 200 || r.status() === 304) && png) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // the centre of the canvas, after two drawn frames and the globe's tiles (tilesLoaded keeps the old view's value
  // until the scene has drawn the new one)
  const grab = () => page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    for (let n = 0; n < 2; n += 1) await new Promise((r) => { const off = v.scene.postRender.addEventListener(() => { off(); r(); }); v.scene.requestRender(); });
    for (let i = 0; i < 120 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 300; c.height = 300;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 150, src.height / 2 - 150, 300, 300, 0, 0, 300, 300);
    return Array.from(g.getImageData(0, 0, 300, 300).data);
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

  // over the first sure sample, 400 km up
  const at = sure[0];
  await page.evaluate(([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 400000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, [Number(at.lat), Number(at.lon)]);
  // Another drape first: switching ForTy on must switch it off (one drape at a time).
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
  const on = await grab();
  await page.evaluate(async (id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), ID);
  const off = await grab();
  let changed = 0;
  const onColours = new Set();
  for (let i = 0; i < on.length; i += 4) {
    onColours.add((on[i] << 16) | (on[i + 1] << 8) | on[i + 2]);
    if (Math.hypot(on[i] - off[i], on[i + 1] - off[i + 1], on[i + 2] - off[i + 2]) > 30) changed += 1;
  }
  const s1 = await stats();
  // a blank 'on' screenshot (one colour) would make 'off' meaningless, so it is reported and must not pass
  report('drew', state.on && onColours.size > 20 && changed > 5000 && !s1?.error && s1?.time === DATE && s1?.count > 1000 && tiles.ok > 0 && tiles.bad.length === 0,
    { at: `${at.lat},${at.lon} (${at.drawn})`, coloursWhenOn: onColours.size, pixelsChangedWhenOff: changed, stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });
  await page.evaluate(async (id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), ID);

  // only tiles the manifest lists were ever requested
  const listed = new Set(Object.entries(manifest?.tiles ?? {}).flatMap(([z, l]) => l.map(([x, y]) => `${z}/${x}/${y}`)));
  const unlisted = [...tiles.urls].map((u) => u.match(/\/data\/forty\/(\d+\/\d+\/\d+)\.png/)?.[1]).filter((k) => !listed.has(k));
  report('only-listed-tiles-requested', listed.size > 1000 && tiles.urls.size > 0 && unlisted.length === 0, { listed: listed.size, requested: tiles.urls.size, unlisted: unlisted.slice(0, 5) });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = [];
    for (const [lat, lon] of pts) out.push((await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const got = await readAll(sure.map((s) => [Number(s.lat), Number(s.lon)]));
  const wrong = sure.map((s, i) => [s, got[i]]).filter(([s, r]) => !(r?.status === 'class' && r.date === DATE && r.text === `${s.drawn} (most likely type)`));
  report('readout-names-the-native-type', wrong.length === 0, { points: sure.length, byType: Object.fromEntries([...new Set(sure.map((s) => s.drawn))].map((t) => [t, sure.filter((s) => s.drawn === t).length])), wrong: wrong.slice(0, 5).map(([s, r]) => `${s.lat},${s.lon} want ${s.drawn}: ${row(r)}`) });
  const none = await readAll(clear.map((s) => [Number(s.lat), Number(s.lon)]));
  const notNone = clear.map((s, i) => [s, none[i]]).filter(([, r]) => !(r?.status === 'class' && r.text === NONE_TEXT && r.date === DATE));
  report('clear-points', notNone.length === 0, { points: clear.length, wrong: notNone.slice(0, 5).map(([s, r]) => `${s.lat},${s.lon}: ${row(r)}`) });

  // legend: each class with the manifest's area, then the note
  const legend = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend, ID);
  const want = (manifest?.classes ?? []).map((c) => `${c.label}, ${c.km2.toLocaleString('en-US')} km²`);
  report('legend', want.length === 5 && legend.length === 6 && legend.slice(0, 5).every((l, i) => l.label === want[i]) && /F1 58\.2%/.test(legend.at(-1)?.label ?? ''), { legend: legend.map((l) => l.label) });

  // a fixed map: no hook through which the time bar could reach it (hansen-loss, a time sampler, is the control)
  const hooks = await page.evaluate((id) => {
    const mod = (lid) => window.__godsEyeView.dataManager.layers.get(lid)?.module;
    const has = (lid) => ['setObservedTime', 'getObservedExtent'].filter((k) => typeof mod(lid)?.[k] === 'function');
    return { ours: has(id), sampler: has('hansen-loss') };
  }, ID);
  report('not-on-the-time-bar', hooks.ours.length === 0 && hooks.sampler.includes('setObservedTime'), hooks);

  // every pixel of the level-7 tiles the readouts used, decoded from the file's bytes by the site's own table
  const urls = [...tiles.urls].filter((u) => /\/forty\/7\/\d+\/\d+\.png/.test(u));
  const counts = { class: 0, none: 0 };
  const byClass = {};
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = manifest ? decodeForty(px, manifest) : { kind: 'unknown' };
      if (v.kind in counts) counts[v.kind] += 1;
      else unknown[px.join(',')] = (unknown[px.join(',')] || 0) + 1;
      if (v.kind === 'class') byClass[v.index] = (byClass[v.index] || 0) + 1;
    }
  }
  report('every-pixel-decodes', !!manifest && urls.length >= 10 && counts.none > 0 && Object.keys(byClass).length >= 4 && Object.keys(unknown).length === 0,
    { level7Tiles: urls.length, ...counts, byClass, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
} catch (e) {
  report('run', false, { error: String(e?.stack || e?.message || e).slice(0, 400) });
} finally {
  await browser.close();
}
report('no-404-or-console-errors', tiles.bad.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
  { tilesBad: tiles.bad.slice(0, 5), consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok, tilesBad: tiles.bad.length }));
process.exit(failed ? 1 : 0);
