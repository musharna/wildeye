// src/data/drought.test.mjs — polygon contract: USDM classes/palette, release selection by observed time,
// info box credit line, layer contract incl. MultiPolygon parts, legend areas, analyst records.
// Mutants verified (each failed the named test before acceptance):
//  - releaseAt: `t >= released` → `t > released` → 'releaseAt' fails (release-day instant must select that release)
//  - releaseAt: `ws.find` over reversed order (oldest first) → 'releaseAt' fails (must be the NEWEST ≤ instant)
//  - DROUGHT_CLASSES d3 color '#E60000' → '#E70000' → 'classes' fails
//  - rebuild: `f.properties?.w === scope.week.w` → `!==` → 'layer' entity count fails
//  - categoryEntities: zIndex `cls.dm + 1` → `1` → 'layer' zIndex fails
//  - getAnalystRecords: part filter removed → 'layer' records length fails
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DROUGHT_CLASSES, droughtClass, releaseAt, describeCategory, categoryEntities, createDroughtLayer } from './drought.js';

const weeks = [
  { w: '2026-09-08', released: '2026-09-10' },
  { w: '2026-09-01', released: '2026-09-03' },
  { w: '2026-08-25', released: '2026-08-27' },
];
const CREDIT = 'The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC.';

test('classes: official USDM palette D0–D4, unknown category → null', () => {
  assert.deepEqual(DROUGHT_CLASSES.map((c) => c.color), ['#FFFF00', '#FCD37F', '#FFAA00', '#E60000', '#730000']);
  assert.deepEqual([0, 1, 2, 3, 4].map((d) => droughtClass(d).key), ['d0', 'd1', 'd2', 'd3', 'd4']);
  assert.equal(droughtClass('3').label, 'D3 extreme drought', 'string dm from entity properties works');
  assert.equal(droughtClass(5), null);
  assert.equal(droughtClass(undefined), null);
});

test('releaseAt: live = newest; observed = newest release whose Thursday ≤ instant; none before the oldest', () => {
  assert.equal(releaseAt(weeks, null).week.w, '2026-09-08');
  assert.match(releaseAt(weeks, null).label, /newest release, map of 2026-09-08/);
  assert.equal(releaseAt(weeks, '2026-09-12T12:00:00Z').week.w, '2026-09-08');
  assert.equal(releaseAt(weeks, '2026-09-10T00:00:00Z').week.w, '2026-09-08', 'release-day instant selects that release');
  assert.equal(releaseAt(weeks, '2026-09-09T23:59:59Z').week.w, '2026-09-01', 'the Wednesday before a release still shows the previous map');
  assert.equal(releaseAt(weeks, '2026-09-04T00:00:00Z').week.w, '2026-09-01');
  assert.match(releaseAt(weeks, '2026-09-04T00:00:00Z').label, /map of 2026-09-01 \(released 2026-09-03\)/);
  assert.equal(releaseAt(weeks, '2026-08-20T00:00:00Z').week, null);
  assert.match(releaseAt(weeks, '2026-08-20T00:00:00Z').label, /no release stored before 2026-08-20/);
  assert.equal(releaseAt(weeks, 'bad').week, null);
  assert.equal(releaseAt([], null).week, null);
});

test('describeCategory carries category, area, scope and the verbatim credit line', () => {
  const html = describeCategory({ dm: 2, area_km2: 123456.7, parts: 3 }, releaseAt(weeks, null), { credit: CREDIT, url: 'https://droughtmonitor.unl.edu/', name: 'U.S. Drought Monitor' });
  assert.match(html, /<b>D2 severe drought<\/b>.*newest release, map of 2026-09-08.*123,457 km².*3 areas drawn.*jointly produced by the National Drought Mitigation Center.*Map courtesy of NDMC\..*href="https:\/\/droughtmonitor\.unl\.edu\/"/s);
  assert.match(describeCategory({ dm: 4, area_km2: 10, parts: 1 }, releaseAt(weeks, null)), /1 area drawn/);
  assert.doesNotMatch(html, /<script/);
});

test('layer: contract, one release at a time, MultiPolygon parts, zIndex by severity, legend areas, records', async () => {
  const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  const feat = (w, released, dm, coords, area) => ({ type: 'Feature', geometry: { type: coords.length > 1 ? 'MultiPolygon' : 'Polygon', coordinates: coords.length > 1 ? coords : coords[0] }, properties: { w, released, dm, label: `D${dm}`, area_km2: area, parts: coords.length } });
  const gj = { type: 'FeatureCollection', today: '2026-09-12', newest: '2026-09-08', weeks, source: { credit: CREDIT, url: 'https://droughtmonitor.unl.edu/' }, features: [
    feat('2026-09-08', '2026-09-10', 0, [poly, poly], 500),
    feat('2026-09-08', '2026-09-10', 4, [poly], 20),
    feat('2026-09-01', '2026-09-03', 0, [poly, poly, poly], 700),
    feat('2026-09-01', '2026-09-03', 1, [poly], 300),
    feat('2026-08-25', '2026-08-27', 2, [poly], 100),
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createDroughtLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime', 'setRowControlsListener']) assert.equal(typeof l[k], 'function');
    assert.equal(l.name, 'Drought (U.S. Drought Monitor)');
    assert.equal(l.icon, '🌵');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 3, 'newest week only: D0 has 2 parts + D4 has 1');
    assert.ok(ds.entities.getById('drought:2026-09-08:d0:1'));
    assert.equal(ds.entities.getById('drought:2026-09-08:d4:0').polygon.zIndex.getValue(), 5);
    assert.equal(ds.entities.getById('drought:2026-09-08:d0:0').polygon.zIndex.getValue(), 1);
    assert.equal(ds.entities.getById('drought:2026-09-08:d4:0').polygon.material.getValue().color.toCssHexString().toUpperCase(), '#7300008C');
    const st = l.getStats();
    assert.equal(st.error, null);
    assert.equal(st.count, 5);
    assert.deepEqual(st.classes, { d0: 500, d4: 20 }, 'area counted once per feature, not per part');
    assert.match(st.scope, /newest release/);

    assert.equal(l.setObservedTime('2026-09-05T00:00:00Z'), true);
    assert.equal(ds.entities.values.length, 4, 'previous week: D0 3 parts + D1');
    assert.deepEqual(l.getStats().classes, { d0: 700, d1: 300 });
    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => i.label.startsWith('D1')).count, 300);
    assert.equal(legend.find((i) => i.label.startsWith('D4')).count, 0);
    assert.match(legend.at(-1).label, /map of 2026-09-01 \(released 2026-09-03\)/);
    assert.equal(l.setObservedTime('2026-08-01T00:00:00Z'), true);
    assert.equal(ds.entities.values.length, 0, 'no release before the oldest stored');
    assert.equal(l.setObservedTime('bad'), false);

    assert.equal(l.getAnalystRecords().length, 0, 'hidden layer reports nothing');
    l.enable();
    assert.equal(l.setObservedTime(null), true);
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 2, 'one record per category, not per part');
    assert.deepEqual(recs.map((r) => [r.cls, r.area_km2, r.week]), [['d0', 500, '2026-09-08'], ['d4', 20, '2026-09-08']]);
    assert.match(l.getRowControls().legend.at(-1).label, /valid on a Tuesday/);
    l.destroy({ dataSources: { remove() {} } });
    assert.equal(l.getStats().count, 0);
  } finally { globalThis.fetch = saved; }
});

test('layer: malformed file (no weeks) is an error, not a crash', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) });
  try {
    const l = createDroughtLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /Malformed/);
  } finally { globalThis.fetch = saved; }
});
