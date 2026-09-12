import * as Cesium from "cesium";
import { binsAt, LIVE_WEEKS } from "./gfw.js";

/**
 * Apparent fishing effort on a 1° grid (polygon contract): one square per 1° cell with
 * AIS-derived fishing hours from pipeline/fishing.py (Global Fishing Watch 4Wings report,
 * CC BY-NC 4.0, "Powered by Global Fishing Watch"). Fill = hours PER WEEK in the cell, so
 * a single observed week and the live LIVE_WEEKS window share one scale (the same bin
 * logic as the deforestation layer, imported from it). Chips toggle gear types; a cell
 * whose visible gears sum to zero fades out. Absence of colour is not absence of fishing:
 * only vessels broadcasting AIS are seen, and the info box says so.
 */
const DATA_URL = "data/fishing.geojson";
const FILL_ALPHA = 0.55;

export const EFFORT_CLASSES = Object.freeze([
  {
    key: "trace",
    label: "< 5 h / cell / week",
    color: "#fef3c7",
    test: (h) => h < 5,
  },
  { key: "low", label: "5 – 25 h", color: "#fbbf24", test: (h) => h < 25 },
  { key: "mid", label: "25 – 100 h", color: "#f97316", test: (h) => h < 100 },
  { key: "high", label: "100 – 500 h", color: "#dc2626", test: (h) => h < 500 },
  {
    key: "intense",
    label: "> 500 h / cell / week",
    color: "#7f1d1d",
    test: () => true,
  },
]);
export const NO_DATA = Object.freeze({
  key: "none",
  label: "no apparent fishing in scope",
  color: "#6b7280",
});

export function effortClass(h) {
  if (!Number.isFinite(h) || h <= 0) return NO_DATA;
  return EFFORT_CLASSES.find((c) => c.test(h));
}

/** Hours per gear over the bins in scope, restricted to visible gears; `perWeek` = total / span. */
export function sumBins(bins, span, visible = {}) {
  const gear = {};
  let hours = 0;
  for (const b of bins)
    for (const [g, h] of Object.entries(b.gear || {})) {
      if (visible[g] === false) continue;
      gear[g] = (gear[g] || 0) + h;
      hours += h;
    }
  return { hours, perWeek: span ? hours / span : 0, gear };
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const gearLabel = (g) => String(g).replace(/_/g, " ");
const fmtH = (h) => (h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString());
/** "39–40" for the 1° band starting at lat/lon `v` (SW corner), hemisphere-free. */
const span = (v) => `${Math.min(Math.abs(v), Math.abs(v + 1))}–${Math.max(Math.abs(v), Math.abs(v + 1))}`;

export function describeCell(p, scope, sum, source = {}) {
  const lat = Number(p.lat),
    lon = Number(p.lon);
  const gears = Object.entries(sum.gear)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([g, h]) => `${esc(gearLabel(g))} ${fmtH(h)} h`)
    .join(", ");
  return (
    `<b>1° cell ${span(lat)}°${lat >= 0 ? "N" : "S"}, ${span(lon)}°${lon >= 0 ? "E" : "W"}</b><br>` +
    `Apparent fishing, ${esc(scope.label)}: <b>${fmtH(sum.hours)}</b> h` +
    (scope.span > 1 ? ` (${fmtH(sum.perWeek)} h per week)` : "") +
    (gears ? `<br>${gears}` : "") +
    `<br>${fmtH(Number(p.hours || 0))} h in this cell over the file's window` +
    `<br><small>Hours in which AIS movement was classified as fishing; vessels without AIS are invisible and gear types are inferred.</small><br>` +
    `<a href="${esc(source.url || "https://globalfishingwatch.org")}" target="_blank" rel="noopener">${esc(source.attribution || "Powered by Global Fishing Watch")}</a> · ${esc(source.licence || "CC BY-NC 4.0")}`
  );
}

const ring = (coords) =>
  Cesium.Cartesian3.fromDegreesArray(
    coords.flatMap(([lon, lat]) => [lon, lat]),
  );
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(
    ring(poly[0]),
    poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))),
  );

/** Entity options for one cell at the observed instant (one per polygon part). */
export function cellEntities(f, observedIso, today, visible = {}, source = {}) {
  const p = f.properties || {};
  const scope = binsAt(p.weeks, observedIso, today);
  const sum = sumBins(scope.bins, scope.span, visible);
  const cls = effortClass(sum.perWeek);
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(
    cls === NO_DATA ? 0.08 : FILL_ALPHA,
  );
  const polys =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
  return polys.map((poly, k) => ({
    id: `fishing:${p.lon}:${p.lat}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: cls !== NO_DATA,
      outlineColor: color.withAlpha(0.8),
      outlineWidth: 1,
    },
    description: describeCell(p, scope, sum, source),
    properties: {
      lon: p.lon,
      lat: p.lat,
      hours: sum.hours,
      perWeek: sum.perWeek,
      top: Object.entries(sum.gear).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      cls: cls.key,
      scope: scope.label,
      part: k,
    },
  }));
}

export function createFishingLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _today = null;
  let _gears = [];
  let _visible = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features)
      for (const e of cellEntities(f, _observed, _today, _visible, _source))
        es.add(e);
    es.resumeEvents();
  };
  const classCounts = () => {
    const c = {};
    for (const e of _dataSource?.entities.values || []) {
      if (e.properties?.part?.getValue?.() !== 0) continue;
      const k = e.properties?.cls?.getValue?.() ?? "none";
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  };

  const layer = {
    id: "fishing",
    name: "Fishing effort (Global Fishing Watch)",
    icon: "🎣",
    source:
      "Powered by Global Fishing Watch — apparent fishing effort from AIS (CC BY-NC 4.0)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("fishing");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Fishing] Initialized");
    },
    enable() {
      if (_dataSource) _dataSource.show = true;
    },
    disable() {
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      try {
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
        if (!res.ok) {
          _lastError = `fishing.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed fishing.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _today = gj.today ?? null;
        _gears = Array.isArray(gj.gears) ? gj.gears : [];
        for (const g of _gears) if (!(g in _visible)) _visible[g] = true;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Fishing] Updated: ${_features.length} cells, ${_gears.length} gear types, version ${_source.version}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Fishing] Load error:", e);
        _lastError = `fishing.geojson load error: ${e?.message || e}`;
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _features = [];
      _lastUpdate = null;
      _lastError = null;
    },

    /** Shared observed-time hook: colour each cell by the 7-day bin containing the instant. */
    setObservedTime(iso) {
      if (iso && !Number.isFinite(Date.parse(iso))) return false;
      const next = iso || null;
      if (next === _observed) return true;
      _observed = next;
      rebuild();
      _rowControlsListener?.();
      return true;
    },

    /** Gear-type chips: `{ trawlers: false }` hides a gear; unknown keys are ignored. */
    setParams(params = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "boolean" && k in _visible && _visible[k] !== v) {
          _visible[k] = v;
          changed = true;
        }
      }
      if (changed) {
        rebuild();
        _rowControlsListener?.();
      }
      return changed;
    },
    getParams() {
      return { ..._visible };
    },

    getRowControls() {
      const counts = classCounts();
      const chips = _gears.map((g) => ({
        id: g,
        label: gearLabel(g).toUpperCase(),
        active: _visible[g] !== false,
        state: _visible[g] !== false ? "active" : "idle",
        title: `${_visible[g] !== false ? "Hide" : "Show"} ${gearLabel(g)}`,
        params: { [g]: !(_visible[g] !== false) },
      }));
      const legend = [...EFFORT_CLASSES, NO_DATA].map((c) => ({
        label: c.label,
        color: c.color,
        count: counts[c.key] ?? 0,
      }));
      legend.push({
        label:
          _observed === null
            ? `cell fill = apparent fishing hours per 1° cell per week, last ${LIVE_WEEKS} weeks (${_source.version ?? "?"}); AIS-based, so unseen is not absent · Powered by Global Fishing Watch`
            : "cell fill = apparent fishing hours per 1° cell in the week of the observed time; AIS-based, so unseen is not absent · Powered by Global Fishing Watch",
        color: "transparent",
        count: null,
      });
      return { chips, legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      return _dataSource.entities.values
        .filter(
          (e) =>
            e.properties?.part?.getValue?.(now) === 0 &&
            e.properties?.cls?.getValue?.(now) !== "none",
        )
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            lon: g("lon"),
            lat: g("lat"),
            hours: g("hours"),
            perWeek: g("perWeek"),
            gear: g("top"),
            cls: g("cls"),
            scope: g("scope"),
          };
        });
    },

    getStats() {
      return {
        count: _features.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        version: _source.version ?? null,
        gears: _gears.length,
        observed: _observed,
        classes: classCounts(),
      };
    },
  };
  return layer;
}

const fishingLayer = createFishingLayer();
export default fishingLayer;
