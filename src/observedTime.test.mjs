// src/observedTime.test.mjs — shared observed-time store, bridge and bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createObservedTime, attachObservedTime, describeObservedTime, isoHour, installObservedTimeUi } from './observedTime.js';

const NOW = Date.parse('2026-09-11T15:37:12Z');

function fakeTimers() {
  const timers = new Map(); let id = 0;
  return {
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearInterval: (h) => timers.delete(h),
    tick() { for (const t of [...timers.values()]) t.fn(); },
    count: () => timers.size,
  };
}

test('store: live by default, set clamps to the hourly domain, null returns to live', () => {
  const s = createObservedTime({ now: () => NOW, domainDays: 2 });
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

test('store: play steps one hour per tick from the domain start and stops at the end', () => {
  const t = fakeTimers();
  const s = createObservedTime({ now: () => NOW, domainDays: 1, ...t });
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
  const s = createObservedTime({ now: () => NOW, domainDays: 2 });
  const calls = [];
  const mk = (id) => ({ id, setObservedTime: (iso) => { calls.push([id, iso]); } });
  const birds = mk('birds'), sst = mk('oisst'), plain = { id: 'plain' };
  const enabled = new Set(['birds']);
  const listeners = new Set();
  const dm = { isEnabled: (id) => enabled.has(id), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const off = attachObservedTime(s, dm, [birds, sst, plain]);
  s.set('2026-09-11T10:00:00Z');
  await Promise.resolve();
  assert.deepEqual(calls, [['birds', '2026-09-11T10:00:00Z']]);
  enabled.add('oisst');
  for (const fn of listeners) fn({ type: 'visibility-transition', layerId: 'oisst', lifecycleState: 'enabled' });
  assert.deepEqual(calls.at(-1), ['oisst', '2026-09-11T10:00:00Z']);
  s.set(null);
  assert.deepEqual(calls.slice(-2), [['birds', null], ['oisst', null]]);
  off();
  s.set('2026-09-11T11:00:00Z');
  assert.equal(calls.length, 4, 'unsubscribed');
  assert.equal(describeObservedTime('2026-09-11T10:00:00Z'), '2026-09-11 10:00 UTC');
  assert.equal(describeObservedTime(null), 'LIVE');
});

test('bar: hidden until a sampling layer is enabled, slider maps to the domain, LIVE resets', () => {
  const s = createObservedTime({ now: () => NOW, domainDays: 1 });
  const enabled = new Set(); const listeners = new Set();
  const dm = { isEnabled: (id) => enabled.has(id), subscribe: (fn) => { listeners.add(fn); return () => {}; } };
  // minimal DOM stub
  const mkEl = (tag) => {
    const el = { tag, children: [], style: {}, hidden: false, attrs: {}, handlers: {}, _html: '', min: '0', max: '0', value: '0', textContent: '',
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(ev, fn) { this.handlers[ev] = fn; },
      set innerHTML(h) { this._html = h; this.children = [...h.matchAll(/class="([a-z-]+)"/g)].map((m) => Object.assign(mkEl('x'), { cls: m[1] })); },
      get innerHTML() { return this._html; },
      querySelector(sel) { return this.children.find((c) => c.cls === sel.slice(1)) || null; },
      querySelectorAll() { return this.children; },
    };
    return el;
  };
  const doc = { body: mkEl('body'), created: [], getElementById: () => null, createElement: (t) => { const e = mkEl(t); doc.created.push(e); return e; } };
  const root = installObservedTimeUi(s, dm, [{ id: 'birds', setObservedTime() {} }], doc);
  assert.equal(root.hidden, true);
  enabled.add('birds');
  for (const fn of listeners) fn({ type: 'visibility-transition', layerId: 'birds', lifecycleState: 'enabled' });
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
