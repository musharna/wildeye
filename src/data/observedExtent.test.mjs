// src/data/observedExtent.test.mjs — the pure helpers each layer uses to declare what it can serve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extentFromTimes, extentFromDays, extentFromWeekDates, extentFromMonths, unionExtents, pluck,
} from './observedExtent.js';

const iso = (ms) => new Date(ms).toISOString();

test('extentFromTimes: min and max of mixed ISO and ms, invalid skipped', () => {
  const e = extentFromTimes(['2026-09-10T12:00:00Z', Date.parse('2026-08-01T03:00:00Z'), 'nonsense', null]);
  assert.equal(iso(e.startMs), '2026-08-01T03:00:00.000Z');
  assert.equal(iso(e.endMs), '2026-09-10T12:00:00.000Z');
  assert.equal(extentFromTimes([]), null, 'nothing usable declares no extent, not an empty one');
  assert.equal(extentFromTimes(['nope']), null);
  assert.equal(extentFromTimes(undefined), null);
});

test('extentFromDays: a day covers its whole UTC day', () => {
  const e = extentFromDays(['2026-09-08', '2026-08-11']);
  assert.equal(iso(e.startMs), '2026-08-11T00:00:00.000Z');
  assert.equal(iso(e.endMs), '2026-09-08T23:59:59.999Z', 'the last day is inside the extent');
  assert.equal(extentFromDays([]), null);
});

test('extentFromWeekDates: the bin reaches back 6 days from its labelled last day', () => {
  // binsAt() in hpai.js matches an instant to the bin (w-6d .. w]. If the extent started AT the
  // earliest w, the six days that bin actually covers would sit outside the selectable span.
  const e = extentFromWeekDates(['2026-09-08', '2026-08-11']);
  assert.equal(iso(e.startMs), '2026-08-05T00:00:00.000Z', '6 days before the earliest bin label');
  assert.equal(iso(e.endMs), '2026-09-08T23:59:59.999Z');
  const daily = extentFromWeekDates(['2026-09-08'], 1);
  assert.equal(iso(daily.startMs), '2026-09-08T00:00:00.000Z', 'binDays=1 reaches back nothing');
  assert.equal(extentFromWeekDates([]), null);
});

test('extentFromMonths: a month covers its whole calendar month, leap year included', () => {
  const e = extentFromMonths(['2026-09', '2025-11']);
  assert.equal(iso(e.startMs), '2025-11-01T00:00:00.000Z');
  assert.equal(iso(e.endMs), '2026-09-30T23:59:59.999Z', 'September ends on the 30th');
  assert.equal(iso(extentFromMonths(['2024-02']).endMs), '2024-02-29T23:59:59.999Z', 'leap February');
  assert.equal(iso(extentFromMonths(['2026-12']).endMs), '2026-12-31T23:59:59.999Z', 'December rolls the year');
  assert.equal(extentFromMonths(['garbage']), null);
});

test('unionExtents: widest of the lot, nulls ignored, all-null is null', () => {
  const u = unionExtents([
    { startMs: 100, endMs: 200 },
    null,
    { startMs: 50, endMs: 150 },
    { startMs: 180, endMs: 900 },
  ]);
  assert.deepEqual(u, { startMs: 50, endMs: 900 });
  assert.equal(unionExtents([null, null]), null);
  assert.equal(unionExtents([]), null);
  // A layer handing back an inverted range must not become a domain. Without this the bar would take
  // start > end and the slider's max would go negative.
  assert.equal(unionExtents([{ startMs: 500, endMs: 100 }]), null, 'inverted range is not an extent');
  assert.deepEqual(unionExtents([{ startMs: 500, endMs: 100 }, { startMs: 50, endMs: 600 }]),
    { startMs: 50, endMs: 600 }, 'a good extent alongside an inverted one still stands');
});

test('pluck: bin arrays, objects of bin arrays, and plain values', () => {
  const feats = [
    { properties: { weeks: [{ w: '2026-09-08' }, { w: '2026-09-01' }] } },
    { properties: { weeks: [{ w: '2026-08-25' }] } },
    { properties: {} },
  ];
  assert.deepEqual(pluck(feats, 'weeks', 'w'), ['2026-09-08', '2026-09-01', '2026-08-25']);
  // neon-vectors keeps its month lists under per-kind keys, not one flat array.
  const nested = [{ properties: { ticks: { a: [{ m: '2026-08' }], b: [{ m: '2026-07' }] } } }];
  assert.deepEqual(pluck(nested, 'ticks', 'm'), ['2026-08', '2026-07']);
  assert.deepEqual(pluck([{ properties: { date: '2026-09-19' } }], 'date'), ['2026-09-19']);
  assert.deepEqual(pluck(null, 'weeks', 'w'), []);
});
