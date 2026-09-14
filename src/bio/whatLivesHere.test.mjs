// src/bio/whatLivesHere.test.mjs — arm-then-click: marker clicks stay normal, sky keeps it armed,
// a ground click sends exactly one GBIF search and lists the species; a newer search or a new arming cancels an
// older one, failures are logged and retryable, Escape disarms, and a failed name lookup falls back to the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { AREA_OUTLINE_ROLE, areaOutlinePrimitive, CENTRE_MARK_FRACTION, centreMark, circleOutline, classifyClick, createWhatLivesHere, HEADING } from './whatLivesHere.js';
import { createBioClient } from './gbif.js';
import { createDetailsCard } from './detailsCard.js';

const YELLOWSTONE = Cesium.Cartesian3.fromDegrees(-110.83, 44.46);
const DENALI = Cesium.Cartesian3.fromDegrees(-151.0074, 63.0692);
const CLICK = { position: { x: 1, y: 1 } };
const MARKER = { id: 'occ:blue-whale:2026-09-01:0', entityCollection: { owner: { name: 'occurrences' } }, description: { getValue: () => '<b>Blue whale</b>' } };

// The browser pieces createDetailsCard touches (as in detailsCard.test.mjs), so the real card can drive the controller.
function fakeCardDoc() {
  const listeners = {};
  const make = (tag) => {
    const parts = {};
    return {
      tag, hidden: false, id: '', className: '', textContent: '', innerHTML: '', href: '', target: '', rel: '', attributes: {}, children: [], listeners: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...kids) { this.children = kids; this.innerHTML = ''; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelector(selector) { return (parts[selector] ||= make(selector)); },
    };
  };
  return { listeners, createElement: make, addEventListener(type, fn) { listeners[type] = fn; }, press(key) { listeners.keydown?.({ key }); } };
}

// realCard: the real details card, wired to the controller as src/main.js wires them (onDismiss → cancel, onListEnd → listEnded).
function rig({ picked = undefined, ground = YELLOWSTONE, near = { total: 5, species: [{ key: 5232437, count: 5 }] }, nearError = null, speciesNear = null, speciesName = null, client: clientOverride = null, defaultArea = false, realCard = false, drawArea = null, depthTexture = true } = {}) {
  const calls = { near: [], names: [], status: [], list: [], card: [], picked: [], armed: [] };
  const params = { years: 'recent', radiusKm: 10 };
  // groundPrimitives stands in for Cesium's collection, for the default outline; `areas` records the injected outline seam.
  const groundPrimitives = { items: [], add(p) { this.items.push(p); return p; }, remove(p) { const i = this.items.indexOf(p); if (i >= 0) this.items.splice(i, 1); return i >= 0; } };
  // Like Cesium's Viewer, selectedEntityChanged fires only when the selected value changes.
  const selection = { handlers: [], value: undefined };
  const viewer = {
    scene: { canvas: { style: {} }, pick: () => picked, pickPositionSupported: false, pickPosition: () => undefined, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 }, groundPrimitives, frameState: { context: { depthTexture } } },
    camera: { pickEllipsoid: () => ground },
    clock: { currentTime: 'now' },
    selectedEntityChanged: { addEventListener: (fn) => selection.handlers.push(fn) },
    get selectedEntity() { return selection.value; },
    set selectedEntity(value) {
      if (value === selection.value) return;
      selection.value = value;
      for (const fn of selection.handlers) fn(value);
    },
  };
  const areas = { drawn: [], cleared: [] };
  const areaSeam = defaultArea ? {} : {
    drawArea: drawArea || ((area) => { const handle = { ...area }; areas.drawn.push(handle); return handle; }),
    clearArea: (handle) => { areas.cleared.push(handle); },
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
  // calls.card keeps status and list calls in one ordered log (fake card only).
  let controller = null;
  const cardDoc = realCard ? fakeCardDoc() : null;
  const card = realCard
    ? createDetailsCard({ viewer, doc: cardDoc, sanitize: (html) => html, onDismiss: () => controller.cancel(), onListEnd: () => controller.listEnded() })
    : {
      showStatus: (s) => { calls.status.push(s); calls.card.push({ kind: 'status', ...s }); },
      showList: (l) => { calls.list.push(l); calls.card.push({ kind: 'list', ...l }); },
    };
  // Records keydown listeners so a test can press a key.
  const doc = {
    keydown: [],
    addEventListener(type, fn) { if (type === 'keydown') this.keydown.push(fn); },
    press(key) { for (const fn of this.keydown) fn({ key }); },
  };
  controller = createWhatLivesHere({
    viewer,
    client,
    card,
    getParams: () => ({ ...params }),
    onPickSpecies: (p) => calls.picked.push(p),
    onArmedChange: (on) => calls.armed.push(on),
    handlerFor: () => ({ setInputAction() {}, destroy() {} }),
    doc,
    ...areaSeam,
  });
  return { controller, calls, viewer, doc, params, areas, groundPrimitives, card, cardDoc };
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

// F5: the searched circle is outlined on the globe while its card describes it.
test('a search outlines its circle from the start; a second search replaces the outline; dismissing the card and destroy remove it', async () => {
  const pending = pendingNear();
  const r = rig({ speciesNear: pending.speciesNear });
  r.controller.arm();
  assert.equal(r.areas.drawn.length, 0, 'arming draws nothing');
  const first = r.controller.handleClick(CLICK);
  assert.equal(r.areas.drawn.length, 1, 'drawn when the search starts, before GBIF answers');
  const [a] = r.areas.drawn;
  assert.ok(Math.abs(a.lat - 44.46) < 1e-6 && Math.abs(a.lon + 110.83) < 1e-6, 'at the clicked point');
  assert.equal(a.radiusKm, 10);
  pending.searches[0].resolve({ total: 5, species: [{ key: 5232437, count: 5 }] });
  await first;
  assert.deepEqual(r.areas.cleared, [], 'the listed search keeps its outline');

  r.params.radiusKm = 50;
  r.controller.arm();
  r.viewer.camera.pickEllipsoid = () => DENALI;
  const second = r.controller.handleClick(CLICK);
  assert.equal(r.areas.drawn.length, 2, 'the second search draws its own outline');
  assert.equal(r.areas.cleared.length, 1, 'and removes the first one');
  assert.equal(r.areas.cleared[0], a, 'the removed outline is the first one');
  const b = r.areas.drawn[1];
  assert.ok(Math.abs(b.lat - 63.0692) < 1e-6 && b.radiusKm === 50, 'the new outline is the second point and radius');

  const logged = await captureConsoleError(async () => {
    r.controller.cancel(); // what the card's onDismiss calls
    await second;
  });
  assert.deepEqual(logged, []);
  assert.equal(r.areas.cleared.length, 2, 'dismissing the card removes the outline');
  assert.equal(r.areas.cleared[1], b);
  r.controller.cancel();
  assert.equal(r.areas.cleared.length, 2, 'a second dismissal has nothing to remove');

  const d = rig();
  d.controller.arm();
  await d.controller.handleClick(CLICK);
  d.controller.destroy();
  assert.equal(d.areas.cleared.length, 1, 'destroy removes the outline');
  assert.equal(d.areas.cleared[0], d.areas.drawn[0]);
});

// R-7e: the outline lives exactly as long as the card shows that search's status or list (real card, wired as src/main.js).
test("a marker's details replacing the list remove the outline, and deselecting then closes the card with nothing drawn back", async () => {
  const r = rig({ realCard: true });
  r.controller.arm();
  await r.controller.handleClick(CLICK);
  assert.equal(r.card.mode, 'list', 'the list shows');
  assert.equal(r.areas.drawn.length, 1);
  assert.deepEqual(r.areas.cleared, [], 'positive control: the listed search keeps its outline');
  r.viewer.selectedEntity = MARKER; // a marker click: Cesium selects it and the card shows its details
  assert.equal(r.card.mode, 'detail');
  assert.deepEqual(r.areas.cleared, [r.areas.drawn[0]], 'the details replaced the list, so the outline is gone');
  r.viewer.selectedEntity = undefined; // a click on empty globe: Cesium deselects and the card closes
  assert.equal(r.card.element.hidden, true, 'the card is closed');
  assert.equal(r.areas.cleared.length, 1, 'removed once');
  assert.equal(r.areas.drawn.length, 1, 'nothing drawn back');
});

test("a marker's details replacing a search still in flight abort it, so it cannot reopen the list", async () => {
  const pending = pendingNear();
  const r = rig({ realCard: true, speciesNear: pending.speciesNear });
  r.controller.arm();
  const search = r.controller.handleClick(CLICK);
  assert.equal(r.card.mode, 'list', 'the Searching status shows');
  const logged = await captureConsoleError(async () => {
    r.viewer.selectedEntity = MARKER;
    pending.searches[0].resolve({ total: 5, species: [{ key: 5232437, count: 5 }] });
    await search;
  });
  assert.equal(pending.searches[0].signal.aborted, true, 'the search was aborted');
  assert.equal(r.card.mode, 'detail', 'the details stay');
  assert.deepEqual(r.areas.cleared, [r.areas.drawn[0]]);
  assert.equal(r.calls.names.length, 0, 'no name lookups for the aborted search');
  assert.deepEqual(logged, []);
});

test('Escape and the close button remove the outline once; arming again removes the previous outline; destroy removes the last', async () => {
  const r = rig({ realCard: true });
  r.controller.arm();
  await r.controller.handleClick(CLICK);
  r.cardDoc.press('Escape');
  assert.equal(r.card.element.hidden, true);
  assert.deepEqual(r.areas.cleared, [r.areas.drawn[0]], 'Escape removed the outline, once');

  r.controller.arm();
  await r.controller.handleClick(CLICK);
  r.card.element.querySelector('.bio-card-close').listeners.click();
  assert.deepEqual(r.areas.cleared, r.areas.drawn, 'the close button removed the second outline, once');

  r.controller.arm();
  await r.controller.handleClick(CLICK);
  assert.equal(r.areas.cleared.length, 2, 'positive control: the third outline shows');
  r.controller.arm();
  assert.deepEqual(r.areas.cleared, r.areas.drawn, 'arming again removed it before any click');
  assert.equal(r.controller.armed, true);
  assert.equal(r.card.mode, 'list', 'the prompt shows');

  await r.controller.handleClick(CLICK);
  assert.equal(r.areas.drawn.length, 4);
  r.controller.destroy();
  assert.deepEqual(r.areas.cleared, r.areas.drawn, 'destroy removed the fourth outline');
});

test('arming again removes the previous outline (fake card)', async () => {
  const r = rig();
  r.controller.arm();
  await r.controller.handleClick(CLICK);
  assert.deepEqual(r.areas.cleared, [], 'positive control: the outline shows after the search');
  r.controller.arm();
  assert.deepEqual(r.areas.cleared, [r.areas.drawn[0]]);
});

test('a failure drawing the outline is logged with its context and does not stop the search', async () => {
  const r = rig({ drawArea: () => { throw new Error('WebGL context lost'); } });
  r.controller.arm();
  const logged = await captureConsoleError(() => r.controller.handleClick(CLICK));
  assert.equal(r.calls.near.length, 1, 'the search was sent');
  assert.equal(r.calls.list.length, 1, 'and its list shows');
  assert.equal(logged.length, 1, 'one console.error');
  const [label, context] = logged[0];
  assert.match(label, /could not outline the searched circle/);
  assert.ok(Math.abs(context.lat - 44.46) < 1e-6 && Math.abs(context.lon + 110.83) < 1e-6, 'logs the point');
  assert.equal(context.radiusKm, 10);
  assert.equal(context.error.message, 'WebGL context lost');
  r.controller.cancel();
  assert.deepEqual(r.areas.cleared, [], 'nothing was drawn, so nothing is removed');
});

test('where ground polylines are unsupported the default outline logs why and draws nothing; the search still lists', async () => {
  const r = rig({ defaultArea: true, depthTexture: false });
  r.controller.arm();
  const logged = await captureConsoleError(() => r.controller.handleClick(CLICK));
  assert.equal(r.groundPrimitives.items.length, 0, 'nothing drawn');
  assert.equal(logged.length, 1, 'one console.error');
  assert.match(logged[0][0], /ground polylines need WEBGL_depth_texture/);
  assert.ok(Math.abs(logged[0][1].area.lat - 44.46) < 1e-6 && logged[0][1].area.radiusKm === 10, 'logs the area');
  assert.equal(r.calls.list.length, 1, 'the list still shows');
  r.controller.cancel();
  assert.equal(r.groundPrimitives.items.length, 0);
  await withLineWidthLimits(async () => {
    const supported = rig({ defaultArea: true });
    supported.controller.arm();
    await supported.controller.handleClick(CLICK);
    assert.equal(supported.groundPrimitives.items.length, 1, 'positive control: with WEBGL_depth_texture the same rig draws the outline');
  });
});

test('centreMark: two crossing arms through the clicked point, each end on a circle of CENTRE_MARK_FRACTION of the radius', () => {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const haversineKm = (a, b) => {
    const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  assert.ok(CENTRE_MARK_FRACTION > 0 && CENTRE_MARK_FRACTION < 0.25, 'a small mark inside the circle');
  for (const [lat, lon, radiusKm] of [[44.46, -110.83, 10], [89.9, 0, 50], [-16.5, 179.99, 50], [0, -180, 1]]) {
    const where = `${lat},${lon} ${radiusKm} km`;
    const centre = { lat, lon };
    const arm = radiusKm * CENTRE_MARK_FRACTION;
    const arms = centreMark({ lat, lon, radiusKm });
    assert.equal(arms.length, 2, where);
    for (const [a, b] of arms) {
      assert.ok(Math.abs(haversineKm(centre, a) / arm - 1) < 1e-6 && Math.abs(haversineKm(centre, b) / arm - 1) < 1e-6, `${where}: both ends on the mark circle`);
      assert.ok(Math.abs(haversineKm(a, b) / (2 * arm) - 1) < 1e-6, `${where}: the arm passes through the clicked point`);
    }
    const [[north], [east]] = arms;
    assert.ok(Math.abs(haversineKm(north, east) / (Math.SQRT2 * arm) - 1) < 1e-3, `${where}: the arms cross at right angles`);
  }
});

test('a Retry replaces the failed search outline with its own', async () => {
  let attempts = 0;
  const r = rig({ speciesNear: async () => { attempts += 1; if (attempts === 1) throw new Error('HTTP 503'); return { total: 2, species: [{ key: 5232437, count: 2 }] }; } });
  r.controller.arm();
  await captureConsoleError(() => r.controller.handleClick(CLICK));
  assert.equal(r.areas.drawn.length, 1, 'a failed search keeps the outline of the spot Retry would search');
  assert.deepEqual(r.areas.cleared, []);
  await r.calls.status.at(-1).retry();
  assert.equal(r.areas.drawn.length, 2);
  assert.equal(r.areas.cleared[0], r.areas.drawn[0]);
});

test('circleOutline: 64 points on the radius, longitudes within ±180°, also at a pole and across the antimeridian', () => {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const haversineKm = (lon1, lat1, lon2, lat2) => {
    const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  for (const [lat, lon, radiusKm] of [[44.46, -110.83, 10], [89.9, 0, 50], [-89.99, 120, 1], [-16.5, 179.8, 50], [0, -180, 10]]) {
    const where = `${lat},${lon} ${radiusKm} km`;
    const points = circleOutline({ lat, lon, radiusKm });
    assert.equal(points.length, 64, where);
    for (const p of points) {
      assert.ok(p.lon >= -180 && p.lon <= 180 && p.lat >= -90 && p.lat <= 90, `${where}: ${p.lon},${p.lat} in range`);
      assert.ok(Math.abs(haversineKm(lon, lat, p.lon, p.lat) / radiusKm - 1) < 1e-6, `${where}: ${p.lon},${p.lat} is on the circle`);
    }
  }
  const across = circleOutline({ lat: -16.5, lon: 179.8, radiusKm: 50 });
  assert.ok(across.some((p) => p.lon < 0) && across.some((p) => p.lon > 0), 'a circle across ±180° has points on both sides');
});

// Node has no WebGL context, so ContextLimits reports a line-width range of 0 and GroundPolylinePrimitive's render state
// refuses width 1. The test sets the range a real context reports (1 to 1 at least) and restores it.
async function withLineWidthLimits(fn) {
  const saved = [Cesium.ContextLimits._minimumAliasedLineWidth, Cesium.ContextLimits._maximumAliasedLineWidth];
  Cesium.ContextLimits._minimumAliasedLineWidth = 1;
  Cesium.ContextLimits._maximumAliasedLineWidth = 1;
  try {
    await fn();
  } finally {
    [Cesium.ContextLimits._minimumAliasedLineWidth, Cesium.ContextLimits._maximumAliasedLineWidth] = saved;
  }
}

test('the default outline is a ground polyline loop that cannot be picked, added to groundPrimitives and removed on dismiss', () => withLineWidthLimits(async () => {
  const primitive = areaOutlinePrimitive({ lat: 44.46, lon: -110.83, radiusKm: 10 });
  assert.ok(primitive instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(primitive.allowPicking, false, 'clicks on or near the outline fall through to the globe and markers');
  assert.equal(primitive.wildeyeRole, AREA_OUTLINE_ROLE);
  // one primitive, so the centre mark shares the outline's lifecycle and its allowPicking: false
  assert.equal(primitive.geometryInstances.length, 3, 'the circle and the two arms of the centre mark');
  assert.deepEqual(primitive.geometryInstances.map((instance) => instance.geometry.loop), [true, false, false]);

  const r = rig({ defaultArea: true });
  r.controller.arm();
  await r.controller.handleClick(CLICK);
  assert.equal(r.groundPrimitives.items.length, 1, 'one outline while the list shows');
  assert.equal(r.groundPrimitives.items[0].wildeyeRole, AREA_OUTLINE_ROLE);
  assert.equal(r.groundPrimitives.items[0].allowPicking, false);
  r.controller.arm();
  await r.controller.handleClick(CLICK);
  assert.equal(r.groundPrimitives.items.length, 1, 'a second search replaces it');
  r.controller.cancel();
  assert.equal(r.groundPrimitives.items.length, 0, 'dismissing the card removes it');
}));
