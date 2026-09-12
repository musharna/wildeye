// src/data/ecoregions.test.mjs — polygon contract (static): biome palette mirrors the pipeline, area format,
// info box, MultiPolygon parts, biome chips, analyst records. No observed time: the layer is not time-varying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BIOMES, NNH, UNKNOWN_BIOME, FILL_ALPHA, biomeOf, formatArea, describeEcoregion, ecoregionEntities, createEcoregionsLayer } from './ecoregions.js';

// real feature properties from the 2026-09-12 run of pipeline/ecoregions.py (eco_id 1)
const ALBERTINE = { eco_id: 1, name: 'Albertine Rift montane forests', biome: 1, biome_name: 'Tropical & Subtropical Moist Broadleaf Forests', realm: 'Afrotropic', nnh: 4, nnh_name: 'Nature Imperiled', area_km2: 151166 };
const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];

test('biome palette and NNH names mirror pipeline/ecoregions.py; unknown biome falls back', () => {
  // mutant verified: BIOMES[14].color "#FE01C4" -> "#FE01C5" fails the deepEqual
  const py = readFileSync(new URL('../../pipeline/ecoregions.py', import.meta.url), 'utf8');
  const pyBiomes = Object.fromEntries([...py.matchAll(/^\s+(\d+): \("([^"]+)", "(#[0-9A-F]{6})"\),$/gm)].map(([, k, name, color]) => [k, { name, color }]));
  assert.equal(Object.keys(pyBiomes).length, 14, 'regex found all 14 pipeline biomes');
  assert.deepEqual({ ...BIOMES }, pyBiomes);
  const pyNnh = Object.fromEntries([...py.matchAll(/^\s+(\d): "([^"]+)",$/gm)].map(([, k, v]) => [k, v]));
  assert.deepEqual({ ...NNH }, pyNnh);
  assert.equal(biomeOf('7').name, 'Tropical & Subtropical Grasslands, Savannas & Shrublands', 'string keys from entity properties resolve');
  assert.equal(biomeOf(14).color, '#FE01C4');
  assert.equal(biomeOf(99), UNKNOWN_BIOME);
  assert.equal(biomeOf(undefined), UNKNOWN_BIOME);
});

test('formatArea thresholds', () => {
  // mutant verified: `v >= 1e6` -> `v > 1e6` fails on 1e6
  assert.deepEqual([0, -5, NaN, undefined, 'x'].map(formatArea), Array(5).fill('area unknown'));
  assert.equal(formatArea(151166), '151,166 km²');
  assert.equal(formatArea(999_999), '999,999 km²');
  assert.equal(formatArea(1e6), '1.00 million km²');
  assert.equal(formatArea(4_567_890), '4.57 million km²');
});

test('describeEcoregion: name, biome, realm, NNH category, area, licence; escapes text', () => {
  // mutant verified: dropping esc() around p.name lets the <img> tag through
  const html = describeEcoregion(ALBERTINE, { name: 'RESOLVE Ecoregions 2017', url: 'https://ecoregions.appspot.com/', licence: 'CC BY 4.0 (RESOLVE)' });
  assert.match(html, /<b>Albertine Rift montane forests<\/b>.*Biome: .*#38A700.*Tropical &amp; Subtropical Moist Broadleaf Forests.*Realm: Afrotropic.*Nature Needs Half: Nature Imperiled.*Area: 151,166 km².*ID 1.*https:\/\/ecoregions\.appspot\.com\/.*CC BY 4\.0 \(RESOLVE\)/s);
  const evil = describeEcoregion({ ...ALBERTINE, name: '<img src=x onerror=alert(1)>', realm: 'A"B' });
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /&lt;img src=x onerror=alert\(1\)&gt;.*Realm: A&quot;B/s, 'escaped text still present (positive control)');
  // the seed's dissolved biomes carry nnh 0
  assert.match(describeEcoregion({ ...ALBERTINE, nnh: 0 }), /Nature Needs Half: not categorised/);
  assert.match(describeEcoregion({ ...ALBERTINE, nnh: 1 }), /Nature Needs Half: Half Protected/);
});

test('ecoregionEntities: one entity per MultiPolygon part, biome colour at FILL_ALPHA', () => {
  // mutant verified: always using [f.geometry.coordinates] yields 1 entity for the MultiPolygon
  const multi = ecoregionEntities({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [poly, poly] }, properties: ALBERTINE });
  assert.deepEqual(multi.map((e) => e.id), ['ecoregions:1:0', 'ecoregions:1:1']);
  assert.deepEqual(multi.map((e) => e.properties.part), [0, 1]);
  const c = multi[0].polygon.material;
  assert.equal(FILL_ALPHA, 0.35);
  assert.equal(c.alpha, 0.35);
  assert.equal(Math.round(c.red * 255), 0x38);
  assert.equal(Math.round(c.green * 255), 0xa7);
  const single = ecoregionEntities({ type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { ...ALBERTINE, eco_id: 2, biome: 13 } });
  assert.equal(single.length, 1);
  assert.equal(Math.round(single[0].polygon.material.red * 255), 0xcc);
});

function gjFixture() {
  return {
    type: 'FeatureCollection', generated_at: '2026-09-12T21:17:56Z', source: { name: 'RESOLVE Ecoregions 2017', licence: 'CC BY 4.0', url: 'https://ecoregions.appspot.com/' },
    features: [
      { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [poly, poly] }, properties: ALBERTINE },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { ...ALBERTINE, eco_id: 785, name: 'Aegean desert', biome: 13, biome_name: 'Deserts & Xeric Shrublands', realm: 'Palearctic', nnh: 4 } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly }, properties: { ...ALBERTINE, eco_id: 135, name: 'Admiralty Islands lowland rain forests', realm: 'Australasia', nnh: 2, area_km2: 2108 } },
    ],
  };
}
const viewer = (sink) => ({ dataSources: { add(d) { sink.ds = d; }, remove() {} } });

test('layer: contract, static (no observed time), biome chips hide/show, legend, records', async () => {
  // mutants verified: (a) applyVisibility ignoring _biomes leaves hidden entities shown;
  // (b) getAnalystRecords without the e.show filter returns 3 records while biome 1 is hidden
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gjFixture() });
  try {
    const l = createEcoregionsLayer();
    for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setRowControlsListener', 'setParams', 'getParams']) assert.equal(typeof l[k], 'function', k);
    assert.equal(l.setObservedTime, undefined, 'not time-varying');
    assert.equal(l.id, 'ecoregions');
    assert.equal(l.icon, '🗺️');
    assert.equal(l.name, 'Ecoregions and biomes (RESOLVE 2017)');
    const sink = {};
    l.init(viewer(sink));
    assert.equal(await l.update(), true);
    assert.equal(sink.ds.entities.values.length, 4);
    const st = l.getStats();
    assert.equal(st.count, 3);
    assert.equal(st.error, null);
    assert.deepEqual(st.biomes, { 1: 2, 13: 1 });
    let calls = 0;
    l.setRowControlsListener(() => calls++);
    const rc = l.getRowControls();
    assert.deepEqual(rc.chips.map((c) => c.label), ['TROP MOIST FOREST 2', 'DESERT 1']);
    assert.deepEqual(rc.legend.slice(0, 2).map((i) => [i.color, i.count]), [['#38A700', 2], ['#CC6767', 1]]);
    assert.match(rc.legend.at(-1).label, /3 ecoregions, static/);

    assert.deepEqual(l.getAnalystRecords(), [], 'hidden layer reports nothing');
    l.enable();
    assert.equal(l.getAnalystRecords().length, 3, 'one record per ecoregion (part 0 only)');
    assert.deepEqual(l.getAnalystRecords().find((r) => r.eco_id === 1), { id: 'ecoregions:1:0', eco_id: 1, name: 'Albertine Rift montane forests', biome: 'Tropical & Subtropical Moist Broadleaf Forests', realm: 'Afrotropic', nnh: 'Nature Imperiled', area_km2: 151166 });

    const chip = rc.chips[0];
    assert.equal(l.setParams(chip.params), true);
    assert.equal(calls, 1);
    const shown = (id) => sink.ds.entities.getById(id).show;
    assert.deepEqual(['ecoregions:1:0', 'ecoregions:1:1', 'ecoregions:135:0', 'ecoregions:785:0'].map(shown), [false, false, false, true]);
    assert.deepEqual(l.getAnalystRecords().map((r) => r.eco_id), [785]);
    const rc2 = l.getRowControls();
    assert.equal(rc2.chips[0].state, 'idle');
    assert.deepEqual(rc2.legend.filter((i) => i.count !== null).map((i) => i.color), ['#CC6767'], 'hidden biome leaves the legend');
    assert.equal(l.setParams({ 99: false }), false, 'unknown biome ignored');
    assert.equal(l.setParams({ 13: 'no' }), false, 'non-boolean ignored');
    assert.equal(l.setParams({ 1: true }), true);
    assert.equal(l.getAnalystRecords().length, 3);
    assert.deepEqual(l.getParams(), { 1: true, 13: true });
  } finally { globalThis.fetch = saved; }
});

test('layer: HTTP error and malformed file surface in getStats', async () => {
  const saved = globalThis.fetch;
  try {
    const l = createEcoregionsLayer();
    l.init(viewer({}));
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /HTTP 404/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection' }) });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /Malformed/);
    globalThis.fetch = async () => ({ ok: true, json: async () => gjFixture() });
    assert.equal(await l.update(), true, 'positive control: a good file clears the error');
    assert.equal(l.getStats().error, null);
  } finally { globalThis.fetch = saved; }
});
