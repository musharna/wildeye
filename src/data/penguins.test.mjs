// src/data/penguins.test.mjs — Antarctic penguin colonies: card wording per count, rings at shared sites, readout reach, load checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIES, VANTAGES, NEAR_KM, DOT_PX, GAP_PX, clusterOffsets, seasonLabel, dateLabel, countText, latestText, shortLatest, describePoint, bySite, pointEntity,
  validate, createPenguinsLayer,
} from './penguins.js';

// Points copied from pipeline/penguins.py's real output (mapppdr v3.1): BREA gentoo (latest season holds a chicks count
// after a nests count), LAZN emperor (presence only), and a made-up two-species site to test the rings.
const BREA = {
  site: 'BREA', name: 'Breakwater Island', region: 'Central-west Antarctic Peninsula', lat: -64.7958, lon: -63.2256, species: 'GEPE',
  records: 3, surveys: 3, first: 2022, last: 2025,
  latest: { season: 2025, counts: [
    { type: 'chicks', count: 1471, date: '2026-02-06', accuracy: 3, vantage: 'ground' },
    { type: 'nests', count: 2337, date: '2025-12-14', accuracy: 1, vantage: 'uav' },
  ] },
  presentOnly: null,
};
const LAZN = {
  site: 'LAZN', name: 'Lazarev North', region: 'Queen Maud Land', lat: -69.38, lon: 14.64, species: 'EMPE',
  records: 5, surveys: 5, first: 2018, last: 2022, latest: null, presentOnly: 2022,
};
const TWO = (species, extra = {}) => ({
  site: 'TWOS', name: 'Two <Species> Point', region: 'Test', lat: -62.5, lon: -60.0, species, records: 1, surveys: 1, first: 1999, last: 1999,
  latest: { season: 1999, counts: [{ type: 'nests', count: 1, date: null, accuracy: null, vantage: null }] }, presentOnly: null, ...extra,
});
const data = (points = [BREA, LAZN, TWO('CHPE'), TWO('ADPE')]) => ({
  points, absentOnly: ['DARX ADPE'], species: SPECIES.map((s) => ({ id: s.id })),
  source: { doi: '10.3897/BDJ.11.e101476', datasetDoi: '10.48361/zftxkr' },
});

test('seasonLabel and dateLabel: an austral summer by its first year; a date in words; garbage throws', () => {
  assert.equal(seasonLabel(2025), '2025/26');
  assert.equal(seasonLabel(1999), '1999/00');
  assert.equal(seasonLabel(1909), '1909/10');
  assert.equal(dateLabel('2025-12-22'), '22 Dec 2025');
  assert.equal(dateLabel('2026-01-02'), '2 Jan 2026');
  assert.throws(() => dateLabel('22/12/2025'), /not a date/);
});

test('countText: each count keeps its own type; one is singular; zero says none found', () => {
  assert.equal(countText({ type: 'nests', count: 2337 }), '2,337 nests');
  assert.equal(countText({ type: 'chicks', count: 1 }), '1 chick');
  assert.equal(countText({ type: 'adults', count: 1 }), '1 adult');
  assert.equal(countText({ type: 'nests', count: 0 }), '0 nests (none found)');
});

test('latestText: every count of the latest season, in the file order, never added; presence only says so', () => {
  const [line] = latestText(BREA);
  assert.equal(
    line,
    'Latest counts (2, not added), 2025/26 season: 1,471 chicks <small>(ground count, 6 Feb 2026, accuracy 3 of 5)</small>; '
      + '2,337 nests <small>(drone photo, 14 Dec 2025, accuracy 1 of 5)</small>',
  );
  assert.ok(!/3,808/.test(line), 'chicks and nests are not summed');
  assert.deepEqual(latestText(LAZN), ['No count in this release: recorded present, not counted, latest in 2022/23']);
  const one = latestText(TWO('ADPE'));
  assert.deepEqual(one, ['Latest count, 1999/00 season: 1 nest <small>(accuracy not stated)</small>']);
  // a presence-only record later than the latest count is reported under it
  assert.deepEqual(latestText({ ...BREA, presentOnly: 2026 }).slice(1), ['Recorded present, not counted, in 2026/27']);
  assert.equal(shortLatest(BREA), 'gentoo 1,471 chicks, 2,337 nests (2025/26)');
  assert.equal(shortLatest(LAZN), 'emperor present, not counted (2022/23)');
});

test('describePoint: species, escaped site name, position, counts, surveys and span, citation', () => {
  const html = describePoint(BREA, data().source);
  assert.match(html, /^<b>Gentoo penguin<\/b> · Breakwater Island<br>Central-west Antarctic Peninsula · 64\.796°S 63\.226°W<br>Latest counts/);
  assert.match(html, /3 surveys \(3 records\), 2022\/23 to 2025\/26/);
  assert.match(html, /doi\.org\/10\.3897\/BDJ\.11\.e101476.*doi\.org\/10\.48361\/zftxkr.*mapppdr v3\.1 \(2026-08-21\) · CC BY 4\.0/);
  assert.match(describePoint(TWO('ADPE')), /Two &lt;Species&gt; Point/);
  assert.match(describePoint(TWO('ADPE')), /1 survey \(1 record\), 1999\/00<br>/);
  assert.match(describePoint(LAZN), /14\.640°E/);
});

test('bySite, clusterOffsets and pointEntity: species at one site in SPECIES order, side by side, never overlapping', () => {
  const sites = bySite([TWO('CHPE'), BREA, TWO('ADPE')]);
  assert.deepEqual(sites.get('TWOS').map((p) => p.species), ['ADPE', 'CHPE']);
  assert.deepEqual(clusterOffsets(1), [[0, 0]], 'a lone dot sits on its site');
  for (let n = 2; n <= 6; n += 1) {
    const o = clusterOffsets(n);
    assert.equal(o.length, n);
    assert.ok(Math.abs(o[0][0]) < 1e-9 && o[0][1] < 0, `n=${n}: the first dot is at the top`);
    if (n > 2) assert.ok(o[1][0] > 0, `n=${n}: the rest go clockwise (the second is to the right)`);
    // every pair at least a dot plus the gap apart, centre to centre, and the nearest pair exactly that
    let nearest = Infinity;
    for (let a = 0; a < n; a += 1) for (let b = a + 1; b < n; b += 1) nearest = Math.min(nearest, Math.hypot(o[a][0] - o[b][0], o[a][1] - o[b][1]));
    assert.ok(Math.abs(nearest - (DOT_PX + GAP_PX)) < 1e-9, `n=${n}: nearest pair ${nearest}`);
    const centre = o.reduce((s, [x, y]) => [s[0] + x, s[1] + y], [0, 0]);
    assert.ok(Math.hypot(...centre) < 1e-9, `n=${n}: the cluster is centred on the site`);
  }
  const first = pointEntity(sites.get('TWOS')[0], 0, 2);
  const second = pointEntity(sites.get('TWOS')[1], 1, 2);
  assert.equal(first.id, 'penguins:TWOS:ADPE');
  assert.deepEqual([first.billboard.pixelOffset.x, first.billboard.pixelOffset.y].map((v) => +v.toFixed(9)), [0, -6]);
  assert.deepEqual([second.billboard.pixelOffset.x, second.billboard.pixelOffset.y].map((v) => +v.toFixed(9)), [0, 6]);
  assert.deepEqual(first.position, second.position, 'both at the site itself; only the screen offset differs');
  assert.equal(first.billboard.pixelOffsetScaleByDistance, first.billboard.scaleByDistance, 'offsets scale with the dots');
  assert.match(decodeURIComponent(first.billboard.image), new RegExp(`fill="${SPECIES.find((s) => s.id === 'ADPE').color}"`));
  assert.match(decodeURIComponent(second.billboard.image), new RegExp(`fill="${SPECIES.find((s) => s.id === 'CHPE').color}"`));
  assert.equal(first.billboard.disableDepthTestDistance, 50_000, 'a dot on the far side of the Earth is not drawn through it');
  const lone = pointEntity(BREA);
  assert.deepEqual([lone.billboard.pixelOffset.x, lone.billboard.pixelOffset.y], [0, 0]);
  assert.equal(lone.billboard.width, pointEntity(LAZN).billboard.width, 'no count sizes a dot');
  assert.equal(lone.billboard.width, DOT_PX);
});

test('validate: refuses a file the card cannot describe, accepts the real shapes', () => {
  assert.equal(validate(data()).points.length, 4); // positive control
  const bad = [
    [{ points: [] }, /no points/],
    [data([{ ...BREA, lat: 64.8 }]), /BREA GEPE has no position south of 55°S/],
    [data([{ ...BREA, species: 'ROPE' }]), /species the legend does not know: ROPE/],
    [data([{ ...BREA, surveys: undefined }]), /has no survey counts/],
    [data([{ ...LAZN, presentOnly: null }]), /neither a count nor a presence record/],
    [data([{ ...BREA, latest: { season: 2025, counts: [{ ...BREA.latest.counts[0], type: 'eggs' }] } }]), /count type the card does not know: eggs/],
    [data([{ ...BREA, latest: { season: 2025, counts: [{ ...BREA.latest.counts[0], vantage: 'kite' }] } }]), /vantage the card does not know: kite/],
    [data([{ ...BREA, latest: { season: 2025, counts: [{ ...BREA.latest.counts[0], count: -1 }] } }]), /not a whole number: -1/],
    [data([{ ...BREA, latest: { season: 2025, counts: [] } }]), /latest season with no counts/],
  ];
  for (const [d, message] of bad) assert.throws(() => validate(d), message);
  // every vantage the pipeline allows has words (pipeline/penguins.py VANTAGES)
  assert.deepEqual(Object.keys(VANTAGES).sort(), ['aerial', 'aerial photo', 'ground', 'ground photo', 'landsat', 'offshore vessel', 'sentinel', 'uav', 'vhr']);
});

function fakeViewer() {
  const state = { ds: null };
  return { state, viewer: { dataSources: { add(d) { state.ds = d; }, remove() { state.ds = null; } } } };
}
const okFetch = (d, urls = []) => async (u) => { urls.push(u); return { ok: true, json: async () => d }; };

test('layer: contract, one entity per point in its slot, legend, readout reach and wording', async () => {
  const urls = [];
  const l = createPenguinsLayer({ fetchImpl: okFetch(data(), urls) });
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getRowControls', 'readoutAt']) assert.equal(typeof l[k], 'function', k);
  assert.equal(l.setObservedTime, undefined, 'not on the time bar');
  assert.equal(l.getObservedExtent, undefined, 'not on the time bar');
  const { state, viewer } = fakeViewer();
  l.init(viewer);
  assert.equal(state.ds.name, 'penguins');
  assert.equal(await l.update(), true);
  assert.deepEqual(urls, ['data/penguins.json']);
  const ids = state.ds.entities.values.map((e) => e.id);
  assert.equal(ids.length, 4);
  const slots = Object.fromEntries(state.ds.entities.values.map((e) => [e.id, e.properties.slot.getValue()]));
  assert.deepEqual([slots['penguins:TWOS:ADPE'], slots['penguins:TWOS:CHPE'], slots['penguins:BREA:GEPE']], [0, 1, 0]);
  const offsetY = (id) => state.ds.entities.getById(id).billboard.pixelOffset.getValue().y;
  assert.ok(offsetY('penguins:TWOS:ADPE') < 0 && offsetY('penguins:TWOS:CHPE') > 0 && offsetY('penguins:BREA:GEPE') === 0);
  assert.deepEqual(l.getStats(), { count: 4, shown: 4, sites: 3, lastUpdate: l.getStats().lastUpdate, error: null });
  const legend = l.getRowControls().legend;
  assert.deepEqual(legend.filter((i) => i.count !== null).map((i) => [i.label, i.count]), [
    ['Adélie penguin', 1], ['chinstrap penguin', 1], ['emperor penguin', 1], ['gentoo penguin', 1], ['king penguin', 0], ['macaroni penguin', 0],
  ]);
  assert.match(legend.at(-1).label, /1 site and species only ever recorded absent not drawn · mapppdr v3\.1/);
  const two = createPenguinsLayer({ fetchImpl: okFetch(data([BREA, { ...BREA, site: 'BRE2', lat: -64.9 }, LAZN])) });
  two.init(fakeViewer().viewer);
  await two.update();
  assert.deepEqual(two.getRowControls().legend.slice(0, 6).map((i) => i.count), [0, 0, 1, 2, 0, 0], 'the legend counts every dot of a species');

  assert.equal(await l.readoutAt(-64.7958, -63.2256), null, 'a layer that is off is not read');
  l.enable();
  const at = await l.readoutAt(-64.7958, -63.2256);
  assert.equal(at.status, 'value');
  assert.equal(at.text, 'Breakwater Island (under 1 km): gentoo 1,471 chicks, 2,337 nests (2025/26)');
  assert.equal(at.date, 'mapppdr v3.1 (2026-08-21)');
  // reach: NEAR_KM (10 km) north of the site is in, 12 km is out
  const north = (km) => -64.7958 + km / 111.195;
  assert.match((await l.readoutAt(north(NEAR_KM - 0.5), -63.2256)).text, /^Breakwater Island \(10 km\)/);
  const out = await l.readoutAt(north(NEAR_KM + 2), -63.2256);
  assert.equal(out.status, 'class', 'no site in reach is a statement, not missing data');
  assert.equal(out.text, 'no penguin breeding site recorded within 10 km');
  // a shared site lists every species in SPECIES order, each with its own counts
  assert.equal((await l.readoutAt(-62.5, -60.0)).text, 'Two <Species> Point (under 1 km): Adélie 1 nest (1999/00); chinstrap 1 nest (1999/00)');
  // two sites within reach: the nearest is named and the other counted
  const pair = createPenguinsLayer({ fetchImpl: okFetch(data([BREA, { ...LAZN, lat: -64.7958 + 6 / 111.195, lon: -63.2256 }])) });
  pair.init(fakeViewer().viewer);
  await pair.update();
  pair.enable();
  assert.equal((await pair.readoutAt(-64.7958 + 1 / 111.195, -63.2256)).text,
    'Breakwater Island (1 km): gentoo 1,471 chicks, 2,337 nests (2025/26) · 1 other breeding site within 10 km');
  assert.match((await pair.readoutAt(-64.7958 + 5 / 111.195, -63.2256)).text, /^Lazarev North \(1 km\): emperor present, not counted \(2022\/23\) · 1 other/);
  assert.equal((await l.readoutAt(91, 0)).status, 'outside');
});

test('update: HTTP error and a malformed file fail loud; a retry loads; a good file is read once', async () => {
  for (const [fetchImpl, message] of [
    [async () => ({ ok: false, status: 404 }), /penguins\.json HTTP 404/],
    [okFetch({ points: [{ ...BREA, species: 'ROPE' }] }), /species the legend does not know: ROPE/],
  ]) {
    const l = createPenguinsLayer({ fetchImpl });
    l.init(fakeViewer().viewer);
    const errors = [];
    const saved = console.error;
    console.error = (m) => errors.push(m);
    try {
      assert.equal(await l.update(), false);
    } finally { console.error = saved; }
    assert.match(l.getStats().error, message);
    assert.match(errors[0], message, 'the failure is logged, not swallowed');
    l.enable();
    assert.equal((await l.readoutAt(-64.7958, -63.2256)).status, 'error');
  }
  let calls = 0;
  const l = createPenguinsLayer({ fetchImpl: async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => data() }; } });
  l.init(fakeViewer().viewer);
  const saved = console.error;
  console.error = () => {};
  try {
    assert.equal(await l.update(), false);
  } finally { console.error = saved; }
  assert.equal(await l.update(), true, 'positive control: a retry after a failure loads and clears the error');
  assert.equal(l.getStats().error, null);
  assert.equal(await l.update(), true);
  assert.equal(calls, 2, 'a pinned release is read once');
});
