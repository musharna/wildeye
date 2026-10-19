// src/data/birds.test.mjs — pure helpers + layer contract for the radar bird layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapBirdRecord, birdColumn, headingColor, createBirdsLayer, drapeFade, frameIdAtOrBefore, RAIN_SHARE, SAMPLING_ERROR, mostlyNotBirds, describe, columnEntity, nightText, nightLines, nightSpark } from './birds.js';

test('birds: analyst record maps fields and nulls', () => {
  const r = mapBirdRecord({ site: 'KOKX', name: 'Upton NY', density_birds_km3: 12.5, heading_deg: 200, speed_ms: 9, peak_altitude_m: 600, scan_time: '2026-09-11T00:12:10Z', stale: false, lat: 40.9, lon: -72.9 }, 0);
  assert.deepEqual(r, { id: 'KOKX', name: 'Upton NY', densityBirdsKm3: 12.5, headingDeg: 200, speedMs: 9, peakAltitudeM: 600, scanTime: '2026-09-11T00:12:10Z', stale: false, lat: 40.9, lon: -72.9 });
  const n = mapBirdRecord({ density_birds_km3: NaN }, 4);
  assert.equal(n.id, 'RADAR-0004');
  assert.equal(n.densityBirdsKm3, null);
});

test('birds: column height is monotone, floored, capped', () => {
  assert.equal(birdColumn(null), 0);
  assert.equal(birdColumn(0), 0);
  assert.ok(birdColumn(1) < birdColumn(50));
  assert.ok(birdColumn(1e6) <= 120000);
});

test('birds: heading colour is defined for nulls', () => {
  assert.ok(headingColor(null));
  assert.notDeepEqual(headingColor(0), headingColor(180));
});

test('birds: layer contract', () => {
  const l = createBirdsLayer();
  assert.equal(l.id, 'birds');
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords']) assert.equal(typeof l[k], 'function');
  assert.deepEqual(l.getAnalystRecords(), []);
  assert.equal(l.getStats().particles, 0);
  assert.equal(l.getStats().drapes, 0);
});

test('birds: drape fade is 1 near, 0 far, monotone between', () => {
  assert.equal(drapeFade(100000), 1);
  assert.equal(drapeFade(3000000), 0);
  const mid = drapeFade(1400000);
  assert.ok(mid > 0 && mid < 1);
  assert.ok(drapeFade(1000000) > drapeFade(1800000));
});

test('birds: component params toggle and drive row chips', () => {
  const l = createBirdsLayer();
  assert.deepEqual(l.getParams(), { columns: false, drape: true, particles: true });
  assert.equal(l.setParams({ drape: false }), true);
  assert.equal(l.setParams({ drape: false }), false);
  assert.equal(l.setParams({ drape: 'no' }), false);
  const chips = l.getRowControls().chips;
  const drape = chips.find((c) => c.id === 'drape');
  assert.equal(drape.active, false);
  assert.deepEqual(drape.params, { drape: true });
  assert.equal(chips.length, 3);
});

test('birds: replay mode gate — update() is a no-op in replay and live resumes', async () => {
  const l = createBirdsLayer();
  assert.equal(l.getMode(), 'live');
  assert.equal(l.getStats().mode, 'live');
  assert.equal(l.getReplayInfo(), null);
});

test('birds: manifest is re-read on live update so new archive frames reach the slider', async () => {
  const l = createBirdsLayer();
  const frames = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-09-11T0${i}`, { dir: `d${i}` }]));
  let manifest = { frames: frames(2) };
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('manifest.json')) return { ok: true, json: async () => JSON.parse(JSON.stringify(manifest)) };
    if (String(url).includes('birds.geojson')) return { ok: true, json: async () => ({ features: [], generated_at: 'x' }) };
    return { ok: false, status: 404 };
  };
  try {
    l.init({ dataSources: { add() {}, remove() {} }, scene: {} });
    assert.equal((await l._loadManifest()).ids.length, 2);
    manifest = { frames: frames(3) };            // cron appended an hour
    assert.equal((await l._loadManifest()).ids.length, 2, 'plain call stays memoised');
    assert.equal(await l.update(), true);
    assert.equal(l.getReplayInfo().frames, 3, 'live update refreshes the manifest');
    // failure keeps the last good manifest rather than blanking it
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.equal((await l._loadManifest(true)).ids.length, 3);
  } finally { globalThis.fetch = saved; l.destroy({ dataSources: { remove() {} }, scene: {} }); }
});

test('birds: frameIdAtOrBefore picks the newest hourly frame not after the instant', () => {
  const ids = ['2026-09-10T22', '2026-09-10T23', '2026-09-11T00'];
  assert.equal(frameIdAtOrBefore(ids, '2026-09-10T23:40:00Z'), '2026-09-10T23');
  assert.equal(frameIdAtOrBefore(ids, '2026-09-11T00:00:00Z'), '2026-09-11T00');
  assert.equal(frameIdAtOrBefore(ids, '2026-09-10T01:00:00Z'), null);
  assert.equal(frameIdAtOrBefore(ids, 'nope'), null);
});

test('birds: setObservedTime enters replay on the matching frame and null returns to live', async () => {
  const l = createBirdsLayer();
  const manifest = { frames: { '2026-09-10T22': { dir: 'a' }, '2026-09-10T23': { dir: 'b' } } };
  const shown = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('manifest.json')) return { ok: true, json: async () => JSON.parse(JSON.stringify(manifest)) };
    if (u.includes('birds.geojson')) return { ok: true, json: async () => ({ features: [], generated_at: 'x' }) };
    return { ok: false, status: 404 };
  };
  try {
    l.init({ dataSources: { add() {}, remove() {} }, scene: {} });
    l._showFrame = async (id) => { shown.push(id); };
    assert.equal(await l.setObservedTime('2026-09-10T23:30:00Z'), true);
    assert.equal(l.getMode(), 'replay');
    assert.deepEqual(l.getReplayInfo(), { frames: 2, index: 1, frameId: '2026-09-10T23' });
    assert.equal(await l.setObservedTime('2026-09-10T23:59:00Z'), true);
    assert.deepEqual(shown, ['2026-09-10T23'], 'same frame is not re-fetched');
    assert.equal(await l.setObservedTime('2026-09-01T00:00:00Z'), false, 'before the archive: nothing to show');
    assert.equal(await l.update(), true, 'poll is a no-op in replay');
    assert.equal(await l.setObservedTime(null), true);
    assert.equal(l.getMode(), 'live');
  } finally { globalThis.fetch = saved; l.destroy({ dataSources: { remove() {} }, scene: {} }); }
});

test('birdsLegend: heading wheel only when a heading-coloured component is on; height rule only with columns', async () => {
  const { birdsLegend } = await import('./birds.js');
  const all = birdsLegend({ columns: true, drape: true, particles: true });
  assert.deepEqual(all.slice(0, 4).map((i) => i.label), ['→ N', '→ E', '→ S', '→ W']);
  assert.equal(new Set(all.slice(0, 4).map((i) => i.color)).size, 4, 'four distinct hues');
  assert.ok(all.some((i) => /column height/.test(i.label)) && all.some((i) => /radar/.test(i.label)));
  const drapeOnly = birdsLegend({ columns: false, drape: true, particles: false });
  assert.deepEqual(drapeOnly.map((i) => i.label), ['radar: probable biological echo (rain masked)']);
  assert.deepEqual(birdsLegend({ columns: false, drape: false, particles: false }), []);
  // the layer itself must surface it (default params: drape + flow on)
  assert.equal(createBirdsLayer().getRowControls().legend.length, 5);
});

test('birds: a scan whose echo was mostly not birds is flagged at the gauge-checked threshold', () => {
  const doc = JSON.parse(readFileSync(new URL('../../docs/analysis/bird_rain.json', import.meta.url)));
  assert.equal(RAIN_SHARE, doc.threshold, 'the globe uses the threshold the gauge check chose');
  assert.equal(doc.ships, true);
  // the popup's night marker uses the same threshold on a night's weighted share: kept only while that use passes
  const nights = JSON.parse(readFileSync(new URL('../../docs/analysis/bird_rain_nights.json', import.meta.url)));
  assert.equal(nights.threshold, RAIN_SHARE);
  assert.equal(nights.keep_marker, true);
  assert.equal(mostlyNotBirds({ bio_gate_share: 0.003 }), true);
  assert.equal(mostlyNotBirds({ bio_gate_share: 0.549 }), true);
  assert.equal(mostlyNotBirds({ bio_gate_share: 0.55 }), false, 'the threshold itself is birds');
  assert.equal(mostlyNotBirds({ bio_gate_share: 0.78 }), false);
  for (const p of [{ bio_gate_share: null }, {}, null, { bio_gate_share: '0.1' }]) assert.equal(mostlyNotBirds(p), false);
  const base = { site: 'KDIX', name: 'Fort Dix NJ', density_birds_km3: 3.2, heading_deg: 200, speed_ms: 9, peak_altitude_m: 400, scan_time: 't' };
  const rain = describe({ ...base, bio_gate_share: 0.003 }, 6000);
  assert.match(rain, /Mostly rain or clutter: only 0% of the echo/);
  assert.match(rain, /3\.2 birds\/km³/, 'the count is still shown');
  const clear = describe({ ...base, bio_gate_share: 0.78 }, 6000);
  assert.doesNotMatch(clear, /Mostly rain/);
  assert.match(clear, /Compare nights at this radar/);
  assert.match(describe({ ...base, density_birds_km3: 0, bio_gate_share: 0.01 }, 0), /Mostly rain or clutter.*Quiet/);
  const alpha = (props) => columnEntity({ geometry: { coordinates: [-74.4, 40.0] }, properties: { ...base, ...props } })
    .cylinder.material.color.getValue().alpha;
  assert.equal(alpha({ bio_gate_share: 0.003 }), 0.25, 'mostly rain: faded like a stale scan');
  assert.equal(alpha({ bio_gate_share: 0.78 }), 0.6);
  assert.equal(alpha({}), 0.6, 'no share (Aloft profiles) is not faded');
});

test('birds: popups carry the night totals as the pipeline wrote them', () => {
  // birds_nights.json as served 2026-10-19 02:00 UTC, three radars (fixtures/README.md)
  const doc = JSON.parse(readFileSync(new URL('./fixtures/birds_nights_20261019.json', import.meta.url)));
  const now = Date.parse(doc.generated_at);
  assert.deepEqual(nightLines(doc.sites.KAKQ, now), [
    'Tonight so far: 5,970 birds crossed each km, peak 3,580/km/h at 01:46 UTC',
    'Last night (2026-10-17): 126,000 birds crossed each km (± 8% from 10-minute sampling), peak 20,100/km/h at 02:10 UTC',
  ]);
  // tonight at 23% coverage gets no coverage note (the night is not over); its share 0.438 is mostly rain
  assert.equal(nightLines(doc.sites.KMLB, now)[0], 'Tonight so far: 20,600 birds crossed each km, peak 13,100/km/h at 00:05 UTC; mostly rain or clutter, unreliable');
  // a complete night that was rainy and 40% covered says both, and carries no error bar (the total is unreliable)
  assert.equal(nightText(doc.sites.KAKQ[0]), '1,780 birds crossed each km, peak 1,200/km/h at 05:53 UTC; mostly rain or clutter, unreliable; scans cover 40% of the night');
  // before sunset there is no "tonight", only last night
  assert.deepEqual(nightLines(doc.sites.KLOT, Date.parse('2026-10-18T22:00:00Z')).map((l) => l.split(':')[0]), ['Last night (2026-10-17)']);
  assert.equal(nightText({ mt_birds_km: null, complete: false }), 'no scans');
  assert.deepEqual(nightLines(null, now), []);
  const p = { site: 'KAKQ', name: 'Wakefield VA', density_birds_km3: 3.2, heading_deg: 200, speed_ms: 9, peak_altitude_m: 400, scan_time: 't', bio_gate_share: 0.8 };
  const html = describe(p, 6000, doc.sites.KAKQ, now);
  assert.match(html, /scan t<br>Tonight so far: 5,970 birds crossed each km.*<br>Last night \(2026-10-17\): 126,000/);
  assert.doesNotMatch(describe(p, 6000), /Tonight|Last night/, 'no nights (replay frames): no night lines');
});

test('birds: the night error bar is the sampling check\'s q, shown only while that check passes', () => {
  const doc = JSON.parse(readFileSync(new URL('../../docs/analysis/bird_sampling.json', import.meta.url)));
  assert.equal(doc.ships, true, 'the error bar ships only while the held-out nights pass');
  assert.equal(SAMPLING_ERROR, Math.round(doc.q * 1000) / 1000);
  const night = { mt_birds_km: 4000, complete: true, bio_gate_share: 0.8 };
  assert.equal(nightText(night), '4,000 birds crossed each km (± 8% from 10-minute sampling)');
  assert.equal(nightText({ ...night, complete: false }), '4,000 birds crossed each km', 'tonight is not finished');
  assert.equal(nightText({ ...night, bio_gate_share: 0.3 }), '4,000 birds crossed each km; mostly rain or clutter, unreliable');
  assert.equal(nightText({ ...night, bio_gate_share: undefined }), '4,000 birds crossed each km (± 8% from 10-minute sampling)');
});

test('birds: update() feeds the night totals into the popups and keeps the last good file on failure', async () => {
  const l = createBirdsLayer();
  const doc = JSON.parse(readFileSync(new URL('./fixtures/birds_nights_20261019.json', import.meta.url)));
  const gj = { generated_at: 'g', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-77.0, 36.98] },
    properties: { site: 'KAKQ', name: 'Wakefield VA', density_birds_km3: 3.2, heading_deg: 200, speed_ms: 9, peak_altitude_m: 400, scan_time: 't', bio_gate_share: 0.8 } }] };
  let nightsOk = true;
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('birds_nights.json')) return nightsOk ? { ok: true, json: async () => doc } : { ok: false, status: 503 };
    if (u.includes('birds.geojson')) return { ok: true, json: async () => gj };
    return { ok: false, status: 404 };
  };
  let ds = null;
  const viewer = { dataSources: { add(d) { ds = d; }, remove() {} }, scene: {} };
  try {
    l.init(viewer);
    l._updateField = async () => {};
    const popup = () => ds.entities.getById('birds:KAKQ').description.getValue();
    assert.equal(await l.update(), true, `update failed: ${l.getStats().error}`);
    assert.equal(l.getStats().nightsError, null);
    assert.match(popup(), /Last night \(2026-10-17\): 126,000 birds crossed each km/);
    nightsOk = false;
    assert.equal(await l.update(), true, 'a nights failure does not fail the layer');
    assert.equal(l.getStats().nightsError, 'birds_nights.json HTTP 503');
    assert.match(popup(), /Last night \(2026-10-17\): 126,000/, 'the last good night totals are kept');
  } finally { globalThis.fetch = saved; l.destroy({ dataSources: { remove() {} }, scene: {} }); }
});

test('birds: the popup sparkline is the radar against its own nights, log scale, rain and gaps marked', () => {
  // birds_nights.json as served 2026-10-19 02:49 UTC after seeding 20 past nights (fixtures/README.md); the
  // expected bars were computed independently in Python from the same file
  const doc = JSON.parse(readFileSync(new URL('./fixtures/birds_nights_history_20261019.json', import.meta.url)));
  assert.equal(nightSpark(doc.sites.KAKQ), 'Last 14 nights: ▆█▆▃▆▅×▄▇▄▆▅×█ (high 174,000 on 10-05; log scale; × rain)');
  assert.equal(nightSpark(doc.sites.KBUF), 'Last 14 nights: ············█▇ (high 7,170 on 10-16; log scale; × rain)');
  const n = (night, mt, share = 0.8) => ({ night, complete: true, mt_birds_km: mt, bio_gate_share: share });
  // three decades: the top night is the top bar, a night 1000x lower the bottom, 31.6x lower the middle
  assert.equal(nightSpark([n('2026-10-01', 1e5), n('2026-10-02', 1e2), n('2026-10-03', 1e5 / 10 ** 1.5)]).split(' ')[3], '█▁▅');
  assert.equal(nightSpark([n('2026-10-01', 1e5), n('2026-10-02', 1), n('2026-10-03', 0)]).split(' ')[3], '█▁▁', 'below the floor and zero sit on the bottom');
  // a rain night is never the top, even when its count is the largest; one decade down is bar 5 of 0-7 (4.67 rounds up)
  assert.match(nightSpark([n('2026-10-01', 1e6, 0.1), n('2026-10-02', 1e3), n('2026-10-03', 1e2)]), /: ×█▆ \(high 1,000 on 10-02/);
  // only complete nights, only the last 14
  const many = Array.from({ length: 20 }, (_, i) => n(`2026-10-${String(i + 1).padStart(2, '0')}`, 1000 + i));
  assert.match(nightSpark([...many, { night: '2026-10-21', complete: false, mt_birds_km: 1e9 }]), /^Last 14 nights: .{14} \(high 1,020 on 10-20/u);
  assert.equal(nightSpark(many.slice(0, 2)), null, 'fewer than 3 complete nights: no sparkline');
  assert.equal(nightSpark([n('2026-10-01', null), n('2026-10-02', null), n('2026-10-03', 5, 0.1)]), null, 'nothing to scale against');
  assert.equal(nightSpark(null), null);
  const p = { site: 'KAKQ', name: 'Wakefield VA', density_birds_km3: 3.2, heading_deg: 200, speed_ms: 9, peak_altitude_m: 400, scan_time: 't', bio_gate_share: 0.8 };
  assert.match(describe(p, 6000, doc.sites.KAKQ, Date.parse(doc.generated_at)), /Last night \(2026-10-17\)[^<]*<br>Last 14 nights: ▆█/);
});
