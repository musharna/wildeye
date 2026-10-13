// src/data/dataCredits.test.mjs — a credit names the route the data actually comes by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA_CREDITS } from './dataCredits.js';

// Layers the pipeline draws from the numbers no longer use the providers' coloured PNG services. ndvi moved off NCEI's
// WMS in PR #85 while its credit still said "NCEI THREDDS WMS". "From the numbers" is every source key process() in
// pipeline/raster.py dispatches on before its PNG fallback, read from that file, so a new source is covered without
// editing this test (a hand-kept list here missed cmems_dominant and crw_outlook, PR #86 review).
const PNG_ROUTE = /\bWMS\b|transparentPng/;

function numberSources() {
  const py = fs.readFileSync(new URL('../../pipeline/raster.py', import.meta.url), 'utf8');
  const start = py.indexOf('\ndef process(');
  const end = py.indexOf('\n    else:', start);
  assert.ok(start > 0 && end > start, 'process() and its PNG fallback are where this test expects them');
  return [...py.slice(start, end).matchAll(/^ {4}(?:if|elif) "(\w+)" in product:$/gm)].map((m) => m[1]);
}

test('credits of layers drawn from numbers do not name a coloured-PNG route', () => {
  const keys = numberSources();
  for (const k of ['cmems', 'erddap_grid', 'opendap_grid', 'cmems_dominant', 'crw_outlook']) {
    assert.ok(keys.includes(k), `control: ${k} is read from process()`);
  }
  const products = JSON.parse(fs.readFileSync(new URL('../../pipeline/rasters.json', import.meta.url), 'utf8'));
  const fromNumbers = products.filter((p) => keys.some((k) => k in p));
  assert.ok(['ndvi', 'oisst', 'cmems-pft', 'crw-outlook'].every((id) => fromNumbers.some((p) => p.id === id)), 'control: the set is live');
  const byKey = new Map(DATA_CREDITS.map((c) => [c.key, c.html]));
  for (const p of fromNumbers) {
    const html = byKey.get(p.credit_key);
    assert.equal(typeof html, 'string', `${p.id}: credit_key ${p.credit_key} has a credit`);
    assert.doesNotMatch(html, PNG_ROUTE, `${p.id} (${p.credit_key}) is drawn from numbers`);
  }
  // a layer still read as a coloured PNG may name its WMS: the pattern itself matches what it must
  assert.match('NASA GIBS WMS', PNG_ROUTE);
});
