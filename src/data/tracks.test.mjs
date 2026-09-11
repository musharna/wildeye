// src/data/tracks.test.mjs — track contract layer: pure helpers + contract + observed-time clipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipSegment, describeTrack, createTracksLayer, speciesColor } from './tracks.js';

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
  assert.ok(speciesColor('a', ['a', 'b']).red !== speciesColor('b', ['a', 'b']).red || speciesColor('a', ['a', 'b']).green !== speciesColor('b', ['a', 'b']).green);
});

test('tracks layer: contract, chips, observed-time clipping and fading', async () => {
  const mk = (species, dataset, times, coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { species, dataset, segment: 0, animal: 'A', times, start: times[0], end: times.at(-1), n: coords.length, source: 'atn', source_name: 'ATN' } });
  const gj = { type: 'FeatureCollection', species: ['ribbon seal', 'spotted seal'], features: [
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
    assert.equal(ds.entities.values.length, 5, 'three polylines + one head per deployment (last segment only)');
    assert.deepEqual(l.getRowControls().chips.map((c) => c.label), ['RIBBON SEAL 1', 'SPOTTED SEAL 2']);
    // observed time inside track 1, outside track 2
    assert.equal(l.setObservedTime(T(3)), true);
    const heads = ds.entities.values.filter((e) => e.id.endsWith(':head'));
    assert.equal(heads.length, 1, 'only the in-span track gets a head');
    const faded = ds.entities.values.find((e) => e.id.startsWith('trk:d2'));
    assert.ok(faded.polyline.material.getValue().color.alpha < 0.5, 'out-of-span track is faded');
    assert.equal(l.setParams({ 'ribbon seal': false }), true);
    assert.equal(ds.entities.values.filter((e) => e.show).length, 2);
    assert.equal(l.setObservedTime(null), true);
    assert.equal(ds.entities.values.filter((e) => e.id.endsWith(':head')).length, 2);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 1, 'hidden species excluded');
  } finally { globalThis.fetch = saved; }
});
