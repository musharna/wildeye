// src/data/pngDecode.test.mjs — exact PNG decoding for tile readouts, against digests from an independent decoder (PIL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodePng } from './pngDecode.js';
import { createTilePixelReader } from './gibsReadout.js';
import { decodeOccurrence } from './surfaceWater.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const sha = (data) => createHash('sha256').update(data).digest('hex');

// sha256 of PIL's `.convert('RGBA').tobytes()` for each file (fixtures/README.md)
const CASES = [
  ['jrc-occurrence-13-6462-3802.png', 256, '3c1e8e9664e74669a4d41bdb1b68af9404f2ebac324f5f7793dea47a997b2777'], // RGBA, semi-transparent
  ['jrc-occurrence-8-103-120.png', 256, '592222441a1005a084f94ce26ec7db665f43c10cc6c373e19544774cbdb0c5eb'], // RGB
  ['gibs-evi-2024-06-09-4-4-6.png', 256, '056dbdf31fcc91a5c47392fe9cab8938f411a154d77d9da75e74ad12130ea402'], // palette + tRNS, ocean transparent
  ['png-filters-rgba-37x23.png', 37, '4b295dca56ef2cdf633b3dc4beb688609f068e20af6cbfc373aede9ae68746e0'], // rows filtered None/Sub/Up/Average/Paeth
  ['png-filters-rgb-37x23.png', 37, '8dbb1ff7b80e1e295f5f7f3b103da83d9150956774838ebab7da343ce525d039'],
  // Paeth at a tie: left 0, up 15, up-left 10 → pa == pc < pb, and the predictor must take left
  ['png-paeth-tie-rgb-2x2.png', 2, '1d57d7aecee691c515ddf5a7ac7ea18c3342affbbdd409391a0739306e1b7941'],
];

test('real tiles and every row filter decode to exactly the RGBA an independent decoder reads', async () => {
  for (const [name, width, digest] of CASES) {
    const img = await decodePng(fixture(name));
    assert.equal(img.width, width, name);
    assert.equal(img.data.length, img.width * img.height * 4, name);
    assert.equal(sha(img.data), digest, name);
  }
  const evi = await decodePng(fixture('gibs-evi-2024-06-09-4-4-6.png'));
  const alphas = new Set();
  for (let i = 3; i < evi.data.length; i += 4) alphas.add(evi.data[i]);
  assert.deepEqual([...alphas].sort((a, b) => a - b), [0, 255], 'the palette tile has both transparent and opaque pixels');
  assert.deepEqual([...(await decodePng(fixture('png-paeth-tie-rgb-2x2.png'))).data.slice(12, 16)], [99, 99, 99, 255]);
});

test('a semi-transparent pixel keeps its colour: the tile reader reads Tonle Sap at 83% (the 2D-canvas path read 43,0,210,212)', async () => {
  const bytes = fixture('jrc-occurrence-13-6462-3802.png');
  const read = createTilePixelReader({
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), blob: async () => new Blob([bytes]) }),
  });
  const { rgba } = await read('jrc', 9, 4);
  assert.deepEqual(rgba, [43, 0, 211, 212]);
  assert.deepEqual(decodeOccurrence(rgba), { kind: 'value', percent: 83 });
});

test('anything but an 8-bit, non-interlaced RGB, RGBA or palette PNG is refused by name', async () => {
  const good = fixture('png-filters-rgba-37x23.png');
  assert.equal((await decodePng(good)).width, 37, 'positive control');
  const patched = (offset, value) => {
    const b = good.slice();
    b[offset] = value; // IHDR data starts at byte 16: width 4, height 4, depth, colour type, compression, filter, interlace
    return b;
  };
  await assert.rejects(decodePng(new TextEncoder().encode('<html>not a tile</html>')), /not a PNG/);
  await assert.rejects(decodePng(patched(24, 16)), /bit depth 16/);
  await assert.rejects(decodePng(patched(25, 4)), /colour type 4/);
  await assert.rejects(decodePng(patched(28, 1)), /interlaced/);
  await assert.rejects(decodePng(good.slice(0, good.length - 40)), /PNG/);
});
