#!/usr/bin/env node
/**
 * qa-natural-lands.mjs — real-browser acceptance for the SBTN Natural Lands drape (spec 2026-10-06-natural-lands-design.md).
 * Run: node scripts/qa-natural-lands.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Two halves: (1) the live sources still say what src/data/naturalLands.js pins (the README's licence, the cache's
 * max zoom and colormap, and that tiles past level 12 add nothing); (2) the site draws the GFW tiles, turns another
 * drape off, shows the legend and credit, and at known points from the raw-data samples
 * (docs/analysis/natlands_legend_samples.tsv, read from the GeoTIFFs) the rendered globe is the colour GROUPS gives the
 * point's raw class. There is no readout to check: a colour stands for several classes.
 */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { CLASSES, GROUPS, MAX_LEVEL, TILE_URL } from '../src/data/naturalLands.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'natural-lands';
const OTHER = 'ifl';
const PREFIX = TILE_URL.slice(0, TILE_URL.indexOf('{z}'));
const ASSET = 'https://data-api.globalforestwatch.org/asset/fc4e9c41-06fe-4f95-86a3-718caae4e8fa/creation_options';

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tileAt = async (z, x, y) => {
  const res = await fetch(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y} HTTP ${res.status}`);
  return decodePng(new Uint8Array(await res.arrayBuffer()));
};
const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const groupOf = (v) => GROUPS.find((g) => g.classes.includes(v)) ?? null;

// (1) the live sources
const readme = Buffer.from((await (await fetch('https://api.github.com/repos/wri/natural-lands-map/readme')).json()).content, 'base64').toString('utf8');
report('source:licence', readme.includes('Creative Commons Attribution ShareAlike 4.0 International License') && readme.includes('creativecommons.org/licenses/by-sa/4.0'),
  { line: readme.split('\n').find((l) => /Creative Commons/.test(l))?.slice(0, 200) ?? null });
const opts = (await (await fetch(ASSET)).json()).data;
report('source:max-zoom', opts.max_zoom === MAX_LEVEL && opts.implementation === 'default_pro', { served: opts.max_zoom, pinned: MAX_LEVEL, implementation: opts.implementation });
const cmap = Object.fromEntries(Object.entries(opts.symbology.colormap).map(([k, c]) => [Number(k), [c.red, c.green, c.blue, c.alpha]]));
// the colormap lists 2–20; class 21 has no stop and the samples show it drawn grey (the crosstab says how often)
const off = Object.keys(CLASSES).map(Number).filter((v) => v in cmap && String(cmap[v]) !== String([...groupOf(v).rgb, 255]));
report('source:colormap-agrees-with-groups', off.length === 0 && Object.keys(cmap).length >= 20, { disagree: off, classesWithoutStop: Object.keys(CLASSES).filter((v) => !(v in cmap)) });
// past level 12 the cache upsamples: each child equals its parent's quarter doubled; level 11 → 12 is the control
const upsampled = async (z, x, y) => {
  const parent = await tileAt(z, x, y);
  let diff = 0;
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const child = await tileAt(z + 1, 2 * x + dx, 2 * y + dy);
    for (let j = 0; j < 256; j += 1) for (let i = 0; i < 256; i += 1)
      if (String(px(child, i, j)) !== String(px(parent, dx * 128 + (i >> 1), dy * 128 + (j >> 1)))) diff += 1;
    await sleep(300);
  }
  return diff;
};
const d12 = await upsampled(12, 1365, 2082); // near Manaus
const d11 = await upsampled(11, 682, 1041);
report('source:nothing-past-level-12', d12 === 0 && d11 > 1000, { level12to13: d12, controlLevel11to12: d11 });

// known points: per group, the first homogeneous uniform-pick sample whose level-12 tile pixel sits in a 31×31 block of
// the group's colour, so the rendered centre cannot straddle an edge
const [head, ...rows] = readFileSync(new URL('../docs/analysis/natlands_legend_samples.tsv', import.meta.url), 'utf8').trim().split('\n');
const keys = head.split('\t');
const samples = rows.map((r) => Object.fromEntries(r.split('\t').map((v, i) => [keys[i], v])));
const KNOWN = [];
for (const g of GROUPS) {
  for (const s of samples.filter((s) => s.homogeneous === '1' && s.pick.endsWith(':uniform') && g.classes.includes(Number(s.raw_class)) && Number(s.px) > 20 && Number(s.px) < 235 && Number(s.py) > 20 && Number(s.py) < 235)) {
    const img = await tileAt(12, s.x, s.y);
    let same = true;
    for (let j = -15; j <= 15 && same; j += 1) for (let i = -15; i <= 15 && same; i += 1) same = String(px(img, Number(s.px) + i, Number(s.py) + j)) === String([...g.rgb, 255]);
    await sleep(300);
    if (same) { KNOWN.push({ what: `${CLASSES[s.raw_class]} (${s.raw_tile})`, lat: Number(s.lat), lon: Number(s.lon), group: g.title, rgb: g.rgb }); break; }
  }
}
report('known-points', KNOWN.length === GROUPS.length, { points: KNOWN.map((k) => `${k.what} ${k.lat.toFixed(5)},${k.lon.toFixed(5)}`) });

// (2) the site
const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
const tiles = { ok: 0, bad: [], hops: 0, redirected: 0, urls: new Set(), levels: new Set() };
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /natural|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  // Counted per request at its end, through any redirect: a tile the cache has not rendered yet answers 307 to GFW's
  // dynamic tiler (`/dynamic/{z}/{x}/{y}.png?implementation=default_pro`), which draws it and stores it for next time.
  const asked = (req) => (req.redirectChain()[0] ?? req).url();
  page.on('requestfinished', (req) => {
    const url = asked(req);
    if (!url.startsWith(PREFIX)) return;
    const r = req.response();
    // the 307 hop finishes as a request of its own (puppeteer), and its follow-up is counted below at its end
    if (r && r.status() >= 300 && r.status() < 400) { tiles.hops += 1; return; }
    tiles.urls.add(url);
    tiles.levels.add(Number(url.slice(PREFIX.length).split('/')[0]));
    if (req.redirectChain().length) tiles.redirected += 1;
    if ((r?.status() === 200 && /^image\/png/.test(r.headers()['content-type'] ?? '')) || r?.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r?.status()} ${url}`);
  });
  page.on('requestfailed', (req) => {
    const url = asked(req);
    if (url.startsWith(PREFIX)) tiles.bad.push(`failed ${req.failure()?.errorText ?? ''} ${req.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const settle = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 180 && still < 8; i += 1) {
      await sleep(500);
      const n = tiles.ok + tiles.bad.length;
      still = n > 0 && n === last ? still + 1 : 0;
      last = n;
    }
  };
  const look = (lat, lon, h) => page.evaluate(async ([lat, lon, h]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, h), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    // two frames at the new view before anything reads tile state (LESSONS 2026-10-03, a settle that read the last view)
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, [lat, lon, h]);
  // the median colour of the 9×9 screen pixels at the centre, rendered and read back in one task
  const centre = () => page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 9; c.height = 9;
    const g = c.getContext('2d');
    g.drawImage(src, Math.round(src.width / 2) - 4, Math.round(src.height / 2) - 4, 9, 9, 0, 0, 9, 9);
    const d = g.getImageData(0, 0, 9, 9).data;
    const ch = (k) => { const a = []; for (let i = k; i < d.length; i += 4) a.push(d[i]); a.sort((x, y) => x - y); return a[40]; };
    return [ch(0), ch(1), ch(2)];
  });
  const nearest = (rgb) => GROUPS.map((g) => ({ g, d: Math.hypot(...g.rgb.map((v, i) => v - rgb[i])) })).sort((a, b) => a.d - b.d)[0];
  const stats = () => page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);

  // the first known point before the layer is on: the basemap there is not the group colour (the control for the after)
  await look(KNOWN[0].lat, KNOWN[0].lon, 8000);
  const before = await centre();
  const tilesBefore = tiles.urls.size;
  const state = await page.evaluate(async ([id, other]) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(other, true, { origin: 'user' });
    const otherOn = dataManager.isEnabled(other);
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled(other) };
  }, [ID, OTHER]);
  report('not-fetched-before-on', tilesBefore === 0, { tilesBefore });
  report('one-drape-at-a-time', state.on && state.otherOn === true && state.otherAfter === false, { [`${OTHER}Before`]: state.otherOn, [`${OTHER}After`]: state.otherAfter, on: state.on });

  for (const [i, k] of KNOWN.entries()) {
    if (i > 0) await look(k.lat, k.lon, 8000);
    await settle();
    const rgb = await centre();
    const n = nearest(rgb);
    // at the first point the basemap must not already read as the colour (else the check could not fail)
    const control = i > 0 || Math.hypot(...k.rgb.map((v, j) => v - before[j])) > 40;
    report(`point ${k.what}`, n.g.title === k.group && n.d < 40 && control, { want: k.group, wantRgb: k.rgb, rendered: rgb, nearest: n.g.title, distance: Math.round(n.d), ...(i === 0 ? { beforeOn: before, beforeDistance: Math.round(Math.hypot(...k.rgb.map((v, j) => v - before[j]))) } : {}) });
  }
  // a wide view draws coarse levels; together with the known points the drape reached level 12 and never past it
  await look(-3, -60, 3000000);
  await settle();
  const s1 = await stats();
  const levels = [...tiles.levels].sort((a, b) => a - b);
  report('tiles', tiles.ok > 0 && tiles.bad.length === 0 && tiles.hops === tiles.redirected && levels.at(-1) === MAX_LEVEL && !s1?.error,
    { tiles200: tiles.ok, redirectHops: tiles.hops, viaDynamicTiler: tiles.redirected, tilesBad: tiles.bad.length, badSample: tiles.bad.slice(0, 3), levels, stats: s1 });

  // A 2020 baseline: no time-bar hook (a time sampler, hansen-loss, is the control that the probe sees one)
  const hooks = await page.evaluate((id) => {
    const mod = (lid) => window.__godsEyeView.dataManager.layers.get(lid)?.module;
    const has = (lid) => ['setObservedTime', 'getObservedExtent'].filter((k) => typeof mod(lid)?.[k] === 'function');
    return { ours: has(id), sampler: has('hansen-loss') };
  }, ID);
  report('not-on-the-time-bar', hooks.ours.length === 0 && hooks.sampler.includes('setObservedTime'), hooks);

  // no readout row: the click card lists only layers that can say what is at a point
  const rows = await page.evaluate(async (id) => (await window.__godsEyeView.readoutAt(-3, -60)).filter((r) => r.id === id).length, ID);
  report('no-readout-row', rows === 0, { rows });

  const text = await page.evaluate(() => document.body.textContent);
  const want = {
    legend: GROUPS.every((g) => g.classes.every((v) => text.includes(CLASSES[v]))) && text.includes('a colour names a group, not a class'),
    licence: text.includes('CC BY-SA 4.0'),
    citation: text.includes('SBTN Natural Lands Map v1.1: Technical Documentation') && text.includes('Mazur, E., M. Sims'),
  };
  report('legend-and-credit', Object.values(want).every(Boolean), want);
  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?nl(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });
} catch (e) {
  report('run', false, { error: String(e?.stack || e?.message || e).slice(0, 400) });
} finally {
  await browser.close();
}
report('no-page-or-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok, viaDynamicTiler: tiles.redirected, tilesBad: tiles.bad.length }));
process.exit(failed ? 1 : 0);
