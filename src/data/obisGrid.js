import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";

/**
 * Marine records, OBIS (Ocean Biodiversity Information System, IOC-UNESCO): records, species, datasets and years per 1°
 * cell from OBIS's open-data export, CC0 1.0 and CC BY 4.0 datasets only, built by pipeline/obis_grid.py (spec
 * docs/superpowers/specs/2026-10-02-obis-grid-design.md). The globe shows one 360 × 180 PNG, a pixel per cell, shaded by
 * records in decades; the readout looks the cell up in the manifest, not the image. A fixed snapshot, so not on the time
 * bar.
 */
export const MANIFEST_URL = "data/obis_grid.json";
export const COLUMNS = ["lat", "lon", "records", "species", "datasets", "first_year", "last_year"];
const SOURCE = "OBIS (2026) Ocean Biodiversity Information System, IOC-UNESCO";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isYear = (v) => v === null || Number.isInteger(v);

/** null when obis_grid.json has the shape pipeline/obis_grid.py writes; otherwise what is wrong with it. */
export function validateObisGridManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  if (typeof m.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.asOf)) return `asOf ${JSON.stringify(m.asOf)} is not a date`;
  if (m.cell_degrees !== 1) return `cell_degrees ${JSON.stringify(m.cell_degrees)} is not 1`;
  if (typeof m.image !== "string" || !m.image.endsWith(".png")) return `image ${JSON.stringify(m.image)} is not a PNG path`;
  if (!Array.isArray(m.palette) || m.palette.length !== 7 || !m.palette.every(isRgb)) return "palette is not 7 RGB colours";
  const f = m.bin_floors;
  if (!Array.isArray(f) || f.length !== m.palette.length || !f.every((v, i) => isCount(v) && v >= 1 && (i === 0 || v > f[i - 1])))
    return "bin_floors is not one rising floor per palette colour";
  if (!Array.isArray(m.columns) || m.columns.join() !== COLUMNS.join()) return `columns ${JSON.stringify(m.columns)} are not ${COLUMNS.join(", ")}`;
  const s = m.share;
  if (!s || !["datasets_in", "datasets_total", "datasets_out", "records_in", "records_total_listed"].every((k) => isCount(s[k])))
    return "share lacks a dataset or record count";
  if (!Array.isArray(m.cells)) return "cells is not a list";
  for (const c of m.cells) {
    const ok = Array.isArray(c) && c.length === 7 && Number.isInteger(c[0]) && c[0] >= -90 && c[0] <= 89
      && Number.isInteger(c[1]) && c[1] >= -180 && c[1] <= 179 && c[2] >= 1 && isCount(c[2]) && isCount(c[3]) && c[4] >= 1 && isCount(c[4])
      && isYear(c[5]) && isYear(c[6]);
    if (!ok) return `cell ${JSON.stringify(c)} is not [lat, lon, records ≥ 1, species, datasets ≥ 1, first_year, last_year]`;
  }
  return null;
}

/** The 1° cell a point falls in, keyed as the pipeline writes it: south-west corner, 90°N and 180°E folded in. */
export function cellOf(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
  // only a longitude past ±180 wraps: 180 itself folds into the 179 cell, as the pipeline's least(floor(lon), 179)
  const wrapped = lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
  return `${Math.min(Math.floor(lat), 89)},${Math.min(Math.floor(wrapped), 179)}`;
}

const n = (v) => v.toLocaleString("en-US");
const plural = (v, one, many) => `${n(v)} ${v === 1 ? one : many}`;

/** A cell's readout text: counts, then the years its dated records span. */
export function cellText([, , records, species, datasets, y0, y1]) {
  const years = y0 === null ? "no dated records" : y0 === y1 ? `${y0}` : `${y0}–${y1}`;
  return `${plural(records, "record", "records")} · ${plural(species, "species", "species")} · ${plural(datasets, "dataset", "datasets")} · ${years}`;
}

const cellIndex = new WeakMap();
function lookup(manifest, key) {
  let t = cellIndex.get(manifest);
  if (!t) {
    t = new Map(manifest.cells.map((c) => [`${c[0]},${c[1]}`, c]));
    cellIndex.set(manifest, t);
  }
  return t.get(key) ?? null;
}

const decade = (floor) => (floor >= 1_000_000 ? `${n(floor)}+` : `${n(floor)}–${n(floor * 10 - 1)}`);

export function createObisGridLayer({
  id = "obis-grid",
  name = "Marine records (OBIS)",
  icon = "🐚",
  fetchImpl = (u) => fetch(u),
  providerFor = (url, rectangle) => Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle, credit: SOURCE }),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  zrank = 22,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _manifest = null,
    _lastUpdate = null,
    _lastError = null,
    _generation = 0;

  const drop = () => {
    _generation += 1; // a drape still loading is now stale
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  const draw = async () => {
    drop();
    const generation = _generation;
    let provider;
    try {
      // the asOf query busts a cached image from an earlier build
      provider = await providerFor(`${_manifest.image}?v=${_manifest.asOf}`, Cesium.Rectangle.fromDegrees(-180, -90, 180, 90));
    } catch (e) {
      if (generation === _generation) {
        _lastError = `${_manifest.image} load error: ${e?.message || e}`;
        console.error(`[Data:${id}] ${_lastError}`, e);
      }
      return false;
    }
    if (generation !== _generation || !_viewer) return false;
    _lastError = null;
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
    return true;
  };

  const load = async () => {
    try {
      const res = await fetchImpl(MANIFEST_URL);
      if (!res.ok) {
        _lastError = `obis_grid.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateObisGridManifest(m);
      if (bad) {
        _lastError = `Malformed obis_grid.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `obis_grid.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "OBIS open-data export, CC0 1.0 and CC BY 4.0 datasets (obis.org)",
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
      if (!_manifest && !(await load())) return false;
      // a failed image is retried by the next update
      if (!_imagery && !(await draw())) return false;
      _lastUpdate = Date.now();
      return true;
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
    },
    getRowControls() {
      if (!_manifest) return { chips: [], legend: [] };
      const legend = _manifest.palette.map((c, i) => ({ label: `${decade(_manifest.bin_floors[i])} records`, color: `rgb(${c.join(",")})`, count: null }));
      const s = _manifest.share;
      const pct = s.records_total_listed ? Math.round((100 * s.records_in) / s.records_total_listed) : 0;
      legend.push({
        label: `Records per 1° cell, OBIS ${_manifest.asOf}: ${n(s.datasets_in)} CC0 / CC BY datasets, about ${pct}% of OBIS's records; records track survey effort, not richness`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The cell's records, species, datasets and years; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "obis_grid.json not loaded yet" });
      const key = cellOf(lat, lon);
      if (!key) return row("outside");
      const date = `OBIS ${_manifest.asOf}`;
      const c = lookup(_manifest, key);
      return row("value", { text: c ? cellText(c) : "no records", date });
    },
    getStats() {
      return { count: _manifest?.cells.length ?? 0, lastUpdate: _lastUpdate, error: _lastError, time: _manifest?.asOf ?? null };
    },
  };
}

export const obisGridLayer = createObisGridLayer();
