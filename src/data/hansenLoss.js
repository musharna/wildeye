import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { createTilePixelReader, gibsTileRequest } from "./gibsReadout.js";
import { FIRST_YEAR, LAST_YEAR, decodeLossPixel, maxCodeFor, rampColour } from "./hansenPixels.js";

/**
 * Tree-cover loss, 2001–2024 (Hansen et al. 2013, Science 342:850, doi:10.1126/science.1244693; UMD GFC v1.12,
 * CC BY 4.0), from Global Forest Watch's data tiles at 30% canopy (grill_wildeye_next_wave_2026-09-25 Q5–Q7).
 * The tiles carry the loss year in a channel, so a Web Worker recolours each one before it is drawn (a 512-px
 * tile took ~20 ms at 6× CPU throttle on the main thread) and a point readout decodes the year exactly.
 * Cumulative on the time bar: loss after the observed year is not drawn.
 */
export const TILE_SIZE = 512;
export const MAX_LEVEL = 12; // 512 px at z12 ≈ 19 m, finer than the 30 m data
export const TILE_FAILURE_LIMIT = 8;
const SOURCE = "Hansen/UMD/Google/USGS/NASA via Global Forest Watch";

export function hansenTileUrl(z, x, y) {
  // v1.12 without /dynamic/ answers every tile with a 307 to this address (probe 2026-09-25)
  return `https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.12/dynamic/${z}/${x}/${y}.png?implementation=tcd_30`;
}

/** Posts `{id, url, maxCode}` to the recolour worker; resolves with its ImageBitmap. */
export function createRecolourClient(
  makeWorker = () => new Worker(new URL("./hansenLoss.worker.js", import.meta.url), { type: "module" }),
) {
  let worker = null,
    seq = 0;
  const pending = new Map();
  const ensure = () => {
    if (worker) return worker;
    const w = makeWorker();
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.bitmap);
    };
    w.onerror = (e) => {
      const error = new Error(`recolour worker failed: ${e?.message ?? e}`);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  };
  return (url, maxCode) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ensure().postMessage({ id, url, maxCode });
    });
}

export function createHansenLossLayer({
  id = "hansen-loss",
  name = "Forest loss (Hansen/UMD, 2001–2024)",
  icon = "🪓",
  recolourTile = createRecolourClient(),
  providerFor = (requestImage) => {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: hansenTileUrl("{z}", "{x}", "{y}"),
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      maximumLevel: MAX_LEVEL,
      credit: SOURCE,
    });
    provider.requestImage = requestImage;
    return provider;
  },
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  readTilePixel = createTilePixelReader(),
  zrank = 20,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _drawnCode = null,
    _enabled = false,
    _observed = null,
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
    _drawnCode = null;
  };

  const draw = (code) => {
    if (code === _drawnCode && _imagery) {
      _imagery.show = _enabled;
      return;
    }
    drop();
    _generation += 1;
    _tileFailures = 0;
    if (_lastError === "map tiles failing") _lastError = null;
    const generation = _generation;
    const provider = providerFor((x, y, level) => recolourTile(hansenTileUrl(level, x, y), code));
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      const error = tileError?.error ?? tileError;
      const message = String(error?.message ?? error);
      if (/OffscreenCanvas/.test(message)) {
        if (_lastError !== message) console.error(`[Data:${id}] cannot recolour tiles`, { error });
        _lastError = message;
        return;
      }
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] GFW tiles failing`, { code, error });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
    _drawnCode = code;
  };

  const apply = () => {
    const code = maxCodeFor(_observed);
    if (code < 1) {
      if (_imagery) _imagery.show = false;
      _lastError = `no forest loss is mapped before 2001 (shown: ${String(_observed).slice(0, 10)})`;
      return;
    }
    if (_lastError?.startsWith("no forest loss")) _lastError = null;
    draw(code);
  };

  const shownCode = () => maxCodeFor(_observed);

  return {
    id,
    name,
    icon,
    source: `${SOURCE} · CC BY 4.0`,
    updateInterval: 24 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = shownCode() >= 1;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      // Cesium never re-requests a failed tile; a fresh provider is the retry
      if (_lastError === "map tiles failing") drop();
      apply();
      _lastUpdate = Date.now();
      return true;
    },
    async setObservedTime(iso) {
      _observed = iso || null;
      if (_viewer) apply();
      return true;
    },
    getObservedExtent() {
      return { startMs: Date.UTC(FIRST_YEAR, 0, 1), endMs: Date.UTC(LAST_YEAR, 11, 31, 23) };
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
      _observed = null;
    },
    getRowControls() {
      const years = [2001, 2006, 2012, 2018, 2024];
      const legend = years.map((y) => ({ label: String(y), color: `rgb(${rampColour(y).join(",")})`, count: null }));
      legend.push({ label: "Year of tree-cover loss, 30% canopy (Hansen/UMD v1.12)", color: "transparent", count: null });
      return { chips: [], legend };
    },
    /** The loss year at a point, from the full-resolution tile (z12, 512 px); null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      const req = gibsTileRequest(hansenTileUrl("{z}", "{x}", "{y}"), MAX_LEVEL, lat, lon, TILE_SIZE);
      if (!req) return row("outside");
      let pixel;
      try {
        pixel = await readTilePixel(req.url, req.px, req.py);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, url: req.url, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      const v = decodeLossPixel(pixel.rgba);
      if (v.kind === "none") return row("class", { text: "No loss detected", date: `${FIRST_YEAR}–${LAST_YEAR}` });
      if (v.kind === "unknown") return row("error", { error: `unrecognised pixel ${v.rgba.join(",")}` });
      const after = v.year - 2000 > shownCode();
      return row("class", { text: after ? "Forest loss (after the date shown)" : "Forest loss", date: String(v.year) });
    },
    getStats() {
      const code = shownCode();
      return {
        count: 1,
        lastUpdate: _lastUpdate,
        error: _lastError,
        time: code >= 1 ? `${FIRST_YEAR}–${2000 + code}` : null,
        observed: _observed,
      };
    },
  };
}

export const hansenLossLayer = createHansenLossLayer();
