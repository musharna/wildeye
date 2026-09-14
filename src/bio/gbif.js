/**
 * GBIF and iNaturalist requests for species search and "what lives here". Runs in the browser, so it works
 * on the static host. Spec: docs/superpowers/specs/2026-09-13-species-search-design.md.
 */
export const GBIF_API = 'https://api.gbif.org';
export const INAT_API = 'https://api.inaturalist.org';
/** The only record licences the species feature shows. */
export const LICENSES = Object.freeze(['CC0_1_0', 'CC_BY_4_0']);
export const RADII_KM = Object.freeze([1, 10, 50]);
export const REQUEST_TIMEOUT_MS = 8000;
/**
 * The GBIF Backbone Taxonomy's checklist. The app's taxon keys are Backbone keys, the default of api.gbif.org v1 and the map tiles. Since
 * 2026-06-18 www.gbif.org reads taxon keys under Catalogue of Life XR unless a link names a checklist, and there a Backbone key matches
 * no record, so a gbif.org link that filters a taxon carries this key. gbifPortalUrl and gbifPortalAnyLocationUrl filter no taxon and
 * carry none; one that gains a taxon filter needs it.
 */
export const GBIF_BACKBONE_CHECKLIST_KEY = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';

export class RequestError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.url = url;
  }
}

/** 'recent' = the last 10 calendar years including this one; 'all' = no year filter. */
export function yearRange(years, now = new Date()) {
  if (years === 'all') return null;
  if (years !== 'recent') throw new Error(`yearRange: unknown years "${years}"`);
  const to = now.getUTCFullYear();
  return { from: to - 9, to };
}

export function yearLabel(years, now = new Date()) {
  const range = yearRange(years, now);
  return range ? `${range.from}–${range.to}` : 'all years';
}

function appendRecordFilters(params, years, now) {
  for (const licence of LICENSES) params.append('license', licence);
  const range = yearRange(years, now);
  if (range) params.set('year', `${range.from},${range.to}`);
}

function checkPoint(lat, lon, radiusKm) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`bad lat ${lat}`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`bad lon ${lon}`);
  if (!RADII_KM.includes(radiusKm)) throw new Error(`bad radius ${radiusKm} km (allowed: ${RADII_KM.join(', ')})`);
}

/** Mean earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;
/**
 * Polygons are built only within ±85° latitude and away from ±180°. 85° is a fixed safety margin, the same for every radius: a ring
 * from ringVertices reaches past a pole only when its centre is within one radius of it, 0.45° for 50 km (from 89.5° a 50 km ring
 * tops out at 89.95°; from 89.9° it reaches 90.35°). A ring that would cross ±180° cannot be one GBIF polygon. Either circle is
 * searched with geoDistance instead (see speciesNearUrl).
 */
export const MAX_POLYGON_LAT = 85;
/**
 * Vertices of the circle's polygon: the what-lives-here search, its gbif.org link and the outline drawn on the globe (whatLivesHere.js) all
 * use it, so the card's count, the link and the outline describe the same area. In a real browser on 2026-09-14 gbif.org opened area
 * links of up to 1,253 characters to records and a 1,508-character one (10 km, 64 vertices) to 0 results or an error; the cause is unknown
 * upstream (nothing in gbif-web's source and no replayed request fails). At 32 vertices a 50 km circle gives a link of about 846
 * characters, and gbif.test.mjs keeps every radius under 1,000 at the longest coordinates.
 */
export const SEARCH_POLYGON_VERTICES = 32;

/** The circle's ring as [longitude, latitude] pairs, unchecked (circlePolygonWkt explains the offsets). */
function ringVertices({ lat, lon, radiusKm, vertices }) {
  const toRadians = Math.PI / 180;
  const degrees = radiusKm / EARTH_RADIUS_KM / toRadians;
  const ring = [];
  for (let i = 0; i < vertices; i += 1) {
    const theta = (2 * Math.PI * i) / vertices;
    const vertexLat = lat + degrees * Math.sin(theta);
    ring.push([lon + (degrees * Math.cos(theta)) / Math.cos(((lat + vertexLat) / 2) * toRadians), vertexLat]);
  }
  return ring;
}

/** Why the search does not use a polygon for this circle (outside the ±85° margin, or across the antimeridian), or null when it does. */
export function polygonRefusal({ lat, lon, radiusKm, vertices = SEARCH_POLYGON_VERTICES }) {
  if (Math.abs(lat) > MAX_POLYGON_LAT) return `lat ${lat} is outside ±${MAX_POLYGON_LAT}°, the fixed safety margin polygons keep from the poles at every radius`;
  const across = ringVertices({ lat, lon, radiusKm, vertices }).find(([vertexLon]) => vertexLon < -180 || vertexLon > 180);
  if (across) return `the ${radiusKm} km circle around ${lat},${lon} crosses the antimeridian (vertex longitude ${across[0].toFixed(5)}), and a ring across ±180° cannot be one GBIF polygon`;
  return null;
}

/**
 * The circle of `radiusKm` around a point as a WKT polygon: a closed counter-clockwise ring, longitude first, 5 decimals.
 * gbif.org has no distance filter (its location filter is `geometry`), so the search and its gbif.org link both use this
 * wherever polygonRefusal allows it.
 * Spherical earth: a vertex sits r·sinθ north and r·cosθ / cos(latitude) east of the point. The latitude is the mean of the
 * point's and the vertex's, which keeps every 50 km vertex within 0.04% of the radius up to 85°. The point's latitude
 * alone leaves them 0.6% short at 75° and 1.8% short at 85°.
 */
export function circlePolygonWkt({ lat, lon, radiusKm, vertices = SEARCH_POLYGON_VERTICES }) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`circlePolygonWkt: bad lat ${lat}`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`circlePolygonWkt: bad lon ${lon}`);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) throw new Error(`circlePolygonWkt: bad radius ${radiusKm} km`);
  if (!Number.isInteger(vertices) || vertices < 3) throw new Error(`circlePolygonWkt: bad vertex count ${vertices}`);
  const refusal = polygonRefusal({ lat, lon, radiusKm, vertices });
  if (refusal) throw new Error(`circlePolygonWkt: ${refusal}; refusing to build a wrong polygon`);
  const fixed = (value) => String(Number(value.toFixed(5))); // no "-0", no trailing zeros
  const ring = ringVertices({ lat, lon, radiusKm, vertices }).map(([vertexLon, vertexLat]) => `${fixed(vertexLon)} ${fixed(vertexLat)}`);
  ring.push(ring[0]);
  return `POLYGON((${ring.join(',')}))`;
}

/**
 * The species map legend. GBIF draws each unbinned cell of records as a circle whose size, fill, opacity and line are set by its record
 * count, in the classes of the tile style (github.com/gbif/maps mapnik-server/src/main/node/cartocss/scaled-circles.mss, last changed in
 * commit 9dd3dba827d1c41f1a5e58d6df6226b87249988c, the same bytes as master c3df098 on 2026-09-14). `upTo` is a class's upper bound
 * (null: none), `widthPx` its marker width in tile pixels, `fill` and `opacity` its marker fill, `lineColor` and `lineWidthPx` its marker
 * line (width 0: no line). densityTileTemplate uses `style`; gbif.test.mjs pins the classes to the style.
 *
 * `color` is the legend swatch: the class as the globe draws it at the default view (camera straight down over lon -90, lat 30 at 12,000
 * km, 1400x900, over the Esri World Imagery basemap), each circle's class read from its tile's own record count, and `years` is the map it
 * was measured in (scripts/species-legend-probe.mjs --years, species-legend-colours.py, species-legend-fit.py; 2026-09-14). The three
 * lowest classes are the median colour around the centres of circles whose centre no other circle reaches, in the default LAST 10 YEARS map
 * ('centre', three runs). That map has no circle of the two highest classes, and their circles always overlap others, so they were measured
 * in the ALL YEARS map from the pixels only their own circle covers ('single', two runs: 51 circles of <=10k, 2 of >10k). The >10k swatch
 * matches a lone >10k circle. 94% of the pixels a >10k circle tops lie under 2 or more circles, and those mostly draw a lighter coral,
 * nearer the <=10k swatch (#be7861) than the >10k swatch (#ad5466); a magenta tail is 8-11% of those stacked pixels (ALL YEARS map at the
 * default view, run 1). The style fills are semi-transparent above the lowest class and the globe tints the imagery, so a swatch in the
 * style fill showed colours the map never has. The colours hold from far out only: at the 1,700 km Upper Midwest view the <=100 and <=1k
 * circles look stronger, about 10 L* darker and twice as saturated (CIEDE2000 11-13 from these swatches), which the caption says. Swatch
 * widths stay the style's, so their order holds; on screen circles are only roughly that size and change with zoom (spec: Implementation
 * notes).
 */
export const SPECIES_MAP_LEGEND = Object.freeze({
  style: 'scaled.circles',
  caption: 'Records per circle · colours as seen from far out; closer up they look stronger',
  classes: Object.freeze([
    Object.freeze({ upTo: 10, widthPx: 6, fill: '#fed976', opacity: 1.0, lineColor: '#fe9724', lineWidthPx: 1, color: '#e4d9ac', years: 'recent' }),
    Object.freeze({ upTo: 100, widthPx: 7, fill: '#fd8d3c', opacity: 0.8, lineColor: '#fd5b24', lineWidthPx: 0, color: '#d5aa78', years: 'recent' }),
    Object.freeze({ upTo: 1000, widthPx: 10, fill: '#fd8d3c', opacity: 0.7, lineColor: '#fd471d', lineWidthPx: 0, color: '#cea878', years: 'recent' }),
    Object.freeze({ upTo: 10000, widthPx: 16, fill: '#f03b20', opacity: 0.6, lineColor: '#f01129', lineWidthPx: 0, color: '#be7861', years: 'all' }),
    Object.freeze({ upTo: null, widthPx: 30, fill: '#bd0026', opacity: 0.6, lineColor: '#bd0047', lineWidthPx: 0, color: '#ad5466', years: 'all' }),
  ]),
});

/**
 * Width and height in px of the @1x PNG tiles densityTileTemplate requests (GBIF techdocs maps v2: "normally 512px wide squares"; 512x512
 * measured 2026-09-14). The species provider declares this size, so one tile pixel is drawn at about one screen pixel; at Cesium's default
 * of 256 each was drawn at about half size (spec: Implementation notes).
 */
export const SPECIES_TILE_SIZE_PX = 512;

/**
 * Cesium URL template for GBIF's circle tiles of one taxon. `adhoc`, because `density` ignores `license=`. `srs=EPSG:3857`, because
 * `adhoc` defaults to EPSG:4326 while Cesium's UrlTemplateImageryProvider tiles in Web Mercator. No `bin`: every record-bearing cell is
 * drawn as a circle in the SPECIES_MAP_LEGEND style, where binned hexagons drew some empty (spec: Implementation notes). The @1x tiles are
 * SPECIES_TILE_SIZE_PX square.
 */
export function densityTileTemplate({ taxonKey, years, now = new Date() }) {
  if (!Number.isInteger(taxonKey) || taxonKey <= 0) throw new Error(`densityTileTemplate: bad taxonKey ${taxonKey}`);
  const params = new URLSearchParams({ taxonKey: String(taxonKey), style: SPECIES_MAP_LEGEND.style, srs: 'EPSG:3857' });
  appendRecordFilters(params, years, now);
  return `${GBIF_API}/v2/map/occurrence/adhoc/{z}/{x}/{y}@1x.png?${params}`;
}

/** Species rows in a what-lives-here list, dataset rows under it, and dataset rows under the species map legend (R-7u). */
export const NEAR_SPECIES_LIMIT = 20;
export const NEAR_DATASET_LIMIT = 5;
export const TAXON_DATASET_LIMIT = 3;

/**
 * The 20 species and the 5 datasets with the most CC0 / CC BY records within `radiusKm` of a point, as two facets of one search, each
 * with its own limit: the circlePolygonWkt polygon, or GBIF's geoDistance where the circle cannot be a polygon (polygonRefusal), as every
 * search did before the polygon.
 */
export function speciesNearUrl({ lat, lon, radiusKm, years, now = new Date() }) {
  checkPoint(lat, lon, radiusKm);
  const area = polygonRefusal({ lat, lon, radiusKm }) === null
    ? { geometry: circlePolygonWkt({ lat, lon, radiusKm }) }
    : { geoDistance: `${lat.toFixed(4)},${lon.toFixed(4)},${radiusKm}km` };
  const params = new URLSearchParams({ ...area, hasCoordinate: 'true', hasGeospatialIssue: 'false' });
  params.append('facet', 'speciesKey');
  params.append('facet', 'datasetKey');
  params.set('speciesKey.facetLimit', String(NEAR_SPECIES_LIMIT));
  params.set('datasetKey.facetLimit', String(NEAR_DATASET_LIMIT));
  params.set('limit', '0');
  appendRecordFilters(params, years, now);
  return `${GBIF_API}/v1/occurrence/search?${params}`;
}

/**
 * The same search on gbif.org, where a visitor can browse the records and request a citable download. It carries the
 * search's own `geometry` value: gbif.org drops `geo_distance`, which would open the link with no location filter. It carries the search's
 * `hasGeospatialIssue=false` too, so gbif.org counts the records the card counts (gbif-web lists hasGeospatialIssue among its occurrence
 * search fields; on 2026-09-14 a 50 km link without it counted 222,689 records where the card said 217,508).
 */
export function gbifPortalUrl({ lat, lon, radiusKm, years, now = new Date() }) {
  checkPoint(lat, lon, radiusKm);
  const params = new URLSearchParams({ geometry: circlePolygonWkt({ lat, lon, radiusKm }), hasGeospatialIssue: 'false' });
  appendRecordFilters(params, years, now);
  return `https://www.gbif.org/occurrence/search?${params}`;
}

/** gbif.org with the same licences and years and no location filter: the card's link where the circle cannot be a polygon. */
export function gbifPortalAnyLocationUrl({ years, now = new Date() }) {
  const params = new URLSearchParams();
  appendRecordFilters(params, years, now);
  return `https://www.gbif.org/occurrence/search?${params}`;
}

/** A GBIF dataset key: a lowercase UUID, as the DATASET_KEY facet and /v1/dataset return it. */
const DATASET_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkDatasetKey(key) {
  if (typeof key !== 'string' || !DATASET_KEY_PATTERN.test(key)) throw new Error(`GBIF dataset key must be a dataset UUID, got ${JSON.stringify(key)}`);
  return key;
}

/** The DATASET_KEY facet in facet order. A key becomes a request path and a link, so anything but a dataset UUID with a count is dropped. */
function parseDatasetFacet(json) {
  const facet = (json.facets || []).find((f) => f && f.field === 'DATASET_KEY');
  return (facet?.counts || [])
    .map((c) => ({ key: c.name, count: Number(c.count) }))
    .filter((d) => typeof d.key === 'string' && DATASET_KEY_PATTERN.test(d.key) && Number.isFinite(d.count));
}

export function parseSpeciesNear(json) {
  if (!json || !Number.isFinite(json.count)) throw new Error('GBIF occurrence search: response has no count');
  const facet = (json.facets || []).find((f) => f && f.field === 'SPECIES_KEY');
  const species = (facet?.counts || [])
    .map((c) => ({ key: Number(c.name), count: Number(c.count) }))
    .filter((s) => Number.isInteger(s.key) && s.key > 0 && Number.isFinite(s.count));
  return { total: json.count, species, datasets: parseDatasetFacet(json) };
}

/**
 * The 3 datasets with the most CC0 / CC BY records of a taxon in the chosen years: the datasets behind the species map (R-7u), with the
 * record filters the map's adhoc tiles apply. Those tiles add hasCoordinate=true and no geospatial-issue filter (github.com/gbif/occurrence
 * BaseEsHeatmapRequestBuilder.buildHeatmapRequest, at c590689), and live on 2026-09-14 the monarch z0 tile totalled 42,244 records: the
 * search with hasCoordinate=true gave 42,244 and with hasGeospatialIssue=false as well 42,240. So hasCoordinate=true, and not
 * hasGeospatialIssue=false, which would drop records the map draws. No location filter, like the map.
 */
export function taxonDatasetsUrl({ taxonKey, years, now = new Date() }) {
  if (!Number.isInteger(taxonKey) || taxonKey <= 0) throw new Error(`taxonDatasetsUrl: bad taxonKey ${taxonKey}`);
  const params = new URLSearchParams({ taxonKey: String(taxonKey), hasCoordinate: 'true', facet: 'datasetKey', 'datasetKey.facetLimit': String(TAXON_DATASET_LIMIT), limit: '0' });
  appendRecordFilters(params, years, now);
  return `${GBIF_API}/v1/occurrence/search?${params}`;
}

export function parseTaxonDatasets(json) {
  if (!json || !Number.isFinite(json.count)) throw new Error('GBIF occurrence search: response has no count');
  return { total: json.count, datasets: parseDatasetFacet(json) };
}

/**
 * The taxon's records on gbif.org with the map's record filters: coordinates, licences and years (see taxonDatasetsUrl), in the camelCase
 * names gbif.org writes back to its URL. `checklistKey` says the key is a Backbone key (GBIF_BACKBONE_CHECKLIST_KEY): in a real browser on
 * 2026-09-14 the link without it opened to 0 results, and with it to the monarch's 42,244 records, the count the API gives.
 */
export function gbifPortalTaxonUrl({ taxonKey, years, now = new Date() }) {
  if (!Number.isInteger(taxonKey) || taxonKey <= 0) throw new Error(`gbifPortalTaxonUrl: bad taxonKey ${taxonKey}`);
  const params = new URLSearchParams({ taxonKey: String(taxonKey), checklistKey: GBIF_BACKBONE_CHECKLIST_KEY, hasCoordinate: 'true' });
  appendRecordFilters(params, years, now);
  return `https://www.gbif.org/occurrence/search?${params}`;
}

export function datasetUrl(key) {
  return `${GBIF_API}/v1/dataset/${checkDatasetKey(key)}`;
}

/**
 * A dataset's title and DOI (null when it has none). Its licence is left out on purpose: a dataset's licence is not the licence of the
 * records shown (the iNaturalist Research-grade dataset is CC BY-NC while its CC BY records pass the record filter), so it is never shown.
 */
export function parseDataset(json) {
  if (!json || typeof json !== 'object') throw new Error('GBIF dataset: response is not an object');
  if (typeof json.key !== 'string' || !DATASET_KEY_PATTERN.test(json.key)) throw new Error('GBIF dataset: response has no dataset key');
  if (typeof json.title !== 'string' || !json.title.trim()) throw new Error(`GBIF dataset ${json.key}: response has no title`);
  return { key: json.key, title: json.title.trim(), doi: typeof json.doi === 'string' && json.doi ? json.doi : null };
}

/** "10.", a 4-9 digit registrant, "/", and a suffix of the characters Crossref recommends matching: nothing that can leave doi.org's path. */
const DOI_PATTERN = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/;

/** A dataset's link: its DOI on doi.org, or its gbif.org page when it has no DOI or one outside DOI_PATTERN. Always https. */
export function datasetHref({ key, doi }) {
  checkDatasetKey(key);
  return typeof doi === 'string' && DOI_PATTERN.test(doi) ? `https://doi.org/${doi}` : `https://www.gbif.org/dataset/${key}`;
}

export function inatSuggestUrl(q) {
  return `${INAT_API}/v1/taxa/autocomplete?${new URLSearchParams({ q, per_page: '8' })}`;
}

export function parseInatSuggest(json) {
  return (json?.results || [])
    .filter((r) => r && typeof r.name === 'string' && r.name && typeof r.rank === 'string')
    // matched_term is the name iNaturalist matched, which can be another common name ("Hump-back Cicada" for Swamp Cicada)
    .map((r) => ({ id: r.id ?? null, gbifKey: null, scientificName: r.name, commonName: r.preferred_common_name || null, rank: r.rank, matchedTerm: typeof r.matched_term === 'string' && r.matched_term ? r.matched_term : null }));
}

export function gbifSuggestUrl(q) {
  return `${GBIF_API}/v1/species/suggest?${new URLSearchParams({ q, limit: '8' })}`;
}

export function parseGbifSuggest(json) {
  return (Array.isArray(json) ? json : [])
    .filter((r) => r && Number.isInteger(r.key))
    .map((r) => ({ id: null, gbifKey: r.key, scientificName: r.canonicalName || r.scientificName, commonName: null, rank: String(r.rank || '').toLowerCase(), matchedTerm: null }));
}

export function gbifMatchUrl(name) {
  return `${GBIF_API}/v1/species/match?${new URLSearchParams({ name, strict: 'true' })}`;
}

/**
 * GBIF's match for a scientific name (M1): the key to map (a synonym resolves to its accepted key), how GBIF matched the name (EXACT, FUZZY,
 * HIGHERRANK or NONE) and the name it matched, so a match that is not EXACT can say which GBIF name the map shows. No match has a null key
 * and name; a response that is not a match fails loud rather than reading as "not in GBIF".
 */
export function parseGbifMatch(json) {
  const matchType = json?.matchType;
  if (typeof matchType !== 'string') throw new Error(`GBIF match: response has no matchType (${String(JSON.stringify(json)).slice(0, 120)})`);
  if (matchType === 'NONE') return { key: null, matchType, canonicalName: null };
  if (!Number.isInteger(json.usageKey)) throw new Error(`GBIF match: a ${matchType} match has no usageKey`);
  const canonicalName = json.canonicalName || json.scientificName;
  if (typeof canonicalName !== 'string' || !canonicalName) throw new Error(`GBIF match: a ${matchType} match for key ${json.usageKey} has no name`);
  return { key: Number.isInteger(json.acceptedUsageKey) ? json.acceptedUsageKey : json.usageKey, matchType, canonicalName };
}

export function speciesUrl(key) {
  return `${GBIF_API}/v1/species/${key}`;
}

export function parseSpeciesName(json) {
  if (!json || !Number.isInteger(json.key)) throw new Error('GBIF species: response has no key');
  return { key: json.key, scientificName: json.canonicalName || json.scientificName, commonName: json.vernacularName || null, className: json.class || null };
}

/** At most `maxPerWindow` acquisitions in any `windowMs` window. */
export function createRateLimiter({ maxPerWindow = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const stamps = [];
  return {
    tryAcquire() {
      const t = now();
      while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length >= maxPerWindow) return false;
      stamps.push(t);
      return true;
    },
  };
}

/** Run async jobs with at most `limit` in flight. */
export function createPool(limit = 4) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length) {
      const { job, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => { active -= 1; pump(); });
    }
  };
  return {
    run(job) { return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); }); },
    get active() { return active; },
  };
}

/** GET JSON with a timeout. HTTP errors and timeouts become RequestError; a caller abort stays an AbortError. */
export async function fetchJson(url, { signal = null, timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new RequestError('timeout', { url })), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new RequestError(`HTTP ${res.status}`, { status: res.status, url });
    return await res.json();
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (controller.signal.aborted && !signal?.aborted) throw new RequestError('timeout', { url });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

function abortError(signal) {
  return signal.reason?.name === 'AbortError' ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
}

/** Settle with `shared`, unless this caller's `signal` aborts first; the shared work carries on for every other caller. */
function untilCallerAborts(shared, signal) {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function createBioClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  inatLimiter = createRateLimiter({ now }),
  pool = createPool(4),
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const names = new Map();
  const datasets = new Map();
  const get = (url, signal) => fetchJson(url, { signal, timeoutMs, fetchImpl });
  return {
    /** Name suggestions: iNaturalist first; GBIF scientific names, with a notice, when iNaturalist fails. */
    async suggest(q, { signal = null } = {}) {
      const query = String(q ?? '').trim();
      if (query.length < 3) return { source: 'none', items: [] };
      if (!inatLimiter.tryAcquire()) throw new RequestError('iNaturalist limit reached (60 name searches a minute); wait a moment');
      let inatError;
      try {
        return { source: 'inaturalist', items: parseInatSuggest(await get(inatSuggestUrl(query), signal)) };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        inatError = error;
      }
      try {
        const items = parseGbifSuggest(await get(gbifSuggestUrl(query), signal));
        return { source: 'gbif', notice: `iNaturalist didn't answer (${inatError.message}); showing GBIF scientific names`, items };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new RequestError(`iNaturalist (${inatError.message}) and GBIF (${error.message}) both failed`);
      }
    },
    async match(scientificName, { signal = null } = {}) {
      return parseGbifMatch(await get(gbifMatchUrl(scientificName), signal));
    },
    async speciesNear(args, { signal = null } = {}) {
      return parseSpeciesNear(await get(speciesNearUrl(args), signal));
    },
    async taxonDatasets(args, { signal = null } = {}) {
      return parseTaxonDatasets(await get(taxonDatasetsUrl(args), signal));
    },
    /**
     * Cached per key for the session and shared by every caller; a failed lookup is forgotten so a retry can succeed.
     * The shared lookup carries no caller signal (timeout only), so one caller's abort rejects only that caller.
     */
    speciesName(key, { signal = null } = {}) {
      if (!names.has(key)) {
        const pending = pool.run(() => get(speciesUrl(key), null)).then(parseSpeciesName);
        names.set(key, pending);
        pending.catch(() => names.delete(key));
      }
      return untilCallerAborts(names.get(key), signal);
    },
    /** A dataset's title and DOI, looked up like speciesName: one shared, pooled lookup per key for the session, a failure forgotten. */
    dataset(key, { signal = null } = {}) {
      if (!datasets.has(key)) {
        const pending = pool.run(() => get(datasetUrl(key), null)).then(parseDataset);
        datasets.set(key, pending);
        pending.catch(() => datasets.delete(key));
      }
      return untilCallerAborts(datasets.get(key), signal);
    },
  };
}
