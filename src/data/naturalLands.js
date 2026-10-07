import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";

/**
 * SBTN Natural Lands Map v1.1 (WRI Land & Carbon Lab for the Science Based Targets Network; 2020 baseline, 30 m;
 * CC BY-SA 4.0; Mazur et al. 2025, technical documentation), drawn as served from Global Forest Watch's tile cache and
 * never re-hosted (spec docs/superpowers/specs/2026-10-06-natural-lands-design.md).
 *
 * The cache draws the map's 20 classes in three colours. Which classes each colour stands for was read from the raw
 * classification GeoTIFFs at sampled points (analysis/natlands_legend.py, table docs/analysis/natlands_legend_crosstab.md),
 * not from colour names: GROUPS below is that table. Because a colour stands for several classes, a click cannot say
 * which class a place is, so this layer has no point readout (ledger grill_wildeye_wave3 decision 2). A 2020 baseline,
 * so not on the time bar.
 */
export const TILE_URL = "https://tiles.globalforestwatch.org/sbtn_natural_lands_classification/v1.1/default_pro/{z}/{x}/{y}.png";
// the cache's finest level: data-api creation_options max_zoom 12, and tiles past it are exact 2x upsamples of their
// level-12 parent (probe 2026-10-06); scripts/qa-natural-lands.mjs re-checks both
export const MAX_LEVEL = 12;
export const TILE_FAILURE_LIMIT = 8;
const SOURCE = "WRI / SBTN Natural Lands Map v1.1 via Global Forest Watch";

// value -> name, from the class sheet the README links (read 2026-10-06)
export const CLASSES = Object.freeze({
  2: "natural forests",
  3: "natural short vegetation",
  4: "natural water",
  5: "mangroves",
  6: "bare",
  7: "snow",
  8: "wetland natural forests",
  9: "natural peat forests",
  10: "wetland natural short vegetation",
  11: "natural peat short vegetation",
  12: "crop",
  13: "built",
  14: "non-natural tree cover",
  15: "non-natural short vegetation",
  16: "non-natural water",
  17: "wetland non-natural tree cover",
  18: "non-natural peat tree cover",
  19: "wetland non-natural short vegetation",
  20: "non-natural peat short vegetation",
  21: "non-natural bare",
});

// each tile colour and the classes it stands for, from docs/analysis/natlands_legend_crosstab.md
export const GROUPS = Object.freeze([
  Object.freeze({ rgb: Object.freeze([36, 110, 36]), title: "Natural forest", classes: Object.freeze([2, 5, 8, 9]) }),
  Object.freeze({ rgb: Object.freeze([185, 185, 30]), title: "Other natural land and water", classes: Object.freeze([3, 4, 6, 7, 10, 11]) }),
  Object.freeze({ rgb: Object.freeze([211, 211, 211]), title: "Non-natural land", classes: Object.freeze([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) }),
]);

/** The legend row for a colour: its title and every class it stands for, by the sheet's names. */
export const groupLabel = (g) => `${g.title}: ${g.classes.map((v) => CLASSES[v]).join(", ")}`;

/** True only when every colour stands for exactly one class and no class has two colours: the condition for a readout. */
export function oneColourPerClass(groups) {
  const all = groups.flatMap((g) => g.classes);
  return groups.every((g) => g.classes.length === 1) && new Set(all).size === all.length && new Set(groups.map((g) => String(g.rgb))).size === groups.length;
}

export function createNaturalLandsLayer({
  id = "natural-lands",
  name = "Natural lands 2020 (SBTN Natural Lands Map)",
  icon = "🌄",
  providerFor = (options) => new Cesium.UrlTemplateImageryProvider(options),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  zrank = 21,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  const draw = () => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    const generation = _generation;
    // web-mercator XYZ, the provider's default scheme; every tile exists (outside the map it is 200 and transparent),
    // so any tile error is a fault
    const provider = providerFor({ url: TILE_URL, maximumLevel: MAX_LEVEL, credit: SOURCE });
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] GFW tiles failing`, { error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
  };

  return {
    id,
    name,
    icon,
    source: `${SOURCE} · CC BY-SA 4.0`,
    updateInterval: 24 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = true;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      // Cesium never re-requests a failed tile; a fresh provider is the retry
      if (!_imagery || _lastError === "map tiles failing") draw();
      else _imagery.show = _enabled;
      _lastUpdate = Date.now();
      return true;
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
    },
    getRowControls() {
      const legend = GROUPS.map((g) => ({ label: groupLabel(g), color: `rgb(${g.rgb.join(",")})`, count: null }));
      legend.push({
        label: "Natural and non-natural land in 2020, 30 m (SBTN Natural Lands Map v1.1, WRI); Global Forest Watch draws its 20 classes in these three colours, so a colour names a group, not a class · CC BY-SA 4.0",
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    getStats() {
      return { count: 1, lastUpdate: _lastUpdate, error: _lastError, time: "2020" };
    },
  };
}

export const naturalLandsLayer = createNaturalLandsLayer();
