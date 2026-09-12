// src/data/fires.test.mjs — point contract (dated): FRP classes, 6-hour bin selection, live 24 h window, info box, layer contract + observed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frpClass, binGeometry, binsAt, sumBins, describeCell, createFiresLayer, NO_DATA, LIVE_HOURS } from './fires.js';

// header shaped like pipeline/fires.py output: bin0 = 2026-09-06T00Z, 6-h bins, newest bin ends 2026-09-13T00Z (28 bins, k = 0..27)
const header = { bin0: '2026-09-06T00:00:00Z', bin_hours: 6, newest: '2026-09-13T00:00:00Z', latest: '2026-09-12T20:50:00Z', days: 7, source: { citation: 'NASA FIRMS', licence: 'open', url: 'https://u', cell_deg: 0.5 } };
const geom = binGeometry(header);
// bins newest first: k=27 (09-12 18:00–24:00), 24 (09-12 00–06), 23 (09-11 18–24), 3 (09-06 18–24)
const bins = [[27, 2, 8.4], [24, 30, 565.7], [23, 48, 1031.1], [3, 155, 2859.1]];

test('frpClass thresholds, none for 0/NaN', () => {
  // mutant seen failing: "large" test f < 250 → f <= 250 puts 250 in large
  assert.deepEqual([0, 1, 9.9, 10, 49, 50, 249, 250, 1e6, NaN, null].map((f) => frpClass(f).key), ['none', 'small', 'small', 'moderate', 'moderate', 'large', 'large', 'intense', 'intense', 'none', 'none']);
});

test('binGeometry rejects a malformed header; binsAt: live = bins starting within 24 h of the newest bin end, observed = the one 6-h bin', () => {
  // mutants seen failing: cutoff `>=` → `>` drops k=24 (starts exactly 24 h before the newest end); Math.floor → Math.round on k labels 09:00 as the 12:00 bin
  assert.equal(binGeometry({ bin0: 'x', bin_hours: 6, newest: '2026-09-13T00:00:00Z' }), null);
  assert.equal(binGeometry({ ...header, bin_hours: 0 }), null);
  assert.deepEqual(geom, { bin0Ms: Date.parse('2026-09-06T00:00:00Z'), binMs: 6 * 3600_000, newestMs: Date.parse('2026-09-13T00:00:00Z'), latestMs: Date.parse('2026-09-12T20:50:00Z') });
  assert.equal(binGeometry({ ...header, latest: undefined }).latestMs, null, 'latest is optional; positive control: geometry still built');
  const live = binsAt(bins, null, geom);
  assert.deepEqual(live.bins.map((b) => b[0]), [27, 24], `k=23 started 30 h before the newest end, outside ${LIVE_HOURS} h`);
  assert.equal(live.label, '6-h bins since 2026-09-12 00:00Z (latest detection 2026-09-12 20:50Z)');
  assert.deepEqual(sumBins(live.bins), { n: 32, frp: 574.1 });
  const obs = binsAt(bins, '2026-09-11T21:30:00Z', geom);
  assert.deepEqual(obs.bins, [[23, 48, 1031.1]]);
  assert.equal(obs.label, '6 h from 2026-09-11 18:00Z');
  assert.deepEqual(binsAt(bins, '2026-09-12T09:00:00Z', geom).bins, [], 'k=25 has no detections');
  assert.equal(binsAt(bins, '2026-09-12T09:00:00Z', geom).label, 'no detections in the 6 h from 2026-09-12 06:00Z');
  assert.deepEqual(binsAt(bins, 'garbage', geom).bins, []);
  assert.deepEqual(binsAt(bins, null, null).bins, []);
  assert.deepEqual(binsAt(undefined, null, geom).bins, []);
});

test('describeCell states scope totals, window totals, the thermal-anomaly caveat and the citation', () => {
  // mutant seen failing: `fmt(sum.frp)` → `fmt(p.frp)` in the scope line shows the window MW instead of the bin's
  const scope = binsAt(bins, '2026-09-11T21:30:00Z', geom);
  const html = describeCell({ n: 235, frp: 4464.3, frp_max_bin: 2859.1 }, 29.25, -1.25, scope, sumBins(scope.bins), { ...header.source, days: 7 });
  assert.match(html, /Fire cell -1\.25, 29\.25.*0\.5° square.*6 h from 2026-09-11 18:00Z: 48 detections, <b>1,031<\/b> MW fire radiative power.*235 detections, 4,464 MW in the file's 7-day window \(peak 6-h bin 2,859 MW\).*volcanoes, gas flares.*not fire perimeters.*https:\/\/u.*NASA FIRMS.*open/s);
  const one = describeCell({ n: 1, frp: 0.9 }, 0, 0, binsAt([[27, 1, 0.9]], null, geom), { n: 1, frp: 0.9 });
  assert.match(one, /0\.5° square.*1 detection, <b>0\.9<\/b> MW/s);
});

test('layer: contract, observed-time recolour, faded cells, legend counts, records', async () => {
  // mutants seen failing: classCounts keyed on `n` instead of `cls` (legend counts collapse); getAnalystRecords without the n>0 filter returns the faded cell
  const gj = { type: 'FeatureCollection', generated_at: '2026-09-12T21:05:26Z', ...header, features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [29.25, -1.25] }, properties: { n: 235, frp: 4464.3, frp_max_bin: 2859.1, bins } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-73.75, 9.25] }, properties: { n: 3, frp: 23.2, frp_max_bin: 23.2, bins: [[15, 3, 23.2]] } },
  ] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createFiresLayer();
    assert.equal(l.id, 'fires');
    assert.equal(l.icon, '🔥');
    assert.equal(l.name, 'Active fires (NASA FIRMS VIIRS)');
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setObservedTime', 'setRowControlsListener']) assert.equal(typeof l[k], 'function');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(l.getStats().error, null);
    assert.equal(l.getStats().latest, '2026-09-12T20:50:00Z');
    assert.equal(ds.entities.values.length, 2);
    assert.deepEqual(l.getStats().classes, { intense: 1, none: 1 }, 'live: cell 1 sums 574 MW; cell 2 (k=15, 09-09) is outside 24 h');
    assert.ok(ds.entities.getById('fires:1').point.color.getValue().alpha < 0.2, 'no-data cell faded');
    assert.ok(ds.entities.getById('fires:0').point.color.getValue().alpha > 0.8);
    let pings = 0; l.setRowControlsListener(() => pings++);
    assert.equal(l.setObservedTime('2026-09-09T20:00:00Z'), true);
    assert.equal(pings, 1);
    assert.deepEqual(l.getStats().classes, { moderate: 1, none: 1 }, 'observed 09-09 18–24 (k=15): only cell 2, 23.2 MW');
    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => i.label === '10 – 50 MW').count, 1);
    assert.equal(legend.find((i) => i.label === NO_DATA.label).count, 1);
    assert.match(legend.at(-1).label, /0\.5° cell.*6-hour bin of the observed time/);
    assert.equal(l.setObservedTime('bad'), false);
    assert.equal(l.getAnalystRecords().length, 0, 'hidden layer reports nothing');
    l.enable();
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 1);
    assert.deepEqual({ ...recs[0], id: undefined }, { id: undefined, lat: 9.25, lon: -73.75, detections: 3, frp: 23.2, cls: 'moderate', scope: '6 h from 2026-09-09 18:00Z' });
    assert.equal(l.setObservedTime(null), true);
    assert.equal(l.getAnalystRecords()[0].detections, 32);
    assert.match(l.getRowControls().legend.at(-1).label, /last 24 h.*latest detection 2026-09-12T20:50:00Z/);
    // malformed header → error, not a silent empty layer
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /bin0/);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /HTTP 404/);
    l.destroy({ dataSources: { remove() {} } });
  } finally { globalThis.fetch = saved; }
});

test('live file: layer loads public/data/fires.geojson with > 0 features and no error', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const path = new URL('../../public/data/fires.geojson', import.meta.url);
  if (!existsSync(path)) { t.skip('public/data/fires.geojson absent (gitignored) — run pipeline/run_fires.sh'); return; }
  const text = await readFile(path, 'utf8');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(text) });
  try {
    const l = createFiresLayer();
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    const s = l.getStats();
    assert.equal(s.error, null);
    assert.ok(s.count > 0 && ds.entities.values.length === s.count);
    l.enable();
    assert.ok(l.getAnalystRecords().length > 0, 'some cell burned in the last 24 h');
    console.log(`  live fires.geojson: ${s.count} cells, classes ${JSON.stringify(s.classes)}, latest ${s.latest}`);
  } finally { globalThis.fetch = saved; }
});
