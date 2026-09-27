// Camera-ownership policy for deferred destinations (the share-link restore
// flight). The ORDER is the contract: the release happens before the flight,
// and a deferred flight retires the moment ANY newer navigation intent claims
// the camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginDeferredNavigation,
  reassertNavigationHandoff,
} from './navigationPolicy.js';

/** Records every policy side effect in the order it happened. */
function spy(overrides = {}) {
  const log = [];
  return {
    log,
    stamp: () => log.push('stamp'),
    release: () => log.push('release'),
    ...overrides,
  };
}

/**
 * The wiring StyleManager applies: one generation counter advanced by every
 * navigation intent (the globe reset, a user gesture, a tracked entity taking
 * the camera). Deferred flights capture their stamp and recheck it before flying.
 */
function navigator() {
  const state = { generation: 0, log: [] };
  const stamp = () => { state.generation += 1; return state.generation; };
  const release = () => state.log.push('release');
  return {
    state,
    /** An intent whose flight resolves later (the share-link restore). */
    startDeferred() {
      return beginDeferredNavigation({ stamp });
    },
    /** The deferred flight finally resolving. */
    resolveDeferred(generation, label) {
      const cleared = reassertNavigationHandoff({
        generation,
        currentGeneration: state.generation,
        release,
      });
      if (cleared) state.log.push(`fly:${label}`);
      return cleared;
    },
    /** Any newer intent: the globe reset, a gesture, or entity tracking. */
    claim() {
      stamp();
    },
  };
}

test('deferred handoff: the current request re-releases, then proceeds', () => {
  const s = spy();
  const ok = reassertNavigationHandoff({ generation: 4, currentGeneration: 4, ...s });
  assert.equal(ok, true);
  assert.deepEqual(s.log, ['release']);
});

test('deferred intent stamps without releasing a camera owner', () => {
  const s = spy({ stamp: () => { s.log.push('stamp'); return 7; } });
  assert.equal(beginDeferredNavigation({ ...s }), 7);
  assert.deepEqual(s.log, ['stamp']);
});

test('disposed deferred intent is inert before stamp or UI mutation', () => {
  const s = spy();
  assert.equal(beginDeferredNavigation({ disposed: true, ...s }), false);
  assert.deepEqual(s.log, []);
});

test('disposed deferred work is inert before release', () => {
  const s = spy();
  assert.equal(reassertNavigationHandoff({
    generation: 4,
    currentGeneration: 4,
    disposed: true,
    ...s,
  }), false);
  assert.deepEqual(s.log, []);
});

test('deferred handoff: a superseded request neither flies nor releases', () => {
  // The newer intent owns the camera now — releasing here would yank it.
  const s = spy();
  const ok = reassertNavigationHandoff({ generation: 3, currentGeneration: 4, ...s });
  assert.equal(ok, false);
  assert.deepEqual(s.log, [], 'a stale flight must be completely inert');
});

test('interleaving: a newer intent during a deferred flight retires it', () => {
  const nav = navigator();
  const restoreGeneration = nav.startDeferred();
  nav.claim(); // the user resets the globe or a tracked entity takes the camera
  assert.equal(nav.resolveDeferred(restoreGeneration, 'restore'), false);
  assert.deepEqual(nav.state.log, [], 'the retired flight never released or flew');
});

test('interleaving: an uninterrupted deferred flight still flies', () => {
  const nav = navigator();
  const restoreGeneration = nav.startDeferred();
  assert.equal(nav.resolveDeferred(restoreGeneration, 'restore'), true);
  assert.deepEqual(nav.state.log, ['release', 'fly:restore']);
});

test('interleaving: the newest of two deferred flights wins', () => {
  const nav = navigator();
  const first = nav.startDeferred();
  const second = nav.startDeferred();
  assert.equal(nav.resolveDeferred(first, 'first'), false);
  assert.equal(nav.resolveDeferred(second, 'second'), true);
  assert.ok(!nav.state.log.includes('fly:first'));
  assert.ok(nav.state.log.includes('fly:second'));
});
