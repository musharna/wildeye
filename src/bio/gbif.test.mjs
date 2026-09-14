// src/bio/gbif.test.mjs — GBIF / iNaturalist request builders, parsers and client behaviour (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LICENSES, yearRange, yearLabel, densityTileTemplate, speciesNearUrl, gbifPortalUrl, parseSpeciesNear,
  inatSuggestUrl, parseInatSuggest, gbifSuggestUrl, parseGbifSuggest, gbifMatchUrl, parseGbifMatch,
  speciesUrl, parseSpeciesName, createRateLimiter, createPool, fetchJson, RequestError, createBioClient, circlePolygonWkt, RADII_KM,
  polygonRefusal, gbifPortalAnyLocationUrl, SPECIES_MAP_LEGEND, SPECIES_TILE_SIZE_PX,
  datasetUrl, parseDataset, datasetHref, taxonDatasetsUrl, parseTaxonDatasets, gbifPortalTaxonUrl, GBIF_BACKBONE_CHECKLIST_KEY, SEARCH_POLYGON_VERTICES,
} from './gbif.js';

const NOW = new Date('2026-09-13T12:00:00Z');
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const httpError = (status) => ({ ok: false, status, json: async () => ({}) });
const INAT_RG = '50c9509d-22c7-4a22-a47d-8c48425ef4a7'; // iNaturalist Research-grade Observations
const EBIRD_EOD = '4fa7b334-ce0d-4e88-aaae-2e0c138d049e';
// R-7u: one what-lives-here search lists the top 20 species and the top 5 datasets, each facet with its own limit (live 2026-09-14:
// SPECIES_KEY 20 counts and DATASET_KEY 5 counts from one request with the polygon).
const assertNearFacets = (url, where) => {
  assert.deepEqual(url.searchParams.getAll('facet'), ['speciesKey', 'datasetKey'], where);
  assert.equal(url.searchParams.get('speciesKey.facetLimit'), '20', where);
  assert.equal(url.searchParams.get('datasetKey.facetLimit'), '5', where);
  assert.equal(url.searchParams.has('facetLimit'), false, `${where}: per-facet limits only`);
};

test('years: recent is the last 10 calendar years including this one; all has no filter', () => {
  assert.deepEqual(yearRange('recent', NOW), { from: 2017, to: 2026 });
  assert.equal(yearRange('all', NOW), null);
  assert.equal(yearLabel('recent', NOW), '2017–2026');
  assert.equal(yearLabel('all', NOW), 'all years');
  assert.throws(() => yearRange('decade', NOW), /unknown years/);
});

test('density tiles use the adhoc endpoint with both licence filters and the year range', () => {
  // GBIF's density endpoint ignores license= (byte-identical tiles with and without it, 2026-09-13).
  const tile = (years) => new URL(densityTileTemplate({ taxonKey: 5133088, years, now: NOW }).replace('{z}/{x}/{y}', '0/0/0'));
  const recent = tile('recent');
  assert.equal(recent.origin + recent.pathname, 'https://api.gbif.org/v2/map/occurrence/adhoc/0/0/0@1x.png');
  assert.deepEqual(LICENSES, ['CC0_1_0', 'CC_BY_4_0']);
  assert.deepEqual(recent.searchParams.getAll('license'), LICENSES);
  assert.equal(recent.searchParams.get('taxonKey'), '5133088');
  assert.equal(recent.searchParams.get('year'), '2017,2026');
  assert.equal(recent.searchParams.get('srs'), 'EPSG:3857', 'Web Mercator tiles, the default tiling scheme of Cesium UrlTemplateImageryProvider');
  // R-7t, the user's choice 2026-09-14: GBIF's unbinned scaled circles. Binned hexagons drew record-bearing cells empty at fine sizes
  // and painted ocean at coarse ones; unbinned, every record-bearing cell is a circle (spec: Implementation notes).
  assert.equal(recent.searchParams.get('style'), 'scaled.circles');
  for (const key of ['bin', 'hexPerTile', 'squareSize']) assert.equal(recent.searchParams.has(key), false, `${key}: unbinned cells take no bin parameter`);
  assert.equal(tile('all').searchParams.has('year'), false);
  const template = densityTileTemplate({ taxonKey: 1, years: 'all', now: NOW });
  assert.ok(template.includes('/{z}/{x}/{y}@1x.png?'), `Cesium placeholders stay unencoded: ${template}`);
  assert.equal(template.includes('{hexPerTile}'), false, template);
  // GBIF serves @1x PNG tiles 512 px square (techdocs maps v2: "normally 512px wide squares"; 512x512 measured 2026-09-14), and the
  // species provider declares that size: at Cesium's default of 256 every GBIF pixel was drawn at about half size.
  assert.equal(SPECIES_TILE_SIZE_PX, 512);
  assert.throws(() => densityTileTemplate({ taxonKey: 0, years: 'all', now: NOW }), /taxonKey/);
});

// R-7t: GBIF draws each unbinned cell as a circle whose size, fill, opacity and line are set by its record count, in the classes of the
// tile style (github.com/gbif/maps mapnik-server/src/main/node/cartocss/scaled-circles.mss, last changed in 9dd3dba827d1, read
// 2026-09-14). The legend is those classes, so the style the tiles use must have an entry here and the legend must match it: changing
// the style without the legend fails. Row: [upper bound, marker-width px, marker-fill, marker-opacity, marker-line-color, marker-line-width px].
const STYLE_CLASSES = {
  'scaled.circles': [
    [10, 6, '#fed976', 1.0, '#fe9724', 1],
    [100, 7, '#fd8d3c', 0.8, '#fd5b24', 0],
    [1000, 10, '#fd8d3c', 0.7, '#fd471d', 0],
    [10000, 16, '#f03b20', 0.6, '#f01129', 0],
    [null, 30, '#bd0026', 0.6, '#bd0047', 0],
  ],
};

test('the species map legend is the record-count classes of the style the tiles use, each swatch in the colour the globe draws it', () => {
  const style = new URL(densityTileTemplate({ taxonKey: 5133088, years: 'all', now: NOW }).replace('{z}/{x}/{y}', '0/0/0')).searchParams.get('style');
  assert.equal(SPECIES_MAP_LEGEND.style, style, 'the legend describes the style the tiles are drawn with');
  assert.ok(Object.hasOwn(STYLE_CLASSES, style), `no class table for ${style}: read its .mss in github.com/gbif/maps`);
  assert.deepEqual(SPECIES_MAP_LEGEND.classes.map((c) => [c.upTo, c.widthPx, c.fill, c.opacity, c.lineColor, c.lineWidthPx]), STYLE_CLASSES[style]);
  // B2: each swatch is its class's circles as the globe draws them at the default 12,000 km view: the median rendered colour of lone
  // circles over land, each circle's class read from its tile's own record count (scripts/species-legend-probe.mjs and
  // scripts/species-legend-colours.py, 3 runs, 2026-09-14). The two highest classes had no circle to sample there and are predicted from
  // the others (scripts/species-legend-fit.py), so they carry predicted: true.
  assert.deepEqual(SPECIES_MAP_LEGEND.classes.map((c) => [c.color, c.predicted]), [
    ['#e4d9ac', false], ['#d5aa78', false], ['#cea878', false], ['#be8770', true], ['#ab7272', true],
  ]);
  // Swatch sizes keep the style's order. I3: the caption says what was measured: the colours are as seen from far out, and closer up the
  // circles look stronger, not brighter (at the 1,700 km Upper Midwest view the <=100 and <=1k circles are about 10 L* darker and twice as
  // saturated as their swatches).
  assert.ok(SPECIES_MAP_LEGEND.classes.every((c, i, all) => i === 0 || c.widthPx > all[i - 1].widthPx), 'sizes grow with the class');
  assert.equal(SPECIES_MAP_LEGEND.caption, 'Records per circle · colours as seen from far out; closer up they look stronger');
  assert.ok(Object.isFrozen(SPECIES_MAP_LEGEND) && Object.isFrozen(SPECIES_MAP_LEGEND.classes) && SPECIES_MAP_LEGEND.classes.every(Object.isFrozen));
});

test('species near a point: a polygon around it, both licences, years, clean coordinates, top-20 species facet', () => {
  const url = new URL(speciesNearUrl({ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'recent', now: NOW }));
  assert.equal(url.origin + url.pathname, 'https://api.gbif.org/v1/occurrence/search');
  // gbif.org has no distance filter (its location filter is `geometry`), so the search uses the polygon the gbif.org link uses (R-7b).
  assert.match(url.searchParams.get('geometry') ?? '', /^POLYGON\(\(-110\.\d+ 44\.\d+(,-?\d+(\.\d+)? -?\d+(\.\d+)?)+\)\)$/);
  assert.equal(url.searchParams.has('geoDistance'), false);
  assert.deepEqual(url.searchParams.getAll('license'), LICENSES);
  assert.equal(url.searchParams.get('year'), '2017,2026');
  for (const [key, value] of [['hasCoordinate', 'true'], ['hasGeospatialIssue', 'false'], ['limit', '0']]) {
    assert.equal(url.searchParams.get(key), value, key);
  }
  assertNearFacets(url, 'polygon search');
  assert.throws(() => speciesNearUrl({ lat: 44, lon: -110, radiusKm: 5, years: 'all', now: NOW }), /radius/);
  assert.throws(() => speciesNearUrl({ lat: Number.NaN, lon: -110, radiusKm: 10, years: 'all', now: NOW }), /lat/);
});

test('the gbif.org link carries the search geometry byte for byte, both licences and the years, and no geo_distance', () => {
  // gbif.org (gbif-web) keeps only its config fields; `geo_distance` is not one, so a link with it opens with no location filter.
  const rawGeometry = (href) => (href.match(/[?&]geometry=([^&]*)/) || [])[1] ?? null;
  // a rounded point and an unrounded one, as a Cesium click gives
  for (const args of [{ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'recent', now: NOW }, { lat: 44.463728192, lon: -110.829104417, radiusKm: 50, years: 'recent', now: NOW }]) {
    const searchHref = speciesNearUrl(args);
    const portalHref = gbifPortalUrl(args);
    const search = new URL(searchHref);
    const portal = new URL(portalHref);
    assert.equal(portal.origin + portal.pathname, 'https://www.gbif.org/occurrence/search');
    assert.ok(search.searchParams.get('geometry'), 'the search sends a geometry');
    assert.equal(portal.searchParams.get('geometry'), search.searchParams.get('geometry'));
    assert.equal(rawGeometry(portalHref), rawGeometry(searchHref), 'encoded geometry values are byte-identical');
    for (const key of ['geo_distance', 'geoDistance']) assert.equal(portal.searchParams.has(key), false, key);
    assert.deepEqual(portal.searchParams.getAll('license'), LICENSES);
    assert.equal(portal.searchParams.get('year'), '2017,2026');
  }
  assert.equal(new URL(gbifPortalUrl({ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'all', now: NOW })).searchParams.has('year'), false);
});

test('circlePolygonWkt: a closed counter-clockwise ring of SEARCH_POLYGON_VERTICES (32) vertices on the circle, 5 decimals; no pole, no antimeridian', () => {
  // One vertex count for the search, its gbif.org link and the outline: gbif.org failed a 64-vertex link in a real browser (next test).
  assert.equal(SEARCH_POLYGON_VERTICES, 32);
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const haversineKm = ([lon1, lat1], [lon2, lat2]) => {
    const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const ring = (wkt) => {
    const body = wkt.match(/^POLYGON\(\((.*)\)\)$/)?.[1];
    assert.ok(body, `not a WKT polygon: ${wkt.slice(0, 60)}`);
    return body.split(',').map((pair) => {
      const parts = pair.split(' ');
      assert.equal(parts.length, 2, pair);
      for (const part of parts) assert.match(part, /^-?\d+(\.\d{1,5})?$/, 'a plain decimal with at most 5 decimals');
      return parts.map(Number);
    });
  };
  // Yellowstone (the probe point), an unrounded click, the equator, the southern hemisphere, and the 85° limit both ways
  for (const [lat, lon] of [[44.46, -110.83], [44.463728192, -110.829104417], [0, 0], [-33.92, 18.42], [85, 20], [-85, -20]]) {
    for (const radiusKm of RADII_KM) {
      const where = `${lat},${lon} ${radiusKm} km`;
      const points = ring(circlePolygonWkt({ lat, lon, radiusKm }));
      assert.equal(points.length, SEARCH_POLYGON_VERTICES + 1, where);
      assert.deepEqual(points[SEARCH_POLYGON_VERTICES], points[0], `${where}: closed`);
      const worst = Math.max(...points.slice(0, SEARCH_POLYGON_VERTICES).map((p) => Math.abs(haversineKm([lon, lat], p) / radiusKm - 1)));
      assert.ok(worst <= 0.005, `${where}: a vertex is ${(worst * 100).toFixed(3)}% off the radius`);
      let twiceArea = 0; // shoelace in lon/lat, centred on the point
      for (let i = 0; i < SEARCH_POLYGON_VERTICES; i += 1) twiceArea += (points[i][0] - lon) * (points[i + 1][1] - lat) - (points[i + 1][0] - lon) * (points[i][1] - lat);
      assert.ok(twiceArea > 0, `${where}: counter-clockwise`);
    }
  }
  assert.equal(ring(circlePolygonWkt({ lat: 10, lon: 10, radiusKm: 10, vertices: 16 })).length, 17);
  assert.equal(new URL(speciesNearUrl({ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'all', now: NOW })).searchParams.get('geometry'), circlePolygonWkt({ lat: 44.46, lon: -110.83, radiusKm: 10 }));

  // Polygons are built only within ±85° latitude, a fixed safety margin for every radius (a ring reaches past a pole only within
  // one radius of it, 0.45° for 50 km), and away from ±180°, where a ring cannot be one GBIF polygon. circlePolygonWkt and the
  // gbif.org polygon link refuse such a circle, polygonRefusal says why, and the search falls back to geoDistance (next test).
  for (const lat of [85.001, -85.001, 89.9]) {
    assert.throws(() => circlePolygonWkt({ lat, lon: 0, radiusKm: 10 }), /85/);
    assert.match(polygonRefusal({ lat, lon: 0, radiusKm: 10 }) ?? '', /85/);
  }
  assert.throws(() => gbifPortalUrl({ lat: -86, lon: 0, radiusKm: 10, years: 'all', now: NOW }), /85/);
  // A ring with a longitude past ±180° would be a wrong polygon, so it throws; the same circle just inside is fine.
  assert.throws(() => circlePolygonWkt({ lat: 0, lon: 179.9, radiusKm: 50 }), /antimeridian/);
  assert.throws(() => circlePolygonWkt({ lat: 60, lon: -179.5, radiusKm: 50 }), /antimeridian/);
  assert.match(polygonRefusal({ lat: 60, lon: -179.5, radiusKm: 50 }) ?? '', /antimeridian/);
  assert.equal(ring(circlePolygonWkt({ lat: 0, lon: 179.5, radiusKm: 50 })).length, SEARCH_POLYGON_VERTICES + 1);
  assert.equal(polygonRefusal({ lat: 0, lon: 179.5, radiusKm: 50 }), null);
  assert.equal(polygonRefusal({ lat: 85, lon: 20, radiusKm: 50 }), null);
  for (const bad of [{ radiusKm: 0 }, { radiusKm: Number.NaN }, { vertices: 2 }, { vertices: 6.5 }, { lon: 181 }]) {
    assert.throws(() => circlePolygonWkt({ lat: 0, lon: 0, radiusKm: 10, ...bad }), /circlePolygonWkt/, JSON.stringify(bad));
  }
});

// 1,000 characters is a margin under a real-browser failure, not a documented GBIF limit. On 2026-09-14 gbif.org opened a 1,508-character
// link (10 km, 64 vertices) to 0 results or an error, and links of 464 to 1,253 characters to records; the cause is unknown upstream. The
// longest links have the longest coordinates: every vertex with a 3-digit negative longitude and a 2-digit negative latitude, which a ring
// just inside the ±85° and ±180° refusal limits gives.
test('gbif.org area links stay at most 1,000 characters at every radius, for the longest coordinates a polygon can have', () => {
  for (const radiusKm of RADII_KM) {
    const lat = -84.9;
    let lon = -180;
    while (polygonRefusal({ lat, lon, radiusKm }) !== null) lon = Number((lon + 0.01).toFixed(2));
    assert.match(polygonRefusal({ lat, lon: lon - 0.05, radiusKm }) ?? '', /antimeridian/, `${radiusKm} km: the ring sits at the antimeridian limit`);
    const href = gbifPortalUrl({ lat, lon, radiusKm, years: 'recent', now: NOW });
    const pairs = new URL(href).searchParams.get('geometry').match(/^POLYGON\(\((.*)\)\)$/)[1].split(',');
    assert.equal(pairs.length, SEARCH_POLYGON_VERTICES + 1);
    for (const pair of pairs) assert.match(pair, /^-1\d\d\.\d+ -8\d\.\d+$/, `${radiusKm} km: the longest coordinates`);
    assert.ok(href.length <= 1000, `${radiusKm} km at ${lat},${lon}: the gbif.org link is ${href.length} characters`);
  }
});

// F9: a circle that cannot be a polygon was searched with geoDistance before the polygon change, and still is.
test('a circle that cannot be a polygon (beyond 85° or across ±180°) is searched with geoDistance; an ordinary one with the polygon', () => {
  for (const args of [{ lat: 86, lon: 0, radiusKm: 10 }, { lat: -89.9, lon: 45, radiusKm: 50 }, { lat: 0, lon: 180, radiusKm: 1 }, { lat: 60, lon: -179.5, radiusKm: 50 }]) {
    const where = JSON.stringify(args);
    const url = new URL(speciesNearUrl({ ...args, years: 'recent', now: NOW }));
    assert.equal(url.origin + url.pathname, 'https://api.gbif.org/v1/occurrence/search', where);
    assert.equal(url.searchParams.has('geometry'), false, where);
    assert.equal(url.searchParams.get('geoDistance'), `${args.lat.toFixed(4)},${args.lon.toFixed(4)},${args.radiusKm}km`, where);
    assert.deepEqual(url.searchParams.getAll('license'), LICENSES, where);
    assert.equal(url.searchParams.get('year'), '2017,2026', where);
    for (const [key, value] of [['hasCoordinate', 'true'], ['hasGeospatialIssue', 'false'], ['limit', '0']]) {
      assert.equal(url.searchParams.get(key), value, `${where} ${key}`);
    }
    assertNearFacets(url, where);
  }
  const ordinary = new URL(speciesNearUrl({ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'recent', now: NOW }));
  assert.equal(ordinary.searchParams.has('geoDistance'), false, 'positive control: an ordinary point sends no geoDistance');
  assert.match(ordinary.searchParams.get('geometry') ?? '', /^POLYGON\(\(/, 'positive control: an ordinary point sends the polygon');
});

test('the gbif.org link with no location filter keeps both licences and the years, and nothing else', () => {
  const recent = new URL(gbifPortalAnyLocationUrl({ years: 'recent', now: NOW }));
  assert.equal(recent.origin + recent.pathname, 'https://www.gbif.org/occurrence/search');
  assert.deepEqual([...recent.searchParams.keys()], ['license', 'license', 'year']);
  assert.deepEqual(recent.searchParams.getAll('license'), LICENSES);
  assert.equal(recent.searchParams.get('year'), '2017,2026');
  assert.deepEqual([...new URL(gbifPortalAnyLocationUrl({ years: 'all', now: NOW })).searchParams.keys()], ['license', 'license']);
});

test('parseSpeciesNear reads the total, the SPECIES_KEY facet and the DATASET_KEY facet; no count is an error', () => {
  // shape of a live response, 2026-09-14 (the 10 km polygon around 44.46,-110.83, both facets)
  const live = { offset: 0, limit: 0, endOfRecords: false, count: 28953, results: [], facets: [
    { field: 'SPECIES_KEY', counts: [{ name: '2482492', count: 2743 }, { name: '2490935', count: 1553 }] },
    { field: 'DATASET_KEY', counts: [{ name: EBIRD_EOD, count: 27513 }, { name: INAT_RG, count: 1179 }] },
  ] };
  assert.deepEqual(parseSpeciesNear(live), {
    total: 28953,
    species: [{ key: 2482492, count: 2743 }, { key: 2490935, count: 1553 }],
    datasets: [{ key: EBIRD_EOD, count: 27513 }, { key: INAT_RG, count: 1179 }],
  });
  assert.deepEqual(parseSpeciesNear({ count: 0, facets: [] }), { total: 0, species: [], datasets: [] });
  // A dataset key becomes a request path and a link, so anything but a GBIF dataset UUID with a count is dropped.
  const odd = { count: 2, facets: [{ field: 'DATASET_KEY', counts: [{ name: '../occurrence/1', count: 1 }, { name: INAT_RG, count: 'x' }, { name: INAT_RG.toUpperCase(), count: 1 }] }] };
  assert.deepEqual(parseSpeciesNear(odd).datasets, []);
  assert.throws(() => parseSpeciesNear({ facets: [] }), /count/);
});

// R-7u: the GBIF data user agreement asks users to acknowledge the publishers whose data they use, with a DOI where appropriate, so each
// listed dataset is looked up for its title and DOI. A dataset's licence is not the licence of the records shown (the iNaturalist dataset
// is CC BY-NC while its CC BY records pass the record filter), so the parser does not keep it.
test('dataset lookups: the URL takes only a GBIF dataset UUID; the parser keeps key, title and DOI and refuses a response with no title', () => {
  assert.equal(datasetUrl(INAT_RG), `https://api.gbif.org/v1/dataset/${INAT_RG}`);
  for (const bad of ['', '../occurrence/1', '50c9509d', null, 7]) assert.throws(() => datasetUrl(bad), /dataset key/, String(bad));
  // fields of the live response, 2026-09-14
  const live = { key: INAT_RG, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x', license: 'http://creativecommons.org/licenses/by-nc/4.0/legalcode', publishingOrganizationKey: '28eb1a3f-1c15-4a95-931a-4af90ecb574d' };
  assert.deepEqual(parseDataset(live), { key: INAT_RG, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' });
  assert.deepEqual(parseDataset({ key: EBIRD_EOD, title: 'EOD – eBird Observation Dataset' }), { key: EBIRD_EOD, title: 'EOD – eBird Observation Dataset', doi: null });
  assert.deepEqual(parseDataset({ key: EBIRD_EOD, title: 'EOD', doi: '' }).doi, null);
  assert.throws(() => parseDataset({ key: INAT_RG, doi: '10.15468/ab3s5x' }), /title/);
  assert.throws(() => parseDataset({ key: INAT_RG, title: '   ' }), /title/);
  assert.throws(() => parseDataset({ title: 'x' }), /key/);
  assert.throws(() => parseDataset(null), /GBIF dataset/);
});

test('a dataset links to its DOI on doi.org, or to its gbif.org page when it has no DOI or an odd one', () => {
  assert.equal(datasetHref({ key: INAT_RG, doi: '10.15468/ab3s5x' }), 'https://doi.org/10.15468/ab3s5x');
  assert.equal(datasetHref({ key: INAT_RG, doi: '10.1234/a.b-c_d(1);2:3/4' }), 'https://doi.org/10.1234/a.b-c_d(1);2:3/4');
  for (const doi of [null, undefined, '', 'javascript:alert(1)', 'doi:10.15468/ab3s5x', 'https://evil.example/10.1234/x', '10.15468/ab 3s5x', '10.15468/<b>', '10.1/x', '10.15468/ab3s5x?x=1', '10.15468/ab3s5x#frag']) {
    assert.equal(datasetHref({ key: INAT_RG, doi }), `https://www.gbif.org/dataset/${INAT_RG}`, String(doi));
  }
  assert.throws(() => datasetHref({ key: 'x', doi: '10.15468/ab3s5x' }), /dataset key/);
});

test('the top datasets of a taxon: an occurrence search with the taxon, both licences, the years and a 3-dataset facet, and its gbif.org link', () => {
  const url = new URL(taxonDatasetsUrl({ taxonKey: 5133088, years: 'recent', now: NOW }));
  assert.equal(url.origin + url.pathname, 'https://api.gbif.org/v1/occurrence/search');
  assert.equal(url.searchParams.get('taxonKey'), '5133088');
  assert.deepEqual(url.searchParams.getAll('license'), LICENSES);
  assert.equal(url.searchParams.get('year'), '2017,2026');
  assert.deepEqual(url.searchParams.getAll('facet'), ['datasetKey']);
  assert.equal(url.searchParams.get('datasetKey.facetLimit'), '3');
  // M1: the same records the map tiles count. adhoc tiles filter hasCoordinate=true and nothing on geospatial issues (gbif/occurrence
  // BaseEsHeatmapRequestBuilder; live 2026-09-14: the z0 tile totals 42,244 = the search with hasCoordinate=true, 42,240 with
  // hasGeospatialIssue=false as well), so the facet search adds hasCoordinate and not hasGeospatialIssue.
  assert.equal(url.searchParams.get('hasCoordinate'), 'true');
  assert.equal(url.searchParams.has('hasGeospatialIssue'), false, 'adhoc tiles keep records with geospatial issues');
  assert.equal(url.searchParams.get('limit'), '0');
  assert.equal(new URL(taxonDatasetsUrl({ taxonKey: 5133088, years: 'all', now: NOW })).searchParams.has('year'), false);
  assert.throws(() => taxonDatasetsUrl({ taxonKey: 0, years: 'all', now: NOW }), /taxonKey/);
  // live 2026-09-14 (monarch, 2017-2026, both licences): count 42534, DATASET_KEY 3 counts
  assert.deepEqual(
    parseTaxonDatasets({ count: 42534, facets: [{ field: 'DATASET_KEY', counts: [{ name: INAT_RG, count: 41111 }, { name: '6ac3f774-d9fb-4796-b3e9-92bf6c81c084', count: 306 }] }] }),
    { total: 42534, datasets: [{ key: INAT_RG, count: 41111 }, { key: '6ac3f774-d9fb-4796-b3e9-92bf6c81c084', count: 306 }] },
  );
  assert.deepEqual(parseTaxonDatasets({ count: 0, facets: [] }), { total: 0, datasets: [] });
  assert.throws(() => parseTaxonDatasets({ facets: [] }), /count/);
  const portal = new URL(gbifPortalTaxonUrl({ taxonKey: 5133088, years: 'recent', now: NOW }));
  assert.equal(portal.origin + portal.pathname, 'https://www.gbif.org/occurrence/search');
  // The link carries the map's coordinate filter too, in the camelCase names gbif.org writes back to its URL. Since 2026-06-18 gbif.org
  // reads taxon keys under Catalogue of Life XR unless told otherwise, and this Backbone key matched 0 records there in a real browser; with
  // the Backbone's checklistKey the same link opened to the monarch's ~42,244 records.
  assert.equal(GBIF_BACKBONE_CHECKLIST_KEY, 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c');
  assert.deepEqual([...portal.searchParams.entries()], [['taxonKey', '5133088'], ['checklistKey', GBIF_BACKBONE_CHECKLIST_KEY], ['hasCoordinate', 'true'], ['license', 'CC0_1_0'], ['license', 'CC_BY_4_0'], ['year', '2017,2026']]);
  assert.deepEqual([...new URL(gbifPortalTaxonUrl({ taxonKey: 5133088, years: 'all', now: NOW })).searchParams.keys()], ['taxonKey', 'checklistKey', 'hasCoordinate', 'license', 'license']);
  // The area links filter no taxon, so they carry no checklist.
  assert.equal(new URL(gbifPortalUrl({ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'recent', now: NOW })).searchParams.has('checklistKey'), false);
  assert.equal(new URL(gbifPortalAnyLocationUrl({ years: 'recent', now: NOW })).searchParams.has('checklistKey'), false);
  assert.throws(() => gbifPortalTaxonUrl({ taxonKey: -1, years: 'all', now: NOW }), /taxonKey/);
});

test('name parsers keep the fields the panel shows', () => {
  assert.deepEqual(
    // names and matched_term as iNaturalist answered q=hump on 2026-09-13 (ids illustrative); a result may carry no matched_term
    parseInatSuggest({ results: [
      { id: 1001, name: 'Danaus plexippus', rank: 'species', preferred_common_name: 'Monarch', observations_count: 541746, matched_term: 'Monarch' },
      { id: 11, name: 'Megaptera novaeangliae', rank: 'species', preferred_common_name: 'Humpback Whale', matched_term: 'Hump Whale' },
      { id: 12, name: 'Neotibicen tibicen', rank: 'species', preferred_common_name: 'Swamp Cicada', matched_term: '' },
      { id: 13, name: 'Danaus plexaure', rank: 'species', preferred_common_name: 'Soldier' },
      { id: 2, rank: 'genus' },
    ] }),
    [
      { id: 1001, gbifKey: null, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species', matchedTerm: 'Monarch' },
      { id: 11, gbifKey: null, scientificName: 'Megaptera novaeangliae', commonName: 'Humpback Whale', rank: 'species', matchedTerm: 'Hump Whale' },
      { id: 12, gbifKey: null, scientificName: 'Neotibicen tibicen', commonName: 'Swamp Cicada', rank: 'species', matchedTerm: null },
      { id: 13, gbifKey: null, scientificName: 'Danaus plexaure', commonName: 'Soldier', rank: 'species', matchedTerm: null },
    ],
  );
  assert.deepEqual(
    parseGbifSuggest([{ key: 6223161, canonicalName: 'Danaus plexaure', scientificName: 'Danaus plexaure (Godart)', rank: 'SPECIES' }]),
    [{ id: null, gbifKey: 6223161, scientificName: 'Danaus plexaure', commonName: null, rank: 'species', matchedTerm: null }],
  );
  // live 2026-09-13: strict match on the synonym Megaptera nodosa → accepted key 5220086
  assert.equal(parseGbifMatch({ usageKey: 5220089, matchType: 'EXACT', status: 'SYNONYM', acceptedUsageKey: 5220086 }), 5220086);
  assert.equal(parseGbifMatch({ usageKey: 5133088, matchType: 'EXACT', status: 'ACCEPTED' }), 5133088);
  assert.equal(parseGbifMatch({ matchType: 'NONE' }), null);
  assert.deepEqual(
    parseSpeciesName({ key: 5232437, scientificName: 'Branta canadensis (Linnaeus, 1758)', canonicalName: 'Branta canadensis', vernacularName: 'Canada Goose (canadensis Group)', class: 'Aves' }),
    { key: 5232437, scientificName: 'Branta canadensis', commonName: 'Canada Goose (canadensis Group)', className: 'Aves' },
  );
  assert.equal(parseSpeciesName({ key: 7, scientificName: 'A b' }).scientificName, 'A b');
  assert.throws(() => parseSpeciesName({}), /no key/);
  assert.equal(new URL(inatSuggestUrl('red maple')).searchParams.get('q'), 'red maple');
  assert.equal(new URL(inatSuggestUrl('red maple')).pathname, '/v1/taxa/autocomplete');
  assert.equal(new URL(gbifSuggestUrl('Danaus plex')).pathname, '/v1/species/suggest');
  assert.equal(new URL(gbifMatchUrl('Megaptera nodosa')).searchParams.get('strict'), 'true');
  assert.equal(speciesUrl(5232437), 'https://api.gbif.org/v1/species/5232437');
});

test('iNaturalist limiter allows 60 requests in any 60 s window', () => {
  let t = 0;
  const limiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 60; i += 1) assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
  t = 59_999;
  assert.equal(limiter.tryAcquire(), false);
  t = 60_000;
  assert.equal(limiter.tryAcquire(), true);
});

test('name lookups never run more than 4 at a time', async () => {
  const pool = createPool(4);
  let active = 0;
  let peak = 0;
  const gates = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const jobs = Array.from({ length: 12 }, () => pool.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => gates.push(resolve));
    active -= 1;
  }));
  while (gates.length < 4) await tick();
  assert.equal(peak, 4);
  while (gates.length) { gates.shift()(); await tick(); await tick(); }
  await Promise.all(jobs);
  assert.equal(peak, 4);
});

test('fetchJson: HTTP errors carry the status, a hung request times out, a caller abort stays an AbortError', async () => {
  await assert.rejects(fetchJson('https://x.test/a', { fetchImpl: async () => httpError(503) }), (e) => e instanceof RequestError && e.status === 503 && e.message === 'HTTP 503');
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(fetchJson('https://x.test/b', { fetchImpl: hang, timeoutMs: 20 }), (e) => e instanceof RequestError && e.message === 'timeout');
  const caller = new AbortController();
  const pending = fetchJson('https://x.test/c', { fetchImpl: hang, signal: caller.signal, timeoutMs: 5000 });
  caller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.deepEqual(await fetchJson('https://x.test/d', { fetchImpl: async () => ok({ a: 1 }) }), { a: 1 });
});

test('suggest: iNaturalist first; GBIF names with a visible notice when it fails; both failing names both', async () => {
  const hosts = [];
  const inatBody = { results: [{ id: 1001, name: 'Danaus plexippus', rank: 'species', preferred_common_name: 'Monarch' }] };
  const gbifBody = [{ key: 5133088, canonicalName: 'Danaus plexippus', rank: 'SPECIES' }];
  const client = createBioClient({ fetchImpl: async (url) => { hosts.push(new URL(url).host); return ok(url.includes('inaturalist') ? inatBody : gbifBody); } });
  assert.deepEqual(await client.suggest('mo'), { source: 'none', items: [] });
  assert.equal(hosts.length, 0, 'fewer than 3 letters sends nothing');
  const first = await client.suggest('monarch');
  assert.equal(first.source, 'inaturalist');
  assert.equal(first.items[0].commonName, 'Monarch');
  assert.deepEqual(hosts, ['api.inaturalist.org']);

  const inatDown = createBioClient({ fetchImpl: async (url) => (url.includes('inaturalist') ? httpError(503) : ok(gbifBody)) });
  const fallback = await inatDown.suggest('monarch');
  assert.equal(fallback.source, 'gbif');
  assert.match(fallback.notice, /iNaturalist didn't answer \(HTTP 503\)/);
  assert.equal(fallback.items[0].gbifKey, 5133088);

  const bothDown = createBioClient({ fetchImpl: async () => httpError(500) });
  await assert.rejects(bothDown.suggest('monarch'), /iNaturalist \(HTTP 500\) and GBIF \(HTTP 500\) both failed/);

  let t = 0;
  const limited = createBioClient({ fetchImpl: async () => ok(inatBody), inatLimiter: createRateLimiter({ maxPerWindow: 1, now: () => t }) });
  await limited.suggest('monarch');
  await assert.rejects(limited.suggest('monarch'), /iNaturalist limit reached/);
});

test('the client looks up a taxon\'s top datasets with one search', async () => {
  const seen = [];
  const body = { count: 42534, facets: [{ field: 'DATASET_KEY', counts: [{ name: INAT_RG, count: 41111 }] }] };
  const client = createBioClient({ fetchImpl: async (url) => { seen.push(url); return ok(body); } });
  assert.deepEqual(await client.taxonDatasets({ taxonKey: 5133088, years: 'recent', now: NOW }), { total: 42534, datasets: [{ key: INAT_RG, count: 41111 }] });
  assert.deepEqual(seen, [taxonDatasetsUrl({ taxonKey: 5133088, years: 'recent', now: NOW })]);
});

// R-7u: dataset lookups behave like name lookups: one shared lookup per key for the session, through the same pool, with no caller
// signal on the shared fetch, a failure forgotten, and a caller's abort rejecting only that caller.
test('dataset lookups go through the pool, cache per key, forget a failure, and an abort rejects only its caller', async () => {
  const base = createPool(4);
  let runs = 0;
  const pool = { run: (job) => { runs += 1; return base.run(job); } };
  let fail = true;
  const urls = [];
  const client = createBioClient({ pool, fetchImpl: async (url) => { urls.push(url); return fail ? httpError(503) : ok({ key: INAT_RG, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x', license: 'CC BY-NC' }); } });
  await assert.rejects(client.dataset(INAT_RG), /HTTP 503/);
  fail = false;
  assert.deepEqual(await client.dataset(INAT_RG), { key: INAT_RG, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' });
  await client.dataset(INAT_RG);
  assert.deepEqual(urls, [datasetUrl(INAT_RG), datasetUrl(INAT_RG)], 'retried after the failure, cached after the success');
  assert.equal(runs, 2, 'each fetch ran through the pool');
  await assert.rejects(client.dataset('../occurrence/1'), /dataset key/);
  assert.equal(urls.length, 2, 'a bad key sends nothing');

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const releases = [];
  const signals = [];
  const pending = createBioClient({ fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    releases.push(() => resolve(ok({ key: EBIRD_EOD, title: 'EOD – eBird Observation Dataset' })));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const settle = (p) => p.then((value) => value.title, (error) => error.name);
  const callerA = new AbortController();
  const a = settle(pending.dataset(EBIRD_EOD, { signal: callerA.signal }));
  const b = settle(pending.dataset(EBIRD_EOD, { signal: new AbortController().signal }));
  while (releases.length === 0) await tick();
  callerA.abort();
  releases[0]();
  assert.deepEqual([await a, await b, releases.length, signals[0].aborted], ['AbortError', 'EOD – eBird Observation Dataset', 1, false]);
  assert.equal(await settle(pending.dataset(EBIRD_EOD, { signal: AbortSignal.abort() })), 'AbortError', 'an aborted signal rejects at once, even for a cached key');
});

test('speciesName caches per key and forgets a failure so a retry can succeed', async () => {
  let calls = 0;
  let fail = true;
  const client = createBioClient({ fetchImpl: async () => { calls += 1; return fail ? httpError(503) : ok({ key: 7, canonicalName: 'A b', vernacularName: 'Ab' }); } });
  await assert.rejects(client.speciesName(7), /HTTP 503/);
  fail = false;
  assert.deepEqual(await client.speciesName(7), { key: 7, scientificName: 'A b', commonName: 'Ab', className: null });
  await client.speciesName(7);
  assert.equal(calls, 2);
});

test('speciesName shares one lookup per key, but an abort rejects only the caller whose signal aborted', async () => {
  const calls = new Map();
  const releases = new Map();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // Behaves like fetch: rejects with the signal's reason on abort, including a signal that is already aborted.
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    const key = Number(url.split('/').pop());
    calls.set(key, (calls.get(key) || 0) + 1);
    releases.set(key, () => resolve(ok({ key, canonicalName: `Name ${key}` })));
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const client = createBioClient({ fetchImpl });
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error: error.name }));
  const ABORTED = { error: 'AbortError' };
  const name = (key) => ({ value: { key, scientificName: `Name ${key}`, commonName: null, className: null } });

  // (a) caller A aborts, then caller B immediately asks for the same key with a live signal
  const callerA1 = new AbortController();
  const a1 = settle(client.speciesName(8, { signal: callerA1.signal }));
  callerA1.abort();
  const b1 = settle(client.speciesName(8, { signal: new AbortController().signal }));
  while (!releases.has(8)) await tick();
  releases.get(8)();

  // (b) callers A and B both wait on key 9; A aborts while the lookup is in flight
  const callerA2 = new AbortController();
  const a2 = settle(client.speciesName(9, { signal: callerA2.signal }));
  const b2 = settle(client.speciesName(9, { signal: new AbortController().signal }));
  while (!releases.has(9)) await tick();
  callerA2.abort();
  releases.get(9)();

  assert.deepEqual(
    { abortThenReask: { A: await a1, B: await b1, fetches: calls.get(8) }, twoLiveCallers: { A: await a2, B: await b2, fetches: calls.get(9) } },
    { abortThenReask: { A: ABORTED, B: name(8), fetches: 1 }, twoLiveCallers: { A: ABORTED, B: name(9), fetches: 1 } },
  );
  // a signal that is already aborted rejects at once, even for a cached key, and sends nothing
  assert.deepEqual(await settle(client.speciesName(9, { signal: AbortSignal.abort() })), ABORTED);
  assert.equal(calls.get(9), 1);
});
