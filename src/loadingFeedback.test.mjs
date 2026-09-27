import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregateLayerLoading,
  createGlobalStatusNotice,
  createLoadingFeedbackState,
  LOADING_FAILURE_DWELL_MS,
  normalizeLayerLoading,
  presentGlobalLoadingStatus,
  presentGlobalStatusNotice,
  presentLoadingFeedback,
  reduceLoadingFeedback,
} from './loadingFeedback.js';

test('universal status notices reuse the standard failure dwell', () => {
  const notice = createGlobalStatusNotice('Shared satellite is unavailable', 1000);
  assert.equal(notice.hideAt, null, 'finite dwell waits until first presentation');
  assert.equal(presentGlobalStatusNotice(notice, 1001).label, 'Shared satellite is unavailable');
  assert.equal(notice.hideAt, 1001 + LOADING_FAILURE_DWELL_MS);
  assert.deepEqual(presentGlobalStatusNotice(notice, notice.hideAt - 1), {
    state: 'error',
    label: 'Shared satellite is unavailable',
    detail: '',
  });
  assert.equal(presentGlobalStatusNotice(notice, notice.hideAt), null);
});

test('acquiring notices persist without a dwell until explicitly cleared', () => {
  const notice = createGlobalStatusNotice('ACQUIRING', 1000, {
    state: 'acquiring',
    detail: 'SHARED FLIGHT',
    persistent: true,
  });
  assert.equal(notice.hideAt, null);
  assert.deepEqual(presentGlobalStatusNotice(notice, 1_000_000), {
    state: 'acquiring',
    label: 'ACQUIRING',
    detail: 'SHARED FLIGHT',
  });
});

test('universal notice masks active loading only for its own fixed dwell', () => {
  const summary = aggregateLayerLoading([{ id: 'satellites', name: 'Satellites', lifecycleState: 'enabling' }]);
  let loading = reduceLoadingFeedback(createLoadingFeedbackState(), summary, 0);
  loading = reduceLoadingFeedback(loading, summary, 200);
  const notice = createGlobalStatusNotice('Shared satellite is unavailable', 300);

  assert.equal(presentGlobalLoadingStatus(notice, loading, summary, 301).label, 'Shared satellite is unavailable');
  assert.equal(presentGlobalLoadingStatus(notice, loading, summary, notice.hideAt).label, 'LOADING LIVE DATA');
});

test('terminal failure preempts a finite notice, whose full dwell starts afterward', () => {
  const active = aggregateLayerLoading([{ id: 'satellites', name: 'Satellites', lifecycleState: 'enabling' }]);
  let loading = reduceLoadingFeedback(createLoadingFeedbackState(), active, 0);
  loading = reduceLoadingFeedback(loading, active, 200);
  loading = reduceLoadingFeedback(loading, aggregateLayerLoading([]), 300, {
    type: 'visibility-failed', layerId: 'satellites', error: new Error('offline'),
  });
  const notice = createGlobalStatusNotice('Shared satellite is unavailable', 400);

  assert.equal(
    presentGlobalLoadingStatus(notice, loading, aggregateLayerLoading([]), 401).label,
    'LOAD FAILED',
  );
  assert.equal(notice.hideAt, null, 'masked finite notice has not started its dwell');
  loading = reduceLoadingFeedback(loading, aggregateLayerLoading([]), 5300);
  assert.equal(
    presentGlobalLoadingStatus(notice, loading, aggregateLayerLoading([]), 5300).label,
    'Shared satellite is unavailable',
  );
  assert.equal(notice.hideAt, 5300 + LOADING_FAILURE_DWELL_MS);
  assert.equal(
    presentGlobalLoadingStatus(notice, loading, aggregateLayerLoading([]), notice.hideAt - 1).label,
    'Shared satellite is unavailable',
  );
  assert.equal(presentGlobalLoadingStatus(notice, loading, aggregateLayerLoading([]), notice.hideAt), null);
});

test('persistent acquisition never hides an unrelated manager failure', () => {
  const active = aggregateLayerLoading([{
    id: 'traffic', name: 'Street Traffic', lifecycleState: 'enabling',
  }]);
  const idle = aggregateLayerLoading([]);
  let loading = reduceLoadingFeedback(createLoadingFeedbackState(), active, 0);
  loading = reduceLoadingFeedback(loading, active, 200);
  loading = reduceLoadingFeedback(loading, idle, 300, {
    type: 'visibility-failed', layerId: 'traffic', error: new Error('offline'),
  });
  const acquiring = createGlobalStatusNotice('ACQUIRING', 100, {
    state: 'acquiring',
    detail: 'SHARED FLIGHT',
    persistent: true,
  });

  assert.deepEqual(presentGlobalLoadingStatus(acquiring, loading, idle, 301), {
    state: 'error',
    label: 'LOAD FAILED',
    detail: '',
  });
  assert.equal(
    presentGlobalLoadingStatus(acquiring, loading, idle, 300 + LOADING_FAILURE_DWELL_MS - 1).label,
    'LOAD FAILED',
  );
  loading = reduceLoadingFeedback(loading, idle, 300 + LOADING_FAILURE_DWELL_MS);
  assert.equal(
    presentGlobalLoadingStatus(acquiring, loading, idle, 300 + LOADING_FAILURE_DWELL_MS).label,
    'ACQUIRING',
    'the still-owned acquisition resumes only after the full failure dwell is visible',
  );
});

test('replacement, repetition, and hidden-tab elapsed time use the newest fixed deadline', () => {
  const first = createGlobalStatusNotice('Shared satellite is unavailable', 100);
  const repeated = createGlobalStatusNotice('Shared satellite is unavailable', 200);
  const replacement = createGlobalStatusNotice('Shared satellite follow expired', 300);

  presentGlobalStatusNotice(first, 100);
  presentGlobalStatusNotice(repeated, 200);
  presentGlobalStatusNotice(replacement, 300);

  assert.ok(repeated.hideAt > first.hideAt, 'a repeated event is a new accessible notice epoch');
  assert.equal(presentGlobalStatusNotice(replacement, replacement.hideAt - 1).label, 'Shared satellite follow expired');
  assert.equal(presentGlobalStatusNotice(replacement, replacement.hideAt), null,
    'elapsed wall time while hidden expires the notice instead of replaying it');
});

test('universal notice lifecycle clears on dispose and uses the one top-center live region', () => {
  const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const disposeStart = ui.indexOf('  async dispose() {');
  const disposeEnd = ui.indexOf('\n  }\n', disposeStart);
  const dispose = ui.slice(disposeStart, disposeEnd);

  assert.match(dispose, /this\._globalStatusNotice = null;/);
  assert.match(html, /<div id="global-loading-status" role="status" aria-live="polite" aria-atomic="true" hidden>/);
});

test('normalizes lifecycle and refresh loading without owning manager state', () => {
  assert.equal(normalizeLayerLoading({ lifecycleState: 'enabling' }).loading, true);
  assert.equal(normalizeLayerLoading({ lifecycleState: 'disabling' }).disabling, true);
  assert.equal(normalizeLayerLoading({ enabled: true, stats: { loading: true, count: 8 } }).refresh, true);
  assert.equal(normalizeLayerLoading({ enabled: true, stats: { refreshing: true } }).refresh, true);
  assert.match(
    normalizeLayerLoading({ stats: { managerRefreshError: 'refresh failed' } }).error,
    /refresh failed/,
  );
});

test('delays initial loading so instant operations never flash', () => {
  const summary = aggregateLayerLoading([{ id: 'a', name: 'A', lifecycleState: 'enabling' }]);
  const pending = reduceLoadingFeedback(createLoadingFeedbackState(), summary, 100);
  assert.equal(pending.visible, false);
  const finished = reduceLoadingFeedback(pending, aggregateLayerLoading([]), 150);
  assert.equal(presentLoadingFeedback(finished, aggregateLayerLoading([]), 150), null);
});

test('reveals sustained loading and then a bounded completion state', () => {
  const summary = aggregateLayerLoading([{ id: 'a', name: 'A', lifecycleState: 'enabling' }]);
  const pending = reduceLoadingFeedback(createLoadingFeedbackState(), summary, 100);
  const visible = reduceLoadingFeedback(pending, summary, 300);
  assert.equal(presentLoadingFeedback(visible, summary, 300).label, 'LOADING LIVE DATA');
  const complete = reduceLoadingFeedback(visible, aggregateLayerLoading([]), 350);
  assert.equal(presentLoadingFeedback(complete, aggregateLayerLoading([]), 350).label, 'LOAD COMPLETE');
});

test('terminal loading feedback centers its label without an empty detail slot', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /#global-loading-status:is\(\[data-state='complete'\], \[data-state='cancelled'\], \[data-state='error'\]\)\s*\{[\s\S]*?justify-content:\s*center;[\s\S]*?text-align:\s*center;/,
  );
  assert.match(
    css,
    /#global-loading-status:is\(\[data-state='complete'\], \[data-state='cancelled'\], \[data-state='error'\]\) #global-loading-detail\s*\{\s*display:\s*none;/,
  );
});

test('distinguishes accepted-data refresh from initial loading', () => {
  const summary = aggregateLayerLoading([{
    id: 'a', name: 'A', enabled: true, lifecycleState: 'enabled', stats: { loading: true, count: 4 },
  }]);
  assert.equal(summary.refresh, true);
});

test('surfaces cancellation and failure terminal states', () => {
  const summary = aggregateLayerLoading([{ id: 'a', lifecycleState: 'enabling' }]);
  const pending = reduceLoadingFeedback(createLoadingFeedbackState(), summary, 0);
  const visible = reduceLoadingFeedback(pending, summary, 200);
  assert.equal(reduceLoadingFeedback(visible, aggregateLayerLoading([]), 250, {
    type: 'visibility-cancelled', layerId: 'a', cancelled: true,
  }).terminal, 'cancelled');
  assert.equal(reduceLoadingFeedback(visible, aggregateLayerLoading([]), 250, {
    type: 'visibility-failed', layerId: 'a', error: new Error('no'),
  }).terminal, 'error');
});

test('surfaces manager-owned refresh failure and recovery through the shared banner', () => {
  const refreshing = aggregateLayerLoading([{
    id: 'satellites',
    name: 'Satellites',
    enabled: true,
    lifecycleState: 'enabled',
    stats: { refreshing: true, count: 0, lastUpdate: null },
  }]);
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), refreshing, 0, {
    type: 'refresh-transition', layerId: 'satellites', refreshEpoch: 1,
  });
  state = reduceLoadingFeedback(state, refreshing, 200);
  assert.equal(presentLoadingFeedback(state, refreshing, 200).label, 'REFRESHING LIVE DATA');
  state = reduceLoadingFeedback(state, aggregateLayerLoading([]), 250, {
    type: 'refresh-failed', layerId: 'satellites', error: new Error('offline'), refreshEpoch: 1,
  });
  assert.equal(presentLoadingFeedback(state, aggregateLayerLoading([]), 250).label, 'LOAD FAILED');

  const recovered = reduceLoadingFeedback(state, refreshing, 6000, {
    type: 'refresh-transition', layerId: 'satellites', refreshEpoch: 2,
  });
  const complete = reduceLoadingFeedback(recovered, aggregateLayerLoading([]), 6200, {
    type: 'refresh', layerId: 'satellites', refreshEpoch: 2,
  });
  assert.equal(complete.terminal, 'complete');
});

test('AIS first-connect grace expiry reports failure even without a terminal manager event', () => {
  const waiting = aggregateLayerLoading([{
    id: 'ais-live-vessels',
    name: 'AIS Vessels',
    enabled: true,
    lifecycleState: 'enabled',
    stats: { loading: true, count: 0, lastUpdate: null },
  }]);
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), waiting, 0);
  state = reduceLoadingFeedback(state, waiting, 200);

  const unavailable = aggregateLayerLoading([{
    id: 'ais-live-vessels',
    name: 'AIS Vessels',
    enabled: true,
    lifecycleState: 'enabled',
    stats: {
      loading: false,
      count: 0,
      lastUpdate: null,
      status: 'unavailable',
      error: 'awaiting first AIS message…',
    },
  }]);
  state = reduceLoadingFeedback(state, unavailable, 300);

  assert.equal(state.terminal, 'error');
  assert.equal(presentLoadingFeedback(state, unavailable, 300).label, 'LOAD FAILED');
});

test('participant stats failure outranks a simultaneous visibility completion', () => {
  const enabling = aggregateLayerLoading([{
    id: 'ais-live-vessels',
    name: 'AIS Vessels',
    lifecycleState: 'enabling',
    stats: { loading: true },
  }]);
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), enabling, 0);
  state = reduceLoadingFeedback(state, enabling, 200);

  const missingKey = aggregateLayerLoading([{
    id: 'ais-live-vessels',
    name: 'AIS Vessels',
    enabled: true,
    lifecycleState: 'enabled',
    stats: { loading: false, keyRequired: true },
  }]);
  state = reduceLoadingFeedback(state, missingKey, 250, {
    type: 'visibility', layerId: 'ais-live-vessels', enabled: true,
  });

  assert.equal(state.terminal, 'error');
});

test('retains the worst terminal outcome until every concurrent load drains', () => {
  const both = aggregateLayerLoading([
    { id: 'a', name: 'A', lifecycleState: 'enabling' },
    { id: 'b', name: 'B', lifecycleState: 'enabling' },
  ]);
  const onlyB = aggregateLayerLoading([
    { id: 'b', name: 'B', lifecycleState: 'enabling' },
  ]);
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), both, 0, {
    type: 'visibility-transition', layerId: 'a',
  });
  state = reduceLoadingFeedback(state, both, 200, {
    type: 'visibility-transition', layerId: 'b',
  });
  state = reduceLoadingFeedback(state, onlyB, 250, {
    type: 'visibility-failed', layerId: 'a', error: new Error('A failed'),
  });
  assert.deepEqual(state.activeIds, ['a', 'b']);
  assert.equal(state.batchOutcome, 'error');
  state = reduceLoadingFeedback(state, onlyB, 300);
  state = reduceLoadingFeedback(state, aggregateLayerLoading([]), 350, {
    type: 'visibility', layerId: 'b', enabled: true,
  });
  assert.equal(state.terminal, 'error');
  assert.equal(presentLoadingFeedback(state, aggregateLayerLoading([]), 350).label, 'LOAD FAILED');
});

test('retains cancellation across overlapping success and resets it for a later epoch', () => {
  const both = aggregateLayerLoading([
    { id: 'a', name: 'A', lifecycleState: 'enabling' },
    { id: 'b', name: 'B', lifecycleState: 'enabling' },
  ]);
  const onlyB = aggregateLayerLoading([{ id: 'b', name: 'B', lifecycleState: 'enabling' }]);
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), both, 0);
  state = reduceLoadingFeedback(state, onlyB, 200, {
    type: 'visibility-cancelled', layerId: 'a', cancelled: true,
  });
  state = reduceLoadingFeedback(state, aggregateLayerLoading([]), 250, {
    type: 'visibility', layerId: 'b', enabled: true,
  });
  assert.equal(state.terminal, 'cancelled');

  const next = aggregateLayerLoading([{ id: 'c', name: 'C', lifecycleState: 'enabling' }]);
  state = reduceLoadingFeedback(state, next, 300, {
    type: 'visibility-transition', layerId: 'c',
  });
  assert.equal(state.batchOutcome, null);
  assert.deepEqual(state.activeIds, ['c']);
  state = reduceLoadingFeedback(state, aggregateLayerLoading([]), 500, {
    type: 'visibility', layerId: 'c', enabled: true,
  });
  assert.equal(state.terminal, 'complete');
});

test('ignores terminal events from layers outside the active loading epoch', () => {
  const active = aggregateLayerLoading([{ id: 'a', name: 'A', lifecycleState: 'enabling' }]);
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), active, 0);
  state = reduceLoadingFeedback(state, active, 200, {
    type: 'visibility-failed', layerId: 'unrelated', error: new Error('not this batch'),
  });
  assert.equal(state.batchOutcome, null);
  state = reduceLoadingFeedback(state, aggregateLayerLoading([]), 250, {
    type: 'visibility', layerId: 'a', enabled: true,
  });
  assert.equal(state.terminal, 'complete');
});

test('a final failure outranks an earlier success in the same loading epoch', () => {
  const both = aggregateLayerLoading([
    { id: 'a', lifecycleState: 'enabling' },
    { id: 'b', lifecycleState: 'enabling' },
  ]);
  const onlyB = aggregateLayerLoading([{ id: 'b', lifecycleState: 'enabling' }]);
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), both, 0);
  state = reduceLoadingFeedback(state, onlyB, 200, {
    type: 'visibility', layerId: 'a', enabled: true,
  });
  state = reduceLoadingFeedback(state, aggregateLayerLoading([]), 250, {
    type: 'visibility-failed', layerId: 'b', error: new Error('B failed'),
  });
  assert.equal(state.terminal, 'error');
});

test('describes disable work without reporting it as a completed load', () => {
  const summary = aggregateLayerLoading([{
    id: 'a', name: 'A', enabled: true, lifecycleState: 'disabling',
  }]);
  const pending = reduceLoadingFeedback(createLoadingFeedbackState(), summary, 0);
  const visible = reduceLoadingFeedback(pending, summary, 200);
  assert.equal(presentLoadingFeedback(visible, summary, 200).label, 'TURNING OFF LIVE DATA');
  const complete = reduceLoadingFeedback(visible, aggregateLayerLoading([]), 250);
  assert.equal(presentLoadingFeedback(complete, aggregateLayerLoading([]), 250).label, 'LIVE DATA OFF');
});

test('a flow failure landing after the roads settle still ends the batch as LOAD FAILED', () => {
  // Traffic's 250 ms paint race lets a TomTom request outlive the road load
  // that started it. The layer keeps stats.loading true while it still owns
  // that request, so the batch cannot close early and report LOAD COMPLETE
  // over a failure that has not landed yet.
  const sample = (stats) => aggregateLayerLoading([
    { id: 'traffic', name: 'Street Traffic', enabled: true, lifecycleState: 'enabled', stats },
  ]);
  // Roads loading; flow request outstanding.
  const roadsLoading = sample({ loading: true, count: 0, mode: 'live', error: null });
  let state = reduceLoadingFeedback(createLoadingFeedbackState(), roadsLoading, 0);
  state = reduceLoadingFeedback(state, roadsLoading, 200);
  assert.equal(state.visible, true);
  // Cached roads have painted, but the flow fetch has NOT settled: the layer
  // still reports loading, so the batch stays open.
  const flowStillPending = sample({ loading: true, count: 544, mode: 'live', error: null });
  state = reduceLoadingFeedback(state, flowStillPending, 400);
  assert.equal(state.phase, 'loading');
  // Flow fails late.
  const flowFailed = sample({
    loading: false,
    count: 544,
    mode: 'live',
    error: 'SIMULATED — TomTom daily budget reached',
  });
  state = reduceLoadingFeedback(state, flowFailed, 900);
  assert.equal(state.terminal, 'error');
  assert.equal(
    presentLoadingFeedback(state, flowFailed, 900).label,
    'LOAD FAILED',
    'a late flow failure must not be announced as LOAD COMPLETE',
  );
});

test('aggregates Mapped Installations refresh beside CCTV without changing either owner', () => {
  const summary = aggregateLayerLoading([
    {
      id: 'cctv', name: 'CCTV', enabled: true, lifecycleState: 'enabled',
      stats: { count: 500, lastUpdate: 10, loading: true },
    },
    {
      id: 'military-installations', name: 'Mapped Installations', enabled: true,
      lifecycleState: 'enabled',
      stats: { count: 4, lastUpdate: 20, loading: true },
    },
  ]);
  assert.deepEqual(summary.activeIds, ['cctv', 'military-installations']);
  assert.equal(summary.refresh, true);
  const pending = reduceLoadingFeedback(createLoadingFeedbackState(), summary, 0);
  const visible = reduceLoadingFeedback(pending, summary, 200);
  assert.deepEqual(
    presentLoadingFeedback(visible, summary, 200),
    { state: 'refresh', label: 'REFRESHING LIVE DATA', detail: 'CCTV · Mapped Installations' },
  );
});

// The reducer above is pure and fully covered; its DRIVER lives inside the
// StyleManager class (a full viewer to instantiate), so — as with the panel
// stack layout contract — the ticker's lifecycle is pinned against ui.js
// source. (perf rebase 2026-08-17)
test('the loading ticker never runs hidden and stops after loading and notices settle', () => {
  const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  // Scope every assertion to _armLoadingFeedbackTicker's own body. The
  // neighbouring _startTrafficChipTicker is a deliberately PERMANENT 500ms
  // safety-net poll, so its `if (document.hidden) return;` is correct there
  // and must not be confused with this self-stopping ticker's leak.
  const armBody = ui.slice(ui.indexOf('_armLoadingFeedbackTicker() {'));
  assert.ok(armBody.startsWith('_armLoadingFeedbackTicker() {'), 'ticker function not found in ui.js');
  const arm = armBody.slice(0, armBody.indexOf('\n  }\n') + 5);

  // 1. The ARM guard itself refuses while hidden. Previously the only hidden
  //    check sat INSIDE the interval body, so a batch that completed while
  //    hidden left the 60ms timer scheduled for the whole hidden period: the
  //    idle check that clears it was unreachable behind the hidden `return`.
  assert.match(
    arm,
    /if \(this\._loadingFeedbackTicker \|\| document\.hidden\) return;/,
    'the ticker must not arm while the document is hidden',
  );

  // 2. Going hidden STOPS the interval rather than idling inside it.
  assert.match(
    arm,
    /if \(document\.hidden\) \{\s*this\._stopLoadingFeedbackTicker\(\);\s*return;\s*\}/,
    'a hidden tick must clear the interval, not just skip the work',
  );
  assert.doesNotMatch(
    arm,
    /setInterval\(\(\) => \{\s*if \(document\.hidden\) return;/,
    'the bare hidden `return` inside this interval is the leak — it must be gone',
  );

  // 3. Reaching idle stops it after any time-driven notice has completed.
  //    Persistent ACQUIRING notices remain visible without a 60ms timer.
  assert.match(
    arm,
    /const noticeNeedsTicker = Number\.isFinite\(this\._globalStatusNotice\?\.hideAt\);[\s\S]*?if \(this\._loadingFeedbackState\?\.phase === 'idle' && !noticeNeedsTicker\) \{\s*this\._stopLoadingFeedbackTicker\(\);\s*\}/,
    'an idle phase with no expiring notice must stop the ticker',
  );
  assert.match(
    ui,
    /_stopLoadingFeedbackTicker\(\)\s*\{[\s\S]*?clearInterval\(this\._loadingFeedbackTicker\);[\s\S]*?this\._loadingFeedbackTicker = null;/,
    'the shared stopper must actually clear and null the handle',
  );

  // 4. Returning to visible resamples, so a batch that finished while hidden
  //    is reconciled and a still-running one re-arms its ticker. The handler
  //    must live on the class that OWNS _updateGlobalLoadingFeedback
  //    (StyleManager) — wiring it into a neighbouring controller instead
  //    throws on every visibilitychange — and must be torn down with the rest.
  assert.match(
    ui,
    /this\._loadingVisibilityHandler = \(\) => \{\s*if \(!document\.hidden\) this\._updateGlobalLoadingFeedback\(\);\s*\};\s*document\.addEventListener\('visibilitychange', this\._loadingVisibilityHandler\);/,
    'visibilitychange must resample the chip on return',
  );
  const styleManager = ui.slice(ui.indexOf('export class StyleManager'));
  assert.ok(
    styleManager.includes('this._loadingVisibilityHandler'),
    'the resample handler must be owned by StyleManager, which defines _updateGlobalLoadingFeedback',
  );
  assert.match(
    ui,
    /document\.removeEventListener\('visibilitychange', this\._loadingVisibilityHandler\);/,
    'the resample handler must be removed on teardown',
  );
});
