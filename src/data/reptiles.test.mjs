// src/data/reptiles.test.mjs — the reptile richness layer: manifest, drape, readout (total from the display tile, groups
// from the group tile), legend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MANIFEST_URL, TILE_FAILURE_LIMIT, countText, createReptilesLayer, decodeCount, validateManifest } from './reptiles.js';
import { geoTilePixel } from './humanFootprint.js';

// the pipeline's palette shape (pipeline/reptiles.py palette(189)): index 0 for no species, then 189 distinct colours
const PALETTE = [[0, 0, 0], ...Array.from({ length: 189 }, (_, k) => [k + 1, 254 - k, 107])];
const MANIFEST = Object.freeze({
  maxLevel: 3,
  tile: 'data/reptiles/{z}/{x}/{y}.png',
  groupTile: 'data/reptiles/groups/{x}/{y}.png',
  groups: ['lizards', 'snakes', 'turtles', 'other'],
  palette: PALETTE,
  maxSpecies: 189,
  species: 10914,
});

function harness({ manifest = MANIFEST, manifestStatus = 200, total = 189, groups = [68, 102, 17, 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createReptilesLayer({
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: manifestStatus === 200, status: manifestStatus, json: async () => structuredClone(manifest) };
    },
    providerFor: (options) => {
      const listeners = [];
      const p = { options, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: (_layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
    readTilePixel: async (url, px, py) => {
      reads.push({ url, px, py });
      if (readError) throw readError;
      if (url.includes('/groups/')) return { rgba: groups, timeActual: null };
      return { rgba: total === 0 ? [0, 0, 0, 0] : Array.isArray(total) ? total : [...PALETTE[total], 255], timeActual: null };
    },
  });
  layer.init(viewer);
  return { layer, providers, reads, list, stacked, fetches };
}

test('manifest: the shape the pipeline writes is accepted; each broken field is named', () => {
  assert.equal(validateManifest(MANIFEST), null);
  const broken = [
    [{ ...MANIFEST, maxLevel: -1 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/reptiles/{x}/{y}.png' }, /tile .* lacks/],
    [{ ...MANIFEST, groupTile: 'data/reptiles/groups.png' }, /groupTile/],
    [{ ...MANIFEST, maxSpecies: 256 }, /maxSpecies 256/],
    [{ ...MANIFEST, palette: PALETTE.slice(1) }, /palette is not 190/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(0, -1), [0, 0, 256]] }, /palette is not 190/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(0, -1), PALETTE[1]] }, /distinct/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateManifest(m) ?? 'accepted', why);
});

test('decoding and text: transparent is none, a palette colour its count; the groups split the total', () => {
  assert.deepEqual(decodeCount([0, 0, 0, 0], PALETTE), { kind: 'none' });
  assert.deepEqual(decodeCount([...PALETTE[1], 255], PALETTE), { kind: 'value', n: 1 });
  assert.deepEqual(decodeCount([...PALETTE[189], 255], PALETTE), { kind: 'value', n: 189 });
  assert.equal(decodeCount([0, 0, 0, 255], PALETTE).kind, 'unknown', 'index 0 is never drawn opaque');
  assert.equal(countText(189, [68, 102, 17]), '189 reptile species: 68 lizards, 102 snakes, 17 turtles, 2 other');
  assert.equal(countText(1, [0, 0, 1]), '1 reptile species: 0 lizards, 0 snakes, 1 turtle, 0 other');
  assert.equal(countText(8, [7, 0, 0]), '8 reptile species: 7 lizards, 0 snakes, 0 turtles, 1 other');
  assert.equal(countText(2, [1, 1, 0]), '2 reptile species: 1 lizard, 1 snake, 0 turtles, 0 other');
});

test('the drape: one geographic provider to level 3, read once; off until enabled; failing tiles rebuild it', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/reptiles.json');
  assert.equal(providers.length, 1);
  const o = providers[0].options;
  assert.equal(o.url, 'data/reptiles/{z}/{x}/{y}.png');
  assert.ok(o.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(o.maximumLevel, 3);
  assert.match(o.credit, /GARD 1\.7/);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual([stacked.at(-1).id, stacked.at(-1).zrank], ['reptiles', 21]);
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i++) providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, null);
  providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, 'map tiles failing');
  await layer.update();
  assert.equal(providers.length, 2);
  assert.equal(list.length, 1, 'the failing drape is replaced');
  assert.equal(layer.getStats().error, null);
  layer.disable();
  assert.equal(list[0].show, false);
  layer.destroy();
  assert.equal(list.length, 0);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /reptiles\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, palette: PALETTE.slice(1) } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed reptiles\.json: palette/);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(0, 0)).status, 'error');
  const good = harness();
  assert.equal(await good.layer.update(), true, 'positive control: the same harness with the pipeline shape draws');
});

test('readout: total and groups from the same level-3 pixel; none where no range reaches; odd pixels are loud', async () => {
  const lat = 3.75, lon = 101.75;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.deepEqual([r.status, r.text, r.date], ['value', '189 reptile species: 68 lizards, 102 snakes, 17 turtles, 2 other', 'GARD 1.7']);
  const t = geoTilePixel(lat, lon, 3);
  assert.deepEqual(h.reads, [
    { url: `data/reptiles/3/${t.x}/${t.y}.png`, px: t.px, py: t.py },
    { url: `data/reptiles/groups/${t.x}/${t.y}.png`, px: t.px, py: t.py },
  ]);
  assert.match((await h.layer.readoutAt(lat, lon + 360)).text, /^189 /, 'longitudes wrap');

  const empty = harness({ total: 0 });
  empty.layer.enable();
  await empty.layer.update();
  const none = await empty.layer.readoutAt(72.05, -40.05);
  assert.deepEqual([none.status, none.text], ['class', 'No mapped reptile range']);
  assert.equal(empty.reads.length, 1, 'no group read where there are no species');

  for (const [opts, why] of [
    [{ total: [1, 2, 3, 255] }, /unrecognised pixel 1,2,3,255/],
    [{ groups: [100, 100, 0, 255] }, /group pixel 100,100,0,255 does not fit 189 species/],
    [{ groups: [1, 1, 1, 0] }, /does not fit/],
    [{ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) }, /404/],
  ]) {
    const x = harness(opts);
    x.layer.enable();
    await x.layer.update();
    const row = await x.layer.readoutAt(lat, lon);
    assert.equal(row.status, 'error');
    assert.match(row.error, why);
  }
});

test('legend: sampled counts in their palette colours up to the most, plus what is counted', async () => {
  const { layer } = harness();
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), ['1', '25', '50', '100', '150', '189']);
  assert.equal(legend[0].color, `rgb(${PALETTE[1].join(',')})`);
  assert.equal(legend[5].color, `rgb(${PALETTE[189].join(',')})`);
  assert.match(legend.at(-1).label, /range overlaps each 0\.1° cell \(GARD 1\.7 range maps of 10,914 species/);
  const small = harness({ manifest: { ...MANIFEST, maxSpecies: 40, palette: PALETTE.slice(0, 41) } });
  await small.layer.update();
  assert.deepEqual(small.layer.getRowControls().legend.slice(0, -1).map((e) => e.label), ['1', '25', '40']);
});
