// src/data/birds.test.mjs — pure helpers + layer contract for the radar bird layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapBirdRecord, birdColumn, headingColor, createBirdsLayer, drapeFade, frameIdAtOrBefore, RAIN_SHARE, SAMPLING_ERROR, mostlyNotBirds, nightDate, scanTime, particleText, heightLine, seasonLines, SEASON_COMPARE, BIN_M, describe, columnEntity, nightText, nightLines, nightSpark, airspeedLines, nightDates, AIRSPEED_NIGHTS, AIRSPEED_CUTOFF_MS } from './birds.js';

test('birds: BIN_M is the height step of real vol2bird and Aloft profiles', () => {
  const steps = (hs) => new Set(hs.slice(1).map((h, i) => h - hs[i]));
  const kokx = readFileSync(new URL('../../pipeline/tests/fixtures/KOKX_profile.txt', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => Number(l.trim().split(/\s+/)[2]));
  assert.deepEqual([...steps(kokx)], [BIN_M]);
  const rows = readFileSync(new URL('../../pipeline/tests/fixtures/seang_vpts_tail.csv', import.meta.url), 'utf8').trim().split('\n');
  const col = rows[0].split(',').indexOf('height');
  const aloft = [...new Set(rows.slice(1).map((r) => Number(r.split(',')[col])))].sort((a, b) => a - b);
  assert.deepEqual([...steps(aloft)], [BIN_M]);
  assert.equal(kokx[0], 0, 'positive control: the lowest real bin starts at 0');
});

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
  // vol2bird heights are the bottom of a 200 m bin above sea level: 0 is the lowest layer, not the ground
  assert.match(describe({ ...base, peak_altitude_m: 0 }, 6000), /9 m\/s, densest 0\u2060–\u2060200\u00a0m above sea level<br>/);
  assert.match(clear, /densest 400\u2060–\u2060600\u00a0m above sea level<br>/);
  assert.doesNotMatch(describe({ ...base, peak_altitude_m: 0 }, 6000), /peak 0/);
  assert.doesNotMatch(describe({ ...base, peak_altitude_m: null }, 6000), /densest|null|NaN/, 'no densest layer: the clause is left out');
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
    'Last night (Oct\u00a017): 126,000 birds crossed each km (±\u00a08% from 10-minute sampling), peak 20,100/km/h at 02:10 UTC',
  ]);
  // tonight at 23% coverage gets no coverage note (the night is not over); its share 0.438 is mostly rain
  assert.equal(nightLines(doc.sites.KMLB, now)[0], 'Tonight so far: 20,600 birds crossed each km, peak 13,100/km/h at 00:05 UTC; mostly rain or clutter, unreliable');
  // a complete night that was rainy and 40% covered says both, and carries no error bar (the total is unreliable)
  assert.equal(nightText(doc.sites.KAKQ[0]), '1,780 birds crossed each km, peak 1,200/km/h at 05:53 UTC; mostly rain or clutter, unreliable; scans cover 40% of the night');
  // before sunset there is no "tonight", only last night
  assert.deepEqual(nightLines(doc.sites.KLOT, Date.parse('2026-10-18T22:00:00Z')).map((l) => l.split(':')[0]), ['Last night (Oct\u00a017)']);
  assert.equal(nightText({ mt_birds_km: null, complete: false }), 'no scans');
  assert.deepEqual(nightLines(null, now), []);
  const p = { site: 'KAKQ', name: 'Wakefield VA', density_birds_km3: 3.2, heading_deg: 200, speed_ms: 9, peak_altitude_m: 400, scan_time: 't', bio_gate_share: 0.8 };
  const html = describe(p, 6000, doc.sites.KAKQ, now);
  assert.match(html, /scan t<br>Tonight so far: 5,970 birds crossed each km.*<br>Last night \(Oct\u00a017\): 126,000/);
  assert.doesNotMatch(describe(p, 6000), /Tonight|Last night/, 'no nights (replay frames): no night lines');
});

test('birds: the night error bar is the sampling check\'s q, shown only while that check passes', () => {
  const doc = JSON.parse(readFileSync(new URL('../../docs/analysis/bird_sampling.json', import.meta.url)));
  assert.equal(doc.ships, true, 'the error bar ships only while the held-out nights pass');
  assert.equal(SAMPLING_ERROR, Math.round(doc.q * 1000) / 1000);
  const night = { mt_birds_km: 4000, complete: true, bio_gate_share: 0.8 };
  assert.equal(nightText(night), '4,000 birds crossed each km (±\u00a08% from 10-minute sampling)');
  assert.equal(nightText({ ...night, complete: false }), '4,000 birds crossed each km', 'tonight is not finished');
  assert.equal(nightText({ ...night, bio_gate_share: 0.3 }), '4,000 birds crossed each km; mostly rain or clutter, unreliable');
  assert.equal(nightText({ ...night, bio_gate_share: undefined }), '4,000 birds crossed each km (±\u00a08% from 10-minute sampling)');
});

test('birds: night dates and the error bar cannot wrap inside themselves in the popup', () => {
  // the live popup broke "(±" from "8%" and "10-" from "16" (2026-10-19); a no-break space holds each together
  assert.equal(nightDate('2026-10-05'), 'Oct\u00a05');
  assert.equal(nightDate('2026-01-31'), 'Jan\u00a031');
  assert.equal(nightDate('2026-12-01'), 'Dec\u00a01');
  const t = nightText({ mt_birds_km: 4000, complete: true, bio_gate_share: 0.8 });
  assert.match(t, /±\u00a08%/);
  assert.doesNotMatch(t, /± /, 'a plain space after ± lets the line break there');
  for (const line of nightLines([{ night: '2026-10-17', complete: true, mt_birds_km: 4000, bio_gate_share: 0.8 }])) {
    assert.doesNotMatch(line, /\d-\d/, 'no hyphenated date left to break at');
  }
  // the scan line had the same raw ISO date (PR #107 review); every popup test used scan_time 't'
  assert.equal(scanTime('2026-10-19T08:38:17Z'), 'Oct\u00a019\u00a008:38\u00a0UTC');
  for (const v of ['t', null, undefined]) assert.equal(scanTime(v), v == null ? 'n/a' : v, 'not ISO: shown as given');
  const p = { site: 'KBUF', name: 'Buffalo NY', density_birds_km3: 0.5, heading_deg: 66, speed_ms: 5, peak_altitude_m: 200,
    scan_time: '2026-10-19T08:38:17Z', bio_gate_share: 0.8 };
  const nights = [{ night: '2026-10-17', complete: true, mt_birds_km: 4110, bio_gate_share: 0.8 }];
  const html = describe(p, 6000, nights, Date.parse('2026-10-19T09:00:00Z'));
  assert.match(html, /scan Oct\u00a019\u00a008:38\u00a0UTC/);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ' '), /\d-\d|± /, 'no break point inside a date or the error bar anywhere');
  const contact = particleText(1.25, 66.4, 5.2, { site: 'KBUF', name: 'Buffalo NY', scan_time: '2026-10-19T08:38:17Z' });
  assert.match(contact, /≈ 1\.3 birds\/km³.*heading 66° · ground speed 5 m\/s<br>nearest radar KBUF \(Buffalo NY\) · scan Oct\u00a019\u00a008:38\u00a0UTC<br>/);
  assert.match(particleText(0, 0, 0, undefined), /nearest radar n\/a · scan n\/a<br>/);
});

test('birds: last night\'s flight heights, middle half and median, beside the radar\'s own height', () => {
  // birds_nights.json rebuilt from the live profile store for the night of 19 Oct (fixtures/README.md)
  const doc = JSON.parse(readFileSync(new URL('./fixtures/birds_nights_heights_20261020.json', import.meta.url)));
  const [akq] = doc.sites.KAKQ;   // quartiles 193.8 / 352.3 / 588.2 m ASL, antenna 77 m
  assert.equal(heightLine(akq), 'Half of last night\'s birds flew 200\u2060–\u2060600\u00a0m above sea level (median 350\u00a0m; radar at 77\u00a0m)');
  const [buf] = doc.sites.KBUF;   // 781.0 / 1216.2 / 1613.2, antenna 240
  assert.equal(heightLine(buf), 'Half of last night\'s birds flew 800\u2060–\u20601,600\u00a0m above sea level (median 1,200\u00a0m; radar at 240\u00a0m)');
  assert.equal(heightLine(doc.sites.KILN[0]), null, 'KILN was off the air: no heights');
  // in the popup it follows the night's total; tonight (not finished) never gets one
  assert.deepEqual(nightLines(doc.sites.KAKQ, Date.parse('2026-10-20T14:00:00Z')).at(-1), heightLine(akq));
  assert.equal(heightLine({ ...akq, complete: false }), null);
  assert.equal(heightLine({ ...akq, bio_gate_share: 0.3 }), null, 'a mostly-rain night has no heights');
  assert.equal(heightLine({ ...akq, height_quartiles_m: null }), null, 'a night from before heights were kept');
  assert.equal(heightLine({ ...akq, height_quartiles_m: [1, NaN, 3] }), null);
  assert.match(heightLine({ ...akq, antenna_m: undefined }), /\(median 350\u00a0m\)$/);
});

test('birds: the season line totals the archived nights and says how many it rests on', () => {
  // birds_seasons.json from the archive's first real run, 2026-10-19 21:07 UTC, cut to KAKQ and KILN (fixtures/README.md)
  const doc = JSON.parse(readFileSync(new URL('./fixtures/birds_seasons_20261019.json', import.meta.url)));
  // KAKQ: 22 nights archived (Sep 27 - Oct 18, the archive starts where the live store did), 3 under the rain share
  assert.deepEqual(seasonLines(doc, 'KAKQ', false),
    ['Fall 2026 so far: 592,000 birds crossed each km (Aug\u00a01 – Oct\u00a018: 22 of 79 nights, 3 mostly rain)']);
  // KILN went off the air: its season runs to its last night, and the outage nights are not counted
  assert.deepEqual(seasonLines(doc, 'KILN', false),
    ['Fall 2026 so far: 328,000 birds crossed each km (Aug\u00a01 – Oct\u00a014: 14 of 75 nights, 1 mostly rain)']);
  assert.deepEqual(seasonLines(doc, 'KXXX'), [], 'a radar with no archived nights');
  assert.deepEqual(seasonLines(null, 'KAKQ'), []);
  // the comparison with last fall: matched by date, only nights both falls have, only when compare is on
  const rec = (mt, share = 0.8) => ({ mt_birds_km: mt, bio_gate_share: share, coverage: 0.9 });
  const two = { windows: { fall: ['08-01', '11-15'] }, seasons: {
    'fall-2025': { KAKQ: { '2025-08-01': rec(100), '2025-08-02': rec(50), '2025-08-03': rec(900) } },
    'fall-2026': { KAKQ: { '2026-08-01': rec(300), '2026-08-02': rec(null), '2026-08-03': rec(20, 0.1), '2026-08-04': rec(5) } } } };
  assert.deepEqual(seasonLines(two, 'KAKQ', true), [
    'Fall 2026 so far: 325 birds crossed each km (Aug\u00a01 – Aug\u00a04: 3 of 4 nights, 1 mostly rain)',
    'Last fall on the same 2 nights: 1,000 (this fall 320)',
  ]);
  assert.equal(seasonLines(two, 'KAKQ', false).length, 1, 'no comparison unless the year-on-year check passed');
  // a finished season drops "so far"; the latest season is picked by date, not by key order
  const done = { windows: two.windows, seasons: { 'fall-2026': { KAKQ: { '2026-11-15': rec(10) } }, 'fall-2025': { KAKQ: { '2025-11-15': rec(1) } } } };
  assert.match(seasonLines(done, 'KAKQ', false)[0], /^Fall 2026: 10 birds .*Nov\u00a015: 1 of 107 nights\)$/);
  // the switch is season_check's verdict on the falls in the archive (pipeline/season_check.py, rule fixed 10-19)
  const verdict = JSON.parse(readFileSync(new URL('../../docs/analysis/bird_season.json', import.meta.url)));
  assert.equal(verdict.season, 'fall-2026');
  assert.equal(typeof verdict.ships, 'boolean');
  assert.equal(SEASON_COMPARE, verdict.ships, `season_check says ships=${verdict.ships} (median ${verdict.median_disagreement} over ${verdict.pairs.length} pairs)`);
});

test('birds: the airspeed check gives one popup line per verdict, with its nights and speeds', () => {
  const t = { 'KFFC 2026-10-17': { verdict: 'birds', airspeed_ms: 11.2, insect_share: 0.1 },
    'KFFC 2026-10-16': { verdict: 'birds', airspeed_ms: 9.0, insect_share: 0.2 },
    'KFFC 2026-10-11': { verdict: 'insects', airspeed_ms: 3.1, insect_share: 0.8 },
    'KFFC 2026-10-12': { verdict: 'unclear', airspeed_ms: null, insect_share: null },
    'KOHX 2026-10-16': { verdict: 'birds', airspeed_ms: 8.0, insect_share: 0.1 } };
  const lines = airspeedLines('KFFC', t);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Airspeed check, Oct\u00a011: likely insects, so the count is too high \(3\.1\u00a0m\/s through the air; insects drift under 5\u00a0m\/s\)$/);
  assert.equal(lines[1], 'Airspeed check, Oct\u00a012: unclear');
  assert.match(lines[2], /^Airspeed check, Oct\u00a016, 17: looks like birds \(9\.0\u2060–\u206011\.2\u00a0m\/s through the air/);
  assert.deepEqual(airspeedLines('KBUF', t), [], 'a radar the check did not ask about gets no line');
  // the month is written where it changes, so a list across Sep/Oct stays readable
  assert.equal(nightDates(['2026-09-27', '2026-09-30', '2026-10-01', '2026-10-04']), 'Sep\u00a027, 30, Oct\u00a01, 4');
  assert.equal(nightDates([]), '');
});

test('birds: the shipped airspeed table and cutoff are bird_insects.json\'s', () => {
  const doc = JSON.parse(readFileSync(new URL('../../docs/analysis/bird_insects.json', import.meta.url)));
  assert.equal(AIRSPEED_CUTOFF_MS, doc.rules.cutoff_ms);
  assert.deepEqual({ ...AIRSPEED_NIGHTS }, doc.popup);
  assert.ok(Object.keys(doc.popup).length >= 5, 'the five nights asked about are in it');
  assert.ok(Object.isFrozen(AIRSPEED_NIGHTS));
  const kffc = describe({ site: 'KFFC', name: 'Atlanta', density_birds_km3: 1, heading_deg: 200, speed_ms: 9, scan_time: 't' }, 1);
  assert.match(kffc, /Airspeed check, /, 'the line reaches the radar popup');
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
    assert.match(popup(), /Last night \(Oct\u00a017\): 126,000 birds crossed each km/);
    nightsOk = false;
    assert.equal(await l.update(), true, 'a nights failure does not fail the layer');
    assert.equal(l.getStats().nightsError, 'birds_nights.json HTTP 503');
    assert.match(popup(), /Last night \(Oct\u00a017\): 126,000/, 'the last good night totals are kept');
  } finally { globalThis.fetch = saved; l.destroy({ dataSources: { remove() {} }, scene: {} }); }
});

test('birds: update() adds the season line, refetches the archive hourly and keeps the last good one', async () => {
  const l = createBirdsLayer();
  const seasons = JSON.parse(readFileSync(new URL('./fixtures/birds_seasons_20261019.json', import.meta.url)));
  const gj = { generated_at: 'g', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-77.0, 36.98] },
    properties: { site: 'KAKQ', name: 'Wakefield VA', density_birds_km3: 3.2, heading_deg: 200, speed_ms: 9, peak_altitude_m: 400, scan_time: 't', bio_gate_share: 0.8 } }] };
  let seasonsOk = true; let seasonFetches = 0;
  const saved = globalThis.fetch; const savedNow = Date.now; let now = Date.parse('2026-10-19T22:00:00Z');
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('birds_seasons.json')) { seasonFetches++; return seasonsOk ? { ok: true, json: async () => seasons } : { ok: false, status: 503 }; }
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
    assert.equal(l.getStats().seasonsError, null);
    assert.match(popup(), /<br>Fall 2026 so far: 592,000 birds crossed each km \(Aug\u00a01 – Oct\u00a018: 22 of 79 nights/);
    now += 59 * 60_000;
    await l.update();
    assert.equal(seasonFetches, 1, 'not refetched within the hour');
    seasonsOk = false; now += 2 * 60_000;
    assert.equal(await l.update(), true, 'a seasons failure does not fail the layer');
    assert.equal(seasonFetches, 2);
    assert.equal(l.getStats().seasonsError, 'birds_seasons.json HTTP 503');
    assert.match(popup(), /Fall 2026 so far: 592,000/, 'the last good archive is kept');
  } finally { globalThis.fetch = saved; Date.now = savedNow; l.destroy({ dataSources: { remove() {} }, scene: {} }); }
});

test('birds: the popup sparkline is the radar against its own nights, log scale, rain and gaps marked', () => {
  // birds_nights.json as served 2026-10-19 02:49 UTC after seeding 20 past nights (fixtures/README.md); the
  // expected bars were computed independently in Python from the same file
  const doc = JSON.parse(readFileSync(new URL('./fixtures/birds_nights_history_20261019.json', import.meta.url)));
  assert.equal(nightSpark(doc.sites.KAKQ), 'Last 14 nights: ▆█▆▃▆▅×▄▇▄▆▅×█ (high 174,000 on Oct\u00a05; log scale; × rain)');
  assert.equal(nightSpark(doc.sites.KBUF), 'Last 14 nights: ············█▇ (high 7,170 on Oct\u00a016; log scale; × rain)');
  const n = (night, mt, share = 0.8) => ({ night, complete: true, mt_birds_km: mt, bio_gate_share: share });
  // three decades: the top night is the top bar, a night 1000x lower the bottom, 31.6x lower the middle
  assert.equal(nightSpark([n('2026-10-01', 1e5), n('2026-10-02', 1e2), n('2026-10-03', 1e5 / 10 ** 1.5)]).split(' ')[3], '█▁▅');
  assert.equal(nightSpark([n('2026-10-01', 1e5), n('2026-10-02', 1), n('2026-10-03', 0)]).split(' ')[3], '█▁▁', 'below the floor and zero sit on the bottom');
  // a rain night is never the top, even when its count is the largest; one decade down is bar 5 of 0-7 (4.67 rounds up)
  assert.match(nightSpark([n('2026-10-01', 1e6, 0.1), n('2026-10-02', 1e3), n('2026-10-03', 1e2)]), /: ×█▆ \(high 1,000 on Oct\u00a02\b/);
  // only complete nights, only the last 14
  const many = Array.from({ length: 20 }, (_, i) => n(`2026-10-${String(i + 1).padStart(2, '0')}`, 1000 + i));
  assert.match(nightSpark([...many, { night: '2026-10-21', complete: false, mt_birds_km: 1e9 }]), /^Last 14 nights: .{14} \(high 1,020 on Oct\u00a020\b/u);
  assert.equal(nightSpark(many.slice(0, 2)), null, 'fewer than 3 complete nights: no sparkline');
  assert.equal(nightSpark([n('2026-10-01', null), n('2026-10-02', null), n('2026-10-03', 5, 0.1)]), null, 'nothing to scale against');
  assert.equal(nightSpark(null), null);
  const p = { site: 'KAKQ', name: 'Wakefield VA', density_birds_km3: 3.2, heading_deg: 200, speed_ms: 9, peak_altitude_m: 400, scan_time: 't', bio_gate_share: 0.8 };
  assert.match(describe(p, 6000, doc.sites.KAKQ, Date.parse(doc.generated_at)), /Last night \(Oct\u00a017\)[^<]*<br>Last 14 nights: ▆█/);
});
