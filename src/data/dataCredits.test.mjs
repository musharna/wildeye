// src/data/dataCredits.test.mjs — a credit names the route the data actually comes by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA_CREDITS } from './dataCredits.js';

// Layers the pipeline draws from the numbers (pipeline/raster.py: cmems, erddap_grid, opendap_grid) no longer use the
// providers' coloured PNG services. ndvi moved off NCEI's WMS in PR #85 while its credit still said "NCEI THREDDS WMS".
const NUMBER_SOURCES = ['cmems', 'erddap_grid', 'opendap_grid'];
const PNG_ROUTE = /\bWMS\b|transparentPng/;

test('credits of layers drawn from numbers do not name a coloured-PNG route', () => {
  const products = JSON.parse(fs.readFileSync(new URL('../../pipeline/rasters.json', import.meta.url), 'utf8'));
  const fromNumbers = products.filter((p) => NUMBER_SOURCES.some((k) => k in p));
  assert.ok(fromNumbers.some((p) => p.id === 'ndvi') && fromNumbers.some((p) => p.id === 'oisst'), 'control: the set is live');
  const byKey = new Map(DATA_CREDITS.map((c) => [c.key, c.html]));
  for (const p of fromNumbers) {
    const html = byKey.get(p.credit_key);
    assert.equal(typeof html, 'string', `${p.id}: credit_key ${p.credit_key} has a credit`);
    assert.doesNotMatch(html, PNG_ROUTE, `${p.id} (${p.credit_key}) is drawn from numbers`);
  }
  // a layer still read as a coloured PNG may name its WMS: the pattern itself matches what it must
  assert.match('NASA GIBS WMS', PNG_ROUTE);
});
