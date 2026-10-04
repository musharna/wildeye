// src/data/seagrass.test.mjs — the seagrass layer: manifest, epochs on the time bar, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  MANIFEST_URL,
  MAPPED_NORTH,
  MAPPED_SOUTH,
  NONE_TEXT,
  TILE_FAILURE_LIMIT,
  createSeagrassLayer,
  shareText,
  validateSeagrassManifest,
} from './seagrass.js';
import { geoTilePixel } from './humanFootprint.js';

// a palette of the shape pipeline/seagrass.py writes (its own rounding may differ by one); the QA checks the real one
const STOPS = [[1, [204, 236, 214]], [50, [65, 174, 118]], [100, [0, 68, 27]]];
const PALETTE = [[0, 0, 0]];
for (let i = 1; i <= 100; i++) {
  const k = i <= 50 ? 0 : 1;
  const [[a, ca], [b, cb]] = [STOPS[k], STOPS[k + 1]];
  const t = (i - a) / (b - a);
  PALETTE.push(ca.map((x, j) => Math.round(x + (cb[j] - x) * t)));
}
const GRASS = [25.3, -80.35]; // Card Sound, Florida
const INLAND = [28.5, -81.4]; // Orlando
const leaf = geoTilePixel(...GRASS, 9);
const chain = (t) => Object.fromEntries(Array.from({ length: 10 }, (_, z) => [String(z), [[t.x >> (9 - z), t.y >> (9 - z)]]]));
// the later epoch also lists the tile east of the leaf: each epoch is read through its own list
const east = { x: leaf.x + 1, y: leaf.y };
const TILES_2019 = chain(leaf);
const TILES_2023 = { ...chain(leaf), 9: [[leaf.x, leaf.y], [east.x, east.y]] };
const MANIFEST = Object.freeze({
  generated_at: '2026-10-04T08:00:00Z',
  maxLevel: 9,
  tile: 'data/seagrass/{epoch}/{z}/{x}/{y}.png',
  epochs: [
    { key: '2019_2020', label: '2019–2020', year: 2019, members: 299, seagrassKm2: 160123.4, tileBytes: 1, tiles: TILES_2019 },
    { key: '2023_2024', label: '2023–2024', year: 2023, members: 301, seagrassKm2: 170456.7, tileBytes: 1, tiles: TILES_2023 },
  ],
  palette: PALETTE,
  tileBytes: 2,
  source: { author: 'Peng, Li, Krause, Lyons, Murray, Schill, Roelfsema and Asner', licence: 'CC BY 4.0' },
});
const BLANK = { blank: true };
const rgba = (share) => [...PALETTE[share], 255];

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = rgba(42), readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createSeagrassLayer({
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
  assert.equal(validateSeagrassManifest(MANIFEST), null);
  const pal = (i, c) => PALETTE.map((p, j) => (j === i ? c : p));
  const ep = (i, change) => ({ ...MANIFEST, epochs: MANIFEST.epochs.map((e, j) => (j === i ? { ...e, ...change } : e)) });
  const broken = [
    [{ ...MANIFEST, generated_at: '2026-10-04' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: -1 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/seagrass/{z}/{x}/{y}.png' }, /\{epoch\}/],
    [{ ...MANIFEST, epochs: [] }, /not a list of epochs/],
    [ep(0, { key: '2019-2020' }), /not a YYYY_YYYY key/],
    [ep(0, { year: 2020 }), /year 2020 is not its first year/],
    [{ ...MANIFEST, epochs: [...MANIFEST.epochs].reverse() }, /does not follow 2023_2024/],
    [ep(1, { label: '' }), /no label/],
    [ep(1, { members: 0 }), /members 0/],
    [ep(1, { seagrassKm2: 0 }), /seagrassKm2 0/],
    [ep(1, { tiles: { ...TILES_2023, 4: undefined } }), /2023_2024.*no list for level 4/],
    [ep(0, { tiles: { ...TILES_2019, 0: [[2, 0]] } }), /not on level 0/],
    [ep(0, { tiles: { ...TILES_2019, 1: [[0, 2]] } }), /not on level 1/],
    [{ ...MANIFEST, palette: PALETTE.slice(0, 100) }, /101 RGB/],
    [{ ...MANIFEST, palette: pal(7, [0, 0, 256]) }, /101 RGB/],
    [{ ...MANIFEST, palette: pal(7, PALETTE[8]) }, /not distinct/],
    [{ ...MANIFEST, source: { licence: 'CC BY-NC 4.0' } }, /licence/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateSeagrassManifest(m) ?? 'accepted', why);
});

test('share text: any share under 1.5% is painted 1 and says so', () => {
  assert.equal(shareText(1), 'seagrass: under 1.5% of the ~150 m cell');
  assert.equal(shareText(2), 'seagrass: about 2% of the ~150 m cell');
  assert.equal(shareText(100), 'seagrass: about 100% of the ~150 m cell');
});

test('the drape: one geographic provider per shown epoch, only that epoch\'s listed tiles requested, shown only while enabled', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/seagrass.json');
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.equal(p.options.url, 'data/seagrass/2023_2024/{z}/{x}/{y}.png?v=2026-10-04T08:00:00Z', 'no date set: the latest epoch, build time busting the cache');
  assert.ok(p.options.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(p.options.maximumLevel, 9);
  assert.match(p.options.credit, /Peng/);
  assert.equal(await p.requestImage(east.x, east.y, 9), 'tile', 'listed in 2023–2024');
  assert.equal(await p.requestImage(east.x + 1, east.y, 9), BLANK, 'an unlisted one is blank');
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual(stacked.at(-1), { id: 'seagrass', imagery: list[0], zrank: 21 });
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');

  await layer.setObservedTime('2021-06-01T00:00:00Z');
  assert.equal(providers.length, 2, 'a date in 2021 draws the 2019–2020 epoch');
  const q = providers[1];
  assert.equal(q.options.url, 'data/seagrass/2019_2020/{z}/{x}/{y}.png?v=2026-10-04T08:00:00Z');
  assert.equal(await q.requestImage(east.x, east.y, 9), BLANK, 'the 2019–2020 list does not hold the 2023 tile');
  assert.equal(await q.requestImage(leaf.x, leaf.y, 9), 'tile');
  assert.equal(list.length, 1, 'the old drape is gone');
  assert.equal(list[0].show, true);
  await layer.setObservedTime('2020-12-31T23:00:00Z');
  assert.equal(providers.length, 2, 'the same epoch keeps its drape');
  await layer.setObservedTime('2023-01-01T00:00:00Z');
  assert.equal(providers.length, 3);
  assert.match(providers[2].options.url, /2023_2024/);

  await layer.setObservedTime('2018-12-31T00:00:00Z');
  assert.equal(list[0].show, false, 'before the first epoch nothing is drawn');
  assert.equal(layer.getStats().error, 'no seagrass mapped before 2019 (shown: 2018-12-31)');
  assert.equal(layer.getStats().time, null);
  layer.enable();
  assert.equal(list[0].show, false, 'enabling does not show a gap');
  // back to the epoch still drawn: no redraw, so only leaving the gap clears its message
  await layer.setObservedTime('2024-06-01T00:00:00Z');
  assert.equal(providers.length, 3, 'the 2023–2024 drape was kept through the gap');
  assert.equal(layer.getStats().error, null);
  assert.equal(list[0].show, true);
  await layer.setObservedTime('2019-01-01T00:00:00Z');
  assert.equal(layer.getStats().error, null);
  assert.equal(list[0].show, true);
  assert.equal(layer.getStats().time, '2019–2020');
  assert.equal(await layer.setObservedTime('not a date'), false);

  assert.deepEqual(layer.getObservedExtent(), { startMs: Date.UTC(2019, 0, 1), endMs: Date.UTC(2024, 11, 31, 23, 59, 59, 999) });
  layer.disable();
  assert.equal(list[0].show, false);
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(gone.layer.getObservedExtent(), null);
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /seagrass\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, epochs: [] } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed seagrass\.json: epochs/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(...GRASS)).status, 'error');
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

test('readout: the share at level 9 of the shown epoch; none in a transparent pixel or an unlisted tile, without a read; beyond the map is outside; failures and odd colours are loud', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(...GRASS), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(...GRASS);
  assert.deepEqual([r.status, r.text, r.date], ['class', 'seagrass: about 42% of the ~150 m cell', '2023–2024']);
  assert.deepEqual(h.reads, [{ url: `data/seagrass/2023_2024/9/${leaf.x}/${leaf.y}.png?v=2026-10-04T08:00:00Z`, px: leaf.px, py: leaf.py }]);
  await h.layer.setObservedTime('2020-03-01T00:00:00Z');
  const old = await h.layer.readoutAt(...GRASS);
  assert.equal(old.date, '2019–2020');
  assert.equal(h.reads.at(-1).url, `data/seagrass/2019_2020/9/${leaf.x}/${leaf.y}.png?v=2026-10-04T08:00:00Z`);
  await h.layer.setObservedTime('2017-03-01T00:00:00Z');
  assert.deepEqual(await h.layer.readoutAt(...GRASS), { id: 'seagrass', name: h.layer.name, icon: '🌱', status: 'gap', text: null, date: null, observed: '2017-03-01T00:00:00Z' });
  await h.layer.setObservedTime(null);
  const reads = h.reads.length;

  const inland = await h.layer.readoutAt(...INLAND);
  assert.deepEqual([inland.status, inland.text, inland.date], ['class', NONE_TEXT, '2023–2024']);
  assert.equal(h.reads.length, reads, 'an unlisted tile was never written: no read');
  assert.equal(NONE_TEXT, 'no seagrass mapped in this ~150 m cell');
  // the map's own GeoTIFFs stop at 72.34°N and 51.29°S: beyond is unmapped, not seagrass-free
  assert.deepEqual([MAPPED_NORTH, MAPPED_SOUTH], [72.33, -51.29]);
  assert.equal((await h.layer.readoutAt(72.4, -80.35)).status, 'outside');
  assert.equal((await h.layer.readoutAt(-51.4, -80.35)).status, 'outside');
  assert.equal((await h.layer.readoutAt(72.3, -80.35)).status, 'class', 'just inside the north edge is read');
  assert.equal((await h.layer.readoutAt(-51.2, -80.35)).status, 'class', 'just inside the south edge is read');
  assert.equal(h.reads.length, reads);

  const faint = harness({ pixel: rgba(1) });
  faint.layer.enable();
  await faint.layer.update();
  assert.equal((await faint.layer.readoutAt(...GRASS)).text, 'seagrass: under 1.5% of the ~150 m cell');

  const clear = harness({ pixel: [0, 0, 0, 0] });
  clear.layer.enable();
  await clear.layer.update();
  assert.equal((await clear.layer.readoutAt(...GRASS)).text, NONE_TEXT, 'a listed tile can be clear at this pixel');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(...GRASS)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(...GRASS);
  assert.equal(failed.status, 'error', 'a listed tile was written, so a 404 is a fault');
  assert.match(failed.error, /404/);
});

test('legend: five share bins, each in the colour of its middle share, then the definition and the shown epoch\'s mapped area', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => [e.label, e.color]), [
    ['1–10% seagrass', `rgb(${PALETTE[6].join(',')})`],
    ['10–25% seagrass', `rgb(${PALETTE[18].join(',')})`],
    ['25–50% seagrass', `rgb(${PALETTE[38].join(',')})`],
    ['50–75% seagrass', `rgb(${PALETTE[63].join(',')})`],
    ['75–100% seagrass', `rgb(${PALETTE[88].join(',')})`],
  ]);
  const note = legend.at(-1).label;
  assert.match(note, /~150 m cell mapped as seagrass/);
  assert.match(note, /51°S and 72°N/);
  assert.match(note, /170,457 km² mapped in 2023–2024/);
  assert.match(note, /CC BY 4\.0/);
  await layer.setObservedTime('2020-01-01T00:00:00Z');
  assert.match(layer.getRowControls().legend.at(-1).label, /160,123 km² mapped in 2019–2020/);
  await layer.setObservedTime('2018-01-01T00:00:00Z');
  assert.doesNotMatch(layer.getRowControls().legend.at(-1).label, /km² mapped/, 'no epoch shown, no area');
});

test('credit: the source, its licence and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'seagrass');
  assert.ok(credit, 'DATA_CREDITS has a seagrass entry');
  assert.match(credit.html, /Peng/);
  assert.match(credit.html, /doi\.org\/10\.5281\/zenodo\.18612240/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /Changed: .*share of each ~150 m cell/);
});
