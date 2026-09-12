// src/data/depthTest.test.mjs — bio point layers must be depth-tested at globe distances.
// `disableDepthTestDistance: Number.POSITIVE_INFINITY` never depth-tests a point, so markers on the
// far side of the earth draw THROUGH it (the real-app smoke 2026-09-12 showed Africa's fires over the
// open Pacific). A finite distance keeps the no-clipping benefit close to the ground only.
// Mutant seen failing: restoring POSITIVE_INFINITY in fires.js. Positive control: every file is read
// and each declares a finite numeric distance (so a deleted property also fails, not silently passes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const BIO_POINT_LAYERS = ['fires', 'rivers', 'phenology', 'cetaceans', 'h5n1', 'neon-vectors', 'occurrences', 'neon', 'otn', 'birds'];

test('bio point layers use a finite disableDepthTestDistance (no see-through-the-globe markers)', async () => {
  for (const id of BIO_POINT_LAYERS) {
    const src = await readFile(new URL(`./${id}.js`, import.meta.url), 'utf8');
    const settings = [...src.matchAll(/disableDepthTestDistance\s*:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
    assert.ok(settings.length > 0, `${id}: no disableDepthTestDistance property found`);
    for (const v of settings) {
      assert.ok(/^[\d_]+(\.\d+)?(e\d+)?$/.test(v) && Number.isFinite(Number(v.replace(/_/g, ''))),
        `${id}: disableDepthTestDistance is ${v}, must be a finite number literal`);
    }
  }
});
