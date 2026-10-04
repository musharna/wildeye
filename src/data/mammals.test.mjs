// src/data/mammals.test.mjs — the mammal richness layer: manifest, drape, readout (total from the display tile, groups
// from the group tile), legend, credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { DATE, MANIFEST_URL, NONE_TEXT, TILE_FAILURE_LIMIT, countText, createMammalsLayer, validateManifest } from './mammals.js';
import { geoTilePixel } from './humanFootprint.js';

// the pipeline's palette shape (pipeline/mammals.py palette(top)): index 0 for no species, then distinct colours
const TOP = 220;
const PALETTE = [[0, 0, 0], ...Array.from({ length: TOP }, (_, k) => [k + 1, 254 - k, 107])];
const MANIFEST = Object.freeze({
  generated_at: '2026-10-04T09:00:00Z',
  maxLevel: 3,
  tile: 'data/mammals/{z}/{x}/{y}.png',
  groupTile: 'data/mammals/groups/{x}/{y}.png',
  groups: ['rodents', 'bats', 'primates', 'other'],
  palette: PALETTE,
  maxSpecies: TOP,
  species: 6362,
});
const V = '?v=2026-10-04T09:00:00Z';

function harness({ manifest = MANIFEST, manifestStatus = 200, total = 200, groups = [60, 90, 12, 255], readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createMammalsLayer({
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
    [{ ...MANIFEST, generated_at: '2026-10-04' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: -1 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/mammals/{x}/{y}.png' }, /tile .* lacks/],
    [{ ...MANIFEST, groupTile: 'data/mammals/groups.png' }, /groupTile/],
    [{ ...MANIFEST, groups: ['lizards', 'snakes', 'turtles', 'other'] }, /groups .* are not rodents, bats, primates, other/],
    [{ ...MANIFEST, species: 0 }, /species 0/],
    [{ ...MANIFEST, maxSpecies: 256 }, /maxSpecies 256/],
    [{ ...MANIFEST, palette: PALETTE.slice(1) }, /palette is not 221/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(0, -1), [0, 0, 256]] }, /palette is not 221/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(0, -1), PALETTE[1]] }, /distinct/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateManifest(m) ?? 'accepted', why);
});

test('text: the groups split the total, the rest is other', () => {
  assert.equal(countText(200, [60, 90, 12]), '200 mammal species: 60 rodents, 90 bats, 12 primates, 38 other');
  assert.equal(countText(1, [0, 0, 1]), '1 mammal species: 0 rodents, 0 bats, 1 primate, 0 other');
  assert.equal(countText(3, [1, 1, 0]), '3 mammal species: 1 rodent, 1 bat, 0 primates, 1 other');
  assert.equal(countText(1200, [0, 0, 0]), '1,200 mammal species: 0 rodents, 0 bats, 0 primates, 1,200 other');
});

test('the drape: one geographic provider to level 3, read once; off until enabled; failing tiles rebuild it', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/mammals.json');
  assert.equal(providers.length, 1);
  const o = providers[0].options;
  assert.equal(o.url, `data/mammals/{z}/{x}/{y}.png${V}`, 'the build time busts cached tiles');
  assert.ok(o.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(o.maximumLevel, 3);
  assert.match(o.credit, /MDD v1\.2/);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual([stacked.at(-1).id, stacked.at(-1).zrank], ['mammals', 21]);
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
  for (let i = 0; i < TILE_FAILURE_LIMIT; i++) providers[0].fail(new Error('404'));
  assert.equal(layer.getStats().error, null, 'the old provider no longer counts');
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  layer.disable();
  assert.equal(list[0].show, false);
  layer.destroy();
  assert.equal(list.length, 0);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /mammals\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, palette: PALETTE.slice(1) } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed mammals\.json: palette/);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(0, 0)).status, 'error');
  const good = harness();
  assert.equal(await good.layer.update(), true, 'positive control: the same harness with the pipeline shape draws');
});

test('readout: total and groups from the same level-3 pixel; none where no range reaches; odd pixels are loud', async () => {
  const lat = -1.05, lon = 29.55;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.deepEqual([r.status, r.text, r.date], ['value', '200 mammal species: 60 rodents, 90 bats, 12 primates, 38 other', DATE]);
  assert.equal(DATE, 'MDD v1.2 maps');
  const t = geoTilePixel(lat, lon, 3);
  assert.deepEqual(h.reads, [
    { url: `data/mammals/3/${t.x}/${t.y}.png${V}`, px: t.px, py: t.py },
    { url: `data/mammals/groups/${t.x}/${t.y}.png${V}`, px: t.px, py: t.py },
  ]);
  assert.match((await h.layer.readoutAt(lat, lon + 360)).text, /^200 /, 'longitudes wrap');

  const empty = harness({ total: 0 });
  empty.layer.enable();
  await empty.layer.update();
  const none = await empty.layer.readoutAt(72.05, -40.05);
  assert.deepEqual([none.status, none.text], ['class', NONE_TEXT]);
  assert.equal(NONE_TEXT, 'No mapped mammal range');
  assert.equal(empty.reads.length, 1, 'no group read where there are no species');

  for (const [opts, why] of [
    [{ total: [1, 2, 3, 255] }, /unrecognised pixel 1,2,3,255/],
    [{ groups: [100, 100, 1, 255] }, /group pixel 100,100,1,255 does not fit 200 species/],
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
  const exact = harness({ groups: [100, 100, 0, 255] });
  exact.layer.enable();
  await exact.layer.update();
  assert.equal((await exact.layer.readoutAt(lat, lon)).text, '200 mammal species: 100 rodents, 100 bats, 0 primates, 0 other', 'groups may fill the total');
});

test('legend: sampled counts in their palette colours up to the most, plus what is counted', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls().legend.length, 1, 'before the manifest: the note only');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), ['1', '50', '100', '150', '200', '220']);
  assert.equal(legend[0].color, `rgb(${PALETTE[1].join(',')})`);
  assert.equal(legend[5].color, `rgb(${PALETTE[220].join(',')})`);
  assert.match(legend.at(-1).label, /range overlaps each 0\.1° cell \(range maps of 6,362 wild species, MDD v1\.2 taxonomy/);
  assert.match(legend.at(-1).label, /CC BY 4\.0/);
  const small = harness({ manifest: { ...MANIFEST, maxSpecies: 40, palette: PALETTE.slice(0, 41) } });
  await small.layer.update();
  assert.deepEqual(small.layer.getRowControls().legend.slice(0, -1).map((e) => e.label), ['1', '40']);
});

test('credit: the source, its licence, the citation and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'mammals');
  assert.ok(credit, 'DATA_CREDITS has a mammals entry');
  assert.match(credit.html, /Marsh/);
  assert.match(credit.html, /doi\.org\/10\.5281\/zenodo\.6644198/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /doi\.org\/10\.1111\/jbi\.14330/);
  assert.match(credit.html, /Changed: .*0\.1° cell/);
});
