// src/data/h5n1.test.mjs — site-series contract for H5N1 sampled spread: bins, sums, info box, place entity, layer contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { binsAt, sumWeeks, describePlace, placeEntity, createH5n1Layer, WINDOW_WEEKS, hostColor, HOST_COLORS } from './h5n1.js';

const weeks = [
  { w: '2026-07-12', n: { cattle: 30, poultry: 2 }, c: { 'B3.13': 30, 'D1.1': 2 } },
  { w: '2026-07-05', n: { 'wild bird': 7 }, c: { 'D1.1': 7 } },
  { w: '2026-01-11', n: { poultry: 50 }, c: { 'D1.1': 50 } },
];

test('binsAt: live = newest 13 weeks of the record; instant = its 7-day bin; nothing outside', () => {
  // Mutant: WINDOW_WEEKS - 1 → WINDOW_WEEKS * 30 lets the January bin into live — caught by the first deepEqual.
  const live = binsAt(weeks, null, '2026-07-12');
  assert.deepEqual(live.bins.map((b) => b.w), ['2026-07-12', '2026-07-05']);
  assert.match(live.label, new RegExp(`last ${WINDOW_WEEKS} weeks to 2026-07-12`));
  assert.deepEqual(binsAt(weeks, '2026-07-06T00:00:00Z', '2026-07-12').bins.map((b) => b.w), ['2026-07-12'], 'w−6 d is inside');
  assert.deepEqual(binsAt(weeks, '2026-07-05T23:00:00Z', '2026-07-12').bins.map((b) => b.w), ['2026-07-05'], 'w−7 d is the previous bin');
  const none = binsAt(weeks, '2026-09-01T00:00:00Z', '2026-07-12');
  assert.equal(none.bins.length, 0);
  assert.match(none.label, /no sequenced samples in the week of 2026-09-01/);
  assert.equal(binsAt(weeks, 'garbage', 'x').bins.length, 0);
  assert.equal(binsAt(undefined, null, null).bins.length, 0);
});

test('sumWeeks hides categories but keeps genotype counts; colours fall back to other', () => {
  // Mutant: dropping the `visible[k] !== false` filter — caught by the cattle-hidden total (positive control: the full sum).
  assert.deepEqual(sumWeeks(weeks.slice(0, 2)), { n: { cattle: 30, poultry: 2, 'wild bird': 7 }, c: { 'B3.13': 30, 'D1.1': 9 }, total: 39 });
  assert.equal(sumWeeks(weeks.slice(0, 2), { cattle: false }).total, 9);
  assert.equal(hostColor('nonsense'), HOST_COLORS.other);
  assert.notEqual(hostColor('cattle'), HOST_COLORS.other);
});

test('describePlace escapes, lists hosts and genotypes, flags a country centroid, carries the effort caveat', () => {
  // Mutant: removing esc() around p.loc — caught by the &lt;Idaho&gt; match.
  const scope = binsAt(weeks, null, '2026-07-12');
  const html = describePlace({ loc: '<Idaho>', level: 'division', country: 'USA', n: 89 }, scope, sumWeeks(scope.bins), { name: 'NS', url: 'https://u' });
  assert.match(html, /&lt;Idaho&gt;, USA.*last 13 weeks to 2026-07-12: 39 sequenced H5N1 samples.*cattle: 30 · wild bird: 7 · poultry: 2.*GenoFLU genotype: B3\.13 \(30\), D1\.1 \(9\).*89 samples.*United States only.*B3\.13 and D1\.1.*sequencing effort.*https:\/\/u.*public domain/s);
  assert.doesNotMatch(html, /centroid/, 'a division is not flagged');
  assert.match(describePlace({ loc: 'USA', level: 'country', country: 'USA' }, scope, sumWeeks([])), /country centroid.*0 sequenced H5N1 samples/s);
});

test('placeEntity: size grows with samples, colour = dominant visible host, fades when empty', () => {
  // Mutant: alpha always 1 — caught by the faded assertion.
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [-114.35, 43.81] }, properties: { loc: 'Idaho', level: 'division', country: 'USA', weeks } };
  const ctx = { dataEnd: '2026-07-12', visible: {}, source: {} };
  const live = placeEntity(f, 3, null, ctx);
  assert.equal(live.id, 'h5n1:3');
  assert.equal(live.properties.total, 39);
  assert.equal(live.properties.dominant, 'cattle');
  assert.equal(live.point.color.alpha, 1);
  const noCattle = placeEntity(f, 3, null, { ...ctx, visible: { cattle: false } });
  assert.equal(noCattle.properties.dominant, 'wild bird');
  assert.ok(noCattle.point.pixelSize < live.point.pixelSize);
  const empty = placeEntity(f, 3, '2026-09-01T00:00:00Z', ctx);
  assert.equal(empty.properties.total, 0);
  assert.ok(empty.point.color.alpha < 0.3);
});

test('layer: contract, live window, observed week, chips, legend states record end, analyst records', async () => {
  // Mutant: getAnalystRecords without the total>0 filter returns 2 records live — caught by the length assertion.
  const gj = { type: 'FeatureCollection', data_end: '2026-07-12', categories: ['poultry', 'wild bird', 'cattle', 'human', 'other'], clades: ['B3.13', 'D1.1'], source: { name: 'NS' },
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-114, 43] }, properties: { loc: 'Idaho', level: 'division', country: 'USA', hosts: { cattle: 30, poultry: 52, 'wild bird': 7 }, weeks } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-98, 38] }, properties: { loc: 'USA', level: 'country', country: 'USA', hosts: { human: 1 }, weeks: [{ w: '2026-01-11', n: { human: 1 }, c: {} }] } },
    ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createH5n1Layer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setParams', 'getParams', 'setObservedTime', 'setRowControlsListener']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 2);
    assert.equal(l.getStats().active, 1);
    let rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.id), ['poultry', 'wild bird', 'cattle', 'human'], 'only present categories, in file order');
    assert.equal(rc.legend.find((i) => i.label === 'cattle').count, 1);
    assert.match(rc.legend.at(-1).label, /^US only \(open USDA\/NCBI builds\), genotypes B3\.13, D1\.1 .*ends 2026-07-12/);
    l.setObservedTime('2026-01-10T12:00:00Z');
    assert.equal(l.getStats().active, 2);
    assert.equal(ds.entities.getById('h5n1:0').properties.dominant.getValue(), 'poultry');
    assert.match(l.getRowControls().legend.at(-1).label, /^US only, genotypes B3\.13, D1\.1 .*week of the observed time/);
    assert.equal(l.setParams({ human: false }), true);
    assert.equal(l.getStats().active, 1, 'hiding humans empties the USA point that week');
    assert.equal(l.setParams({ human: false }), false);
    assert.equal(l.setObservedTime('bad'), false);
    assert.equal(l.setObservedTime(null), true);
    assert.deepEqual(l.getAnalystRecords(), [], 'hidden layer yields no records');
    l.enable();
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].samples, 39);
    assert.equal(recs[0].loc, 'Idaho');
  } finally { globalThis.fetch = saved; }
});

test('real file: the gitignored live run public/data/h5n1.geojson loads through the layer (fails if absent — never the seed)', async () => {
  // Mutant: reading public/data/seed/h5n1.geojson instead — the path assertion below catches it.
  const path = new URL('../../public/data/h5n1.geojson', import.meta.url);
  assert.ok(path.pathname.endsWith('/public/data/h5n1.geojson') && !path.pathname.includes('/seed/'));
  assert.ok(existsSync(path), 'public/data/h5n1.geojson missing: run pipeline/run_h5n1.sh first');
  const text = readFileSync(path, 'utf8');
  const gj = JSON.parse(text);
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createH5n1Layer();
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    const s = l.getStats();
    assert.equal(s.error, null);
    assert.ok(s.count > 0 && ds.entities.values.length === s.count);
    assert.ok(s.active > 0, 'some place has samples in the live window');
    assert.deepEqual(gj.categories, ['poultry', 'wild bird', 'cattle', 'human', 'other']);
    for (const f of gj.features) for (const k of Object.keys(f.properties.hosts)) assert.ok(gj.categories.includes(k), k);
    assert.doesNotMatch(text, /"A\/[A-Za-z]/, 'no strain names in the shipped file');
    console.log(`real file: ${s.count} places, ${s.active} active, record to ${s.dataEnd}`);
  } finally { globalThis.fetch = saved; }
});
