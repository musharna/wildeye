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
 * Polygons are built only below 85° latitude and away from ±180°: a ring near a pole or across the antimeridian cannot be
 * expressed as a simple GBIF polygon. Such a circle is searched with geoDistance instead (see speciesNearUrl).
 */
export const MAX_POLYGON_LAT = 85;

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

/** Why the circle cannot be a simple GBIF polygon (beyond ±85° latitude, or across the antimeridian), or null when it can. */
export function polygonRefusal({ lat, lon, radiusKm, vertices = 64 }) {
  if (Math.abs(lat) > MAX_POLYGON_LAT) return `lat ${lat} is outside ±${MAX_POLYGON_LAT}° (a ring near a pole is not a simple GBIF polygon)`;
  const across = ringVertices({ lat, lon, radiusKm, vertices }).find(([vertexLon]) => vertexLon < -180 || vertexLon > 180);
  if (across) return `the ${radiusKm} km circle around ${lat},${lon} crosses the antimeridian (vertex longitude ${across[0].toFixed(5)})`;
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
export function circlePolygonWkt({ lat, lon, radiusKm, vertices = 64 }) {
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
 * Cesium URL template for GBIF hexagon tiles of one taxon. `adhoc`, because `density` ignores `license=`. `srs=EPSG:3857`,
 * because `adhoc` defaults to EPSG:4326 while Cesium's UrlTemplateImageryProvider tiles in Web Mercator.
 */
export function densityTileTemplate({ taxonKey, years, now = new Date() }) {
  if (!Number.isInteger(taxonKey) || taxonKey <= 0) throw new Error(`densityTileTemplate: bad taxonKey ${taxonKey}`);
  const params = new URLSearchParams({ taxonKey: String(taxonKey), style: 'classic.poly', bin: 'hex', hexPerTile: '30', srs: 'EPSG:3857' });
  appendRecordFilters(params, years, now);
  return `${GBIF_API}/v2/map/occurrence/adhoc/{z}/{x}/{y}@1x.png?${params}`;
}

/**
 * The 20 species with the most CC0 / CC BY records within `radiusKm` of a point: the circlePolygonWkt polygon, or GBIF's
 * geoDistance where the circle cannot be a polygon (polygonRefusal), as every search did before the polygon.
 */
export function speciesNearUrl({ lat, lon, radiusKm, years, now = new Date() }) {
  checkPoint(lat, lon, radiusKm);
  const area = polygonRefusal({ lat, lon, radiusKm }) === null
    ? { geometry: circlePolygonWkt({ lat, lon, radiusKm }) }
    : { geoDistance: `${lat.toFixed(4)},${lon.toFixed(4)},${radiusKm}km` };
  const params = new URLSearchParams({
    ...area,
    hasCoordinate: 'true',
    hasGeospatialIssue: 'false',
    facet: 'speciesKey',
    facetLimit: '20',
    limit: '0',
  });
  appendRecordFilters(params, years, now);
  return `${GBIF_API}/v1/occurrence/search?${params}`;
}

/**
 * The same search on gbif.org, where a visitor can browse the records and request a citable download. It carries the
 * search's own `geometry` value: gbif.org drops `geo_distance`, which would open the link with no location filter.
 */
export function gbifPortalUrl({ lat, lon, radiusKm, years, now = new Date() }) {
  checkPoint(lat, lon, radiusKm);
  const params = new URLSearchParams({ geometry: circlePolygonWkt({ lat, lon, radiusKm }) });
  appendRecordFilters(params, years, now);
  return `https://www.gbif.org/occurrence/search?${params}`;
}

/** gbif.org with the same licences and years and no location filter: the card's link where the circle cannot be a polygon. */
export function gbifPortalAnyLocationUrl({ years, now = new Date() }) {
  const params = new URLSearchParams();
  appendRecordFilters(params, years, now);
  return `https://www.gbif.org/occurrence/search?${params}`;
}

export function parseSpeciesNear(json) {
  if (!json || !Number.isFinite(json.count)) throw new Error('GBIF occurrence search: response has no count');
  const facet = (json.facets || []).find((f) => f && f.field === 'SPECIES_KEY');
  const species = (facet?.counts || [])
    .map((c) => ({ key: Number(c.name), count: Number(c.count) }))
    .filter((s) => Number.isInteger(s.key) && s.key > 0 && Number.isFinite(s.count));
  return { total: json.count, species };
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

/** GBIF key for a scientific name; a synonym resolves to its accepted key; no match is null. */
export function parseGbifMatch(json) {
  if (!json || json.matchType === 'NONE' || !Number.isInteger(json.usageKey)) return null;
  return Number.isInteger(json.acceptedUsageKey) ? json.acceptedUsageKey : json.usageKey;
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
  };
}
