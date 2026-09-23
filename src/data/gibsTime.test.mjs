// src/data/gibsTime.test.mjs — which GIBS date to draw for an instant, read off the intervals the layer serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateAtOrBefore, latestDate, extentOfTimes } from './gibsTime.js';

// MODIS 16-day composites restart every 1 January, so GIBS lists one interval per year.
const EVI = ['2025-01-01/2025-12-19/P16D', '2026-01-01/2026-08-29/P16D'];
const BLACK_MARBLE = ['2012-01-01/2012-01-01/P1Y', '2016-01-01/2016-01-01/P1Y'];

test('a 16-day composite resolves to the composite that contains the instant', () => {
  assert.equal(dateAtOrBefore(EVI, '2026-08-30T12:00:00Z'), '2026-08-29');
  assert.equal(dateAtOrBefore(EVI, '2026-01-16T23:59:59Z'), '2026-01-01');
  assert.equal(dateAtOrBefore(EVI, '2026-01-17T00:00:00Z'), '2026-01-17');
});

test('the year boundary: late December falls back to the last composite of the old year', () => {
  assert.equal(dateAtOrBefore(EVI, '2025-12-31T00:00:00Z'), '2025-12-19');
});

test('sparse annual layers pick the nearest earlier year; before the first there is nothing', () => {
  assert.equal(dateAtOrBefore(BLACK_MARBLE, '2014-06-01T00:00:00Z'), '2012-01-01');
  assert.equal(dateAtOrBefore(BLACK_MARBLE, '2026-09-22T00:00:00Z'), '2016-01-01');
  assert.equal(dateAtOrBefore(BLACK_MARBLE, '2011-12-31T23:59:59Z'), null);
});

test('latest and extent read the served dates, not the clock', () => {
  assert.equal(latestDate(EVI), '2026-08-29');
  assert.equal(latestDate([]), null);
  const e = extentOfTimes(BLACK_MARBLE);
  assert.equal(new Date(e.startMs).toISOString(), '2012-01-01T00:00:00.000Z');
  assert.equal(new Date(e.endMs).toISOString(), '2016-01-01T23:59:59.999Z');
  assert.equal(extentOfTimes([]), null);
});

test('an unsupported period or a malformed interval throws instead of guessing', () => {
  assert.throws(() => dateAtOrBefore(['2026-01-01/2026-02-01/PT1H'], '2026-01-05T00:00:00Z'), /unsupported GIBS period PT1H/);
  assert.throws(() => latestDate(['2026-01-01']), /malformed GIBS interval/);
});
