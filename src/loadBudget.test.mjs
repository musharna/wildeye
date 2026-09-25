import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLoad, isVendorKey, resourceKey } from '../scripts/load-budget-check.mjs';

/**
 * Pure half of the startup-weight gate (`scripts/load-budget-check.mjs`). The
 * browser half is proved end to end by the gate itself: an eager import of the
 * lazy `marine` chunk turned it red with `+ marine.js`, and suppressing the
 * HUD's first-tick geoid request turned it IMPROVED with `- egm96-universal.esm.js`.
 */

test('resource keys drop Vite content hashes and nothing else', () => {
  assert.equal(resourceKey('/assets/index-DB4WOJsT.js'), 'index.js');
  assert.equal(resourceKey('/assets/egm96-universal.esm-D6y_VLZc.js?v=1'), 'egm96-universal.esm.js');
  assert.equal(resourceKey('/assets/marine-BJ61ZZ9E.js'), 'marine.js');
  // Unhashed paths, including Cesium's static tree, pass through unchanged.
  assert.equal(resourceKey('/cesium/Cesium.js'), '/cesium/Cesium.js');
  assert.equal(resourceKey('/cesium/Assets/IAU2006_XYS/IAU2006_XYS_18.json'), '/cesium/Assets/IAU2006_XYS/IAU2006_XYS_18.json');
  // A hyphenated name whose tail is not an 8-char hash keeps its tail.
  assert.equal(resourceKey('/assets/landing-point.json'), 'landing-point.json');
});

test('vendor = Cesium static files or a chunk named after a runtime dependency', () => {
  const deps = ['cesium', 'egm96-universal', 'mgrs'];
  assert.equal(isVendorKey('/cesium/Cesium.js', deps), true);
  assert.equal(isVendorKey('egm96-universal.esm.js', deps), true);
  assert.equal(isVendorKey('mgrs.js', deps), true);
  assert.equal(isVendorKey('index.js', deps), false);
  assert.equal(isVendorKey('marine.js', deps), false);
});

test('load verdicts: equal passes; an added file or vendor rise regresses; a removal or vendor drop improves', () => {
  const baseline = { files: ['/cesium/Cesium.js', 'egm96-universal.esm.js', 'index.js'], vendorBytes: { '/cesium/Cesium.js': 100, 'egm96-universal.esm.js': 50 } };

  const same = compareLoad(baseline, structuredClone(baseline));
  assert.equal(same.verdict, 'equal');

  const pulledOn = compareLoad(baseline, { ...structuredClone(baseline), files: [...baseline.files, 'marine.js'] });
  assert.equal(pulledOn.verdict, 'regressed');
  assert.deepEqual(pulledOn.added, ['marine.js']);

  const vendorBump = compareLoad(baseline, { ...structuredClone(baseline), vendorBytes: { ...baseline.vendorBytes, '/cesium/Cesium.js': 101 } });
  assert.equal(vendorBump.verdict, 'regressed');
  assert.deepEqual(vendorBump.vendorDeltas, [{ key: '/cesium/Cesium.js', delta: 1 }]);

  const deferred = compareLoad(baseline, { files: ['/cesium/Cesium.js', 'index.js'], vendorBytes: { '/cesium/Cesium.js': 100 } });
  assert.equal(deferred.verdict, 'improved');
  assert.deepEqual(deferred.removed, ['egm96-universal.esm.js']);
  assert.deepEqual(deferred.vendorDeltas, [{ key: 'egm96-universal.esm.js', delta: -50 }]);

  // A swap (one file off, another on) is a rise, not a wash.
  const swapped = compareLoad(baseline, { files: ['/cesium/Cesium.js', 'index.js', 'marine.js'], vendorBytes: { '/cesium/Cesium.js': 100 } });
  assert.equal(swapped.verdict, 'regressed');
});
