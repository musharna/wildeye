import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ShareLinkManager, decodeShareCreatedAtMs } from './sharelink.js';
import { createDefaultLayerState } from './data/layerState.js';

const uiSource = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

function sourceBlock(start, end) {
  const startIndex = uiSource.indexOf(start);
  const endIndex = uiSource.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source block start: ${start}`);
  assert.ok(endIndex > startIndex, `missing source block end: ${end}`);
  return uiSource.slice(startIndex, endIndex);
}

function assertClaimsBefore(block, mutation, label) {
  const claimIndex = block.indexOf("claimRestoreLane?.('visual')");
  const mutationIndex = block.indexOf(mutation);
  assert.ok(claimIndex >= 0, `${label} must claim the visual restore lane`);
  assert.ok(mutationIndex >= 0, `${label} mutation marker is missing`);
  assert.ok(claimIndex < mutationIndex, `${label} must claim before mutation`);
}

function makeManager(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, nextHash) {
      window.location.hash = nextHash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

function installClipboard(writeText) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
}

// The DISPLAY panel went on 2026-09-26 (bloat step 1, cluster 3): its fields are ignored on parse, and the
// NVG/FLIR styles an old link names restore as normal. `crt` in the same kind of link is the positive control.
test('retired visual fields in an old link are ignored, and nvg/flir restore as normal', () => {
  const retired = 'cr=1&sc=0&scf=5&sce=97&bloom=1&bi=80&bv=2&sharpen=0&si=10&hud=minimal&sp=g.50';
  for (const style of ['nvg', 'flir']) {
    const parsed = makeManager(`#v=2&lat=10&lon=20&style=${style}&hv=1&${retired}`).parseInitialHash();
    assert.equal(parsed.style, 'normal', `${style} restores as normal`);
    assert.equal(parsed.hudVisible, true, 'a kept field in the same link still restores');
    for (const key of ['celestialRing', 'scopeEnabled', 'scopeFeatherPct', 'scopeTerminusPct', 'bloom', 'sharpen', 'hudVariant', 'styleParams']) {
      assert.equal(key in parsed, false, `${key} is not parsed`);
    }
  }
  assert.equal(makeManager(`#v=2&lat=10&lon=20&style=crt&${retired}`).parseInitialHash().style, 'retro');
});

test('unknown-only v2 layer tokens are invalid, while historical l fields stay inert', () => {
  const invalid = makeManager('#v=2&lat=10&lon=20&l=z').parseInitialHash();
  assert.equal(invalid.layerState, null);
  assert.equal(invalid.layerStateInvalid, true);
  for (const hash of ['#lat=10&lon=20&l=z', '#v=1&lat=10&lon=20&l=z']) {
    const legacy = makeManager(hash).parseInitialHash();
    assert.equal(legacy.layerState, null);
    assert.equal(legacy.layerStateInvalid, false);
  }
});

test('share-link serialization writes HUD visibility and map, and none of the retired visual fields', () => {
  const manager = makeManager();
  manager.onVisualChange({ hudVisible: true, mapStack: 'osm' });
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  const params = new URLSearchParams(window.location.hash.slice(1));
  assert.equal(params.get('hv'), '1');
  assert.equal(params.get('map'), 'osm');
  for (const key of ['cr', 'sc', 'scf', 'sce', 'bloom', 'bi', 'bv', 'sharpen', 'si', 'hud', 'sp']) {
    assert.equal(params.has(key), false, `${key} is not written`);
  }
});

test('generated links are v2 and include deterministic layers, options, and panels', () => {
  const manager = makeManager();
  const layers = createDefaultLayerState();
  layers.enabledLayerIds = ['occurrences', 'birds'];
  manager.setLayerStateProvider(() => layers);
  manager.setPanelStateProvider(() => ({ specs: [
    { id: 'control-panel', collapsed: false, pinned: true },
    { id: 'species-panel', collapsed: true },
  ] }));
  manager.onStyleChange('retro');
  clearTimeout(manager._debounceTimer);
  manager._updateHash();
  const params = new URLSearchParams(window.location.hash.slice(1));
  assert.equal(params.get('v'), '2');
  assert.equal(params.get('l'), 'n.o', 'registry order, not enable order');
  assert.equal(params.get('style'), 'crt');
  assert.equal(params.get('ui'), 'c.c.0_c.p.1_b.c.1');
});

test('explicit empty layers and panel state are v2-only', () => {
  const parsed = makeManager(
    '#v=2&lat=10&lon=20&style=crt&l=&ui=c.c.0_c.p.1_d.c.1_d.p.1',
  ).parseInitialHash();
  assert.deepEqual(parsed.layerState.enabledLayerIds, []);
  assert.deepEqual(parsed.panelState, { specs: [
    { id: 'control-panel', collapsed: false, pinned: true },
    { id: 'data-panel', collapsed: true, pinned: null },
  ] });
  const legacy = makeManager('#v=1&lat=10&lon=20&style=crt&l=&ui=c.c.0')
    .parseInitialHash();
  assert.equal(legacy.layerState, null);
  assert.equal(legacy.panelState, null);
});

test('camera-only, partial, and malformed panel shares remain valid incoming state', () => {
  const cameraOnly = makeManager('#lat=10&lon=20').parseInitialHash();
  assert.ok(cameraOnly);
  assert.equal(cameraOnly.panelState, null);

  const partial = makeManager('#v=2&lat=10&lon=20&ui=d.c.0').parseInitialHash();
  assert.deepEqual(partial.panelState, { specs: [
    { id: 'data-panel', collapsed: false, pinned: null },
  ] });

  for (const hash of [
    '#v=2&lat=10&lon=20&ui=',
    '#v=2&lat=10&lon=20&ui=unknown.c.1',
    '#v=2&lat=10&lon=20&ui=d.c.maybe',
  ]) {
    const malformed = makeManager(hash).parseInitialHash();
    assert.ok(malformed);
    assert.equal(malformed.panelState, null);
  }
});

// M5 (final review): the SPECIES panel's open state travels in a share link, so the recipient of a link with the species map on sees the
// panel's legend, taxon name and Top datasets credits. ui.js builds and restores the panels in SHARE_PANEL_STATE_SPECS, and sharelink.js
// encodes and decodes the panels in SHARE_PANEL_STATE_REGISTRY: a panel missing from either list is dropped, so both list the same panels.
test('a share link round-trips the SPECIES panel open, and ui.js and sharelink.js list the same panels', () => {
  const sender = makeManager();
  sender.setPanelStateProvider(() => ({ specs: [{ id: 'data-panel', collapsed: true }, { id: 'species-panel', collapsed: false }] }));
  clearTimeout(sender._debounceTimer);
  sender._updateHash();
  const hash = window.location.hash;
  const received = makeManager(hash).parseInitialHash();
  assert.deepEqual(received.panelState, { specs: [
    { id: 'data-panel', collapsed: true, pinned: null },
    { id: 'species-panel', collapsed: false, pinned: null },
  ] }, `round trip through ${hash}`);
  const ids = (source, start) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `missing ${start}`);
    return [...source.slice(from, source.indexOf(']);', from)).matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
  };
  const uiIds = ids(uiSource, 'const SHARE_PANEL_STATE_SPECS = Object.freeze([');
  const registryIds = ids(fs.readFileSync(new URL('./sharelink.js', import.meta.url), 'utf8'), 'const SHARE_PANEL_STATE_REGISTRY = Object.freeze([');
  assert.ok(registryIds.length >= 4, `positive control: the registry's panels are read (${registryIds})`);
  assert.ok(uiIds.includes('species-panel'), `ui.js shares species-panel: ${uiIds}`);
  assert.deepEqual(uiIds, registryIds, 'ui.js and sharelink.js list the same panels in the same order');
});

// Both `bing-road` and the `k` panel token belonged to the retired left Map
// Stack panel. Nothing is owed to a link that carried them — no build with
// either one ever shipped publicly — so the parser no longer knows them, and
// each takes the ordinary unknown path: an unrecognized panel token is skipped,
// and an unrecognized stack id lands on the controller's Esri fallback
// (pinned in `src/mapStackChips.test.mjs` and live in `scripts/qa-map-source-tray.mjs`).
// The camera half of such a link must still restore.
test('a retired-vocabulary link degrades to the unknown paths instead of failing', () => {
  const parsed = makeManager('#v=2&lat=10&lon=20&map=bing-road&ui=k.c.0').parseInitialHash();
  assert.equal(parsed.lat, 10);
  assert.equal(parsed.lon, 20);
  assert.equal(parsed.panelState, null);
});

test('non-finite camera coordinates fail closed without reserving restoration', () => {
  for (const hash of [
    '#lat=Infinity&lon=20',
    '#lat=10&lon=-Infinity',
    '#lat=1e309&lon=20',
    '#v=2&lat=%2BInfinity&lon=20',
  ]) {
    const manager = makeManager(hash);
    assert.equal(manager.parseInitialHash(), null, hash);
    assert.equal(manager._initialRestorePending, false, hash);
  }

  assert.ok(makeManager('#lat=10&lon=20').parseInitialHash());
  assert.ok(makeManager('#v=2&lat=-10.5&lon=20.25').parseInitialHash());
});

test('incoming state suppresses premature hash replacement until restoration', () => {
  const manager = makeManager('#v=2&lat=10&lon=20&l=e&style=nvg');
  manager.parseInitialHash();
  manager._updateHash();
  assert.equal(window.location.hash, '#v=2&lat=10&lon=20&l=e&style=nvg');
});

test('copy timestamp parsing is strict and rejects malformed or future values', () => {
  const nowMs = 2_000_000;
  assert.equal(decodeShareCreatedAtMs(new URLSearchParams('at=1999'), { nowMs }), 1_999_000);
  for (const raw of ['', '0', '-1', '1.5', 'abc', '001', '9007199254740992']) {
    assert.equal(
      decodeShareCreatedAtMs(new URLSearchParams(`at=${encodeURIComponent(raw)}`), { nowMs }),
      null,
      raw,
    );
  }
  assert.equal(decodeShareCreatedAtMs(new URLSearchParams('at=2001'), { nowMs }), null);
});

test('copy adds a fresh ephemeral timestamp without aging the live URL', async () => {
  const copied = [];
  installClipboard(async (url) => { copied.push(url); });
  const manager = makeManager();
  manager._updateHash();
  const liveHash = window.location.hash;

  assert.equal(await manager.copyLink({ nowMs: 2_000_000 }), true);
  assert.equal(await manager.copyLink({ nowMs: 2_002_000 }), true);
  assert.equal(new URL(copied[0]).hash.includes('at=2000'), true);
  assert.equal(new URL(copied[1]).hash.includes('at=2002'), true);
  assert.equal(window.location.hash, liveHash);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('at'), false);
});

test('copy snapshots current state while incoming hash writes are still suppressed', async () => {
  let copied = null;
  installClipboard(async (url) => { copied = url; });
  const manager = makeManager('#v=2&lat=10&lon=20&l=e&at=100');
  manager.parseInitialHash();
  assert.equal(manager._initialRestorePending, true);
  assert.equal(await manager.copyLink({ nowMs: 3_000_000 }), true);
  const params = new URL(copied).hash.slice(1);
  assert.equal(new URLSearchParams(params).get('at'), '3000');
  assert.equal(window.location.hash, '#v=2&lat=10&lon=20&l=e&at=100');
});

test('clipboard rejection leaves both live URL and restore suppression untouched', async () => {
  installClipboard(async () => { throw new Error('denied'); });
  const manager = makeManager('#v=2&lat=10&lon=20&l=s');
  manager.parseInitialHash();
  assert.equal(await manager.copyLink({ nowMs: 4_000_000 }), false);
  assert.equal(window.location.hash, '#v=2&lat=10&lon=20&l=s');
  assert.equal(manager._initialRestorePending, true);
});

// ── `sce` is a BAND, not a free number (review round 2) ───────────────────────
//
// The terminus is documented and supported as 94..100. Parsing clamped to
// 0..100, so `sce=0` produced an unsupported sub-94 terminus — a hole in the
// mask, not a scope — and the next hash write serialized it straight back out.

test('share-link restore forces a final stationary render', () => {
  const calls = { flyTo: null, setView: null, renders: 0 };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
      flyTo(options) { calls.flyTo = options; },
      setView(options) { calls.setView = options; },
    },
    scene: { requestRender() { calls.renders += 1; } },
  };
  const manager = new ShareLinkManager(viewer);
  manager.applyState({
    lat: 40.7669,
    lon: -73.9909,
    alt: 396,
    heading: 206,
    pitch: -22,
    roll: 0,
  });

  assert.ok(calls.flyTo, 'restore must start a camera flight');
  assert.equal(typeof calls.flyTo.complete, 'function');
  calls.flyTo.complete();
  assert.deepEqual(calls.setView, {
    destination: calls.flyTo.destination,
    orientation: calls.flyTo.orientation,
  });
  assert.equal(calls.renders, 1);
});

test('newer navigation suppresses delayed share camera while non-camera state still restores', async () => {
  let flights = 0;
  let restored = null;
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo() { flights += 1; },
    },
  };
  const manager = new ShareLinkManager(viewer, {
    onRestore: (state) => { restored = state; },
    isNavigationCurrent: () => false,
  });
  const applied = await manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
    style: 'thermal', panelState: { specs: [] },
  }, { navigationToken: 4 });
  assert.equal(applied.succeeded, true);
  assert.equal(flights, 0);
  assert.equal(restored.style, 'thermal');
});

test('newer visual, map, and individual panel actions suppress only their owned restore lanes', async () => {
  let restored = null;
  const manager = makeManager(
    '#v=2&lat=40&lon=-74&style=flir&map=osm&ui=c.c.0_d.c.0',
  );
  manager._onRestore = (state) => { restored = state; };
  manager._isNavigationCurrent = () => false;
  const state = manager.parseInitialHash();

  manager.claimRestoreLane('visual');
  manager.claimRestoreLane('map');
  manager.claimRestoreLane('panel', 'control-panel');
  const result = await manager.applyState(state, { navigationToken: 1 });

  assert.equal(restored.style, undefined);
  assert.equal(restored.mapStack, undefined);
  assert.deepEqual(restored.panelState, {
    specs: [{ id: 'data-panel', collapsed: false, pinned: null }],
  });
  assert.equal(result.visual, 'superseded');
  assert.equal(result.map, 'superseded');
  assert.equal(result.panels, 'applied');
  assert.equal(manager._initialRestorePending, true);
  manager.completeInitialRestore();
  assert.equal(manager._initialRestorePending, false);
});

test('every explicit visual gesture claims restore authority before it mutates state', () => {
  const initUi = sourceBlock('  _initUI() {', '  _initMapStackControl() {');
  const hotkey = initUi.slice(
    initUi.indexOf("if (e.key.toLowerCase() === 'h')"),
    initUi.indexOf("if (e.key.toLowerCase() === 'o')"),
  );
  assertClaimsBefore(hotkey, 'this.hud.toggle()', 'HUD hotkey');
  const style = sourceBlock('  setStyle(styleName, {', '  _startTransition(styleName, fromValue, toValue) {');
  assertClaimsBefore(style, 'this.activeStyle = styleName', 'setStyle');
});

test('share apply completion waits for both callback work and camera settlement', async () => {
  let flight = null;
  let releaseRestore;
  const restoreGate = new Promise((resolve) => { releaseRestore = resolve; });
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo(options) { flight = options; },
      setView() {},
    },
    scene: { requestRender() {} },
  };
  const manager = new ShareLinkManager(viewer, { onRestore: () => restoreGate });
  let settled = false;
  const applying = manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }).then((result) => { settled = true; return result; });

  await Promise.resolve();
  assert.equal(settled, false);
  releaseRestore();
  await Promise.resolve();
  assert.equal(settled, false);
  flight.complete();
  const result = await applying;
  assert.equal(result.camera, 'applied');
  assert.equal(settled, true);
});

test('a later navigation prevents share completion from resetting the final pose', () => {
  let generation = 3;
  let flight = null;
  let setViews = 0;
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo(options) { flight = options; },
      setView() { setViews += 1; },
    },
    scene: { requestRender() {} },
  };
  const manager = new ShareLinkManager(viewer, {
    isNavigationCurrent: (token) => token === generation,
  });
  manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }, { navigationToken: 3 });
  generation = 4;
  flight.complete();
  assert.equal(setViews, 0);
});

test('destroy cancels only a still-owned share flight and ignores delayed completion', () => {
  let generation = 7;
  let flight = null;
  let cancellations = 0;
  let setViews = 0;
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      flyTo(options) { flight = options; },
      setView() { setViews += 1; },
    },
    scene: { requestRender() {} },
  };
  const manager = new ShareLinkManager(viewer, {
    isNavigationCurrent: (token) => token === generation,
    cancelOwnedNavigation: () => { cancellations += 1; flight?.cancel?.(); },
  });
  manager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }, { navigationToken: 7 });
  manager.destroy();
  flight.complete();
  assert.equal(cancellations, 1);
  assert.equal(setViews, 0);

  const newerManager = new ShareLinkManager(viewer, {
    isNavigationCurrent: (token) => token === generation,
    cancelOwnedNavigation: () => { cancellations += 1; },
  });
  newerManager.applyState({
    lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0,
  }, { navigationToken: 7 });
  generation = 8;
  newerManager.destroy();
  assert.equal(cancellations, 1, 'newer navigation must not be cancelled');
});
