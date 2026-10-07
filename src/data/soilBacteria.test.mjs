// Soil bacterial richness layer: manifest contract, the value-tile decoding, the drape, the readout read under the
// centre of the clicked point's 0.1° cell, the legend and the credit (spec 2026-10-07-soil-bacteria-design.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { DATE, LEGEND_STOPS, MANIFEST_URL, NONE_TEXT, TILE_FAILURE_LIMIT, binOf, createSoilBacteriaLayer, decodeValue, validateManifest, valueText } from './soilBacteria.js';
import { geoTilePixel } from './humanFootprint.js';

// the pipeline's palette shape (pipeline/soil_bacteria.py palette()): index 0 for blank, then 75 distinct colours
const PALETTE = [[0, 0, 0], ...Array.from({ length: 75 }, (_, k) => [k + 1, 200 - k, 50])];
const MANIFEST = Object.freeze({
  generated_at: '2026-10-07T18:00:00Z',
  maxLevel: 3,
  tile: 'data/soil_bacteria/{z}/{x}/{y}.png',
  valueTile: 'data/soil_bacteria/value/{x}/{y}.png',
  palette: PALETTE,
  display: { min: 150, max: 900, step: 10 },
  mean: [183, 895],
  sd: [63, 269],
  unit: 'bacterial sequence variants per soil sample',
  model: { r2: 0.41, r2Sd: 0.09, r2Max: 0.62, locations: 320, reads: 7500 },
});
const V = '?v=2026-10-07T18:00:00Z';
// the spec's encoding, written here from the spec: R = mean mod 256, G = SD mod 256, B = high nibbles, A = 255
const enc = (mean, sd) => [mean % 256, sd % 256, Math.floor(mean / 256) + 16 * Math.floor(sd / 256), 255];

function harness({ manifest = MANIFEST, manifestStatus = 200, pixel = enc(734, 190), readError = null } = {}) {
  const providers = [], reads = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createSoilBacteriaLayer({
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
      return { rgba: typeof pixel === 'function' ? pixel(url, px, py) : pixel, timeActual: null };
    },
  });
  layer.init(viewer);
  return { layer, providers, reads, list, stacked, fetches };
}

test('manifest: the shape the pipeline writes is accepted; each broken field is named', () => {
  assert.equal(validateManifest(MANIFEST), null);
  const broken = [
    [{ ...MANIFEST, generated_at: '2026-10-07' }, /generated_at/],
    [{ ...MANIFEST, maxLevel: -1 }, /maxLevel/],
    [{ ...MANIFEST, tile: 'data/soil_bacteria/{x}/{y}.png' }, /tile .* lacks/],
    [{ ...MANIFEST, valueTile: 'data/soil_bacteria/value.png' }, /valueTile .* lacks/],
    [{ ...MANIFEST, display: { min: 150, max: 905, step: 10 } }, /display .* is not whole bins/],
    [{ ...MANIFEST, display: { min: 150, max: 900, step: 0 } }, /display/],
    [{ ...MANIFEST, palette: PALETTE.slice(1) }, /palette is not 76 RGB colours/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(0, -1), [0, 0, 256]] }, /palette is not 76/],
    [{ ...MANIFEST, palette: [...PALETTE.slice(0, -1), PALETTE[1]] }, /distinct/],
    [{ ...MANIFEST, mean: [183, 4096] }, /mean .* is not a range 0–4095/],
    [{ ...MANIFEST, sd: [269, 63] }, /sd .* is not a range/],
    [{ ...MANIFEST, model: { r2: 0.41, reads: 7500 } }, /model .* lacks/],
    [null, /not an object/],
  ];
  for (const [m, why] of broken) assert.match(validateManifest(m) ?? 'accepted', why);
});

test('decoding: every whole mean and SD the tiles carry comes back exactly; blank and odd pixels are named', () => {
  const vals = [0, 1, 15, 16, 183, 255, 256, 269, 511, 512, 895, 1024, 4095];
  for (const m of vals) for (const s of vals) assert.deepEqual(decodeValue(enc(m, s)), { kind: 'value', mean: m, sd: s }, `${m}, ${s}`);
  assert.deepEqual(enc(895, 269), [127, 13, 19, 255], 'the bytes pipeline/tests pins for the same pair');
  assert.deepEqual(decodeValue([0, 0, 0, 0]), { kind: 'none' });
  for (const odd of [[1, 0, 0, 0], [0, 0, 0, 128], [10, 10, 10, 254]]) assert.equal(decodeValue(odd).kind, 'unknown', odd.join(','));
});

test('text: whole numbers with the unit, the spread named as the model\'s', () => {
  assert.equal(valueText(734, 190), '≈734 bacterial sequence variants per soil sample (model spread ±190)');
  assert.equal(valueText(1200, 63), '≈1,200 bacterial sequence variants per soil sample (model spread ±63)');
});

test('the drape: one geographic provider to level 3, read once; off until enabled; failing tiles rebuild it', async () => {
  const { layer, providers, list, stacked, fetches } = harness();
  assert.equal(await layer.update(), true);
  assert.deepEqual(fetches, [MANIFEST_URL]);
  assert.equal(MANIFEST_URL, 'data/soil_bacteria.json');
  assert.equal(providers.length, 1);
  const o = providers[0].options;
  assert.equal(o.url, `data/soil_bacteria/{z}/{x}/{y}.png${V}`, 'the build time busts cached tiles');
  assert.ok(o.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(o.maximumLevel, 3);
  assert.match(o.credit, /Bickel et al\. 2026/);
  assert.equal(list[0].show, false, 'registered off');
  assert.deepEqual([stacked.at(-1).id, stacked.at(-1).zrank], ['soil-bacteria', 21]);
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
  assert.equal(layer.setObservedTime, undefined);
  layer.disable();
  assert.equal(list[0].show, false);
  layer.destroy();
  assert.equal(list.length, 0);
});

test('a missing or malformed manifest is loud and draws nothing', async () => {
  const gone = harness({ manifestStatus: 404 });
  assert.equal(await gone.layer.update(), false);
  assert.match(gone.layer.getStats().error, /soil_bacteria\.json HTTP 404/);
  assert.equal(gone.providers.length, 0);
  const bad = harness({ manifest: { ...MANIFEST, palette: PALETTE.slice(1) } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed soil_bacteria\.json: palette/);
  bad.layer.enable();
  assert.equal((await bad.layer.readoutAt(0, 0)).status, 'error');
  const good = harness();
  assert.equal(await good.layer.update(), true, 'positive control: the same harness with the pipeline shape draws');
});

test('readout: mean and spread from the value pixel under the cell centre; blank reads none; odd pixels are loud', async () => {
  const lat = 14.75, lon = -17.45;
  const h = harness();
  assert.equal(await h.layer.readoutAt(lat, lon), null, 'off → no row');
  h.layer.enable();
  await h.layer.update();
  const r = await h.layer.readoutAt(lat, lon);
  assert.deepEqual([r.status, r.text, r.date], ['value', '≈734 bacterial sequence variants per soil sample (model spread ±190)', DATE]);
  assert.equal(DATE, 'Bickel et al. 2026 model');
  const t = geoTilePixel(lat, lon, 3);
  assert.deepEqual(h.reads, [{ url: `data/soil_bacteria/value/${t.x}/${t.y}.png${V}`, px: t.px, py: t.py }], 'one read, of the value tile');
  assert.match((await h.layer.readoutAt(lat, lon + 360)).text, /^≈734 /, 'longitudes wrap');

  // Off a cell's centre the pixel under the point can hold the next cell (lon 0.095 lies in cell 1800, 0.0–0.1° E, but
  // under pixel 2049, which nearest neighbour fills from cell 1801): the readout reads the cell's centre pixel
  const off = geoTilePixel(0.05, 0.095, 3), centre = geoTilePixel(0.05, 0.05, 3);
  assert.equal(off.x * 256 + off.px, 2049);
  assert.equal(Math.floor((2049 + 0.5) * 3600 / 4096), 1801, 'that pixel carries the next cell');
  const before = h.reads.length;
  await h.layer.readoutAt(0.05, 0.095);
  assert.deepEqual(h.reads.slice(before).map((q) => [q.px, q.py]), [[centre.px, centre.py]]);
  // 180° E is 180° W: the first column; the south pole is in the last row
  const n = h.reads.length;
  await h.layer.readoutAt(-90, 180);
  const pole = geoTilePixel(-89.95, -179.95, 3);
  assert.deepEqual(h.reads.slice(n).map((q) => [q.url, q.px, q.py]), [[`data/soil_bacteria/value/0/${pole.y}.png${V}`, pole.px, pole.py]]);
  assert.equal((await h.layer.readoutAt(91, 0)).status, 'outside');

  const sea = harness({ pixel: [0, 0, 0, 0] });
  sea.layer.enable();
  await sea.layer.update();
  const none = await sea.layer.readoutAt(0.05, -149.95);
  assert.deepEqual([none.status, none.text, none.date], ['class', NONE_TEXT, DATE]);
  assert.equal(NONE_TEXT, 'No modelled soil estimate');
  assert.doesNotMatch(none.text, /\d/, 'no number where the model is blank');

  for (const [opts, why] of [
    [{ pixel: [1, 2, 3, 128] }, /unrecognised pixel 1,2,3,128/],
    [{ pixel: [5, 0, 0, 0] }, /unrecognised pixel 5,0,0,0/],
    [{ pixel: enc(182, 190) }, /mean 182, SD 190: outside the build's 183–895, 63–269/],
    [{ pixel: enc(896, 190) }, /mean 896/],
    [{ pixel: enc(734, 62) }, /SD 62/],
    [{ pixel: enc(734, 270) }, /SD 270/],
    [{ readError: Object.assign(new Error('tile HTTP 404'), { status: 404 }) }, /404/],
  ]) {
    const x = harness(opts);
    x.layer.enable();
    await x.layer.update();
    const row = await x.layer.readoutAt(lat, lon);
    assert.equal(row.status, 'error', JSON.stringify(opts));
    assert.match(row.error, why);
  }
  for (const [m, s] of [[183, 63], [895, 269]]) {
    const edge = harness({ pixel: enc(m, s) });
    edge.layer.enable();
    await edge.layer.update();
    assert.equal((await edge.layer.readoutAt(lat, lon)).status, 'value', `the build's own ends ${m}, ${s} are values`);
  }
});

test('the readout pixel holds the clicked cell for every cell of a row and a column', async () => {
  // a fake level-3 value tile set filled by nearest neighbour from cell indices: mean = 183 + column mod 700,
  // SD = 63 + row mod 200, so any neighbour shows
  const pixel = (url, px, py) => {
    const [, x, y] = url.match(/value\/(\d+)\/(\d+)\.png/).map(Number);
    const col = Math.floor((x * 256 + px + 0.5) * 3600 / 4096), row = Math.floor((y * 256 + py + 0.5) * 1800 / 2048);
    return enc(183 + (col % 700), 63 + (row % 200));
  };
  const h = harness({ pixel });
  h.layer.enable();
  await h.layer.update();
  // points 0.04° from the centre of each cell, alternately east and west, north and south
  for (let col = 0; col < 3600; col += 1) {
    const lon = -179.95 + col * 0.1 + (col % 2 ? 0.04 : -0.04);
    const r = await h.layer.readoutAt(0.06, lon);
    assert.equal(r.text, valueText(183 + (col % 700), 63 + (899 % 200)), `column ${col}`);
  }
  for (let row = 0; row < 1800; row += 1) {
    const lat = 89.95 - row * 0.1 + (row % 2 ? 0.04 : -0.04);
    const r = await h.layer.readoutAt(lat, 0.06);
    assert.equal(r.text, valueText(183 + (1800 % 700), 63 + (row % 200)), `row ${row}`);
  }
});

test('a point just inside any edge or corner of a cell reads that cell, where the pixel under it often does not', async () => {
  // the same nearest-neighbour fake tiles; mean carries the column, SD the row
  const cellOfPixel = (x, px, y, py) => [Math.floor((y * 256 + py + 0.5) * 1800 / 2048), Math.floor((x * 256 + px + 0.5) * 3600 / 4096)];
  const pixel = (url, px, py) => {
    const [, x, y] = url.match(/value\/(\d+)\/(\d+)\.png/).map(Number);
    const [row, col] = cellOfPixel(x, px, y, py);
    return enc(183 + (col % 700), 63 + (row % 200));
  };
  const h = harness({ pixel });
  h.layer.enable();
  await h.layer.update();
  const D = 0.049; // inside the cell: its edges are 0.05° from the centre
  const offsets = [[D, 0], [-D, 0], [0, D], [0, -D], [D, D], [D, -D], [-D, D], [-D, -D]];
  const cells = [];
  for (let col = 0; col < 3600; col += 7) cells.push([899, col]);
  for (let row = 0; row < 1800; row += 7) cells.push([row, 1800]);
  cells.push([0, 0], [0, 3599], [1799, 0], [1799, 3599]);
  let pixelUnderPointWrong = 0, n = 0;
  for (const [row, col] of cells) {
    const [clat, clon] = [89.95 - row * 0.1, -179.95 + col * 0.1];
    for (const [dlat, dlon] of offsets) {
      const lat = clat + dlat, lon = clon + dlon;
      const r = await h.layer.readoutAt(lat, lon);
      assert.equal(r.text, valueText(183 + (col % 700), 63 + (row % 200)), `cell ${row},${col} at ${dlat},${dlon}`);
      // the control: the pixel under the point itself, which a readout without the snap to the cell would read
      const t = geoTilePixel(lat, lon, 3);
      const [pr, pc] = cellOfPixel(t.x, t.px, t.y, t.py);
      if (pr !== row || pc !== col) pixelUnderPointWrong += 1;
      n += 1;
    }
  }
  assert.ok(pixelUnderPointWrong > n / 4, `the points discriminate: the pixel under the point is another cell for ${pixelUnderPointWrong} of ${n}`);
});

test('legend: the stops in their bin colours, then the unit and what kind of number this is', async () => {
  const { layer } = harness();
  assert.equal(layer.getRowControls().legend.length, 1, 'before the manifest: the note only');
  await layer.update();
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, -1).map((e) => e.label), LEGEND_STOPS.map(String));
  assert.deepEqual(LEGEND_STOPS, [200, 400, 600, 800]);
  // 200 is in bin 6 ([200, 210)), 800 in bin 66
  assert.equal(legend[0].color, `rgb(${PALETTE[6].join(',')})`);
  assert.equal(legend[3].color, `rgb(${PALETTE[66].join(',')})`);
  assert.deepEqual([binOf(150, MANIFEST.display), binOf(159, MANIFEST.display), binOf(160, MANIFEST.display), binOf(899, MANIFEST.display), binOf(900, MANIFEST.display)], [1, 1, 2, 75, 75]);
  const note = legend.at(-1).label;
  for (const part of [/sequence variants per soil sample/, /7,500 sequencing reads/, /0\.1° cells/, /320 sampled locations/, /R² 0\.41/, /not a survey/, /ice sheet are model extrapolation with no soil samples behind them/, /Antarctica is blank/, /Bickel et al\. 2026/, /CC BY 4\.0/])
    assert.match(note, part);
  assert.equal(legend.at(-1).color, 'transparent');
});

test('credit: the maps, the paper, the licence and what was changed, as CC BY asks', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'soil-bacteria');
  assert.ok(credit, 'DATA_CREDITS has a soil-bacteria entry');
  assert.match(credit.html, /Bickel/);
  assert.match(credit.html, /doi\.org\/10\.5281\/zenodo\.21133869/);
  assert.match(credit.html, /doi\.org\/10\.1093\/ismeco\/ycag266/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(credit.html, /Changed: .*whole numbers/);
});
