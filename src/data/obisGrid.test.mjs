// src/data/obisGrid.test.mjs — the OBIS marine records layer: manifest, cell lookup, drape lifecycle, readout, loud failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { existsSync, readFileSync } from 'node:fs';
import { COLUMNS, MANIFEST_URL, cellOf, cellText, createObisGridLayer, validateObisGridManifest } from './obisGrid.js';

const PALETTE = [[254, 235, 226], [252, 197, 192], [250, 159, 181], [247, 104, 161], [221, 52, 151], [174, 1, 126], [122, 1, 119]];
// the rows pipeline/tests/test_obis_grid.py plants and sums by hand
const CELLS = [[-1, -1, 1, 0, 1, null, null], [10, -20, 4, 2, 2, 1990, 2015], [89, 179, 1, 1, 1, 2020, 2020]];
const MANIFEST = Object.freeze({
  asOf: '2026-10-02',
  source: 'OBIS open-data export (s3://obis-open-data/occurrence), CC0 1.0 and CC BY 4.0 datasets only',
  cell_degrees: 1,
  image: 'data/obis_grid.png',
  palette: PALETTE,
  bin_floors: [1, 10, 100, 1000, 10000, 100000, 1000000],
  columns: COLUMNS,
  share: { datasets_in: 2, datasets_total: 4, datasets_out: 1, records_in: 6, records_total_listed: 16 },
  cells: CELLS,
});

function harness({ manifest = MANIFEST, manifestStatus = 200, imageError = null } = {}) {
  const providers = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createObisGridLayer({
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: manifestStatus === 200, status: manifestStatus, json: async () => structuredClone(manifest) };
    },
    providerFor: async (url, rectangle) => {
      providers.push({ url, rectangle });
      if (imageError) throw imageError;
      return { url, rectangle };
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: (_layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
  });
  layer.init(viewer);
  return { layer, providers, list, stacked, fetches };
}

test('manifest: the shape the pipeline writes is accepted; each broken field is named', () => {
  assert.equal(validateObisGridManifest(MANIFEST), null);
  const broken = [
    [{ ...MANIFEST, asOf: undefined }, /asOf/],
    [{ ...MANIFEST, cell_degrees: 0.5 }, /cell_degrees/],
    [{ ...MANIFEST, image: 'data/obis_grid.json' }, /image/],
    [{ ...MANIFEST, palette: PALETTE.slice(1) }, /palette/],
    [{ ...MANIFEST, bin_floors: [1, 10, 10, 1000, 10000, 100000, 1000000] }, /bin_floors/],
    [{ ...MANIFEST, columns: COLUMNS.slice(0, 6) }, /columns/],
    [{ ...MANIFEST, share: { ...MANIFEST.share, records_in: -1 } }, /share/],
    [{ ...MANIFEST, cells: [...CELLS, [90, 0, 1, 1, 1, null, null]] }, /cell \[90/],
    [{ ...MANIFEST, cells: [...CELLS, [0, 180, 1, 1, 1, null, null]] }, /cell \[0,180/],
    [{ ...MANIFEST, cells: [...CELLS, [0, 0, 0, 0, 1, null, null]] }, /records ≥ 1/],
    [{ ...MANIFEST, cells: [...CELLS, [0, 0, 1, 1, 1, null]] }, /cell/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateObisGridManifest(m) ?? 'accepted', why);
});

test('cell lookup: the south-west corner, as the pipeline keys it; the pole and the antimeridian fold into the last cell', () => {
  assert.equal(cellOf(10.0, -20.0), '10,-20', 'on the corner: in the cell');
  assert.equal(cellOf(10.99, -19.01), '10,-20');
  assert.equal(cellOf(-0.5, -0.5), '-1,-1');
  assert.equal(cellOf(90, 180), '89,179');
  assert.equal(cellOf(-90, -180), '-90,-180');
  assert.equal(cellOf(0.5, 190.5), '0,-170', 'a longitude past 180 wraps');
  assert.equal(cellOf(0.5, -180.5), '0,179');
  for (const bad of [[91, 0], [-90.1, 0], [NaN, 0], [0, Infinity]]) assert.equal(cellOf(...bad), null, `${bad} is off the map`);
});

test('cell text: counts with their units, singular where one; the years the dated records span', () => {
  assert.equal(cellText(CELLS[1]), '4 records · 2 species · 2 datasets · 1990–2015');
  assert.equal(cellText(CELLS[2]), '1 record · 1 species · 1 dataset · 2020');
  assert.equal(cellText(CELLS[0]), '1 record · 0 species · 1 dataset · no dated records');
  assert.equal(cellText([0, 0, 1234567, 1, 3, 1900, 2026]), '1,234,567 records · 1 species · 3 datasets · 1900–2026');
});

test('the drape: the manifest is read once; one image over the whole globe, shown only while enabled; not on the time bar', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/obis_grid.json');
  assert.equal(providers.length, 1);
  assert.equal(providers[0].url, 'data/obis_grid.png?v=2026-10-02', 'the snapshot date busts a cached image');
  assert.deepEqual(providers[0].rectangle, Cesium.Rectangle.fromDegrees(-180, -90, 180, 90));
  assert.equal(list[0].show, false, 'registered off');
  assert.equal(stacked.at(-1).id, 'obis-grid');
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1, 'a second update keeps the drape');
  assert.deepEqual(fetches, [MANIFEST_URL], 'and does not re-read the manifest');
  layer.disable();
  assert.equal(list[0].show, false);
  assert.equal(layer.getObservedExtent, undefined, 'not on the time bar');
  assert.equal(layer.setObservedTime, undefined);
  assert.deepEqual([layer.getStats().time, layer.getStats().count], ['2026-10-02', 3]);
  layer.destroy();
  assert.equal(list.length, 0);
  assert.equal(stacked.at(-1).imagery, null);
});

test('a missing or malformed manifest, or an image that will not load, is loud and draws nothing; the next update retries the image', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /obis_grid\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, cell_degrees: 2 } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed obis_grid\.json: cell_degrees 2/);
  assert.equal(bad.providers.length, 0);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(0, 0)).status, 'error');

  const png = harness({ imageError: new Error('HTTP 404') });
  assert.equal(await png.layer.update(), false);
  assert.match(png.layer.getStats().error, /data\/obis_grid\.png load error: HTTP 404/);
  assert.equal(png.list.length, 0);
  await png.layer.update();
  assert.equal(png.providers.length, 2, 'retried, not given up on');
});

function slowImage() {
  const releases = [], list = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; } } };
  const layer = createObisGridLayer({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => structuredClone(MANIFEST) }),
    providerFor: (url) => new Promise((r) => { releases.push(() => r({ url })); }),
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: () => {},
  });
  layer.init(viewer);
  const requested = async (n) => {
    for (let turn = 0; releases.length < n; turn++) {
      if (turn === 200) throw new Error(`the image was requested ${releases.length} times, never ${n}`);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { layer, viewer, releases, list, requested };
}

test('a drape still loading when the layer is destroyed never lands, nor after the layer is set up again', async () => {
  const gone = slowImage();
  const pending = gone.layer.update();
  await gone.requested(1);
  gone.layer.destroy();
  gone.releases[0]();
  assert.equal(await pending, false);
  assert.equal(gone.list.length, 0);

  const again = slowImage();
  const stale = again.layer.update();
  await again.requested(1);
  again.layer.destroy();
  again.layer.init(again.viewer);
  const fresh = again.layer.update();
  await again.requested(2);
  again.releases[0](); // the stale load lands while the fresh one is still in flight
  assert.equal(await stale, false);
  const third = again.layer.update();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(again.releases.length, 2, 'a third update joins the fresh load, not a new one');
  again.releases[1]();
  assert.deepEqual([await fresh, await third], [true, true]);
  assert.deepEqual(again.list.map((l) => l.provider.url), ['data/obis_grid.png?v=2026-10-02'], 'one drape, the fresh one');
});

test('two updates racing while the image loads share one load and land one drape', async () => {
  const { layer, releases, list, requested } = slowImage();
  const a = layer.update(), b = layer.update();
  await requested(1);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(releases.length, 1, 'the image is requested once');
  releases[0]();
  assert.deepEqual([await a, await b], [true, true]);
  assert.equal(list.length, 1);
});

test('readout: the cell under the point from the manifest; an empty cell reads no records; off and unloaded are distinct', async () => {
  const h = harness();
  assert.equal(await h.layer.readoutAt(10.5, -19.5), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(10.5, -19.5);
  assert.deepEqual(
    { status: r.status, text: r.text, date: r.date, id: r.id },
    { status: 'value', text: '4 records · 2 species · 2 datasets · 1990–2015', date: 'OBIS 2026-10-02', id: 'obis-grid' },
  );
  assert.equal((await h.layer.readoutAt(90, 180)).text, '1 record · 1 species · 1 dataset · 2020');
  const empty = await h.layer.readoutAt(40.5, 5.5);
  assert.deepEqual([empty.status, empty.text, empty.date], ['value', 'no records', 'OBIS 2026-10-02']);
  assert.equal((await h.layer.readoutAt(95, 0)).status, 'outside');
});

test('legend: one swatch per decade in its colour, plus the source and the share of OBIS shown', async () => {
  const { layer } = harness();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), [
    '1–9 records', '10–99 records', '100–999 records', '1,000–9,999 records', '10,000–99,999 records', '100,000–999,999 records', '1,000,000+ records',
  ]);
  assert.equal(legend[3].color, 'rgb(247,104,161)');
  assert.match(legend.at(-1).label, /OBIS 2026-10-02: 2 CC0 \/ CC BY datasets, about 38% of OBIS's records; records track survey effort, not richness/);
});

test('real file: the gitignored pipeline output public/data/obis_grid.json loads through the layer and reads its own cells (skips loud if absent)', async (t) => {
  const json = 'public/data/obis_grid.json', png = 'public/data/obis_grid.png';
  if (!existsSync(json)) { t.skip(`${json} absent (gitignored) — run python -m pipeline.obis_grid`); return; }
  const m = JSON.parse(readFileSync(json, 'utf8'));
  assert.equal(validateObisGridManifest(m), null);
  const head = readFileSync(png);
  assert.deepEqual([head.readUInt32BE(16), head.readUInt32BE(20)], [360, 180], 'one pixel per 1° cell');
  const layer = createObisGridLayer({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => m }),
    providerFor: async (url) => ({ url }),
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: () => {},
  });
  layer.init({ imageryLayers: { add() {}, remove: () => true } });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, null);
  assert.ok(m.cells.length > 0 && layer.getStats().count === m.cells.length);
  for (const c of [m.cells[0], m.cells.at(-1), m.cells[m.cells.length >> 1]]) {
    // the cell's centre reads that cell back
    assert.equal((await layer.readoutAt(c[0] + 0.5, c[1] + 0.5)).text, cellText(c), `cell ${c[0]},${c[1]}`);
  }
});
