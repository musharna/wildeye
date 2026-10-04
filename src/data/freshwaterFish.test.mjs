// src/data/freshwaterFish.test.mjs — the freshwater fish layer: file validation, entities, realm chips, bin legend,
// readout (every basin under the point: the source's basins overlap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITION, REALM_LABELS, basinText, createFreshwaterFishLayer, describeBasin, validateBasins } from './freshwaterFish.js';

const sq = (x, y, d = 1) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
const BINS = [1, 10, 25, 50, 100, 250, 500, 1000].map((min, i) => ({ min, label: `bin ${i}`, color: `#00000${i}` }));
const basin = (id, name, realm, species, bin, geometry) => ({
  type: 'Feature',
  geometry,
  properties: { id, name, realm, country: 'C', species, families: [['Loricariidae', 380], ['Cichlidae', 257]], bin, color: BINS[bin].color, area_km2: 6_100_000 },
});
// Amazon; Mabelle River lying wholly inside Komo River, as in the source; Dreketi River across the antimeridian.
const GEOJSON = Object.freeze({
  type: 'FeatureCollection',
  source: { name: 'Freshwater fish species per drainage basin', url: 'https://doi.org/10.5281/zenodo.19511163', licence: 'CC BY 4.0' },
  bins: BINS,
  features: [
    basin('B0001', 'Amazon', 'Neotropic', 2815, 7, { type: 'Polygon', coordinates: [sq(-70, -10, 10)] }),
    basin('B0002', 'Komo River', 'Afrotropic', 6, 0, { type: 'Polygon', coordinates: [sq(10, 0, 2)] }),
    basin('B0003', 'Mabelle River', 'Afrotropic', 3, 0, { type: 'Polygon', coordinates: [sq(10.5, 0.5, 0.5)] }),
    basin('B0004', 'Dreketi River', 'Oceania', 1, 0, { type: 'MultiPolygon', coordinates: [[sq(178, -17)], [sq(-180, -17)]] }),
  ],
});

function harness({ geojson = GEOJSON, status = 200 } = {}) {
  const ds = { show: true, entities: { values: [], suspendEvents() {}, resumeEvents() {}, removeAll() { this.values = []; }, add(e) { const ent = { ...e, show: true, properties: Object.fromEntries(Object.entries(e.properties).map(([k, v]) => [k, { getValue: () => v }])) }; this.values.push(ent); return ent; } } };
  const viewer = { dataSources: { add: () => {}, remove: () => true } };
  const layer = createFreshwaterFishLayer({
    fetchImpl: async () => ({ ok: status === 200, status, json: async () => structuredClone(geojson) }),
    dataSourceFor: () => ds,
  });
  layer.init(viewer);
  return { layer, ds };
}

test('validation: the pipeline shape is accepted; each broken field is named', () => {
  assert.equal(validateBasins(GEOJSON), null);
  const mutate = (k, fn) => {
    const g = structuredClone(GEOJSON);
    fn(g.features[k]);
    return g;
  };
  const broken = [
    [{ ...GEOJSON, features: [] }, /no basins/],
    [{ ...GEOJSON, bins: BINS.slice(1) }, /7 bins, not 8/],
    [mutate(1, (f) => { f.properties.id = 'B0001'; }), /basin B0001 appears twice/],
    [mutate(1, (f) => { f.properties.realm = 'Atlantis'; }), /realm "Atlantis"/],
    [mutate(1, (f) => { f.properties.species = 0; }), /species 0/],
    [mutate(1, (f) => { f.properties.species = 2.5; }), /species 2.5/],
    [mutate(1, (f) => { f.properties.bin = 8; }), /bin 8/],
    [mutate(1, (f) => { f.properties.color = 'red'; }), /colour/],
    [mutate(1, (f) => { f.properties.name = ''; }), /no name/],
    [mutate(1, (f) => { f.geometry.type = 'Point'; }), /not a polygon/],
    [null, /no basins/],
  ];
  for (const [g, why] of broken) assert.match(validateBasins(g) ?? 'accepted', why);
});

test('text: the readout names the basin and its species; the info box adds realm, families and area', () => {
  assert.equal(basinText(GEOJSON.features[0].properties), 'Amazon · 2,815 freshwater fish species');
  assert.equal(basinText(GEOJSON.features[3].properties), 'Dreketi River · 1 freshwater fish species');
  const html = describeBasin({ ...GEOJSON.features[0].properties, name: 'A <b>' });
  assert.match(html, /A &lt;b&gt;/, 'names are escaped');
  assert.match(html, /Realm: Neotropic/);
  assert.match(html, /Country: C<br>/);
  // the source lists a basin's countries with ";" (the Amazon: "Bolivia;Brazil;…")
  assert.match(describeBasin({ ...GEOJSON.features[0].properties, country: 'Bolivia;Brazil;Peru' }), /Countries: Bolivia, Brazil, Peru<br>/);
  assert.match(html, /2,815/);
  assert.match(html, /Largest families: Loricariidae 380, Cichlidae 257/);
  assert.match(html, /6\.10 million km²/);
  assert.match(html, /native and introduced species are not told apart/);
  assert.match(html, /CC BY 4\.0/);
  assert.match(html, /doi\.org\/10\.1038\/sdata\.2017\.141/, 'Tedesco et al. 2017 is cited too');
});

test('entities: one per polygon part, coloured by bin; realm chips hide and show; the legend is the bins', async () => {
  const { layer, ds } = harness();
  assert.equal(await layer.update(), true);
  assert.equal(ds.entities.values.length, 5, '4 basins, Dreketi in two parts');
  assert.ok(ds.entities.values.find((e) => e.id === 'freshwater-fish:B0004:1'));
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips.map((c) => c.label), ['AFROTROPIC 2', 'NEOTROPIC 1', 'OCEANIA 1']);
  assert.deepEqual(legend.slice(0, 8).map((l) => [l.label, l.color]), BINS.map((b) => [`${b.label} species`, b.color]));
  assert.equal(legend.length, 9);

  assert.equal(layer.setParams({ Afrotropic: false, Atlantis: false, Neotropic: 'no' }), true);
  const shown = (id) => ds.entities.values.filter((e) => e.properties.id.getValue() === id).every((e) => e.show);
  assert.equal(shown('B0002'), false);
  assert.equal(shown('B0003'), false);
  assert.equal(shown('B0001'), true, 'other realms stay');
  assert.deepEqual(layer.getParams(), { Afrotropic: false, Neotropic: true, Oceania: true });
  assert.equal(layer.setParams({ Afrotropic: false }), false, 'no change, no redraw');
  layer.setParams({ Afrotropic: true });
  assert.equal(shown('B0002'), true);
  assert.equal(Object.keys(REALM_LABELS).length, 7);
});

test('readout: every basin under a point, none outside, nothing while off; a missing or broken file is loud', async () => {
  const { layer } = harness();
  await layer.update();
  assert.equal(await layer.readoutAt(-5, -65), null, 'registered off: no row');
  layer.enable();
  assert.deepEqual(
    { ...(await layer.readoutAt(-5, -65)), icon: null },
    { id: 'freshwater-fish', name: 'Freshwater fish (drainage basins)', icon: null, status: 'class', text: 'Amazon · 2,815 freshwater fish species', date: EDITION },
  );
  assert.equal(
    (await layer.readoutAt(0.75, 10.75)).text,
    'Komo River · 6 freshwater fish species; Mabelle River · 3 freshwater fish species (the source’s basins overlap here)',
    'both basins of an overlap, in file order',
  );
  assert.equal((await layer.readoutAt(1.5, 11.5)).text, 'Komo River · 6 freshwater fish species', 'positive control: outside the inner basin, one');
  assert.equal((await layer.readoutAt(30, -30)).text, 'Not in a mapped drainage basin');
  assert.match((await layer.readoutAt(-16.5, 180)).text, /^Dreketi River/, '180° is the part at -180°');
  assert.match((await layer.readoutAt(-16.5, 178.5)).text, /^Dreketi River/);
  assert.match((await layer.readoutAt(-5, 295)).text, /^Amazon/, 'longitudes wrap');
  layer.setParams({ Neotropic: false });
  assert.match((await layer.readoutAt(-5, -65)).text, /^Amazon/, 'a hidden realm still answers: the readout is about the point');
  layer.disable();
  assert.equal(await layer.readoutAt(-5, -65), null);

  const gone = harness({ status: 404 });
  assert.equal(await gone.layer.update(), false);
  gone.layer.enable();
  assert.match(gone.layer.getStats().error, /HTTP 404/);
  assert.match((await gone.layer.readoutAt(0, 0)).error, /HTTP 404/);
  const bad = harness({ geojson: { ...GEOJSON, bins: [] } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed freshwater_fish\.geojson: 0 bins/);
  assert.equal(bad.ds.entities.values.length, 0, 'nothing drawn');
});
