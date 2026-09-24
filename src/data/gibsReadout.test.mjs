import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tilePixel, decodePixel, formatValue, gibsTileRequest, createTilePixelReader } from './gibsReadout.js';

// Real tables from the live pipeline (fixtures/gibs-readout.json), not hand-written ones: a fixture
// encodes a belief, and GIBS's own tables are what the site will decode.
const { layers } = JSON.parse(readFileSync(new URL('./fixtures/gibs-readout.json', import.meta.url)));
const lc = layers['gibs-landcover'], evi = layers['gibs-evi'], lst = layers['gibs-lst'], gedi = layers['gibs-biomass'];

test('tile math matches the Python probe: Chicago at z8; longitude wraps; beyond the mercator limit is null', () => {
  assert.deepEqual(tilePixel(41.88, -87.63, 8), { x: 65, y: 95, px: 175, py: 37 });
  assert.deepEqual(tilePixel(0, 180, 2), tilePixel(0, -180, 2));
  assert.deepEqual(tilePixel(10, 370, 4), tilePixel(10, 10, 4));
  assert.equal(tilePixel(86, 0, 5), null);
  assert.equal(tilePixel(-86, 0, 5), null);
  assert.notEqual(tilePixel(85, 0, 5), null); // positive control just inside the limit
});

test('a class pixel decodes to its NASA label', () => {
  assert.deepEqual(decodePixel(lc, [49, 204, 49, 255]), { kind: 'class', label: 'Evergreen Broadleaf Forests' });
});

test('a ramp pixel decodes to its interval and a midpoint text at the table\'s precision', () => {
  const rgb = evi.decode.find((e) => e[3] === 0.4251).slice(0, 3);
  assert.deepEqual(decodePixel(evi, [...rgb, 255]), { kind: 'value', lo: 0.4251, hi: 0.4326, text: '0.429' });
  const g = gedi.decode.find((e) => e[3] === 12).slice(0, 3);
  // Final review I1: at 0 dp the midpoint 12.5 rounded to 13, a value its own bin [12,13) excludes. The shown
  // value must lie inside its bin for every table, so precision comes from the half-width.
  assert.equal(decodePixel(gedi, [...g, 255]).text, '12.5 Mg ha-1');
  for (const e of [evi, lst, gedi]) for (const [, , , lo, hi] of e.decode) {
    const text = formatValue({ ...e, ramp: { ...e.ramp, unit: '' } }, lo, hi); // '' unit: LST stays in K, comparable to the bin
    if (/^[≥<]| – /.test(text)) continue; // wide/open bins read as bounds (next test)
    const shown = Number.parseFloat(text);
    assert.ok(shown >= lo && shown < hi, `${e.gibsId} [${lo},${hi}) shown as ${shown}`);
  }
});

test('LST reads in °C with one decimal', () => {
  assert.equal(formatValue(lst, 298.4, 299.0), '25.6 °C');
});

test('an open-ended or wide bin reads as a bound, never a made-up midpoint', () => {
  assert.equal(formatValue(lst, 350.02, 652.0), '≥ 76.9 °C'); // last bin, 500× the median width
  assert.equal(formatValue(lst, 0.02, 200.0), '< -73.1 °C'); // first bin
  assert.equal(formatValue(gedi, 250, null), '≥ 250.0 Mg ha-1'); // null = open end (pipeline)
  assert.equal(formatValue(evi, -0.0999, 0.0001), '-0.100 – 0.000'); // wide, not at an end
  assert.equal(formatValue(evi, 0.4251, 0.4326), '0.429'); // positive control: a normal bin is a midpoint
});

test('a transparent pixel is no data; an unknown colour is named, never snapped', () => {
  assert.equal(decodePixel(evi, [0, 26, 105, 0]).kind, 'nodata');
  assert.equal(decodePixel(lc, [0, 0, 0, 0]).kind, 'nodata');
  assert.deepEqual(decodePixel(evi, [1, 2, 3, 255]), { kind: 'unknown', rgb: [1, 2, 3] });
  assert.equal(decodePixel(evi, [0, 0, 1, 255]).kind, 'value'); // positive control
});

test('a tile request fills the template at the layer\'s maximum level', () => {
  const r = gibsTileRequest('https://g/L/default/2024-01-01/M/{z}/{y}/{x}.png', 8, 41.88, -87.63);
  assert.deepEqual(r, { url: 'https://g/L/default/2024-01-01/M/8/95/65.png', px: 175, py: 37 });
  assert.equal(gibsTileRequest('t/{z}/{y}/{x}', 8, 89, 0), null);
});

test('the tile reader fetches a tile once, returns the pixel and layer-time-actual, and does not cache a failure', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('bad')) return { ok: false, status: 404, headers: new Map() };
    return { ok: true, status: 200, headers: new Map([['layer-time-actual', '2024-01-01T00:00:00Z']]), blob: async () => url };
  };
  // a 2×1 image: pixel (1,0) is 9,8,7,255
  const decodeImage = async () => ({ width: 2, data: new Uint8ClampedArray([1, 2, 3, 4, 9, 8, 7, 255]) });
  const read = createTilePixelReader({ fetchImpl, decodeImage });
  assert.deepEqual(await read('good', 1, 0), { rgba: [9, 8, 7, 255], timeActual: '2024-01-01' });
  assert.deepEqual((await read('good', 0, 0)).rgba, [1, 2, 3, 4]);
  assert.equal(calls.filter((u) => u === 'good').length, 1);
  await assert.rejects(read('bad', 0, 0), /GIBS tile HTTP 404/);
  await assert.rejects(read('bad', 0, 0), /GIBS tile HTTP 404/);
  assert.equal(calls.filter((u) => u === 'bad').length, 2);
});
