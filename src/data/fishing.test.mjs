// src/data/fishing.test.mjs — polygon contract (1° grid): effort classes, gear-filtered sums, info box, layer contract + observed time + gear chips.
// Mutants verified (each named test fails when the line is broken):
//   * effortClass: `h < 5` → `h <= 5`            (thresholds test: 5 must be "low")
//   * sumBins: drop the `visible[g] === false` skip (gear-filter test: hidden gear still counted)
//   * sumBins: `hours / span` → `hours`           (thresholds test: live perWeek 4-week sum ≠ per-week)
//   * describeCell: `lat >= 0 ? "N" : "S"` swapped (describe test: 15–16°N)
//   * cellEntities: `cls === NO_DATA ? 0.08` → 0.55 (layer test: faded alpha < 0.2)
//   * layer.setParams: never set `changed = true`  (layer test: chip toggle does not recolour)
//   * getAnalystRecords: drop the `part === 0` filter (layer test: MultiPolygon counted twice)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortClass, sumBins, describeCell, cellEntities, createFishingLayer, NO_DATA, EFFORT_CLASSES } from './fishing.js';
import { binsAt } from './gfw.js';

const weeks = [
  { w: '2026-09-12', hours: 30, gear: { trawlers: 20, purse_seines: 10 } },
  { w: '2026-09-05', hours: 10, gear: { trawlers: 10 } },
  { w: '2026-08-29', hours: 100, gear: { drifting_longlines: 100 } },
  { w: '2026-06-06', hours: 600, gear: { squid_jigger: 600 } },
];
const square = (lon, lat) => [[[lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1], [lon, lat]]];

test('effortClass thresholds and per-week sums over the live window', () => {
  assert.deepEqual([0, 4.9, 5, 24.9, 25, 99, 100, 499, 500, 1e4, NaN].map((h) => effortClass(h).key),
    ['none', 'trace', 'low', 'low', 'mid', 'mid', 'high', 'high', 'intense', 'intense', 'none']);
  const live = binsAt(weeks, null, '2026-09-12');
  assert.equal(live.bins.length, 3, 'June bin is outside the 4-week live window');
  const s = sumBins(live.bins, live.span);
  assert.deepEqual(s, { hours: 140, perWeek: 35, gear: { trawlers: 30, purse_seines: 10, drifting_longlines: 100 } });
  assert.equal(effortClass(s.perWeek).key, 'mid');
});

test('sumBins honours the gear chips: hidden gear drops out, visible gear stays (positive control)', () => {
  const live = binsAt(weeks, null, '2026-09-12');
  const s = sumBins(live.bins, live.span, { drifting_longlines: false });
  assert.deepEqual(s, { hours: 40, perWeek: 10, gear: { trawlers: 30, purse_seines: 10 } });
  assert.equal(sumBins(live.bins, live.span, { trawlers: false, purse_seines: false, drifting_longlines: false }).hours, 0);
});

test('describeCell names the cell, the scope, the gear breakdown and the AIS caveat', () => {
  const p = { lon: -18, lat: 15, hours: 740, weeks };
  const live = binsAt(weeks, null, '2026-09-12');
  const html = describeCell(p, live, sumBins(live.bins, live.span), { url: 'https://u', attribution: 'Powered by GFW', licence: 'CC BY-NC 4.0' });
  assert.match(html, /1° cell 15–16°N, 17–18°W.*last 4 weeks to 2026-09-12: <b>140<\/b> h \(35 h per week\).*drifting longlines 100 h, trawlers 30 h, purse seines 10 h.*740 h in this cell.*vessels without AIS are invisible.*https:\/\/u.*Powered by GFW.*CC BY-NC 4.0/s);
  const june = binsAt(weeks, '2026-06-03T12:00:00Z', '2026-09-12');
  const h2 = describeCell({ lon: 170, lat: -40, hours: 600, weeks }, june, sumBins(june.bins, june.span));
  assert.match(h2, /39–40°S, 170–171°E.*week ending 2026-06-06: <b>600<\/b> h<br>squid jigger 600 h/s);
  assert.doesNotMatch(h2, /per week\)/, 'a single observed week states no per-week rate');
});

test('layer: contract, observed-time recolour, gear chips, legend counts, records, MultiPolygon parts', async () => {
  const gj = { type: 'FeatureCollection', today: '2026-09-12', gears: ['trawlers', 'purse_seines', 'drifting_longlines', 'squid_jigger'],
    source: { version: 'public-global-fishing-effort:v3.0', attribution: 'Powered by Global Fishing Watch', licence: 'CC BY-NC 4.0', url: 'https://globalfishingwatch.org' },
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(-18, 15) }, properties: { lon: -18, lat: 15, hours: 740, weeks } },
      { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [square(170, -40), square(171, -40)] }, properties: { lon: 170, lat: -40, hours: 600, weeks: [weeks[3]] } },
    ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createFishingLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime', 'setParams', 'getParams', 'setRowControlsListener']) assert.equal(typeof l[k], 'function');
    assert.equal(l.id, 'fishing');
    assert.equal(l.icon, '🎣');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 3, 'one entity per polygon part');
    assert.deepEqual(l.getStats().classes, { mid: 1, none: 1 });
    assert.equal(l.getStats().error, null);
    assert.ok(ds.entities.getById('fishing:170:-40:1').polygon.material.getValue().color.alpha < 0.2, 'no effort in scope = faded');
    assert.ok(ds.entities.getById('fishing:-18:15:0').polygon.material.getValue().color.alpha > 0.5);
    // gear chips
    const rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.id), gj.gears);
    assert.deepEqual(rc.chips[2].params, { drifting_longlines: false });
    assert.equal(l.setParams({ drifting_longlines: false }), true);
    assert.deepEqual(l.getStats().classes, { low: 1, none: 1 }, '(30+10)/4 = 10 h per week once longlines are hidden');
    assert.equal(l.getRowControls().chips[2].state, 'idle');
    assert.equal(l.setParams({ nonsense: false }), false);
    assert.equal(l.setParams({ drifting_longlines: true }), true);
    assert.deepEqual(l.getParams(), { trawlers: true, purse_seines: true, drifting_longlines: true, squid_jigger: true });
    // observed time
    assert.equal(l.setObservedTime('2026-06-03T00:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { intense: 2 }, 'both cells carry the June bin');
    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => i.label === EFFORT_CLASSES[4].label).count, 2);
    assert.equal(legend.find((i) => i.label === NO_DATA.label).count, 0);
    assert.match(legend.at(-1).label, /week of the observed time.*Powered by Global Fishing Watch/);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 2, 'MultiPolygon cell counted once (3 entities, 2 records)');
    assert.equal(l.getAnalystRecords()[1].gear, 'squid_jigger');
    assert.equal(l.setObservedTime('2026-07-15T00:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { none: 2 }, 'a week with no bin fades every cell');
    assert.equal(l.getAnalystRecords().length, 0);
    assert.equal(l.setObservedTime(null), true);
    assert.match(l.getRowControls().legend.at(-1).label, /last 4 weeks \(public-global-fishing-effort:v3.0\)/);
    const rec = l.getAnalystRecords();
    assert.equal(rec.length, 1);
    assert.deepEqual([rec[0].hours, rec[0].perWeek, rec[0].gear, rec[0].cls], [140, 35, 'drifting_longlines', 'mid']);
    l.disable();
    assert.equal(l.getAnalystRecords().length, 0);
  } finally { globalThis.fetch = saved; }
});
