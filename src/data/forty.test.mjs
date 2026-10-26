// src/data/forty.test.mjs — the ForTy forest types layer: manifest, decode, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MANIFEST_URL, NONE_TEXT, NOTE, TILE_FAILURE_LIMIT, createFortyLayer, decodeForty, validateFortyManifest } from './forty.js';
import { geoTilePixel } from './humanFootprint.js';

// classes as pipeline/forty.py wrote them on the real Sumatra trial of 2026-10-26 (--bbox 99.85,-5.6,111.1,5.6)
const CLASSES = [
  { index: 1, label: 'primary forest', rgb: [27, 120, 55], km2: 123771 },
  { index: 2, label: 'naturally regenerating forest', rgb: [127, 191, 123], km2: 135979 },
  { index: 3, label: 'planted forest', rgb: [29, 145, 192], km2: 0 },
  { index: 4, label: 'plantation forest', rgb: [230, 95, 169], km2: 15035 },
  { index: 5, label: 'tree crops and agroforestry', rgb: [230, 171, 2], km2: 204597 },
];
const FOREST = [-2.0, 101.5]; // Kerinci Seblat, Sumatra
const SEA = [0, -30];
const leaf = geoTilePixel(...FOREST, 7);
// the leaf tile and its ancestors, as the pipeline lists painted tiles per level
const TILES = Object.fromEntries(Array.from({ length: 8 }, (_, z) => [String(z), [[leaf.x >> (7 - z), leaf.y >> (7 - z)]]]));
const MANIFEST = Object.freeze({
  generated_at: '2026-10-26T03:19:41Z',
  maxLevel: 7,
  tile: 'data/forty/{z}/{x}/{y}.png',
  tiles: TILES,
  classes: CLASSES,
  itemsRead: 680,
  items: 623,
  tileBytes: 426237,
  source: { name: 'Forest Typology 2020 v1 (ForTy), Nature Trace', licence: 'CC BY 4.0' },
});
const BLANK = { blank: true };

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = [27, 120, 55, 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createFortyLayer({
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: manifestStatus === 200, status: manifestStatus, json: async () => structuredClone(manifest) };
    },
    providerFor: (options) => {
      const listeners = [], requested = [];
      const p = {
        options,
        requested,
        requestImage: (x, y, level) => { requested.push(`${level}/${x}/${y}`); return Promise.resolve('tile'); },
        errorEvent: { addEventListener: (fn) => listeners.push(fn) },
        fail: (error) => listeners.forEach((fn) => fn({ error })),
      };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: (_layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
    readTilePixel: async (url, px, py) => {
      reads.push({ url, px, py });
      if (readError) throw readError;
      return { rgba: pixel, timeActual: null };
    },
    blank: () => BLANK,
  });
  layer.init(viewer);
  return { layer, providers, reads, list, stacked, fetches };
}

test('manifest: the shape the pipeline writes is accepted; each broken field is named', () => {
  assert.equal(validateFortyManifest(MANIFEST), null);
  const cls = (i, patch) => CLASSES.map((c, j) => (j === i ? { ...c, ...patch } : c));
  const broken = [
    [{ ...MANIFEST, generated_at: '2026-10-26' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: 7.5 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/forty/{z}/{x}.png' }, /\{y\}/],
    [{ ...MANIFEST, tiles: { ...TILES, 3: undefined } }, /no list for level 3/],
    [{ ...MANIFEST, tiles: { ...TILES, 0: [[2, 0]] } }, /not on level 0/],
    [{ ...MANIFEST, tiles: { ...TILES, 1: [[0, 2]] } }, /not on level 1/],
    [{ ...MANIFEST, classes: [CLASSES[1], CLASSES[0], ...CLASSES.slice(2)] }, /indexed 1, 2/],
    [{ ...MANIFEST, classes: cls(4, { label: '' }) }, /label/],
    [{ ...MANIFEST, classes: cls(4, { rgb: CLASSES[0].rgb }) }, /distinct/],
    [{ ...MANIFEST, classes: cls(2, { km2: -1 }) }, /planted forest lacks its area/],
    [{ ...MANIFEST, classes: cls(0, { km2: undefined }) }, /primary forest lacks its area/],
    [{ ...MANIFEST, itemsRead: 600 }, /600 source tiles read for 623/],
    [{ ...MANIFEST, items: undefined }, /source tiles read/],
    [{ ...MANIFEST, source: { licence: 'CC BY-NC 4.0' } }, /licence/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateFortyManifest(m) ?? 'accepted', why);
  assert.equal(validateFortyManifest({ ...MANIFEST, classes: cls(2, { km2: 0 }) }), null, 'a class with no area in the box is still a class');
});

test('pixel decode: a class colour is its class, transparent is none, anything else is named', () => {
  for (const c of CLASSES) assert.deepEqual(decodeForty([...c.rgb, 255], MANIFEST), { kind: 'class', index: c.index, label: c.label });
  assert.deepEqual(decodeForty([0, 0, 0, 0], MANIFEST), { kind: 'none' });
  for (const odd of [[27, 120, 55, 254], [0, 0, 0, 255], [253, 226, 120, 255]]) {
    assert.deepEqual(decodeForty(odd, MANIFEST), { kind: 'unknown', rgba: odd }, `${odd} is named, not snapped`);
  }
});

test('the drape: one geographic provider to level 7, only listed tiles requested, shown only while enabled; not on the time bar', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/forty.json');
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.equal(p.options.url, 'data/forty/{z}/{x}/{y}.png?v=2026-10-26T03:19:41Z', 'the build time busts cached tiles');
  assert.ok(p.options.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(p.options.maximumLevel, 7);
  assert.match(p.options.credit, /Nature Trace/);
  assert.equal(await p.requestImage(leaf.x, leaf.y, 7), 'tile', 'a listed tile is requested');
  assert.equal(await p.requestImage(leaf.x + 1, leaf.y, 7), BLANK, 'an unlisted one is blank');
  assert.equal(await p.requestImage(0, 0, 0), BLANK, 'the western hemisphere at level 0 holds no listed tile here');
  assert.deepEqual(p.requested, [`7/${leaf.x}/${leaf.y}`]);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual(stacked.at(-1), { id: 'forty', imagery: list[0], zrank: 21 });
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  assert.equal(layer.setObservedTime, undefined);
  assert.deepEqual(layer.getStats(), { count: 1, lastUpdate: layer.getStats().lastUpdate, error: null, time: 'ForTy 2020' });
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /forty\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, itemsRead: 1 } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed forty\.json: 1 source tiles read for 623/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(...FOREST)).status, 'error');
  const ok = harness();
  assert.equal(await ok.layer.update(), true, 'the same harness with the real manifest draws');
  assert.equal(ok.providers.length, 1);
});

test('tile failures: every listed tile exists, so the limit marks the layer failing and the next update rebuilds it', async () => {
  const { layer, providers } = harness();
  layer.enable();
  await layer.update();
  for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i++) providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, null);
  providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, 'map tiles failing');
  await layer.update();
  assert.equal(providers.length, 2);
  assert.equal(layer.getStats().error, null);
  for (let i = 0; i < TILE_FAILURE_LIMIT; i++) providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, null, 'the old provider no longer counts');
});

test('readout: the type at level 7; none in a transparent pixel or an unlisted tile, without a read; failures and odd colours are loud', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(...FOREST), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(...FOREST);
  assert.deepEqual([r.status, r.text, r.date], ['class', 'primary forest (most likely type)', 'ForTy 2020']);
  assert.deepEqual(h.reads, [{ url: `data/forty/7/${leaf.x}/${leaf.y}.png?v=2026-10-26T03:19:41Z`, px: leaf.px, py: leaf.py }]);

  const sea = await h.layer.readoutAt(...SEA);
  assert.deepEqual([sea.status, sea.text, sea.date], ['class', NONE_TEXT, 'ForTy 2020']);
  assert.equal(h.reads.length, 1, 'an unlisted tile was never written: no read');
  assert.equal(NONE_TEXT, 'no forest type: other land, water or no data');
  assert.equal((await h.layer.readoutAt(95, 0)).status, 'outside');

  const crops = harness({ pixel: [230, 171, 2, 255] });
  crops.layer.enable();
  await crops.layer.update();
  assert.equal((await crops.layer.readoutAt(...FOREST)).text, 'tree crops and agroforestry (most likely type)');

  const clear = harness({ pixel: [0, 0, 0, 0] });
  clear.layer.enable();
  await clear.layer.update();
  assert.equal((await clear.layer.readoutAt(...FOREST)).text, NONE_TEXT, 'a listed tile can be clear at this pixel');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(...FOREST)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(...FOREST);
  assert.equal(failed.status, 'error', 'a listed tile was written, so a 404 is a fault');
  assert.match(failed.error, /404/);
});

test('legend: one swatch per type in its colour with its area, then the method and the accuracy caveat', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(
    legend.slice(0, -1).map((e) => [e.label, e.color]),
    [
      ['primary forest, 123,771 km²', 'rgb(27,120,55)'],
      ['naturally regenerating forest, 135,979 km²', 'rgb(127,191,123)'],
      ['planted forest, 0 km²', 'rgb(29,145,192)'],
      ['plantation forest, 15,035 km²', 'rgb(230,95,169)'],
      ['tree crops and agroforestry, 204,597 km²', 'rgb(230,171,2)'],
    ],
  );
  assert.equal(legend.at(-1).label, NOTE);
  // the preprint's figures (doi:10.31223/X58R27 v2: "overall accuracy of 90.2%", "planted forest class shows the lowest F1-score (58.2%)")
  assert.match(NOTE, /~610 m/);
  assert.match(NOTE, /areas are of this map as drawn/, 'the areas are the drape\'s, not the 10 m map\'s (docs/analysis/forty_drape_vs_native.md)');
  assert.match(NOTE, /overall accuracy 90\.2%/);
  assert.match(NOTE, /planted forest is the least reliable class \(F1 58\.2%\)/);
  assert.match(NOTE, /CC BY 4\.0/);
});

test('credit: the source, its licence, the dataset and preprint DOIs and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'forty');
  assert.ok(credit, 'DATA_CREDITS has a forty entry');
  assert.match(credit.html, /Nature Trace/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /doi\.org\/10\.25452\/figshare\.plus\.32288616\.v1/);
  assert.match(credit.html, /doi\.org\/10\.31223\/X58R27/);
  assert.match(credit.html, /Changed: .*averaged over ~610 m pixels and the most likely type drawn/);
});

test('wiring: registered, a drape (one at a time), read on click, in Habitats, with a share-link token; not on the time bar', async () => {
  const { readFileSync } = await import('node:fs');
  const { LAYER_GROUPS } = await import('./layerGroups.js');
  const { REGISTERED_LAYER_IDS, LAYER_STATE_REGISTRY } = await import('./layerState.js');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{ fortyLayer \} from '\.\/data\/forty\.js';/);
  assert.match(main, /dataManager\.register\(fortyLayer\);/);
  const list = (re) => main.match(re)?.[1].split(',').map((s) => s.trim());
  const drapes = list(/const drapeLayers = \[([^\]]+)\];/);
  const reads = list(/const readGibsLayers = \(\{ lat, lon \}\) => \[\n\s*\.\.\.\[([^\]]+)\]/);
  const observed = list(/const observedLayers = \[([^\]]+)\];/);
  assert.ok(drapes?.includes('iflLayer') && reads?.includes('iflLayer') && observed?.includes('ndviLayer'), 'positive control: the three lists were found');
  assert.ok(drapes.includes('fortyLayer'), 'a drape, so turning it on turns another drape off');
  assert.ok(reads.includes('fortyLayer'), 'read on click');
  assert.ok(!observed.includes('fortyLayer'), 'a fixed 2020 map is not on the time bar');
  assert.ok(LAYER_GROUPS.find((g) => g.id === 'habitats').layers.includes('forty'));
  assert.ok(REGISTERED_LAYER_IDS.includes('forty'));
  assert.equal(LAYER_STATE_REGISTRY.find((e) => e.id === 'forty')?.token, 'ft');
});
