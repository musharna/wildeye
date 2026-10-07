// src/data/plantsWcvp.test.mjs — the WCVP native plants layer: file validation (counts, bins, colours), entities,
// legend, readout (native, endemic, introduced; none recorded; outside every unit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITION, createPlantsWcvpLayer, describeUnit, unitText, validateUnits } from './plantsWcvp.js';

const sq = (x, y, d = 1) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
const EDGES = [1, 10, 30, 100, 300, 1000, 3000, 10000];
const BINS = EDGES.map((min, i) => ({ min, label: `bin ${i}`, color: `#00000${i}` }));
const NONE = '#6b7280';
const unit = (id, name, native, endemic, introduced, bin, geometry) => ({
  type: 'Feature',
  geometry,
  properties: { id, name, native, endemic, introduced, bin, color: bin === null ? NONE : BINS[bin].color, area_km2: 1_140_000 },
});
// Colombia; Bouvet Island (none recorded); Fiji across the antimeridian; Great Britain.
const GEOJSON = Object.freeze({
  type: 'FeatureCollection',
  source: { name: 'World Checklist of Vascular Plants (WCVP) 16.0', url: 'https://sftp.kew.org/pub/data-repositories/WCVP/', licence: 'CC BY 3.0 (Royal Botanic Gardens, Kew)', version: '16.0' },
  bins: BINS,
  none_color: NONE,
  features: [
    unit('CLM', 'Colombia', 25490, 7935, 701, 7, { type: 'Polygon', coordinates: [sq(-79, -4, 12)] }),
    unit('BOU', 'Bouvet I.', 0, 0, 0, null, { type: 'Polygon', coordinates: [sq(3.3, -54.5, 0.2)] }),
    unit('FIJ', 'Fiji', 1, 1, 1, 0, { type: 'MultiPolygon', coordinates: [[sq(178, -17)], [sq(-180, -17)]] }),
    unit('GRB', 'Great Britain', 2948, 643, 2356, 5, { type: 'Polygon', coordinates: [sq(-6, 50, 8)] }),
  ],
});

function harness({ geojson = GEOJSON, status = 200 } = {}) {
  const ds = { show: true, entities: { values: [], suspendEvents() {}, resumeEvents() {}, removeAll() { this.values = []; }, add(e) { const ent = { ...e, show: true, properties: Object.fromEntries(Object.entries(e.properties).map(([k, v]) => [k, { getValue: () => v }])) }; this.values.push(ent); return ent; } } };
  const viewer = { dataSources: { add: () => {}, remove: () => true } };
  const layer = createPlantsWcvpLayer({
    fetchImpl: async () => ({ ok: status === 200, status, json: async () => structuredClone(geojson) }),
    dataSourceFor: () => ds,
  });
  layer.init(viewer);
  return { layer, ds };
}

const mutate = (k, fn) => {
  const g = structuredClone(GEOJSON);
  fn(g.features[k], g);
  return g;
};

test('validation: the pipeline shape is accepted; each broken field is named', () => {
  assert.equal(validateUnits(GEOJSON), null);
  const broken = [
    [{ ...GEOJSON, features: [] }, /no units/],
    [null, /no units/],
    [{ ...GEOJSON, bins: BINS.slice(1) }, /7 bins, not 8/],
    [{ ...GEOJSON, none_color: 'grey' }, /none colour "grey"/],
    [mutate(1, (f) => { f.properties.id = 'CLM'; }), /unit CLM appears twice/],
    [mutate(1, (f) => { f.properties.id = 'bou'; }), /unit id "bou"/],
    [mutate(1, (f) => { f.geometry.type = 'Point'; }), /not a polygon/],
    [mutate(1, (f) => { f.properties.name = ''; }), /no name/],
    [mutate(0, (f) => { f.properties.native = -1; }), /native -1/],
    [mutate(0, (f) => { f.properties.endemic = 2.5; }), /endemic 2.5/],
    [mutate(0, (f) => { f.properties.introduced = null; }), /introduced null/],
    [mutate(3, (f) => { f.properties.endemic = 2949; }), /2949 endemic of 2948 native/],
  ];
  for (const [g, why] of broken) assert.match(validateUnits(g) ?? 'accepted', why);
});

test('validation: a unit is coloured by the bin that holds its native count, and grey only with none recorded', () => {
  // each edge is the lowest count of its bin: 10 is bin 1, 9 is bin 0
  const at = (native, bin) => mutate(2, (f) => { Object.assign(f.properties, { native, endemic: 0, bin, color: BINS[bin].color }); });
  assert.equal(validateUnits(at(10, 1)), null);
  assert.equal(validateUnits(at(9, 0)), null);
  assert.equal(validateUnits(at(10000, 7)), null);
  assert.match(validateUnits(at(10, 0)) ?? 'accepted', /10 native is not in bin bin 0/);
  assert.match(validateUnits(at(9, 1)) ?? 'accepted', /9 native is not in bin bin 1/);
  assert.match(validateUnits(at(9999, 7)) ?? 'accepted', /9999 native is not in bin bin 7/);
  assert.match(validateUnits(mutate(3, (f) => { f.properties.color = BINS[4].color; })) ?? 'accepted', /GRB: colour #000004 is not bin bin 5's #000005/);
  assert.match(validateUnits(mutate(3, (f) => { f.properties.bin = 8; })) ?? 'accepted', /GRB: bin 8/);
  assert.match(validateUnits(mutate(1, (f) => { f.properties.color = BINS[0].color; })) ?? 'accepted', /BOU: no native species but bin null, colour #000000/);
  assert.match(validateUnits(mutate(1, (f) => { f.properties.bin = 0; })) ?? 'accepted', /BOU: no native species but bin 0/);
  assert.match(validateUnits(mutate(3, (f) => { Object.assign(f.properties, { bin: null, color: NONE }); })) ?? 'accepted', /GRB: bin null/, 'grey with species recorded is refused');
});

test('text: the readout gives native, endemic and introduced; the info box adds the caveats and credits', () => {
  assert.equal(unitText(GEOJSON.features[0].properties), 'Colombia · 25,490 native vascular plant species (7,935 endemic, 701 introduced)');
  assert.equal(unitText(GEOJSON.features[1].properties), 'Bouvet I. · no native vascular plant species recorded (0 introduced)');
  const html = describeUnit({ ...GEOJSON.features[3].properties, name: 'G <b>' }, GEOJSON.source);
  assert.match(html, /G &lt;b&gt;/, 'names are escaped');
  assert.match(html, /\(TDWG GRB\)/);
  assert.match(html, /Native vascular plant species: 2,948<br>/);
  assert.match(html, /Endemic \(native here and nowhere else\): 643<br>/);
  assert.match(html, /Introduced: 2,356<br>/);
  assert.match(html, /1\.14 million km²/);
  assert.match(html, /Larger units hold more species/);
  assert.match(html, /apomictic microspecies/);
  assert.match(html, /WCVP 16\.0/);
  assert.match(html, /CC BY 3\.0/);
  assert.match(html, /doi\.org\/10\.1038\/s41597-021-00997-6/, 'Govaerts et al. 2021 is cited');
  assert.match(html, /TDWG WGSRPD<\/a> \(CC BY 4\.0\)/);
});

test('entities: one per polygon part, filled with the unit colour; the legend is the bins, none, and the size caveat', async () => {
  const { layer, ds } = harness();
  assert.deepEqual(layer.getRowControls().legend, [], 'nothing before the file loads');
  assert.equal(await layer.update(), true);
  assert.equal(ds.entities.values.length, 5, '4 units, Fiji in two parts');
  const fiji = ds.entities.values.find((e) => e.id === 'plants-wcvp:FIJ:1');
  assert.ok(fiji);
  const fill = (id) => ds.entities.values.find((e) => e.id === `plants-wcvp:${id}:0`).polygon.material;
  assert.equal(fill('CLM').toCssHexString().slice(0, 7), BINS[7].color);
  assert.equal(fill('BOU').toCssHexString().slice(0, 7), NONE);
  assert.ok(fill('GRB').alpha > 0.3 && fill('GRB').alpha < 0.8, 'translucent over the globe');
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips, []);
  assert.deepEqual(legend.slice(0, 8).map((l) => [l.label, l.color]), BINS.map((b) => [`${b.label} native species`, b.color]));
  assert.deepEqual([legend[8].label, legend[8].color], ['none recorded', NONE]);
  assert.match(legend[9].label, /log scale \(4 TDWG Level-3 units, WCVP 16\.0\)\. Larger units hold more species/);
  assert.equal(legend.length, 10);
});

test('readout: the unit under a point, none outside, nothing while off; a missing or broken file is loud', async () => {
  const { layer } = harness();
  await layer.update();
  assert.equal(await layer.readoutAt(4, -74), null, 'registered off: no row');
  layer.enable();
  assert.deepEqual(
    { ...(await layer.readoutAt(4, -74)), icon: null },
    { id: 'plants-wcvp', name: 'Native plants (WCVP, botanical countries)', icon: null, status: 'class', text: 'Colombia · 25,490 native vascular plant species (7,935 endemic, 701 introduced)', date: EDITION },
  );
  assert.equal((await layer.readoutAt(-54.4, 3.4)).text, 'Bouvet I. · no native vascular plant species recorded (0 introduced)');
  assert.equal((await layer.readoutAt(30, -30)).text, 'Not in a botanical country');
  assert.match((await layer.readoutAt(-16.5, 180)).text, /^Fiji/, '180° is the part at -180°');
  assert.match((await layer.readoutAt(-16.5, 178.5)).text, /^Fiji/);
  assert.match((await layer.readoutAt(4, 286)).text, /^Colombia/, 'longitudes wrap');
  assert.equal(EDITION, 'WCVP 16.0');
  layer.disable();
  assert.equal(await layer.readoutAt(4, -74), null);

  const gone = harness({ status: 404 });
  assert.equal(await gone.layer.update(), false);
  gone.layer.enable();
  assert.match(gone.layer.getStats().error, /HTTP 404/);
  assert.match((await gone.layer.readoutAt(0, 0)).error, /HTTP 404/);
  const bad = harness({ geojson: { ...GEOJSON, bins: [] } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed plants_wcvp\.geojson: 0 bins/);
  assert.equal(bad.ds.entities.values.length, 0, 'nothing drawn');
});
