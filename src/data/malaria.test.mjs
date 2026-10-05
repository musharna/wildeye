// src/data/malaria.test.mjs — the MAP malaria layer: years on the time bar, the GetFeatureInfo request, MAP's answers, drape, readout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  CELL_DEG,
  MAP_EXTENT,
  MAX_LEVEL,
  MAP_LAYER,
  MAP_STYLE,
  NO_ESTIMATE,
  TILE_FAILURE_LIMIT,
  YEARS,
  createMalariaLayer,
  estimateText,
  featureInfoUrl,
  pct,
  readEstimate,
  timeOf,
  yearAt,
} from './malaria.js';

// Verbatim GetFeatureInfo answers from MAP's GeoServer (2026-10-03), at 1/24° cell centres; each value equals the one
// read from a WCS GetCoverage GeoTIFF of the same cell with rasterio, a different service operation.
const { responses: R } = JSON.parse(readFileSync(new URL('./fixtures/map-featureinfo.json', import.meta.url)));

test('years: live shows 2025, a scrub shows the year at or before it, before 2000 there is none', () => {
  assert.deepEqual([YEARS[0], YEARS.at(-1), YEARS.length], [2000, 2025, 26]);
  assert.equal(yearAt(null), 2025);
  assert.equal(yearAt('2015-07-01T00:00:00Z'), 2015);
  assert.equal(yearAt('2030-01-01T00:00:00Z'), 2025);
  assert.equal(yearAt('2000-01-01T00:00:00Z'), 2000);
  assert.equal(yearAt('1999-12-31T23:00:00Z'), null);
  assert.throws(() => yearAt('not a date'), RangeError);
  assert.equal(timeOf(2015), '2015-01-01T00:00:00.000Z'); // as the capabilities list it
});

test('the GetFeatureInfo request is WMS 1.1.1 with a lon,lat bbox centred on the point, read at the centre pixel', () => {
  // WMS 1.3.0 + EPSG:4326 orders the bbox lat,lon: a probe written that way read 10°N 0°E for 0°N 10°E
  const u = new URL(featureInfoUrl(-13.4791667, 33.4791667, 2010));
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.version, '1.1.1');
  assert.equal(q.srs, 'EPSG:4326');
  const [minx, miny, maxx, maxy] = q.bbox.split(',').map(Number);
  assert.ok(Math.abs((minx + maxx) / 2 - 33.4791667) < 1e-9, 'bbox x is longitude');
  assert.ok(Math.abs((miny + maxy) / 2 - -13.4791667) < 1e-9, 'bbox y is latitude');
  assert.deepEqual([q.width, q.height, q.x, q.y], ['3', '3', '1', '1']);
  assert.equal(q.layers, MAP_LAYER);
  assert.equal(q.query_layers, MAP_LAYER);
  assert.equal(q.info_format, 'application/json');
  assert.equal(q.time, '2010-01-01T00:00:00.000Z');
});

test("MAP's answers read as a rate with its interval, no estimate, or sparsely populated", () => {
  assert.deepEqual(readEstimate(R['ghana-2025'].json), { kind: 'value', rate: 0.2608685791492462, lci: 0.03156652674078941, uci: 0.687126636505127 });
  assert.equal(estimateText(readEstimate(R['ghana-2025'].json)), '26.1% of children aged 2–10 carry P. falciparum (95% interval 3.2% to 68.7%)');
  assert.equal(readEstimate(R['ghana-2015'].json).rate, 0.6016679406166077);
  assert.equal(pct(readEstimate(R['malawi-2010'].json).rate), '61.0%');
  assert.deepEqual(readEstimate(R['paris-2025'].json), { kind: 'none' });
  // the mask band, not the rate: MAP models 1.9% here but masks the cell as sparsely populated and draws it grey
  assert.deepEqual(readEstimate(R['amazon-masked-2025'].json), { kind: 'sparse' });
  assert.equal(R['amazon-masked-2025'].json.features[1].properties.Data > 0, true);
  // a modelled rate of 3e-8 is not shown as 0.0%
  assert.equal(estimateText(readEstimate(R['manaus-2025'].json)), '< 0.1% of children aged 2–10 carry P. falciparum (95% interval < 0.1% to < 0.1%)');
});

test('a changed answer is an error, never "no malaria"', () => {
  assert.throws(() => readEstimate({ features: [] }), /no Data band/);
  assert.throws(() => readEstimate({ features: [{ properties: { jiffle: 0.2 } }] }), /no Data band/);
  const props = R['ghana-2025'].json.features[1].properties;
  assert.throws(() => readEstimate({ features: [{ properties: { ...props, Data: 12 } }] }), /Data is not a rate: 12/);
  assert.throws(() => readEstimate({ features: [{ properties: { ...props, UCI: null } }] }), /UCI is not a rate/);
  // positive controls: the real answer and the no-estimate code still read
  assert.equal(readEstimate({ features: [{ properties: props }] }).kind, 'value');
  assert.equal(readEstimate({ features: [{ properties: { ...props, Data: NO_ESTIMATE } }] }).kind, 'none');
});

function harness({ answer = R['ghana-2025'].json, status = 200 } = {}) {
  const providers = [], list = [], stacked = [], fetches = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; }, contains: (l) => list.includes(l) } };
  const layer = createMalariaLayer({
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: status === 200, status, json: async () => structuredClone(answer) };
    },
    providerFor: (options) => {
      const listeners = [];
      const p = { options, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: (_layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
  });
  layer.init(viewer);
  return { layer, providers, list, stacked, fetches };
}

test('the drape asks MAP for the shown year, in the release\'s style; a scrub redraws, an unchanged year does not', async () => {
  const { layer, providers, stacked } = harness();
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(providers.length, 1);
  const o = providers[0].options;
  assert.equal(o.layers, MAP_LAYER);
  assert.deepEqual(o.parameters, { format: 'image/png', transparent: true, styles: MAP_STYLE, time: '2025-01-01T00:00:00.000Z' });
  assert.equal(stacked.at(-1).id, 'malaria');
  // tiles are asked for over the release's extent only, down to the level that resolves its grid: a south edge set
  // too far north drew nothing over real estimates with no failed request (review of PR #50)
  assert.ok(o.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.ok(Cesium.Rectangle.equalsEpsilon(o.rectangle, Cesium.Rectangle.fromDegrees(-180, -60, 180, 85), 1e-12));
  assert.deepEqual(MAP_EXTENT, { west: -180, south: -60, east: 180, north: 85 });
  assert.equal(o.maximumLevel, MAX_LEVEL);
  const pixelDeg = (level) => 180 / (256 * 2 ** level); // geographic scheme: 2×1 tiles of 256 px at level 0
  assert.ok(pixelDeg(MAX_LEVEL) < CELL_DEG && pixelDeg(MAX_LEVEL - 1) > CELL_DEG, 'the coarsest level finer than a cell');
  await layer.setObservedTime('2010-06-01T00:00:00Z');
  assert.equal(providers.at(-1).options.parameters.time, '2010-01-01T00:00:00.000Z');
  const n = providers.length;
  await layer.setObservedTime('2010-11-01T00:00:00Z');
  assert.equal(providers.length, n); // still 2010
  assert.equal(layer.getStats().time, '2010');
  const ext = layer.getObservedExtent();
  assert.deepEqual([new Date(ext.startMs).toISOString(), new Date(ext.endMs).toISOString()], ['2000-01-01T00:00:00.000Z', '2025-12-31T23:59:59.999Z']);
});

test('before 2000 the drape hides and says why, the readout is a gap; back in range it shows again', async () => {
  const { layer, list, fetches } = harness();
  layer.enable();
  await layer.update();
  await layer.setObservedTime('1995-01-01T00:00:00Z');
  assert.equal(list.at(-1).show, false);
  assert.match(layer.getStats().error, /no malaria estimate before 2000/);
  assert.equal((await layer.readoutAt(10, 0)).status, 'gap');
  assert.equal(fetches.length, 0);
  await layer.setObservedTime('2003-01-01T00:00:00Z');
  assert.equal(list.at(-1).show, true);
  assert.equal(layer.getStats().error, null);
});

test('the readout asks for the shown year at the point and labels the answer with that year', async () => {
  // a scrubbed year, not the latest: a readout that always asked for 2025 passed when this read at 2025
  const { layer, fetches } = harness({ answer: R['ghana-2015'].json });
  layer.enable();
  await layer.update();
  await layer.setObservedTime('2015-03-01T00:00:00Z');
  const r = await layer.readoutAt(10.0208333, -0.0208333);
  assert.equal(fetches.length, 1);
  assert.equal(new URL(fetches[0]).searchParams.get('time'), '2015-01-01T00:00:00.000Z');
  assert.deepEqual(r, { id: 'malaria', name: layer.name, icon: '🦟', status: 'value', text: '60.2% of children aged 2–10 carry P. falciparum (95% interval 40.1% to 76.8%)', date: '2015' });
  await layer.setObservedTime(null); // positive control: live reads 2025
  await layer.readoutAt(10.0208333, -0.0208333);
  assert.equal(new URL(fetches[1]).searchParams.get('time'), '2025-01-01T00:00:00.000Z');
  assert.equal((await harness({ answer: R['paris-2025'].json }).layer.readoutAt(0, 0)), null); // disabled: nothing read
});

test('no estimate, sparsely populated, a failed request and a changed answer each say so', async () => {
  const read = async (opts) => {
    const h = harness(opts);
    h.layer.enable();
    await h.layer.update();
    return h.layer.readoutAt(1, 1);
  };
  assert.deepEqual(await read({ answer: R['paris-2025'].json }).then((r) => [r.status, r.text, r.date]), ['nodata', null, '2025']);
  assert.equal((await read({ answer: R['amazon-masked-2025'].json })).text, 'Sparsely populated: MAP masks the estimate here');
  const failed = await read({ status: 503 });
  assert.deepEqual([failed.status, failed.error], ['error', 'MAP GetFeatureInfo HTTP 503']);
  const changed = await read({ answer: { features: [] } });
  assert.equal(changed.status, 'error');
  assert.match(changed.error, /no Data band/);
});

test('tile failures surface after the limit and a new year clears them', async () => {
  const { layer, providers } = harness();
  layer.enable();
  await layer.update();
  for (let k = 0; k < TILE_FAILURE_LIMIT - 1; k++) providers[0].fail(new Error('x'));
  assert.equal(layer.getStats().error, null);
  providers[0].fail(new Error('x'));
  assert.equal(layer.getStats().error, 'map tiles failing');
  await layer.setObservedTime('2012-01-01T00:00:00Z');
  assert.equal(layer.getStats().error, null);
  providers[0].fail(new Error('late')); // the old provider's failures no longer count
  assert.equal(layer.getStats().error, null);
});

test('legend: the style\'s six stops, the sparsely populated grey, and a caption', () => {
  const { legend } = createMalariaLayer().getRowControls();
  assert.deepEqual(legend.slice(0, 6).map((l) => [l.label, l.color]), [['0%', '#011959'], ['20%', '#185562'], ['40%', '#577647'], ['60%', '#b38e2f'], ['80%', '#fba689'], ['100%', '#faccfa']]);
  assert.deepEqual([legend[6].label, legend[6].color], ['Sparsely populated (MAP masks the estimate)', '#F0F0F0']);
  assert.match(legend[7].label, /children aged 2–10/);
});
