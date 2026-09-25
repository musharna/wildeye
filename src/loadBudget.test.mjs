import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLoad, isVendorKey, manifestSources, startupKey } from '../scripts/load-budget-check.mjs';

/**
 * Pure half of the startup-weight gate (`scripts/load-budget-check.mjs`). The
 * browser half is proved end to end by the gate itself: an eager import of the
 * lazy `marine` chunk turned it red, and suppressing the HUD's first-tick geoid
 * request turned it IMPROVED with the egm96-universal source removed.
 */

const MANIFEST = {
  'index.html': { file: 'assets/index-DB4WOJsT.js', src: 'index.html', isEntry: true },
  'node_modules/egm96-universal/dist/egm96-universal.esm.js': { file: 'assets/egm96-universal.esm-D6y_VLZc.js', src: 'node_modules/egm96-universal/dist/egm96-universal.esm.js' },
  'node_modules/@mapbox/vector-tile/index.js': { file: 'assets/index-Q1w2E3r4.js', src: 'node_modules/@mapbox/vector-tile/index.js' },
  'src/data/local_data/natural_earth/marine.json': { file: 'assets/marine-BJ61ZZ9E.js', src: 'src/data/local_data/natural_earth/marine.json' },
};

test('startup keys are manifest sources, so same-named chunks stay distinct', () => {
  const sources = manifestSources(MANIFEST);
  assert.equal(startupKey('/assets/index-DB4WOJsT.js', sources), 'index.html');
  // Two chunks Vite named `index-*.js` must not collapse into one key.
  assert.equal(startupKey('/assets/index-Q1w2E3r4.js?v=2', sources), 'node_modules/@mapbox/vector-tile/index.js');
  assert.equal(startupKey('/assets/egm96-universal.esm-D6y_VLZc.js', sources), 'node_modules/egm96-universal/dist/egm96-universal.esm.js');
  // Cesium's static tree is copied, not bundled: keyed by its served path.
  assert.equal(startupKey('/cesium/Cesium.js', sources), '/cesium/Cesium.js');
  // A build output the manifest doesn't know means a stale dist/: fail loud.
  assert.throws(() => startupKey('/assets/stray-AAAAAAAA.js', sources), /missing from dist\/\.vite\/manifest\.json/);
});

test('vendor = code that lives in a dependency, scoped packages included', () => {
  assert.equal(isVendorKey('/cesium/Cesium.js'), true);
  assert.equal(isVendorKey('node_modules/egm96-universal/dist/egm96-universal.esm.js'), true);
  assert.equal(isVendorKey('node_modules/@mapbox/vector-tile/index.js'), true);
  assert.equal(isVendorKey('index.html'), false);
  assert.equal(isVendorKey('src/data/local_data/natural_earth/marine.json'), false);
});

test('load verdicts: equal passes; an added file or vendor rise regresses; a removal or vendor drop improves', () => {
  const egm = 'node_modules/egm96-universal/dist/egm96-universal.esm.js';
  const baseline = { files: ['/cesium/Cesium.js', egm, 'index.html'], vendorBytes: { '/cesium/Cesium.js': 100, [egm]: 50 } };

  const same = compareLoad(baseline, structuredClone(baseline));
  assert.equal(same.verdict, 'equal');

  const marine = 'src/data/local_data/natural_earth/marine.json';
  const pulledOn = compareLoad(baseline, { ...structuredClone(baseline), files: [...baseline.files, marine] });
  assert.equal(pulledOn.verdict, 'regressed');
  assert.deepEqual(pulledOn.added, [marine]);

  const vendorBump = compareLoad(baseline, { ...structuredClone(baseline), vendorBytes: { ...baseline.vendorBytes, '/cesium/Cesium.js': 101 } });
  assert.equal(vendorBump.verdict, 'regressed');
  assert.deepEqual(vendorBump.vendorDeltas, [{ key: '/cesium/Cesium.js', delta: 1 }]);

  const deferred = compareLoad(baseline, { files: ['/cesium/Cesium.js', 'index.html'], vendorBytes: { '/cesium/Cesium.js': 100 } });
  assert.equal(deferred.verdict, 'improved');
  assert.deepEqual(deferred.removed, [egm]);
  assert.deepEqual(deferred.vendorDeltas, [{ key: egm, delta: -50 }]);

  // A swap (one file off, another on) is a rise, not a wash.
  const swapped = compareLoad(baseline, { files: ['/cesium/Cesium.js', 'index.html', marine], vendorBytes: { '/cesium/Cesium.js': 100 } });
  assert.equal(swapped.verdict, 'regressed');
});
