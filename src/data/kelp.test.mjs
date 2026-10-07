// src/data/kelp.test.mjs — the floating kelp layer: manifest, decode, drape lifecycle, readout, legend, credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  EDITION,
  MANIFEST_URL,
  NONE_TEXT,
  PAPER_KM2,
  TILE_FAILURE_LIMIT,
  createKelpLayer,
  shareText,
  validateKelpManifest,
} from './kelp.js';
import { decodeTidalMarsh as decodeShare, LEGEND_BINS } from './tidalMarsh.js';
import { geoTilePixel } from './humanFootprint.js';

// a palette of the shape pipeline/kelp.py writes (its own rounding may differ by one): index 0 transparent, 1-100 from
// pale yellow through orange to dark brown; the QA checks the real one
const STOPS = [[1, [255, 237, 160]], [50, [236, 112, 20]], [100, [102, 37, 6]]];
const PALETTE = [[0, 0, 0]];
for (let i = 1; i <= 100; i++) {
  const k = i <= 50 ? 0 : 1;
  const [[a, ca], [b, cb]] = [STOPS[k], STOPS[k + 1]];
  const t = (i - a) / (b - a);
  PALETTE.push(ca.map((x, j) => Math.round(x + (cb[j] - x) * t)));
}
const KELP = [36.6, -121.9]; // Monterey Bay
const SEA = [30.0, -140.0]; // open Pacific
const leaf = geoTilePixel(...KELP, 9);
// the leaf tile and its ancestors, as the pipeline lists painted tiles per level
const TILES = Object.fromEntries(Array.from({ length: 10 }, (_, z) => [String(z), [[leaf.x >> (9 - z), leaf.y >> (9 - z)]]]));
const MANIFEST = Object.freeze({
  generated_at: '2026-10-07T18:20:53Z',
  maxLevel: 9,
  tile: 'data/kelp/{z}/{x}/{y}.png',
  tiles: TILES,
  palette: PALETTE,
  subpixels: 64,
  features: 426489,
  kelpKm2: 2216.2,
  drawnKm2: 2216.2,
  tileBytes: 4364423,
  source: { author: 'Arafeh-Dalmau, Villaseñor-Derbez, Schoeman, Mora-Soto, Bell et al.', licence: 'CC BY 4.0' },
});
const BLANK = { blank: true };
const rgba = (share) => [...PALETTE[share], 255];

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = rgba(58), readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createKelpLayer({
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
  assert.equal(validateKelpManifest(MANIFEST), null);
  const pal = (i, c) => PALETTE.map((p, j) => (j === i ? c : p));
  const broken = [
    [{ ...MANIFEST, generated_at: '2026-10-07' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: 9.5 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/kelp/{z}/{x}.png' }, /\{y\}/],
    [{ ...MANIFEST, tiles: null }, /tiles is not an object/],
    [{ ...MANIFEST, tiles: { ...TILES, 4: undefined } }, /no list for level 4/],
    [{ ...MANIFEST, tiles: { ...TILES, 0: [[2, 0]] } }, /not on level 0/],
    [{ ...MANIFEST, tiles: { ...TILES, 1: [[0, 2]] } }, /not on level 1/],
    [{ ...MANIFEST, tiles: { ...TILES, 3: [[-1, 0]] } }, /not on level 3/],
    [{ ...MANIFEST, palette: PALETTE.slice(0, 100) }, /101 RGB/],
    [{ ...MANIFEST, palette: pal(7, [0, 0, 256]) }, /101 RGB/],
    [{ ...MANIFEST, palette: pal(7, PALETTE[8]) }, /not distinct/],
    [{ ...MANIFEST, subpixels: 0 }, /subpixels 0/],
    [{ ...MANIFEST, features: 1.5 }, /features 1.5/],
    [{ ...MANIFEST, kelpKm2: 0 }, /kelpKm2 0/],
    [{ ...MANIFEST, kelpKm2: '2216' }, /kelpKm2 "2216"/],
    [{ ...MANIFEST, source: { licence: 'CC BY-NC 4.0' } }, /licence/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateKelpManifest(m) ?? 'accepted', why);
});

test('pixel decode and text: a palette colour is its share, transparent is none, anything else is named', () => {
  for (let s = 1; s <= 100; s++) assert.deepEqual(decodeShare(rgba(s), MANIFEST), { kind: 'share', share: s });
  assert.deepEqual(decodeShare([0, 0, 0, 0], MANIFEST), { kind: 'none' });
  for (const odd of [[0, 0, 0, 255], [...PALETTE[58], 254], [1, 2, 3, 255]]) {
    assert.deepEqual(decodeShare(odd, MANIFEST), { kind: 'unknown', rgba: odd }, `${odd} is named, not snapped`);
  }
  assert.equal(shareText(1), 'floating kelp: under 1.5% of the ~150 m cell', 'any share under 1.5% is painted 1');
  assert.equal(shareText(2), 'floating kelp: about 2% of the ~150 m cell');
  assert.equal(shareText(100), 'floating kelp: about 100% of the ~150 m cell');
});

test('the drape: one geographic provider to level 9, only listed tiles requested, shown only while enabled; not on the time bar', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/kelp.json');
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.equal(p.options.url, 'data/kelp/{z}/{x}/{y}.png?v=2026-10-07T18:20:53Z', 'the build time busts cached tiles');
  assert.ok(p.options.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(p.options.maximumLevel, 9);
  assert.match(p.options.credit, /Arafeh-Dalmau/);
  assert.equal(await p.requestImage(leaf.x, leaf.y, 9), 'tile', 'a listed tile is requested');
  assert.equal(await p.requestImage(leaf.x + 1, leaf.y, 9), BLANK, 'an unlisted one is blank');
  assert.equal(await p.requestImage(1, 0, 0), BLANK, 'the eastern hemisphere at level 0 holds no listed tile here');
  assert.equal(await p.requestImage(0, 0, 0), 'tile', 'the western one does');
  assert.deepEqual(p.requested, [`9/${leaf.x}/${leaf.y}`, '0/0/0']);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual(stacked.at(-1), { id: 'kelp', imagery: list[0], zrank: 21 });
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  assert.equal(layer.setObservedTime, undefined);
  assert.deepEqual(layer.getStats(), { count: 1, lastUpdate: layer.getStats().lastUpdate, error: null, time: EDITION });
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /kelp\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, kelpKm2: -1 } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed kelp\.json: kelpKm2 -1/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(...KELP)).status, 'error');
  const ok = harness(); // positive control: the same harness with the good manifest draws
  assert.equal(await ok.layer.update(), true);
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

test('readout: the share at level 9; none in a transparent pixel or an unlisted tile, without a read; failures and odd colours are loud', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(...KELP), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(...KELP);
  assert.deepEqual([r.status, r.text, r.date], ['class', 'floating kelp: about 58% of the ~150 m cell', EDITION]);
  assert.deepEqual(h.reads, [{ url: `data/kelp/9/${leaf.x}/${leaf.y}.png?v=2026-10-07T18:20:53Z`, px: leaf.px, py: leaf.py }]);

  const sea = await h.layer.readoutAt(...SEA);
  assert.deepEqual([sea.status, sea.text, sea.date], ['class', NONE_TEXT, EDITION]);
  assert.equal(h.reads.length, 1, 'an unlisted tile was never written: no read');
  assert.equal(NONE_TEXT, 'no floating kelp mapped in this ~150 m cell');
  assert.equal((await h.layer.readoutAt(91, 0)).status, 'outside', 'off the globe');

  const faint = harness({ pixel: rgba(1) });
  faint.layer.enable();
  await faint.layer.update();
  assert.equal((await faint.layer.readoutAt(...KELP)).text, 'floating kelp: under 1.5% of the ~150 m cell');

  const clear = harness({ pixel: [0, 0, 0, 0] });
  clear.layer.enable();
  await clear.layer.update();
  assert.equal((await clear.layer.readoutAt(...KELP)).text, NONE_TEXT, 'a listed tile can be clear at this pixel');

  const odd = harness({ pixel: [1, 2, 3, 255] });
  odd.layer.enable();
  await odd.layer.update();
  assert.match((await odd.layer.readoutAt(...KELP)).error, /unrecognised pixel 1,2,3,255/);

  const gone = harness({ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) });
  gone.layer.enable();
  await gone.layer.update();
  const failed = await gone.layer.readoutAt(...KELP);
  assert.equal(failed.status, 'error', 'a listed tile was written, so a 404 is a fault');
  assert.match(failed.error, /404/);
});

test('legend: five share bins, each in the colour of its middle share, then what a cell means, the mapped area and the authors\' total', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(LEGEND_BINS, [[1, 10], [10, 25], [25, 50], [50, 75], [75, 100]]);
  assert.deepEqual(legend.slice(0, -1).map((e) => [e.label, e.color]), [
    ['1–10% kelp', `rgb(${PALETTE[6].join(',')})`],
    ['10–25% kelp', `rgb(${PALETTE[18].join(',')})`],
    ['25–50% kelp', `rgb(${PALETTE[38].join(',')})`],
    ['50–75% kelp', `rgb(${PALETTE[63].join(',')})`],
    ['75–100% kelp', `rgb(${PALETTE[88].join(',')})`],
  ]);
  const note = legend.at(-1).label;
  assert.match(note, /~150 m cell where floating kelp canopy was ever detected/);
  assert.match(note, /Landsat from 1984/);
  assert.match(note, /Sentinel-2 mosaic of 2015–2019/);
  assert.match(note, /Canada, Chile and New Zealand are underestimated/);
  assert.match(note, /floating-canopy kelps only/);
  assert.match(note, /2,216\.2 km² mapped; the authors' total is 2,216\.6 km²/);
  assert.equal(PAPER_KM2, 2216.55);
  assert.match(note, /CC BY 4\.0/);
  const other = harness({ manifest: { ...MANIFEST, kelpKm2: 1234.56 } });
  await other.layer.update();
  assert.match(other.layer.getRowControls().legend.at(-1).label, /1,234\.6 km² mapped/, 'the mapped area is the manifest\'s');
});

test('credit: the paper, the data record, the US/Mexico input, the licence and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'kelp');
  assert.ok(credit, 'DATA_CREDITS has a kelp entry');
  assert.match(credit.html, /Arafeh-Dalmau/);
  assert.match(credit.html, /doi\.org\/10\.1038\/s41467-025-58054-4/);
  assert.match(credit.html, /doi\.org\/10\.5281\/zenodo\.14816612/);
  // the US/Mexico input is named in the visible text, not only in a link's address
  const text = credit.html.replace(/<[^>]+>/g, '');
  assert.match(text, /Santa Barbara Coastal LTER, EDI package knb-lter-sbc\.74\.13 \(CC BY 4\.0\)/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /Changed: .*share of each ~150 m cell/);
});
