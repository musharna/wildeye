// src/data/protectedAreas.test.mjs — the protected-areas layer: manifest, shard keys, point in polygon, readout, listed tiles only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  MANIFEST_URL,
  NONE_TEXT,
  TILE_FAILURE_LIMIT,
  areaText,
  areasAt,
  createProtectedAreasLayer,
  inPolygon,
  listedTilesOnly,
  readoutText,
  shardKey,
  validateProtectedManifest,
} from './protectedAreas.js';

// the pipeline's tables (pipeline/protected_areas.py CLASSES, GROUPS, PALETTE)
const CLASSES = {
  strict_nature_reserve: { group: 3, label: 'strict nature reserve' },
  wilderness_area: { group: 3, label: 'wilderness area' },
  national_park: { group: 2, label: 'national park' },
  forest: { group: 1, label: 'protected forest' },
  aboriginal_land: { group: null, label: 'aboriginal land' },
};
const sq = (w, s, e, n) => [w, s, e, s, e, n, w, n]; // a closed-by-wrap ring, closing point dropped as the pipeline writes
const YS = { name: 'Yellowstone National Park', class: 'national_park', title: 'National Park', operator: 'National Park Service', osm: 'r1453306', wikidata: 'Q351', km2: 8896.61, polygons: [[sq(-111.1, 44.1, -109.9, 45.1)]] };
const WILD = { name: 'Teton Wilderness', class: 'wilderness_area', title: 'Wilderness Area', operator: 'United States Forest Service', osm: 'r6000828', wikidata: null, km2: 2364.65, polygons: [[sq(-110.5, 44.0, -110.0, 44.3)]] };
const FOREST = { name: 'Custer Gallatin National Forest', class: 'forest', title: 'National Forest', operator: 'United States Forest Service', osm: 'r2146884', wikidata: null, km2: 13436.61, polygons: [[sq(-112, 44.0, -109, 46)]] };
const SHARD = { cell: [40, -115], areas: [FOREST, YS, WILD] };
const MANIFEST = Object.freeze({
  release: '2026-09-23.1',
  generated_at: '2026-10-03T06:00:00Z',
  maxLevel: 2,
  tile: 'data/protected/tiles/{z}/{x}/{y}.png',
  tiles: { 0: [[0, 0]], 1: [[0, 0]], 2: [[1, 0], [1, 1]] },
  palette: [[0, 0, 0], [161, 217, 155], [65, 171, 93], [0, 90, 50]],
  groups: [{ index: 3, key: 'strict', label: 'Strict reserve or wilderness (IUCN Ia/Ib)' }, { index: 2, key: 'national_park', label: 'National park (IUCN II)' }, { index: 1, key: 'other', label: 'Other protection' }],
  classes: CLASSES,
  shard_degrees: 5,
  shard: 'data/protected/shards/{lat}_{lon}.json',
  shards: [[40, -115]],
  counts: { areas: 3, by_group: { strict: 1, national_park: 1, other: 1 } },
});

function harness({ manifest = MANIFEST, shardStatus = 200 } = {}) {
  const providers = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createProtectedAreasLayer({
    fetchImpl: async (url) => {
      fetches.push(url);
      if (url === MANIFEST_URL) return { ok: true, status: 200, json: async () => structuredClone(manifest) };
      return { ok: shardStatus === 200, status: shardStatus, json: async () => structuredClone(SHARD) };
    },
    providerFor: (options) => {
      const listeners = [], requested = [];
      const p = {
        options,
        requested,
        requestImage: (x, y, level) => { requested.push(`${level}/${x}/${y}`); return Promise.resolve(`image ${level}/${x}/${y}`); },
        errorEvent: { addEventListener: (fn) => listeners.push(fn) },
        fail: (error) => listeners.forEach((fn) => fn({ error })),
      };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: (_layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
    blank: () => 'blank',
  });
  layer.init(viewer);
  return { layer, providers, list, stacked, fetches };
}

test('manifest: the shape the pipeline writes passes; each broken part is named', () => {
  assert.equal(validateProtectedManifest(MANIFEST), null);
  const bad = (patch) => validateProtectedManifest({ ...structuredClone(MANIFEST), ...patch });
  assert.match(bad({ release: '2026-09-23' }), /release/);
  assert.match(bad({ tiles: { 0: [[0, 0]], 1: [[0, 0]] } }), /no list for level 2/);
  assert.match(bad({ tiles: { ...MANIFEST.tiles, 2: [[8, 0]] } }), /not on level 2/); // level 2 has 8 columns, 0–7
  assert.match(bad({ tiles: { ...MANIFEST.tiles, 1: [[0, 2]] } }), /not on level 1/); // and 2 rows, 0–1
  assert.match(bad({ palette: MANIFEST.palette.slice(1) }), /palette/);
  assert.match(bad({ classes: { x: { group: 4, label: 'x' } } }), /classes/);
  assert.match(bad({ shards: [[42, -115]] }), /south-west corner/);
  assert.match(bad({ shards: [[90, 0]] }), /south-west corner/);
  assert.match(bad({ shard: 'data/x.json' }), /lacks/);
  assert.match(bad({ counts: {} }), /counts/);
});

test("tile keys: the pipeline's tile (x, y, level), y from the north, is the rectangle Cesium's GeographicTilingScheme asks for", () => {
  const scheme = new Cesium.GeographicTilingScheme();
  for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [7, 3, 2], [3, 1, 2], [255, 127, 7], [100, 40, 7]]) {
    const d = 180 / 2 ** z; // pipeline tile_bounds: (-180 + x d, 90 - (y + 1) d, -180 + (x + 1) d, 90 - y d)
    const r = scheme.tileXYToRectangle(x, y, z);
    const got = [r.west, r.south, r.east, r.north].map((v) => Cesium.Math.toDegrees(v));
    const want = [-180 + x * d, 90 - (y + 1) * d, -180 + (x + 1) * d, 90 - y * d];
    got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `z${z} ${x},${y}: ${got} vs ${want}`));
  }
});

test('shard key: the 5° cell the pipeline writes (pipeline shard_key), the north and east edges folded in', () => {
  assert.equal(shardKey(44.6, -110.5), '40_-115');
  assert.equal(shardKey(90, 180), '85_175');
  assert.equal(shardKey(-90, -180), '-90_-180');
  assert.equal(shardKey(-0.1, -0.1), '-5_-5');
  assert.equal(shardKey(44.6, 249.5), '40_-115', 'a longitude past 180 wraps');
  assert.equal(shardKey(91, 0), null);
  assert.equal(shardKey(Number.NaN, 0), null);
});

test('point in polygon: inside the exterior and outside its hole; even–odd over flat rings', () => {
  const holey = [sq(0, 0, 10, 10), sq(4, 4, 6, 6)];
  assert.equal(inPolygon(holey, 2, 2), true); // positive control
  assert.equal(inPolygon(holey, 5, 5), false, 'in the hole');
  assert.equal(inPolygon(holey, 11, 5), false, 'outside');
  assert.equal(inPolygon([[0, 0, 10, 0, 0, 10]], 2, 2), true, 'a triangle');
  assert.equal(inPolygon([[0, 0, 10, 0, 0, 10]], 6, 6), false, 'past its hypotenuse');
});

test('readout order: most protective group first, then smallest; texts name kind, designation, operator and OSM id', () => {
  const found = areasAt(SHARD, 44.2, -110.2, CLASSES);
  assert.deepEqual(found.map((a) => a.osm), ['r6000828', 'r1453306', 'r2146884']); // wilderness (3), park (2), forest (1)
  assert.deepEqual(areasAt(SHARD, 44.8, -110.5, CLASSES).map((a) => a.osm), ['r1453306', 'r2146884']);
  assert.deepEqual(areasAt(SHARD, 40.5, -114.5, CLASSES), []);
  assert.equal(areaText(YS, CLASSES), 'Yellowstone National Park (national park) · National Park Service · OSM r1453306', 'a designation that only repeats the kind is not repeated');
  assert.equal(areaText(FOREST, CLASSES), 'Custer Gallatin National Forest (protected forest, National Forest) · United States Forest Service · OSM r2146884');
  assert.equal(areaText({ ...YS, name: null, operator: null, title: null }, CLASSES), 'unnamed (national park) · OSM r1453306');
  assert.equal(readoutText([], CLASSES), NONE_TEXT);
  const four = [WILD, YS, FOREST, { ...FOREST, osm: 'w9' }];
  assert.match(readoutText(four, CLASSES), /^Teton Wilderness .*; Yellowstone .*; Custer .*; \+1 more$/);
});

test('listed tiles only: a tile the manifest lists is requested, any other is blank without a request', async () => {
  const requested = [];
  const p = listedTilesOnly({ requestImage: (x, y, level) => { requested.push(`${level}/${x}/${y}`); return Promise.resolve('img'); } }, new Set(['2/1/0']), () => 'blank');
  assert.equal(await p.requestImage(1, 0, 2), 'img'); // positive control
  assert.equal(await p.requestImage(0, 1, 2), 'blank');
  assert.equal(await p.requestImage(1, 0, 1), 'blank', 'the same x, y on another level is another tile');
  assert.deepEqual(requested, ['2/1/0']);
});

test('drape: one geographic provider over listed tiles, stacked, shown only while enabled, redrawn after tiles fail', async () => {
  const h = harness();
  assert.equal(await h.layer.update(), true);
  assert.equal(h.providers.length, 1);
  const p = h.providers[0];
  assert.equal(p.options.url, 'data/protected/tiles/{z}/{x}/{y}.png?v=2026-09-23.1');
  assert.ok(p.options.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(p.options.maximumLevel, 2);
  assert.equal(await p.requestImage(1, 1, 2), 'image 2/1/1');
  assert.equal(await p.requestImage(0, 0, 2), 'blank');
  assert.deepEqual(p.requested, ['2/1/1']);
  assert.equal(h.list.length, 1);
  assert.equal(h.list[0].show, false, 'drawn hidden until enabled');
  h.layer.enable();
  assert.equal(h.list[0].show, true);
  assert.deepEqual(h.stacked.map((s) => [s.id, s.zrank]), [['protected-areas', 23]]);
  for (let i = 0; i < TILE_FAILURE_LIMIT; i += 1) p.fail(new Error('404'));
  assert.equal(h.layer.getStats().error, 'map tiles failing');
  await h.layer.update();
  assert.equal(h.providers.length, 2, 'redrawn');
  assert.equal(h.layer.getStats().error, null);
  h.providers[0].fail(new Error('late'));
  assert.equal(h.layer.getStats().error, null, "the old provider's failures no longer count");
  h.layer.disable();
  assert.equal(h.list[0].show, false);
});

test('readout: off is null; a cell without a shard reads none without a fetch; a shard is fetched once; a failed one is retried', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(44.6, -110.5), null, 'off');
  await h.layer.update();
  h.layer.enable();
  const date = 'OpenStreetMap via Overture 2026-09-23.1';
  const r = await h.layer.readoutAt(44.8, -110.5);
  assert.deepEqual([r.status, r.date], ['value', date]);
  assert.match(r.text, /^Yellowstone National Park \(national park\).*; Custer Gallatin/);
  await h.layer.readoutAt(44.2, -110.2);
  assert.deepEqual(h.fetches.filter((u) => u !== MANIFEST_URL), ['data/protected/shards/40_-115.json?v=2026-09-23.1'], 'one fetch for two reads');
  const none = await h.layer.readoutAt(10, 10);
  assert.deepEqual([none.status, none.text, none.date], ['value', NONE_TEXT, date]);
  assert.equal(h.fetches.length, 2, 'no fetch for a cell the manifest has no shard for');
  assert.equal((await h.layer.readoutAt(91, 0)).status, 'outside');

  const f = harness({ shardStatus: 503 });
  await f.layer.update();
  f.layer.enable();
  const err = await f.layer.readoutAt(44.8, -110.5);
  assert.deepEqual([err.status, err.error], ['error', 'shard 40_-115 HTTP 503']);
  await f.layer.readoutAt(44.8, -110.5);
  assert.equal(f.fetches.filter((u) => u.includes('shards')).length, 2, 'a failed shard is fetched again');
});

test('a malformed manifest draws nothing and says why', async () => {
  const h = harness({ manifest: { ...MANIFEST, shard_degrees: 1 } });
  assert.equal(await h.layer.update(), false);
  assert.equal(h.providers.length, 0);
  assert.match(h.layer.getStats().error, /Malformed protected_areas.json: shard_degrees/);
  h.layer.enable();
  assert.equal((await h.layer.readoutAt(44.6, -110.5)).status, 'error');
});

test('legend: the three groups with their counts and the coverage caveat with the ODbL credit', async () => {
  const h = harness();
  await h.layer.update();
  const { legend } = h.layer.getRowControls();
  assert.deepEqual(legend.slice(0, 3).map((l) => [l.color, l.count]), [['rgb(0,90,50)', 1], ['rgb(65,171,93)', 1], ['rgb(161,217,155)', 1]]);
  assert.match(legend[3].label, /3 protected areas mapped in OpenStreetMap \(Overture 2026-09-23\.1\); OpenStreetMap's coverage is uneven and it is not an official registry · © OpenStreetMap contributors, ODbL/);
});

test('the built manifest and a shard it lists, when present, pass and read (real file)', (t) => {
  const path = new URL('../../public/data/protected_areas.json', import.meta.url);
  if (!existsSync(path)) {
    t.skip('public/data/protected_areas.json not built here (pipeline/protected_areas.py)');
    return;
  }
  const m = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(validateProtectedManifest(m), null);
  const [lat, lon] = m.shards.find(([la, lo]) => la === 40 && lo === -115) ?? m.shards[0];
  const s = JSON.parse(readFileSync(new URL(`../../public/${m.shard.replace('{lat}', lat).replace('{lon}', lon)}`, import.meta.url), 'utf8'));
  assert.deepEqual(s.cell, [lat, lon]);
  assert.ok(s.areas.length > 0 && s.areas.every((a) => m.classes[a.class]?.group));
  if (lat === 40 && lon === -115) assert.ok(areasAt(s, 44.6, -110.5, m.classes).some((a) => a.osm === 'r1453306'), 'Yellowstone at its centre');
});
