// src/data/gbifMethodGrid.test.mjs — camera traps and eDNA from one GBIF manifest: validation, cell text, a drape per
// method, readout, legend, loud failures, the real file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { COLUMNS, MANIFEST_URL, METHODS, cellText, createMethodGridLayer, validateMethodGridManifest } from './gbifMethodGrid.js';

const ORANGES = [[254, 237, 222], [253, 208, 162], [253, 174, 107], [253, 141, 60], [241, 105, 19], [217, 72, 1], [140, 45, 4]];
const BLUES = [[239, 243, 255], [198, 219, 239], [158, 202, 225], [107, 174, 214], [66, 146, 198], [33, 113, 181], [8, 69, 148]];
// the cells pipeline/tests/test_camera_traps.py sums by hand from its planted download
const CAMERA = [[46, 7, 290, 4, 2, ['Capreolus capreolus', 'Meles meles', 'Sus scrofa']]];
const EDNA = [[-12, -77, 2, 1, 1, ['Engraulis ringens']], [89, 179, 3, 1, 1, ['Gadus morhua']]];
const MANIFEST = Object.freeze({
  asOf: '2026-10-03',
  source: 'GBIF.org occurrence download (SQL)',
  download: { key: '0009014-260928105237408', doi: '10.15468/dl.test', created: '2026-10-03T08:00:00' },
  cell_degrees: 1,
  bin_floors: [1, 10, 100, 1000, 10000, 100000, 1000000],
  columns: COLUMNS,
  methods: {
    camera: { label: 'Camera traps (GBIF)', phrases: ['camera trap'], image: 'data/camera_traps.png', palette: ORANGES, records: 290, datasets: 2, cells: CAMERA },
    edna: { label: 'eDNA (GBIF)', phrases: ['edna'], image: 'data/edna.png', palette: BLUES, records: 5, datasets: 2, cells: EDNA },
  },
});

function harness({ method = 'camera', manifest = MANIFEST, manifestStatus = 200, imageError = null } = {}) {
  const providers = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; } } };
  const layer = createMethodGridLayer({
    method,
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

const withMethod = (method, patch) => ({ ...MANIFEST, methods: { ...MANIFEST.methods, [method]: { ...MANIFEST.methods[method], ...patch } } });

test('manifest: the shape the pipeline writes is accepted for both methods; each broken field is named', () => {
  assert.equal(validateMethodGridManifest(MANIFEST, 'camera'), null);
  assert.equal(validateMethodGridManifest(MANIFEST, 'edna'), null);
  const broken = [
    [{ ...MANIFEST, asOf: '3 Oct' }, 'camera', /asOf/],
    [{ ...MANIFEST, download: { key: 'k', doi: 'dl.test' } }, 'camera', /DOI/],
    [{ ...MANIFEST, cell_degrees: 5 }, 'camera', /cell_degrees/],
    [{ ...MANIFEST, bin_floors: [1, 10, 10, 1000, 10000, 100000, 1000000] }, 'camera', /bin_floors/],
    [{ ...MANIFEST, columns: COLUMNS.slice(0, 5) }, 'camera', /columns/],
    [MANIFEST, 'acoustic', /no method "acoustic"/],
    [withMethod('edna', { image: 'data/edna.json' }), 'edna', /edna image/],
    [withMethod('edna', { palette: BLUES.slice(1) }), 'edna', /edna palette/],
    [withMethod('camera', { records: -1 }), 'camera', /record or dataset count/],
    [withMethod('camera', { cells: [[90, 0, 1, 1, 1, ['a']]] }), 'camera', /cell \[90/],
    [withMethod('camera', { cells: [[0, 0, 0, 0, 1, []]] }), 'camera', /records ≥ 1/],
    [withMethod('camera', { cells: [[0, 0, 5, 1, 1, ['a', 'b']]] }), 'camera', /up to 3 species/], // more names than species
    [withMethod('camera', { cells: [[0, 0, 5, 4, 1, ['a', 'b', 'c', 'd']]] }), 'camera', /up to 3 species/],
    [null, 'camera', /not an object/],
  ];
  for (const [m, method, why] of broken) assert.match(validateMethodGridManifest(m, method) ?? 'accepted', why);
  // a broken eDNA block does not stop the camera layer, and the other way round
  assert.equal(validateMethodGridManifest(withMethod('edna', { cells: 'x' }), 'camera'), null);
});

test('cell text: counts with their units, then the species recorded most', () => {
  assert.equal(cellText(CAMERA[0]), '290 records · 4 species · 2 datasets (Capreolus capreolus, Meles meles, Sus scrofa)');
  assert.equal(cellText(EDNA[1]), '3 records · 1 species · 1 dataset (Gadus morhua)');
  assert.equal(cellText([0, 0, 1, 0, 1, []]), '1 record · 0 species · 1 dataset', 'nothing named to species: no list');
  assert.equal(cellText([0, 0, 1234567, 2, 3, ['a', 'b']]), '1,234,567 records · 2 species · 3 datasets (a, b)');
});

test('a drape per method: its own image, id and stack slot; the manifest read once; not on the time bar', async () => {
  for (const [method, image, id] of [['camera', 'data/camera_traps.png', 'camera-traps'], ['edna', 'data/edna.png', 'edna']]) {
    const { layer, providers, list, stacked, fetches } = harness({ method });
    assert.equal(layer.id, id);
    assert.equal(layer.id, METHODS[method].id);
    assert.equal(await layer.update(), true);
    assert.deepEqual(fetches, [MANIFEST_URL]);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].url, `${image}?v=2026-10-03`, 'the snapshot date busts a cached image');
    assert.equal(list[0].show, false, 'registered off');
    assert.equal(stacked.at(-1).id, id);
    layer.enable();
    assert.equal(list[0].show, true);
    await layer.update();
    assert.deepEqual([providers.length, fetches.length], [1, 1], 'a second update keeps the drape and the manifest');
    assert.equal(layer.setObservedTime, undefined, 'not on the time bar');
    assert.equal(layer.getObservedExtent, undefined);
    assert.equal(layer.getStats().count, MANIFEST.methods[method].cells.length);
    layer.destroy();
    assert.equal(list.length, 0);
  }
  assert.throws(() => createMethodGridLayer({ method: 'acoustic' }), /unknown method "acoustic"/);
});

test('a missing or malformed manifest, or an image that will not load, is loud and draws nothing; the next update retries', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /camera_traps\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ method: 'edna', manifest: withMethod('edna', { palette: [] }) });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed camera_traps\.json: edna palette/);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(0, 0)).status, 'error');
  const png = harness({ imageError: new Error('HTTP 404') });
  assert.equal(await png.layer.update(), false);
  assert.match(png.layer.getStats().error, /data\/camera_traps\.png load error: HTTP 404/);
  await png.layer.update();
  assert.equal(png.providers.length, 2, 'retried, not given up on');
});

test('readout: the cell from its own method only; an empty cell says which method found nothing; off reads nothing', async () => {
  const cam = harness({ method: 'camera' });
  assert.equal(await cam.layer.readoutAt(46.5, 7.5), null, 'off → no row');
  cam.layer.enable();
  await cam.layer.update();
  const r = await cam.layer.readoutAt(46.5, 7.5);
  assert.deepEqual(
    { status: r.status, text: r.text, date: r.date, id: r.id },
    { status: 'value', text: cellText(CAMERA[0]), date: 'GBIF 2026-10-03', id: 'camera-traps' },
  );
  // an eDNA cell is not a camera cell
  assert.deepEqual([(await cam.layer.readoutAt(90, 180)).text], ['no camera trap records']);
  assert.equal((await cam.layer.readoutAt(95, 0)).status, 'outside');
  const dna = harness({ method: 'edna' });
  dna.layer.enable();
  await dna.layer.update();
  assert.equal((await dna.layer.readoutAt(90, 180)).text, '3 records · 1 species · 1 dataset (Gadus morhua)', 'the pole folds in');
  assert.equal((await dna.layer.readoutAt(46.5, 7.5)).text, 'no eDNA records');
});

test('legend: one swatch per decade in the method\'s colours, then what it shows, its counts and the download DOI', async () => {
  const { layer } = harness({ method: 'edna' });
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] }, 'nothing before the manifest');
  await layer.update();
  const { legend } = layer.getRowControls();
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), [
    '1–9 records', '10–99 records', '100–999 records', '1,000–9,999 records', '10,000–99,999 records', '100,000–999,999 records', '1,000,000+ records',
  ]);
  assert.equal(legend[3].color, 'rgb(107,174,214)', 'the eDNA ramp, not the camera one');
  assert.match(legend.at(-1).label, /where eDNA sampling recorded animals .* 2026-10-03: 5 records from 2 CC0 \/ CC BY datasets\. Where the method was used, not where animals are\. GBIF\.org occurrence download, doi:10\.15468\/dl\.test$/);
});

test('real file: the gitignored pipeline output public/data/camera_traps.json loads through both layers and reads its own cells (skips loud if absent)', async (t) => {
  const json = 'public/data/camera_traps.json';
  if (!existsSync(json)) { t.skip(`${json} absent (gitignored) — run python -m pipeline.camera_traps`); return; }
  const m = JSON.parse(readFileSync(json, 'utf8'));
  for (const method of Object.keys(METHODS)) {
    assert.equal(validateMethodGridManifest(m, method), null);
    const head = readFileSync(`public/${m.methods[method].image}`);
    assert.deepEqual([head.readUInt32BE(16), head.readUInt32BE(20)], [360, 180], 'one pixel per 1° cell');
    const layer = createMethodGridLayer({
      method,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => m }),
      providerFor: async (url) => ({ url }),
      imageryLayerFor: (provider) => ({ provider, show: true }),
      stack: () => {},
    });
    layer.init({ imageryLayers: { add() {}, remove: () => true } });
    layer.enable();
    assert.equal(await layer.update(), true);
    const cells = m.methods[method].cells;
    assert.ok(cells.length > 0 && layer.getStats().count === cells.length);
    for (const c of [cells[0], cells.at(-1), cells[cells.length >> 1]]) {
      assert.equal((await layer.readoutAt(c[0] + 0.5, c[1] + 0.5)).text, cellText(c), `${method} cell ${c[0]},${c[1]}`);
    }
  }
});
