// src/data/haedat.test.mjs — HAEDAT harmful algal events: scope by year, illness colour, position precision, readout reach, layer contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ILLNESSES, REGIONAL_KM, NEAR_KM, yearOf, eventsAt, dominant, illnessText, precisionText, distanceKm, describePosition, positionEntity, createHaedatLayer,
} from './haedat.js';

const KEYS = ILLNESSES.map((i) => i.key);
// Three positions shaped like pipeline/haedat.py's output: a 10 km monitoring point, a 500 km regional record and a
// point whose only event is undated.
const MAINE = {
  lat: 44.14, lon: -67.53, uncertaintyKm: 10, countries: ['UNITED STATES'], places: ['Maine Coastline <b>'], species: [['Alexandrium tamarense', 8]],
  years: { 1988: { n: 10, ill: { PSP: 10 } }, 2014: { n: 1, ill: { ASP: 1, PSP: 1 } }, 2019: { n: 3, ill: { None: 3 } } },
  undated: { n: 0, ill: {} },
};
const REGION = {
  lat: 0, lon: 100, uncertaintyKm: 500, countries: ['INDONESIA'], places: ['Sumatra'], species: [],
  years: { 2014: { n: 4, ill: { CFP: 4 } } }, undated: { n: 0, ill: {} },
};
const UNDATED = {
  lat: 33.61, lon: 131.89, uncertaintyKm: 10, countries: ['JAPAN'], places: ['Bungo Channel'], species: [],
  years: {}, undated: { n: 1, ill: { None: 1 } },
};
const data = () => ({
  events: 19, undated: ['HAEDAT:JP-04:JP-01-008'], offGlobe: ['x (21.7, -808.8)'], illnesses: [...KEYS], positions: [MAINE, REGION, UNDATED],
  source: { doi: '10.25607/k68d5v', name: 'HAEDAT', publisher: 'IOC-UNESCO', version: '3.35', published: '2025-05-23' },
});

test('yearOf: the UTC calendar year of an instant; live stays null; garbage throws', () => {
  assert.equal(yearOf(null), null);
  assert.equal(yearOf(undefined), null);
  assert.equal(yearOf('2014-12-31T23:59:59Z'), 2014);
  assert.equal(yearOf('2015-01-01T00:00:00Z'), 2015);
  assert.throws(() => yearOf('soon'), /not an instant/);
});

test('eventsAt: live = every year plus the undated; a year = that year only; a year with nothing = 0', () => {
  assert.deepEqual(eventsAt(MAINE, null), { n: 14, ill: { PSP: 11, ASP: 1, None: 3 } });
  assert.deepEqual(eventsAt(MAINE, 2014), { n: 1, ill: { ASP: 1, PSP: 1 } });
  assert.deepEqual(eventsAt(MAINE, 2000), { n: 0, ill: {} });
  assert.deepEqual(eventsAt(UNDATED, null), { n: 1, ill: { None: 1 } }, 'undated events count live');
  assert.deepEqual(eventsAt(UNDATED, 2014), { n: 0, ill: {} }, 'and in no year');
});

test('dominant: the commonest illness, ties to the one listed first; illnessText orders by count', () => {
  assert.equal(dominant({ PSP: 11, ASP: 1, None: 3 }), 'PSP');
  assert.equal(dominant({ ASP: 2, PSP: 2 }), 'PSP', 'PSP is listed before ASP');
  assert.equal(dominant({ Other: 2, DSP: 3 }), 'DSP');
  assert.equal(dominant({}), null);
  assert.equal(illnessText({ None: 3, PSP: 11, ASP: 1 }), 'PSP 11, None 3, ASP 1');
});

test('precision: wider than REGIONAL_KM is a regional record; distance is great-circle and crosses the antimeridian', () => {
  assert.match(precisionText(REGIONAL_KM), /monitoring point, within about 100 km/);
  assert.match(precisionText(REGIONAL_KM + 0.1), /regional record.*within about 100 km/);
  assert.match(precisionText(985), /regional record.*985 km/);
  assert.ok(Math.abs(distanceKm(0, 0, 0, 1) - 111.195) < 0.01);
  assert.ok(Math.abs(distanceKm(0, 179.5, 0, -179.5) - 111.195) < 0.01);
  assert.ok(Math.abs(distanceKm(44.14, -67.53, 44.14, -67.53)) < 1e-9);
});

test('describePosition: counts in scope, escaped places, precision, causative taxa, record span, citation', () => {
  const html = describePosition(MAINE, null, data().source);
  assert.match(html, /<b>14 harmful algal events<\/b> · all years/);
  assert.match(html, /Maine Coastline &lt;b&gt; · UNITED STATES/);
  assert.match(html, /monitoring point, within about 10 km/);
  assert.match(html, /Linked illness: PSP 11, None 3, ASP 1/);
  assert.match(html, /<i>Alexandrium tamarense<\/i> \(8\)/);
  assert.match(html, /14 events recorded here, 1988–2019/);
  assert.match(html, /doi\.org\/10\.25607\/k68d5v.*archive 3\.35 of 2025-05-23 · CC BY 4\.0/);
  assert.match(describePosition(MAINE, 2014), /<b>1 harmful algal event<\/b> · 2014/);
  assert.match(describePosition(UNDATED, null), /1 event recorded here \(1 undated\)/);
});

test('positionEntity: none out of scope; filled dot within 100 km, translucent ring beyond, coloured by the dominant illness', () => {
  assert.equal(positionEntity(MAINE, 2000), null);
  const dot = positionEntity(MAINE, null);
  assert.equal(dot.id, 'haedat:44.14,-67.53');
  assert.equal(dot.properties.dominant, 'PSP');
  assert.equal(dot.properties.regional, false);
  assert.equal(dot.point.color.toCssHexString(), ILLNESSES.find((i) => i.key === 'PSP').color);
  const asp = positionEntity(MAINE, 2014);
  assert.equal(asp.properties.dominant, 'PSP', 'a tie goes to the first listed');
  const ring = positionEntity(REGION, null);
  assert.equal(ring.properties.regional, true);
  assert.equal(ring.point.color.alpha, 0.12);
  assert.equal(ring.point.outlineColor.toCssHexString(), ILLNESSES.find((i) => i.key === 'CFP').color);
  assert.ok(ring.point.pixelSize > dot.point.pixelSize - 5, 'a ring is not smaller than a dot of similar count');
  // the boundary itself, through the entity: the archive has positions at exactly 100 km (the Gulf of Maine point)
  assert.equal(positionEntity({ ...MAINE, uncertaintyKm: REGIONAL_KM }, null).properties.regional, false);
  assert.equal(positionEntity({ ...MAINE, uncertaintyKm: REGIONAL_KM + 0.1 }, null).properties.regional, true);
});

function fakeViewer() {
  const state = { ds: null };
  return { state, viewer: { dataSources: { add(d) { state.ds = d; }, remove() { state.ds = null; } } } };
}
const okFetch = (d, urls = []) => async (u) => { urls.push(u); return { ok: true, json: async () => d }; };

test('layer: contract, entities per scope, extent from the dated years, legend, readout reach and wording', async () => {
  const urls = [];
  const l = createHaedatLayer({ fetchImpl: okFetch(data(), urls) });
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getRowControls', 'setObservedTime', 'getObservedExtent', 'readoutAt']) assert.equal(typeof l[k], 'function', k);
  assert.equal(l.getObservedExtent(), null, 'no data → no extent');
  const { state, viewer } = fakeViewer();
  l.init(viewer);
  assert.equal(state.ds.name, 'haedat');
  assert.equal(await l.update(), true);
  assert.deepEqual(urls, ['data/haedat.json']);
  assert.equal(state.ds.entities.values.length, 3, 'live: every position, the undated one included');
  assert.deepEqual(l.getObservedExtent(), { startMs: Date.UTC(1988, 0, 1), endMs: Date.UTC(2020, 0, 1) - 1 });

  assert.equal(l.setObservedTime('2014-06-01T00:00:00Z'), true);
  assert.deepEqual(state.ds.entities.values.map((e) => e.id).sort(), ['haedat:0,100', 'haedat:44.14,-67.53']);
  assert.equal(l.getStats().observed, 2014);
  const legend2014 = l.getRowControls().legend;
  assert.deepEqual(Object.fromEntries(legend2014.filter((i) => i.count !== null).map((i) => [i.label.split(' ')[0], i.count])),
    { PSP: 1, DSP: 0, ASP: 1, NSP: 0, AZP: 0, CFP: 4, cyanobacterial: 0, aerosolised: 0, other: 0, no: 0 });
  assert.equal(l.setObservedTime('bad'), false);
  assert.equal(l.setObservedTime('1500-01-01T00:00:00Z'), true);
  assert.equal(state.ds.entities.values.length, 0, 'a year with no events draws nothing');
  assert.match(l.getRowControls().legend.at(-1).label, /1500 · 1 undated event in no year · 1 event placed off the globe not drawn · archive/);
  l.setObservedTime(null);
  // live counts the undated events at their positions, so only the off-globe ones are left out
  assert.match(l.getRowControls().legend.at(-1).label, /all years · 1 event placed off the globe not drawn · archive 3\.35/);

  assert.equal(await l.readoutAt(44.14, -67.53), null, 'a layer that is off is not read');
  l.enable();
  const at = await l.readoutAt(44.14, -67.53);
  assert.equal(at.status, 'value');
  assert.equal(at.name, 'Harmful algal events (HAEDAT)');
  assert.equal(at.date, 'all years');
  assert.match(at.text, /^14 events at 1 HAEDAT position whose range covers this spot \(PSP 11, None 3, ASP 1\); nearest 0 km away, a monitoring point$/);
  // reach = the position's stated range or NEAR_KM, whichever is wider: 20 km from a 10 km point is in, 30 km is out
  const north = (km) => 44.14 + km / 111.195;
  assert.equal((await l.readoutAt(north(NEAR_KM - 5), -67.53)).status, 'value');
  const out = await l.readoutAt(north(NEAR_KM + 5), -67.53);
  assert.equal(out.status, 'class', 'no position in reach is a statement, not missing data');
  assert.match(out.text, /no event recorded at a HAEDAT position whose range covers this spot/);
  assert.equal(out.date, 'all years');
  // 300 km from the 500 km regional record is in reach of it
  const regional = await l.readoutAt(0, 100 + 300 / 111.195);
  assert.match(regional.text, /^4 events at 1 HAEDAT position .*\(CFP 4\); nearest 300 km away, a regional record$/);
  l.setObservedTime('2019-03-01T00:00:00Z');
  const y = await l.readoutAt(44.14, -67.53);
  assert.equal(y.date, '2019');
  assert.match(y.text, /^3 events .*\(None 3\)/);
  l.setObservedTime('2014-03-01T00:00:00Z');
  assert.equal((await l.readoutAt(33.61, 131.89)).status, 'class', 'the undated-only position has nothing in a year');
  assert.equal((await l.readoutAt(91, 0)).status, 'outside');
  // the readout names the form on the same boundary as the ring: a position at exactly 100 km is a monitoring point
  for (const [km, kind] of [[REGIONAL_KM, 'a monitoring point'], [REGIONAL_KM + 0.1, 'a regional record']]) {
    const edge = createHaedatLayer({ fetchImpl: okFetch({ ...data(), positions: [{ ...MAINE, uncertaintyKm: km }] }) });
    edge.init(fakeViewer().viewer);
    await edge.update();
    edge.enable();
    assert.match((await edge.readoutAt(44.14, -67.53)).text, new RegExp(`nearest 0 km away, ${kind}$`), `${km} km`);
  }
});

test('update: HTTP error, malformed file, an unknown or reordered illness fail loud; a good file then loads', async () => {
  const bad = [
    [async () => ({ ok: false, status: 404 }), /haedat\.json HTTP 404/],
    [okFetch({ positions: [{ lat: 1 }] }), /Malformed haedat\.json/],
    [okFetch({ ...data(), positions: [{ ...MAINE, years: { 2000: { n: 1, ill: { BMAA: 1 } } } }] }), /illness the legend does not know: BMAA/],
    [okFetch({ ...data(), illnesses: [...KEYS].reverse() }), /lists illnesses .* but the legend has/],
  ];
  for (const [fetchImpl, message] of bad) {
    const l = createHaedatLayer({ fetchImpl });
    l.init(fakeViewer().viewer);
    const errors = [];
    const saved = console.error;
    console.error = (m) => errors.push(m);
    try {
      assert.equal(await l.update(), false);
    } finally { console.error = saved; }
    assert.match(l.getStats().error, message);
    assert.match(errors[0], message, 'the failure is logged, not swallowed');
    l.enable();
    assert.equal((await l.readoutAt(44.14, -67.53)).status, 'error');
  }
  let calls = 0;
  const l = createHaedatLayer({ fetchImpl: async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => data() }; } });
  l.init(fakeViewer().viewer);
  assert.equal(await l.update(), false);
  assert.equal(await l.update(), true, 'positive control: a retry after a failure loads and clears the error');
  assert.equal(l.getStats().error, null);
  assert.equal(await l.update(), true);
  assert.equal(calls, 2, 'a pinned archive is read once');
});
