import { test } from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import { TILE_RETRIES, gibsWorthRetrying, retryCallback, worthRetrying } from "./tileRetry.js";
import { gibsProvider, gibsTilePixelReader } from "./gibsLayer.js";
import { createTilePixelReader } from "./gibsReadout.js";

test("a 5xx or a failure with no status is asked again; a 4xx is an answer, but GIBS's 404 is not", async () => {
  assert.equal(worthRetrying(500), true);
  assert.equal(worthRetrying(503), true);
  assert.equal(worthRetrying(undefined), true);
  assert.equal(worthRetrying(404), false);
  assert.equal(worthRetrying(400), false);
  assert.equal(gibsWorthRetrying(404), true);
  assert.equal(gibsWorthRetrying(500), true);
  assert.equal(gibsWorthRetrying(400), false); // GIBS's answer for a tile outside the matrix
  const waited = [];
  const retry = retryCallback(worthRetrying, async (ms) => { waited.push(ms); });
  assert.equal(await retry(null, new Cesium.RequestErrorEvent(500)), true);
  assert.equal(await retry(null, new Cesium.RequestErrorEvent(404)), false);
  assert.equal(waited.length, 1); // only the 500 paused
});

/** Cesium's image loader replaced the way its specs do, answering each request with the next status (200 = a tile). */
function withImageAnswers(statuses, body) {
  const real = Cesium.Resource._Implementations.createImage;
  // isCrossOriginUrl parses URLs through an <a> and window.location; node has neither
  const hadDom = "document" in globalThis;
  if (!hadDom) {
    globalThis.window = { location: { href: "https://musharna.github.io/wildeye/" } };
    globalThis.document = {
      createElement: () => {
        let u = null;
        return { set href(v) { u = new URL(v, "https://musharna.github.io/"); }, get href() { return u.href; }, get host() { return u.host; }, get protocol() { return u.protocol; } };
      },
    };
  }
  const asked = [];
  Cesium.Resource._Implementations.createImage = (request, crossOrigin, deferred) => {
    const status = statuses[asked.push(request.url) - 1] ?? 200;
    if (status === 200) deferred.resolve({ width: 256, height: 256 });
    else deferred.reject(new Cesium.RequestErrorEvent(status));
  };
  return body(asked).finally(() => {
    Cesium.Resource._Implementations.createImage = real;
    if (!hadDom) {
      delete globalThis.document;
      delete globalThis.window;
    }
  });
}

test("a GIBS tile answered 500 or 404 is asked again through Cesium and drawn; a 400 is not asked again", async () => {
  const provider = gibsProvider("https://gibs.example/wmts/L/default/2025-01-01/M/{z}/{y}/{x}.png", { maximumLevel: 7 });
  await withImageAnswers([500], async (asked) => {
    assert.deepEqual(await provider.requestImage(6, 3, 3), { width: 256, height: 256 });
    assert.equal(asked.length, 2);
    assert.equal(asked[1], asked[0]); // the same tile, twice
    assert.match(asked[0], /\/3\/3\/6\.png$/);
  });
  await withImageAnswers([404, 404], async (asked) => {
    assert.deepEqual(await provider.requestImage(5, 3, 3), { width: 256, height: 256 });
    assert.equal(asked.length, 3);
  });
  // positive control: GIBS's 400 is an answer; the tile fails at once
  await withImageAnswers([400], async (asked) => {
    await assert.rejects(provider.requestImage(7, 3, 3), (e) => e.statusCode === 400);
    assert.equal(asked.length, 1);
  });
});

test("the readout asks a failed tile again, gives up after TILE_RETRIES, and never re-asks an answer", async () => {
  const png = { width: 1, height: 1, data: Uint8Array.from([1, 2, 3, 255]) };
  const rig = (statuses, options = {}) => {
    const calls = [];
    const read = createTilePixelReader({
      fetchImpl: async (u) => {
        const status = statuses[calls.push(u) - 1] ?? 200;
        return { ok: status === 200, status, headers: new Map(), blob: async () => null };
      },
      decodeImage: async () => png,
      wait: async () => {},
      ...options,
    });
    return { read, calls };
  };
  const flaky = rig([500, 503]);
  assert.deepEqual((await flaky.read("u", 0, 0)).rgba, [1, 2, 3, 255]);
  assert.equal(flaky.calls.length, 3);
  const down = rig([500, 500, 500, 500]);
  await assert.rejects(down.read("u", 0, 0), /GIBS tile HTTP 500/);
  assert.equal(down.calls.length, 1 + TILE_RETRIES);
  const missing = rig([404]);
  await assert.rejects(missing.read("u", 0, 0), /GIBS tile HTTP 404/);
  assert.equal(missing.calls.length, 1);
  // the GIBS layer's own reader asks a 404 again; the default reader above did not
  const calls = [];
  const gibsRead = gibsTilePixelReader({
    fetchImpl: async (u) => { const status = calls.push(u) === 1 ? 404 : 200; return { ok: status === 200, status, headers: new Map(), blob: async () => null }; },
    decodeImage: async () => png,
    wait: async () => {},
  });
  assert.deepEqual((await gibsRead("u", 0, 0)).rgba, [1, 2, 3, 255]);
  assert.equal(calls.length, 2);
});
