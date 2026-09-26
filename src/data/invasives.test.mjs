// src/data/invasives.test.mjs — GRIIS introduced species per checklist: bins, readout wording by basis, layer contract (off the time bar), legend, seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { BINS, binOf, readoutText, describeList, createInvasivesLayer } from './invasives.js';

test('binOf: log bins <100 / 100–300 / 300–1k / 1k–3k / ≥3k at their edges', () => {
  const keys = [0, 5, 99, 100, 299, 300, 999, 1000, 2999, 3000, 8527].map((n) => binOf(n).key);
  assert.deepEqual(keys, ['lt100', 'lt100', 'lt100', 'lt300', 'lt300', 'lt1k', 'lt1k', 'lt3k', 'lt3k', 'ge3k', 'ge3k']);
  assert.equal(BINS.length, 5);
  assert.equal(new Set(BINS.map((b) => b.color)).size, 5);
  assert.throws(() => binOf(-1), /introduced/);
  assert.throws(() => binOf(null), /introduced/);
});

const P = (o = {}) => ({ key: 'ws', area: 'Samoa', units: ['WSM'], introduced: 386, invasive: 156, basis: 'impact', presence: 'stated',
  version: '2026-03-28', doi: '10.15468/x <y>', licence: 'CC BY 4.0', citation: 'Pagad S (2026). GRIIS - Samoa <b>.', ...o });

test('readoutText: A30 wording, invasive by the list\'s own basis, never a severity word', () => {
  assert.equal(readoutText(P()), 'Introduced species on the GRIIS list: 386 · invasive 156 (evidence of impact) · Samoa list, 2026');
  assert.equal(readoutText(P({ area: 'Belgium', introduced: 4215, invasive: 97, basis: 'spread', version: '2025-12-29' })),
    'Introduced species on the GRIIS list: 4,215 · invasive 97 (spreading) · Belgium list, 2025');
  assert.equal(readoutText(P({ area: 'Afghanistan', introduced: 70, invasive: null, basis: 'not stated' })),
    'Introduced species on the GRIIS list: 70 · invasive: not stated on this list · Afghanistan list, 2026');
  assert.equal(readoutText(P({ area: 'Turkey', introduced: 953, presence: 'not stated' })),
    'Introduced species on the GRIIS list: 953 (presence not stated on the list) · invasive 156 (evidence of impact) · Turkey list, 2026');
});

test('describeList: escapes list text, links the DOI, names licence and shapes', () => {
  const html = describeList(P());
  assert.match(html, /<b>Samoa<\/b>.*386.*introduced.*156.*evidence of impact.*2026-03-28.*Pagad S \(2026\)\. GRIIS - Samoa &lt;b&gt;\..*doi\.org\/10\.15468\/x%20%3Cy%3E.*CC BY 4\.0.*Natural Earth/s);
  assert.doesNotMatch(html, /<y>|<b>\./);
});

function geojson() {
  const sq = (x) => [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]];
  return { type: 'FeatureCollection', generated_at: '2026-09-25T12:00:00Z',
    source: { id: 'griis', name: 'GRIIS, ISSG via GBIF', licence: 'CC BY 4.0' },
    protected_areas: ['Lake Mburo, Uganda', 'Kruger'],
    not_drawn: [{ key: 'ch', area: 'Chatham Islands, New Zealand', introduced: 40, invasive: 9, basis: 'impact', presence: 'stated', version: '2020-10-05' }],
    features: [
      { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [sq(0)] }, properties: P() },
      { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [sq(10), sq(12)] },
        properties: P({ key: 'us', area: 'United States (Contiguous)', introduced: 8527, invasive: 2503, basis: 'spread' }) },
      { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [sq(20)] },
        properties: P({ key: 'af', area: 'Afghanistan', introduced: 70, invasive: null, basis: 'not stated' }) },
    ] };
}

async function withFetch(gj, fn) {
  const saved = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return { ok: true, json: async () => gj }; };
  try { return await fn(urls); } finally { globalThis.fetch = saved; }
}

test('layer: contract without the time bar, parts, bins, legend names what is not drawn, readout', async () => {
  await withFetch(geojson(), async (urls) => {
    const l = createInvasivesLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getRowControls', 'readoutAt', 'setRowControlsListener'])
      assert.equal(typeof l[k], 'function', k);
    assert.equal(l.setObservedTime, undefined, 'A25: the checklist version is not an observed time');
    assert.equal(l.getObservedExtent, undefined);
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.match(urls[0], /^data\/griis\.geojson\?t=\d+$/);
    assert.equal(ds.entities.values.length, 4, 'MultiPolygon → one entity per part');
    assert.ok(ds.entities.getById('griis:us:1'));
    // No height = Cesium drapes the polygon over terrain (a ground primitive: the most expensive polygon path, ~6 fps
    // on an Intel iGPU with 1,480 parts) and silently drops the outline ("outlines are unsupported on terrain").
    for (const e of ds.entities.values) {
      assert.equal(e.polygon.height?.getValue(), 0, `${e.id}: flat on the ellipsoid, not clamped to terrain`);
      assert.equal(e.polygon.outline.getValue(), true, 'the outline is drawn now that the polygon is not on terrain');
    }
    assert.deepEqual(l.getStats().bins, { lt300: 0, lt100: 1, lt1k: 1, lt3k: 0, ge3k: 1 });
    assert.equal(l.getStats().notDrawn, 1);
    assert.equal(l.getStats().protectedAreas, 2);

    const legend = l.getRowControls().legend;
    assert.equal(legend.find((i) => i.label === '≥ 3,000').count, 1);
    assert.ok(legend.some((i) => /fill = introduced species on the GRIIS list/.test(i.label) && !/sever|risk|threat/i.test(i.label)));
    assert.ok(legend.some((i) => /not drawn.*Chatham Islands, New Zealand/.test(i.label)), 'smaller lists are named, not dropped');
    assert.ok(legend.some((i) => /2 protected-area lists/.test(i.label)));
    assert.ok(legend.some((i) => /no fill = no GRIIS list drawn/.test(i.label)));

    assert.equal(await l.readoutAt(0.5, 0.5), null, 'disabled layer is not read');
    l.enable();
    const hit = await l.readoutAt(0.5, 12.5);
    assert.equal(hit.status, 'class');
    assert.equal(hit.date, '2026-03-28', 'the date is the checklist version');
    assert.match(hit.text, /^Introduced species on the GRIIS list: 8,527 · invasive 2,503 \(spreading\) · United States \(Contiguous\) list, 2026$/);
    const miss = await l.readoutAt(50, 50);
    assert.equal(miss.status, 'class', 'positive statement, not an error');
    assert.equal(miss.text, 'Not in an area with a drawn GRIIS list');
  });
});

test('update: HTTP error and malformed file fail loud and keep nothing', async () => {
  const saved = globalThis.fetch;
  try {
    const l = createInvasivesLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /griis\.geojson HTTP 404/);
    const bad = geojson();
    bad.features[0].properties.introduced = '386';
    globalThis.fetch = async () => ({ ok: true, json: async () => bad });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /Samoa.*introduced/);
    const badBasis = geojson();
    badBasis.features[1].properties.basis = 'severity';
    globalThis.fetch = async () => ({ ok: true, json: async () => badBasis });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /basis/);
    globalThis.fetch = async () => ({ ok: true, json: async () => geojson() });
    assert.equal(await l.update(), true, 'positive control: a good file loads and clears the error');
    assert.equal(l.getStats().error, null);
  } finally { globalThis.fetch = saved; }
});

test('seed (public/data/seed/griis.geojson): < 100 KB, subsampling stated, layer loads it', async () => {
  const url = new URL('../../public/data/seed/griis.geojson', import.meta.url);
  const size = (await stat(url)).size;
  assert.ok(size < 100_000, `seed is ${size} bytes`);
  const gj = JSON.parse(await readFile(url, 'utf8'));
  assert.match(gj.source?.subsample ?? '', /seed/);
  await withFetch(gj, async () => {
    const l = createInvasivesLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(l.getStats().count, 20);
  });
});
