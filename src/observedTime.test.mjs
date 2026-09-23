// src/observedTime.test.mjs — shared observed-time store, bridge and bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createObservedTime, attachObservedTime, describeObservedTime, isoHour, installObservedTimeUi } from './observedTime.js';
import { DataLayerManager } from './data/manager.js';

const NOW = Date.parse('2026-09-11T15:37:12Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (iso) => Date.parse(iso);

function fakeTimers() {
  const timers = new Map(); let id = 0;
  return {
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearInterval: (h) => timers.delete(h),
    tick() { for (const t of [...timers.values()]) t.fn(); },
    count: () => timers.size,
  };
}

test('store: no layer has declared data, so there is no domain and nothing to select', () => {
  const s = createObservedTime({ now: () => NOW });
  assert.equal(s.domain(), null);
  assert.equal(s.set('2026-09-11T10:00:00Z'), false, 'cannot scrub to an hour no layer can serve');
  assert.equal(s.get(), null);
  assert.equal(s.step(-1), false);
  s.play();
  assert.equal(s.isPlaying(), false, 'play on an empty domain does nothing');
});

test('store: the domain is the data, so it ends where the data ends — not at now', () => {
  // THE REGRESSION. This was domainDays:30 applied to now(), invented in the store and checked
  // against nothing, so the bar offered every hour up to the present whatever the layers held. The
  // birds archive is a fixed backfill that stopped advancing on 2026-09-10; on the old code the
  // right-hand 12 days of this slider addressed hours with no frame behind them.
  const s = createObservedTime({ now: () => NOW });
  s.setLayerExtent('birds', { startMs: at('2026-08-11T02:00:00Z'), endMs: at('2026-09-10T12:00:00Z') });
  const d = s.domain();
  assert.equal(new Date(d.start).toISOString(), '2026-08-11T02:00:00.000Z');
  assert.equal(new Date(d.end).toISOString(), '2026-09-10T12:00:00.000Z', 'ends at the last frame, not at now');
  assert.ok(d.end < NOW, 'and that is well before now');
  s.set('2026-09-11T10:00:00Z');
  assert.equal(s.get(), '2026-09-10T12:00:00Z', 'an hour past the data clamps to the last hour that has it');
  s.set('2026-07-01T00:00:00Z');
  assert.equal(s.get(), '2026-08-11T02:00:00Z', 'and before it clamps to the first');
});

test('store: rollingDays resolves against the clock, and extents union', () => {
  const s = createObservedTime({ now: () => NOW });
  s.setLayerExtent('oisst', { rollingDays: 10 });
  assert.equal(new Date(s.domain().start).toISOString(), '2026-09-01T15:00:00.000Z');
  assert.equal(new Date(s.domain().end).toISOString(), '2026-09-11T15:00:00.000Z', 'a rolling window ends now');
  // occurrences reaches back to May; the union has to take the wider start AND keep the later end.
  s.setLayerExtent('occurrences', { startMs: at('2026-05-24T00:00:00Z'), endMs: at('2026-09-01T00:00:00Z') });
  assert.equal(new Date(s.domain().start).toISOString(), '2026-05-24T00:00:00.000Z');
  assert.equal(new Date(s.domain().end).toISOString(), '2026-09-11T15:00:00.000Z');
  assert.equal(s.extents().size, 2);
  assert.equal(s.setLayerExtent('oisst', { rollingDays: 10 }), false, 're-declaring the same extent is not a change');
});

test('store: withdrawing the layer that carried the span pulls the instant back in', () => {
  const s = createObservedTime({ now: () => NOW });
  s.setLayerExtent('tracks', { startMs: at('2009-06-23T00:00:00Z'), endMs: at('2026-09-01T00:00:00Z') });
  s.setLayerExtent('birds', { startMs: at('2026-08-11T02:00:00Z'), endMs: at('2026-09-10T12:00:00Z') });
  s.set('2009-07-01T00:00:00Z');
  assert.equal(s.get(), '2009-07-01T00:00:00Z');
  s.setLayerExtent('tracks', null);
  assert.equal(s.get(), '2026-08-11T02:00:00Z', 'clamped into what is left, not left parked in 2009');
  s.setLayerExtent('birds', null);
  assert.equal(s.domain(), null);
  assert.equal(s.get(), null, 'the last extent going away returns the bar to live');
});

test('store: the step scales with the span, and an explicit stepMs still wins', () => {
  // tracks carries fixes from 2009. At a fixed hourly step that is ~150,000 notches on one slider.
  const s = createObservedTime({ now: () => NOW });
  s.setLayerExtent('birds', { startMs: at('2026-08-11T02:00:00Z'), endMs: at('2026-09-10T12:00:00Z') });
  assert.equal(s.domain().stepMs, HOUR, 'a month of hourly frames steps by the hour');
  s.setLayerExtent('occurrences', { startMs: at('2026-05-24T00:00:00Z'), endMs: at('2026-09-01T00:00:00Z') });
  assert.equal(s.domain().stepMs, DAY, 'a hundred days steps by the day');
  s.setLayerExtent('tracks', { startMs: at('2009-06-23T00:00:00Z'), endMs: at('2026-09-01T00:00:00Z') });
  assert.equal(s.domain().stepMs, 7 * DAY, 'seventeen years steps by the week');
  const pinned = createObservedTime({ now: () => NOW, stepMs: HOUR });
  pinned.setLayerExtent('tracks', { startMs: at('2009-06-23T00:00:00Z'), endMs: at('2026-09-01T00:00:00Z') });
  assert.equal(pinned.domain().stepMs, HOUR, 'an explicit step is not overridden');
});

test('store: set clamps to the hourly domain, null returns to live', () => {
  const s = createObservedTime({ now: () => NOW });
  s.setLayerExtent('oisst', { rollingDays: 2 });
  assert.equal(s.get(), null);
  assert.equal(isoHour(NOW), '2026-09-11T15:00:00Z');
  const seen = []; s.subscribe((v) => seen.push(v));
  assert.equal(s.set('2026-09-11T10:42:00Z'), true);
  assert.equal(s.get(), '2026-09-11T10:00:00Z');
  assert.equal(s.set('2026-09-11T10:05:00Z'), false, 'same hour is not a change');
  s.set('2000-01-01T00:00:00Z');
  assert.equal(s.get(), '2026-09-09T15:00:00Z', 'clamped to domain start');
  s.set('2099-01-01T00:00:00Z');
  assert.equal(s.get(), '2026-09-11T15:00:00Z', 'clamped to domain end');
  assert.equal(s.set('garbage'), false);
  s.set(null);
  assert.equal(s.get(), null);
  assert.deepEqual(seen, ['2026-09-11T10:00:00Z', '2026-09-09T15:00:00Z', '2026-09-11T15:00:00Z', null]);
});

test('store: play steps one step per tick from the domain start and stops at the end', () => {
  const t = fakeTimers();
  const s = createObservedTime({ now: () => NOW, ...t });
  s.setLayerExtent('oisst', { rollingDays: 1 });
  s.set('2026-09-11T13:00:00Z');
  s.play();
  assert.equal(s.isPlaying(), true);
  t.tick(); assert.equal(s.get(), '2026-09-11T14:00:00Z');
  t.tick(); assert.equal(s.get(), '2026-09-11T15:00:00Z');
  assert.equal(s.isPlaying(), false, 'paused at domain end');
  assert.equal(t.count(), 0);
  s.set(null); s.play(); assert.equal(s.get(), '2026-09-10T15:00:00Z', 'play from live starts at domain start');
  s.set(null); assert.equal(s.isPlaying(), false, 'returning to live pauses');
});

test('bridge: only enabled sampling layers receive the time; a layer enabled later is caught up', async () => {
  const s = createObservedTime({ now: () => NOW });
  const calls = [];
  const mk = (id) => ({ id, setObservedTime: (iso) => { calls.push([id, iso]); }, getObservedExtent: () => ({ rollingDays: 2 }) });
  const birds = mk('birds'), sst = mk('oisst'), plain = { id: 'plain' };
  const enabled = new Set(['birds']);
  const listeners = new Set();
  const dm = { isEnabled: (id) => enabled.has(id), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const off = attachObservedTime(s, dm, [birds, sst, plain]);
  await Promise.resolve(); await Promise.resolve();
  s.set('2026-09-11T10:00:00Z');
  await Promise.resolve();
  assert.deepEqual(calls.filter(([, iso]) => iso), [['birds', '2026-09-11T10:00:00Z']]);
  enabled.add('oisst');
  // The settled announcement the manager really sends. This read {type:'visibility-transition',
  // lifecycleState:'enabled'} until 2026-09-20 — an event the manager never emits — so the test passed
  // while the branch it covers was dead in the browser. The real-manager test below keeps it honest.
  for (const fn of listeners) fn({ type: 'visibility', layerId: 'oisst', enabled: true });
  assert.deepEqual(calls.at(-1), ['oisst', '2026-09-11T10:00:00Z']);
  off();
  assert.equal(s.domain(), null, 'detaching withdraws every extent it declared');
  assert.equal(describeObservedTime('2026-09-11T10:00:00Z'), '2026-09-11 10:00 UTC');
  assert.equal(describeObservedTime(null), 'LIVE');
});

test('bridge: a layer switched off while scrubbed and back on under LIVE is told LIVE; a never-scrubbed one is left alone', async () => {
  // Review 2026-09-22: night lights scrubbed to 2014, switched off, bar sent to LIVE (disabled layers
  // get no push), switched on again → drew 2012 tiles under a LIVE bar.
  const s = createObservedTime({ now: () => NOW });
  const calls = [];
  const mk = (id) => ({ id, setObservedTime: (iso) => { calls.push([id, iso]); }, getObservedExtent: () => ({ rollingDays: 2 }) });
  const nl = mk('gibs-nightlights'), lst = mk('gibs-lst');
  const enabled = new Set(['gibs-nightlights']);
  const listeners = new Set();
  const dm = { isEnabled: (id) => enabled.has(id), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const off = attachObservedTime(s, dm, [nl, lst]);
  const settle = (id, on) => { if (on) enabled.add(id); else enabled.delete(id); for (const fn of listeners) fn({ type: 'visibility', layerId: id, enabled: on }); };
  await Promise.resolve(); await Promise.resolve();
  s.set('2026-09-11T10:00:00Z');
  await Promise.resolve();
  settle('gibs-nightlights', false);
  s.set(null);
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ['gibs-nightlights', '2026-09-11T10:00:00Z'], 'the switched-off layer missed LIVE');
  settle('gibs-nightlights', true);
  assert.deepEqual(calls.at(-1), ['gibs-nightlights', null], 're-enabled under LIVE is told LIVE');
  const n = calls.length;
  settle('gibs-lst', true);
  assert.equal(calls.length, n, 'a layer never told a past time gets no redundant push under LIVE');
  off();
});

// Minimal DOM stub shared by the bar tests below. `style` is a plain object, so a test reads back
// exactly what the code assigned — including `display`, which is what actually hides the bar.
function stubDoc() {
  const mkEl = (tag) => ({
    tag, children: [], style: {}, hidden: false, handlers: {}, _html: '', min: '0', max: '0', value: '0', textContent: '',
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    set innerHTML(h) { this._html = h; this.children = [...h.matchAll(/class="([a-z-]+)"/g)].map((m) => Object.assign(mkEl('x'), { cls: m[1] })); },
    get innerHTML() { return this._html; },
    querySelector(sel) { return this.children.find((c) => c.cls === sel.slice(1)) || null; },
    querySelectorAll() { return this.children; },
  });
  const doc = { body: mkEl('body'), getElementById: () => null, createElement: (t) => mkEl(t) };
  return doc;
}

test('bar: hidden until a sampling layer is enabled, slider maps to the domain, LIVE resets', () => {
  const s = createObservedTime({ now: () => NOW });
  const enabled = new Set(); const listeners = new Set();
  const dm = { isEnabled: (id) => enabled.has(id), subscribe: (fn) => { listeners.add(fn); return () => {}; } };
  const doc = stubDoc();
  const root = installObservedTimeUi(s, dm, [{ id: 'birds', setObservedTime() {} }], doc);
  assert.equal(root.hidden, true);
  enabled.add('birds');
  s.setLayerExtent('birds', { rollingDays: 1 });
  for (const fn of listeners) fn({ type: 'visibility', layerId: 'birds', enabled: true });
  assert.equal(root.hidden, false);
  const range = root.querySelector('.ot-range'), label = root.querySelector('.ot-label');
  assert.equal(range.max, '24'); assert.equal(range.value, '24'); assert.equal(label.textContent, 'LIVE');
  range.value = '3'; range.handlers.input();
  assert.equal(s.get(), '2026-09-10T18:00:00Z');
  assert.equal(label.textContent, '2026-09-10 18:00 UTC');
  root.querySelector('.ot-live').handlers.click();
  assert.equal(s.get(), null); assert.equal(range.value, '24');
  assert.equal(installObservedTimeUi(s, dm, [], { ...doc, getElementById: () => root }), null, 'installed once');
});

test('bar: an enabled layer with nothing to scrub over does not get a slider', () => {
  // A layer can be on while its extent is still in flight (birds fetches its manifest) or absent.
  // A bar over an empty range is a control that lies about being usable, so it stays away.
  const s = createObservedTime({ now: () => NOW });
  const enabled = new Set(['birds']); const listeners = new Set();
  const dm = { isEnabled: (id) => enabled.has(id), subscribe: (fn) => { listeners.add(fn); return () => {}; } };
  const root = installObservedTimeUi(s, dm, [{ id: 'birds', setObservedTime() {} }], stubDoc());
  assert.equal(root.style.display, 'none', 'enabled but no declared data: no bar');
  assert.equal(root.querySelector('.ot-range').max, '0');
  s.setLayerExtent('birds', { startMs: at('2026-08-11T02:00:00Z'), endMs: at('2026-09-10T12:00:00Z') });
  for (const fn of listeners) fn({ type: 'visibility', layerId: 'birds', enabled: true });
  assert.equal(root.style.display, 'flex', 'the extent arriving is what brings the bar in');
  assert.equal(root.querySelector('.ot-range').max, '730', '30 days 10 hours of hourly frames');
});

/** A layer module the real DataLayerManager can drive, recording the observed times it is handed. */
function samplingLayer(id, extent = { rollingDays: 1 }) {
  const seen = [];
  return {
    seen,
    module: {
      id,
      async init() {},
      async enable() {},
      async disable() {},
      async update() {},
      updateInterval: -1,
      setObservedTime(iso) { seen.push(iso); },
      getObservedExtent() { return extent; },
    },
  };
}

test('bridge: a layer enabled through the REAL manager while scrubbed is handed the observed time', async () => {
  // The fixture this replaces synthesised {type:'visibility-transition', lifecycleState:'enabled'} —
  // an event DataLayerManager never sends. _setLifecycleTransition has one call site and passes only
  // 'enabling'/'disabling'; the settle that sets 'enabled' notifies nobody. Settled visibility is
  // announced as {type:'visibility', enabled}. Driving the real manager is what catches that.
  const s = createObservedTime({ now: () => NOW });
  const mgr = new DataLayerManager({}, { hasBackend: false });
  const birds = samplingLayer('birds', { rollingDays: 2 });
  mgr.register(birds.module);
  const off = attachObservedTime(s, mgr, [birds.module]);
  s.setLayerExtent('probe', { rollingDays: 2 }); // a domain exists so an instant can be selected
  s.set('2026-09-11T10:00:00Z');
  await Promise.resolve();
  assert.deepEqual(birds.seen, [], 'a disabled layer is not sampled');
  await mgr.setEnabled('birds', true);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(birds.seen.includes('2026-09-11T10:00:00Z'),
    'enabling while scrubbed must hand the layer the observed time, not leave it live');
  off();
});

test('bridge: the REAL manager enabling a layer is what puts its extent on the bar', async () => {
  const s = createObservedTime({ now: () => NOW });
  const mgr = new DataLayerManager({}, { hasBackend: false });
  const birds = samplingLayer('birds', { startMs: at('2026-08-11T02:00:00Z'), endMs: at('2026-09-10T12:00:00Z') });
  mgr.register(birds.module);
  const off = attachObservedTime(s, mgr, [birds.module]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.domain(), null, 'a registered but disabled layer contributes no span');
  await mgr.setEnabled('birds', true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(new Date(s.domain().end).toISOString(), '2026-09-10T12:00:00.000Z', 'its real archive end');
  await mgr.setEnabled('birds', false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.domain(), null, 'and it is withdrawn when the layer goes off');
  off();
});

test('bar: shows and hides by display, driven by the REAL manager', async () => {
  // `hidden` alone cannot hide this bar: installObservedTimeUi sets inline display:flex, which outranks
  // the UA's [hidden]{display:none}. The assertion is therefore on display, which is what a user sees.
  const s = createObservedTime({ now: () => NOW });
  const mgr = new DataLayerManager({}, { hasBackend: false });
  const birds = samplingLayer('birds');
  mgr.register(birds.module);
  attachObservedTime(s, mgr, [birds.module]);
  const root = installObservedTimeUi(s, mgr, [birds.module], stubDoc());
  assert.equal(root.style.display, 'none', 'no sampling layer enabled: the bar is not displayed');
  await mgr.setEnabled('birds', true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(root.style.display, 'flex', 'the bar appears once a sampling layer is on');
  await mgr.setEnabled('birds', false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(root.style.display, 'none', 'and goes away again');
});
