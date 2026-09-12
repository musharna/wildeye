// src/data/otn.test.mjs — site-series contract: bin selection, station entity, layer contract + observed time + chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binsAt, describeStation, stationEntity, createOtnLayer, WINDOW_WEEKS } from './otn.js';

const weeks = [
  { w: '2025-07-30', n: { 'striped bass': 40, 'atlantic cod': 2 }, a: 5 },
  { w: '2025-07-23', n: { 'atlantic cod': 7 }, a: 2 },
  { w: '2025-01-15', n: { 'striped bass': 1 }, a: 1 },
];

test('binsAt: live = newest window of the record; instant = the 7-day bin containing it; none outside', () => {
  const live = binsAt(weeks, null, '2025-07-30');
  assert.deepEqual(live.bins.map((b) => b.w), ['2025-07-30', '2025-07-23'], 'the January bin is outside the live window');
  assert.match(live.label, new RegExp(`last ${WINDOW_WEEKS} weeks to 2025-07-30`));
  assert.deepEqual(binsAt(weeks, '2025-07-24T00:00:00Z', '2025-07-30').bins.map((b) => b.w), ['2025-07-30'], 'w−6 d is inside the bin');
  assert.deepEqual(binsAt(weeks, '2025-07-23T23:00:00Z', '2025-07-30').bins.map((b) => b.w), ['2025-07-23'], 'w−7 d belongs to the previous bin');
  const none = binsAt(weeks, '2026-09-01T00:00:00Z', '2025-07-30');
  assert.equal(none.bins.length, 0);
  assert.match(none.label, /no public detections in the week of 2026-09-01/);
  assert.equal(binsAt(weeks, 'garbage', '2025-07-30').bins.length, 0);
  assert.equal(binsAt(undefined, null, null).bins.length, 0);
});

test('describeStation escapes, lists species by count, carries the citation and the fixed-receiver caveat', () => {
  const p = { station: '<S1>', project: 'P', sci: { 'striped bass': 'Morone saxatilis' } };
  const scope = binsAt(weeks, null, '2025-07-30');
  const html = describeStation(p, scope, { n: { 'striped bass': 41, 'atlantic cod': 9 }, total: 50, animals: 5 }, { project_name: 'Proj', project_citation: 'Cite & me', project_infourl: 'https://u' }, { name: 'OTN', licence: 'CC BY 4.0' });
  assert.match(html, /&lt;S1&gt;.*Proj.*50 detections.*5 tagged animals.*striped bass <i>Morone saxatilis<\/i>: 41.*atlantic cod.*: 9.*fixed receiver.*Cite &amp; me.*https:\/\/u.*CC BY 4\.0/s);
});

test('stationEntity: size grows with detections, colour = dominant visible species, fades when nothing in scope', () => {
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [-63, 44] }, properties: { station: 'S1', project: 'P', weeks } };
  const ctx = { dataEnd: '2025-07-30', visible: {}, species: ['striped bass', 'atlantic cod'], projects: {}, source: {} };
  const live = stationEntity(f, 0, null, ctx);
  assert.equal(live.id, 'otn:0');
  assert.equal(live.properties.total, 49);
  assert.equal(live.properties.dominant, 'striped bass');
  assert.equal(live.point.color.alpha, 1);
  const codOnly = stationEntity(f, 0, null, { ...ctx, visible: { 'striped bass': false } });
  assert.equal(codOnly.properties.total, 9);
  assert.equal(codOnly.properties.dominant, 'atlantic cod');
  assert.ok(codOnly.point.pixelSize < live.point.pixelSize);
  const empty = stationEntity(f, 0, '2026-09-01T00:00:00Z', ctx);
  assert.equal(empty.properties.total, 0);
  assert.ok(empty.point.color.alpha < 0.3, 'nothing heard that week → faded');
});

test('layer: contract, live window, observed-time bin, chips hide species, legend counts, analyst records', async () => {
  const gj = {
    type: 'FeatureCollection', data_end: '2025-07-30', species: ['atlantic cod', 'striped bass'], projects: { P: { project_name: 'Proj', project_citation: 'C' } }, source: { name: 'OTN', licence: 'CC BY 4.0' },
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-63, 44] }, properties: { station: 'S1', project: 'P', weeks } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-62, 45] }, properties: { station: 'S2', project: 'P', weeks: [{ w: '2025-01-15', n: { 'atlantic cod': 3 }, a: 1 }] } },
    ],
  };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createOtnLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setParams', 'getParams', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 2);
    assert.equal(l.getStats().active, 1, 'S2 only has a January bin, outside the live window');
    let rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.label), ['ATLANTIC COD', 'STRIPED BASS']);
    assert.equal(rc.legend.find((i) => i.label === 'striped bass').count, 1);
    assert.match(rc.legend.at(-1).label, /ends 2025-07-30/);
    // the week of 2025-07-23: cod dominates S1
    assert.equal(l.setObservedTime('2025-07-20T12:00:00Z'), true);
    assert.equal(ds.entities.getById('otn:0').properties.dominant.getValue(), 'atlantic cod');
    assert.equal(l.getRowControls().legend.find((i) => i.label === 'atlantic cod').count, 1);
    // January week: S2 active, S1 active (1 bass)
    l.setObservedTime('2025-01-12T00:00:00Z');
    assert.equal(l.getStats().active, 2);
    assert.equal(l.setParams({ 'striped bass': false }), true);
    assert.equal(l.getStats().active, 1, 'hiding bass empties S1 that week');
    assert.equal(l.getRowControls().legend.some((i) => i.label === 'striped bass'), false, 'hidden species leaves the legend');
    assert.equal(l.setParams({ 'striped bass': false }), false);
    assert.equal(l.setObservedTime('bad'), false);
    assert.equal(l.setObservedTime(null), true);
    l.enable();
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].detections, 9, 'bass hidden → cod only');
  } finally { globalThis.fetch = saved; }
});
