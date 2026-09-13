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

/** Cesium URL template for GBIF hexagon tiles of one taxon. `adhoc`, because `density` ignores `license=`. */
export function densityTileTemplate({ taxonKey, years, now = new Date() }) {
  if (!Number.isInteger(taxonKey) || taxonKey <= 0) throw new Error(`densityTileTemplate: bad taxonKey ${taxonKey}`);
  const params = new URLSearchParams({ taxonKey: String(taxonKey), style: 'classic.poly', bin: 'hex', hexPerTile: '30' });
  appendRecordFilters(params, years, now);
  return `${GBIF_API}/v2/map/occurrence/adhoc/{z}/{x}/{y}@1x.png?${params}`;
}

/** The 20 species with the most CC0 / CC BY records within `radiusKm` of a point. */
export function speciesNearUrl({ lat, lon, radiusKm, years, now = new Date() }) {
  checkPoint(lat, lon, radiusKm);
  const params = new URLSearchParams({
    geoDistance: `${lat.toFixed(4)},${lon.toFixed(4)},${radiusKm}km`,
    hasCoordinate: 'true',
    hasGeospatialIssue: 'false',
    facet: 'speciesKey',
    facetLimit: '20',
    limit: '0',
  });
  appendRecordFilters(params, years, now);
  return `${GBIF_API}/v1/occurrence/search?${params}`;
}

/** The same filters on gbif.org, where a visitor can browse the records and request a citable download. */
export function gbifPortalUrl({ lat, lon, radiusKm, years, now = new Date() }) {
  checkPoint(lat, lon, radiusKm);
  const params = new URLSearchParams({ geo_distance: `${lat.toFixed(4)},${lon.toFixed(4)},${radiusKm}km` });
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
    .map((r) => ({ id: r.id ?? null, gbifKey: null, scientificName: r.name, commonName: r.preferred_common_name || null, rank: r.rank }));
}

export function gbifSuggestUrl(q) {
  return `${GBIF_API}/v1/species/suggest?${new URLSearchParams({ q, limit: '8' })}`;
}

export function parseGbifSuggest(json) {
  return (Array.isArray(json) ? json : [])
    .filter((r) => r && Number.isInteger(r.key))
    .map((r) => ({ id: null, gbifKey: r.key, scientificName: r.canonicalName || r.scientificName, commonName: null, rank: String(r.rank || '').toLowerCase() }));
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
    /** Cached per key for the session; a failed lookup is forgotten so a retry can succeed. */
    speciesName(key, { signal = null } = {}) {
      if (!names.has(key)) {
        const pending = pool.run(() => get(speciesUrl(key), signal)).then(parseSpeciesName);
        names.set(key, pending);
        pending.catch(() => names.delete(key));
      }
      return names.get(key);
    },
  };
}
