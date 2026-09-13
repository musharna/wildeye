// src/data/rivers.test.mjs — site-series contract: temperature classes, day bins / observed time, info box, layer contract, seed.
// Mutants verified to fail each test are named in the test bodies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { tempClass, dayAt, describeGage, gageEntity, createRiversLayer, TEMP_CLASSES, NO_DATA, isSpike, SUSPECT } from './rivers.js';

const HOT = '22–25 °C above adult salmonid lethal / migration-blockage 21–22 °C';
const gage = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-120.18731, 42.6035] },
  properties: {
    site: '10387150', name: 'LAKE ABERT NEAR VALLEY FALLS, OR', state: 'Oregon', huc: '171200060000',
    d0: '2026-08-13',
    t: [null, 17.7, 18.8, 19.0, 22.0, 25.0, null, null, null, null, null, null, 21.0, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 9.9, null],
    q: [null, 12300, null, null, 5.5, null, null, null, null, null, null, null, null, 0.987, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 3],
    latest: { d: '2026-09-10', t: 9.9, q: null },
  },
};
const withFetch = async (payload, fn) => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  try { return await fn(); } finally { globalThis.fetch = saved; }
};
const viewer = () => { let ds; return { v: { dataSources: { add(d) { ds = d; }, remove() {} } }, ds: () => ds }; };

test('tempClass: band edges are lower-inclusive (10 → cool, 18 → warm, 22 → hot, 25 → lethal); non-numbers → no data', () => {
  // mutant: `t < c.max` → `t <= c.max` moves 10/18/22/25 down one band → fails
  assert.deepEqual([-0.1, 9.9, 10, 17.9, 18, 21.9, 22, 24.9, 25, 40].map((t) => tempClass(t).key),
    ['cold', 'cold', 'cool', 'cool', 'warm', 'warm', 'hot', 'hot', 'lethal', 'lethal']);
  assert.deepEqual([null, undefined, NaN, '12'].map((t) => tempClass(t)), [NO_DATA, NO_DATA, NO_DATA, NO_DATA]);
  assert.equal(TEMP_CLASSES.length, 5);
  assert.equal(TEMP_CLASSES.filter((c) => /salmonid/.test(c.label)).length, 4, 'every band from 10 °C up names its salmonid meaning');
});

test('dayAt: live = latest day with a temperature; instant = the day matching its UTC date; outside the window = no record', () => {
  // mutant: dayIndex uses Math.round instead of Math.floor → 23:00Z on 08-14 lands on 08-15 → fails
  assert.deepEqual(dayAt(gage.properties, null), { d: '2026-09-10', t: 9.9, q: null, suspect: false, label: 'latest daily mean, 2026-09-10' });
  assert.deepEqual(dayAt(gage.properties, '2026-08-14T23:00:00Z'), { d: '2026-08-14', t: 17.7, q: 12300, suspect: false, label: 'daily mean, 2026-08-14' });
  assert.deepEqual(dayAt(gage.properties, '2026-08-17T00:00:00Z'), { d: '2026-08-17', t: 22.0, q: 5.5, suspect: false, label: 'daily mean, 2026-08-17' });
  assert.equal(dayAt(gage.properties, '2026-08-19T12:00:00Z').t, null, 'day inside window without a value → null, not undefined');
  assert.equal(dayAt(gage.properties, '2026-08-12T23:59:59Z').d, null);
  assert.match(dayAt(gage.properties, '2026-09-12T00:00:00Z').label, /no record for 2026-09-12/);
  assert.equal(dayAt(gage.properties, 'bad').label, 'invalid time');
  assert.equal(dayAt({}, null).label, 'no data');
});

test('describeGage: escapes, states the band, the flow, the provisional + constant-exposure caveats, the site link and non-endorsement', () => {
  // mutant: dropping `esc(p.name)` leaves the raw `<b>` in the name → doesNotMatch fails (positive control: the escaped form matches)
  const p = { ...gage.properties, name: 'RIVER <b>AT</b> X' };
  const html = describeGage(p, dayAt(p, '2026-08-17T00:00:00Z'), { name: 'USGS', licence: 'PD' });
  assert.match(html, new RegExp(`RIVER &lt;b&gt;AT&lt;/b&gt; X.*USGS 10387150 \\(Oregon\\).*daily mean, 2026-08-17: water <b>22\\.0 °C</b> \\(${HOT.replace(/\//g, '\\/')}\\) · flow <b>5\\.5 ft³/s</b>.*provisional.*constant-exposure.*monitoring-location/10387150.*USGS.*PD.*does not imply endorsement`, 's'));
  assert.doesNotMatch(html, /<b>AT<\/b>/);
  assert.doesNotMatch(html, /sensor:/, 'no sensor label when the gage has a single series');
  // mutant: sensor clause dropped from describeGage → the match below fails (the line above is its negative)
  assert.match(describeGage({ ...p, sensor: 'Top <WT> Sensor' }, dayAt(p, null)), /\(Oregon\) · temperature sensor: Top &lt;WT&gt; Sensor<br>/);
  assert.match(describeGage(p, dayAt(p, '2026-08-19T00:00:00Z')), /water <b>—<\/b> \(no temperature that day\) · flow <b>—<\/b>/);
  assert.match(describeGage(p, dayAt(p, '2026-08-14T00:00:00Z')), /flow <b>12,300 ft³\/s<\/b>/);
});

test('gageEntity: colour = temperature class, size grows with flow, chips off → grey / fixed size, fades without data', () => {
  // mutant: `showT ? tempClass(scope.t) : NO_DATA` → always tempClass → temperature-off entity keeps class 'cool' → fails
  const both = { visible: { temperature: true, discharge: true }, source: {} };
  const hot = gageEntity(gage, '2026-08-18T00:00:00Z', both); // 25.0 °C, no flow
  assert.equal(hot.properties.cls, 'lethal');
  assert.equal(hot.point.pixelSize, 6);
  const big = gageEntity(gage, '2026-08-14T00:00:00Z', both);
  const small = gageEntity(gage, '2026-08-17T00:00:00Z', both);
  assert.ok(big.point.pixelSize > small.point.pixelSize && small.point.pixelSize > 6);
  assert.equal(big.properties.cls, 'cool');
  assert.equal(gageEntity(gage, '2026-08-14T00:00:00Z', { visible: { temperature: false, discharge: true }, source: {} }).properties.cls, 'none');
  assert.equal(gageEntity(gage, '2026-08-14T00:00:00Z', { visible: { temperature: true, discharge: false }, source: {} }).point.pixelSize, 6);
  const none = gageEntity(gage, '2026-08-19T00:00:00Z', both);
  assert.equal(none.properties.hasData, false);
  assert.ok(none.point.color.alpha < 0.3 && big.point.color.alpha === 1);
  assert.equal(big.id, 'rivers:10387150');
});

test('layer: contract, live counts, observed-time recolour, chips, legend, analyst records', async () => {
  // mutant: getAnalystRecords filter on hasData removed → 2 records on 08-19 while neither gage has data → fails
  const other = { ...gage, properties: { ...gage.properties, site: '04296000', name: 'BLACK RIVER AT COVENTRY, VT', state: 'Vermont', t: gage.properties.t.map((v, i) => (i === 1 ? 12.0 : null)), q: gage.properties.q, latest: { d: '2026-08-14', t: 12.0, q: 12300 } } };
  const gj = { type: 'FeatureCollection', data_end: '2026-09-11', source: { name: 'USGS', licence: 'PD' }, features: [gage, other] };
  await withFetch(gj, async () => {
    const l = createRiversLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime', 'setRowControlsListener', 'setParams', 'getParams']) assert.equal(typeof l[k], 'function');
    assert.equal(l.id, 'rivers'); assert.equal(l.icon, '🏞️'); assert.equal(l.name, 'River temperature and flow (USGS gages)');
    const { v, ds } = viewer();
    l.init(v);
    assert.equal(await l.update(), true);
    assert.equal(ds().entities.values.length, 2);
    assert.deepEqual(l.getStats().classes, { cold: 1, cool: 1 });
    assert.equal(l.getStats().error, null);
    let pings = 0; l.setRowControlsListener(() => pings++);
    assert.equal(l.setObservedTime('2026-08-14T06:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { cool: 2 });
    assert.equal(l.setObservedTime('2026-08-17T06:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { hot: 1, none: 1 }, 'VT gage has flow but no temperature on 08-17 → no-data class but still reporting');
    const rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.id), ['temperature', 'discharge']);
    assert.equal(rc.legend.find((i) => i.label === HOT).count, 1);
    assert.equal(rc.legend.find((i) => i.label === NO_DATA.label).count, 1);
    assert.match(rc.legend.at(-1).label, /observed day/);
    assert.equal(l.setObservedTime('bad'), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 2, 'positive control: both gages report on 08-17');
    assert.equal(l.setObservedTime('2026-08-19T06:00:00Z'), true);
    assert.equal(l.getAnalystRecords().length, 0, 'neither gage has a value on 08-19');
    assert.equal(l.setObservedTime(null), true);
    assert.equal(l.getAnalystRecords().length, 2);
    assert.equal(l.getAnalystRecords()[0].temp_c, 9.9);
    assert.match(l.getRowControls().legend.at(-1).label, /record to 2026-09-11/);
    assert.equal(l.setParams({ temperature: false }), true);
    assert.equal(l.getRowControls().legend.length, 2, 'temperature off → no band rows, only no-data + caption');
    assert.equal(l.setParams({ temperature: false }), false);
    assert.ok(pings >= 4);
    l.disable();
    assert.equal(l.getAnalystRecords().length, 0);
    l.destroy(v);
    assert.equal(l.getStats().count, 0);
  });
});

async function driveReal(gj) {
  return withFetch(gj, async () => {
    const l = createRiversLayer();
    const { v, ds } = viewer();
    l.init(v);
    assert.equal(await l.update(), true);
    const s = l.getStats();
    assert.equal(s.error, null);
    assert.ok(s.count > 0 && ds().entities.values.length === s.count);
    assert.ok(s.active > 0, 'at least one gage reports on its latest day');
    l.enable();
    assert.ok(l.getAnalystRecords(5).every((r) => typeof r.temp_c === 'number'));
    return s;
  });
}

test('layer against the real pipeline output (public/data/rivers.geojson): features > 0, no error', async (t) => {
  const url = new URL('../../public/data/rivers.geojson', import.meta.url);
  let text;
  try { text = await readFile(url, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return t.skip('public/data/rivers.geojson not built here (gitignored); run pipeline/run_rivers.sh');
    throw e;
  }
  const s = await driveReal(JSON.parse(text));
  t.diagnostic(`real file: ${s.count} gages, ${s.active} reporting, classes ${JSON.stringify(s.classes)}`);
});

test('seed (public/data/seed/rivers.geojson): < 100 KB, gages > 0, subsampling stated, layer loads it', async (t) => {
  // mutant: seed written without source.subsample → match fails; seed over the cap → size assert fails
  const url = new URL('../../public/data/seed/rivers.geojson', import.meta.url);
  const size = (await stat(url)).size;
  assert.ok(size < 100_000, `seed is ${size} bytes`);
  const gj = JSON.parse(await readFile(url, 'utf8'));
  assert.match(gj.source?.subsample ?? '', /round-robin across states/);
  const s = await driveReal(gj);
  t.diagnostic(`seed: ${size} bytes, ${s.count} gages, ${s.active} reporting`);
});

test('gageEntity: negative (reverse, tidal) flow gets a finite size by magnitude and is explained in the info box', () => {
  // Mutant seen failing: log10(q + 1) without Math.abs → NaN pixelSize → Cesium stops rendering (real-app smoke 2026-09-12).
  const tidal = structuredClone(gage);
  tidal.properties.q[1] = -12300; // same magnitude as the forward fixture's 12300 on that day
  const both = { visible: { temperature: true, discharge: true }, source: {} };
  const rev = gageEntity(tidal, '2026-08-14T00:00:00Z', both);
  const fwd = gageEntity(gage, '2026-08-14T00:00:00Z', both);
  assert.ok(Number.isFinite(rev.point.pixelSize), `pixelSize ${rev.point.pixelSize}`);
  assert.equal(rev.point.pixelSize, fwd.point.pixelSize, 'same magnitude, same size');
  assert.match(rev.description, /reverse flow/);
  assert.doesNotMatch(fwd.description, /reverse flow/, 'positive control: forward flow carries no note');
});

test('isSpike: a one-day jump off its neighbours is suspect; steady hot water and heat waves are not', () => {
  // Real series (USGS daily means, 2026-08-13..09-11). Mutant seen failing: a fixed ceiling (v > 35) flags Boiling River
  // and misses nothing else; dropping the median (comparing with the previous day only) flags the day AFTER the spike too.
  const skibo = [17.3, 16.5, 16.6, 17.1, 15.3, 16.0, 14.2, 15.1, 16.5, 16.0, 13.9, 13.2, 14.8, 16.3, 14.7, 13.8, 15.5, 16.3, 16.7, 15.6, 15.6, 15.2, 16.5, 16.5, 15.7, 17.6, 17.8, 16.8, 41.0, 16.8];
  const boiling = [53.0, 53.0, 52.6, 52.6, 52.6, 52.6, 52.6, 52.6, 52.7, 52.7];
  const cahaba = [30.6, 32.4, 32.8, 32.9, 33.5, 34.5, 34.0, 33.2, 32.7, 31.9];
  assert.equal(isSpike(skibo, 28), true, 'St. Louis River 41.0 °C between 16.8 and 16.8');
  assert.equal(isSpike(skibo, 29), false, 'the day after the spike is normal');
  assert.equal(isSpike(skibo, 27), false, 'the day before the spike is normal');
  assert.equal(boiling.some((_, i) => isSpike(boiling, i)), false, 'geothermal 52–53 °C is real, not suspect');
  assert.equal(cahaba.some((_, i) => isSpike(cahaba, i)), false, 'a 34.5 °C heat-wave peak is not suspect');
  assert.equal(isSpike([null, 20, null], 1), false, 'too few neighbours → no call');
  const g = { type: 'Feature', geometry: { type: 'Point', coordinates: [-92, 47] }, properties: { site: '04015438', name: 'ST. LOUIS RIVER NEAR SKIBO, MN', state: 'Minnesota', d0: '2026-08-13', t: skibo, q: skibo.map(() => 100), latest: { d: '2026-09-10', t: 41.0, q: 100 } } };
  const e = gageEntity(g, null, { visible: { temperature: true, discharge: true }, source: {} });
  assert.equal(e.properties.cls, SUSPECT.key);
  assert.match(e.description, /suspect reading.*excluded from the temperature bands/);
  const normal = gageEntity(g, '2026-09-09T12:00:00Z', { visible: { temperature: true, discharge: true }, source: {} });
  assert.equal(normal.properties.cls, 'cool', 'positive control: a normal day keeps its band');
});
