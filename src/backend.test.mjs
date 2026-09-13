// src/backend.test.mjs — base-aware asset URLs and the static-host capability flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetUrl, HAS_BACKEND } from './backend.js';

test('assetUrl joins the build base once, whatever the input slash', () => {
  // Mutant seen failing: returning the name unchanged gives "/logo.svg", which ignores /wildeye/.
  assert.equal(assetUrl('logo.svg', '/wildeye/'), '/wildeye/logo.svg');
  assert.equal(assetUrl('/mic.svg', '/wildeye/'), '/wildeye/mic.svg');
  assert.equal(assetUrl('logo.svg', '/wildeye'), '/wildeye/logo.svg');
  assert.equal(assetUrl('logo.svg', '/'), '/logo.svg', 'positive control: dev base stays root');
});

test('outside a Vite build (node tests) the backend is assumed present', () => {
  assert.equal(HAS_BACKEND, true);
});
