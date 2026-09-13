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
