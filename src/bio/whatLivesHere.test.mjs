// src/bio/whatLivesHere.test.mjs — arm-then-click: marker clicks stay normal, sky keeps it armed,
// a ground click sends exactly one GBIF search and lists the species; a newer search or a new arming cancels an
// older one, failures are logged and retryable, Escape disarms, and a failed name lookup falls back to the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { classifyClick, createWhatLivesHere, HEADING } from './whatLivesHere.js';
import { createBioClient } from './gbif.js';

const YELLOWSTONE = Cesium.Cartesian3.fromDegrees(-110.83, 44.46);
const DENALI = Cesium.Cartesian3.fromDegrees(-151.0074, 63.0692);
const CLICK = { position: { x: 1, y: 1 } };

function rig({ picked = undefined, ground = YELLOWSTONE, near = { total: 5, species: [{ key: 5232437, count: 5 }] }, nearError = null, speciesNear = null, speciesName = null, client: clientOverride = null } = {}) {
  const calls = { near: [], names: [], status: [], list: [], card: [], picked: [], armed: [] };
  const params = { years: 'recent', radiusKm: 10 };
  const viewer = {
    scene: { canvas: { style: {} }, pick: () => picked, pickPositionSupported: false, pickPosition: () => undefined, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    camera: { pickEllipsoid: () => ground },
  };
  const client = clientOverride || {
    speciesNear: async (args, options) => {
      calls.near.push(args);
      if (speciesNear) return speciesNear(args, options);
      if (nearError) throw nearError;
      return near;
    },
    speciesName: async (key, options) => {
      calls.names.push(key);
      if (speciesName) return speciesName(key, options);
      return { key, scientificName: 'Branta canadensis', commonName: 'Canada Goose' };
    },
  };
  // calls.card keeps status and list calls in one ordered log.
  const card = {
    showStatus: (s) => { calls.status.push(s); calls.card.push({ kind: 'status', ...s }); },
    showList: (l) => { calls.list.push(l); calls.card.push({ kind: 'list', ...l }); },
  };
  // Records keydown listeners so a test can press a key.
  const doc = {
    keydown: [],
    addEventListener(type, fn) { if (type === 'keydown') this.keydown.push(fn); },
    press(key) { for (const fn of this.keydown) fn({ key }); },
  };
  const controller = createWhatLivesHere({
    viewer,
    client,
    card,
    getParams: () => ({ ...params }),
    onPickSpecies: (p) => calls.picked.push(p),
    onArmedChange: (on) => calls.armed.push(on),
    handlerFor: () => ({ setInputAction() {}, destroy() {} }),
    doc,
  });
  return { controller, calls, viewer, doc, params };
}

// A GBIF search that stays pending until the test settles it. Like fetch, it rejects with the abort reason as soon
// as its signal aborts.
function pendingNear() {
  const searches = [];
  const speciesNear = (args, { signal }) => new Promise((resolve, reject) => {
    searches.push({ args, signal, resolve, reject });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { searches, speciesNear };
}

// Records console.error calls, rather than only silencing them, so a test can assert what was logged.
async function captureConsoleError(fn) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
}

test('classifyClick: marker, sky, ground', () => {
  assert.equal(classifyClick({ picked: { id: 'occ:1' }, position: YELLOWSTONE }), 'entity');
  assert.equal(classifyClick({ picked: { primitive: {} }, position: YELLOWSTONE }), 'ground', 'a pick without an id (terrain, 3D tiles) is ground');
  assert.equal(classifyClick({ picked: undefined, position: null }), 'sky');
  assert.equal(classifyClick({ picked: undefined, position: YELLOWSTONE }), 'ground');
});

test('unarmed clicks do nothing; a marker click sends no query and stays armed', () => {
  const unarmed = rig();
  assert.equal(unarmed.controller.handleClick(CLICK), null, 'a ground click before arming');
  assert.equal(unarmed.calls.near.length, 0);
  const { controller, calls } = rig({ picked: { id: 'occ:blue-whale:2026-09-01:0' } });
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

test('re-arming and clicking again supersedes a pending search: only the second list shows, and no failure', async () => {
  const pending = pendingNear();
  const r = rig({ speciesNear: pending.speciesNear });
  let cardCallsBeforeSecond = 0;
  const logged = await captureConsoleError(async () => {
    r.controller.arm();
    const first = r.controller.handleClick(CLICK);
    r.controller.arm();
    r.viewer.camera.pickEllipsoid = () => DENALI;
    cardCallsBeforeSecond = r.calls.card.length;
    const second = r.controller.handleClick(CLICK);
    assert.equal(pending.searches.length, 2, 'two searches were sent');
    const [a, b] = pending.searches;
    b.resolve({ total: 7, species: [{ key: 5232437, count: 7 }] });
    await second;
    a.resolve({ total: 3, species: [{ key: 5232437, count: 3 }] });
    await first;
    assert.equal(a.signal.aborted, true, 'the first search was aborted');
  });
  const afterSecond = r.calls.card.slice(cardCallsBeforeSecond);
  assert.deepEqual(afterSecond.map((c) => c.kind), ['status', 'list'], 'after the second click: its Searching status and its list, nothing from the first search');
  assert.equal(afterSecond[0].message, 'Searching GBIF within 10 km…');
  assert.match(afterSecond[1].filterLine, / · 7 records$/, 'the list is the second search, not the first');
  assert.ok(Math.abs(r.calls.near[1].lat - 63.0692) < 1e-6, 'the second search is at the second point');
  assert.equal(r.calls.card.some((c) => /GBIF search failed/.test(c.message ?? '')), false, 'no failure status');
  assert.deepEqual(logged, [], 'nothing logged for a superseded search');
});

test('a Retry started while an earlier search is still pending supersedes it', async () => {
  const pending = pendingNear();
  const r = rig({ speciesNear: pending.speciesNear });
  r.controller.arm();
  await captureConsoleError(async () => {
    const failed = r.controller.handleClick(CLICK);
    pending.searches[0].reject(new Error('HTTP 503'));
    await failed;
  });
  const { retry } = r.calls.status.at(-1);
  const older = retry();
  const newer = retry();
  assert.equal(pending.searches.length, 3, 'each Retry sends a search');
  const [, olderSearch, newerSearch] = pending.searches;
  newerSearch.resolve({ total: 7, species: [{ key: 5232437, count: 7 }] });
  await newer;
  olderSearch.resolve({ total: 3, species: [{ key: 5232437, count: 3 }] });
  await older;
  assert.equal(r.calls.list.length, 1, 'only one list reaches the card');
  assert.match(r.calls.list[0].filterLine, / · 7 records$/, 'and it is the newer search');
  assert.equal(r.calls.card.at(-1).kind, 'list');
  assert.equal(olderSearch.signal.aborted, true, 'the older search was aborted');
});

test('arming again cancels a search still in flight, so the prompt stays on the card', async () => {
  const pending = pendingNear();
  const r = rig({ speciesNear: pending.speciesNear });
  r.controller.arm();
  const first = r.controller.handleClick(CLICK);
  r.controller.arm();
  const [old] = pending.searches;
  old.resolve({ total: 5, species: [{ key: 5232437, count: 5 }] });
  await first;
  const last = r.calls.card.at(-1);
  assert.deepEqual({ kind: last.kind, message: last.message }, { kind: 'status', message: 'Click a spot on the globe. Esc cancels.' }, 'the prompt is still the last card call');
  assert.equal(r.calls.list.length, 0, 'the old search listed nothing');
  assert.equal(old.signal.aborted, true, 'arming aborted the old search');
  assert.equal(r.controller.armed, true);
});

test('a failed search logs exactly one console.error with the point, radius and years', async () => {
  const r = rig({ nearError: new Error('HTTP 503') });
  r.controller.arm();
  const logged = await captureConsoleError(() => r.controller.handleClick(CLICK));
  assert.equal(logged.length, 1, 'exactly one console.error');
  const [label, context] = logged[0];
  assert.match(label, /GBIF search failed/);
  assert.ok(Math.abs(context.lat - 44.46) < 1e-6 && Math.abs(context.lon + 110.83) < 1e-6, 'logs the point');
  assert.equal(context.radiusKm, 10);
  assert.equal(context.years, 'recent');
  assert.equal(context.error.message, 'HTTP 503');
});

test('Retry on a failed search sends a new search at the same point, with the radius and years in force at retry time', async () => {
  let attempts = 0;
  const r = rig({
    speciesNear: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('HTTP 503');
      return { total: 2, species: [{ key: 5232437, count: 2 }] };
    },
  });
  r.controller.arm();
  await captureConsoleError(() => r.controller.handleClick(CLICK));
  const { retry } = r.calls.status.at(-1);
  r.params.radiusKm = 50;
  r.params.years = 'all';
  await retry();
  assert.equal(r.calls.near.length, 2, 'Retry sends a second search');
  assert.equal(r.calls.near[1].radiusKm, 50);
  assert.equal(r.calls.near[1].years, 'all');
  assert.equal(r.calls.near[1].lat, r.calls.near[0].lat);
  assert.equal(r.calls.near[1].lon, r.calls.near[0].lon);
  assert.equal(r.calls.card.at(-1).filterLine, 'CC0 and CC BY records · all years · within 50 km · 2 records');
});

test('Escape while armed disarms (cursor back, onArmedChange(false)); other keys and Escape when not armed change nothing', () => {
  const r = rig();
  r.controller.arm();
  r.doc.press('Enter');
  assert.equal(r.controller.armed, true, 'only Escape cancels');
  r.doc.press('Escape');
  assert.equal(r.controller.armed, false, 'Escape disarms');
  assert.equal(r.viewer.scene.canvas.style.cursor, '');
  assert.deepEqual(r.calls.armed, [true, false]);
  r.doc.press('Escape');
  assert.deepEqual(r.calls.armed, [true, false], 'Escape when not armed reports nothing');
  assert.equal(r.controller.handleClick(CLICK), null, 'a click after Escape sends nothing');
  assert.equal(r.calls.near.length, 0);
});

test('a failed name lookup falls back to the taxon key and logs the key; the other names still resolve', async () => {
  const r = rig({
    near: { total: 9, species: [{ key: 5232437, count: 5 }, { key: 2480528, count: 4 }] },
    speciesName: async (key) => {
      if (key === 2480528) throw new Error('HTTP 503');
      return { key, scientificName: 'Branta canadensis', commonName: 'Canada Goose' };
    },
  });
  r.controller.arm();
  const logged = await captureConsoleError(() => r.controller.handleClick(CLICK));
  assert.equal(r.calls.list.length, 1, 'the list still shows');
  assert.deepEqual(r.calls.list[0].entries, [
    { key: 5232437, count: 5, scientificName: 'Branta canadensis', commonName: 'Canada Goose', error: undefined },
    { key: 2480528, count: 4, scientificName: 'GBIF taxon 2480528', commonName: null, error: 'HTTP 503' },
  ]);
  assert.equal(logged.length, 1, 'one console.error for the failed name');
  assert.match(logged[0][0], /name lookup failed/);
  assert.equal(logged[0][1].key, 2480528);
});

// R-6b: the card was dismissed while it said "Searching GBIF…"; the search must not reopen it.
test('cancel() aborts the search in flight and disarms; the settled search calls the card nothing', async () => {
  const pending = pendingNear();
  const r = rig({ speciesNear: pending.speciesNear });
  r.controller.arm();
  const search = r.controller.handleClick(CLICK);
  assert.equal(r.calls.card.at(-1).message, 'Searching GBIF within 10 km…');
  const cardCallsAtCancel = r.calls.card.length;
  const logged = await captureConsoleError(async () => {
    r.controller.cancel();
    pending.searches[0].resolve({ total: 5, species: [{ key: 5232437, count: 5 }] });
    await search;
  });
  assert.equal(pending.searches[0].signal.aborted, true, 'cancel aborted the search');
  assert.deepEqual(r.calls.card.slice(cardCallsAtCancel), [], 'no card call after cancel');
  assert.equal(r.controller.armed, false);
  assert.deepEqual(logged, [], 'a cancelled search logs nothing');
  r.controller.arm();
  r.controller.cancel();
  assert.equal(r.controller.armed, false, 'cancel disarms an armed controller');
  assert.equal(r.viewer.scene.canvas.style.cursor, '');
  assert.deepEqual(r.calls.armed, [true, false, true, false]);
});

// F9: above 85° or across ±180° the polygon cannot be built. The search uses geoDistance as before, and the card says
// gbif.org can't show the circle, linking the same filters with no location, instead of "GBIF search failed".
test('a click where the circle cannot be a polygon lists species via geoDistance and links gbif.org without a location filter', async () => {
  const species = { count: 4, facets: [{ field: 'SPECIES_KEY', counts: [{ name: '5232437', count: 4 }] }] };
  const name = { key: 5232437, canonicalName: 'Branta canadensis', vernacularName: 'Canada Goose' };
  for (const [where, ground, radiusKm] of [['north of 85°', Cesium.Cartesian3.fromDegrees(12.5, 86.2), 10], ['across the antimeridian', Cesium.Cartesian3.fromDegrees(179.8, -16.5), 50]]) {
    const urls = [];
    const client = createBioClient({ fetchImpl: async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => (url.includes('/v1/occurrence/search') ? species : name) }; } });
    const r = rig({ ground, client });
    r.params.radiusKm = radiusKm;
    r.controller.arm();
    const logged = await captureConsoleError(() => r.controller.handleClick(CLICK));
    assert.deepEqual(logged, [], `${where}: nothing logged`);
    assert.equal(r.calls.card.some((c) => /failed/.test(c.message ?? '')), false, `${where}: no failure status`);
    const search = urls.find((u) => u.includes('/v1/occurrence/search'));
    assert.ok(search, `${where}: the GBIF search was sent`);
    const sent = new URL(search);
    assert.equal(sent.searchParams.has('geometry'), false, where);
    assert.match(sent.searchParams.get('geoDistance') ?? '', new RegExp(`,${radiusKm}km$`), where);
    const list = r.calls.list.at(-1);
    assert.ok(list, `${where}: the list shows`);
    assert.equal(list.footerNote, "gbif.org can't show this area as a circle", where);
    assert.equal(list.footer, 'Occurrence data: GBIF.org, CC0 and CC BY records, all locations', where);
    const link = new URL(list.footerHref);
    assert.equal(link.origin + link.pathname, 'https://www.gbif.org/occurrence/search', where);
    assert.deepEqual([...link.searchParams.keys()], ['license', 'license', 'year'], `${where}: the licences and years, no location`);
  }
  const ordinary = rig();
  ordinary.controller.arm();
  await ordinary.controller.handleClick(CLICK);
  assert.equal(ordinary.calls.list[0].footerNote ?? null, null, 'positive control: an ordinary point has no note');
  assert.match(new URL(ordinary.calls.list[0].footerHref).searchParams.get('geometry') ?? '', /^POLYGON/, 'positive control: and the circle link');
});
