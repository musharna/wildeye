// src/data/marineRealms.test.mjs — the marine realms layer: file validation, entities, group chips, readout, legend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITION, GROUP_LABELS, createMarineRealmsLayer, describeRealm, realmText, validateRealms } from './marineRealms.js';

// 30 one-degree squares along the equator, the shape pipeline/marine_realms.py writes; realm 2 is a ring with a hole
// (an island) and realm 30 a MultiPolygon with a part on the antimeridian.
const sq = (x, y, d = 1) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
const GROUP_OF = (r) => (r <= 2 ? r : r <= 8 ? 3 : r === 9 ? 4 : r === 10 ? 5 : r <= 28 ? 6 : r === 29 ? 7 : 8);
function realmFeature(r) {
  const x = (r - 1) * 2;
  const geometry =
    r === 2
      ? { type: 'Polygon', coordinates: [sq(x, 0, 1), [[x + 0.4, 0.4], [x + 0.6, 0.4], [x + 0.6, 0.6], [x + 0.4, 0.6], [x + 0.4, 0.4]]] }
      : r === 30
        ? { type: 'MultiPolygon', coordinates: [[sq(x, 0)], [sq(x, 10)], [sq(-180, 20)]] }
        : { type: 'Polygon', coordinates: [sq(x, 0)] };
  return {
    type: 'Feature',
    geometry,
    properties: { realm: r, name: r === 2 ? 'Black Sea' : `Realm ${r}`, group: GROUP_OF(r), group_name: `group ${GROUP_OF(r)}`, pct_unique: r === 2 ? 84 : 30, species: r === 2 ? 192 : 1000 + r, color: `#${(0x102030 + r).toString(16)}`, area_km2: 12345 },
  };
}
const GEOJSON = Object.freeze({
  type: 'FeatureCollection',
  source: { name: 'Marine biogeographic realms (Costello et al. 2017)', url: 'https://doi.org/10.17608/k6.auckland.5596840', licence: 'CC BY 4.0' },
  groups: Object.fromEntries(Object.keys(GROUP_LABELS).map((g) => [g, `group ${g}`])),
  features: Array.from({ length: 30 }, (_, i) => realmFeature(i + 1)),
});

function harness({ geojson = GEOJSON, status = 200 } = {}) {
  const added = [];
  const ds = { show: true, entities: { values: [], suspendEvents() {}, resumeEvents() {}, removeAll() { this.values = []; }, add(e) { const ent = { ...e, show: true, properties: Object.fromEntries(Object.entries(e.properties).map(([k, v]) => [k, { getValue: () => v }])) }; this.values.push(ent); return ent; } } };
  const viewer = { dataSources: { add: (d) => added.push(d), remove: () => true } };
  const layer = createMarineRealmsLayer({
    fetchImpl: async () => ({ ok: status === 200, status, json: async () => structuredClone(geojson) }),
    dataSourceFor: () => ds,
  });
  layer.init(viewer);
  return { layer, ds, added };
}

test('validation: the pipeline shape is accepted; each broken field is named', () => {
  assert.equal(validateRealms(GEOJSON), null);
  const mutate = (k, fn) => {
    const g = structuredClone(GEOJSON);
    fn(g.features[k]);
    return g;
  };
  const broken = [
    [{ ...GEOJSON, features: GEOJSON.features.slice(1) }, /29 realms, not 30/],
    [mutate(3, (f) => { f.properties.realm = 31; }), /not 1–30/],
    [mutate(3, (f) => { f.properties.realm = 3.5; }), /not 1–30/],
    [mutate(3, (f) => { f.properties.realm = 5; }), /realm 5 appears twice/],
    [mutate(3, (f) => { f.properties.group = 9; }), /group 9/],
    [mutate(3, (f) => { f.properties.color = 'red'; }), /colour/],
    [mutate(3, (f) => { f.properties.name = ''; }), /no name/],
    [mutate(3, (f) => { f.geometry.type = 'LineString'; }), /not a polygon/],
    [null, /no features/],
  ];
  for (const [g, why] of broken) assert.match(validateRealms(g) ?? 'accepted', why);
});

test('text: the readout names the realm, its number and its share of unique species; the info box adds group and area', () => {
  const p = GEOJSON.features[1].properties;
  assert.equal(realmText(p), 'Black Sea (realm 2) · 84% of its 192 species unique to it');
  const html = describeRealm({ ...p, name: 'A <b>' });
  assert.match(html, /A &lt;b&gt;/, 'names are escaped');
  assert.match(html, /realm 2 of 30/);
  assert.match(html, /Group: group 2/);
  assert.match(html, /12,345 km²/);
  assert.match(html, /CC BY 4\.0/);
});

test('entities: one per polygon part, holes kept, coloured by realm; group chips hide and show their realms', async () => {
  const { layer, ds } = harness();
  assert.equal(await layer.update(), true);
  assert.equal(ds.entities.values.length, 32, '30 realms, realm 30 in three parts');
  const black = ds.entities.values.find((e) => e.id === 'marine-realms:2:0');
  assert.equal(black.polygon.hierarchy.holes.length, 1, 'the island stays a hole');
  assert.ok(ds.entities.values.find((e) => e.id === 'marine-realms:30:1'));
  const { chips, legend } = layer.getRowControls();
  assert.deepEqual(chips.map((c) => c.label), ['BALTIC 1', 'BLACK SEA 1', 'N ATLANTIC, ARCTIC & N PACIFIC 6', 'MID-TROP N PACIFIC 1', 'SE PACIFIC 1', 'TROPICS & WARM SEAS 18', 'NW PACIFIC 1', 'SOUTHERN OCEAN 1']);
  assert.equal(legend.length, 31);
  assert.deepEqual(legend[1], { label: '2 Black Sea', color: GEOJSON.features[1].properties.color, count: null });

  assert.equal(layer.setParams({ 6: false, 99: false, 3: 'no' }), true);
  const shown = (r) => ds.entities.values.filter((e) => e.properties.realm.getValue() === r).every((e) => e.show);
  assert.equal(shown(11), false);
  assert.equal(shown(28), false);
  assert.equal(shown(2), true, 'other groups stay');
  assert.equal(layer.getRowControls().legend.length, 31 - 18);
  assert.deepEqual(layer.getParams(), { 1: true, 2: true, 3: true, 4: true, 5: true, 6: false, 7: true, 8: true });
  assert.equal(layer.setParams({ 6: false }), false, 'no change, no redraw');
  layer.setParams({ 6: true });
  assert.equal(shown(11), true);
});

test('readout: the realm under a point, land in no realm, nothing while off; a missing or broken file is loud', async () => {
  const { layer, ds } = harness();
  await layer.update();
  assert.equal(await layer.readoutAt(0.2, 2.2), null, 'registered off: no row');
  layer.enable();
  assert.deepEqual(
    { ...(await layer.readoutAt(0.2, 2.2)), icon: null },
    { id: 'marine-realms', name: 'Marine realms (Costello et al. 2017)', icon: null, status: 'class', text: 'Black Sea (realm 2) · 84% of its 192 species unique to it', date: EDITION },
  );
  assert.equal((await layer.readoutAt(0.5, 2.5)).text, 'Land: not in a marine realm', 'the island in the hole');
  assert.equal((await layer.readoutAt(10.5, 58.5)).text.startsWith('Realm 30 (realm 30)'), true, "a MultiPolygon's second part");
  assert.equal((await layer.readoutAt(-40, -40)).text, 'Land: not in a marine realm');
  assert.match((await layer.readoutAt(20.5, 180)).text, /^Realm 30 /, '180° is the antimeridian part at -180°');
  assert.match((await layer.readoutAt(20.5, -180)).text, /^Realm 30 /);
  assert.match((await layer.readoutAt(0.2, 362.2)).text, /^Black Sea/, 'longitudes wrap');
  assert.equal((await layer.readoutAt(20.5, 179)).text, 'Land: not in a marine realm', 'positive control: just west of it is not');
  layer.setParams({ 2: false });
  assert.match((await layer.readoutAt(0.2, 2.2)).text, /^Black Sea/, 'a hidden group still answers: the readout is about the point, not the chips');
  layer.disable();
  assert.equal(await layer.readoutAt(0.2, 2.2), null);

  const gone = harness({ status: 404 });
  assert.equal(await gone.layer.update(), false);
  gone.layer.enable();
  assert.match(gone.layer.getStats().error, /HTTP 404/);
  assert.match((await gone.layer.readoutAt(0, 0)).error, /HTTP 404/);
  const bad = harness({ geojson: { ...GEOJSON, features: GEOJSON.features.slice(0, 29) } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed marine_realms\.geojson: 29 realms/);
  assert.equal(bad.ds.entities.values.length, 0, 'nothing drawn');
});
