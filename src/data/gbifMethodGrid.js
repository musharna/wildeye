import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";
import { cellOf } from "./obisGrid.js";

/**
 * Camera traps and eDNA, GBIF: per 1° cell, the CC0 1.0 and CC BY 4.0 animal records whose sampling protocol names the
 * method, from one GBIF SQL download, built by pipeline/camera_traps.py (spec
 * docs/superpowers/specs/2026-10-03-camera-traps-edna-design.md). One manifest, two layers: each shows its method's
 * 360 × 180 PNG (a pixel per cell, shaded by records in decades) and reads the cell from the manifest. Where the method
 * was used and published, not where animals are. A fixed snapshot, so not on the time bar.
 */
export const MANIFEST_URL = "data/camera_traps.json";
export const COLUMNS = ["lat", "lon", "records", "species", "datasets", "top_species"];
export const METHODS = Object.freeze({
  camera: Object.freeze({ id: "camera-traps", name: "Camera traps (GBIF)", icon: "📷", none: "no camera trap records", what: "camera traps" }),
  edna: Object.freeze({ id: "edna", name: "eDNA (GBIF)", icon: "🧬", none: "no eDNA records", what: "eDNA sampling" }),
});
const SOURCE = "GBIF.org occurrence download, CC0 1.0 and CC BY 4.0 records";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** null when camera_traps.json has the shape pipeline/camera_traps.py writes for `method`; otherwise what is wrong. */
export function validateMethodGridManifest(m, method) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  if (typeof m.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.asOf)) return `asOf ${JSON.stringify(m.asOf)} is not a date`;
  if (!m.download || typeof m.download.doi !== "string" || !/^10\.\d+\/\S+$/.test(m.download.doi)) return "download has no DOI";
  if (m.cell_degrees !== 1) return `cell_degrees ${JSON.stringify(m.cell_degrees)} is not 1`;
  const f = m.bin_floors;
  if (!Array.isArray(f) || f.length !== 7 || !f.every((v, i) => isCount(v) && v >= 1 && (i === 0 || v > f[i - 1])))
    return "bin_floors is not 7 rising floors";
  if (!Array.isArray(m.columns) || m.columns.join() !== COLUMNS.join()) return `columns ${JSON.stringify(m.columns)} are not ${COLUMNS.join(", ")}`;
  const s = m.methods?.[method];
  if (!s) return `no method ${JSON.stringify(method)}`;
  if (typeof s.image !== "string" || !s.image.endsWith(".png")) return `${method} image ${JSON.stringify(s.image)} is not a PNG path`;
  if (!Array.isArray(s.palette) || s.palette.length !== 7 || !s.palette.every(isRgb)) return `${method} palette is not 7 RGB colours`;
  if (!isCount(s.records) || !isCount(s.datasets)) return `${method} lacks its record or dataset count`;
  if (!Array.isArray(s.cells)) return `${method} cells is not a list`;
  for (const c of s.cells) {
    const ok = Array.isArray(c) && c.length === 6 && Number.isInteger(c[0]) && c[0] >= -90 && c[0] <= 89
      && Number.isInteger(c[1]) && c[1] >= -180 && c[1] <= 179 && c[2] >= 1 && isCount(c[2]) && isCount(c[3]) && c[4] >= 1 && isCount(c[4])
      && Array.isArray(c[5]) && c[5].length <= 3 && c[5].length <= c[3] && c[5].every((x) => typeof x === "string" && x);
    if (!ok) return `cell ${JSON.stringify(c)} is not [lat, lon, records ≥ 1, species, datasets ≥ 1, [up to 3 species]]`;
  }
  return null;
}

const n = (v) => v.toLocaleString("en-US");
const plural = (v, one, many) => `${n(v)} ${v === 1 ? one : many}`;

/** A cell's readout text: counts, then the species recorded most there. */
export function cellText([, , records, species, datasets, top]) {
  const counts = `${plural(records, "record", "records")} · ${plural(species, "species", "species")} · ${plural(datasets, "dataset", "datasets")}`;
  return top.length ? `${counts} (${top.join(", ")})` : counts;
}

const cellIndex = new WeakMap();
function lookup(cells, key) {
  let t = cellIndex.get(cells);
  if (!t) {
    t = new Map(cells.map((c) => [`${c[0]},${c[1]}`, c]));
    cellIndex.set(cells, t);
  }
  return t.get(key) ?? null;
}

const decade = (floor) => (floor >= 1_000_000 ? `${n(floor)}+` : `${n(floor)}–${n(floor * 10 - 1)}`);

export function createMethodGridLayer({
  method,
  fetchImpl = (u) => fetch(u),
  providerFor = (url, rectangle) => Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle, credit: SOURCE }),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  zrank = 22,
} = {}) {
  const spec = METHODS[method];
  if (!spec) throw new Error(`unknown method ${JSON.stringify(method)}`);
  const { id, name, icon } = spec;
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _manifest = null,
    _lastUpdate = null,
    _lastError = null,
    _generation = 0,
    _drawing = null; // the draw in flight: _imagery stays null across its await, so a second update joins it

  const ours = () => _manifest.methods[method];

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
      provider = await providerFor(`${ours().image}?v=${_manifest.asOf}`, Cesium.Rectangle.fromDegrees(-180, -90, 180, 90));
    } catch (e) {
      if (generation === _generation) {
        _lastError = `${ours().image} load error: ${e?.message || e}`;
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
        _lastError = `camera_traps.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateMethodGridManifest(m, method);
      if (bad) {
        _lastError = `Malformed camera_traps.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      return true;
    } catch (e) {
      _lastError = `camera_traps.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  return {
    id,
    name,
    icon,
    source: "GBIF.org occurrence download (SQL), CC0 1.0 and CC BY 4.0 records whose sampling protocol names the method",
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
      if (!_imagery) {
        if (!_drawing) {
          const p = draw().finally(() => { if (_drawing === p) _drawing = null; });
          _drawing = p;
        }
        if (!(await _drawing)) return false;
      }
      _lastUpdate = Date.now();
      return true;
    },
    destroy() {
      drop();
      _drawing = null; // a load still in flight is stale (drop moved the generation on); a later update starts afresh
      _viewer = null;
      _enabled = false;
    },
    getRowControls() {
      if (!_manifest) return { chips: [], legend: [] };
      const s = ours();
      const legend = s.palette.map((c, i) => ({ label: `${decade(_manifest.bin_floors[i])} records`, color: `rgb(${c.join(",")})`, count: null }));
      legend.push({
        label: `Records per 1° cell where ${spec.what} recorded animals and the records reached GBIF, ${_manifest.asOf}: ${n(s.records)} records from ${n(s.datasets)} CC0 / CC BY datasets. Where the method was used, not where animals are. GBIF.org occurrence download, doi:${_manifest.download.doi}`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The cell's records, species, datasets and most-recorded species; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "camera_traps.json not loaded yet" });
      const key = cellOf(lat, lon);
      if (!key) return row("outside");
      const c = lookup(ours().cells, key);
      return row("value", { text: c ? cellText(c) : spec.none, date: `GBIF ${_manifest.asOf}` });
    },
    getStats() {
      return { count: _manifest ? ours().cells.length : 0, lastUpdate: _lastUpdate, error: _lastError, time: _manifest?.asOf ?? null };
    },
  };
}

export const cameraTrapsLayer = createMethodGridLayer({ method: "camera" });
export const ednaLayer = createMethodGridLayer({ method: "edna" });
