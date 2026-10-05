// src/data/tidalMarsh.test.mjs — the tidal marsh layer: manifest, decode, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  LEGEND_BINS,
  MANIFEST_URL,
  NONE_TEXT,
  TILE_FAILURE_LIMIT,
  createTidalMarshLayer,
  decodeTidalMarsh,
  shareText,
  validateTidalMarshManifest,
} from './tidalMarsh.js';
import { geoTilePixel } from './humanFootprint.js';

// a palette of the shape pipeline/tidal_marsh.py writes (its own rounding may differ by one): index 0 transparent, 1-100 from
// light green through blue to deep blue; the QA checks the real one
const STOPS = [[1, [199, 233, 180]], [50, [29, 145, 192]], [100, [8, 29, 88]]];
const PALETTE = [[0, 0, 0]];
for (let i = 1; i <= 100; i++) {
  const k = i <= 50 ? 0 : 1;
  const [[a, ca], [b, cb]] = [STOPS[k], STOPS[k + 1]];
  const t = (i - a) / (b - a);
  PALETTE.push(ca.map((x, j) => Math.round(x + (cb[j] - x) * t)));
}
const MARSH = [52.85, 0.25]; // The Wash, England
const INLAND = [52.0, -1.5];
const leaf = geoTilePixel(...MARSH, 9);
// the leaf tile and its ancestors, as the pipeline lists painted tiles per level
const TILES = Object.fromEntries(Array.from({ length: 10 }, (_, z) => [String(z), [[leaf.x >> (9 - z), leaf.y >> (9 - z)]]]));
const MANIFEST = Object.freeze({
  generated_at: '2026-10-04T06:10:00Z',
  maxLevel: 9,
  tile: 'data/tidal_marsh/{z}/{x}/{y}.png',
  tiles: TILES,
  palette: PALETTE,
  year: 2020,
  version: '2.6',
  members: 154,
  marshKm2: 50123.4,
  tileBytes: 30000000,
  source: { author: 'Worthington, Spalding, Landis, Maxwell, Navarro, Smart and Murray', licence: 'CC BY 4.0' },
});
const BLANK = { blank: true };
const rgba = (share) => [...PALETTE[share], 255];

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = rgba(58), readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createTidalMarshLayer({
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
  assert.equal(validateTidalMarshManifest(MANIFEST), null);
  const pal = (i, c) => PALETTE.map((p, j) => (j === i ? c : p));
  const broken = [
    [{ ...MANIFEST, generated_at: '2026-10-04' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: 9.5 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/tidal_marsh/{z}/{x}.png' }, /\{y\}/],
    [{ ...MANIFEST, tiles: { ...TILES, 4: undefined } }, /no list for level 4/],
    [{ ...MANIFEST, tiles: { ...TILES, 0: [[2, 0]] } }, /not on level 0/],
    [{ ...MANIFEST, tiles: { ...TILES, 1: [[0, 2]] } }, /not on level 1/],
    [{ ...MANIFEST, palette: PALETTE.slice(0, 100) }, /101 RGB/],
    [{ ...MANIFEST, palette: pal(7, [0, 0, 256]) }, /101 RGB/],
    [{ ...MANIFEST, palette: pal(7, PALETTE[8]) }, /not distinct/],
    [{ ...MANIFEST, year: 2019 }, /year 2019/],
    [{ ...MANIFEST, version: '' }, /version/],
    [{ ...MANIFEST, members: 0 }, /members 0/],
    [{ ...MANIFEST, marshKm2: 0 }, /marshKm2 0/],
    [{ ...MANIFEST, source: { licence: 'CC BY-NC 4.0' } }, /licence/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateTidalMarshManifest(m) ?? 'accepted', why);
});

test('pixel decode: a palette colour is its share, transparent is none, anything else is named', () => {
  for (let s = 1; s <= 100; s++) assert.deepEqual(decodeTidalMarsh(rgba(s), MANIFEST), { kind: 'share', share: s });
  assert.deepEqual(decodeTidalMarsh([0, 0, 0, 0], MANIFEST), { kind: 'none' });
  for (const odd of [[0, 0, 0, 255], [...PALETTE[58], 254], [1, 2, 3, 255]]) {
    assert.deepEqual(decodeTidalMarsh(odd, MANIFEST), { kind: 'unknown', rgba: odd }, `${odd} is named, not snapped`);
  }
  assert.equal(shareText(1), 'tidal marsh: under 1.5% of the ~150 m cell', 'any share under 1.5% is painted 1');
  assert.equal(shareText(2), 'tidal marsh: about 2% of the ~150 m cell');
  assert.equal(shareText(100), 'tidal marsh: about 100% of the ~150 m cell');
});

test('the drape: one geographic provider to level 9, only listed tiles requested, shown only while enabled; not on the time bar', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/tidal_marsh.json');
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.equal(p.options.url, 'data/tidal_marsh/{z}/{x}/{y}.png?v=2026-10-04T06:10:00Z', 'the build time busts cached tiles');
  assert.ok(p.options.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(p.options.maximumLevel, 9);
  assert.match(p.options.credit, /Worthington/);
  assert.equal(await p.requestImage(leaf.x, leaf.y, 9), 'tile', 'a listed tile is requested');
  assert.equal(await p.requestImage(leaf.x + 1, leaf.y, 9), BLANK, 'an unlisted one is blank');
  assert.equal(await p.requestImage(0, 0, 0), BLANK, 'the western hemisphere at level 0 holds no listed tile here');
  assert.deepEqual(p.requested, [`9/${leaf.x}/${leaf.y}`]);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual(stacked.at(-1), { id: 'tidal-marsh', imagery: list[0], zrank: 21 });
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  assert.equal(layer.setObservedTime, undefined);
  assert.deepEqual(layer.getStats(), { count: 1, lastUpdate: layer.getStats().lastUpdate, error: null, time: '2020 (v2.6)' });
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /tidal_marsh\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, year: 2021 } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed tidal_marsh\.json: year 2021/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(...MARSH)).status, 'error');
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

test('readout: the share at level 9; none in a transparent pixel or an unlisted tile, without a read; beyond 60° is outside the map; failures and odd colours are loud', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(...MARSH), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(...MARSH);
  assert.deepEqual([r.status, r.text, r.date], ['class', 'tidal marsh: about 58% of the ~150 m cell', '2020 (v2.6)']);
  assert.deepEqual(h.reads, [{ url: `data/tidal_marsh/9/${leaf.x}/${leaf.y}.png?v=2026-10-04T06:10:00Z`, px: leaf.px, py: leaf.py }]);

  const inland = await h.layer.readoutAt(...INLAND);
  assert.deepEqual([inland.status, inland.text, inland.date], ['class', NONE_TEXT, '2020 (v2.6)']);
  assert.equal(h.reads.length, 1, 'an unlisted tile was never written: no read');
  assert.equal(NONE_TEXT, 'no tidal marsh mapped in this ~150 m cell');
  // the map stops at 60°N and 60°S: north of it is unmapped, not marsh-free
  assert.equal((await h.layer.readoutAt(60.5, 0.25)).status, 'outside');
  assert.equal((await h.layer.readoutAt(-60.5, 0.25)).status, 'outside');
  assert.equal((await h.layer.readoutAt(59.5, 0.25)).status, 'class', 'just inside is read');
  assert.equal(h.reads.length, 1);

  const faint = harness({ pixel: rgba(1) });
  faint.layer.enable();
  await faint.layer.update();
  assert.equal((await faint.layer.readoutAt(...MARSH)).text, 'tidal marsh: under 1.5% of the ~150 m cell');

  const clear = harness({ pixel: [0, 0, 0, 0] });
  clear.layer.enable();
  await clear.layer.update();
  assert.equal((await clear.layer.readoutAt(...MARSH)).text, NONE_TEXT, 'a listed tile can be clear at this pixel');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(...MARSH)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(...MARSH);
  assert.equal(failed.status, 'error', 'a listed tile was written, so a 404 is a fault');
  assert.match(failed.error, /404/);
});

test('legend: five share bins, each in the colour of its middle share, then the definition, the mapped area and the authors\' estimate', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(LEGEND_BINS, [[1, 10], [10, 25], [25, 50], [50, 75], [75, 100]]);
  assert.deepEqual(legend.slice(0, -1).map((e) => [e.label, e.color]), [
    ['1–10% marsh', `rgb(${PALETTE[6].join(',')})`],
    ['10–25% marsh', `rgb(${PALETTE[18].join(',')})`],
    ['25–50% marsh', `rgb(${PALETTE[38].join(',')})`],
    ['50–75% marsh', `rgb(${PALETTE[63].join(',')})`],
    ['75–100% marsh', `rgb(${PALETTE[88].join(',')})`],
  ]);
  const note = legend.at(-1).label;
  assert.match(note, /~150 m cell mapped as tidal marsh in 2020/);
  assert.match(note, /60°N–60°S/);
  assert.match(note, /50,123 km² mapped/);
  assert.match(note, /52,880 km² \(95% CI 32,030–59,780\)/);
  assert.match(note, /CC BY 4\.0/);
});

test('credit: the source, its licence, the citation and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'tidal-marsh');
  assert.ok(credit, 'DATA_CREDITS has a tidal-marsh entry');
  assert.match(credit.html, /Worthington/);
  assert.match(credit.html, /doi\.org\/10\.5281\/zenodo\.8420753/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /doi\.org\/10\.1111\/geb\.13852/);
  assert.match(credit.html, /Changed: .*share of each ~150 m cell/);
});
