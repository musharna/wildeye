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
  decodeRing,
  decodeShard,
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
const SHARD = { cell: [44, -111], areas: [FOREST, YS, WILD] };
// as the pipeline writes it (pipeline/protected_areas.py _rings): integers of 1e-4°, first pair absolute, then differences
const encodeRing = (r) => r.map((v, i) => Math.round(v * 1e4) - (i >= 2 ? Math.round(r[i - 2] * 1e4) : 0));
const ENCODED = { ...SHARD, areas: SHARD.areas.map((a) => ({ ...a, polygons: a.polygons.map((rings) => rings.map(encodeRing)) })) };
const MANIFEST = Object.freeze({
  release: '2026-09-23.1',
  generated_at: '2026-10-03T06:00:00Z',
  maxLevel: 2,
  tile: 'data/protected/tiles/{z}/{x}/{y}.png',
  tiles: { 0: [[0, 0]], 1: [[0, 0]], 2: [[1, 0], [1, 1]] },
  palette: [[0, 0, 0], [161, 217, 155], [65, 171, 93], [0, 90, 50]],
  groups: [{ index: 3, key: 'strict', label: 'Strict reserve or wilderness (IUCN Ia/Ib)' }, { index: 2, key: 'national_park', label: 'National park (IUCN II)' }, { index: 1, key: 'other', label: 'Other protection' }],
  classes: CLASSES,
  shard_degrees: 1,
  coord_scale: 10000,
  shard: 'data/protected/shards/{lat}_{lon}.json',
  shards: [[44, -111]],
  counts: { areas: 3, by_group: { strict: 1, national_park: 1, other: 1 }, unpainted_at_max_level: 1 },
});

function harness({ manifest = MANIFEST, shardStatus = 200 } = {}) {
  const providers = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createProtectedAreasLayer({
    fetchImpl: async (url) => {
      fetches.push(url);
      if (url === MANIFEST_URL) return { ok: true, status: 200, json: async () => structuredClone(manifest) };
      return { ok: shardStatus === 200, status: shardStatus, json: async () => structuredClone(ENCODED) };
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
  assert.match(bad({ shards: [[44.5, -111]] }), /south-west corner/);
  assert.match(bad({ shards: [[90, 0]] }), /south-west corner/);
  assert.match(bad({ shard_degrees: 7 }), /does not divide 180/);
  assert.match(bad({ shard_degrees: 5 }), /not a 5° cell/, 'the shards listed must be cells of the size declared');
  assert.match(bad({ coord_scale: 0 }), /coord_scale/);
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

test('shard key: the cell the pipeline writes (pipeline shard_key), the north and east edges folded in', () => {
  assert.equal(shardKey(44.6, -110.5, 1), '44_-111');
  assert.equal(shardKey(90, 180, 1), '89_179');
  assert.equal(shardKey(-90, -180, 1), '-90_-180');
  assert.equal(shardKey(-0.1, -0.1, 1), '-1_-1');
  assert.equal(shardKey(44.6, 249.5, 1), '44_-111', 'a longitude past 180 wraps');
  assert.equal(shardKey(44.6, -110.5, 5), '40_-115');
  assert.equal(shardKey(90, 180, 5), '85_175');
  assert.equal(shardKey(91, 0, 1), null);
  assert.equal(shardKey(Number.NaN, 0, 1), null);
});

test('rings: the literal the pipeline test writes for box(1, 2, 3, 4) decodes to its corners; decoding never drifts', () => {
  assert.deepEqual(decodeRing([30000, 20000, 0, 20000, -20000, 0, 0, -20000], 10000), [3, 2, 3, 4, 1, 4, 1, 2]);
  const long = Array.from({ length: 2000 }, (_, i) => (i % 2 ? 0.0001 : 0.0003)); // 1,000 small steps
  const end = decodeRing([1234567, -456789, ...long.slice(2).map((v) => Math.round(v * 1e4))], 10000).slice(-2);
  assert.deepEqual(end, [(1234567 + 999 * 3) / 1e4, (-456789 + 999) / 1e4]);
  const d = decodeShard(ENCODED, 10000);
  assert.deepEqual(d.areas[1].polygons, YS.polygons);
  assert.deepEqual(ENCODED.areas[1].polygons[0][0].slice(0, 4), [-1111000, 441000, 12000, 0], 'the fixture is encoded, not degrees');
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
  assert.deepEqual(h.fetches.filter((u) => u !== MANIFEST_URL), ['data/protected/shards/44_-111.json?v=2026-09-23.1'], 'one fetch for two reads');
  const none = await h.layer.readoutAt(10, 10);
  assert.deepEqual([none.status, none.text, none.date], ['value', NONE_TEXT, date]);
  assert.equal(h.fetches.length, 2, 'no fetch for a cell the manifest has no shard for');
  assert.equal((await h.layer.readoutAt(91, 0)).status, 'outside');

  const f = harness({ shardStatus: 503 });
  await f.layer.update();
  f.layer.enable();
  const err = await f.layer.readoutAt(44.8, -110.5);
  assert.deepEqual([err.status, err.error], ['error', 'shard 44_-111 HTTP 503']);
  await f.layer.readoutAt(44.8, -110.5);
  assert.equal(f.fetches.filter((u) => u.includes('shards')).length, 2, 'a failed shard is fetched again');
});

test('a malformed manifest draws nothing and says why', async () => {
  const h = harness({ manifest: { ...MANIFEST, shard_degrees: 7 } });
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
  assert.match(legend[3].label, /^3 protected areas mapped in OpenStreetMap \(Overture 2026-09-23\.1\), 1 of them too small to show at about 600 m \(a WHAT LIVES HERE click still finds them\); OpenStreetMap's coverage is uneven and it is not an official registry · © OpenStreetMap contributors, ODbL$/);
  const all = harness({ manifest: { ...MANIFEST, counts: { ...MANIFEST.counts, unpainted_at_max_level: 0 } } });
  await all.layer.update();
  assert.doesNotMatch(all.layer.getRowControls().legend[3].label, /too small/);
});

test('the built manifest and a shard it lists, when present, pass and read (real file)', (t) => {
  const path = new URL('../../public/data/protected_areas.json', import.meta.url);
  if (!existsSync(path)) {
    t.skip('public/data/protected_areas.json not built here (pipeline/protected_areas.py)');
    return;
  }
  const m = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(validateProtectedManifest(m), null);
  const [lat, lon] = m.shards.find(([la, lo]) => la === 44 && lo === -111) ?? m.shards[0];
  const raw = JSON.parse(readFileSync(new URL(`../../public/${m.shard.replace('{lat}', lat).replace('{lon}', lon)}`, import.meta.url), 'utf8'));
  assert.deepEqual(raw.cell, [lat, lon]);
  const s = decodeShard(raw, m.coord_scale);
  assert.ok(s.areas.length > 0 && s.areas.every((a) => m.classes[a.class]?.group));
  // every decoded vertex lies in its cell: the clip and the encoding agree
  for (const a of s.areas) for (const rings of a.polygons) for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    assert.ok(r[i] >= lon - 1e-4 && r[i] <= lon + m.shard_degrees + 1e-4 && r[i + 1] >= lat - 1e-4 && r[i + 1] <= lat + m.shard_degrees + 1e-4, `${a.osm} vertex ${r[i]},${r[i + 1]}`);
  }
  if (lat === 44 && lon === -111) assert.ok(areasAt(s, 44.6, -110.5, m.classes).some((a) => a.osm === 'r1453306'), 'Yellowstone at its centre');
});
