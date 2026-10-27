#!/usr/bin/env node
/**
 * qa-esri-lulc.mjs — real-browser acceptance for the Land cover 10 m (Esri/Impact Observatory, yearly) layer.
 * Run: node scripts/qa-esri-lulc.mjs [--url https://musharna.github.io/wildeye/] [--samples docs/analysis/esri_lulc_samples.tsv]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from analysis/esri_lulc_drawn_vs_source.py: at each sampled point and year, the class the
 * service's getSamples gives, kept where the tile the script built on its own decodes to the same class. The readout
 * must name it for that year with the time bar on that year, and must say "no land cover" where getSamples has no
 * data and the tile is transparent.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { CLASSES, FIRST_YEAR, LAST_YEAR, NONE_TEXT, decodeLulcPixel } from '../src/data/esriLulc.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const SAMPLES = arg('--samples', path.join(import.meta.dirname, '..', 'docs', 'analysis', 'esri_lulc_samples.tsv'));
const ID = 'esri-lulc';
const TILE = /Sentinel2_10m_LandCover\/ImageServer\/exportImage/;
// Des Moines and the farmland round it: city, crops, trees and water in one 400 km view
const VIEW = [41.6, -93.6];
const LABEL = new Map(CLASSES.map((c) => [String(c.value), c.label]));
const yearOf = (url) => new Date(Number(new URL(url).searchParams.get('time'))).getUTCFullYear();

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
const sure = samples.filter((s) => LABEL.has(s.service) && s.drawn === s.service);
const sea = samples.filter((s) => s.drawn === 'none' && s.service === 'http 400');
const years = [...new Set(sure.map((s) => Number(s.year)))].sort();
report('truth', sure.length >= 120 && sea.length >= 20 && years.join() === `${FIRST_YEAR},2021,${LAST_YEAR}`, { samples: samples.length, sureClasses: sure.length, sea: sea.length, years });

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
const tiles = { ok: 0, bad: [], urls: new Set() };
const failedRequests = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /lulc|land cover|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('requestfailed', (r) => {
    // a superseded tile Cesium cancels is not a failure
    if (TILE.test(r.url()) && r.failure()?.errorText !== 'net::ERR_ABORTED') failedRequests.push(`${r.failure()?.errorText} ${r.url()}`);
  });
  page.on('response', (r) => {
    if (!TILE.test(r.url())) return;
    tiles.urls.add(r.url());
    const png = /^image\/png/.test(r.headers()['content-type'] ?? '');
    if ((r.status() === 200 || r.status() === 304) && png) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.headers()['content-type']} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

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
  // tiles have stopped arriving: the count unchanged for 4 s
  const settle = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 240 && still < 8; i += 1) {
      await sleep(500);
      const n = tiles.ok + tiles.bad.length;
      still = n > 0 && n === last ? still + 1 : 0;
      last = n;
    }
  };
  const stats = () => page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);
  const showYear = (iso, want) => page.evaluate(async (id, iso, want) => {
    const { dataManager, observedTime } = window.__godsEyeView;
    observedTime.set(iso);
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 40 && s()?.time !== want; i += 1) await new Promise((r) => setTimeout(r, 250));
    return s() ?? null;
  }, ID, iso, want);

  await page.evaluate(([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 400000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, VIEW);
  // Another drape first: switching this layer on must switch it off (one drape at a time).
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
  const liveYears = [...new Set([...tiles.urls].map(yearOf))];
  report('drew', state.on && onColours.size > 20 && changed > 2000 && !s1?.error && s1?.time === String(LAST_YEAR) && tiles.ok > 0 && tiles.bad.length === 0 && liveYears.join() === String(LAST_YEAR),
    { at: VIEW.join(','), coloursWhenOn: onColours.size, pixelsChangedWhenOff: changed, stats: s1, tiles200: tiles.ok, tileYears: liveYears, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });
  await page.evaluate(async (id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), ID);

  const extent = await page.evaluate((id) => {
    const s = window.__godsEyeView.observedTime;
    return { mine: s.extents().get(id) ?? null, domainStart: s.domain()?.start ?? null };
  }, ID);
  report('time-bar-reaches-2017', extent.mine?.startMs === Date.UTC(FIRST_YEAR, 0, 1) && extent.mine?.endMs >= Date.UTC(LAST_YEAR, 11, 31) && extent.domainStart !== null && extent.domainStart <= Date.UTC(FIRST_YEAR, 0, 1),
    { extent: extent.mine, domainStart: extent.domainStart && new Date(extent.domainStart).toISOString() });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = [];
    for (const [lat, lon] of pts) out.push((await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;

  // each sampled year with the time bar on it; the tiles drawn after the switch carry that year
  for (const year of years) {
    const iso = year === LAST_YEAR ? null : `${year}-06-15T00:00:00Z`;
    const before = new Set(tiles.urls);
    const s = await showYear(iso, String(year));
    await settle();
    const fresh = [...tiles.urls].filter((u) => !before.has(u));
    const freshYears = [...new Set(fresh.map(yearOf))];
    const mine = sure.filter((p) => Number(p.year) === year);
    const got = await readAll(mine.map((p) => [Number(p.lat), Number(p.lon)]));
    const wrong = mine.map((p, i) => [p, got[i]]).filter(([p, r]) => !(r?.status === 'class' && r.date === String(year) && r.text === LABEL.get(p.service)));
    const seaHere = sea.filter((p) => Number(p.year) === year);
    const none = await readAll(seaHere.map((p) => [Number(p.lat), Number(p.lon)]));
    const notNone = seaHere.map((p, i) => [p, none[i]]).filter(([, r]) => !(r?.status === 'class' && r.text === NONE_TEXT && r.date === String(year)));
    // live comes back to the newest year without new tiles (its imagery was drawn first), so only scrubs need fresh ones
    const tilesOk = iso === null ? freshYears.every((y) => y === year) : fresh.length > 0 && freshYears.join() === String(year);
    report(`readout-${year}`, s?.time === String(year) && !s?.error && tilesOk && wrong.length === 0 && notNone.length === 0 && mine.length >= 40,
      { shown: s?.time, freshTiles: fresh.length, freshTileYears: freshYears, points: mine.length, byClass: Object.fromEntries([...new Set(mine.map((p) => LABEL.get(p.service)))].map((l) => [l, mine.filter((p) => LABEL.get(p.service) === l).length])), sea: seaHere.length,
        wrong: wrong.slice(0, 5).map(([p, r]) => `${p.lat},${p.lon} want ${LABEL.get(p.service)}: ${row(r)}`), notNone: notNone.slice(0, 5).map(([p, r]) => `${p.lat},${p.lon}: ${row(r)}`) });
  }

  // before the first map: hidden and said so; LIVE draws the newest year again (a sampled point is the positive control).
  // The bar clamps to the enabled layers' extents, which start in 2017 with this layer alone, so a probe extent from
  // 2005 stands in for another layer that reaches further back (as Hansen forest loss does).
  const probe = sure.find((p) => Number(p.year) === LAST_YEAR);
  await page.evaluate(() => window.__godsEyeView.observedTime.setLayerExtent('qa-probe', { startMs: Date.UTC(2005, 0, 1), endMs: Date.now() }));
  const early = await showYear('2010-06-01T00:00:00Z', null);
  const [earlyRead] = await readAll([[Number(probe.lat), Number(probe.lon)]]);
  const shownEarly = await page.evaluate((id) => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const v = window.__godsEyeView.dataManager.layers.get(id);
    return v ? Array.from({ length: layers.length }, (_, i) => layers.get(i)).filter((l) => l.imageryProvider?.url?.includes('Sentinel2_10m_LandCover')).map((l) => l.show) : null;
  }, ID);
  const back = await showYear(null, String(LAST_YEAR));
  await page.evaluate(() => window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null));
  const [backRead] = await readAll([[Number(probe.lat), Number(probe.lon)]]);
  report('before-2017-hidden', early?.time === null && /no land cover is mapped before 2017/.test(early?.error ?? '') && earlyRead?.status === 'outside' && shownEarly?.length === 1 && shownEarly[0] === false
    && back?.time === String(LAST_YEAR) && !back?.error && backRead?.text === LABEL.get(probe.service),
    { early: { time: early?.time, error: early?.error, read: row(earlyRead), imageryShown: shownEarly }, live: { time: back?.time, error: back?.error, read: row(backRead) } });

  const legend = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend, ID);
  report('legend', legend.length === CLASSES.length + 1 && CLASSES.every((c, i) => legend[i].label === c.label && legend[i].color === `rgb(${c.rgb.join(',')})`) && /One map a year 2017–2025/.test(legend.at(-1)?.label ?? '') && /CC BY 4\.0/.test(legend.at(-1)?.label ?? ''),
    { legend: legend.map((l) => l.label) });

  // every pixel of up to 16 drawn tiles, fetched again here and decoded by the site's own table
  const urls = [...tiles.urls].slice(0, 16);
  const counts = { class: 0, none: 0 };
  const byClass = {};
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const v = decodeLulcPixel([data[i], data[i + 1], data[i + 2], data[i + 3]]);
      if (v.kind in counts) counts[v.kind] += 1;
      else unknown[v.rgba.join(',')] = (unknown[v.rgba.join(',')] || 0) + 1;
      if (v.kind === 'class') byClass[v.label] = (byClass[v.label] || 0) + 1;
    }
  }
  report('every-pixel-decodes', urls.length >= 8 && counts.class > 0 && Object.keys(byClass).length >= 3 && Object.keys(unknown).length === 0,
    { tiles: urls.length, ...counts, byClass, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
} catch (e) {
  report('run', false, { error: String(e?.stack || e?.message || e).slice(0, 400) });
} finally {
  await browser.close();
}
report('no-tile-or-console-errors', tiles.bad.length === 0 && failedRequests.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
  { tilesBad: tiles.bad.slice(0, 5), failedRequests: failedRequests.slice(0, 5), consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok, tilesBad: tiles.bad.length }));
process.exit(failed ? 1 : 0);
