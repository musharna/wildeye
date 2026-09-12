// src/data/phenology.test.mjs — site-series contract: class sums, observed-time bins, info box, layer contract + chips.
// Mutants each test was seen to fail on are named in the test titles/comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumBins, describeSite, siteEntity, createPhenologyLayer, CLASSES, classColor, NO_YES_COLOR } from './phenology.js';
import { binsAt } from './hpai.js';

const weeks = [
  { w: '2026-09-12', yes: { leaves: 3, flowers: 1 }, obs: { leaves: 5, flowers: 4, fruits: 2 }, sp: { leaves: { 'red maple': 2, 'sugar maple': 1 }, flowers: { goldenrod: 1 } } },
  { w: '2026-09-05', yes: { birds: 2 }, obs: { birds: 2, leaves: 1 }, sp: { birds: { 'American robin': 2 } } },
  { w: '2026-05-02', yes: { insects: 4 }, obs: { insects: 4 }, sp: { insects: { monarch: 4 } } },
];

test('sumBins: yes/checked per class, species merged, chips filter, dominant by yes (mutant: dominant from obs → fruits/leaves order flips)', () => {
  const live = sumBins(weeks.slice(0, 2));
  assert.deepEqual(live.yes, { leaves: 3, flowers: 1, birds: 2 });
  assert.deepEqual(live.obs, { leaves: 6, flowers: 4, fruits: 2, birds: 2 });
  assert.deepEqual(live.sp.leaves, { 'red maple': 2, 'sugar maple': 1 });
  assert.equal(live.total, 6);
  assert.equal(live.checked, 14);
  assert.equal(live.dominant, 'leaves');
  const noLeaves = sumBins(weeks.slice(0, 2), { leaves: false });
  assert.equal(noLeaves.dominant, 'birds', 'hidden class cannot be dominant');
  assert.equal(noLeaves.total, 3);
  assert.equal(noLeaves.obs.leaves, undefined, 'hidden class is not counted as checked either');
  assert.equal(sumBins([]).dominant, null);
  assert.equal(classColor('flowers'), CLASSES[1].color);
  assert.equal(classColor(null), NO_YES_COLOR);
});

test('describeSite: in-scope classes with yes-of-checked and species, caveat, source (mutant: filter on yes>0 → "fruits: none of 2" line disappears)', () => {
  const p = { site: 24702, st: 'AZ', n: 10, weeks };
  const live = binsAt(weeks, null, '2026-09-12');
  const html = describeSite(p, live, sumBins(live.bins), { name: 'USA-NPN', url: 'https://u', licence: 'CC BY 4.0' });
  assert.match(html, /site 24702, AZ.*last 8 weeks to 2026-09-12: 6 "yes" reports of 14 phenophase checks.*leaves: <b>3 yes<\/b> of 6 reports · red maple \(2\), sugar maple \(1\).*flowers: <b>1 yes<\/b> of 4 reports · goldenrod \(1\).*fruits: none of 2 reports.*birds present \(arrival\): <b>2 yes<\/b> of 2 reports.*10 "yes" reports at this site.*not a census.*https:\/\/u.*CC BY 4.0/s);
  assert.doesNotMatch(html, /monarch/, 'May bin is outside the live window');
  const may = binsAt(weeks, '2026-05-01T12:00:00Z', '2026-09-12');
  assert.match(describeSite(p, may, sumBins(may.bins)), /week ending 2026-05-02: 4 "yes" reports of 4 phenophase checks.*insect activity\/emergence: <b>4 yes<\/b> of 4 reports · monarch \(4\)/s);
});

test('layer: contract, observed-time recolour, chips, legend counts, records against a real-shaped file (mutant: activeCounts counts total>=0 → none=1 leaks into active)', async () => {
  const gj = { type: 'FeatureCollection', today: '2026-09-12', newest: '2026-09-12', source: { name: 'USA-NPN', licence: 'CC BY 4.0', url: 'https://u' }, features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-111.84223, 33.76149] }, properties: { site: 24702, st: 'AZ', n: 10, classes: { leaves: 3, flowers: 1, birds: 2, insects: 4 }, weeks } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-83.25099, 42.60254] }, properties: { site: 10145, st: 'MI', n: 0, classes: {}, weeks: [{ w: '2026-09-12', yes: {}, obs: { birds: 3 }, sp: {} }] } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createPhenologyLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime', 'setParams', 'getParams', 'setRowControlsListener']) assert.equal(typeof l[k], 'function');
    assert.equal(l.id, 'phenology');
    assert.equal(l.icon, '🌸');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 2);
    assert.equal(l.getStats().error, null);
    assert.equal(l.getStats().active, 1);
    assert.deepEqual(l.getStats().classes, { leaves: 1, flowers: 1, birds: 1 });
    const faded = ds.entities.getById('phenology:1');
    assert.ok(faded.point.color.getValue().alpha < 0.3, 'checked-only site is faded');
    assert.equal(ds.entities.getById('phenology:0').point.color.getValue().alpha, 1);
    // chips: one per class, toggling hides the class from colour + counts
    const rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.id), ['leaves', 'flowers', 'fruits', 'insects', 'birds']);
    assert.equal(rc.legend.find((i) => i.label === 'leaves reported').count, 1);
    assert.equal(rc.legend.find((i) => i.label === 'fruits reported').count, 0);
    assert.match(rc.legend.at(-1).label, /last 8 weeks.*newest 2026-09-12.*1 active/);
    assert.equal(l.setParams({ leaves: false }), true);
    assert.equal(l.setParams({ leaves: false }), false, 'no change → false');
    assert.equal(l.getParams().leaves, false);
    assert.equal(l.getRowControls().chips[0].state, 'idle');
    assert.equal(l.getRowControls().legend.find((i) => i.label === 'leaves reported'), undefined, 'hidden class leaves the legend');
    assert.equal(ds.entities.getById('phenology:0').properties.dominant.getValue(), 'birds');
    l.setParams({ leaves: true });
    // observed time: May bin → insects dominate; empty week → faded
    assert.equal(l.setObservedTime('2026-05-01T00:00:00Z'), true);
    assert.equal(ds.entities.getById('phenology:0').properties.dominant.getValue(), 'insects');
    assert.deepEqual(l.getStats().classes, { insects: 1 });
    assert.match(l.getRowControls().legend.at(-1).label, /week of the observed time/);
    assert.equal(l.setObservedTime('2026-01-01T00:00:00Z'), true);
    assert.equal(l.getStats().active, 0);
    assert.equal(l.setObservedTime('bad'), false);
    // mutant: drop `!_dataSource.show` from getAnalystRecords → the hidden-layer check returns 1. The check
    // runs live (1 active site) so it is not vacuous; enable() below is the positive control.
    assert.equal(l.setObservedTime(null), true);
    assert.equal(l.getStats().active, 1);
    assert.equal(l.getAnalystRecords().length, 0, 'hidden layer → no records');
    l.enable();
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].reports, 6);
    assert.equal(recs[0].dominant, 'leaves');
    assert.equal(recs[0].site, 24702);
    l.destroy({ dataSources: { remove() {} } });
    assert.equal(l.getStats().count, 0);
  } finally { globalThis.fetch = saved; }
});
