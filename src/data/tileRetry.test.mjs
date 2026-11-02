import { test } from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import { TILE_RETRIES, retryTileError, worthRetrying } from "./tileRetry.js";
import { gibsProvider } from "./gibsLayer.js";
import { createTilePixelReader } from "./gibsReadout.js";

test("a 5xx or a failure with no status is asked again; a 4xx is an answer", async () => {
  assert.equal(worthRetrying(500), true);
  assert.equal(worthRetrying(503), true);
  assert.equal(worthRetrying(undefined), true);
  assert.equal(worthRetrying(404), false);
  assert.equal(worthRetrying(400), false);
  const waited = [];
  const wait = async (ms) => { waited.push(ms); };
  assert.equal(await retryTileError(null, new Cesium.RequestErrorEvent(500), wait), true);
  assert.equal(await retryTileError(null, new Cesium.RequestErrorEvent(404), wait), false);
  assert.equal(waited.length, 1); // only the 500 paused
});

test("a GIBS tile answered 500 once is asked again through Cesium and drawn", async () => {
  // Cesium's own image loader, replaced the way its specs do: the first request fails as a 500 does in a browser
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
    asked.push(request.url);
    if (asked.length === 1) deferred.reject(new Cesium.RequestErrorEvent(500));
    else deferred.resolve({ width: 256, height: 256 });
  };
  try {
    const provider = gibsProvider("https://gibs.example/wmts/L/default/2025-01-01/M/{z}/{y}/{x}.png", { maximumLevel: 7 });
    const image = await provider.requestImage(6, 3, 3);
    assert.deepEqual(image, { width: 256, height: 256 });
    assert.deepEqual(asked, [asked[0], asked[0]]); // the same tile, twice
    assert.match(asked[0], /\/3\/3\/6\.png$/);
    // positive control: a 404 is not asked again and the tile fails
    asked.length = 0;
    Cesium.Resource._Implementations.createImage = (request, crossOrigin, deferred) => {
      asked.push(request.url);
      deferred.reject(new Cesium.RequestErrorEvent(404));
    };
    await assert.rejects(provider.requestImage(7, 3, 3), (e) => e.statusCode === 404);
    assert.equal(asked.length, 1);
  } finally {
    Cesium.Resource._Implementations.createImage = real;
    if (!hadDom) {
      delete globalThis.document;
      delete globalThis.window;
    }
  }
});

test("the readout asks a 5xx tile again, gives up after TILE_RETRIES, and never re-asks a 404", async () => {
  const png = { width: 1, height: 1, data: Uint8Array.from([1, 2, 3, 255]) };
  const rig = (statuses) => {
    const calls = [];
    const read = createTilePixelReader({
      fetchImpl: async (u) => {
        const status = statuses[calls.push(u) - 1] ?? 200;
        return { ok: status === 200, status, headers: new Map(), blob: async () => null };
      },
      decodeImage: async () => png,
      wait: async () => {},
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
});
