// src/data/hotspots.test.mjs — the biodiversity hotspots layer: file validation, entities, readout, legend, card text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITION, NONE_TEXT, areaText, createHotspotsLayer, describeArea, describeOuter, outerText, validateHotspots,
} from './hotspots.js';

// The shape pipeline/hotspots.py writes: 36 areas (1° squares on the equator, 2° apart, in name order), then outer
// limits. Hotspot 0 is a MultiPolygon with an island at 10° N; hotspot 1 has an outer limit that is a 0.4°-wide ring
// around its square, with the square as a hole, as the source's outer limits exclude their hotspot's land; hotspot 35
// has a part on the antimeridian at -180° and an outer limit straddling it in two parts.
const NAMES = Array.from({ length: 36 }, (_, i) => `Hotspot ${String(i).padStart(2, '0')}`);
NAMES[1] = 'Wallacea';
const sq = (x, y, d = 1) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
const colour = (i) => `#${(0x102030 + i).toString(16)}`;
function areaFeature(i) {
  const x = i * 2;
  const geometry =
    i === 0
      ? { type: 'MultiPolygon', coordinates: [[sq(x, 0)], [sq(x, 10)]] }
      : i === 35
        ? { type: 'MultiPolygon', coordinates: [[sq(x, 0)], [sq(-180, 20)]] }
        : { type: 'Polygon', coordinates: [sq(x, 0)] };
  return { type: 'Feature', geometry, properties: { kind: 'area', name: NAMES[i], color: colour(i), area_km2: i === 1 ? 337024 : 12364 } };
}
const OUTERS = [
  { type: 'Feature', geometry: { type: 'Polygon', coordinates: [sq(1.6, -0.4, 1.8), sq(2, 0)] }, properties: { kind: 'outer', name: 'Wallacea', color: colour(1) } },
  {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [[sq(178, 19, 2)], [sq(-180, 19, 2), sq(-180, 20)]] },
    properties: { kind: 'outer', name: NAMES[35], color: colour(35) },
  },
];
const GEOJSON = Object.freeze({
  type: 'FeatureCollection',
  source: { name: 'Biodiversity Hotspots (version 2016.1), Conservation International', url: 'https://doi.org/10.5281/zenodo.3261807', licence: 'CC BY-SA 4.0' },
  features: [...Array.from({ length: 36 }, (_, i) => areaFeature(i)), ...OUTERS],
});

function harness({ geojson = GEOJSON, status = 200 } = {}) {
  const ds = { show: true, entities: { values: [], suspendEvents() {}, resumeEvents() {}, removeAll() { this.values = []; }, add(e) { const ent = { ...e, show: true }; this.values.push(ent); return ent; } } };
  const viewer = { dataSources: { add: () => {}, remove: () => true } };
  const layer = createHotspotsLayer({
    fetchImpl: async () => ({ ok: status === 200, status, json: async () => structuredClone(geojson) }),
    dataSourceFor: () => ds,
  });
  layer.init(viewer);
  return { layer, ds };
}

test('validation: the pipeline shape is accepted; each broken field is named', () => {
  assert.equal(validateHotspots(GEOJSON), null);
  const mutate = (k, fn) => {
    const g = structuredClone(GEOJSON);
    fn(g.features[k], g);
    return g;
  };
  const broken = [
    [{ ...GEOJSON, features: GEOJSON.features.slice(1) }, /35 hotspot areas, not 36/],
    [mutate(3, (f) => { f.properties.name = NAMES[4]; }), /'Hotspot 04' hotspot area appears twice/],
    [mutate(3, (f) => { f.properties.name = ''; }), /no name/],
    [mutate(3, (f) => { f.properties.kind = 'buffer'; }), /kind "buffer"/],
    [mutate(3, (f) => { f.properties.color = 'red'; }), /colour "red"/],
    [mutate(3, (f) => { f.properties.area_km2 = 0; }), /'Hotspot 03': area 0/],
    [mutate(3, (f) => { f.geometry.type = 'LineString'; }), /geometry LineString is not a polygon/],
    [mutate(36, (f) => { f.properties.name = 'Atlantis'; }), /outer limit of 'Atlantis', which is not a hotspot area/],
    [mutate(36, (f, g) => { g.features.push(structuredClone(f)); }), /'Wallacea' outer limit appears twice/],
    [mutate(36, (f) => { f.properties.color = colour(2); }), /'Wallacea' outer limit is not in its hotspot's colour/],
    [mutate(36, (f) => { f.geometry.type = 'Point'; }), /geometry Point is not a polygon/],
    [null, /no features/],
  ];
  for (const [g, why] of broken) assert.match(validateHotspots(g) ?? 'accepted', why);
});

test('text: readout lines for a hotspot, an outer limit and neither; cards escape names and carry the licence', () => {
  assert.equal(areaText({ name: 'Sundaland', area_km2: 1494436 }), 'Sundaland biodiversity hotspot · 1.49 million km²');
  assert.equal(areaText({ name: 'New Caledonia', area_km2: 18920 }), 'New Caledonia biodiversity hotspot · 18,920 km²');
  assert.equal(outerText(['Wallacea']), "In the outer limit of Wallacea, which groups the hotspot's islands; not part of the hotspot");
  assert.equal(outerText(['A', 'B']), "In the outer limits of A and B, which group each hotspot's islands; not part of these hotspots");
  assert.equal(NONE_TEXT, 'Not in a biodiversity hotspot');
  const card = describeArea({ name: 'A <b>', area_km2: 18920 }, GEOJSON.source);
  assert.match(card, /<b>A &lt;b&gt;<\/b>/, 'names are escaped');
  assert.match(card, /Land area: 18,920 km²/);
  assert.match(card, /at least 1,500 endemic vascular plant species/);
  assert.match(card, /at least 70% of its primary native vegetation/);
  assert.match(card, /re-evaluation/);
  assert.match(card, /CC BY-SA 4\.0/);
  assert.match(card, /href="https:\/\/doi\.org\/10\.5281\/zenodo\.3261807"/);
  const outer = describeOuter({ name: 'Wallacea' }, GEOJSON.source);
  assert.match(outer, /<b>Outer limit of Wallacea<\/b>/);
  assert.match(outer, /not part of the hotspot itself/);
  assert.match(outer, /CC BY-SA 4\.0/);
});

test('entities: one filled polygon per area part; outer limits as dashed outer rings only', async () => {
  const { layer, ds } = harness();
  assert.equal(await layer.update(), true);
  const areas = ds.entities.values.filter((e) => e.polygon);
  const lines = ds.entities.values.filter((e) => e.polyline);
  assert.equal(areas.length, 38, '36 areas, hotspots 0 and 35 in two parts');
  assert.equal(lines.length, 3, "Wallacea's ring and the two parts straddling the antimeridian; no hole is drawn");
  assert.ok(areas.every((e) => e.polygon.fill !== false && e.polygon.outline === true));
  assert.equal(areas.find((e) => e.id === 'hotspots:area:0:1').properties.name, NAMES[0]);
  const ring = lines.find((e) => e.id === 'hotspots:outer:1:0');
  assert.equal(ring.polyline.positions.length, 5, "the 5 points of Wallacea's outer ring, not its hole");
  assert.equal(ring.polyline.material.constructor.name, 'PolylineDashMaterialProperty');
  assert.match(ring.description, /Outer limit of Wallacea/);
  assert.equal(ring.properties.kind, 'outer');
  const { legend } = layer.getRowControls();
  assert.equal(legend.length, 38);
  assert.deepEqual(legend[1], { label: 'Wallacea', color: colour(1), count: null });
  assert.match(legend[36].label, /^dashed line = outer limit/);
  assert.match(legend[36].color, /repeating-linear-gradient/);
  assert.match(legend[37].label, /re-evaluation/);
  assert.equal(layer.getStats().count, 36);
});

test('readout: the hotspot under a point, else the outer limit, else none; nothing while off; a bad file is loud', async () => {
  const { layer } = harness();
  await layer.update();
  assert.equal(await layer.readoutAt(0.5, 2.5), null, 'registered off: no row');
  layer.enable();
  assert.deepEqual(
    { ...(await layer.readoutAt(0.5, 2.5)), icon: null },
    { id: 'hotspots', name: 'Biodiversity hotspots (CI 2016.1)', icon: null, status: 'class', text: 'Wallacea biodiversity hotspot · 337,024 km²', date: EDITION },
  );
  assert.equal((await layer.readoutAt(0.5, 1.8)).text, outerText(['Wallacea']), 'the outer ring around it');
  assert.equal((await layer.readoutAt(-0.5, 2.5)).text, NONE_TEXT, 'past the outer limit');
  assert.equal((await layer.readoutAt(10.5, 0.5)).text, `${NAMES[0]} biodiversity hotspot · 12,364 km²`, "a MultiPolygon's second part");
  assert.equal((await layer.readoutAt(20.5, 180)).text.startsWith(NAMES[35]), true, '180° is the part at -180°');
  assert.equal((await layer.readoutAt(20.5, -179.5)).text.startsWith(NAMES[35]), true);
  assert.equal((await layer.readoutAt(19.5, 179)).text, outerText([NAMES[35]]), 'outer limit west of 180°');
  assert.equal((await layer.readoutAt(19.5, -179.5)).text, outerText([NAMES[35]]), 'and east of it');
  assert.equal((await layer.readoutAt(0.5, 362.5)).text.startsWith('Wallacea'), true, 'longitudes wrap');
  layer.disable();
  assert.equal(await layer.readoutAt(0.5, 2.5), null);

  const gone = harness({ status: 404 });
  assert.equal(await gone.layer.update(), false);
  gone.layer.enable();
  assert.match(gone.layer.getStats().error, /HTTP 404/);
  assert.match((await gone.layer.readoutAt(0, 0)).error, /HTTP 404/);
  const bad = harness({ geojson: { ...GEOJSON, features: GEOJSON.features.slice(1) } });
  assert.equal(await bad.layer.update(), false);
  assert.match(bad.layer.getStats().error, /Malformed hotspots\.geojson: 35 hotspot areas/);
  assert.equal(bad.ds.entities.values.length, 0, 'nothing drawn');
});

test('readout: a point in two outer limits names both; a point in an area and another hotspot\'s outer limit reads the area', async () => {
  const g = structuredClone(GEOJSON);
  // a second outer limit over Wallacea's square and its ring, for hotspot 2
  g.features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [sq(1.5, -0.5, 2)] }, properties: { kind: 'outer', name: NAMES[2], color: colour(2) } });
  const { layer } = harness({ geojson: g });
  assert.equal(await layer.update(), true);
  layer.enable();
  assert.equal((await layer.readoutAt(0.5, 1.8)).text, outerText(['Wallacea', NAMES[2]]));
  assert.equal((await layer.readoutAt(0.5, 2.5)).text, 'Wallacea biodiversity hotspot · 337,024 km²');
});

test('credit: the record, its authors, the share-alike licence, the criteria paper and what was changed, in the visible text', async () => {
  const { DATA_CREDITS } = await import('./dataCredits.js');
  const credit = DATA_CREDITS.find((c) => c.key === 'hotspots');
  assert.ok(credit, 'DATA_CREDITS has a hotspots entry');
  const text = credit.html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  assert.match(text, /Biodiversity Hotspots \(version 2016\.1\), Conservation International \(Hoffman, Koenig, Bunting, Costanza & Williams, Zenodo\), CC BY-SA 4\.0/);
  assert.match(text, /Myers et al\. 2000, Nature 403:853–858, doi:10\.1038\/35002501/);
  assert.match(text, /Changed: boundaries simplified .*shared under the same CC BY-SA 4\.0/);
  assert.match(text, /re-evaluation of the hotspots has been under way since October 2025/);
  assert.match(credit.html, /href="https:\/\/doi\.org\/10\.5281\/zenodo\.3261807"/);
  assert.match(credit.html, /href="https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/"/);
});
