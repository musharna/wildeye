// src/data/mangroves.test.mjs — Global Mangrove Watch extent by country: year selection, change classes, point-in-polygon readout, layer contract + observed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { yearAt, changeClass, NO_DATA, NEW_SINCE, CHANGE_CLASSES, pointInGeometry, describeCountry, createMangrovesLayer } from './mangroves.js';

const YEARS = [1985, 2025];
const series = (a, b) => Array.from({ length: 41 }, (_, i) => a + ((b - a) * i) / 40);

test('yearAt: live = last year, inside the record = that UTC year, before = null, after = clamped with a flag', () => {
  assert.deepEqual(yearAt(null, YEARS), { year: 2025, latest: true });
  assert.deepEqual(yearAt('2010-06-01T00:00:00Z', YEARS), { year: 2010, latest: false });
  assert.deepEqual(yearAt('1985-01-01T00:00:00Z', YEARS), { year: 1985, latest: false });
  assert.deepEqual(yearAt('1984-12-31T23:59:59Z', YEARS), { year: null, latest: false });
  assert.deepEqual(yearAt('2026-09-25T00:00:00Z', YEARS), { year: 2025, latest: true });
  assert.equal(yearAt('garbage', YEARS), null);
});

test('changeClass: diverging classes on % change since the first year; none-then-some and no-data are their own', () => {
  const keys = [-60, -20.01, -20, -5.01, -5, 0, 4.99, 5, 49.99, 50, 4000].map((p) => changeClass(100, 100 * (1 + p / 100)).key);
  assert.deepEqual(keys, ['loss-high', 'loss-high', 'loss', 'loss', 'stable', 'stable', 'stable', 'gain', 'gain', 'gain-high', 'gain-high']);
  assert.equal(changeClass(0, 8), NEW_SINCE, 'no mangrove mapped in 1985 has no percentage');
  assert.equal(changeClass(0, 0), NO_DATA);
  assert.equal(changeClass(100, null), NO_DATA);
  assert.equal(CHANGE_CLASSES.length, 5);
});

test('pointInGeometry: polygon, hole, second MultiPolygon part, outside', () => {
  const sq = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]];
  const far = [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]];
  const g = { type: 'MultiPolygon', coordinates: [sq, far] };
  assert.equal(pointInGeometry(g, 2, 2), true);
  assert.equal(pointInGeometry(g, 5, 5), false, 'inside the hole');
  assert.equal(pointInGeometry(g, 20.5, 20.5), true, 'second part');
  assert.equal(pointInGeometry(g, 15, 15), false);
  assert.equal(pointInGeometry({ type: 'Polygon', coordinates: sq }, 2, 2), true);
});

test('describeCountry: extent with its 95% bounds in the shown year, change since 1985, source and licence', () => {
  const p = { iso: 'IDN', name: 'Indonesia <x>', ha: series(1000, 900), lo: series(950, 850), hi: series(1050, 960) };
  const html = describeCountry(p, { year: 2025, latest: true }, YEARS, { name: 'Global Mangrove Watch', version: '4.1.12', url: 'https://doi.org/x', licence: 'CC BY 4.0' });
  assert.match(html, /Indonesia &lt;x&gt;.*IDN.*2025.*900 ha.*95%.*850.*960.*−10(\.0)?% since 1985.*latest year.*Global Mangrove Watch.*4\.1\.12.*CC BY 4\.0/s);
  const before = describeCountry(p, { year: null, latest: false }, YEARS, {});
  assert.match(before, /no mangrove extent mapped before 1985/);
});

function geojson() {
  const sq = (x) => [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]];
  return { type: 'FeatureCollection', years: YEARS, source: { name: 'Global Mangrove Watch', version: '4.1.12', licence: 'CC BY 4.0', url: 'https://doi.org/x' },
    missing: [{ iso: 'BES_B', name: 'Bonaire', ha_last: 238.4 }],
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: sq(0) }, properties: { iso: 'AAA', name: 'Shrinking', ha: series(100, 50), lo: series(90, 45), hi: series(110, 55) } },
      { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [sq(10), sq(12)] }, properties: { iso: 'BBB', name: 'Growing', ha: series(100, 300), lo: series(90, 280), hi: series(110, 320) } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: sq(20) }, properties: { iso: 'CCC', name: 'New', ha: series(0, 8), lo: series(0, 7), hi: series(0, 9) } },
    ] };
}

async function withFetch(gj, fn) {
  const saved = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return { ok: true, json: async () => gj }; };
  try { return await fn(urls); } finally { globalThis.fetch = saved; }
}

test('layer: contract, parts, observed-time recolour, extent, legend lists the missing territories, readout', async () => {
  await withFetch(geojson(), async (urls) => {
    const l = createMangrovesLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getRowControls', 'setObservedTime', 'getObservedExtent', 'readoutAt']) assert.equal(typeof l[k], 'function', k);
    assert.equal(l.getObservedExtent(), null, 'no data → no extent');
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.match(urls[0], /^data\/gmw\.geojson\?t=\d+$/);
    assert.equal(ds.entities.values.length, 4, 'MultiPolygon → one entity per part');
    assert.deepEqual(l.getStats().classes, { 'loss-high': 1, 'gain-high': 1, new: 1 });
    assert.deepEqual(l.getObservedExtent(), { startMs: Date.UTC(1985, 0, 1), endMs: Date.UTC(2025, 11, 31, 23, 59, 59, 999) });

    assert.equal(l.setObservedTime('1995-07-01T00:00:00Z'), true); // 10 of 40 years in: AAA −12.5%, BBB +50%
    assert.deepEqual(l.getStats().classes, { loss: 1, 'gain-high': 1, new: 1 });
    assert.equal(l.getStats().year, 1995);
    assert.equal(l.setObservedTime('1980-01-01T00:00:00Z'), true);
    assert.deepEqual(l.getStats().classes, { none: 3 }, 'before the record every country is no-data grey');
    assert.equal(ds.entities.getById('gmw:AAA:0').polygon.material.getValue().color.alpha, 0.35);
    assert.equal(l.setObservedTime('bad'), false);
    l.setObservedTime(null);

    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => /^< −20/.test(i.label)).count, 1);
    assert.ok(legend.some((i) => /not drawn.*Bonaire/.test(i.label)), 'unmatched territories are named, not dropped');
    assert.ok(legend.some((i) => /change in mangrove extent since 1985.*2025/.test(i.label)));

    assert.equal(await l.readoutAt(0.5, 0.5), null, 'disabled layer is not read');
    l.enable();
    const hit = await l.readoutAt(0.5, 12.5);
    assert.equal(hit.status, 'class');
    assert.equal(hit.date, '2025');
    assert.match(hit.text, /Growing: 300 ha.*\+200% since 1985/);
    const miss = await l.readoutAt(50, 50);
    assert.equal(miss.status, 'class', 'positive statement, not an error');
    assert.match(miss.text, /not in a country with mapped mangroves/i);
    l.setObservedTime('1980-01-01T00:00:00Z');
    const early = await l.readoutAt(0.5, 0.5);
    assert.equal(early.status, 'nodata');
    assert.equal(early.date, '1980');
  });
});

test('update: HTTP error and malformed file fail loud and keep nothing', async () => {
  const saved = globalThis.fetch;
  try {
    const l = createMangrovesLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /gmw\.geojson HTTP 404/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ features: [] }) });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /years/);
    globalThis.fetch = async () => ({ ok: true, json: async () => geojson() });
    assert.equal(await l.update(), true, 'positive control: a good file loads and clears the error');
    assert.equal(l.getStats().error, null);
  } finally { globalThis.fetch = saved; }
});

test('seed (public/data/seed/gmw.geojson): < 100 KB, subsampling stated, layer loads it', async () => {
  const url = new URL('../../public/data/seed/gmw.geojson', import.meta.url);
  const size = (await stat(url)).size;
  assert.ok(size < 100_000, `seed is ${size} bytes`);
  const gj = JSON.parse(await readFile(url, 'utf8'));
  assert.match(gj.source?.subsample ?? '', /seed/);
  await withFetch(gj, async () => {
    const l = createMangrovesLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    assert.equal(await l.update(), true);
    assert.ok(l.getStats().count >= 10);
  });
});
