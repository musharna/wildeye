import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleLeftovers } from '../scripts/bundleStrings.mjs';

// qa-bloat's bundle-strings check looks for God's Eye endpoints in the app's code. Cesium 1.145 added a Street View
// endpoint (maps.googleapis.com/maps/api/streetview) to its GoogleMaps defaults, an inert constant nothing calls, and
// the check went red on the vendor chunk (2026-09-28). What Cesium code runs is qa-bloat's `requests` check's job.

const NEEDLES = ['maps.googleapis.com', '/api/google'];

test('a needle in the Cesium vendor chunk is not app code left over', () => {
  const scripts = [
    { url: 'vendor-cesium-BWicFAFN.js', text: 'streetViewStaticApiEndpoint=new Ie({url:"https://maps.googleapis.com/maps/api/streetview"})' },
    { url: 'index-B4EN-qZR.js', text: 'fetch("https://api.gbif.org/v1/species/suggest")' },
  ];
  assert.deepEqual(bundleLeftovers(scripts, NEEDLES), []);
});

test('the same needle in an app chunk is still reported, lazy chunks included', () => {
  const scripts = [
    { url: 'vendor-cesium-BWicFAFN.js', text: 'maps.googleapis.com' },
    { url: 'index-B4EN-qZR.js', text: 'fetch("https://maps.googleapis.com/maps/api/place")' },
    { url: 'speciesPanel-Q1w2E3r4.js', text: 'fetch("/api/google/geocode")' },
  ];
  assert.deepEqual(bundleLeftovers(scripts, NEEDLES), ['index-B4EN-qZR.js: maps.googleapis.com', 'speciesPanel-Q1w2E3r4.js: /api/google']);
});

test("vite names every manual chunk vendor-*, which is what marks a chunk as someone else's code", () => {
  const config = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  const manual = config.slice(config.indexOf('manualChunks('));
  const names = [...manual.slice(0, manual.indexOf('return undefined')).matchAll(/return '([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'found no manualChunks return names in vite.config.js');
  for (const name of names) assert.match(name, /^vendor-/);
});
