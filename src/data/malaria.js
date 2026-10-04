import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";

/**
 * Malaria: Plasmodium falciparum parasite rate in children aged 2–10 (PfPR2–10), yearly 2000–2025 at 5 km, from the
 * Malaria Atlas Project's 2026-08 release (CC BY 3.0, malariaatlas.org/open-access-policy; spec
 * docs/superpowers/specs/2026-10-03-map-malaria-design.md). Drawn straight from MAP's GeoServer WMS at the year on the
 * time bar, never re-hosted. A point readout asks the same server for the cell's estimate and its 95% interval
 * (GetFeatureInfo), so the value is MAP's number, not a colour read back off a picture.
 */
export const MAP_WMS = "https://data.malariaatlas.org/geoserver/ows";
export const MAP_LAYER = "Malaria:202608_Global_Pf_Parasite_Rate";
export const MAP_STYLE = "Malaria:Global_Pf_Parasite_Rate_Batlow_masked";
// the release's time dimension, read from the live capabilities 2026-10-03 (scripts/qa-malaria.mjs re-checks it)
export const YEARS = Object.freeze(Array.from({ length: 26 }, (_, k) => 2000 + k));
// the style's colour map (GetStyles, 2026-10-03; re-checked by scripts/qa-malaria.mjs): rate → colour
export const RAMP = Object.freeze([
  [0, "#011959"],
  [0.2, "#185562"],
  [0.4, "#577647"],
  [0.6, "#b38e2f"],
  [0.8, "#fba689"],
  [1, "#faccfa"],
]);
export const SPARSE_COLOR = "#F0F0F0";
export const NO_ESTIMATE = -9999;
export const TILE_FAILURE_LIMIT = 8;
const MAX_LEVEL = 5; // geographic level 5: 0.022° a pixel, finer than the 1/24° (0.042°) grid
const SOURCE = "Malaria Atlas Project, 2026-08 release · CC BY 3.0";

/** The year drawn at an observed instant: live = the latest; otherwise the latest at or before it; null before 2000. */
export function yearAt(iso, years = YEARS) {
  if (!iso) return years[years.length - 1];
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new RangeError(`observed time is not a date: ${iso}`);
  const y = new Date(t).getUTCFullYear();
  let shown = null;
  for (const year of years) if (year <= y) shown = year;
  return shown;
}

/** MAP's time value for a year, exactly as its capabilities list it. */
export const timeOf = (year) => `${year}-01-01T00:00:00.000Z`;

/**
 * GetFeatureInfo for the cell under a point. WMS 1.1.1 with EPSG:4326 orders the bbox lon,lat (1.3.0 would order it
 * lat,lon: a probe of mine read 10°N 0°E for a point meant to be 0°N 10°E). A 3×3 image centred on the point, queried at
 * its centre pixel (x=1, y=1), so the cell asked for is the one the point falls in.
 */
export function featureInfoUrl(lat, lon, year, d = 0.001) {
  const q = new URLSearchParams({
    service: "WMS",
    version: "1.1.1",
    request: "GetFeatureInfo",
    layers: MAP_LAYER,
    query_layers: MAP_LAYER,
    styles: "",
    srs: "EPSG:4326",
    bbox: [lon - d, lat - d, lon + d, lat + d].join(","),
    width: "3",
    height: "3",
    x: "1",
    y: "1",
    info_format: "application/json",
    time: timeOf(year),
  });
  return `${MAP_WMS}?${q}`;
}

/**
 * MAP's GetFeatureInfo answer → no estimate (-9999: outside the mapped countries), sparsely populated (MAP masks the
 * cell and draws it grey), or the rate with its 95% interval. Anything else throws: a changed response must not read
 * as "no malaria".
 */
export function readEstimate(json) {
  const props = (json?.features || []).map((f) => f?.properties || {}).find((p) => "Data" in p);
  if (!props) throw new Error(`MAP GetFeatureInfo has no Data band: ${JSON.stringify(json).slice(0, 200)}`);
  const { Data: rate, Mask__Sparsely_Populated: mask, LCI: lci, UCI: uci } = props;
  if (rate === NO_ESTIMATE) return { kind: "none" };
  if (mask === 1) return { kind: "sparse" };
  for (const [k, v] of Object.entries({ Data: rate, LCI: lci, UCI: uci }))
    if (!(typeof v === "number" && v >= 0 && v <= 1)) throw new Error(`MAP GetFeatureInfo ${k} is not a rate: ${v}`);
  return { kind: "value", rate, lci, uci };
}

/** A rate as a percentage: one decimal, and "< 0.1%" below that (MAP's modelled rates run down to 1e-15). */
export function pct(rate) {
  return rate < 0.001 ? "< 0.1%" : `${(rate * 100).toFixed(1)}%`;
}

export function estimateText({ rate, lci, uci }) {
  return `${pct(rate)} of children aged 2–10 carry P. falciparum (95% interval ${pct(lci)} to ${pct(uci)})`;
}

export function createMalariaLayer({
  id = "malaria",
  name = "Malaria: P. falciparum in children (MAP, 2000–2025)",
  icon = "🦟",
  fetchImpl = (u) => fetch(u),
  providerFor = (options) => new Cesium.WebMapServiceImageryProvider(options),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider, { alpha: 0.75 }),
  stack = setStackedImagery,
  zrank = 27,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _observed = null,
    _drawnYear = null,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const shown = () => yearAt(_observed);

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
    _drawnYear = null;
  };

  const draw = (year) => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    const generation = _generation;
    const provider = providerFor({
      url: MAP_WMS,
      layers: MAP_LAYER,
      parameters: { format: "image/png", transparent: true, styles: MAP_STYLE, time: timeOf(year) },
      tilingScheme: new Cesium.GeographicTilingScheme(),
      // the release's extent (capabilities EX_GeographicBoundingBox): no requests for tiles it cannot cover
      rectangle: Cesium.Rectangle.fromDegrees(-180, -60, 180, 85),
      maximumLevel: MAX_LEVEL,
      credit: SOURCE,
    });
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] MAP tiles failing`, { year, error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
    _drawnYear = year;
  };

  const apply = () => {
    const year = shown();
    if (year === null) {
      if (_imagery) _imagery.show = false;
      _lastError = `no malaria estimate before ${YEARS[0]} (shown: ${String(_observed).slice(0, 10)})`;
      return;
    }
    if (_lastError?.startsWith("no malaria estimate")) _lastError = null;
    if (!_imagery || _drawnYear !== year || _lastError === "map tiles failing") draw(year);
    else _imagery.show = _enabled;
  };

  return {
    id,
    name,
    icon,
    source: SOURCE,
    updateInterval: 24 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = shown() !== null;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      apply();
      _lastUpdate = Date.now();
      return true;
    },
    async setObservedTime(iso) {
      if (iso && !Number.isFinite(Date.parse(iso))) return false;
      _observed = iso || null;
      if (_viewer) apply();
      return true;
    },
    /** Shared observed-time hook: 2000-01-01 to 2025-12-31, the years the release estimates. */
    getObservedExtent() {
      return { startMs: Date.UTC(YEARS[0], 0, 1), endMs: Date.UTC(YEARS[YEARS.length - 1], 11, 31, 23, 59, 59, 999) };
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
      _observed = null;
    },
    getRowControls() {
      const legend = RAMP.map(([v, color]) => ({ label: `${Math.round(v * 100)}%`, color, count: null }));
      legend.push({ label: "Sparsely populated (MAP masks the estimate)", color: SPARSE_COLOR, count: null });
      legend.push({
        label: "Share of children aged 2–10 carrying P. falciparum, modelled per 5 km cell (MAP 2026-08); not drawn outside the mapped countries",
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** MAP's estimate for the cell under a point in the year shown, with its 95% interval; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      const year = shown();
      if (year === null) return row("gap", { observed: _observed });
      if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) return row("outside");
      const url = featureInfoUrl(lat, lon, year);
      let est;
      try {
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`MAP GetFeatureInfo HTTP ${res.status}`);
        est = readEstimate(await res.json());
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url, error: e });
        return row("error", { date: String(year), error: e?.message || String(e) });
      }
      if (est.kind === "none") return row("nodata", { date: String(year) });
      if (est.kind === "sparse") return row("value", { date: String(year), text: "Sparsely populated: MAP masks the estimate here" });
      return row("value", { date: String(year), text: estimateText(est) });
    },
    getStats() {
      const year = shown();
      return { count: 1, lastUpdate: _lastUpdate, error: _lastError, time: year === null ? null : String(year), observed: _observed };
    },
  };
}

export const malariaLayer = createMalariaLayer();
