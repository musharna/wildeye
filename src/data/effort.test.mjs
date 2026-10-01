// src/data/effort.test.mjs — the RECORDING EFFORT layer: a grey veil from GBIF's counts of every record of the chosen species' class.
// Spec: docs/superpowers/specs/2026-09-30-effort-layer-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  effortNote, effortClassName, createEffortLayer, cellRecords, cellAreaKm2, veilAlpha, veilProvider, EFFORT_ZRANK, EFFORT_ALPHA, EFFORT_CREDIT,
  EFFORT_CELLS, EFFORT_MAX_LEVEL, EFFORT_SPARSE_PER_KM2, EFFORT_CLEAR_PER_KM2, VEIL_NONE, VEIL_SPARSE,
} from './effort.js';
import { MODELED_ZRANK } from './modeledRange.js';
import { SPECIES_ZRANK, TILE_FAILURE_LIMIT } from './species.js';

const NOW = new Date('2026-09-30T12:00:00Z');

test('effortClassName: a geomodel collection\'s class in plain words, any other class by its GBIF name', () => {
  assert.equal(effortClassName('Arachnida'), 'spiders and other arachnids');
  assert.equal(effortClassName('Aves'), 'birds');
  assert.equal(effortClassName('Insecta'), 'insects');
  assert.equal(effortClassName('Magnoliopsida'), 'class Magnoliopsida');
  assert.throws(() => effortClassName(null), /class name/);
});

test('effortNote: says what is counted, from where, over which years, and how to read the shading; every state reads as a sentence', () => {
  const shown = (years) => effortNote({ state: 'shown', className: 'Arachnida', years, now: NOW });
  assert.equal(shown('recent'), 'Darker = fewer records of spiders and other arachnids, darkest = none · GBIF CC0/CC BY, 2017–2026');
  assert.equal(shown('all'), 'Darker = fewer records of spiders and other arachnids, darkest = none · GBIF CC0/CC BY, all years');
  assert.equal(effortNote({ state: 'loading' }), 'Checking for an effort map…');
  assert.equal(effortNote({ state: 'no-class' }), 'No effort map: GBIF lists no class for this species');
  assert.equal(effortNote({ state: 'lookup-failed', error: 'HTTP 503' }), 'No effort map: GBIF lookup failed (HTTP 503)');
  assert.throws(() => effortNote({ state: 'bogus' }), /unknown effort state bogus/);
});

// One real GBIF vector tile: every CC0 / CC BY arachnid record 2017–2026 on z3 x2 y3 (eastern North America; fixtures/README.md).
const FIXTURE = readFileSync(new URL('./fixtures/gbif-arachnida-recent-3-2-3.mvt', import.meta.url));
const fixtureBuffer = () => FIXTURE.buffer.slice(FIXTURE.byteOffset, FIXTURE.byteOffset + FIXTURE.byteLength);
// 224,697 records in 388 features, of which 96 features (54,096 records) sit in the tile's edge buffer: copies of the neighbours' cells,
// clipped (the 4,671-record cell at y -64..-49 here is whole at y 943..975 in z3 x2 y2, fetched 2026-10-01). Each neighbour counts its own.
const FIXTURE_INSIDE = 170601;
const cellAt = (cells, px, py) => cells[Math.floor(py / (512 / EFFORT_CELLS)) * EFFORT_CELLS + Math.floor(px / (512 / EFFORT_CELLS))];

test('cellRecords: every record in the tile lands in exactly one cell of an even grid, by where its feature sits', async () => {
  const cells = await cellRecords(fixtureBuffer());
  assert.equal(cells.length, EFFORT_CELLS * EFFORT_CELLS);
  assert.equal(cells.reduce((a, b) => a + b, 0), FIXTURE_INSIDE, 'every record of the tile itself, none of the neighbours\' copies');
  // GBIF's own hexagons (bin=hex, 40 a tile) left these Appalachian places empty although each has records within 0.15°
  // (9, 7, 111 and 5, occurrence search 2026-10-01): the veil drew them as unrecorded ground. Counts put them in recorded cells.
  for (const [px, py] of [[70, 69], [64, 56], [81, 86], [108, 48]]) assert.ok(cellAt(cells, px, py) > 0, `cell at ${px},${py}`);
  assert.equal(cellAt(cells, 480, 480), 0, 'open Atlantic south-east of Bermuda: none (positive control for the zero path)');
  assert.deepEqual([...await cellRecords(null)], new Array(EFFORT_CELLS ** 2).fill(0), 'GBIF answers an empty tile with 204 and no body');
  assert.deepEqual([...await cellRecords(new ArrayBuffer(0))], new Array(EFFORT_CELLS ** 2).fill(0));
});

test('cellAreaKm2: a cell\'s ground area halves its side each level and shrinks with cos² of its latitude', () => {
  const side = 40075.016686 / EFFORT_CELLS;
  // level 1, the cell touching the equator from the north: centre latitude a hair north of 0
  const equator = cellAreaKm2({ level: 1, tileY: 0, row: EFFORT_CELLS - 1 });
  assert.ok(Math.abs(equator / ((side / 2) ** 2) - 1) < 0.02, `${equator}`);
  assert.ok(Math.abs(cellAreaKm2({ level: 2, tileY: 1, row: EFFORT_CELLS - 1 }) / equator - 0.25) < 0.02, 'a level in: a quarter');
  // the row whose centre is 60°N: a quarter of an equator cell at the same level
  const lat = (level, tileY, row) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + (row + 0.5) / EFFORT_CELLS)) / 2 ** level))) * 180) / Math.PI;
  let row60 = 0;
  for (let r = 0; r < EFFORT_CELLS; r += 1) if (Math.abs(lat(4, 4, r) - 60) < Math.abs(lat(4, 4, row60) - 60)) row60 = r;
  const ratio = cellAreaKm2({ level: 4, tileY: 4, row: row60 }) / cellAreaKm2({ level: 4, tileY: 7, row: EFFORT_CELLS - 1 });
  assert.ok(Math.abs(ratio - Math.cos((lat(4, 4, row60) * Math.PI) / 180) ** 2) < 0.02, `${ratio} at ${lat(4, 4, row60)}°`);
  assert.throws(() => cellAreaKm2({ level: -1, tileY: 0, row: 0 }), /level/);
  assert.throws(() => cellAreaKm2({ level: 2, tileY: 4, row: 0 }), /tileY/);
});

test('veilAlpha: none is darkest; the shade follows records per km², so the same ground keeps its shade at every level', () => {
  assert.equal(veilAlpha(0, 1000), VEIL_NONE);
  assert.ok(VEIL_SPARSE < VEIL_NONE, 'one record is lighter than none');
  assert.equal(veilAlpha(1, 1e9), VEIL_SPARSE, 'sparser than EFFORT_SPARSE_PER_KM2: the sparse shade, never none');
  assert.equal(veilAlpha(EFFORT_SPARSE_PER_KM2 * 1000, 1000), VEIL_SPARSE);
  assert.equal(veilAlpha(EFFORT_CLEAR_PER_KM2 * 1000, 1000), 0, 'from EFFORT_CLEAR_PER_KM2: clear');
  assert.equal(veilAlpha(1e9, 1), 0);
  let last = VEIL_SPARSE;
  for (let d = EFFORT_SPARSE_PER_KM2; d <= EFFORT_CLEAR_PER_KM2; d *= 2) {
    const a = veilAlpha(d * 500, 500);
    assert.ok(a <= last, `denser is lighter: ${d}/km² → ${a}`);
    last = a;
  }
  // a cell of 400 records over 40,000 km², then the same ground a level in: four cells of a quarter the area, 100 records each
  assert.ok(Math.abs(veilAlpha(400, 40000) - veilAlpha(100, 10000)) < 1e-12);
  assert.ok(veilAlpha(10, 40000) > veilAlpha(10, 10000), 'the same count on less ground is denser, so lighter');
  for (const bad of [-1, NaN, Infinity]) assert.throws(() => veilAlpha(bad, 1000), /records/);
  for (const bad of [0, -5, NaN]) assert.throws(() => veilAlpha(1, bad), /area/);
});

test('veilProvider: each tile is GBIF\'s counts drawn as grey cells; a throttled request and a failure pass through untouched', async () => {
  const fills = [];
  const canvas = () => ({
    width: 0, height: 0,
    getContext: () => {
      const ctx = { fillStyle: null, fillRect: (x, y, w, h) => fills.push({ x, y, w, h, style: ctx.fillStyle }) };
      return ctx;
    },
  });
  const asked = [];
  const answers = [() => Promise.resolve(fixtureBuffer()), () => undefined, () => Promise.reject(new Error('HTTP 503')), () => Promise.resolve(undefined)];
  const base = { tileWidth: 512, tileHeight: 512, errorEvent: {} };
  const template = 'https://api.gbif.org/v2/map/occurrence/adhoc/{z}/{x}/{y}.mvt?taxonKey=367';
  const veiled = veilProvider(base, template, { fetchTile: (url, request) => { asked.push({ url, request }); return answers.shift()(); }, createCanvas: canvas });
  assert.equal(veiled, base, 'the same provider object, so its error events still fire');
  const request = { id: 'r1' };
  const image = await veiled.requestImage(2, 3, 3, request);
  assert.deepEqual(asked[0], { url: 'https://api.gbif.org/v2/map/occurrence/adhoc/3/2/3.mvt?taxonKey=367', request }, 'Cesium\'s request rides along, so its throttle applies');
  assert.equal(image.width, 512);
  assert.equal(fills.length, EFFORT_CELLS ** 2, 'every cell drawn, the empty ones darkest');
  const size = 512 / EFFORT_CELLS;
  assert.ok(fills.every((f) => f.w === size && f.h === size && f.x % size === 0 && f.y % size === 0), 'an even grid with no seams');
  const alphaOf = (px, py) => Number(fills.find((f) => f.x === Math.floor(px / size) * size && f.y === Math.floor(py / size) * size).style.match(/rgba\(24, 24, 24, ([\d.]+)\)/)[1]);
  const cells = await cellRecords(fixtureBuffer());
  for (const [px, py] of [[70, 69], [480, 480]]) {
    const row = Math.floor(py / size);
    const expected = veilAlpha(cellAt(cells, px, py), cellAreaKm2({ level: 3, tileY: 3, row }));
    assert.ok(Math.abs(alphaOf(px, py) - expected) < 0.001, `${px},${py}: ${alphaOf(px, py)} vs ${expected}`);
  }
  assert.equal(alphaOf(480, 480), VEIL_NONE);
  assert.ok(alphaOf(70, 69) < VEIL_SPARSE, 'Appalachia, recorded: lighter than the sparse shade');
  assert.equal(veiled.requestImage(0, 0, 0, request), undefined, 'undefined = throttled by Cesium, try again later');
  await assert.rejects(veiled.requestImage(0, 0, 0, request), /HTTP 503/, 'a failed tile still reaches the error event');
  fills.length = 0;
  await veiled.requestImage(0, 0, 5, request);
  assert.equal(fills.length, EFFORT_CELLS ** 2);
  assert.ok(fills.every((f) => f.style === `rgba(24, 24, 24, ${VEIL_NONE})`), '204 with no body: all none');
  assert.throws(() => veilProvider(base, 'https://example.org/{z}/{x}.mvt'), /template/);
});

function rig() {
  const providers = [];
  const stacked = [];
  const layer = createEffortLayer({
    providerFor: (url, options) => {
      const fns = [];
      const provider = { url, options, errorEvent: { addEventListener: (fn) => fns.push(fn) }, fail: (error) => fns.forEach((fn) => fn({ error })) };
      providers.push(provider);
      return provider;
    },
    imageryLayerFor: (provider, options) => ({ provider, ...options }),
    stack: (layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
    veil: (provider) => provider,
    now: () => NOW,
  });
  const viewer = { imageryLayers: { list: [], add(l) { this.list.push(l); }, remove(l) { this.list = this.list.filter((x) => x !== l); } } };
  layer.init(viewer);
  return { layer, providers, stacked, viewer };
}

test('effort layer: off asks for nothing; on draws the class\'s tiles under the modeled range and the species records', () => {
  const { layer, providers, stacked, viewer } = rig();
  layer.setTaxon({ classKey: 367, className: 'Arachnida' });
  assert.equal(providers.length, 0, 'off by default: no provider, no tiles');
  assert.equal(viewer.imageryLayers.list.length, 0);
  layer.setEnabled(true);
  assert.equal(providers.length, 1);
  const url = new URL(providers[0].url.replace('{z}/{x}/{y}', '0/0/0'));
  assert.equal(url.searchParams.get('taxonKey'), '367');
  assert.equal(url.searchParams.get('year'), '2017,2026', 'the species map\'s default years');
  assert.equal(providers[0].options.credit, EFFORT_CREDIT);
  // past level 7 Cesium enlarges level-7 tiles: cells stay about 20 km, coarse enough to read as effort rather than single records
  assert.equal(EFFORT_MAX_LEVEL, 7);
  assert.equal(providers[0].options.maximumLevel, EFFORT_MAX_LEVEL);
  assert.equal(viewer.imageryLayers.list.length, 1);
  assert.equal(viewer.imageryLayers.list[0].alpha, EFFORT_ALPHA);
  assert.ok(EFFORT_ZRANK < MODELED_ZRANK && MODELED_ZRANK < SPECIES_ZRANK, 'effort under the modeled range, under the records');
  assert.deepEqual(stacked.at(-1), { id: 'effort', imagery: viewer.imageryLayers.list[0], zrank: EFFORT_ZRANK });
  layer.setEnabled(false);
  assert.equal(viewer.imageryLayers.list.length, 0, 'off removes the layer');
});

test('effort layer: a change of years redraws in the new years while on, and only remembers them while off', () => {
  const { layer, providers } = rig();
  layer.setTaxon({ classKey: 212, className: 'Aves' });
  layer.setYears('all');
  assert.equal(providers.length, 0);
  layer.setEnabled(true);
  assert.equal(new URL(providers[0].url.replace('{z}/{x}/{y}', '0/0/0')).searchParams.has('year'), false);
  layer.setYears('recent');
  assert.equal(providers.length, 2);
  assert.equal(new URL(providers[1].url.replace('{z}/{x}/{y}', '0/0/0')).searchParams.get('year'), '2017,2026');
  assert.equal(layer.getStatus().years, 'recent');
  assert.throws(() => layer.setYears('decade'), /years/);
});

test('effort layer: a new species switches it off; no species, nothing to switch on', () => {
  const { layer, viewer } = rig();
  layer.setTaxon({ classKey: 367, className: 'Arachnida' });
  layer.setEnabled(true);
  layer.setTaxon({ classKey: 212, className: 'Aves' });
  assert.equal(layer.isEnabled(), false);
  assert.equal(viewer.imageryLayers.list.length, 0);
  layer.setTaxon(null);
  layer.setEnabled(true);
  assert.equal(layer.isEnabled(), false);
});

test('effort layer: the first failing tile is said, since an undrawn patch would read as well recorded; a redraw clears it', () => {
  const { layer, providers } = rig();
  let notified = 0;
  layer.onStatus(() => { notified += 1; });
  layer.setTaxon({ classKey: 367, className: 'Arachnida' });
  layer.setEnabled(true);
  providers[0].fail(new Error('not a request error'));
  assert.equal(layer.getStatus().error, null, 'only a tile request failing counts');
  providers[0].fail(new Cesium.RequestErrorEvent(500));
  assert.equal(layer.getStatus().error, 'effort map tiles failing: clear patches may be missing data');
  assert.ok(notified > 0);
  layer.setYears('all');
  assert.equal(layer.getStatus().error, null);
  // an old provider's failures do not count against the new one
  for (let i = 0; i < TILE_FAILURE_LIMIT; i += 1) providers[0].fail(new Cesium.RequestErrorEvent(500));
  assert.equal(layer.getStatus().error, null);
});
