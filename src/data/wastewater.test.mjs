// src/data/wastewater.test.mjs — polygon contract: trend classes, week selection, layer contract + observed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trendClass, trendAtOrBefore, describeCounty, countyEntities, createWastewaterLayer, NO_DATA, TREND_CLASSES } from './wastewater.js';

const weeks = [{ w: '2026-09-11', t: 0.3, n: 2 }, { w: '2026-09-04', t: null, n: 0 }, { w: '2026-08-28', t: -0.4, n: 1 }];

test('trendClass thresholds and no-data', () => {
  assert.deepEqual([-0.5, -0.15, 0, 0.15, 0.2, 0.5, 0.51, null, NaN].map((t) => trendClass(t).key),
    ['falling', 'stable', 'stable', 'stable', 'rising', 'rising', 'surging', 'none', 'none']);
});

test('trendAtOrBefore: latest when unset, skips null weeks, null before the first week', () => {
  assert.equal(trendAtOrBefore(weeks, null).w, '2026-09-11');
  assert.equal(trendAtOrBefore(weeks, '2026-09-10T12:00:00Z').w, '2026-08-28', 'the 09-04 week has no value');
  assert.equal(trendAtOrBefore(weeks, '2026-08-20T00:00:00Z'), null);
  assert.equal(trendAtOrBefore(weeks, 'garbage'), null);
  assert.equal(trendAtOrBefore([], null), null);
});

test('describeCounty escapes and states the no-cross-site rule', () => {
  const html = describeCounty({ name: '<x>', st: 'AL', sites: 1, pop: 1234 }, weeks[0], { name: 'CDC NWSS', url: 'https://u', licence: 'PD' });
  assert.match(html, /&lt;x&gt; County, AL.*\+0\.30 log.*rising.*week ending 2026-09-11.*never compared with each other.*PD/s);
  assert.match(describeCounty({ name: 'A', st: 'AL', sites: 2, pop: 0 }, null), /no value for this week/);
});

test('layer: contract, MultiPolygon parts, observed-time recolour, legend counts', async () => {
  const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  const gj = { type: 'FeatureCollection', source: { name: 'CDC NWSS', licence: 'PD', url: 'https://u' }, features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { fips: '01001', name: 'A', st: 'AL', sites: 2, pop: 10, weeks } },
    { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [poly, poly] }, properties: { fips: '01003', name: 'B', st: 'AL', sites: 1, pop: 5, weeks: [{ w: '2026-09-11', t: -0.9, n: 1 }] } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createWastewaterLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 3, 'one polygon + two MultiPolygon parts');
    assert.deepEqual(l.getStats().classes, { rising: 1, falling: 1 });
    assert.equal(ds.entities.getById('ww:01003:1').polygon.material.getValue().color.alpha > 0.5, true);
    // observed instant inside the 09-04 gap → A falls back to 08-28 (falling), B has no value that week
    assert.equal(l.setObservedTime('2026-09-06T00:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { falling: 1, none: 1 });
    assert.equal(ds.entities.getById('ww:01003:0').polygon.material.getValue().color.alpha, 0.35, 'no-data county → visible grey (0.18 read as bare imagery)');
    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => /^falling/.test(i.label)).count, 1);
    assert.equal(legend.find((i) => i.label === NO_DATA.label).count, 1);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 2, 'one record per county, not per part');
    assert.equal(l.getAnalystRecords()[0].cls, 'falling');
    assert.equal(l.setObservedTime(null), true);
    assert.deepEqual(l.getStats().classes, { rising: 1, falling: 1 });
  } finally { globalThis.fetch = saved; }
});

test('stable and "no value" are clearly different colours (light midpoint vs dark grey)', () => {
  // Mutant seen failing: stable back to grey #9ca3af, which read like the no-value grey over terrain.
  const lum = (hex) => { const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const stable = TREND_CLASSES.find((c) => c.key === 'stable').color;
  const sat = (hex) => { const v = hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16)); return (Math.max(...v) - Math.min(...v)) / 255; };
  assert.ok(lum(stable) - lum(NO_DATA.color) > 0.35, `luminance gap ${lum(stable) - lum(NO_DATA.color)}`);
  assert.ok(sat(stable) > 0.25, 'stable carries a hue, not another grey');
  assert.ok(sat(NO_DATA.color) < 0.1, 'positive control: no-value stays neutral grey');
});
