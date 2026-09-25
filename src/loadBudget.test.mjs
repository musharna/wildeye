import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLoad, isVendorKey, manifestSources, startupKey, summarizeEntries } from '../scripts/load-budget-check.mjs';

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
  // manualChunks groups: only a chunk named vendor-* is vendor code.
  assert.equal(isVendorKey('chunk:vendor-cesium'), true);
  assert.equal(isVendorKey('chunk:regions'), false);
});

test('a manualChunks group with no source module is keyed by name, not its hashed file', () => {
  const build = (hash) => manifestSources({
    ...MANIFEST,
    [`_vendor-cesium-${hash}.js`]: { file: `assets/vendor-cesium-${hash}.js`, name: 'vendor-cesium' },
  });
  // Two builds of different Cesium content give the same key, so the baseline holds across builds.
  assert.equal(startupKey('/assets/vendor-cesium-CNfq2d1x.js', build('CNfq2d1x')), 'chunk:vendor-cesium');
  assert.equal(startupKey('/assets/vendor-cesium-Zz9Yy8Xx.js', build('Zz9Yy8Xx')), 'chunk:vendor-cesium');
  // Sourced chunks keep their source keys alongside it.
  assert.equal(startupKey('/assets/index-DB4WOJsT.js', build('CNfq2d1x')), 'index.html');
  // A sourceless chunk with no name cannot be keyed stably: fail loud.
  assert.throws(() => manifestSources({ '_x-AAAAAAAA.js': { file: 'assets/x-AAAAAAAA.js' } }), /neither src nor name/);
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

test('a file fetched twice counts once at its real size, whichever fetch finished first', () => {
  const origin = 'http://127.0.0.1:4173';
  const sources = manifestSources(MANIFEST);
  const shared = `${origin}/assets/egm96-universal.esm-D6y_VLZc.js`;
  const real = { url: shared, bytes: 4601 };
  const coalesced = { url: shared, bytes: 0 };
  const others = [
    { url: `${origin}/assets/index-DB4WOJsT.js`, bytes: 1500 },
    { url: 'https://tile.googleapis.com/v1/3dtiles/root.json', bytes: 999 },
    { url: `${origin}/cesium/Widgets/widgets.css`, bytes: 30 },
    // Streaming-driven: which Cesium workers start depends on terrain streaming, not app code.
    { url: `${origin}/cesium/Workers/incrementallyBuildTerrainPicker.js`, bytes: 2098 },
  ];
  const zeroFirst = summarizeEntries([coalesced, ...others, real], origin, sources);
  const zeroLast = summarizeEntries([real, ...others, coalesced], origin, sources);
  // Two loads that differ only in fetch order must agree, at the file's real size.
  assert.deepEqual(zeroFirst, zeroLast);
  assert.equal(zeroFirst.vendorBytes['node_modules/egm96-universal/dist/egm96-universal.esm.js'], 4601);
  // Positive control: the rest of the summary is still right. Cross-origin and
  // non-script files and Cesium workers are out, the app entry is in, and the shared file is listed once.
  assert.deepEqual(zeroFirst.files, ['index.html', 'node_modules/egm96-universal/dist/egm96-universal.esm.js']);
  assert.deepEqual(zeroFirst.appBytes, { 'index.html': 1500 });
});
