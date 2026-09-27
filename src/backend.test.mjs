// src/backend.test.mjs — base-aware asset URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetUrl } from './backend.js';

test('assetUrl joins the build base once, whatever the input slash', () => {
  // Mutant seen failing: returning the name unchanged gives "/logo.svg", which ignores /wildeye/.
  assert.equal(assetUrl('logo.svg', '/wildeye/'), '/wildeye/logo.svg');
  assert.equal(assetUrl('/mic.svg', '/wildeye/'), '/wildeye/mic.svg');
  assert.equal(assetUrl('logo.svg', '/wildeye'), '/wildeye/logo.svg');
  assert.equal(assetUrl('logo.svg', '/'), '/logo.svg', 'positive control: dev base stays root');
});
