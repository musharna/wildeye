#!/usr/bin/env node
/**
 * qa-protected-areas.mjs — real-browser acceptance for the Protected areas (OpenStreetMap) layer (spec
 * 2026-10-03-protected-areas-design.md).
 * Run: node scripts/qa-protected-areas.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Eight national parks on six continents, each named by its OSM relation and a deep interior point (the point farthest
 * from its boundary, from Overture release 2026-09-23.1's geometry, 2026-10-03): flown to, the globe's centre must turn the
 * colour of the most protective group the site's own lookup shard puts at that point, and the readout must name the park.
 * The tiles (rasterised in the pipeline) and the shards (tested point by point here, in the browser's code) are two
 * routes to the same answer. Yellowstone's west boundary, read from the shard, is checked 0.02° (~1.6 km, under three
 * finest pixels) either side, so a pyramid shifted or flipped by more than that shows. An unprotected point stays as it
 * was and reads none.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { NONE_TEXT, areasAt, decodeShard, inPolygon, shardKey } from '../src/data/protectedAreas.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'protected-areas';
// [label, OSM relation, interior lat, lon]
const PARKS = [
  ['Yellowstone', 'r1453306', 44.5806, -110.646],
  ['Banff', 'r6365995', 51.4284, -115.807],
  ['Manú', 'r11256967', -12.0833, -71.5835],
  ['Serengeti', 'r4475047', -2.5546, 34.8197],
  ['Kruger', 'r1752987', -23.0578, 31.2114],
  ['Białowieża', 'r252148', 52.7652, 23.8687],
  ['Sagarmatha', 'r3531450', 27.9211, 86.6891],
  ['Kakadu', 'r13000016', -12.5255, 132.5035],
];
// farmland and steppe, far from any park; the first with no area within 0.05° in the served shards is used
const UNPROTECTED = [[41.9, -93.6], [-33.5, -61.5], [48.5, 45.0], [30.6, 31.5]];
const EDGE_LAT = 44.6;
const EDGE_STEP = 0.02;

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
const tiles = { ok: 0, bad: [], unlisted: [], pending: 0, lastAt: 0 };
let listed = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /protected|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  const isTile = (url) => /\/data\/protected\/tiles\//.test(url);
  page.on('request', (r) => { if (isTile(r.url())) { tiles.pending += 1; tiles.lastAt = Date.now(); } });
  page.on('requestfailed', (r) => { if (isTile(r.url())) { tiles.pending -= 1; tiles.lastAt = Date.now(); tiles.bad.push(`failed ${r.url()}`); } });
  page.on('response', (r) => {
    const m = r.url().match(/\/data\/protected\/tiles\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (!m) return;
    tiles.pending -= 1;
    tiles.lastAt = Date.now();
    if (r.status() === 200 || r.status() === 304) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
    if (listed && !listed.has(`${m[1]}/${m[2]}/${m[3]}`)) tiles.unlisted.push(`${m[1]}/${m[2]}/${m[3]}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Moved, and two frames rendered there: until a frame is drawn at the new view no tile is requested and
  // globe.tilesLoaded still describes the last view, so a settle right after setView would read the old state.
  let movedAt = 0;
  const look = async ([lat, lon], height) => {
    await page.evaluate(async ([la, lo, h]) => {
      const v = window.__godsEyeView.viewer;
      v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lo, la, h), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      for (let i = 0; i < 2; i += 1) {
        v.scene.requestRender();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, [lat, lon, height]);
    movedAt = Date.now();
  };
  // The view's tiles in: globe tiles loaded and none of this layer's tile requests open for 1.5 s since the later of the
  // last tile and the last move (a layer switched on or off is a move too). Until the finer tiles
  // arrive Cesium stretches a coarse parent over the view, and a sample then reads the coarse level, not the place.
  const settle = async () => {
    for (let i = 0; i < 120; i += 1) {
      const globe = await page.evaluate(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded);
      if (globe && tiles.pending <= 0 && Date.now() - Math.max(tiles.lastAt, movedAt) > 1500) return true;
      await sleep(500);
    }
    throw new Error(`tiles did not settle: ${tiles.pending} protected tile requests open`);
  };
  // Share of the globe's centre within 40 of each palette colour, and the centre's mean colour, rendered and read in one task.
  const centre = async (palette) => (await settle()) && page.evaluate(async (pal) => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 60; c.height = 60;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 30, src.height / 2 - 30, 60, 60, 0, 0, 60, 60);
    const d = g.getImageData(0, 0, 60, 60).data;
    const near = pal.map(() => 0);
    const mean = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      pal.forEach((want, k) => { if (Math.hypot(d[i] - want[0], d[i + 1] - want[1], d[i + 2] - want[2]) < 40) near[k] += 1; });
      for (let k = 0; k < 3; k += 1) mean[k] += d[i + k] / (d.length / 4);
    }
    return { near: near.map((v) => v / (d.length / 4)), mean: mean.map(Math.round) };
  }, palette);
  const stats = () => page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);
  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null;
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;

  // The manifest and shards the site serves, before the layer is on, to choose where to look and what colour to expect.
  const served = await page.evaluate(async () => (await fetch('data/protected_areas.json')).json());
  listed = new Set(Object.entries(served.tiles).flatMap(([z, list]) => list.map(([x, y]) => `${z}/${x}/${y}`)));
  const shardSet = new Set(served.shards.map(([la, lo]) => `${la}_${lo}`));
  const shards = new Map();
  const shardAt = async (lat, lon) => {
    const key = shardKey(lat, lon, served.shard_degrees);
    if (!shardSet.has(key)) return null;
    if (!shards.has(key)) {
      const [la, lo] = key.split('_');
      const raw = await page.evaluate(async (u) => (await fetch(u)).json(), served.shard.replace('{lat}', la).replace('{lon}', lo));
      shards.set(key, decodeShard(raw, served.coord_scale));
    }
    return shards.get(key);
  };
  const found = async (lat, lon) => {
    const s = await shardAt(lat, lon);
    return s ? areasAt(s, lat, lon, served.classes) : [];
  };
  const topGroup = async (lat, lon) => Math.max(0, ...(await found(lat, lon)).map((a) => served.classes[a.class].group));
  const palette = served.palette.slice(1); // groups 1–3
  const share = (c, group) => (group ? c.near[group - 1] : Math.max(...c.near));

  // a candidate with no area's bounds within 0.1° (the 40 km view's sample is about 0.02° across)
  const clearAround = async (lat, lon, r) => {
    for (const la of [lat - r, lat + r]) for (const lo of [lon - r, lon + r]) {
      for (const a of (await shardAt(la, lo))?.areas ?? []) {
        for (const rings of a.polygons) for (let i = 0; i < rings[0].length; i += 2) {
          if (Math.abs(rings[0][i] - lon) <= r && Math.abs(rings[0][i + 1] - lat) <= r) return false;
        }
        if (a.polygons.some((rings) => inPolygon(rings, lon, lat))) return false;
      }
    }
    return true;
  };
  let empty = null;
  for (const [lat, lon] of UNPROTECTED) if (await clearAround(lat, lon, 0.1)) { empty = [lat, lon]; break; }
  // Yellowstone's west boundary on EDGE_LAT, from its pieces in the shards either side of 111°W (each piece is clipped to
  // its cell, so a crossing on a cell line is the clip, not the boundary): the westmost real crossing of that latitude
  const ysParts = [];
  for (const lon of [-111.5, -110.5]) ysParts.push(...((await shardAt(EDGE_LAT, lon))?.areas ?? []).filter((a) => a.osm === 'r1453306'));
  const onCellLine = (x) => Math.abs(x / served.shard_degrees - Math.round(x / served.shard_degrees)) < 1e-6;
  let westEdge = null;
  for (const part of ysParts) {
    for (const rings of part.polygons) {
      const r = rings[0];
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const [xi, yi, xj, yj] = [r[i], r[i + 1], r[j], r[j + 1]];
        if ((yi > EDGE_LAT) !== (yj > EDGE_LAT)) {
          const x = xi + ((EDGE_LAT - yi) * (xj - xi)) / (yj - yi);
          if (!onCellLine(x) && (westEdge === null || x < westEdge)) westEdge = x;
        }
      }
    }
  }
  if (!empty || westEdge === null) throw new Error(`nothing to check: unprotected ${JSON.stringify(empty)}, Yellowstone west edge ${westEdge}`);
  const inside = [EDGE_LAT, westEdge + EDGE_STEP], outside = [EDGE_LAT, westEdge - EDGE_STEP];
  const inYs = ([lat, lon]) => ysParts.some((part) => part.polygons.some((rings) => inPolygon(rings, lon, lat)));
  const ysInside = inYs(inside) && !inYs(outside);

  const parkGroups = [];
  for (const p of PARKS) parkGroups.push(await topGroup(p[2], p[3]));
  const edgeGroups = { inside: await topGroup(...inside), outside: await topGroup(...outside) };

  await look(inside, 15000);
  const insideBefore = await centre(palette);

  // Another drape first: switching protected areas on must switch it off (one drape at a time).
  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('surface-water', true, { origin: 'user' });
    const otherOn = dataManager.isEnabled('surface-water');
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate && !s()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled('surface-water') };
  }, ID);

  await look(inside, 15000);
  const insideAfter = await centre(palette);
  await look(outside, 15000);
  const outsideAfter = await centre(palette);
  const s1 = await stats();
  report('drew', state.on && !s1?.error && s1?.time === served.release && tiles.ok > 0 && tiles.bad.length === 0, { stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });
  const npGroup = served.classes.national_park.group;
  report('yellowstone-west-edge-in-its-place',
    ysInside && edgeGroups.inside >= npGroup && share(insideBefore) <= 0.1 && share(insideAfter, edgeGroups.inside) >= 0.5 && outsideAfter.near[npGroup - 1] <= 0.1
      && (edgeGroups.outside ? share(outsideAfter, edgeGroups.outside) >= 0.5 : share(outsideAfter) <= 0.1),
    { westEdge, inside, outside, groups: edgeGroups, insideBefore: insideBefore.near, insideAfter: insideAfter.near, outsideAfter: outsideAfter.near });

  const date = `OpenStreetMap via Overture ${served.release}`;
  const live = await readAll(Object.fromEntries(PARKS.map((p) => [p[0], [p[2], p[3]]])));
  for (const [i, [label, osm, lat, lon]] of PARKS.entries()) {
    await look([lat, lon], 40000);
    const c = await centre(palette);
    const g = parkGroups[i];
    const r = live[label];
    report(`park-${label}`, g >= npGroup && share(c, g) >= 0.5 && r?.status === 'value' && r.date === date && r.text.includes(`OSM ${osm}`),
      { osm, at: [lat, lon], group: g, near: c.near, mean: c.mean, got: row(r) });
  }

  // The same view with the layer on and then off: nothing of it may show, so the two frames match.
  await look(empty, 40000);
  const emptyOn = await centre(palette);
  const none = (await readAll({ empty }))?.empty;
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), ID);
  await look(empty, 40000);
  const emptyOff = await centre(palette);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), ID);
  const shift = Math.hypot(...emptyOn.mean.map((v, k) => v - emptyOff.mean[k]));
  // palette-coloured pixels the imagery has of its own (dark farmland near the strict green) are in both frames
  report('negative-unprotected-point', Math.max(...emptyOn.near.map((v, k) => v - emptyOff.near[k])) <= 0.01 && shift < 6 && none?.status === 'value' && none.text === NONE_TEXT && none.date === date,
    { at: empty, nearOn: emptyOn.near, nearOff: emptyOff.near, meanOn: emptyOn.mean, meanOff: emptyOff.mean, got: row(none) });

  // A fixed snapshot: moving the time bar neither redraws the layer nor changes what it reads. The globe may still be
  // streaming tiles for the last camera move, so a redraw is told by the imagery layer object, which a redraw replaces.
  const imagery = () => page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const ours = [];
    for (let i = 0; i < layers.length; i += 1) if (String(layers.get(i).imageryProvider?.url ?? '').includes('data/protected/tiles/')) ours.push(layers.get(i));
    if (ours.length !== 1) return `imagery layers drawing protected tiles: ${ours.length}`;
    if (!window.__qaProtectedImagery) window.__qaProtectedImagery = ours[0];
    return window.__qaProtectedImagery === ours[0] ? 'same' : 'replaced';
  });
  const before = await imagery();
  // With no time-aware layer on, the bar has no domain and set() is a no-op: a probe extent gives it one, and the
  // check requires the instant to have moved, so a bar that never moved cannot pass it.
  const moved = await page.evaluate(() => {
    const t = window.__godsEyeView.observedTime;
    t.setLayerExtent('qa-probe', { startMs: Date.parse('2000-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
    t.set('2010-06-01T00:00:00Z');
    return t.get();
  });
  await sleep(3000);
  const after = await imagery();
  const s2 = await stats();
  const past = (await readAll({ ys: [PARKS[0][2], PARKS[0][3]] })).ys;
  report('ignores-the-time-bar', moved?.startsWith('2010-06-01') && before === 'same' && after === 'same' && s2?.time === served.release && !s2?.error && past?.text === live.Yellowstone?.text,
    { moved, imageryBefore: before, imageryAfter: after, stats: s2, ys: row(past) });
  await page.evaluate(() => {
    window.__godsEyeView.observedTime.set(null);
    window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null);
  });

  const legend = await page.evaluate(() => document.body.textContent.includes('not an official registry'));
  report('legend-names-the-caveat', legend);
  report('only-listed-tiles-requested', tiles.unlisted.length === 0 && tiles.ok > 0, { unlisted: tiles.unlisted.slice(0, 5), requested: tiles.ok });
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
