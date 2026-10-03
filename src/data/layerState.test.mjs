import test from 'node:test';
import assert from 'node:assert/strict';

import { DataLayerManager } from './manager.js';
import {
  LAYER_STATE_REGISTRY,
  LAYER_STATE_STORAGE_KEY,
  LayerStateCoordinator,
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
  normalizeLayerState,
  parseStoredLayerState,
  serializeStoredLayerState,
  validateLayerStateRegistry,
} from './layerState.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function paramsForLayer(id) {
  if (id === 'birds') return { columns: false, drape: true, particles: true };
  if (id === 'species') return { taxonKey: null, years: 'recent', radiusKm: 10 };
  return null;
}

function fakeLayer(id, hooks = {}) {
  let params = paramsForLayer(id);
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    async init() { return hooks.init ? hooks.init() : true; },
    async enable() { return hooks.enable ? hooks.enable() : true; },
    async update() { return hooks.update ? hooks.update() : true; },
    async disable() { return hooks.disable ? hooks.disable() : true; },
    ...(params ? {
      setParams(next = {}, options = {}) {
        if (hooks.setParams && hooks.setParams(next, options) === false) return false;
        params = { ...params, ...next };
        return true;
      },
      getParams() { return { ...params }; },
    } : {}),
  };
}

function productionManager(hooksById = {}) {
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS) manager.register(fakeLayer(id, hooksById[id] || {}));
  manager.finalizeRegistrations(LAYER_STATE_REGISTRY);
  return manager;
}

function memoryStorage(initial = null) {
  const values = new Map();
  if (initial !== null) values.set(LAYER_STATE_STORAGE_KEY, initial);
  return {
    writes: [],
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      values.set(key, value);
      this.writes.push([key, value]);
    },
  };
}

function shareSink() {
  return {
    provider: null,
    updates: 0,
    setLayerStateProvider(provider) { this.provider = provider; },
    onLayerStateChange() { this.updates += 1; },
  };
}

function encode(state) {
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(params, state);
  return params.toString();
}

test('production registry is exact, canonical, and rejects incomplete contracts', async () => {
  assert.equal(validateLayerStateRegistry(), true);
  assert.equal(REGISTERED_LAYER_IDS.length, 48);
  assert.equal(new Set(REGISTERED_LAYER_IDS).size, 48);
  assert.deepEqual(REGISTERED_LAYER_IDS, [...REGISTERED_LAYER_IDS].sort());
  for (const [id, token] of [
    ['biotime', 'bt'],
    ['gibs-amphibians', 'am'],
    ['gibs-mammals', 'mm'],
    ['gibs-biomass', 'gd'],
    ['gibs-evi', 'ev'],
    ['gibs-landcover', 'lc'],
    ['gibs-lst', 'ls'],
    ['gibs-nightlights', 'bm'],
    ['hansen-loss', 'hl'],
    ['gmw', 'mg'],
    ['griis', 'gr'],
    ['surface-water', 'sw'],
    ['human-footprint', 'hf'],
    ['bii', 'bi'],
    ['wetlands', 'wl'],
    ['obis-grid', 'ob'],
    ['protected-areas', 'pa'],
    ['camera-traps', 'ct'],
    ['edna', 'dn'],
  ]) {
    assert.equal(LAYER_STATE_REGISTRY.find((e) => e.id === id)?.token, token, `${id} share token`);
  }
  assert.throws(
    () => validateLayerStateRegistry([...LAYER_STATE_REGISTRY, LAYER_STATE_REGISTRY[0]]),
    /Duplicate layer-state id/,
  );
  // Tokens may be one or two chars (36 one-char tokens ran out at 35 layers, 2026-09-12);
  // three is out of grammar. Mutant seen failing: restoring /^[a-z0-9]$/ rejects 'zz'.
  const twoChar = Object.freeze({ id: 'zz-layer', token: 'zz', disposition: 'enabled-only' });
  assert.equal(validateLayerStateRegistry([...LAYER_STATE_REGISTRY, twoChar]), true);
  assert.throws(
    () => validateLayerStateRegistry([...LAYER_STATE_REGISTRY, { ...twoChar, token: 'zzz' }]),
    /Invalid layer-state token/,
  );

  const manager = new DataLayerManager({});
  manager.register(fakeLayer('occurrences'));
  assert.throws(() => manager.register(fakeLayer('occurrences')), /Duplicate data-layer id/);
  await assert.rejects(manager.restoreLayerState('occurrences', { enabled: true }), /finalized/);
  assert.throws(() => manager.finalizeRegistrations([]), /registry mismatch/);
  assert.throws(
    () => manager.finalizeRegistrations([{ id: 'occurrences', disposition: 'default' }]),
    /Invalid layer serialization disposition/,
  );
  assert.equal(manager.finalizeRegistrations([
    { id: 'occurrences', disposition: 'enabled-only' },
  ]), true);
  assert.throws(() => manager.register(fakeLayer('tracks')), /finalized/);
  assert.throws(() => manager.registerForQa(fakeLayer('tracks')), /not authorized/);
  const qaManager = new DataLayerManager({}, { allowQaRegistration: true });
  qaManager.register(fakeLayer('occurrences'));
  qaManager.finalizeRegistrations([{ id: 'occurrences', disposition: 'enabled-only' }]);
  qaManager.registerForQa(fakeLayer('tracks'));
  assert.equal(qaManager.layers.has('tracks'), true);
  assert.equal(await qaManager.unregisterForQa('tracks'), true);
  assert.equal(qaManager.layers.has('tracks'), false);
});

test('v2 codec distinguishes absent from empty and keeps canonical deterministic ordering', () => {
  assert.equal(decodeLayerStateParams(new URLSearchParams('lat=1&lon=2')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=1&l=o')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=3&l=o')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2')), null);

  const empty = decodeLayerStateParams(new URLSearchParams('v=2&l='));
  assert.deepEqual(empty.enabledLayerIds, []);
  assert.deepEqual(empty.options, {
    birds: { columns: false, drape: true, particles: true },
    species: { taxonKey: null, years: 'recent', radiusKm: 10 },
  });

  const first = normalizeLayerState({
    enabledLayerIds: ['tracks', 'species', 'occurrences', 'species'],
    options: {
      species: { radiusKm: 50, years: 'all', taxonKey: 212 },
      birds: { particles: false, columns: true },
    },
  });
  const second = normalizeLayerState({
    enabledLayerIds: ['occurrences', 'species', 'tracks'],
    options: {
      birds: { columns: true, particles: false },
      species: { taxonKey: 212, years: 'all', radiusKm: 50 },
    },
  });
  assert.deepEqual(first.enabledLayerIds, ['occurrences', 'species', 'tracks'],
    'registry order, deduplicated, regardless of request order');
  assert.equal(encode(first), encode(second));
  assert.deepEqual(decodeLayerStateParams(new URLSearchParams(encode(first))), first);
});

test('unknown enabled-layer tokens reject the payload instead of becoming an empty set', () => {
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2&l=z')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2&l=c.z')), null);
});

test('retired God\'s Eye tokens are ignored so an old link keeps its wildlife layers', () => {
  // `e` was earthquakes until the God's Eye layers were removed (2026-09-26). A link made before
  // then must still switch on its wildlife layers instead of losing the whole payload.
  const oldLink = decodeLayerStateParams(new URLSearchParams('v=2&l=e.o'));
  assert.notEqual(oldLink, null, 'a retired token must not reject the payload');
  assert.deepEqual(oldLink.enabledLayerIds, ['occurrences']);

  // Every retired token at once, still keeping the wildlife layer.
  const allRetired = decodeLayerStateParams(new URLSearchParams(
    'v=2&l=a.b.c.d.e.f.g.i.m.q.r.s.t.u.w.x.o',
  ));
  assert.deepEqual(allRetired?.enabledLayerIds, ['occurrences']);

  // A token that was never issued is still rejected, exactly like the unknown-token rule.
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2&l=zz.o')), null);
});

test('unknown and forbidden option fields are ignored while missing options use codec defaults', () => {
  const decoded = decodeLayerStateParams(new URLSearchParams(
    'v=2&l=n.o&lo=n.c.1_n.z.1_z.c.1_o.c.1_n.d.0.extra_sp.y.a_sp.q.1',
  ));
  assert.deepEqual(decoded.enabledLayerIds, ['birds', 'occurrences']);
  assert.deepEqual(decoded.options.birds, {
    columns: true,
    drape: true,
    particles: true,
  });
  assert.deepEqual(decoded.options.species, {
    taxonKey: null,
    years: 'all',
    radiusKm: 10,
  });

  const raw = normalizeLayerState({
    enabledLayerIds: ['birds', 'unknown-layer'],
    options: {
      birds: {
        columns: true,
        privateNote: 'do-not-share',
        calibration: { secret: 'hidden' },
      },
      species: { taxonKey: 5133088, selectedOccurrenceId: 'private-occurrence' },
      'unknown-layer': { leaked: 'unknown-owner' },
    },
  });
  const serialized = `${encode(raw)} ${serializeStoredLayerState(raw)}`;
  for (const forbidden of [
    'privateNote', 'do-not-share', 'calibration', 'secret', 'hidden',
    'selectedOccurrenceId', 'private-occurrence', 'unknown-layer', 'leaked', 'unknown-owner',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  // Positive control: the legitimate fields in the same payload are serialized.
  assert.match(encode(raw), /n\.c\.1/);
  assert.match(encode(raw), /sp\.k\.5133088/);
});

test('compact URL omits default option state and still resolves to it', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['birds', 'species'];
  // Spelled out rather than reused from createDefaultLayerState() on purpose:
  // this is the ledger of what an OMITTED token means, so changing any of these
  // fails HERE and forces the change to be acknowledged.
  state.options.birds = { columns: false, drape: true, particles: true };
  state.options.species = { taxonKey: null, years: 'recent', radiusKm: 10 };
  const params = encodeLayerStateParams(new URLSearchParams('v=2'), state);
  assert.equal(params.has('lo'), false);
  const roundTrip = decodeLayerStateParams(params);
  assert.deepEqual(roundTrip.options.birds, { columns: false, drape: true, particles: true });
  assert.deepEqual(roundTrip.options.species, { taxonKey: null, years: 'recent', radiusKm: 10 });

  // Positive control: one non-default value is emitted, and only that one.
  state.options.birds = { ...state.options.birds, drape: false };
  const changed = encodeLayerStateParams(new URLSearchParams('v=2'), state);
  assert.equal(changed.get('lo'), 'n.d.0');
  assert.equal(decodeLayerStateParams(changed).options.birds.drape, false);
});

test('stored state is deterministic, rejects other versions, and stays within a tested URL bound', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = [...REGISTERED_LAYER_IDS].reverse();
  // Every option away from its default, so every option token is emitted.
  state.options.birds = { columns: true, drape: false, particles: false };
  state.options.species = { taxonKey: 2_147_483_647, years: 'all', radiusKm: 50 };
  const stored = serializeStoredLayerState(state);
  assert.deepEqual(parseStoredLayerState(stored), normalizeLayerState(state));
  assert.equal(parseStoredLayerState('{"v":1,"l":[]}'), null);
  const url = encode(state);
  assert.equal(new URLSearchParams(url).get('lo').split('_').length, 6, url);
  assert.equal(new URLSearchParams(url).get('l').split('.').length, REGISTERED_LAYER_IDS.length, url);
  assert.ok(url.length < 420, url);
});

test('restore applies sanitized params after init and before enable', async () => {
  const order = [];
  const manager = productionManager({
    birds: {
      init: () => { order.push('init'); return true; },
      setParams: () => { order.push('params'); return true; },
      enable: () => { order.push('enable'); return true; },
      update: () => { order.push('update'); return true; },
    },
  });
  const outcome = await manager.restoreLayerState('birds', {
    enabled: true,
    params: { columns: true, drape: false },
  }, { origin: 'share-restore' });
  assert.deepEqual(order, ['init', 'params', 'enable', 'update']);
  assert.equal(outcome.succeeded, true);
  assert.equal(outcome.persistenceWrite, false);
  assert.deepEqual(outcome.appliedOptions, { columns: true, drape: false });
});

test('manager forwards passive restore origin into module parameter application', async () => {
  const seen = [];
  const manager = productionManager({
    birds: {
      setParams: (_params, options) => { seen.push(options); },
    },
  });
  await manager.restoreLayerState('birds', {
    enabled: false,
    params: { columns: true },
  }, { origin: 'share-restore' });
  assert.deepEqual(seen, [{ origin: 'share-restore', paramsIntentEpoch: 1 }]);
});

test('share payload wins over local, passive restore writes nothing, and explicit success persists', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['tracks'];
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const share = shareSink();
  const coordinator = new LayerStateCoordinator(manager, share, { storage });
  const explicitEmpty = createDefaultLayerState();
  await coordinator.start({ shareLayerState: explicitEmpty });

  assert.equal(coordinator.source, 'share');
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, []);
  assert.deepEqual(storage.writes, []);
  assert.equal(share.provider().enabledLayerIds.length, 0);

  await manager.setEnabled('occurrences', true, { origin: 'user' });
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, ['occurrences']);
  assert.equal(storage.writes.length, 1);

  await manager.setEnabled('tracks', true, { origin: 'scene' });
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, ['occurrences']);

  await manager.setEnabled('tracks', true, { origin: 'tool' });
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, ['occurrences', 'tracks']);

  manager.setLayerParams('birds', { privateNote: 'do-not-share' }, { origin: 'user' });
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(coordinator.getDurableState().options.birds, {
    columns: false,
    drape: true,
    particles: true,
  });

  manager.setLayerParams('birds', { columns: true }, { origin: 'scene' });
  assert.equal(storage.writes.length, 2);
  assert.equal(coordinator.getDurableState().options.birds.columns, false);

  manager.setLayerParams('birds', { columns: true }, { origin: 'voice' });
  assert.equal(storage.writes.length, 3);
  assert.equal(coordinator.getDurableState().options.birds.columns, true);
  coordinator.destroy();
});

test('absent share payload restores local state without rewriting it', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['occurrences', 'species'];
  local.options.species = { taxonKey: 5133088, years: 'all', radiusKm: 50 };
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage });
  const results = await coordinator.start();
  assert.equal(coordinator.source, 'local');
  assert.equal(manager.isEnabled('occurrences'), true);
  assert.equal(manager.isEnabled('species'), true);
  assert.deepEqual(manager.getLayerParams('species'), {
    taxonKey: 5133088,
    years: 'all',
    radiusKm: 50,
  });
  assert.equal(results.every((result) => result.persistenceWrite === false), true);
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('historical share payload suppresses unrelated local layer preferences', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['tracks', 'species'];
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage });
  await coordinator.start({ allowLocalState: false });
  assert.equal(coordinator.source, 'legacy-share');
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, []);
  assert.equal(manager.getEnabledLayerIds().size, 0);
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('one layer failure is isolated from sibling restoration', async () => {
  const manager = productionManager({
    species: { init: () => { throw new Error('missing key'); } },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['species', 'occurrences'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });
  const results = await coordinator.start({ shareLayerState: state });
  assert.equal(manager.isEnabled('species'), false);
  assert.equal(manager.isEnabled('occurrences'), true);
  const failed = results.find((result) => result.layerId === 'species');
  assert.equal(failed.succeeded, false);
  assert.equal(failed.phase, 'init');
  assert.equal(failed.errorClass, 'Error');
  assert.equal(failed.error, 'missing key');
  assert.equal(results.find((result) => result.layerId === 'occurrences').succeeded, true);
  coordinator.destroy();
});

test('later explicit visibility during delayed restore wins for that layer only', async () => {
  const gate = deferred();
  const manager = productionManager();
  const storage = memoryStorage();
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['tracks', 'occurrences'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
    restoreGate: gate.promise,
  });
  const restore = coordinator.start({ shareLayerState: state });
  await manager.setEnabled('tracks', false, { origin: 'user' });
  gate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('tracks'), false);
  assert.equal(manager.isEnabled('occurrences'), true);
  assert.equal(results.find((result) => result.layerId === 'tracks').cancellationReason, 'superseded');
  assert.equal(storage.writes.length, 1);
  coordinator.destroy();
});

test('share restore waits for a superseding same-target visibility successor', async () => {
  const firstUpdateStarted = deferred();
  const releaseFirstUpdate = deferred();
  const secondUpdateStarted = deferred();
  const releaseSecondUpdate = deferred();
  let updateCount = 0;
  const manager = productionManager({
    tracks: {
      update: async () => {
        updateCount += 1;
        if (updateCount === 1) {
          firstUpdateStarted.resolve();
          await releaseFirstUpdate.promise;
        } else if (updateCount === 2) {
          secondUpdateStarted.resolve();
          await releaseSecondUpdate.promise;
        }
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['tracks'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });

  let restoreSettled = false;
  const restore = coordinator.start({ shareLayerState: state })
    .then((result) => { restoreSettled = true; return result; });
  await firstUpdateStarted.promise;
  let successorSettled = false;
  const explicitOn = manager.setEnabled('tracks', true, { origin: 'user' })
    .then((result) => { successorSettled = true; return result; });
  releaseFirstUpdate.resolve();
  await secondUpdateStarted.promise;
  await Promise.resolve();
  assert.equal(restoreSettled, false, 'aggregate must wait for the authoritative successor');
  assert.equal(successorSettled, false);

  releaseSecondUpdate.resolve();
  assert.equal(await explicitOn, true);
  const results = await restore;
  const tracks = results.find((result) => result.layerId === 'tracks');
  assert.equal(tracks.cancellationReason, 'superseded');
  assert.equal(tracks.successorEnabled, true);
  assert.equal(tracks.authoritativeIntentEpoch, tracks.successorIntentEpoch);
  assert.equal(tracks.authoritativeEnabled, true);
  assert.equal(tracks.succeeded, true);
  assert.equal(manager.getLayerLifecycleState('tracks').lifecycleState, 'enabled');
  coordinator.destroy();
});

test('share restore waits for a superseding opposite-target visibility successor', async () => {
  const updateStarted = deferred();
  const releaseUpdate = deferred();
  const disableStarted = deferred();
  const releaseDisable = deferred();
  const manager = productionManager({
    tracks: {
      update: async () => {
        updateStarted.resolve();
        await releaseUpdate.promise;
        return true;
      },
      disable: async () => {
        disableStarted.resolve();
        await releaseDisable.promise;
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['tracks'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), { storage: memoryStorage() });

  let restoreSettled = false;
  const restore = coordinator.start({ shareLayerState: state })
    .then((result) => { restoreSettled = true; return result; });
  await updateStarted.promise;
  const explicitOff = manager.setEnabled('tracks', false, { origin: 'user' });
  releaseUpdate.resolve();
  await disableStarted.promise;
  await Promise.resolve();
  assert.equal(restoreSettled, false, 'aggregate must wait for the OFF successor to settle');

  releaseDisable.resolve();
  assert.equal(await explicitOff, true);
  const results = await restore;
  const tracks = results.find((result) => result.layerId === 'tracks');
  assert.equal(tracks.cancellationReason, 'superseded');
  assert.equal(tracks.successorEnabled, false);
  assert.equal(tracks.authoritativeIntentEpoch, tracks.successorIntentEpoch);
  assert.equal(tracks.authoritativeEnabled, false);
  assert.equal(tracks.succeeded, false, 'the newer OFF must not count as successful shared ON');
  assert.equal(manager.getLayerLifecycleState('tracks').lifecycleState, 'disabled');
  coordinator.destroy();
});

test('later explicit params during init replace options without cancelling visibility', async () => {
  const initGate = deferred();
  const initStarted = deferred();
  const manager = productionManager({
    birds: {
      init: async () => {
        initStarted.resolve();
        await initGate.promise;
        return true;
      },
    },
  });
  const storage = memoryStorage();
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['birds'];
  state.options.birds = { columns: true, drape: false, particles: true };
  const share = shareSink();
  const coordinator = new LayerStateCoordinator(manager, share, { storage });
  const restore = coordinator.start({ shareLayerState: state });
  await initStarted.promise;
  assert.equal(manager.setLayerParams('birds', {
    columns: false,
    drape: true,
  }, { origin: 'user' }), true);
  initGate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('birds'), true);
  assert.deepEqual(coordinator.getDurableState().options.birds, {
    columns: false,
    drape: true,
    particles: true,
  });
  assert.deepEqual(manager.getLayerParams('birds'), {
    columns: false,
    drape: true,
    particles: true,
  }, 'the passive share options did not overwrite the later explicit ones');
  assert.equal(results.find((result) => result.layerId === 'birds').succeeded, true);
  assert.equal(storage.writes.length, 1);
  assert.equal(
    new URLSearchParams(encode(share.provider())).get('lo'),
    null,
    'the superseded shared options are gone from the generated link',
  );
  coordinator.destroy();
});

// ---------------------------------------------------------------------------
// Share payloads are untrusted input and must be BOUNDED: an oversized field
// fails closed exactly like an unknown layer token, never decoding a prefix.
// ---------------------------------------------------------------------------

test('an oversized enabled-layer field fails closed instead of decoding a prefix', () => {
  assert.equal(
    decodeLayerStateParams(new URLSearchParams([['v', '2'], ['l', 'o.'.repeat(5_000)]])),
    null,
  );
  assert.equal(
    decodeLayerStateParams(new URLSearchParams([
      ['v', '2'], ['l', 'n'], ['lo', `n.c.1_${'n.d.0_'.repeat(20_000)}`],
    ])),
    null,
    'an oversized lo payload fails closed too',
  );
  // Positive control: the same fields at a legitimate size decode.
  const ok = decodeLayerStateParams(new URLSearchParams([['v', '2'], ['l', 'o.n'], ['lo', 'n.c.1']]));
  assert.deepEqual(ok.enabledLayerIds, ['birds', 'occurrences']);
  assert.equal(ok.options.birds.columns, true);
});

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
