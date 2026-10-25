import { test } from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import { readFileSync } from "node:fs";
import {
  createGibsLayer,
  classTileDiscardPolicy,
  gibsTileUrl,
  TILE_FAILURE_LIMIT,
} from "./gibsLayer.js";
import { decodePng } from "./pngDecode.js";

const ENTRY = {
  gibsId: "VIIRS_Black_Marble",
  tileMatrixSet: "GoogleMapsCompatible_Level8",
  maximumLevel: 8,
  format: "png",
  times: ["2012-01-01/2012-01-01/P1Y", "2016-01-01/2016-01-01/P1Y"],
  legend: "Night lights, true colour (no values)",
};

function harness({ entry = ENTRY, timeless = false, tilePixels } = {}) {
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
    ...(tilePixels ? { tilePixels } : {}),
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
      colorToAlpha: options.colorToAlpha,
      minificationFilter: options.minificationFilter,
      magnificationFilter: options.magnificationFilter,
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

test("failing tiles recover: a new date clears the error, and a refresh on the same date re-requests the tiles", async () => {
  // Review 2026-09-22: the error outlived the provider that earned it, and nothing re-requested failed tiles.
  const { layer, providers } = harness();
  await layer.update();
  const origError = console.error;
  console.error = () => {};
  const failAll = (p) => {
    for (let i = 0; i < TILE_FAILURE_LIMIT; i++)
      p.fail(new Cesium.RequestErrorEvent(503));
  };
  try {
    failAll(providers.at(-1));
    assert.equal(layer.getStats().error, "map tiles failing");
    await layer.setObservedTime("2014-06-01T00:00:00Z"); // 2012: a new provider
    assert.equal(layer.getStats().error, null);
    failAll(providers.at(-1));
    assert.equal(layer.getStats().error, "map tiles failing"); // positive control: still detected
    const n = providers.length;
    await layer.update(); // the 6-hourly refresh, date unchanged
    assert.equal(providers.length, n + 1, "failed tiles are re-requested");
    assert.match(providers.at(-1).url, /\/2012-01-01\//);
    assert.equal(layer.getStats().error, null);
    await layer.update(); // healthy refresh
    assert.equal(providers.length, n + 1, "a healthy layer is not rebuilt");
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

test("a class layer draws opaque so its colours match the legend; a value layer keeps its alpha", async () => {
  // Land cover was drawn at the default 0.7 over the basemap, so every class read darker than its legend
  // swatch and desert showed the tan basemap through (ledger 2026-09-23). In a class map the colour IS the
  // datum; only a continuous overlay may be translucent.
  const classes = { ...ENTRY, classes: [{ rgb: [5, 69, 10], label: "Evergreen needleleaf forest" }] };
  const cls = harness({ entry: classes });
  cls.layer.enable();
  await cls.layer.update();
  assert.equal(cls.list.at(-1).alpha, 1);

  const value = harness();
  value.layer.enable();
  await value.layer.update();
  assert.equal(value.list.at(-1).alpha, 0.7);
});

test("an undated layer (SEDAC: no time dimension) draws GIBS's dateless tiles at any time and is labelled with its year", async () => {
  // GIBS lists the SEDAC grids with no time dimension; a dated URL would need a date nothing serves, and an
  // empty date list read as a gap hid the layer for ever (probe 2026-10-02).
  const entry = { ...ENTRY, gibsId: "Amphibian_Richness_All_Species_2013", tileMatrixSet: "GoogleMapsCompatible_Level7", maximumLevel: 7, times: [], asOf: "2013" };
  const { layer, providers, list } = harness({ entry });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.match(
    providers[0].url,
    /\/Amphibian_Richness_All_Species_2013\/default\/GoogleMapsCompatible_Level7\/\{z\}\/\{y\}\/\{x\}\.png$/,
  );
  await layer.setObservedTime("1990-06-01T00:00:00Z");
  assert.equal(list.at(-1).show, true);
  assert.equal(providers.length, 1);
  assert.deepEqual([layer.getStats().error, layer.getStats().time, layer.getObservedExtent()], [null, "2013", null]);
  const noYear = harness({ entry: { ...entry, asOf: undefined } });
  assert.equal(await noYear.layer.update(), false);
  assert.match(noYear.layer.getStats().error, /gibs-nightlights load error/);
  // positive control: a dated layer still puts its date in the URL
  const dated = harness();
  await dated.layer.update();
  assert.match(dated.providers[0].url, /\/default\/2016-01-01\//);
});

test("black that is only ever no data is drawn transparent; black that is also data is drawn", async () => {
  // GIBS's empty SEDAC tile in EPSG:3857 is opaque black (no tRNS chunk, probe 2026-10-02): drawn as is, every
  // ocean tile paints black. GEDI and EVI draw black (or 0,0,1) as data, so it must stay.
  const sedac = harness({ entry: { ...ENTRY, noData: [[0, 0, 0], [255, 255, 255]], decode: [[0, 128, 0, 255, 255]] } });
  sedac.layer.enable();
  await sedac.layer.update();
  assert.ok(Cesium.Color.BLACK.equals(sedac.list.at(-1).colorToAlpha));
  const gedi = harness({ entry: { ...ENTRY, decode: [[0, 0, 0, 0, 1], [0, 0, 43, 1, 2]] } });
  gedi.layer.enable();
  await gedi.layer.update();
  assert.equal(gedi.list.at(-1).colorToAlpha, undefined);
  // no-data black next to a data colour Cesium's threshold cannot tell from black (EVI's 0,0,1) stays drawn
  const near = harness({ entry: { ...ENTRY, noData: [[0, 0, 0]], decode: [[0, 0, 1, 0.97, 1.0]] } });
  near.layer.enable();
  await near.layer.update();
  assert.equal(near.list.at(-1).colorToAlpha, undefined);
  // no-data that is not black (LST's 64,64,64) leaves black alone: Cesium can key out one colour, and it is black
  const lst = harness({ entry: { ...ENTRY, noData: [[64, 64, 64]], decode: [[255, 1, 0, 350, 652]] } });
  lst.layer.enable();
  await lst.layer.update();
  assert.equal(lst.list.at(-1).colorToAlpha, undefined);
});

test("the live canopy and anthromes entries key black out; GPP, whose classes are transparent in the tile, does not", async () => {
  // fixtures/gibs-trio.json: live pipeline output 2026-10-03. Canopy and anthromes declare black no data and draw
  // no colour near it; anthromes is undated, so its URL has no date and it is labelled with its period.
  const { layers } = JSON.parse(readFileSync(new URL("./fixtures/gibs-trio.json", import.meta.url)));
  const drawn = async (entry) => {
    const h = harness({ entry });
    h.layer.enable();
    assert.equal(await h.layer.update(), true);
    return h;
  };
  const canopy = await drawn(layers["gibs-canopy"]);
  assert.ok(Cesium.Color.BLACK.equals(canopy.list.at(-1).colorToAlpha));
  const anthromes = await drawn(layers["gibs-anthromes"]);
  assert.ok(Cesium.Color.BLACK.equals(anthromes.list.at(-1).colorToAlpha));
  assert.match(anthromes.providers[0].url, /\/Anthropogenic_Biomes_of_the_World_2001-2006\/default\/GoogleMapsCompatible_Level7\//);
  assert.equal(anthromes.layer.getStats().time, "2001–2006");
  assert.equal(anthromes.list.at(-1).alpha, 1); // a class map draws opaque
  const gpp = await drawn(layers["gibs-gpp"]);
  assert.equal(gpp.list.at(-1).colorToAlpha, undefined);
  assert.equal(gpp.list.at(-1).alpha, 0.7);
});

test("a hidden class is the one colour keyed out, not black; two hidden classes are an error, not a guess", async () => {
  // OPERA DIST-ANN: "No Disturbance" (18,18,18) covers 90-99% of a tile and is hidden (pipeline/gibs.py LAYERS);
  // its no data is already transparent in the tile (probe 2026-10-24), so black does not need the key.
  const classes = [
    { label: "No disturbance", rgb: [18, 18, 18], hidden: true },
    { label: "Disturbed", rgb: [224, 27, 7] },
  ];
  const one = harness({ entry: { ...ENTRY, classes, noData: [[0, 0, 0]] } });
  one.layer.enable();
  assert.equal(await one.layer.update(), true);
  assert.ok(Cesium.Color.fromBytes(18, 18, 18).equals(one.list.at(-1).colorToAlpha));
  assert.equal(one.list.at(-1).alpha, 1);
  // the same entry with nothing hidden still keys out its no-data black, as before
  const none = harness({ entry: { ...ENTRY, classes: classes.map(({ hidden, ...c }) => c), noData: [[0, 0, 0]] } });
  none.layer.enable();
  assert.equal(await none.layer.update(), true);
  assert.ok(Cesium.Color.BLACK.equals(none.list.at(-1).colorToAlpha));
  // Cesium keys out one colour: two hidden classes would draw one of them, so nothing is drawn and the error says so
  const two = harness({ entry: { ...ENTRY, classes: classes.map((c) => ({ ...c, hidden: true })) } });
  two.layer.enable();
  assert.equal(await two.layer.update(), false);
  assert.equal(two.list.length, 0);
  assert.match(two.layer.getStats().error, /gibs-nightlights: 2 hidden classes/);
});

test("the live disturbance entry keys out No disturbance, draws opaque on the year chosen, and hides it from the legend", async () => {
  // fixtures/gibs-disturbance.json: live pipeline output 2026-10-24
  const { layers } = JSON.parse(readFileSync(new URL("./fixtures/gibs-disturbance.json", import.meta.url)));
  const h = harness({ entry: layers["gibs-disturbance"] });
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.ok(Cesium.Color.fromBytes(18, 18, 18).equals(h.list.at(-1).colorToAlpha));
  // a blend of a class colour and the keyed one is neither, and draws as dark halos (local build 2026-10-24): no blending
  assert.equal(h.list.at(-1).magnificationFilter, Cesium.TextureMagnificationFilter.NEAREST);
  assert.equal(h.list.at(-1).minificationFilter, Cesium.TextureMinificationFilter.NEAREST);
  // a class map with nothing hidden keeps Cesium's default filtering (no change to the existing layers)
  const shown = harness({ entry: { ...layers["gibs-disturbance"], classes: layers["gibs-disturbance"].classes.map(({ hidden, ...c }) => c) } });
  await shown.layer.update();
  assert.deepEqual([shown.list.at(-1).minificationFilter, shown.list.at(-1).magnificationFilter], [undefined, undefined]);
  assert.match(h.providers[0].url, /\/OPERA_L3_DIST-ANN-HLS_Color_Index\/default\/2025-01-01\/GoogleMapsCompatible_Level12\//);
  await h.layer.setObservedTime("2023-08-01T00:00:00Z");
  assert.match(h.providers.at(-1).url, /\/default\/2023-01-01\//);
  const labels = h.layer.getRowControls().legend.map((l) => l.label);
  assert.ok(!labels.includes("No disturbance") && labels.includes("Disturbed, ongoing: half or more of the plant cover lost"));
});

// fixtures/README.md: real OPERA tiles; the corrupt one GIBS also served is not kept (its bytes are other requests')
const DIST = () => JSON.parse(readFileSync(new URL("./fixtures/gibs-disturbance.json", import.meta.url))).layers["gibs-disturbance"];
const tilePng = (name) => decodePng(new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));
const decoded = (img) => img.data;

test("a class tile holding a pixel that is no class colour is discarded, so Cesium draws its parent; real tiles are kept", async () => {
  const land = await tilePng("opera-dist-2025-land-9-173-151.png");
  const ocean = await tilePng("opera-dist-2025-ocean-8-128-106.png");
  const policy = classTileDiscardPolicy(DIST(), { pixelsOf: decoded });
  assert.equal(policy.isReady(), true);
  assert.equal(policy.shouldDiscardImage(land), false); // every class drawn, the carried-over 51,51,51 among them
  assert.equal(policy.shouldDiscardImage(ocean), false);
  // the corrupt tile's shape (probe 2026-10-24): an otherwise empty tile whose last row holds the bytes of text
  const corrupt = { ...ocean, data: Uint8Array.from(ocean.data) };
  corrupt.data.set(new TextEncoder().encode("AHTSE Retile"), corrupt.data.length - 64);
  assert.equal(policy.shouldDiscardImage(corrupt), true);
  // a class colour half transparent is a blend, not a class (the large corrupt tiles: 40,000+ such pixels)
  const blended = { ...land, data: Uint8Array.from(land.data) };
  blended.data.set([224, 27, 7, 128], 0);
  assert.equal(policy.shouldDiscardImage(blended), true);
  // GIBS's colour map alone lacks values 9 and 10, and would throw the real land tile away
  const mapOnly = { ...DIST(), classes: DIST().classes.slice(0, 5) };
  assert.equal(classTileDiscardPolicy(mapOnly, { pixelsOf: decoded }).shouldDiscardImage(land), true);
});

test("the tile check goes to Cesium only where gibs.json asks; a check that cannot read pixels keeps the tile and says so", async () => {
  const land = await tilePng("opera-dist-2025-land-9-173-151.png");
  const h = harness({ entry: DIST(), tilePixels: decoded });
  assert.equal(await h.layer.update(), true);
  assert.equal(h.providers[0].options.tileDiscardPolicy.shouldDiscardImage(land), false);
  const plain = harness({ entry: { ...DIST(), discardForeignTiles: undefined }, tilePixels: decoded });
  assert.equal(await plain.layer.update(), true);
  assert.equal(plain.providers[0].options.tileDiscardPolicy, undefined);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const broken = harness({ entry: DIST(), tilePixels: () => { throw new Error("tainted canvas"); } });
    assert.equal(await broken.layer.update(), true);
    assert.equal(broken.providers[0].options.tileDiscardPolicy.shouldDiscardImage(land), false);
    assert.equal(broken.layer.getStats().error, "gibs-nightlights: tiles cannot be checked (tainted canvas)");
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
  }
});
