// src/data/aefChange.test.mjs — the AlphaEarth land change layer: manifest, decode, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { ATTRIBUTION, MANIFEST_URL, NONE_TEXT, NOTE, TILE_FAILURE_LIMIT, createAefChangeLayer, decodeAefChange, validateAefChangeManifest } from './aefChange.js';
import { geoTilePixel } from './humanFootprint.js';

// classes as pipeline/aef_change.py writes them (CLASSES there), with areas of a trial size
const CLASSES = [
  { index: 1, label: 'unusual change', min: 6.5, rgb: [254, 217, 118], km2: 41210 },
  { index: 2, label: 'strong change', min: 10, rgb: [253, 141, 60], km2: 22105 },
  { index: 3, label: 'very strong change', min: 20, rgb: [227, 26, 28], km2: 5120 },
  { index: 4, label: 'extreme change', min: 40, rgb: [128, 0, 38], km2: 0 },
];
const FIRE = [34.07, -118.55]; // the Palisades fire, January 2025
const SEA = [0, -30];
const leaf = geoTilePixel(...FIRE, 6);
// the leaf tile and its ancestors, as the pipeline lists painted tiles per level
const TILES = Object.fromEntries(Array.from({ length: 7 }, (_, z) => [String(z), [[leaf.x >> (6 - z), leaf.y >> (6 - z)]]]));
const MANIFEST = Object.freeze({
  generated_at: '2026-10-26T20:45:00Z',
  maxLevel: 6,
  tile: 'data/aef_change/{z}/{x}/{y}.png',
  tiles: TILES,
  classes: CLASSES,
  scoredKm2: 4100000,
  score: { target: 2025, history: [2020, 2024], lookback: 3, floor: 0.003, threshold: 6.5, cover: 0.25 },
  locations: 34266,
  locationsScored: 32931,
  locationsSkipped: 1335,
  tileBytes: 1234567,
  source: { name: 'AlphaEarth Foundations Satellite Embedding v1 (annual)', licence: 'CC BY 4.0', attribution: ATTRIBUTION },
});
const BLANK = { blank: true };

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = [227, 26, 28, 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createAefChangeLayer({
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
  assert.equal(validateAefChangeManifest(MANIFEST), null);
  const cls = (i, patch) => CLASSES.map((c, j) => (j === i ? { ...c, ...patch } : c));
  const broken = [
    [{ ...MANIFEST, generated_at: '2026-10-26' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: 6.5 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/aef_change/{z}/{x}.png' }, /\{y\}/],
    [{ ...MANIFEST, tiles: { ...TILES, 3: undefined } }, /no list for level 3/],
    [{ ...MANIFEST, tiles: { ...TILES, 0: [[2, 0]] } }, /not on level 0/],
    [{ ...MANIFEST, classes: [CLASSES[1], CLASSES[0], ...CLASSES.slice(2)] }, /indexed 1, 2/],
    [{ ...MANIFEST, classes: cls(3, { label: '' }) }, /label/],
    [{ ...MANIFEST, classes: cls(3, { rgb: CLASSES[0].rgb }) }, /distinct/],
    [{ ...MANIFEST, classes: cls(2, { min: 10 }) }, /edges do not rise/],
    [{ ...MANIFEST, classes: cls(0, { min: undefined }) }, /edges do not rise/],
    [{ ...MANIFEST, classes: cls(1, { km2: -1 }) }, /strong change lacks its area/],
    [{ ...MANIFEST, locationsScored: 40000 }, /40000 locations scored of 34266/],
    [{ ...MANIFEST, locations: undefined }, /locations scored/],
    [{ ...MANIFEST, source: { ...MANIFEST.source, licence: 'CC BY-NC 4.0' } }, /licence/],
    [{ ...MANIFEST, source: { ...MANIFEST.source, attribution: 'Google' } }, /required text/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateAefChangeManifest(m) ?? 'accepted', why);
  assert.equal(validateAefChangeManifest({ ...MANIFEST, classes: cls(3, { km2: 0 }) }), null, 'a band with no area is still a band');
  assert.equal(ATTRIBUTION, 'The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.', 'the README\'s text, verbatim');
});

test('pixel decode: a band colour is its band with its score range, transparent is none, anything else is named', () => {
  assert.deepEqual(decodeAefChange([254, 217, 118, 255], MANIFEST), { kind: 'class', index: 1, label: 'unusual change', min: 6.5, max: 10 });
  assert.deepEqual(decodeAefChange([128, 0, 38, 255], MANIFEST), { kind: 'class', index: 4, label: 'extreme change', min: 40, max: null });
  assert.deepEqual(decodeAefChange([0, 0, 0, 0], MANIFEST), { kind: 'none' });
  for (const odd of [[227, 26, 28, 254], [0, 0, 0, 255], [253, 141, 61, 255]]) {
    assert.deepEqual(decodeAefChange(odd, MANIFEST), { kind: 'unknown', rgba: odd }, `${odd} is named, not snapped`);
  }
});

test('the drape: one geographic provider to level 6, only listed tiles requested, shown only while enabled; not on the time bar', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/aef_change.json');
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.equal(p.options.url, 'data/aef_change/{z}/{x}/{y}.png?v=2026-10-26T20:45:00Z', 'the build time busts cached tiles');
  assert.ok(p.options.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(p.options.maximumLevel, 6);
  assert.match(p.options.credit, /Google DeepMind/);
  assert.equal(await p.requestImage(leaf.x, leaf.y, 6), 'tile', 'a listed tile is requested');
  assert.equal(await p.requestImage(leaf.x + 1, leaf.y, 6), BLANK, 'an unlisted one is blank');
  assert.deepEqual(p.requested, [`6/${leaf.x}/${leaf.y}`]);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual(stacked.at(-1), { id: 'aef-change', imagery: list[0], zrank: 21 });
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  assert.equal(layer.setObservedTime, undefined);
  assert.deepEqual(layer.getStats(), { count: 1, lastUpdate: layer.getStats().lastUpdate, error: null, time: '2025 vs 2022–24' });
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /aef_change\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, locationsScored: 99999 } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed aef_change\.json: 99999 locations scored of 34266/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(...FIRE)).status, 'error');
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

test('readout: the band and its score range at level 6; none in a transparent pixel or an unlisted tile, without a read; failures and odd colours are loud', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(...FIRE), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(...FIRE);
  assert.deepEqual([r.status, r.text, r.date], ['class', 'very strong change (score 20 to 40)', '2025 vs 2022–24']);
  assert.deepEqual(h.reads, [{ url: `data/aef_change/6/${leaf.x}/${leaf.y}.png?v=2026-10-26T20:45:00Z`, px: leaf.px, py: leaf.py }]);

  const sea = await h.layer.readoutAt(...SEA);
  assert.deepEqual([sea.status, sea.text], ['class', NONE_TEXT]);
  assert.equal(h.reads.length, 1, 'an unlisted tile was never written: no read');
  assert.match(NONE_TEXT, /no unusual change, or no score here \(desert, Antarctica,/);
  assert.equal((await h.layer.readoutAt(95, 0)).status, 'outside');

  const top = harness({ pixel: [128, 0, 38, 255] });
  top.layer.enable();
  await top.layer.update();
  assert.equal((await top.layer.readoutAt(...FIRE)).text, 'extreme change (score 40 or more)');

  const clear = harness({ pixel: [0, 0, 0, 0] });
  clear.layer.enable();
  await clear.layer.update();
  assert.equal((await clear.layer.readoutAt(...FIRE)).text, NONE_TEXT, 'a listed tile can be clear at this pixel');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(...FIRE)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(...FIRE);
  assert.equal(failed.status, 'error', 'a listed tile was written, so a 404 is a fault');
  assert.match(failed.error, /404/);
});

test('legend: one swatch per band in its colour with its area, then what the score is and what it is not', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(
    legend.slice(0, -1).map((e) => [e.label, e.color]),
    [
      ['unusual change, 41,210 km²', 'rgb(254,217,118)'],
      ['strong change, 22,105 km²', 'rgb(253,141,60)'],
      ['very strong change, 5,120 km²', 'rgb(227,26,28)'],
      ['extreme change, 0 km²', 'rgb(128,0,38)'],
    ],
  );
  assert.equal(legend.at(-1).label, NOTE);
  // the held-out figures for score v2 at 6.5 (docs/analysis/aef-change-pilot.md): caught 7% (Manitoba) to 65% (LA), 0.4% of strict-stable cells flagged
  assert.match(NOTE, /~1\.3 km/);
  assert.match(NOTE, /a quarter of it changed/, 'the coarse-pixel rule');
  assert.match(NOTE, /not only forest loss/);
  assert.match(NOTE, /wide rivers whose water or ice changed and region-wide weather swings/, 'seen in the global build: Lena and Yenisei, western Russia');
  assert.match(NOTE, /found 7–65% of 2025 forest loss \(least for large boreal fires\) and flagged 0\.4% of untouched forest/);
  assert.match(NOTE, /deserts and Antarctica are not drawn/, 'the two masks of pipeline/aef_change.py');
  assert.match(NOTE, /the rest of its 82 km tile/, 'the score is relative to the file');
  assert.match(NOTE, /CC BY 4\.0/);
});

test('credit: the required text verbatim, the licence and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'aef-change');
  assert.ok(credit, 'DATA_CREDITS has an aef-change entry');
  assert.ok(credit.html.includes(ATTRIBUTION), 'the README asks for this sentence');
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL/);
  assert.match(credit.html, /Changed: .*1\.28 km overview.*rest of its file.*four bands/);
  assert.match(credit.html, /RESOLVE Ecoregions 2017.*Antarctica are not drawn/, 'the desert mask\'s source is credited');
});

test('wiring: registered, a drape (one at a time), read on click, in Land conditions, with a share-link token; not on the time bar', async () => {
  const { readFileSync } = await import('node:fs');
  const { LAYER_GROUPS } = await import('./layerGroups.js');
  const { REGISTERED_LAYER_IDS, LAYER_STATE_REGISTRY } = await import('./layerState.js');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{ aefChangeLayer \} from '\.\/data\/aefChange\.js';/);
  assert.match(main, /dataManager\.register\(aefChangeLayer\);/);
  const list = (re) => main.match(re)?.[1].split(',').map((s) => s.trim());
  const drapes = list(/const drapeLayers = \[([^\]]+)\];/);
  const reads = list(/const readGibsLayers = \(\{ lat, lon \}\) => \[\n\s*\.\.\.\[([^\]]+)\]/);
  const observed = list(/const observedLayers = \[([^\]]+)\];/);
  assert.ok(drapes?.includes('fortyLayer') && reads?.includes('fortyLayer') && observed?.includes('ndviLayer'), 'positive control: the three lists were found');
  assert.ok(drapes.includes('aefChangeLayer'), 'a drape, so turning it on turns another drape off');
  assert.ok(reads.includes('aefChangeLayer'), 'read on click');
  assert.ok(!observed.includes('aefChangeLayer'), 'one fixed comparison is not on the time bar');
  assert.ok(LAYER_GROUPS.find((g) => g.id === 'land').layers.includes('aef-change'));
  assert.ok(REGISTERED_LAYER_IDS.includes('aef-change'));
  assert.equal(LAYER_STATE_REGISTRY.find((e) => e.id === 'aef-change')?.token, 'ac');
});
