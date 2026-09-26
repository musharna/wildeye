// src/data/tracks.test.mjs — track contract layer: pure helpers + contract + observed-time clipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { clipSegment, describeTrack, createTracksLayer, groupColor, GROUP_COLORS } from './tracks.js';

const T = (h) => `2026-09-10T${String(h).padStart(2, '0')}:00:00Z`;

test('clipSegment: null before first fix, interpolated head inside, full segment after last', () => {
  const coords = [[0, 0], [2, 0], [4, 2]];
  const times = [T(0), T(2), T(4)];
  assert.equal(clipSegment(coords, times, Date.parse('2026-09-09T00:00:00Z')), null);
  const mid = clipSegment(coords, times, Date.parse(T(3)));
  assert.deepEqual(mid.head, [3, 1]);
  assert.deepEqual(mid.coords, [[0, 0], [2, 0], [3, 1]]);
  assert.equal(mid.complete, false);
  const end = clipSegment(coords, times, Date.parse('2026-09-11T00:00:00Z'));
  assert.equal(end.complete, true); assert.equal(end.coords.length, 3);
  assert.equal(clipSegment([], [], 0), null);
  assert.equal(clipSegment(coords, times, NaN), null);
});

test('describeTrack escapes and carries citation + licence', () => {
  const html = describeTrack({ species: 'spotted seal', sci: 'Phoca largha', animal: '<b>', start: '2018-04-20T00:00:00Z', end: '2018-06-18T00:00:00Z', n: 40, institution: 'NOAA AFSC', citation: 'London et al. 2025', license: 'free to redistribute, no warranty', url: 'https://x', source_name: 'ATN' });
  assert.match(html, /spotted seal.*&lt;b&gt;.*40 fixes.*NOAA AFSC.*London et al\. 2025.*free to redistribute/s);
  // five groups, five different colours, fixed per group (not by position in the file)
  const css = Object.values(GROUP_COLORS);
  assert.deepEqual(Object.keys(GROUP_COLORS), ['whales & dolphins', 'seals', 'land mammals', 'birds', 'reptiles']);
  assert.equal(new Set(css).size, 5);
  assert.equal(groupColor('seals').toCssHexString(), Cesium.Color.fromCssColorString(GROUP_COLORS.seals).toCssHexString());
  assert.throws(() => groupColor('rodents'), /no colour for group/);
});

test('tracks layer: contract, chips, observed-time clipping and fading', async () => {
  const GRP = { 'ribbon seal': 'seals', 'spotted seal': 'seals', 'lion': 'land mammals' };
  const mk = (species, dataset, times, coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { species, group: GRP[species], dataset, segment: 0, animal: 'A', times, start: times[0], end: times.at(-1), n: coords.length, source: 'atn', source_name: 'ATN' } });
  const gj = { type: 'FeatureCollection', species: ['lion', 'ribbon seal', 'spotted seal'], groups: ['seals', 'land mammals'], features: [
    mk('lion', 'd9', ['2010-03-01T00:00:00Z', '2010-03-02T00:00:00Z'], [[23, -21], [23.1, -21.1]]),
    mk('ribbon seal', 'd1', [T(0), T(2), T(4)], [[0, 0], [2, 0], [4, 2]]),
    mk('spotted seal', 'd2', ['2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'], [[10, 10], [11, 11]]),
    { ...mk('spotted seal', 'd2', ['2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z'], [[12, 12], [13, 13]]), properties: { ...mk('spotted seal', 'd2', ['2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z'], [[12, 12], [13, 13]]).properties, segment: 1 } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createTracksLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setParams', 'getParams', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 7, 'four polylines + one head per deployment (last segment only)');
    // a head dot must not show through the Earth: with depth testing off at any distance, Alaska's seal
    // heads drew over the Balkans and Hawaii's whales over the Sahara from an Africa view (2026-09-25)
    const heads0 = ds.entities.values.filter((e) => e.id.endsWith(':head'));
    assert.ok(heads0.length > 0);
    for (const h of heads0) assert.equal(h.point.disableDepthTestDistance.getValue(), 50_000, 'same as the other bio point layers');
    assert.deepEqual(l.getRowControls().chips.map((c) => c.label), ['SEALS 3', 'LAND MAMMALS 1'], 'one chip per group, in legend order, segment counts');
    assert.deepEqual(l.getRowControls().legend.slice(0, 2).map((g) => [g.label, g.color]), [['seals', GROUP_COLORS.seals], ['land mammals', GROUP_COLORS['land mammals']]]);
    const lion = ds.entities.values.find((e) => e.id.startsWith('trk:d9'));
    const seal = ds.entities.values.find((e) => e.id.startsWith('trk:d1'));
    assert.equal(lion.polyline.material.getValue().color.withAlpha(1).toCssHexString(), Cesium.Color.fromCssColorString(GROUP_COLORS['land mammals']).toCssHexString(), 'coloured by group');
    assert.equal(seal.polyline.material.getValue().color.withAlpha(1).toCssHexString(), Cesium.Color.fromCssColorString(GROUP_COLORS.seals).toCssHexString());
    // observed time inside track 1, outside track 2
    assert.equal(l.setObservedTime(T(3)), true);
    const heads = ds.entities.values.filter((e) => e.id.endsWith(':head'));
    assert.equal(heads.length, 1, 'only the in-span track gets a head');
    const faded = ds.entities.values.find((e) => e.id.startsWith('trk:d2'));
    assert.ok(faded.polyline.material.getValue().color.alpha < 0.5, 'out-of-span track is faded');
    assert.equal(l.setParams({ 'land mammals': false }), true);
    assert.equal(l.setParams({ 'ribbon seal': false }), false, 'species are not toggles any more');
    assert.equal(ds.entities.values.filter((e) => e.id.startsWith('trk:d9') && e.show).length, 0, 'the lion is hidden with its group');
    assert.ok(ds.entities.values.filter((e) => e.id.startsWith('trk:d1') && e.show).length > 0, 'seals stay');
    assert.equal(l.setObservedTime(null), true);
    assert.equal(ds.entities.values.filter((e) => e.id.endsWith(':head')).length, 3);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 2, 'hidden group excluded');
    assert.deepEqual(l.getAnalystRecords().map((r) => r.group), ['seals', 'seals']);
  } finally { globalThis.fetch = saved; }
});

test('tracks layer refuses a file with a track outside the five groups, loudly', async () => {
  const f = (group) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    properties: { species: 'x', group, dataset: 'd', segment: 0, times: ['2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'] } });
  const saved = globalThis.fetch;
  try {
    const l = createTracksLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection', groups: ['birds'], features: [f('birds')] }) });
    assert.equal(await l.update(), true, 'positive control: a grouped file loads');
    for (const bad of [undefined, 'rodents']) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection', groups: ['birds'], features: [f('birds'), f(bad)] }) });
      assert.equal(await l.update(), false);
      assert.match(l.getStats().error, /1 of 2 tracks have no known group/);
      assert.equal(l.getStats().count, 1, 'the last good load stays');
    }
  } finally { globalThis.fetch = saved; }
});

// ---- incremental time steps (2026-09-26): a step rebuilt all 1,132 entities (~50 ms on an Intel iGPU, 192 ms on
// swiftshader) though a weekly step changes at most 44 of 1,114 segments (median 0). Only the in-span set may be touched.
const H = (h) => new Date(Date.parse('2026-09-10T00:00:00Z') + h * 3600000).toISOString();
function shelf() {
  const f = (species, group, dataset, segment, hours, coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { species, group, dataset, segment, animal: dataset, times: hours.map(H), start: H(hours[0]), end: H(hours.at(-1)), n: coords.length, source: 'atn', source_name: 'ATN' } });
  const features = [];
  for (let k = 0; k < 40; k++) features.push(f('lion', 'land mammals', `old${k}`, 0, [-9000 - k, -8990 - k], [[20 + k * 0.1, -20], [20.5 + k * 0.1, -20.5]]));
  features.push(f('ribbon seal', 'seals', 'A', 0, [0, 2, 4], [[0, 0], [2, 0], [4, 2]]));   // live at 3, complete at 5
  features.push(f('ribbon seal', 'seals', 'B', 0, [1, 3, 6, 8], [[5, 5], [6, 5], [7, 6], [8, 8]])); // live 3..7
  features.push(f('spotted seal', 'seals', 'C', 0, [6, 9], [[10, 10], [11, 11]]));        // enters at 6
  features.push(f('spotted seal', 'seals', 'C', 1, [12, 14], [[12, 12], [13, 13]]));      // not before 12
  features.push(f('lion', 'land mammals', 'L', 0, [2, 7], [[30, -1], [31, -2]]));          // group toggled below
  return { type: 'FeatureCollection', features };
}
async function loaded(gj) {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createTracksLayer();
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    l.enable();
    return { l, ds };
  } finally { globalThis.fetch = saved; }
}
const NOW = Cesium.JulianDate.now();
const deg = (c) => { const g = Cesium.Cartographic.fromCartesian(c); return [+Cesium.Math.toDegrees(g.longitude).toFixed(6), +Cesium.Math.toDegrees(g.latitude).toFixed(6)]; };
/** What is drawn: every shown entity, keyed by the segment it belongs to (not by entity id), with geometry and style. */
function drawn(ds) {
  return ds.entities.values.filter((e) => e.show).map((e) => {
    const seg = e.id.replace(/:(live|head)$/, '').replace(/:live$/, '');
    if (e.polyline) return `line ${seg} w${e.polyline.width.getValue(NOW)} a${e.polyline.material.getValue(NOW).color.alpha.toFixed(2)} ${JSON.stringify(e.polyline.positions.getValue(NOW).map(deg))}`;
    return `head ${seg} a${e.point.color.getValue(NOW).alpha.toFixed(2)} ${JSON.stringify(deg(e.position.getValue(NOW)))} ${e.properties.kind.getValue(NOW)}`;
  }).sort();
}

test('tracks: a time step leaves every segment whose state did not change untouched', async () => {
  const { l, ds } = await loaded(shelf());
  l.setObservedTime(H(3));
  const before = new Map(ds.entities.values.map((e) => [e.id, e]));
  const events = [];
  for (const e of ds.entities.values) e.definitionChanged.addEventListener((ent, prop) => events.push(`${ent.id} ${prop}`));
  let adds = 0, removes = 0;
  const { add, remove, removeById } = ds.entities;
  ds.entities.add = function (...a) { adds++; return add.apply(this, a); };
  ds.entities.remove = function (...a) { removes++; return remove.apply(this, a); };
  ds.entities.removeById = function (...a) { removes++; return removeById.apply(this, a); };
  ds.entities.removeAll = () => assert.fail('a time step must not clear the collection');
  l.setObservedTime(H(5)); // A leaves its span, B moves on, the 40 old lions and C do not change
  for (let k = 0; k < 40; k++) {
    const e = ds.entities.values.find((x) => x.id.startsWith(`trk:old${k}:`));
    assert.equal(e, before.get(e.id), `old${k} is the same entity`);
  }
  assert.deepEqual(events.filter((x) => x.startsWith('trk:old')), [], 'nothing on an unchanged segment is redefined, so its Cesium batch is not rebuilt');
  assert.ok(adds + removes <= 6, `only the in-span set is touched (adds ${adds}, removes ${removes})`);
  assert.ok(adds + removes > 0, 'positive control: A leaving its span and B moving did change something');
});

test('tracks: stepping through time draws exactly what a fresh load at that time draws', async () => {
  const steps = [null, H(-1), H(1), H(3), H(3.5), H(5), H(6), H(7.5), H(9), H(13), H(20), null, H(3)];
  const { l, ds } = await loaded(shelf());
  l.setParams({ 'land mammals': false });
  for (const [i, t] of steps.entries()) {
    if (i === 6) l.setParams({ 'land mammals': true });
    l.setObservedTime(t);
    const fresh = await loaded(shelf());
    if (i < 6) fresh.l.setParams({ 'land mammals': false });
    fresh.l.setObservedTime(t);
    assert.deepEqual(drawn(ds), drawn(fresh.ds), `step ${i} (${t})`);
  }
  // positive control: the snapshot sees a step (B's head moves between 3 and 3.5)
  l.setObservedTime(H(3)); const a = drawn(ds); l.setObservedTime(H(3.5));
  assert.notDeepEqual(a, drawn(ds));
});
