// src/data/cetaceans.test.mjs — site-series contract: bin selection, sums, station entity, layer contract + observed time + chips.
// Bins shaped from public/data/cetaceans.geojson (PACM live run 2026-09-12): { w, n: {species: days}, m: {…}, e }.
// Mutants seen failing (each named at its assertion): see comments tagged MUTANT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binsAt, sumWeeks, describeStation, stationEntity, createCetaceansLayer, WINDOW_WEEKS } from './cetaceans.js';

const weeks = [
  { w: '2026-05-15', n: { 'right whale': 3, 'fin whale': 1 }, m: { 'sei whale': 2 }, e: 7 },
  { w: '2026-05-08', n: { 'fin whale': 4 }, m: {}, e: 7 },
  { w: '2026-05-01', n: {}, m: {}, e: 5 },
  { w: '2026-01-02', n: { 'humpback whale': 2 }, m: {}, e: 3 },
];

test('binsAt: live = newest window of the record; instant = the 7-day bin containing it; none outside', () => {
  // MUTANT: cutoff (WINDOW_WEEKS - 1) → WINDOW_WEEKS + 10 lets the January bin in → first assertion fails.
  const live = binsAt(weeks, null, '2026-05-15');
  assert.deepEqual(live.bins.map((b) => b.w), ['2026-05-15', '2026-05-08', '2026-05-01'], 'January bin is outside the 13-week window');
  assert.match(live.label, new RegExp(`last ${WINDOW_WEEKS} weeks to 2026-05-15`));
  // MUTANT: `t > end - 7 * DAY_MS` → `>=` … and w−6/w−7 edge: `t <= end` → `t < end - DAY_MS` fails the first edge.
  assert.deepEqual(binsAt(weeks, '2026-05-09T00:00:00Z', '2026-05-15').bins.map((b) => b.w), ['2026-05-15'], 'w−6 d is inside the bin');
  assert.deepEqual(binsAt(weeks, '2026-05-08T23:00:00Z', '2026-05-15').bins.map((b) => b.w), ['2026-05-08'], 'w−7 d belongs to the previous bin');
  const none = binsAt(weeks, '2026-09-01T00:00:00Z', '2026-05-15');
  assert.equal(none.bins.length, 0);
  assert.match(none.label, /no analysed recordings in the week of 2026-09-01/);
  assert.equal(binsAt(weeks, 'garbage', '2026-05-15').bins.length, 0);
  assert.equal(binsAt(undefined, null, null).bins.length, 0);
});

test('sumWeeks: detection days, possible days and effort; hidden species drop out of n and m but not effort', () => {
  // MUTANT: `effort += b.e` removed → effort 0 fails; visibility filter removed from m → possible 2 when sei hidden fails.
  const all = sumWeeks(weeks.slice(0, 3));
  assert.deepEqual(all, { n: { 'right whale': 3, 'fin whale': 5 }, m: { 'sei whale': 2 }, total: 8, possible: 2, effort: 19 });
  const hidden = sumWeeks(weeks.slice(0, 3), { 'sei whale': false, 'fin whale': false });
  assert.deepEqual(hidden, { n: { 'right whale': 3 }, m: {}, total: 3, possible: 0, effort: 19 });
});

test('describeStation escapes, lists days by species, states the days-not-calls caveat, org name and citation', () => {
  // MUTANT: esc() on station removed → &lt;G1&gt; match fails.
  const p = { station: '<G1>', org: 'WHOI', platform: 'ELECTRIC_GLIDER', mobile: true, qc: ['REAL_TIME'] };
  const scope = binsAt(weeks, null, '2026-05-15');
  const html = describeStation(p, scope, sumWeeks(scope.bins), 'Woods Hole Oceanographic Institution', { name: 'PACM', licence: 'PD', citation: 'Cite & me', url: 'https://u' });
  assert.match(html, /&lt;G1&gt;.*Woods Hole Oceanographic Institution.*electric glider \(mobile.*real time.*8 species-days with detections over 19 analysed days.*counts twice.*fin whale: 5 days.*right whale: 3 days.*possible: sei whale 2.*not calls or animals.*Cite &amp; me.*https:\/\/u.*PD/s);
  assert.doesNotMatch(html, /humpback/, 'January bin is outside the live window');
  // positive control for the doesNotMatch: the January instant does show humpback
  const jan = binsAt(weeks, '2026-01-01T00:00:00Z', '2026-05-15');
  assert.match(describeStation(p, jan, sumWeeks(jan.bins)), /week ending 2026-01-02: 2 species-days with detections over 3 analysed days.*humpback whale: 2 days/s);
});

test('stationEntity: size grows with detection days, colour = dominant visible species, fades when analysed but nothing heard', () => {
  // MUTANT: alpha always 1 → faded assertion fails; dominant sort reversed → 'fin whale' expectation fails.
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [-70, 41] }, properties: { station: 'S1', org: 'WHOI', weeks } };
  const ctx = { dataEnd: '2026-05-15', visible: {}, species: ['right whale', 'fin whale', 'sei whale', 'humpback whale'], organizations: {}, source: {} };
  const live = stationEntity(f, 0, null, ctx);
  assert.equal(live.id, 'cetaceans:0');
  assert.equal(live.properties.total, 8);
  assert.equal(live.properties.effort, 19);
  assert.equal(live.properties.dominant, 'fin whale');
  assert.equal(live.point.color.alpha, 1);
  const rightOnly = stationEntity(f, 0, null, { ...ctx, visible: { 'fin whale': false } });
  assert.equal(rightOnly.properties.dominant, 'right whale');
  assert.ok(rightOnly.point.pixelSize < live.point.pixelSize);
  const quiet = stationEntity(f, 0, '2026-04-28T00:00:00Z', ctx);
  assert.equal(quiet.properties.total, 0);
  assert.equal(quiet.properties.effort, 5, 'recorder was analysed that week');
  assert.ok(quiet.point.color.alpha < 0.3, 'nothing heard that week → faded');
});

test('layer: contract, live window, observed-time bin, chips hide species, legend states record end, analyst records', async () => {
  // MUTANT: getAnalystRecords filter `> 0` removed → 2 records instead of 1 fails; legend `ends ${_dataEnd}` removed fails.
  const gj = {
    type: 'FeatureCollection', data_end: '2026-05-15', species: ['right whale', 'fin whale', 'sei whale', 'humpback whale'],
    organizations: { WHOI: 'Woods Hole Oceanographic Institution' }, source: { name: 'PACM', licence: 'PD' },
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-70, 41] }, properties: { station: 'S1', org: 'WHOI', weeks } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-64, 48] }, properties: { station: 'S2', org: 'UNB', weeks: [{ w: '2026-01-02', n: { 'right whale': 1 }, m: {}, e: 4 }] } },
    ],
  };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createCetaceansLayer();
    assert.equal(l.id, 'cetaceans');
    assert.equal(l.icon, '🐋');
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setRowControlsListener', 'setParams', 'getParams', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 2);
    assert.equal(l.getStats().active, 1, 'S2 only has a January bin, outside the live window');
    assert.equal(l.getStats().error, null);
    let rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.label), ['RIGHT WHALE', 'FIN WHALE', 'SEI WHALE', 'HUMPBACK WHALE']);
    assert.equal(rc.legend.find((i) => i.label === 'fin whale').count, 1);
    assert.match(rc.legend.at(-1).label, /ends 2026-05-15/);
    assert.match(ds.entities.getById('cetaceans:0').description.getValue(), /Woods Hole Oceanographic Institution/);
    l.setObservedTime('2026-01-01T00:00:00Z');
    assert.equal(l.getStats().active, 2);
    assert.match(l.getRowControls().legend.at(-1).label, /week of the observed time/);
    assert.equal(l.setParams({ 'right whale': false }), true);
    assert.equal(l.getStats().active, 1, 'hiding right whale empties S2 that week');
    assert.equal(l.getRowControls().legend.some((i) => i.label === 'right whale'), false, 'hidden species leaves the legend');
    assert.equal(l.setParams({ 'right whale': false }), false);
    assert.equal(l.setObservedTime('bad'), false);
    assert.equal(l.getAnalystRecords().length, 0, 'disabled layer yields no records');
    assert.equal(l.setObservedTime(null), true);
    l.enable();
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 1, 'only S1 has detection days in scope');
    assert.equal(recs[0].speciesDetectionDays, 5, 'right whale hidden → fin whale only');
    assert.equal(recs[0].analysedDays, 19);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /HTTP 503/);
  } finally { globalThis.fetch = saved; }
});
