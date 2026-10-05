// src/data/ifl.test.mjs — the Intact Forest Landscapes layer: manifest, decode, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MANIFEST_URL, NONE_TEXT, TILE_FAILURE_LIMIT, createIflLayer, decodeIfl, validateIflManifest } from './ifl.js';
import { geoTilePixel } from './humanFootprint.js';

// classes and editions as pipeline/ifl.py wrote them on the real run of 2026-10-04
const CLASSES = [
  { index: 1, label: 'intact in 2000, not by 2013', rgb: [255, 221, 0] },
  { index: 2, label: 'intact in 2013, not by 2016', rgb: [255, 153, 0] },
  { index: 3, label: 'intact in 2016, not by 2020', rgb: [232, 40, 30] },
  { index: 4, label: 'intact in 2020, not by 2025', rgb: [150, 0, 24] },
  { index: 5, label: 'intact forest landscape in 2025', rgb: [56, 158, 56] },
];
const EDITIONS = [
  { year: 2000, patches: 2221, areaHa: 1280902212, burnedKm2: 12814683, burnedKm2NotInPrevious: 0 },
  { year: 2013, patches: 2138, areaHa: 1189251152, burnedKm2: 11897767, burnedKm2NotInPrevious: 1785 },
  { year: 2016, patches: 2097, areaHa: 1161411770, burnedKm2: 11619805, burnedKm2NotInPrevious: 1475 },
  { year: 2020, patches: 2053, areaHa: 1126192539, burnedKm2: 11267456, burnedKm2NotInPrevious: 1649 },
  { year: 2025, patches: 2014, areaHa: 1086156508, burnedKm2: 10868119, burnedKm2NotInPrevious: 1822 },
];
const FOREST = [-19.1, -61.6]; // inside SAM_80, Chaco, Bolivia
const SEA = [0, -30];
const leaf = geoTilePixel(...FOREST, 7);
// the leaf tile and its ancestors, as the pipeline lists painted tiles per level
const TILES = Object.fromEntries(Array.from({ length: 8 }, (_, z) => [String(z), [[leaf.x >> (7 - z), leaf.y >> (7 - z)]]]));
const MANIFEST = Object.freeze({
  generated_at: '2026-10-04T03:41:07Z',
  maxLevel: 7,
  tile: 'data/ifl/{z}/{x}/{y}.png',
  tiles: TILES,
  classes: CLASSES,
  editions: EDITIONS,
  tileBytes: 5900000,
  source: { author: 'The IFL Mapping Team', licence: 'CC BY 4.0' },
});
const BLANK = { blank: true };

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = [56, 158, 56, 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createIflLayer({
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
  assert.equal(validateIflManifest(MANIFEST), null);
  const ed = (i, patch) => EDITIONS.map((e, j) => (j === i ? { ...e, ...patch } : e));
  const broken = [
    [{ ...MANIFEST, generated_at: '2026-10-04' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: 7.5 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/ifl/{z}/{x}.png' }, /\{y\}/],
    [{ ...MANIFEST, tiles: { ...TILES, 3: undefined } }, /no list for level 3/],
    [{ ...MANIFEST, tiles: { ...TILES, 0: [[2, 0]] } }, /not on level 0/],
    [{ ...MANIFEST, tiles: { ...TILES, 1: [[0, 2]] } }, /not on level 1/],
    [{ ...MANIFEST, classes: [CLASSES[1], CLASSES[0], ...CLASSES.slice(2)] }, /indexed 1, 2/],
    [{ ...MANIFEST, classes: [...CLASSES.slice(0, 4), { ...CLASSES[4], label: '' }] }, /label/],
    [{ ...MANIFEST, classes: [...CLASSES.slice(0, 4), { ...CLASSES[4], rgb: CLASSES[0].rgb }] }, /distinct/],
    [{ ...MANIFEST, editions: EDITIONS.slice(1) }, /expected 5 editions/],
    [{ ...MANIFEST, editions: ed(2, { year: 2013 }) }, /not increasing at 2013/],
    [{ ...MANIFEST, editions: ed(1, { burnedKm2NotInPrevious: -1 }) }, /edition 2013 lacks/],
    [{ ...MANIFEST, editions: ed(4, { patches: undefined }) }, /edition 2025 lacks/],
    [{ ...MANIFEST, source: { licence: 'CC BY-NC 4.0' } }, /licence/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateIflManifest(m) ?? 'accepted', why);
});

test('pixel decode: a class colour is its class, transparent is none, anything else is named', () => {
  for (const c of CLASSES) assert.deepEqual(decodeIfl([...c.rgb, 255], MANIFEST), { kind: 'class', index: c.index, label: c.label });
  assert.deepEqual(decodeIfl([0, 0, 0, 0], MANIFEST), { kind: 'none' });
  for (const odd of [[56, 158, 56, 254], [0, 0, 0, 255], [1, 2, 3, 255]]) {
    assert.deepEqual(decodeIfl(odd, MANIFEST), { kind: 'unknown', rgba: odd }, `${odd} is named, not snapped`);
  }
});

test('the drape: one geographic provider to level 7, only listed tiles requested, shown only while enabled; not on the time bar', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/ifl.json');
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.equal(p.options.url, 'data/ifl/{z}/{x}/{y}.png?v=2026-10-04T03:41:07Z', 'the build time busts cached tiles');
  assert.ok(p.options.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(p.options.maximumLevel, 7);
  assert.match(p.options.credit, /IFL Mapping Team/);
  assert.equal(await p.requestImage(leaf.x, leaf.y, 7), 'tile', 'a listed tile is requested');
  assert.equal(await p.requestImage(leaf.x + 1, leaf.y, 7), BLANK, 'an unlisted one is blank');
  assert.equal(await p.requestImage(1, 0, 0), BLANK, 'the eastern hemisphere at level 0 holds no listed tile here');
  assert.deepEqual(p.requested, [`7/${leaf.x}/${leaf.y}`]);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual(stacked.at(-1), { id: 'ifl', imagery: list[0], zrank: 21 });
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  assert.equal(layer.setObservedTime, undefined);
  assert.deepEqual(layer.getStats(), { count: 2014, lastUpdate: layer.getStats().lastUpdate, error: null, time: 'IFL 2000–2025' });
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /ifl\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, editions: [] } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed ifl\.json: expected 5 editions/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(...FOREST)).status, 'error');
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

test('readout: the class at level 7; none in a transparent pixel or an unlisted tile, without a read; failures and odd colours are loud', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(...FOREST), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(...FOREST);
  assert.deepEqual([r.status, r.text, r.date], ['class', 'intact forest landscape in 2025', 'IFL 2000–2025']);
  assert.deepEqual(h.reads, [{ url: `data/ifl/7/${leaf.x}/${leaf.y}.png?v=2026-10-04T03:41:07Z`, px: leaf.px, py: leaf.py }]);

  const sea = await h.layer.readoutAt(...SEA);
  assert.deepEqual([sea.status, sea.text, sea.date], ['class', NONE_TEXT, 'IFL 2000–2025']);
  assert.equal(h.reads.length, 1, 'an unlisted tile was never written: no read');
  assert.equal(NONE_TEXT, 'not an intact forest landscape in any edition, 2000–2025');
  assert.equal((await h.layer.readoutAt(95, 0)).status, 'outside');

  const lost = harness({ pixel: [255, 153, 0, 255] });
  lost.layer.enable();
  await lost.layer.update();
  assert.equal((await lost.layer.readoutAt(...FOREST)).text, 'intact in 2013, not by 2016');

  const clear = harness({ pixel: [0, 0, 0, 0] });
  clear.layer.enable();
  await clear.layer.update();
  assert.equal((await clear.layer.readoutAt(...FOREST)).text, NONE_TEXT, 'a listed tile can be clear at this pixel');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(...FOREST)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('GIBS tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(...FOREST);
  assert.equal(failed.status, 'error', 'a listed tile was written, so a 404 is a fault');
  assert.match(failed.error, /404/);
});

test('legend: one swatch per class in its colour, then the definition, the 2025 totals and the ground new to each edition', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => [e.label, e.color]), CLASSES.map((c) => [c.label, `rgb(${c.rgb.join(',')})`]));
  const note = legend.at(-1).label;
  assert.match(note, /at least 500 km² and 10 km wide/);
  assert.match(note, /2,014 landscapes, 10,861,565 km² in 2025/);
  assert.match(note, /6,731 km² of later editions lie outside the edition before/); // 1,785 + 1,475 + 1,649 + 1,822
  assert.match(note, /CC BY 4\.0/);
});

test('credit: the source, its licence, the citation and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'ifl');
  assert.ok(credit, 'DATA_CREDITS has an ifl entry');
  assert.match(credit.html, /The IFL Mapping Team/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /doi\.org\/10\.1126\/sciadv\.1600821/);
  assert.match(credit.html, /Changed: .*simplified by 0\.001° and drawn as ~610 m tiles/);
});
