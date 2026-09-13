# Species Search, "What Lives Here" and Biology Details Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a biology marker shows its details; visitors can map any species from GBIF and list what has been recorded around a clicked point, all in the browser so the GitHub Pages build works.

**Architecture:** Pure request builders and parsers (`src/bio/gbif.js`) feed three browser pieces: a shared HUD card (`src/bio/detailsCard.js`) driven by `viewer.selectedEntityChanged`, a `species` data layer (`src/data/species.js`) that draws GBIF `adhoc` hexagon tiles and saves its settings in share links, and a SPECIES panel (`src/bio/speciesPanel.js`) with an arm-then-click "what lives here" controller (`src/bio/whatLivesHere.js`). No pipeline, no `/api`.

**Tech Stack:** CesiumJS 1.138 (`UrlTemplateImageryProvider`, `ImageryLayer`, `ScreenSpaceEventHandler`), plain ES modules, `node:test`, puppeteer for real-browser checks, Vite static build.

**Spec:** `docs/superpowers/specs/2026-09-13-species-search-design.md`

## Global Constraints

- Record filter on every GBIF request: `license=CC0_1_0&license=CC_BY_4_0`. Maps use `/v2/map/occurrence/adhoc/`, never `/v2/map/occurrence/density/` (density ignores `license=`).
- Years: `recent` = the last 10 calendar years including the current one (2017–2026 in 2026); `all` = no `year` parameter.
- Radius choices: 1, 10 (default), 50 km.
- iNaturalist: at most 60 requests per minute per browser; name suggestions only (no observations, photos or media).
- Every request: 8 s timeout; a newer request aborts the older one; GBIF name lookups at most 4 in flight.
- Strings from GBIF or iNaturalist go into the page with `textContent`, never `innerHTML`.
- Errors are shown where they happen and logged with `console.error` plus context; never swallowed. A superseded request (`AbortError`) is not an error.
- The species feature must work on the static host: no `/api` calls, no `requiresBackend`, no `data-requires-backend`.
- Node 24: `export PATH=~/.local/node24/bin:$PATH`. Single test file: `node --test <file>`. Full suite: `npm test`.
- Public prose (README, CHANGELOG): plain declarative sentences; goes in a draft PR.
- Visual output (card, panel, map) passes an independent critic subagent before deploy. The user cannot see inline images: copy screenshots to `/mnt/c/Users/a2b32/Downloads`.
- Before the Pages deploy, the GBIF terms and the iNaturalist Terms of Service are read in a browser and quoted in `DATA_SOURCES.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/bio/gbif.js` (create) | URL builders, response parsers, rate limiter, concurrency pool, `fetchJson`, `createBioClient` |
| `src/bio/gbif.test.mjs` (create) | unit tests for the above |
| `src/data/rasterDrape.js` (modify) | export `setStackedImagery` so non-drape imagery joins the drape z-order |
| `src/data/species.js` (create) | `species` data layer: GBIF tiles for one taxon, params, tile-failure status |
| `src/data/species.test.mjs` (create) | layer tests |
| `src/data/layerState.js` (modify) | `species` registry entry (token `sp`) and share-link option group |
| `src/data/layerState.test.mjs` (modify) | count 45, species round trip |
| `src/main.js` (modify) | register the layer; create card, client, what-lives-here, panel |
| `src/bio/detailsCard.js` (create) | shared HUD card: detail mode + list mode |
| `src/bio/detailsCard.test.mjs` (create) | card decision, data-source names, text-only rows |
| `src/bio/whatLivesHere.js` (create) | arm-then-click controller |
| `src/bio/whatLivesHere.test.mjs` (create) | click classification, one query per arming, messages |
| `src/bio/speciesPanel.js` (create) | SPECIES panel behaviour |
| `src/bio/speciesPanel.test.mjs` (create) | choose paths, suggestion text, markup/CSS/wiring pins |
| `index.html`, `style.css`, `src/ui.js` (modify) | panel markup, panel + card CSS, collapse on Cockpit entry |
| `src/data/dataCredits.js`, `DATA_SOURCES.md` (modify) | GBIF and iNaturalist credit and licence rows |
| `scripts/build-static-preview.sh` (create), `.gitignore` (modify) | local Pages-flavour build in `.qa-static/` |
| `scripts/qa-species.mjs` (create) | real-browser checks: card, search, here, portal |
| `README.md`, `CHANGELOG.md` (modify, draft PR) | public description |

Task order matters: Task 3 adds the registry entry and the `main.js` registration together (the manager refuses a registry/registration mismatch at boot). Task 6 needs Tasks 1–5.

---

### Task 1: GBIF and iNaturalist client

**Files:**
- Create: `src/bio/gbif.js`
- Test: `src/bio/gbif.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LICENSES: string[]`, `RADII_KM: number[]`, `REQUEST_TIMEOUT_MS: number`, `class RequestError extends Error { status: number|null, url: string|null }`
  - `yearRange(years: 'recent'|'all', now?: Date) → {from, to}|null`; `yearLabel(years, now?) → string`
  - `densityTileTemplate({taxonKey: number, years, now?}) → string` (Cesium template with `{z}/{x}/{y}`)
  - `speciesNearUrl({lat, lon, radiusKm, years, now?}) → string`; `gbifPortalUrl({lat, lon, radiusKm, years, now?}) → string`
  - `parseSpeciesNear(json) → {total: number, species: {key: number, count: number}[]}`
  - `inatSuggestUrl(q)`, `parseInatSuggest(json)`, `gbifSuggestUrl(q)`, `parseGbifSuggest(json)` → suggestion items `{id, gbifKey: number|null, scientificName, commonName: string|null, rank}`
  - `gbifMatchUrl(name)`, `parseGbifMatch(json) → number|null`; `speciesUrl(key)`, `parseSpeciesName(json) → {key, scientificName, commonName, className}`
  - `createRateLimiter({maxPerWindow, windowMs, now}) → {tryAcquire(): boolean}`; `createPool(limit) → {run(job): Promise, active}`
  - `fetchJson(url, {signal, timeoutMs, fetchImpl}) → Promise<any>`
  - `createBioClient({fetchImpl, now, inatLimiter, pool, timeoutMs}) → {suggest(q, {signal}) → Promise<{source: 'inaturalist'|'gbif'|'none', notice?: string, items}>, match(name, {signal}) → Promise<number|null>, speciesNear(args, {signal}) → Promise<{total, species}>, speciesName(key, {signal}) → Promise<{key, scientificName, commonName, className}>}`

- [ ] **Step 1: Write the failing tests**

Create `src/bio/gbif.test.mjs`:

```js
// src/bio/gbif.test.mjs — GBIF / iNaturalist request builders, parsers and client behaviour (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LICENSES, yearRange, yearLabel, densityTileTemplate, speciesNearUrl, gbifPortalUrl, parseSpeciesNear,
  inatSuggestUrl, parseInatSuggest, gbifSuggestUrl, parseGbifSuggest, gbifMatchUrl, parseGbifMatch,
  speciesUrl, parseSpeciesName, createRateLimiter, createPool, fetchJson, RequestError, createBioClient,
} from './gbif.js';

const NOW = new Date('2026-09-13T12:00:00Z');
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const httpError = (status) => ({ ok: false, status, json: async () => ({}) });

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
  assert.equal(tile('all').searchParams.has('year'), false);
  assert.ok(densityTileTemplate({ taxonKey: 1, years: 'all', now: NOW }).includes('/{z}/{x}/{y}@1x.png?'), 'Cesium placeholders stay unencoded');
  assert.throws(() => densityTileTemplate({ taxonKey: 0, years: 'all', now: NOW }), /taxonKey/);
});

test('species near a point: radius, both licences, years, clean coordinates, top-20 species facet', () => {
  const url = new URL(speciesNearUrl({ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'recent', now: NOW }));
  assert.equal(url.origin + url.pathname, 'https://api.gbif.org/v1/occurrence/search');
  assert.equal(url.searchParams.get('geoDistance'), '44.4600,-110.8300,10km');
  assert.deepEqual(url.searchParams.getAll('license'), LICENSES);
  assert.equal(url.searchParams.get('year'), '2017,2026');
  for (const [key, value] of [['hasCoordinate', 'true'], ['hasGeospatialIssue', 'false'], ['facet', 'speciesKey'], ['facetLimit', '20'], ['limit', '0']]) {
    assert.equal(url.searchParams.get(key), value, key);
  }
  assert.throws(() => speciesNearUrl({ lat: 44, lon: -110, radiusKm: 5, years: 'all', now: NOW }), /radius/);
  assert.throws(() => speciesNearUrl({ lat: Number.NaN, lon: -110, radiusKm: 10, years: 'all', now: NOW }), /lat/);
  const portal = new URL(gbifPortalUrl({ lat: 44.46, lon: -110.83, radiusKm: 10, years: 'recent', now: NOW }));
  assert.equal(portal.origin + portal.pathname, 'https://www.gbif.org/occurrence/search');
  assert.equal(portal.searchParams.get('geo_distance'), '44.4600,-110.8300,10km');
  assert.deepEqual(portal.searchParams.getAll('license'), LICENSES);
});

test('parseSpeciesNear reads the total and the SPECIES_KEY facet; no count is an error', () => {
  // shape of a live response, 2026-09-13 (10 km around 44.46,-110.83)
  const live = { offset: 0, limit: 0, endOfRecords: false, count: 39210, results: [], facets: [{ field: 'SPECIES_KEY', counts: [{ name: '2482492', count: 3524 }, { name: '2490935', count: 2122 }] }] };
  assert.deepEqual(parseSpeciesNear(live), { total: 39210, species: [{ key: 2482492, count: 3524 }, { key: 2490935, count: 2122 }] });
  assert.deepEqual(parseSpeciesNear({ count: 0, facets: [] }), { total: 0, species: [] });
  assert.throws(() => parseSpeciesNear({ facets: [] }), /count/);
});

test('name parsers keep the fields the panel shows', () => {
  assert.deepEqual(
    parseInatSuggest({ results: [{ id: 1001, name: 'Danaus plexippus', rank: 'species', preferred_common_name: 'Monarch', observations_count: 541746 }, { id: 2, rank: 'genus' }] }),
    [{ id: 1001, gbifKey: null, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' }],
  );
  assert.deepEqual(
    parseGbifSuggest([{ key: 6223161, canonicalName: 'Danaus plexaure', scientificName: 'Danaus plexaure (Godart)', rank: 'SPECIES' }]),
    [{ id: null, gbifKey: 6223161, scientificName: 'Danaus plexaure', commonName: null, rank: 'species' }],
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.local/node24/bin:$PATH && node --test src/bio/gbif.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./gbif.js`.

- [ ] **Step 3: Implement `src/bio/gbif.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/bio/gbif.test.mjs`
Expected: PASS, 10 tests, 0 failures.

- [ ] **Step 5: See the key tests fail for the stated reason**

Temporarily change `/v2/map/occurrence/adhoc/` to `/v2/map/occurrence/density/` in `densityTileTemplate`, run `node --test src/bio/gbif.test.mjs`, expect exactly the "density tiles use the adhoc endpoint" test to fail on the pathname assertion; restore. Then change `createPool(4)`'s `while (active < limit` to `while (true && queue.length`, expect "never run more than 4" to fail with peak 12; restore. Run the file again: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bio/gbif.js src/bio/gbif.test.mjs
git commit -m "species search: GBIF and iNaturalist client (adhoc tiles with CC0/CC BY filter, radius species facet, name suggestions with GBIF fallback, 60/min iNaturalist cap, 4 concurrent name lookups, 8 s timeouts)"
```

---

### Task 2: `species` data layer and drape stacking

**Files:**
- Modify: `src/data/rasterDrape.js` (after `export function _drapeStackForTest() { return _stack; }`)
- Create: `src/data/species.js`
- Test: `src/data/species.test.mjs`

**Interfaces:**
- Consumes: `densityTileTemplate`, `RADII_KM` from `src/bio/gbif.js` (Task 1).
- Produces:
  - `setStackedImagery(imageryLayers, id: string, layer: ImageryLayer|null, zrank?: number) → string[]` in `rasterDrape.js`
  - `species.js`: `SPECIES_ZRANK = 1000`, `SPECIES_ALPHA = 0.7`, `SPECIES_YEARS`, `TILE_FAILURE_LIMIT = 8`, `DEFAULT_SPECIES_PARAMS = {taxonKey: null, name: null, years: 'recent', radiusKm: 10}`, `mergeSpeciesParams(current, request) → params|null`, `createSpeciesLayer({providerFor, imageryLayerFor, stack, now})`, default export `speciesLayer`
  - layer methods: `init(viewer)`, `enable()`, `disable()`, `update() → Promise<true>`, `destroy()`, `setParams(p) → boolean`, `getParams() → {taxonKey, name, years, radiusKm}`, `getStats() → {count, lastUpdate, error: string|null, tileFailures}`, `onStatus(listener) → unsubscribe`; fields `id: 'species'`, `updateInterval: 0`, `showInTogglePanel: false`

- [ ] **Step 1: Write the failing tests**

Create `src/data/species.test.mjs`:

```js
// src/data/species.test.mjs — species map layer: params, tile rebuilds, z-order above drapes, tile-failure status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeciesLayer, mergeSpeciesParams, DEFAULT_SPECIES_PARAMS, SPECIES_ALPHA, TILE_FAILURE_LIMIT } from './species.js';
import { setStackedImagery } from './rasterDrape.js';

const NOW = new Date('2026-09-13T12:00:00Z');

function fakeImageryLayers() {
  return {
    list: [],
    contains(layer) { return this.list.includes(layer); },
    add(layer) { this.list.push(layer); },
    remove(layer, destroy) { this.list = this.list.filter((x) => x !== layer); if (destroy) layer.destroyed = true; return true; },
  };
}

function harness() {
  const providers = [];
  const layer = createSpeciesLayer({
    providerFor: (url) => {
      const listeners = [];
      const provider = { url, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(provider);
      return provider;
    },
    imageryLayerFor: (provider, options) => ({ provider, alpha: options.alpha, show: false }),
    now: () => NOW,
  });
  return { layer, viewer: { imageryLayers: fakeImageryLayers() }, providers };
}

test('params: a new taxon clears the old name; invalid values reject the whole request', () => {
  const monarch = mergeSpeciesParams(DEFAULT_SPECIES_PARAMS, { taxonKey: 5133088, name: 'Monarch' });
  assert.deepEqual(monarch, { taxonKey: 5133088, name: 'Monarch', years: 'recent', radiusKm: 10 });
  assert.equal(mergeSpeciesParams(monarch, { taxonKey: 5220086 }).name, null);
  assert.equal(mergeSpeciesParams(monarch, { radiusKm: 50 }).name, 'Monarch');
  assert.equal(mergeSpeciesParams(monarch, { years: 'decade' }), null);
  assert.equal(mergeSpeciesParams(monarch, { radiusKm: 5 }), null);
  assert.equal(mergeSpeciesParams(monarch, { taxonKey: -1 }), null);
  assert.equal(mergeSpeciesParams(monarch, { taxonKey: '5133088' }), null);
});

test('no tiles until a species is chosen; years rebuild the tiles, radius does not', () => {
  const { layer, viewer, providers } = harness();
  layer.init(viewer);
  assert.equal(providers.length, 0);
  assert.equal(layer.setParams({ taxonKey: 5133088, name: 'Monarch' }), true);
  assert.equal(providers.length, 1);
  assert.match(providers[0].url, /\/v2\/map\/occurrence\/adhoc\/\{z\}\/\{x\}\/\{y\}@1x\.png\?.*taxonKey=5133088/);
  assert.equal(viewer.imageryLayers.list.length, 1);
  assert.equal(viewer.imageryLayers.list[0].alpha, SPECIES_ALPHA);
  assert.equal(viewer.imageryLayers.list[0].show, false, 'hidden until enabled');
  layer.enable();
  assert.equal(viewer.imageryLayers.list[0].show, true);
  layer.setParams({ radiusKm: 50 });
  assert.equal(providers.length, 1, 'radius only affects what lives here');
  layer.setParams({ years: 'all' });
  assert.equal(providers.length, 2);
  assert.equal(viewer.imageryLayers.list.length, 1, 'old tiles removed');
  assert.equal(providers[1].url.includes('year='), false);
  assert.equal(layer.setParams({ years: 'decade' }), false);
  assert.deepEqual(layer.getParams(), { taxonKey: 5133088, name: 'Monarch', years: 'all', radiusKm: 50 });
  layer.destroy();
  assert.equal(viewer.imageryLayers.list.length, 0);
});

test('species tiles stay above the raster drapes after a drape restacks', () => {
  const { layer, viewer } = harness();
  layer.init(viewer);
  layer.setParams({ taxonKey: 5133088 });
  const drape = { name: 'test drape' };
  viewer.imageryLayers.add(drape);
  setStackedImagery(viewer.imageryLayers, 'test-drape', drape, 10);
  const top = viewer.imageryLayers.list[viewer.imageryLayers.list.length - 1];
  assert.equal(top.provider?.url.includes('taxonKey=5133088'), true, 'species imagery is last (drawn on top)');
  setStackedImagery(viewer.imageryLayers, 'test-drape', null);
  layer.destroy();
});

test('repeated tile errors surface "map tiles failing" once', () => {
  const { layer, viewer, providers } = harness();
  let notified = 0;
  layer.onStatus(() => { notified += 1; });
  layer.init(viewer);
  layer.setParams({ taxonKey: 5133088 });
  notified = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < TILE_FAILURE_LIMIT + 3; i += 1) providers[0].fail(new Error('HTTP 500'));
  } finally {
    console.error = originalError;
  }
  assert.equal(layer.getStats().error, 'map tiles failing');
  assert.equal(layer.getStats().tileFailures, TILE_FAILURE_LIMIT + 3);
  assert.equal(notified, 1);
  layer.destroy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/data/species.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./species.js`.

- [ ] **Step 3: Add `setStackedImagery` to `src/data/rasterDrape.js`**

Insert directly after the line `export function _drapeStackForTest() { return _stack; }`:

```js
/** Put a non-drape ImageryLayer into the shared stack at `zrank` (or take it out with null), then restack. */
export function setStackedImagery(imageryLayers, id, layer, zrank = 50) {
  if (layer) _stack.set(id, { layer, zrank });
  else _stack.delete(id);
  return restackDrapes(imageryLayers);
}
```

- [ ] **Step 4: Implement `src/data/species.js`**

```js
import * as Cesium from 'cesium';
import { densityTileTemplate, RADII_KM } from '../bio/gbif.js';
import { setStackedImagery } from './rasterDrape.js';

/**
 * Species map (spec: docs/superpowers/specs/2026-09-13-species-search-design.md): GBIF hexagon tiles for the
 * taxon chosen in the SPECIES panel, CC0 and CC BY records only. Browser-side, so it works on the static host.
 * Joins the shared drape stack at SPECIES_ZRANK so drape refreshes cannot bury it.
 */
export const SPECIES_ZRANK = 1000;
export const SPECIES_ALPHA = 0.7;
export const SPECIES_YEARS = Object.freeze(['recent', 'all']);
export const TILE_FAILURE_LIMIT = 8;
export const DEFAULT_SPECIES_PARAMS = Object.freeze({ taxonKey: null, name: null, years: 'recent', radiusKm: 10 });

/** Merge a params request; null when any supplied value is invalid. A new taxon clears the old name. */
export function mergeSpeciesParams(current, request = {}) {
  const next = { ...current };
  if (Object.hasOwn(request, 'taxonKey')) {
    const key = request.taxonKey;
    if (key !== null && !(Number.isInteger(key) && key > 0)) return null;
    if (key !== next.taxonKey) next.name = null;
    next.taxonKey = key;
  }
  if (Object.hasOwn(request, 'name')) {
    if (request.name !== null && typeof request.name !== 'string') return null;
    next.name = request.name;
  }
  if (Object.hasOwn(request, 'years')) {
    if (!SPECIES_YEARS.includes(request.years)) return null;
    next.years = request.years;
  }
  if (Object.hasOwn(request, 'radiusKm')) {
    if (!RADII_KM.includes(request.radiusKm)) return null;
    next.radiusKm = request.radiusKm;
  }
  return next;
}

export function createSpeciesLayer({
  providerFor = (url) => new Cesium.UrlTemplateImageryProvider({ url, maximumLevel: 14, credit: 'GBIF.org' }),
  imageryLayerFor = (provider, options) => new Cesium.ImageryLayer(provider, options),
  stack = setStackedImagery,
  now = () => new Date(),
} = {}) {
  let _viewer = null;
  let _imagery = null;
  let _enabled = false;
  let _params = { ...DEFAULT_SPECIES_PARAMS };
  let _generation = 0;
  let _tileFailures = 0;
  let _lastError = null;
  let _lastUpdate = null;
  const _statusListeners = new Set();
  const notify = () => { for (const listener of _statusListeners) listener(); };

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, 'species', null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  const rebuild = () => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    if (!_viewer || !_params.taxonKey) return;
    const generation = _generation;
    const provider = providerFor(densityTileTemplate({ taxonKey: _params.taxonKey, years: _params.years, now: now() }));
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = 'map tiles failing';
        console.error('[Data:species] GBIF tiles failing', { taxonKey: _params.taxonKey, years: _params.years, error: tileError?.error ?? tileError });
        notify();
      }
    });
    _imagery = imageryLayerFor(provider, { alpha: SPECIES_ALPHA });
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, 'species', _imagery, SPECIES_ZRANK);
    _lastUpdate = Date.now();
  };

  return {
    id: 'species',
    name: 'Species map (GBIF)',
    icon: '🔎',
    source: 'GBIF.org occurrence maps, CC0 and CC BY records only',
    updateInterval: 0,
    showInTogglePanel: false,

    init(viewer) {
      _viewer = viewer;
      rebuild();
      console.log('[Data:species] Initialized');
    },
    enable() { _enabled = true; if (_imagery) _imagery.show = true; },
    disable() { _enabled = false; if (_imagery) _imagery.show = false; },
    async update() { return true; },
    destroy() { drop(); _viewer = null; },

    setParams(params = {}) {
      const next = mergeSpeciesParams(_params, params);
      if (!next) return false;
      const tilesChanged = next.taxonKey !== _params.taxonKey || next.years !== _params.years;
      _params = next;
      if (tilesChanged) rebuild();
      notify();
      return true;
    },
    getParams() { return { ..._params }; },
    getStats() {
      return { count: _params.taxonKey ? 1 : 0, lastUpdate: _lastUpdate, error: _lastError, tileFailures: _tileFailures };
    },
    /** The SPECIES panel listens here for tile-failure status. */
    onStatus(listener) {
      if (typeof listener !== 'function') return () => {};
      _statusListeners.add(listener);
      return () => _statusListeners.delete(listener);
    },
  };
}

const speciesLayer = createSpeciesLayer();
export default speciesLayer;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test src/data/species.test.mjs src/data/rasterDrape.test.mjs`
Expected: PASS, 0 failures (rasterDrape's existing tests still pass).

- [ ] **Step 6: See the z-order test fail for the stated reason**

In `species.js` temporarily delete the line `stack(_viewer.imageryLayers, 'species', _imagery, SPECIES_ZRANK);`, run `node --test src/data/species.test.mjs`, expect "species tiles stay above the raster drapes" to fail on "species imagery is last"; restore and re-run: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/data/rasterDrape.js src/data/species.js src/data/species.test.mjs
git commit -m "species search: species map layer (GBIF adhoc tiles for one taxon, stacked above the drapes, tile-failure status)"
```

---

### Task 3: Share-link registry, option group and registration

**Files:**
- Modify: `src/data/layerState.js` (registry entry after `satellites`; option group at the end of `OPTION_GROUPS`)
- Modify: `src/data/layerState.test.mjs:158-159` and append two tests
- Modify: `src/main.js` (import after `import ecoregionsLayer from './data/ecoregions.js';`; register after `dataManager.register(arbonetLayer);`)

**Interfaces:**
- Consumes: default export `speciesLayer` from `src/data/species.js` (Task 2).
- Produces: registry entry `{ id: 'species', token: 'sp', disposition: 'enabled+options', optionOwner: 'species' }`; options `{taxonKey: number|null, years: 'recent'|'all', radiusKm: 1|10|50}` persisted from explicit (`origin: 'user'`) `setLayerParams` calls.

- [ ] **Step 1: Write the failing tests**

In `src/data/layerState.test.mjs` change lines 158-159 to:

```js
  assert.equal(REGISTERED_LAYER_IDS.length, 45);
  assert.equal(new Set(REGISTERED_LAYER_IDS).size, 45);
```

Append at the end of the file:

```js
test('species options round-trip through a share link: taxon key, all years, 50 km', () => {
  const state = normalizeLayerState({
    enabledLayerIds: ['species'],
    options: { species: { taxonKey: 5133088, years: 'all', radiusKm: 50 } },
  });
  const query = encode(state);
  assert.match(query, /(^|&)l=sp(&|$)/);
  const decoded = decodeLayerStateParams(new URLSearchParams(query));
  assert.deepEqual(decoded.enabledLayerIds, ['species']);
  assert.deepEqual(decoded.options.species, { taxonKey: 5133088, years: 'all', radiusKm: 50 });
});

test('species defaults stay out of the URL and invalid species values decode to the defaults', () => {
  const state = normalizeLayerState({
    enabledLayerIds: ['species'],
    options: { species: { taxonKey: null, years: 'recent', radiusKm: 10 } },
  });
  assert.doesNotMatch(encode(state), /sp\./);
  const decoded = decodeLayerStateParams(new URLSearchParams('v=2&l=sp&lo=sp.k.-4_sp.y.z_sp.r.7'));
  assert.deepEqual(decoded.options.species, { taxonKey: null, years: 'recent', radiusKm: 10 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/data/layerState.test.mjs`
Expected: FAIL: the registry test reports 44 !== 45; the round-trip test fails because `decoded` is `null` (token `sp` is unknown, so the payload is rejected).

- [ ] **Step 3: Add the registry entry and option group**

In `src/data/layerState.js`, directly after the line
`  Object.freeze({ id: 'satellites', token: 's', disposition: 'enabled+options', optionOwner: 'satellites' }),`
add:

```js
  Object.freeze({ id: 'species', token: 'sp', disposition: 'enabled+options', optionOwner: 'species' }),
```

Replace the end of `OPTION_GROUPS` — the text `  ]),\n});\n\nconst TRACKING_OPTION_KEY_BY_LAYER` — so the new group is its last member:

```js
  ]),
  species: Object.freeze([
    integerOption('taxonKey', 'k', null),
    enumOption('years', 'y', 'recent', ['recent', 'all'], { recent: 'r', all: 'a' }),
    Object.freeze({
      key: 'radiusKm',
      token: 'r',
      defaultValue: 10,
      // Numeric, so not enumOption: its reverse map would decode '50' as the string '50', which the
      // enum then rejects, silently turning every shared 50 km link into 10 km.
      normalize: (value) => ([1, 10, 50].includes(value) ? value : null),
      encode: (value) => String(value),
      decode: (value) => {
        const km = Number(value);
        return [1, 10, 50].includes(km) ? km : null;
      },
    }),
  ]),
});

const TRACKING_OPTION_KEY_BY_LAYER
```

- [ ] **Step 4: Register the layer in `src/main.js`**

After `import ecoregionsLayer from './data/ecoregions.js';` add:

```js
import speciesLayer from './data/species.js';
```

After `    dataManager.register(arbonetLayer);` add:

```js
    dataManager.register(speciesLayer);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test src/data/layerState.test.mjs src/data/manager.test.mjs src/firstRunExperience.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 6: See the radius decode test fail for the stated reason**

Temporarily replace the `radiusKm` spec with `enumOption('radiusKm', 'r', 10, [1, 10, 50], { 1: '1', 10: '10', 50: '50' }),` and run `node --test src/data/layerState.test.mjs`: the round-trip test must fail with `radiusKm: 10` where 50 was expected. Restore; re-run: PASS.

- [ ] **Step 7: Run the full suite and a production build**

Run: `npm test` → Expected: 0 failures.
Run: `VITE_STATIC_HOST=1 npx vite build --base=/wildeye/ --outDir /tmp/wildeye-build-check --emptyOutDir > /dev/null && echo build-ok && rm -rf /tmp/wildeye-build-check` → Expected: `build-ok`.

- [ ] **Step 8: Commit**

```bash
git add src/data/layerState.js src/data/layerState.test.mjs src/main.js
git commit -m "species search: share-link token sp (taxon key, years, radius) and layer registration"
```

---

### Task 4: Shared biology details card

**Files:**
- Create: `src/bio/detailsCard.js`
- Test: `src/bio/detailsCard.test.mjs`
- Modify: `src/main.js` (import; create the card after `    styleManager.attachDataManager(dataManager);`)
- Modify: `style.css` (append card styles)
- Create: `scripts/build-static-preview.sh`, `scripts/qa-species.mjs`
- Modify: `.gitignore` (append `.qa-static/`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `BIO_CARD_LAYER_IDS: Set<string>`; `cardDecision(entity, time?) → {open: false} | {open: true, layerId, html}`
  - `listRows(entries: {key, count, scientificName, commonName, error?}[]) → {key, primary, secondary, count: string, note}[]`
  - `renderListInto(container, rows, doc, onRow)`
  - `createDetailsCard({viewer, layerName, doc}) → {element, mode: 'detail'|'list'|null, close(), showStatus({heading, message, retry?}), showList({heading, filterLine, entries, footer, footerHref, onRow})}`
  - `scripts/qa-species.mjs --url <url> --checks card,search,here,portal --shots <dir>` → one JSON line per check, exit 1 on any failure.

- [ ] **Step 1: Write the failing tests**

Create `src/bio/detailsCard.test.mjs`:

```js
// src/bio/detailsCard.test.mjs — which clicks open the card, that every listed layer id is a real data source,
// and that GBIF strings render as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { BIO_CARD_LAYER_IDS, cardDecision, listRows, renderListInto } from './detailsCard.js';

const entityIn = (layerId, description) => ({
  id: 'e1',
  entityCollection: { owner: { name: layerId } },
  description: description === undefined ? undefined : { getValue: () => description },
});

test('the card opens for a biology marker with details and stays shut for anything else', () => {
  assert.deepEqual(cardDecision(entityIn('occurrences', '<b>Blue whale</b>')), { open: true, layerId: 'occurrences', html: '<b>Blue whale</b>' });
  assert.equal(cardDecision(entityIn('flights', '<b>UAL1</b>')).open, false, 'flights keep their own readout');
  assert.equal(cardDecision(entityIn('occurrences')).open, false, 'no description');
  assert.equal(cardDecision(entityIn('occurrences', '   ')).open, false, 'blank description');
  assert.equal(cardDecision({ id: 'loose', description: { getValue: () => 'x' } }).open, false, 'not in a data source');
  assert.equal(cardDecision(undefined).open, false, 'selection cleared');
});

test('every card layer id is the name of a real data source', () => {
  const dir = new URL('../data/', import.meta.url);
  const names = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    for (const match of readFileSync(new URL(file, dir), 'utf8').matchAll(/new Cesium\.CustomDataSource\(["']([a-z0-9-]+)["']\)/g)) names.add(match[1]);
  }
  for (const id of BIO_CARD_LAYER_IDS) assert.ok(names.has(id), `${id} has no CustomDataSource("${id}") in src/data`);
  assert.equal(BIO_CARD_LAYER_IDS.has('flights'), false);
  assert.equal(BIO_CARD_LAYER_IDS.size, 19);
});

test('list rows put the common name first and format counts', () => {
  assert.deepEqual(listRows([
    { key: 1, count: 3524, scientificName: 'Branta canadensis', commonName: 'Canada Goose' },
    { key: 2, count: 3, scientificName: 'Salix exigua', commonName: null, error: 'HTTP 503' },
  ]), [
    { key: 1, primary: 'Canada Goose', secondary: 'Branta canadensis', count: '3,524', note: '' },
    { key: 2, primary: 'Salix exigua', secondary: '', count: '3', note: 'name lookup failed: HTTP 503' },
  ]);
});

function fakeDoc() {
  const make = (tag) => {
    const el = {
      tag, children: [], listeners: {}, textContent: '', className: '', type: '',
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...kids) { this.children = kids; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
    };
    Object.defineProperty(el, 'innerHTML', { set() { throw new Error('innerHTML used for external strings'); } });
    return el;
  };
  return { createElement: make };
}

test('rows from GBIF render as text, never markup, and a click hands back the row', () => {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  const clicked = [];
  const rows = listRows([{ key: 9, count: 1, scientificName: '<img src=x onerror=alert(1)>', commonName: null }]);
  renderListInto(container, rows, doc, (row) => clicked.push(row.key));
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].className, 'bio-card-row');
  assert.equal(container.children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  container.children[0].listeners.click();
  assert.deepEqual(clicked, [9]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/bio/detailsCard.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./detailsCard.js`.

- [ ] **Step 3: Implement `src/bio/detailsCard.js`**

```js
/**
 * Shared biology details card (spec: docs/superpowers/specs/2026-09-13-species-search-design.md).
 * Cesium's info box is off (src/main.js `infoBox: false`), so until this card the details each biology layer
 * attaches to its entities, citation and licence included, never reached the screen (verified on the live
 * site 2026-09-13). Detail mode shows the clicked entity's description, which the layer builds with escaped
 * fields. List mode shows "what lives here"; GBIF and iNaturalist strings only ever go through textContent.
 */
export const BIO_CARD_LAYER_IDS = new Set([
  'arbonet', 'birds', 'cetaceans', 'drought', 'ecoregions', 'fires', 'fishing', 'gfw', 'h5n1', 'hpai',
  'neon', 'neon-vectors', 'occurrences', 'otn', 'phenology', 'rivers', 'tracks', 'wastewater', 'whispers',
]);

export function cardDecision(entity, time = undefined) {
  const layerId = entity?.entityCollection?.owner?.name;
  if (typeof layerId !== 'string' || !BIO_CARD_LAYER_IDS.has(layerId)) return { open: false };
  const html = entity.description?.getValue?.(time);
  if (typeof html !== 'string' || !html.trim()) return { open: false };
  return { open: true, layerId, html };
}

export function listRows(entries) {
  return entries.map((entry) => ({
    key: entry.key,
    primary: entry.commonName || entry.scientificName,
    secondary: entry.commonName ? entry.scientificName : '',
    count: Number(entry.count).toLocaleString('en-US'),
    note: entry.error ? `name lookup failed: ${entry.error}` : '',
  }));
}

/** Render list rows with textContent only. */
export function renderListInto(container, rows, doc, onRow) {
  container.replaceChildren();
  for (const row of rows) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'bio-card-row';
    for (const [className, text] of [['bio-card-row-primary', row.primary], ['bio-card-row-secondary', row.secondary], ['bio-card-row-count', row.count]]) {
      const span = doc.createElement('span');
      span.className = className;
      span.textContent = text;
      button.appendChild(span);
    }
    if (row.note) {
      const note = doc.createElement('span');
      note.className = 'bio-card-row-note';
      note.textContent = row.note;
      button.appendChild(note);
    }
    button.addEventListener('click', () => onRow(row));
    container.appendChild(button);
  }
}

export function createDetailsCard({ viewer, layerName = (id) => id, doc = document }) {
  const root = doc.createElement('aside');
  root.id = 'bio-card';
  root.className = 'bio-card';
  root.hidden = true;
  root.setAttribute('aria-live', 'polite');
  // Static skeleton only; no data is interpolated here.
  root.innerHTML = '<div class="bio-card-head"><span class="bio-card-title"></span><button type="button" class="bio-card-close" aria-label="Close details">×</button></div><div class="bio-card-filter"></div><div class="bio-card-body"></div><div class="bio-card-foot"></div>';
  const title = root.querySelector('.bio-card-title');
  const filter = root.querySelector('.bio-card-filter');
  const body = root.querySelector('.bio-card-body');
  const foot = root.querySelector('.bio-card-foot');
  let mode = null;

  const reset = (heading) => {
    title.textContent = heading;
    filter.textContent = '';
    body.replaceChildren();
    foot.replaceChildren();
  };
  const close = () => { root.hidden = true; mode = null; };

  viewer.selectedEntityChanged.addEventListener((entity) => {
    try {
      const decision = cardDecision(entity, viewer.clock.currentTime);
      if (!decision.open) {
        if (mode === 'detail') close();
        return;
      }
      reset(layerName(decision.layerId));
      body.innerHTML = decision.html;
      mode = 'detail';
      root.hidden = false;
    } catch (error) {
      console.error('[bio-card] could not render details', { layerId: entity?.entityCollection?.owner?.name ?? null, entityId: entity?.id ?? null, error });
    }
  });
  root.querySelector('.bio-card-close').addEventListener('click', () => {
    const wasDetail = mode === 'detail';
    close();
    if (wasDetail && viewer.selectedEntity) viewer.selectedEntity = undefined;
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) close();
  });

  return {
    element: root,
    get mode() { return mode; },
    close,
    showStatus({ heading, message, retry = null }) {
      reset(heading);
      const text = doc.createElement('p');
      text.className = 'bio-card-status';
      text.textContent = message;
      body.appendChild(text);
      if (retry) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'bio-card-retry';
        button.textContent = 'Retry';
        button.addEventListener('click', () => retry());
        body.appendChild(button);
      }
      mode = 'list';
      root.hidden = false;
    },
    showList({ heading, filterLine, entries, footer, footerHref, onRow }) {
      reset(heading);
      filter.textContent = filterLine;
      renderListInto(body, listRows(entries), doc, onRow);
      const link = doc.createElement('a');
      link.href = footerHref;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = footer;
      foot.appendChild(link);
      mode = 'list';
      root.hidden = false;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/bio/detailsCard.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: See the text-only test fail for the stated reason**

In `renderListInto` temporarily replace `span.textContent = text;` with `span.innerHTML = text;`; run the file; expect the "render as text" test to throw `innerHTML used for external strings`. Restore; PASS.

- [ ] **Step 6: Wire the card in `src/main.js`**

After `import speciesLayer from './data/species.js';` add:

```js
import { createDetailsCard } from './bio/detailsCard.js';
```

After `    styleManager.attachDataManager(dataManager);` add:

```js
    // Biology details card: Cesium's info box is off, so this is where biology markers show their details.
    const bioCard = createDetailsCard({ viewer, layerName: (id) => dataManager.layers.get(id)?.module?.name || id });
    document.body.appendChild(bioCard.element);
```

- [ ] **Step 7: Append card styles to the end of `style.css`**

```css
/* ── Biology details card (src/bio/detailsCard.js) ── */
.bio-card {
  position: fixed;
  right: 24px;
  bottom: 104px;
  z-index: 140;
  width: min(360px, calc(100vw - 48px));
  max-height: 52vh;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--panel-radius);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
  color: var(--text-primary);
  font: 12px/1.45 var(--font-sans);
}
.bio-card[hidden] { display: none; }
.bio-card-head { display: flex; align-items: center; gap: 8px; }
/* No text-transform: uppercase — it maps µ (U+00B5) to M in unit strings. */
.bio-card-title { flex: 1; min-width: 0; font: 10px/1.3 var(--font-mono); letter-spacing: 1px; color: var(--accent); }
.bio-card-close { background: none; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 7px; color: var(--text-secondary); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 8px; }
.bio-card-close:hover { color: var(--accent); border-color: var(--accent); }
.bio-card-filter { color: var(--text-secondary); font-size: 11px; }
.bio-card-filter:empty { display: none; }
.bio-card-body { overflow-y: auto; min-height: 0; }
.bio-card-body a, .bio-card-foot a { color: var(--accent); }
.bio-card-row { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; width: 100%; text-align: left; background: rgba(255, 255, 255, 0.03); border: 1px solid transparent; border-radius: 7px; color: var(--text-primary); cursor: pointer; font: inherit; padding: 5px 8px; margin-bottom: 3px; }
.bio-card-row:hover, .bio-card-row:focus { border-color: var(--accent); background: var(--accent-dim); outline: none; }
.bio-card-row-primary { grid-column: 1; }
.bio-card-row-secondary { grid-column: 1; color: var(--text-secondary); font-style: italic; font-size: 11px; }
.bio-card-row-secondary:empty { display: none; }
.bio-card-row-count { grid-column: 2; grid-row: 1; color: var(--text-secondary); font: 10px/1.6 var(--font-mono); }
.bio-card-row-note { grid-column: 1 / -1; color: #ffb86b; font-size: 11px; }
.bio-card-status { margin: 0 0 6px; color: var(--text-secondary); }
.bio-card-retry { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 7px; color: var(--text-secondary); cursor: pointer; font: 9px var(--font-mono); letter-spacing: 1.2px; padding: 5px 9px; }
.bio-card-foot { font-size: 11px; color: var(--text-secondary); border-top: 1px solid var(--glass-border); padding-top: 6px; }
.bio-card-foot:empty { display: none; }
body.ui-clean-view #bio-card,
body.recording-mode #bio-card { display: none !important; }
```

- [ ] **Step 8: Create `scripts/build-static-preview.sh`**

```bash
#!/usr/bin/env bash
# Build the GitHub Pages flavour into .qa-static/ (same flags and Cesium relocation as
# pipeline/deploy_pages.sh) for local browser checks.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node24/bin:$PATH"
OUT=.qa-static
VITE_STATIC_HOST=1 npx vite build --base=/wildeye/ --outDir "$OUT" --emptyOutDir >/dev/null
if [ -d "$OUT/wildeye/cesium" ]; then
  rm -rf "$OUT/cesium" && mv "$OUT/wildeye/cesium" "$OUT/cesium" && rmdir "$OUT/wildeye" 2>/dev/null || true
fi
[ -f "$OUT/index.html" ] || { echo "build produced no $OUT/index.html" >&2; exit 1; }
echo "built $OUT; serve with: npx vite preview --base /wildeye/ --outDir $OUT --port 4488 --strictPort"
```

Run: `chmod +x scripts/build-static-preview.sh && printf '.qa-static/\n' >> .gitignore`

- [ ] **Step 9: Create `scripts/qa-species.mjs`**

```js
#!/usr/bin/env node
/**
 * qa-species.mjs — real-browser checks for the biology details card, species search and "what lives here".
 * Run: node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ [--checks card,search,here,portal] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const CHECKS = new Set(arg('--checks', 'card,search,here,portal').split(','));
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const requests = [];
const failed = [];
page.on('request', (r) => requests.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400 && !/google|gstatic|cesium\.com/.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => { if (!/google|gstatic|cesium\.com|tile/.test(r.url())) failed.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`); });
page.on('pageerror', (e) => failed.push(`PAGEERROR ${String(e?.message || e).slice(0, 160)}`));
page.on('dialog', (d) => d.dismiss().catch(() => {}));

let bad = 0;
const report = (check, ok, detail = {}) => { if (!ok) bad += 1; console.log(JSON.stringify({ check, ok, ...detail })); };
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flyTo = (lon, lat, height) => page.evaluate(async (lon, lat, height) => {
  const viewer = window.__godsEyeView.viewer;
  const Cartesian3 = viewer.camera.position.constructor;
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 5000));
}, lon, lat, height);

await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
await sleep(12000);
await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
await page.keyboard.press('Escape');

if (CHECKS.has('card')) {
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('occurrences', true, { origin: 'user' }));
  await page.waitForFunction(() => {
    const viewer = window.__godsEyeView.viewer;
    for (let i = 0; i < viewer.dataSources.length; i += 1) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === 'occurrences' && ds.entities.values.some((e) => e.show)) return true;
    }
    return false;
  }, { timeout: 90000 });
  const target = await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    let ds = null;
    for (let i = 0; i < viewer.dataSources.length; i += 1) if (viewer.dataSources.get(i).name === 'occurrences') ds = viewer.dataSources.get(i);
    const entity = ds.entities.values.find((e) => e.show);
    await viewer.zoomTo(entity);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const time = viewer.clock.currentTime;
    const canvasXY = viewer.scene.cartesianToCanvasCoordinates(entity.position.getValue(time));
    const rect = viewer.scene.canvas.getBoundingClientRect();
    return { id: entity.id, name: entity.properties.name.getValue(time), x: rect.left + canvasXY.x, y: rect.top + canvasXY.y };
  });
  await page.mouse.click(target.x, target.y);
  await sleep(2500);
  const card = await page.evaluate(() => {
    const el = document.getElementById('bio-card');
    return el ? { visible: !el.hidden && el.getBoundingClientRect().width > 0, text: el.innerText } : null;
  });
  await shot('card');
  report('card', Boolean(card?.visible) && card.text.includes(target.name) && /CC0|CC[ -]BY/i.test(card.text), { entity: target.id, name: target.name, card: card && { visible: card.visible, text: card.text.slice(0, 240) } });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('occurrences', false, { origin: 'user' }));
}

if (CHECKS.has('search')) {
  await page.evaluate(() => {
    const panel = document.getElementById('species-panel');
    if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
  });
  await sleep(800);
  requests.length = 0;
  await page.click('#species-search');
  await page.type('#species-search', 'monarch', { delay: 40 });
  await page.waitForFunction(() => document.querySelectorAll('#species-suggestions button').length > 0, { timeout: 20000 });
  const first = await page.evaluate(() => document.querySelector('#species-suggestions button').textContent);
  await page.click('#species-suggestions button');
  await page.waitForFunction(() => window.__godsEyeView.dataManager.isEnabled('species'), { timeout: 20000 });
  await flyTo(-90, 30, 12_000_000);
  await sleep(6000);
  const tiles = requests.filter((u) => u.includes('/v2/map/occurrence/'));
  const filtered = tiles.filter((u) => {
    const q = new URL(u).searchParams;
    return u.includes('/v2/map/occurrence/adhoc/') && q.getAll('license').includes('CC0_1_0') && q.getAll('license').includes('CC_BY_4_0') && q.get('taxonKey') === '5133088';
  });
  const params = await page.evaluate(() => window.__godsEyeView.dataManager.getLayerParams('species'));
  await shot('search');
  report('search', first.startsWith('Monarch') && params?.taxonKey === 5133088 && tiles.length > 0 && filtered.length === tiles.length, { first, params, tiles: tiles.length, adhocWithBothLicences: filtered.length, sample: tiles[0] || null });
}

let hereLink = null;
let hereTotal = null;
if (CHECKS.has('here')) {
  await flyTo(-110.83, 44.46, 40_000);
  await page.click('#species-what-lives-here');
  const center = await page.evaluate(() => {
    const rect = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(center.x, center.y);
  await page.waitForFunction(() => document.querySelectorAll('#bio-card .bio-card-row').length > 0 || /failed|No CC0/.test(document.getElementById('bio-card')?.innerText || ''), { timeout: 45000 });
  const result = await page.evaluate(() => ({
    rows: document.querySelectorAll('#bio-card .bio-card-row').length,
    filter: document.querySelector('#bio-card .bio-card-filter')?.textContent || '',
    text: document.getElementById('bio-card').innerText.slice(0, 400),
    link: document.querySelector('#bio-card .bio-card-foot a')?.href || null,
  }));
  hereLink = result.link;
  hereTotal = Number((result.filter.match(/([\d,]+) records/) || [])[1]?.replace(/,/g, '') || Number.NaN);
  await shot('what-lives-here');
  report('here', result.rows >= 1 && Boolean(result.link), result);
}

if (CHECKS.has('portal') && hereLink && Number.isFinite(hereTotal)) {
  const portal = await browser.newPage();
  await portal.goto(hereLink, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(5000);
  const text = await portal.evaluate(() => document.body.innerText);
  const expected = hereTotal.toLocaleString('en-US');
  report('portal', text.includes(expected), { link: hereLink, expected, pageSample: text.slice(0, 300) });
  await portal.close();
}

report('no-failed-requests', failed.length === 0, { failed: [...new Set(failed)].slice(0, 10) });
await browser.close();
process.exit(bad ? 1 : 0);
```

- [ ] **Step 10: Real-browser check of the card on the static build**

```bash
bash scripts/build-static-preview.sh
npx vite preview --base /wildeye/ --outDir .qa-static --port 4488 --strictPort &   # background server
HEAVY_RUN_MEM=10G heavy-run node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ --checks card --shots .qa-static/shots
```

Expected: `{"check":"card","ok":true,...}` with the clicked sighting's name in `card.text`, and `{"check":"no-failed-requests","ok":true,...}`. This is the check that failed on the live site before this task (clicking `occ:blue-whale:2026-09-01:0` showed nothing). Stop the preview server afterwards (kill it by the PID printed by `ss -ltnp | grep 4488`).

- [ ] **Step 11: Run the full suite**

Run: `npm test` → Expected: 0 failures.

- [ ] **Step 12: Commit**

```bash
git add src/bio/detailsCard.js src/bio/detailsCard.test.mjs src/main.js style.css scripts/build-static-preview.sh scripts/qa-species.mjs .gitignore
git commit -m "biology details card: clicking a biology marker shows its details, citation and licence (Cesium's info box is off, so nothing was shown before); local Pages build script and qa-species browser checks"
```

---

### Task 5: "What lives here" controller

**Files:**
- Create: `src/bio/whatLivesHere.js`
- Test: `src/bio/whatLivesHere.test.mjs`

**Interfaces:**
- Consumes: `gbifPortalUrl`, `yearLabel` (Task 1); a `card` with `showStatus` / `showList` (Task 4); a client with `speciesNear` / `speciesName` (Task 1).
- Produces:
  - `HEADING = 'What lives here'`; `classifyClick({picked, position}) → 'entity'|'sky'|'ground'`
  - `createWhatLivesHere({viewer, client, card, getParams: () => ({years, radiusKm}), onPickSpecies: ({taxonKey, name}) => void, onArmedChange?, handlerFor?, doc?}) → {armed: boolean, arm(), disarm(), handleClick(event) → Promise|null, destroy()}`

- [ ] **Step 1: Write the failing tests**

Create `src/bio/whatLivesHere.test.mjs`:

```js
// src/bio/whatLivesHere.test.mjs — arm-then-click: marker clicks stay normal, sky keeps it armed,
// a ground click sends exactly one GBIF search and lists the species.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { classifyClick, createWhatLivesHere, HEADING } from './whatLivesHere.js';

const YELLOWSTONE = Cesium.Cartesian3.fromDegrees(-110.83, 44.46);
const CLICK = { position: { x: 1, y: 1 } };

function rig({ picked = undefined, ground = YELLOWSTONE, near = { total: 5, species: [{ key: 5232437, count: 5 }] }, nearError = null } = {}) {
  const calls = { near: [], names: [], status: [], list: [], picked: [], armed: [] };
  const viewer = {
    scene: { canvas: { style: {} }, pick: () => picked, pickPositionSupported: false, pickPosition: () => undefined, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    camera: { pickEllipsoid: () => ground },
  };
  const client = {
    speciesNear: async (args) => { calls.near.push(args); if (nearError) throw nearError; return near; },
    speciesName: async (key) => { calls.names.push(key); return { key, scientificName: 'Branta canadensis', commonName: 'Canada Goose' }; },
  };
  const card = { showStatus: (s) => calls.status.push(s), showList: (l) => calls.list.push(l) };
  const controller = createWhatLivesHere({
    viewer,
    client,
    card,
    getParams: () => ({ years: 'recent', radiusKm: 10 }),
    onPickSpecies: (p) => calls.picked.push(p),
    onArmedChange: (on) => calls.armed.push(on),
    handlerFor: () => ({ setInputAction() {}, destroy() {} }),
    doc: { addEventListener() {} },
  });
  return { controller, calls, viewer };
}

test('classifyClick: marker, sky, ground', () => {
  assert.equal(classifyClick({ picked: { id: 'occ:1' }, position: YELLOWSTONE }), 'entity');
  assert.equal(classifyClick({ picked: { primitive: {} }, position: YELLOWSTONE }), 'ground', 'a pick without an id (terrain, 3D tiles) is ground');
  assert.equal(classifyClick({ picked: undefined, position: null }), 'sky');
  assert.equal(classifyClick({ picked: undefined, position: YELLOWSTONE }), 'ground');
});

test('unarmed clicks do nothing; a marker click sends no query and stays armed', () => {
  const { controller, calls } = rig({ picked: { id: 'occ:blue-whale:2026-09-01:0' } });
  assert.equal(controller.handleClick(CLICK), null);
  controller.arm();
  assert.equal(controller.handleClick(CLICK), null);
  assert.equal(calls.near.length, 0);
  assert.equal(controller.armed, true);
});

test('a ground click sends exactly one GBIF search at the clicked point and lists the names', async () => {
  const { controller, calls, viewer } = rig();
  controller.arm();
  assert.equal(viewer.scene.canvas.style.cursor, 'crosshair');
  assert.deepEqual(calls.armed, [true]);
  await controller.handleClick(CLICK);
  assert.equal(calls.near.length, 1);
  assert.equal(calls.near[0].radiusKm, 10);
  assert.equal(calls.near[0].years, 'recent');
  assert.ok(Math.abs(calls.near[0].lat - 44.46) < 1e-6 && Math.abs(calls.near[0].lon + 110.83) < 1e-6);
  assert.equal(controller.armed, false);
  assert.equal(viewer.scene.canvas.style.cursor, '');
  assert.equal(calls.list.length, 1);
  const list = calls.list[0];
  assert.equal(list.heading, HEADING);
  assert.match(list.filterLine, /^CC0 and CC BY records · \d{4}–\d{4} · within 10 km · 5 records$/);
  assert.match(list.footerHref, /^https:\/\/www\.gbif\.org\/occurrence\/search\?/);
  assert.equal(list.footer, 'Occurrence data: GBIF.org, CC0 and CC BY records only');
  assert.deepEqual(list.entries, [{ key: 5232437, count: 5, scientificName: 'Branta canadensis', commonName: 'Canada Goose', error: undefined }]);
  list.onRow({ key: 5232437, primary: 'Canada Goose' });
  assert.deepEqual(calls.picked, [{ taxonKey: 5232437, name: 'Canada Goose' }]);
  assert.equal(controller.handleClick(CLICK), null, 'one query per arming');
  assert.equal(calls.near.length, 1);
});

test('sky keeps it armed; zero records and failures are different messages', async () => {
  const sky = rig({ ground: null });
  sky.controller.arm();
  assert.equal(sky.controller.handleClick(CLICK), null);
  assert.equal(sky.controller.armed, true);
  assert.match(sky.calls.status.at(-1).message, /Click on the globe/);

  const empty = rig({ near: { total: 0, species: [] } });
  empty.controller.arm();
  await empty.controller.handleClick(CLICK);
  assert.match(empty.calls.status.at(-1).message, /^No CC0\/CC BY records within 10 km for \d{4}–\d{4}\. Try a larger radius or all years\.$/);
  assert.equal(empty.calls.list.length, 0);

  const down = rig({ nearError: new Error('HTTP 503') });
  down.controller.arm();
  const originalError = console.error;
  console.error = () => {};
  try {
    await down.controller.handleClick(CLICK);
  } finally {
    console.error = originalError;
  }
  const failure = down.calls.status.at(-1);
  assert.equal(failure.message, 'GBIF search failed (HTTP 503)');
  assert.equal(typeof failure.retry, 'function');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/bio/whatLivesHere.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./whatLivesHere.js`.

- [ ] **Step 3: Implement `src/bio/whatLivesHere.js`**

```js
import * as Cesium from 'cesium';
import { gbifPortalUrl, yearLabel } from './gbif.js';

/**
 * "What lives here" (spec: docs/superpowers/specs/2026-09-13-species-search-design.md). The SPECIES panel
 * arms a one-shot click. A click on the ground lists the 20 species with the most CC0 and CC BY GBIF records
 * within the chosen radius. A click on a marker is left to the normal click; a click on the sky stays armed.
 */
export const HEADING = 'What lives here';

export function classifyClick({ picked, position }) {
  if (picked && picked.id !== undefined && picked.id !== null) return 'entity';
  if (!position) return 'sky';
  return 'ground';
}

export function createWhatLivesHere({
  viewer,
  client,
  card,
  getParams,
  onPickSpecies,
  onArmedChange = () => {},
  handlerFor = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  doc = document,
}) {
  let armed = false;
  let controller = null;

  const setArmed = (value) => {
    if (armed === value) return;
    armed = value;
    viewer.scene.canvas.style.cursor = value ? 'crosshair' : '';
    onArmedChange(value);
  };

  const groundAt = (windowPosition) => {
    const scene = viewer.scene;
    let cartesian = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
    if (!cartesian) cartesian = viewer.camera.pickEllipsoid(windowPosition, scene.globe.ellipsoid);
    return cartesian || null;
  };

  async function run(lat, lon) {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const { years, radiusKm } = getParams();
    card.showStatus({ heading: HEADING, message: `Searching GBIF within ${radiusKm} km…` });
    try {
      const near = await client.speciesNear({ lat, lon, radiusKm, years }, { signal });
      if (near.species.length === 0) {
        card.showStatus({ heading: HEADING, message: `No CC0/CC BY records within ${radiusKm} km for ${yearLabel(years)}. Try a larger radius or all years.` });
        return near;
      }
      const names = await Promise.all(near.species.map((s) => client.speciesName(s.key, { signal }).catch((error) => {
        if (error?.name === 'AbortError') throw error;
        console.error('[what-lives-here] name lookup failed', { key: s.key, error });
        return { key: s.key, scientificName: `GBIF taxon ${s.key}`, commonName: null, error: error.message };
      })));
      card.showList({
        heading: HEADING,
        filterLine: `CC0 and CC BY records · ${yearLabel(years)} · within ${radiusKm} km · ${near.total.toLocaleString('en-US')} records`,
        entries: near.species.map((s, i) => ({ key: s.key, count: s.count, scientificName: names[i].scientificName, commonName: names[i].commonName, error: names[i].error })),
        footer: 'Occurrence data: GBIF.org, CC0 and CC BY records only',
        footerHref: gbifPortalUrl({ lat, lon, radiusKm, years }),
        onRow: (row) => onPickSpecies({ taxonKey: row.key, name: row.primary }),
      });
      return near;
    } catch (error) {
      if (error?.name === 'AbortError') return null;
      console.error('[what-lives-here] GBIF search failed', { lat, lon, radiusKm, years, error });
      card.showStatus({ heading: HEADING, message: `GBIF search failed (${error.message})`, retry: () => run(lat, lon) });
      return null;
    }
  }

  /** One canvas click. Returns the query promise for a ground click while armed, else null. */
  function handleClick(event) {
    if (!armed) return null;
    const picked = viewer.scene.pick(event.position);
    const position = groundAt(event.position);
    const kind = classifyClick({ picked, position });
    if (kind === 'entity') return null;
    if (kind === 'sky') {
      card.showStatus({ heading: HEADING, message: 'Click on the globe, not the sky.' });
      return null;
    }
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    setArmed(false);
    return run(Cesium.Math.toDegrees(cartographic.latitude), Cesium.Math.toDegrees(cartographic.longitude));
  }

  const handler = handlerFor(viewer.scene.canvas);
  handler.setInputAction((event) => { void handleClick(event); }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && armed) setArmed(false);
  });

  return {
    get armed() { return armed; },
    arm() {
      setArmed(true);
      card.showStatus({ heading: HEADING, message: 'Click a spot on the globe. Esc cancels.' });
    },
    disarm() { setArmed(false); },
    handleClick,
    destroy() { handler.destroy(); controller?.abort(); },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/bio/whatLivesHere.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: See the one-query test fail for the stated reason**

Temporarily delete `setArmed(false);` inside `handleClick`; run the file; expect "a ground click sends exactly one GBIF search" to fail at `controller.armed` still `true`. Restore; PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bio/whatLivesHere.js src/bio/whatLivesHere.test.mjs
git commit -m "what lives here: arm-then-click controller (marker clicks stay normal, sky stays armed, one GBIF radius search per arming, distinct no-records and failure messages)"
```

---

### Task 6: SPECIES panel, wiring, credits

**Files:**
- Create: `src/bio/speciesPanel.js`
- Test: `src/bio/speciesPanel.test.mjs`
- Modify: `index.html` (after the scene panel), `style.css` (append), `src/ui.js` (`COCKPIT_ENTRY_COLLAPSE_PANEL_IDS`), `src/main.js`, `src/data/dataCredits.js`, `DATA_SOURCES.md`

**Interfaces:**
- Consumes: `createBioClient` (Task 1); `speciesLayer`, `DEFAULT_SPECIES_PARAMS` (Task 2); `bioCard` (Task 4); `createWhatLivesHere` (Task 5); `dataManager.getLayerParams(id)`, `setLayerParams(id, params, {origin}) → boolean`, `isEnabled(id)`, `setEnabled(id, on, {origin}) → Promise`, `subscribe(fn)`.
- Produces: `MIN_QUERY_LENGTH = 3`, `SUGGEST_DEBOUNCE_MS = 300`, `suggestionText(item) → string`, `createSpeciesPanel({doc, dataManager, speciesLayer, client, whatLivesHere, setTimer, clearTimer}) → {choose(item) → Promise<boolean>, chooseTaxon({taxonKey, name}) → Promise<true>, render()}`.

- [ ] **Step 1: Write the failing tests**

Create `src/bio/speciesPanel.test.mjs`:

```js
// src/bio/speciesPanel.test.mjs — choosing a species, suggestion text, and the markup / CSS / startup wiring pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpeciesPanel, suggestionText } from './speciesPanel.js';
import { DATA_CREDITS } from '../data/dataCredits.js';

function fakeElement() {
  return {
    textContent: '', hidden: false, value: '', attrs: {}, listeners: {}, children: [], dataset: {}, type: '', className: '',
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children = kids; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}

const PANEL_IDS = ['species-search', 'species-suggestions', 'species-status', 'species-chosen', 'species-chosen-name', 'species-toggle', 'species-years', 'species-radius', 'species-what-lives-here'];

function panelRig({ match = async () => 5133088 } = {}) {
  const els = Object.fromEntries(PANEL_IDS.map((id) => [id, fakeElement()]));
  const doc = { getElementById: (id) => els[id] || null, createElement: () => fakeElement() };
  let params = { taxonKey: null, name: null, years: 'recent', radiusKm: 10 };
  let enabled = false;
  const calls = { params: [], enable: [], match: [] };
  const dataManager = {
    getLayerParams: () => ({ ...params }),
    setLayerParams: (id, p, options) => { calls.params.push({ id, p, origin: options.origin }); params = { ...params, ...p }; return true; },
    isEnabled: () => enabled,
    setEnabled: async (id, on, options) => { calls.enable.push({ id, on, origin: options.origin }); enabled = on; return true; },
    subscribe: () => () => {},
  };
  const speciesLayer = { getStats: () => ({ error: null, tileFailures: 0 }), onStatus: () => () => {} };
  const client = {
    match: async (name) => { calls.match.push(name); return match(name); },
    speciesName: async (key) => ({ key, scientificName: 'x', commonName: null }),
    suggest: async () => ({ source: 'none', items: [] }),
  };
  const whatLivesHere = { armed: false, arm() {}, disarm() {} };
  const panel = createSpeciesPanel({ doc, dataManager, speciesLayer, client, whatLivesHere, setTimer: () => 0, clearTimer: () => {} });
  return { panel, els, calls };
}

test('choosing an iNaturalist suggestion matches it in GBIF, sets the taxon and turns the map on', async () => {
  const { panel, els, calls } = panelRig();
  assert.equal(await panel.choose({ gbifKey: null, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' }), true);
  assert.deepEqual(calls.match, ['Danaus plexippus']);
  assert.deepEqual(calls.params.at(-1), { id: 'species', p: { taxonKey: 5133088, name: 'Monarch' }, origin: 'user' });
  assert.deepEqual(calls.enable, [{ id: 'species', on: true, origin: 'user' }]);
  assert.equal(els['species-chosen-name'].textContent, 'Monarch');
  assert.equal(els['species-toggle'].textContent, 'MAP ON');
});

test('a GBIF suggestion skips the match; a name GBIF lacks says so and changes nothing', async () => {
  const direct = panelRig();
  await direct.panel.choose({ gbifKey: 6223161, scientificName: 'Danaus plexaure', commonName: null, rank: 'species' });
  assert.deepEqual(direct.calls.match, []);
  assert.equal(direct.calls.params.at(-1).p.taxonKey, 6223161);

  const missing = panelRig({ match: async () => null });
  assert.equal(await missing.panel.choose({ gbifKey: null, scientificName: 'Nonexistus fakeus', commonName: null, rank: 'species' }), false);
  assert.equal(missing.els['species-status'].textContent, 'Nonexistus fakeus is not in GBIF.');
  assert.equal(missing.calls.params.length, 0);
  assert.equal(missing.calls.enable.length, 0);
});

test('suggestion text puts the common name first', () => {
  assert.equal(suggestionText({ commonName: 'Monarch', scientificName: 'Danaus plexippus', rank: 'species' }), 'Monarch · Danaus plexippus (species)');
  assert.equal(suggestionText({ commonName: null, scientificName: 'Danaus plexaure', rank: 'species' }), 'Danaus plexaure (species)');
});

test('SPECIES panel markup, CSS, Cockpit collapse, startup wiring and credits are in place', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  const stack = html.slice(html.indexOf('<div id="left-panel-stack">'), html.indexOf('<!-- Global Context is deliberately'));
  assert.match(stack, /<div id="species-panel" class="panel-collapsible collapsed" data-panel-id="species-panel">/);
  for (const id of PANEL_IDS) assert.match(stack, new RegExp(`id="${id}"`), id);
  assert.match(stack, /data-collapse-target="species-panel"/);
  assert.doesNotMatch(stack.slice(stack.indexOf('id="species-panel"')), /data-requires-backend/, 'species search works on the static host');
  assert.match(css, /#left-panel-stack > #species-panel \{[^}]*order: 5;/);
  assert.match(css, /body\.cockpit-mode #left-panel-stack > #species-panel \{ display: none !important; \}/);
  assert.match(css, /#species-panel\.collapsed \.species-body \{ display: none !important; \}/);
  assert.match(css, /\.species-suggestions\[hidden\] \{ display: none; \}/);
  assert.match(main, /dataManager\.register\(speciesLayer\);/);
  assert.match(main, /createDetailsCard\(\{/);
  assert.match(main, /createWhatLivesHere\(\{/);
  assert.match(main, /createSpeciesPanel\(\{/);
  const cockpit = ui.match(/const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.match(cockpit[1], /'species-panel'/);
  const credit = DATA_CREDITS.find((entry) => entry.key === 'species');
  assert.ok(credit && /GBIF\.org/.test(credit.html) && /iNaturalist/.test(credit.html) && /CC0 and CC BY/.test(credit.html));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/bio/speciesPanel.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./speciesPanel.js`.

- [ ] **Step 3: Implement `src/bio/speciesPanel.js`**

```js
/**
 * SPECIES panel (spec: docs/superpowers/specs/2026-09-13-species-search-design.md): name search with
 * suggestions, the chosen species with a map switch, year and radius chips, and the "What lives here" button.
 */
export const MIN_QUERY_LENGTH = 3;
export const SUGGEST_DEBOUNCE_MS = 300;

export function suggestionText(item) {
  return `${item.commonName ? `${item.commonName} · ` : ''}${item.scientificName} (${item.rank})`;
}

export function createSpeciesPanel({ doc = document, dataManager, speciesLayer, client, whatLivesHere, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const el = (id) => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`SPECIES panel: #${id} is missing from index.html`);
    return node;
  };
  const input = el('species-search');
  const list = el('species-suggestions');
  const status = el('species-status');
  const chosen = el('species-chosen');
  const chosenName = el('species-chosen-name');
  const toggle = el('species-toggle');
  const yearChips = el('species-years');
  const radiusChips = el('species-radius');
  const armButton = el('species-what-lives-here');
  let timer = null;
  let suggestAbort = null;
  let chooseAbort = null;
  let lookingUpKey = null;

  const params = () => dataManager.getLayerParams('species') || { taxonKey: null, name: null, years: 'recent', radiusKm: 10 };

  function render() {
    const p = params();
    const on = dataManager.isEnabled('species');
    chosen.hidden = !p.taxonKey;
    chosenName.textContent = p.name || (p.taxonKey ? `GBIF taxon ${p.taxonKey}` : '');
    if (p.taxonKey && !p.name && lookingUpKey !== p.taxonKey) {
      // A share link carries only the key; look the name up once.
      lookingUpKey = p.taxonKey;
      client.speciesName(p.taxonKey).then((found) => {
        const current = params();
        if (current.taxonKey === found.key && !current.name) {
          dataManager.setLayerParams('species', { name: found.commonName || found.scientificName }, { origin: 'programmatic' });
        }
      }, (error) => {
        console.error('[species] name lookup failed', { taxonKey: p.taxonKey, error });
        status.textContent = `GBIF name lookup failed (${error.message})`;
      });
    }
    toggle.textContent = on ? 'MAP ON' : 'MAP OFF';
    toggle.setAttribute('aria-pressed', String(on));
    for (const chip of yearChips.querySelectorAll('[data-years]')) chip.setAttribute('aria-pressed', String(chip.dataset.years === p.years));
    for (const chip of radiusChips.querySelectorAll('[data-radius]')) chip.setAttribute('aria-pressed', String(Number(chip.dataset.radius) === p.radiusKm));
    const stats = speciesLayer.getStats();
    if (stats.error) status.textContent = `GBIF ${stats.error} (${stats.tileFailures} tile errors)`;
    armButton.setAttribute('aria-pressed', String(whatLivesHere.armed));
    armButton.textContent = whatLivesHere.armed ? 'CLICK THE GLOBE · ESC CANCELS' : 'WHAT LIVES HERE';
  }

  function clearSuggestions() {
    list.replaceChildren();
    list.hidden = true;
  }

  function showSuggestions(result) {
    list.replaceChildren();
    status.textContent = result.notice || '';
    for (const item of result.items) {
      const li = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'species-suggestion';
      button.textContent = suggestionText(item);
      button.addEventListener('click', () => { void choose(item); });
      li.appendChild(button);
      list.appendChild(li);
    }
    list.hidden = result.items.length === 0;
    if (result.items.length === 0 && result.source !== 'none') status.textContent = `No names match "${input.value.trim()}".`;
  }

  async function requestSuggestions() {
    const query = input.value.trim();
    suggestAbort?.abort();
    if (query.length < MIN_QUERY_LENGTH) {
      clearSuggestions();
      return;
    }
    suggestAbort = new AbortController();
    try {
      showSuggestions(await client.suggest(query, { signal: suggestAbort.signal }));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error('[species] name search failed', { query, error });
      clearSuggestions();
      status.textContent = `Name search failed (${error.message})`;
    }
  }

  /** Put a GBIF taxon on the map. Used by suggestions and by "what lives here" rows. */
  async function chooseTaxon({ taxonKey, name }) {
    if (!dataManager.setLayerParams('species', { taxonKey, name }, { origin: 'user' })) {
      throw new Error(`species layer rejected taxon ${taxonKey}`);
    }
    if (!dataManager.isEnabled('species')) await dataManager.setEnabled('species', true, { origin: 'user' });
    render();
    return true;
  }

  async function choose(item) {
    chooseAbort?.abort();
    chooseAbort = new AbortController();
    clearSuggestions();
    status.textContent = `Looking up ${item.scientificName} in GBIF…`;
    try {
      const taxonKey = item.gbifKey ?? await client.match(item.scientificName, { signal: chooseAbort.signal });
      if (!taxonKey) {
        status.textContent = `${item.scientificName} is not in GBIF.`;
        return false;
      }
      await chooseTaxon({ taxonKey, name: item.commonName || item.scientificName });
      input.value = '';
      status.textContent = '';
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
      console.error('[species] could not choose species', { item, error });
      status.textContent = `GBIF lookup failed (${error.message})`;
      return false;
    }
  }

  input.addEventListener('input', () => {
    clearTimer(timer);
    timer = setTimer(() => { void requestSuggestions(); }, SUGGEST_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') list.querySelector('button')?.click();
    if (event.key === 'Escape') clearSuggestions();
  });
  toggle.addEventListener('click', () => {
    void dataManager.setEnabled('species', !dataManager.isEnabled('species'), { origin: 'user' }).then(render);
  });
  yearChips.addEventListener('click', (event) => {
    const chip = event.target?.closest?.('[data-years]');
    if (!chip) return;
    dataManager.setLayerParams('species', { years: chip.dataset.years }, { origin: 'user' });
    render();
  });
  radiusChips.addEventListener('click', (event) => {
    const chip = event.target?.closest?.('[data-radius]');
    if (!chip) return;
    dataManager.setLayerParams('species', { radiusKm: Number(chip.dataset.radius) }, { origin: 'user' });
    render();
  });
  armButton.addEventListener('click', () => {
    if (whatLivesHere.armed) whatLivesHere.disarm();
    else whatLivesHere.arm();
    render();
  });
  dataManager.subscribe((change) => { if (change?.layerId === 'species') render(); });
  speciesLayer.onStatus(render);
  render();

  return { choose, chooseTaxon, render };
}
```

- [ ] **Step 4: Add the panel markup to `index.html`**

Directly after the scene panel's last lines — the text `      <div id="scene-status">Ready</div>\n    </div>\n  </div>\n` — insert:

```html

  <!-- Species search: any GBIF species on the map, and what has been recorded around a clicked point -->
  <div id="species-panel" class="panel-collapsible collapsed" data-panel-id="species-panel">
    <div class="panel-glow"></div>
    <div class="species-panel-inner">
      <div class="panel-header">
        <span class="panel-title">SPECIES</span>
        <span class="panel-divider"></span>
        <button class="panel-collapse-btn" data-collapse-target="species-panel" title="Collapse panel">+</button>
      </div>
      <div class="species-body">
        <label class="species-label" for="species-search">Find a species</label>
        <input type="search" id="species-search" placeholder="monarch, humpback, red maple…" autocomplete="off" spellcheck="false" />
        <ul id="species-suggestions" class="species-suggestions" aria-label="Species suggestions" hidden></ul>
        <div id="species-status" class="species-status" role="status" aria-live="polite"></div>
        <div id="species-chosen" class="species-chosen" hidden>
          <span id="species-chosen-name" class="species-chosen-name"></span>
          <button type="button" id="species-toggle" class="scene-btn species-chip" aria-pressed="false">MAP OFF</button>
        </div>
        <div id="species-years" class="species-chip-row" role="group" aria-label="Years">
          <button type="button" class="scene-btn species-chip" data-years="recent" aria-pressed="true">LAST 10 YEARS</button>
          <button type="button" class="scene-btn species-chip" data-years="all" aria-pressed="false">ALL YEARS</button>
        </div>
        <div id="species-radius" class="species-chip-row" role="group" aria-label="Radius for what lives here">
          <button type="button" class="scene-btn species-chip" data-radius="1" aria-pressed="false">1 KM</button>
          <button type="button" class="scene-btn species-chip" data-radius="10" aria-pressed="true">10 KM</button>
          <button type="button" class="scene-btn species-chip" data-radius="50" aria-pressed="false">50 KM</button>
        </div>
        <button type="button" id="species-what-lives-here" class="scene-btn species-action" aria-pressed="false">WHAT LIVES HERE</button>
        <p class="species-credit">Names: iNaturalist · Records: GBIF.org (CC0 and CC BY only)</p>
      </div>
    </div>
  </div>
```

- [ ] **Step 5: Append panel styles to the end of `style.css`**

```css
/* ── SPECIES panel (src/bio/speciesPanel.js) ── */
#left-panel-stack > #species-panel {
  --panel-expanded-width: 320px;
  position: relative;
  top: auto;
  right: auto;
  bottom: auto;
  left: auto;
  z-index: auto;
  width: var(--panel-expanded-width);
  max-height: none;
  flex: 0 0 auto;
  min-height: 0;
  pointer-events: auto;
  order: 5;
}
#left-panel-stack > #species-panel:not(.collapsed) {
  box-sizing: border-box;
  flex: 0 1 var(--left-panel-allocated-height, auto);
  height: var(--left-panel-allocated-height, auto);
  max-height: var(--left-panel-allocated-height, 100%);
}
#left-panel-stack.layout-tail > #species-panel:not(.collapsed) {
  flex: 0 0 var(--left-panel-allocated-height);
  height: var(--left-panel-allocated-height);
  max-height: var(--left-panel-allocated-height);
}
#species-panel .panel-glow {
  position: absolute;
  inset: -18px;
  background: radial-gradient(ellipse at center, rgba(0, 212, 255, 0.16) 0%, transparent 65%);
  filter: blur(16px);
  opacity: 0.25;
  pointer-events: none;
}
.species-panel-inner {
  position: relative;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--panel-radius);
  padding: 14px;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 24px);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03) inset, 0 1px 0 rgba(255, 255, 255, 0.06) inset;
}
#left-panel-stack > #species-panel:not(.collapsed) .species-panel-inner { height: 100%; max-height: 100%; overflow-y: auto; scrollbar-gutter: stable; }
.species-body { display: flex; flex-direction: column; gap: 8px; }
.species-label { color: var(--text-secondary); font: 9px var(--font-mono); letter-spacing: 1.2px; }
#species-search { background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 7px; color: var(--text-primary); padding: 6px 8px; font: 12px var(--font-sans); }
#species-search:focus { outline: none; border-color: var(--accent); }
.species-suggestions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.species-suggestions[hidden] { display: none; }
.species-suggestion { width: 100%; text-align: left; background: rgba(255, 255, 255, 0.03); border: 1px solid transparent; border-radius: 7px; color: var(--text-primary); cursor: pointer; font: 12px var(--font-sans); padding: 5px 8px; }
.species-suggestion:hover, .species-suggestion:focus { border-color: var(--accent); background: var(--accent-dim); outline: none; }
.species-status { color: var(--text-secondary); font-size: 11px; }
.species-status:empty { display: none; }
.species-chosen { display: flex; align-items: center; gap: 8px; }
.species-chosen[hidden] { display: none; }
.species-chosen-name { flex: 1; min-width: 0; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.species-chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
.species-chip[aria-pressed="true"], .species-action[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.species-credit { margin: 0; color: var(--text-dim); font-size: 10px; }
#species-panel.collapsed { width: var(--left-collapsed-width); }
#species-panel.collapsed .species-body { display: none !important; }
#species-panel.collapsed .panel-title { font-size: 8px; letter-spacing: 1.8px; }
#species-panel.collapsed .species-panel-inner { padding-bottom: 10px; }
#species-panel.collapsed .panel-header { margin-bottom: 2px; }
body.cockpit-mode #left-panel-stack > #species-panel { display: none !important; }
body.ui-clean-view #species-panel,
body.recording-mode #species-panel { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }
```

- [ ] **Step 6: Collapse the panel on Cockpit entry (`src/ui.js`)**

Replace the text `  'global-context-panel',\n  'radio-panel',\n]);` (the end of `COCKPIT_ENTRY_COLLAPSE_PANEL_IDS`) with:

```js
  'global-context-panel',
  'radio-panel',
  'species-panel',
]);
```

- [ ] **Step 7: Wire the client, controller and panel in `src/main.js`**

Replace `import speciesLayer from './data/species.js';` with:

```js
import speciesLayer, { DEFAULT_SPECIES_PARAMS } from './data/species.js';
import { createBioClient } from './bio/gbif.js';
import { createWhatLivesHere } from './bio/whatLivesHere.js';
import { createSpeciesPanel } from './bio/speciesPanel.js';
```

After `    document.body.appendChild(bioCard.element);` add:

```js
    // Species search and "what lives here" (docs/superpowers/specs/2026-09-13-species-search-design.md).
    const bioClient = createBioClient();
    let speciesPanel = null;
    const whatLivesHere = createWhatLivesHere({
      viewer,
      client: bioClient,
      card: bioCard,
      getParams: () => dataManager.getLayerParams('species') || DEFAULT_SPECIES_PARAMS,
      onPickSpecies: ({ taxonKey, name }) => {
        speciesPanel?.chooseTaxon({ taxonKey, name }).catch((error) => console.error('[species] could not map the picked species', { taxonKey, error }));
      },
      onArmedChange: () => speciesPanel?.render(),
    });
    speciesPanel = createSpeciesPanel({ dataManager, speciesLayer, client: bioClient, whatLivesHere });
```

- [ ] **Step 8: Add the credit and licence rows**

In `src/data/dataCredits.js`, directly before the text `  {\n    key: 'rivers',` insert:

```js
  {
    key: 'species',
    html: 'Species maps and "what lives here": <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF.org</a> occurrence search and maps (CC0 and CC BY records only). Species names suggested by <a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a>.',
  },
```

In `DATA_SOURCES.md`, append this row as the last row of the table under `## wildeye additions` (after the `| Wildlife sightings |` row):

```markdown
| Species map and "what lives here" (browser, no pipeline) | GBIF.org maps API `/v2/map/occurrence/adhoc` and occurrence search (`geoDistance`, `facet=speciesKey`), both with `license=CC0_1_0&license=CC_BY_4_0`; names from iNaturalist `/v1/taxa/autocomplete`, matched with GBIF `/v1/species/match` | per-record CC0 / CC BY only, filtered in every request; names are not records |
```

and append these rows at the end of the table under `## wildeye licence matrix`:

```markdown
| GBIF maps + occurrence search (species map, what lives here) | **v1 built 2026-09-13** (browser; `density` tiles ignore `license=`, so `adhoc` is used) | per-record CC0 / CC BY filter; GBIF terms pages 403 to scripts, UNREAD until read in a browser before deploy | CC0 and CC BY records only; link to the same query on gbif.org for a citable download | "Occurrence data: GBIF.org, CC0 and CC BY records only" in the card | api.gbif.org, 2026-09-13 |
| iNaturalist taxon autocomplete (species names) | **v1 built 2026-09-13** (name suggestions only; no observations, photos or media) | API docs (swagger.json, read 2026-09-13): "The API is intended to support application development, not data scraping." Terms of Service 403 to scripts, UNREAD until read in a browser before deploy | ≤ 60 requests/min per browser; "keep under 10,000 requests per day" | "Names: iNaturalist" in the SPECIES panel | api.inaturalist.org/v1/swagger.json, 2026-09-13 |
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test src/bio/speciesPanel.test.mjs src/cockpitMarkup.test.mjs src/radioMarkup.test.mjs`
Expected: PASS, 0 failures.

Run: `npm test` → Expected: 0 failures.

- [ ] **Step 10: Real-browser check of search and what lives here**

```bash
bash scripts/build-static-preview.sh
npx vite preview --base /wildeye/ --outDir .qa-static --port 4488 --strictPort &
HEAVY_RUN_MEM=10G heavy-run node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ --checks card,search,here --shots .qa-static/shots
```

Expected JSON lines, all `"ok":true`: `card`; `search` with `first` starting `Monarch`, `params.taxonKey` 5133088, `tiles` > 0 and `adhocWithBothLicences` equal to `tiles`; `here` with `rows` ≥ 1; `no-failed-requests`. If `search` shows tiles without both `license` values, Cesium's `Resource` rewrote the repeated query key: fix `densityTileTemplate` by building the query with a literal string (`license=CC0_1_0&license=CC_BY_4_0`) instead of `URLSearchParams.append`, re-run Task 1's tests and this step.

- [ ] **Step 11: Commit**

```bash
git add src/bio/speciesPanel.js src/bio/speciesPanel.test.mjs index.html style.css src/ui.js src/main.js src/data/dataCredits.js DATA_SOURCES.md
git commit -m "species search: SPECIES panel (name search with suggestions, map switch, year and radius chips, what lives here), startup wiring, GBIF and iNaturalist credit and licence rows"
```

---

### Task 7: End-to-end verification, visual review, terms, deploy

**Files:**
- Modify (only if a check below requires it): `src/bio/gbif.js`, `src/bio/gbif.test.mjs`, `DATA_SOURCES.md`

**Interfaces:**
- Consumes: everything above; `scripts/qa-species.mjs`, `scripts/qa-static-controls.mjs`, `pipeline/deploy_pages.sh`.
- Produces: a verified Pages deploy.

- [ ] **Step 1: Full browser run on the local static build, including the gbif.org link**

```bash
bash scripts/build-static-preview.sh
npx vite preview --base /wildeye/ --outDir .qa-static --port 4488 --strictPort &
HEAVY_RUN_MEM=10G heavy-run node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ --checks card,search,here,portal --shots .qa-static/shots
```

Expected: every line `"ok":true`. If only `portal` fails: read its `pageSample`. If it is a bot-check page ("Just a moment", "Checking your browser"), open the link for the user with `cmd.exe /c start "" "<link>"` and ask whether gbif.org shows the same record count. If gbif.org loaded but shows a different count, it ignored `geo_distance`: change `gbifPortalUrl` to

```js
export function gbifPortalUrl({ lat, lon, radiusKm, years, now = new Date() }) {
  return speciesNearUrl({ lat, lon, radiusKm, years, now }).replace('limit=0', 'limit=20');
}
```

update the portal assertions in `src/bio/gbif.test.mjs` to expect `https://api.gbif.org/v1/occurrence/search` with `limit=20`, run `node --test src/bio/gbif.test.mjs`, and re-run this step without `portal`.

- [ ] **Step 2: Control crawl of the SPECIES panel**

Run: `HEAVY_RUN_MEM=10G heavy-run node scripts/qa-static-controls.mjs --url http://localhost:4488/wildeye/ --sections SPECIES --no-location`
Expected: last line `0 controls produced failed requests or errors; 0 reloaded or navigated the page: none`.

- [ ] **Step 3: Independent visual review**

Copy the screenshots for the user: `cp .qa-static/shots/*.png /mnt/c/Users/a2b32/Downloads/`.
Dispatch an independent critic subagent (Agent tool, general-purpose, default model) with this brief: "You are reviewing three screenshots of a Cesium globe web app: `.qa-static/shots/card.png` (a details card opened by clicking a wildlife sighting), `search.png` (SPECIES panel after choosing Monarch, GBIF hexagon density map drawn over the globe), `what-lives-here.png` (the card listing species recorded within 10 km of a point in Yellowstone). Read each image. For each, report PASS or FAIL with concrete defects: text that is cut off, overlapping other HUD elements, too small to read at 1400×900, low contrast against the dark globe, a map layer that hides the markers or looks like a rendering error, controls whose state (pressed / not pressed) cannot be told apart. Do not assume anything the image does not show." Fix every FAIL defect (CSS in `style.css`, or `SPECIES_ALPHA` in `src/data/species.js`), rebuild, re-run Step 1 with `--checks card,search,here`, and dispatch a fresh critic until all three PASS.

- [ ] **Step 4: Read the terms in a real browser and record them**

```bash
cat > .qa-static/read-terms.mjs <<'EOF'
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
for (const url of ['https://www.gbif.org/terms', 'https://www.gbif.org/terms/data-user', 'https://www.inaturalist.org/pages/terms']) {
  const page = await browser.newPage();
  const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 }).catch((e) => ({ status: () => String(e.message) }));
  await new Promise((r) => setTimeout(r, 4000));
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  console.log(`=== ${url} status=${res.status()} chars=${text.length}\n${text.slice(0, 6000)}\n`);
  await page.close();
}
await browser.close();
EOF
node .qa-static/read-terms.mjs > .qa-static/terms.txt; grep -n "^===" .qa-static/terms.txt
```

(`.qa-static/` is gitignored, so the script resolves `puppeteer` from the repo's `node_modules`.) If all three pages return text: find the clauses on display, redistribution, attribution, API use and automated access; replace the two "UNREAD until read in a browser before deploy" phrases in `DATA_SOURCES.md` with the verbatim quotes and the URL and date read; if a clause forbids this use, stop and report it to the user instead of deploying. If any page is blocked (status 403 or a bot-check page): stop and ask the user to open those URLs in their browser and confirm there is no clause against displaying CC0/CC BY records via the API (GBIF) or using autocomplete in a public app (iNaturalist); do not deploy until they answer.

- [ ] **Step 5: Commit any changes from Steps 1–4**

```bash
git add -A src/bio src/data style.css DATA_SOURCES.md
git commit -m "species search: fixes from the browser, visual and terms checks"
```

(Skip if nothing changed.)

- [ ] **Step 6: Full suite, push, deploy, live check**

```bash
npm test
git push origin main-wildeye
bash pipeline/deploy_pages.sh
gh api repos/musharna/wildeye/pages/builds/latest --jq '.status+" "+.commit'   # repeat until "built <gh-pages sha>"
HEAVY_RUN_MEM=10G heavy-run node scripts/qa-species.mjs --url https://musharna.github.io/wildeye/ --checks card,search,here
```

Expected: `npm test` 0 failures; deploy prints `pushed gh-pages <sha>`; Pages status `built <sha>`; every live check `"ok":true`. Stop the local preview server (kill by the PID from `ss -ltnp | grep 4488`).

---

### Task 8: README and CHANGELOG (draft PR)

**Files:**
- Modify: `README.md` (new section before `## Where the data comes from`), `CHANGELOG.md` (under `## [Unreleased]` → `### Added`)

**Interfaces:**
- Consumes: the shipped feature.
- Produces: a draft PR for the user to read.

- [ ] **Step 1: Branch**

```bash
git checkout -b docs/species-search
```

- [ ] **Step 2: README section**

Insert before the line `## Where the data comes from`:

```markdown
## Species search

The SPECIES panel finds a species by common or scientific name. Name suggestions come from
iNaturalist. The map shows GBIF occurrence records under CC0 or CC BY as hexagons, for the last
10 years or for all years.

"What lives here" lists the 20 species with the most CC0 and CC BY records within 1, 10 or 50 km
of a point you click. Each list links to the same search on gbif.org, where the records can be
browsed and downloaded with a citation.

Clicking a marker from a biology layer opens a card with that record's details, citation and
licence.

These features run in the browser and work on the hosted site.

```

- [ ] **Step 3: CHANGELOG bullets**

After the bullet that begins `- wildeye: a shared 30-day time bar`, add:

```markdown
- wildeye: species search. Any species can be mapped from GBIF records (CC0 and CC BY only), and
  "what lives here" lists the species recorded near a clicked point.
- wildeye: clicking a biology marker opens a card with the record's details, citation and licence.
  Before this, those details were attached to the markers but never shown.
```

- [ ] **Step 4: Commit, push, open a draft PR**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: species search, what lives here and the biology details card"
git push -u origin docs/species-search
gh pr create --draft --base main-wildeye --title "docs: species search and biology details card" --body "README section and CHANGELOG entries for species search, what lives here and the details card. Draft for review before merge."
git checkout main-wildeye
```

Expected: `gh` prints the draft PR URL. Report it to the user; do not merge until they say merge.
