// Camera-ownership policy for user-issued destinations. The ORDER is the
// contract: the release happens before the flight, and a deferred flight retires the moment ANY newer
// navigation intent claims the camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginDeferredNavigation,
  reassertNavigationHandoff,
  runExplicitNavigation,
} from './navigationPolicy.js';

/** Records every policy side effect in the order it happened. */
function spy(overrides = {}) {
  const log = [];
  return {
    log,
    stamp: () => log.push('stamp'),
    release: () => log.push('release'),
    navigate: () => { log.push('navigate'); return 'flew'; },
    ...overrides,
  };
}

/**
 * The wiring StyleManager applies: one generation counter shared by every
 * explicit navigation intent AND by a tracked entity taking the camera.
 * Deferred flights capture their stamp and recheck it before flying.
 */
function navigator() {
  const state = { generation: 0, log: [] };
  const stamp = () => { state.generation += 1; return state.generation; };
  const release = () => state.log.push('release');
  return {
    state,
    /** One explicit intent that flies immediately. Returns its stamp, or false. */
    navigate(noun) {
      return runExplicitNavigation({
        stamp,
        release,
        navigate: (generation) => {
          state.log.push(`fly:${noun}`);
          return generation;
        },
      });
    },
    /** An intent whose flight resolves later (the geocoded search). */
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
    trackEntity() {
      // Mirrors StyleManager's trackedEntityChanged listener.
      stamp();
    },
  };
}

test('a free camera is stamped, released, then flown — in that order', () => {
  const s = spy();
  const result = runExplicitNavigation({ ...s });
  assert.equal(result, 'flew');
  assert.deepEqual(s.log, ['stamp', 'release', 'navigate']);
});

test('the accepted intent hands its stamp to the flight', () => {
  let seen = null;
  runExplicitNavigation({ stamp: () => 42, navigate: (generation) => { seen = generation; } });
  assert.equal(seen, 42, 'a deferred flight needs its stamp to recheck later');
});

test('disposed navigation is inert before any camera or UI mutation', () => {
  const s = spy();
  const result = runExplicitNavigation({ disposed: true, ...s });
  assert.equal(result, false);
  assert.deepEqual(s.log, []);
});

test('the refusal is a strict false, distinguishable from a flight result', () => {
  const refused = runExplicitNavigation({ disposed: true, navigate: () => 'flew' });
  assert.strictEqual(refused, false);
  // A navigate() that legitimately returns undefined is not a refusal.
  assert.strictEqual(runExplicitNavigation({ navigate: () => undefined }), undefined);
});

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

// Interleavings: the generation advances on EVERY explicit intent, not just on
// another search. A search-only token left all of these open — the stale search
// still held the current token and flew over the newer destination.
test('interleaving: a canned destination during a search retires the search', () => {
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  nav.navigate('location'); // user clicks a city pill while the geocode runs
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), false);
  assert.deepEqual(nav.state.log, ['release', 'fly:location']);
  assert.ok(!nav.state.log.includes('fly:search'), 'the stale search must not fly');
});

test('interleaving: a tracked entity taking the camera during a search retires it', () => {
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  nav.trackEntity();
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), false);
  assert.deepEqual(nav.state.log, [], 'the deferred search never released');
});

test('interleaving: an uninterrupted search still flies', () => {
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), true);
  assert.deepEqual(nav.state.log, ['release', 'fly:search']);
});

test('interleaving: the newest of two searches wins', () => {
  const nav = navigator();
  const first = nav.startDeferred('location');
  const second = nav.startDeferred('location');
  assert.equal(nav.resolveDeferred(first, 'first'), false);
  assert.equal(nav.resolveDeferred(second, 'second'), true);
  assert.ok(!nav.state.log.includes('fly:first'));
  assert.ok(nav.state.log.includes('fly:second'));
});
