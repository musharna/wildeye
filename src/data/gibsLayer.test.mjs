import { test } from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import {
  createGibsLayer,
  gibsTileUrl,
  TILE_FAILURE_LIMIT,
} from "./gibsLayer.js";

const ENTRY = {
  gibsId: "VIIRS_Black_Marble",
  tileMatrixSet: "GoogleMapsCompatible_Level8",
  maximumLevel: 8,
  format: "png",
  times: ["2012-01-01/2012-01-01/P1Y", "2016-01-01/2016-01-01/P1Y"],
  legend: "Night lights, true colour (no values)",
};

function harness({ entry = ENTRY, timeless = false } = {}) {
  const providers = [];
  const stacked = [];
  const list = [];
  const viewer = {
    imageryLayers: {
      add: (l) => list.push(l),
      remove: (l) => {
        list.splice(list.indexOf(l), 1);
        return true;
      },
      contains: (l) => list.includes(l),
    },
  };
  const layer = createGibsLayer({
    id: "gibs-nightlights",
    name: "Night lights",
    icon: "🌃",
    source: "NASA GIBS",
    zrank: 18,
    timeless,
    fetchJson: async () => ({ layers: { "gibs-nightlights": entry } }),
    providerFor: (url, options) => {
      const listeners = [];
      const p = {
        url,
        options,
        errorEvent: { addEventListener: (fn) => listeners.push(fn) },
        fail: (error) => listeners.forEach((fn) => fn({ error })),
      };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider, options) => ({
      provider,
      alpha: options.alpha,
      show: true,
    }),
    stack: (_layers, id, il, zrank) => stacked.push({ id, il, zrank }),
  });
  layer.init(viewer);
  return { layer, providers, stacked, list };
}

test("live shows the latest served date, in the URL and in the stats", async () => {
  const { layer, providers, stacked } = harness();
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(providers.length, 1);
  assert.match(
    providers[0].url,
    /\/VIIRS_Black_Marble\/default\/2016-01-01\/GoogleMapsCompatible_Level8\/\{z\}\/\{y\}\/\{x\}\.png$/,
  );
  assert.equal(providers[0].options.maximumLevel, 8);
  assert.equal(layer.getStats().time, "2016-01-01");
  assert.equal(stacked.at(-1).id, "gibs-nightlights");
});

test("scrubbing resolves the date itself; an unchanged date does not rebuild the imagery", async () => {
  const { layer, providers } = harness();
  await layer.update();
  await layer.setObservedTime("2014-06-01T00:00:00Z");
  assert.match(providers.at(-1).url, /\/2012-01-01\//);
  const n = providers.length;
  await layer.setObservedTime("2015-01-01T00:00:00Z");
  assert.equal(providers.length, n); // still 2012: no new provider
  await layer.setObservedTime(null);
  assert.match(providers.at(-1).url, /\/2016-01-01\//);
});

test("before the first served date the layer hides and says why; returning brings it back", async () => {
  const { layer, list } = harness();
  layer.enable();
  await layer.update();
  await layer.setObservedTime("2011-06-01T00:00:00Z");
  assert.equal(list.at(-1).show, false);
  assert.match(
    layer.getStats().error,
    /no gibs-nightlights data at or before 2011-06-01/,
  );
  await layer.setObservedTime("2013-01-01T00:00:00Z");
  assert.equal(list.at(-1).show, true); // positive control: the legitimate path still shows
  assert.equal(layer.getStats().error, null);
});

test("a timeless composite ignores the bar and declares no extent", async () => {
  const entry = { ...ENTRY, times: ["2019-04-18/2019-04-18/P1429D"] };
  const { layer, providers } = harness({ entry, timeless: true });
  await layer.update();
  await layer.setObservedTime("2001-01-01T00:00:00Z");
  assert.equal(providers.length, 1);
  assert.equal(layer.getObservedExtent(), null);
  const timed = harness();
  await timed.layer.update();
  assert.equal(
    new Date(timed.layer.getObservedExtent().startMs).toISOString(),
    "2012-01-01T00:00:00.000Z",
  );
});

test("tile request failures surface after the limit; other tile errors do not count", async () => {
  const { layer, providers } = harness();
  await layer.update();
  const p = providers.at(-1);
  const origError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < TILE_FAILURE_LIMIT - 1; i++)
      p.fail(new Cesium.RequestErrorEvent(503));
    p.fail(new Cesium.RuntimeError("decode"));
    assert.equal(layer.getStats().error, null);
    p.fail(new Cesium.RequestErrorEvent(503));
    assert.equal(layer.getStats().error, "map tiles failing");
  } finally {
    console.error = origError;
  }
});

test("a manifest without this layer is an error, not a blank layer", async () => {
  const { layer } = harness();
  const bare = createGibsLayer({
    id: "gibs-evi",
    name: "EVI",
    icon: "🌱",
    source: "x",
    zrank: 16,
    fetchJson: async () => ({ layers: {} }),
    providerFor: () => assert.fail("no provider"),
    imageryLayerFor: () => ({}),
    stack: () => {},
  });
  bare.init({ imageryLayers: {} });
  assert.equal(await bare.update(), false);
  assert.match(bare.getStats().error, /no gibs-evi in gibs\.json/);
  assert.equal(await layer.update(), true); // positive control
});

test("legend rows come from the manifest entry; a caption-only entry shows its caption", async () => {
  const { layer } = harness();
  await layer.update();
  assert.deepEqual(
    layer.getRowControls().legend.map((l) => l.label),
    ["Night lights, true colour (no values)"],
  );
  assert.equal(
    gibsTileUrl({ ...ENTRY, format: "jpeg" }, "2016-01-01").endsWith(
      "/{z}/{y}/{x}.jpeg",
    ),
    true,
  );
});
