// src/data/neon-vectors.test.mjs — site-series contract, two kinds (ticks, mosquitoes) per NEON site with monthly bins.
// Bins are shaped from pipeline/neon_vectors.py output (fields drags/area_m2/per1000/stages/genera, traps/trap_hours/per_trapnight).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthAt, binRate, describeSite, siteEntity, createNeonVectorsLayer } from './neon-vectors.js';

const ticks = [
  { m: '2026-07', release: 'PROVISIONAL', drags: 6, area_m2: 950, count: null, per1000: null, stages: {}, genera: {}, pending: true },
  { m: '2025-09', release: 'PROVISIONAL', drags: 6, area_m2: 960, count: 144, per1000: 150.0, stages: { larva: 120, nymph: 20, adult: 4 }, genera: { unidentified: 120, Ixodes: 24 }, pending: false },
];
const mosquitoes = [
  { m: '2026-07', release: 'PROVISIONAL', traps: 40, trap_hours: 480.0, count: 900, per_trapnight: 45.0, genera: { Coquillettidia: 600, Aedes: 300 }, pending: false },
];
const feat = (props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-72.17266, 42.53691] }, properties: { site: 'HARV', name: 'Harvard Forest', site_type: 'CORE', ...props } });

test('monthAt: live = newest bin; instant = its calendar month; none when not sampled that month', () => {
  // mutants: `list.find((b) => !b.pending)` → `list[0]` (live picks the pending 2026-07); fallback `list[0]` → `list.at(-1)`
  assert.equal(monthAt(ticks, null).bin.m, '2025-09', 'live = newest month with a lab count, not the pending newer one');
  assert.match(monthAt(ticks, null, 'drags').label, /latest identified drags, 2025-09/);
  const allPending = [ticks[0], { ...ticks[0], m: '2026-05' }];
  assert.equal(monthAt(allPending, null).bin.m, '2026-07', 'no identified month: newest pending bin is shown');
  assert.equal(monthAt(ticks, '2025-09-30T23:00:00Z').bin.m, '2025-09');
  assert.equal(monthAt(ticks, '2026-08-15T00:00:00Z').bin, null);
  assert.match(monthAt(ticks, '2026-08-15T00:00:00Z', 'drags').label, /no drags in 2026-08/);
  assert.equal(monthAt(ticks, 'garbage').bin, null);
  assert.equal(monthAt([], null).bin, null);
});

test('binRate: ticks per 1000 m² with drag effort, mosquitoes per trap-night with trap-hours', () => {
  // mutant seen failing: kind test inverted (ticks read per_trapnight → undefined)
  assert.deepEqual(binRate('ticks', ticks[1]), { rate: 150, effort: '6 drags over 960 m²' });
  assert.deepEqual(binRate('mosquitoes', mosquitoes[0]), { rate: 45, effort: '40 traps, 480 trap-hours' });
  assert.deepEqual(binRate('ticks', null), { rate: null, effort: '' });
});

test('describeSite: rate + effort, life-stage and genus breakdown, pending month, caveat, licence', () => {
  // mutant seen failing: stages line dropped from the ticks description
  const src = { name: 'NSF NEON ticks and mosquitoes', url: 'https://t', url_mosquitoes: 'https://m', licence: 'CC BY 4.0' };
  const t = describeSite(feat({}).properties, 'ticks', monthAt(ticks, '2025-09-10T00:00:00Z', 'drags'), src);
  assert.match(t, /Harvard Forest.*HARV.*ticks<br>drags in 2025-09: 144 ticks in 6 drags over 960 m² = <b>150<\/b> per 1000 m² dragged · provisional/s);
  assert.match(t, /life stages — larva: 120 · nymph: 20 · adult: 4.*genera — <i>unidentified<\/i>: 120 · <i>Ixodes<\/i>: 24.*own history only.*https:\/\/t.*CC BY 4\.0/s);
  const pend = describeSite(feat({}).properties, 'ticks', monthAt(ticks, '2026-07-10T00:00:00Z', 'drags'), src);
  assert.match(pend, /identification pending/);
  assert.doesNotMatch(pend, /life stages/, 'no breakdown while pending');
  const m = describeSite(feat({}).properties, 'mosquitoes', monthAt(mosquitoes, null, 'trapping'), src);
  assert.match(m, /900 mosquitoes in 40 traps, 480 trap-hours = <b>45<\/b> per trap-night.*<i>Coquillettidia<\/i>: 600.*24 trap-hours.*https:\/\/m/s);
  assert.doesNotMatch(m, /life stages/, 'mosquitoes have no life-stage line');
  assert.match(describeSite({ name: '<x>', site: 'X' }, 'ticks', { bin: null, label: 'no drags in 2026-01' }), /&lt;x&gt;.*no drags in 2026-01/s);
});

test('siteEntity: size from rate, pending faded + inactive, hidden kind not shown, ring for mosquitoes', () => {
  // mutants seen failing: `active = shown && !!b` (pending counted active); log size term removed (sizes equal)
  const f = feat({ ticks, mosquitoes });
  const ctx = { visible: { ticks: true, mosquitoes: true }, source: {} };
  const sep = siteEntity(f, 0, 'ticks', '2025-09-10T00:00:00Z', ctx);
  assert.equal(sep.id, 'nv:ticks:0');
  assert.equal(sep.properties.active, true);
  assert.equal(sep.properties.rate, 150);
  assert.equal(sep.point.color.alpha, 1);
  const live = siteEntity(f, 0, 'ticks', '2026-07-10T00:00:00Z', ctx);
  assert.equal(live.properties.pending, true);
  assert.equal(live.properties.active, false);
  assert.ok(live.point.color.alpha < 0.3);
  assert.ok(live.point.pixelSize < sep.point.pixelSize);
  assert.equal(live.show, true, 'pending month is drawn (faded), not hidden');
  const mos = siteEntity(f, 0, 'mosquitoes', null, ctx);
  assert.equal(mos.properties.active, true);
  assert.equal(mos.point.outlineWidth, 2);
  const hid = siteEntity(f, 0, 'mosquitoes', null, { ...ctx, visible: { ticks: true, mosquitoes: false } });
  assert.equal(hid.show, false);
  assert.equal(hid.properties.active, false);
  assert.equal(siteEntity(f, 0, 'mosquitoes', '2026-01-01T00:00:00Z', ctx).show, false);
});

test('layer: contract, one mark per kind with data, chips, legend newest month, observed time, records, stats', async () => {
  // mutants seen failing: rebuild skips the empty-series guard (3→4 marks); legend newest month from months[k].at(-1)
  const gj = { type: 'FeatureCollection', generated_at: '2026-09-12T00:00:00Z', source: { name: 'NEON', licence: 'CC BY 4.0' },
    months: { ticks: ['2026-07', '2025-09'], mosquitoes: ['2026-07'] },
    features: [feat({ ticks, mosquitoes }), { ...feat({ site: 'OSBS', name: 'Ordway', ticks: [], mosquitoes: [{ ...mosquitoes[0], m: '2026-06' }] }) }] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createNeonVectorsLayer();
    assert.equal(l.id, 'neon-vectors');
    assert.equal(l.name, 'Ticks and mosquitoes (NEON)');
    assert.equal(l.icon, '🪳');
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setRowControlsListener', 'setParams', 'getParams', 'setObservedTime']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    let pinged = 0; l.setRowControlsListener(() => pinged++);
    assert.equal(await l.update(), true);
    assert.equal(pinged, 1);
    assert.equal(ds.entities.values.length, 3, 'HARV ticks + HARV mosquitoes + OSBS mosquitoes');
    assert.equal(l.getStats().error, null);
    assert.equal(l.getStats().count, 2);
    assert.equal(l.getStats().active, 3, 'live: HARV ticks fall back to the identified 2025-09 month, not the pending 2026-07');
    let rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.label), ['TICKS', 'MOSQUITOES']);
    assert.match(rc.legend[0].label, /ticks per 1000 m² dragged, newest month 2026-07/);
    assert.equal(rc.legend[0].count, 1);
    assert.match(rc.legend.at(-1).label, /latest identified month · faded = no month identified by the lab yet · 3 marks/);
    assert.equal(rc.legend[1].count, 2);
    assert.equal(l.getAnalystRecords().length, 0, 'disabled layer yields no records');
    l.enable();
    const recs = l.getAnalystRecords();
    assert.deepEqual(recs.map((r) => [r.site, r.kind, r.rate]).sort(), [['HARV', 'mosquitoes', 45], ['HARV', 'ticks', 150], ['OSBS', 'mosquitoes', 45]]);
    assert.equal(l.setObservedTime('2025-09-15T00:00:00Z'), true);
    assert.equal(l.getStats().active, 1, 'only HARV ticks in 2025-09');
    assert.match(l.getRowControls().legend.at(-1).label, /month of the observed time/);
    assert.equal(l.setParams({ ticks: false }), true);
    assert.equal(l.getStats().active, 0);
    assert.equal(l.getRowControls().chips[0].active, false);
    assert.equal(l.setParams({ ticks: false }), false);
    assert.equal(l.setParams({ bogus: true }), false);
    assert.equal(l.setObservedTime('bad'), false);
    assert.equal(l.setObservedTime(null), true);
    l.destroy({ dataSources: { remove() {} } });
    assert.equal(l.getStats().count, 0);
  } finally { globalThis.fetch = saved; }
});

test('layer: HTTP error and malformed file surface in getStats, not silently', async () => {
  // mutant seen failing: `if (!res.ok)` branch removed (json() of the 404 body throws a different message)
  const saved = globalThis.fetch;
  try {
    const l = createNeonVectorsLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error('no body'); } });
    assert.equal(await l.update(), false);
    assert.equal(l.getStats().error, 'neon-vectors.geojson HTTP 404');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /Malformed/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) });
    assert.equal(await l.update(), true, 'positive control: a valid empty file loads');
    assert.equal(l.getStats().error, null);
  } finally { globalThis.fetch = saved; }
});
