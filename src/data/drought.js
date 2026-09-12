import * as Cesium from "cesium";

/**
 * U.S. drought categories (polygon contract): the U.S. Drought Monitor's weekly D0–D4
 * MultiPolygons from pipeline/drought.py, newest five releases, official USDM palette. One
 * release is shown at a time: live the newest; with the shared observed time set, the
 * newest release whose Thursday release date is ≤ the instant (a Tuesday-valid map is not
 * public until Thursday, so an instant between the two shows the previous week). The info
 * box carries the credit line the NDMC requires verbatim.
 */
const DATA_URL = "data/drought.geojson";
const FILL_ALPHA = 0.55;

export const DROUGHT_CLASSES = Object.freeze([
  { key: "d0", dm: 0, label: "D0 abnormally dry", color: "#FFFF00" },
  { key: "d1", dm: 1, label: "D1 moderate drought", color: "#FCD37F" },
  { key: "d2", dm: 2, label: "D2 severe drought", color: "#FFAA00" },
  { key: "d3", dm: 3, label: "D3 extreme drought", color: "#E60000" },
  { key: "d4", dm: 4, label: "D4 exceptional drought", color: "#730000" },
]);

export function droughtClass(dm) {
  return DROUGHT_CLASSES.find((c) => c.dm === Number(dm)) || null;
}

/**
 * The release in scope: `weeks` = [{w, released}] newest first. iso null → newest; else the
 * newest release whose `released` date (from 00:00 UTC that day) is ≤ the instant; none → null.
 */
export function releaseAt(weeks, iso) {
  const ws = weeks || [];
  if (!iso) {
    return ws.length
      ? { week: ws[0], label: `newest release, map of ${ws[0].w}` }
      : { week: null, label: "no release loaded" };
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { week: null, label: "invalid time" };
  const hit = ws.find((w) => t >= Date.parse(`${w.released}T00:00:00Z`));
  return hit
    ? { week: hit, label: `map of ${hit.w} (released ${hit.released})` }
    : { week: null, label: `no release stored before ${iso.slice(0, 10)}` };
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function describeCategory(p, scope, source = {}) {
  const cls = droughtClass(p.dm);
  return (
    `<b>${esc(cls ? cls.label : p.label)}</b><br>` +
    `U.S. Drought Monitor, ${esc(scope.label)}<br>` +
    `${Math.round(p.area_km2 || 0).toLocaleString()} km² in this category (${p.parts ?? 0} area${p.parts === 1 ? "" : "s"} drawn)<br>` +
    `<small>Boundaries simplified for the globe; categories are the USDM's own. ${esc(source.credit || "")}</small><br>` +
    `<a href="${esc(source.url || "https://droughtmonitor.unl.edu/")}" target="_blank" rel="noopener">${esc(source.name || "U.S. Drought Monitor")}</a>`
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

/** Entity options for one (week, category) feature: one per polygon part. */
export function categoryEntities(f, scope, source = {}) {
  const p = f.properties || {};
  const cls = droughtClass(p.dm);
  if (!cls) return [];
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(
    FILL_ALPHA,
  );
  const polys =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
  const description = describeCategory(p, scope, source);
  return polys.map((poly, k) => ({
    id: `drought:${p.w}:${cls.key}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: color.withAlpha(0.9),
      outlineWidth: 1,
      // D4 must draw above D0 where the simplified rings overlap
      zIndex: cls.dm + 1,
    },
    description,
    properties: {
      w: p.w,
      released: p.released,
      dm: cls.dm,
      cls: cls.key,
      label: cls.label,
      area_km2: p.area_km2,
      scope: scope.label,
      part: k,
    },
  }));
}

export function createDroughtLayer() {
  let _dataSource = null;
  let _features = [];
  let _weeks = [];
  let _source = {};
  let _newest = null;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const scopeNow = () => releaseAt(_weeks, _observed);
  const rebuild = () => {
    if (!_dataSource) return;
    const scope = scopeNow();
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    if (scope.week)
      for (const f of _features)
        if (f.properties?.w === scope.week.w)
          for (const e of categoryEntities(f, scope, _source)) es.add(e);
    es.resumeEvents();
  };
  const classAreas = () => {
    const c = {};
    for (const e of _dataSource?.entities.values || []) {
      if (e.properties?.part?.getValue?.() !== 0) continue;
      const k = e.properties?.cls?.getValue?.();
      c[k] = (c[k] || 0) + (e.properties?.area_km2?.getValue?.() || 0);
    }
    return c;
  };

  const layer = {
    id: "drought",
    name: "Drought (U.S. Drought Monitor)",
    icon: "🌵",
    source:
      "U.S. Drought Monitor, jointly produced by the National Drought Mitigation Center (UNL), USDA, NOAA and NASA; map courtesy of NDMC",
    updateInterval: 24 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("drought");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _weeks = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Drought] Initialized");
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
          _lastError = `drought.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features) || !Array.isArray(gj.weeks)) {
          _lastError = "Malformed drought.geojson";
          return false;
        }
        _features = gj.features;
        _weeks = gj.weeks;
        _source = gj.source || {};
        _newest = gj.newest ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Drought] Updated: ${_features.length} week×category features over ${_weeks.length} releases, newest map ${_newest}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Drought] Load error:", e);
        _lastError = `drought.geojson load error: ${e?.message || e}`;
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _features = [];
      _weeks = [];
      _lastUpdate = null;
      _lastError = null;
    },

    setObservedTime(iso) {
      if (iso && !Number.isFinite(Date.parse(iso))) return false;
      const next = iso || null;
      if (next === _observed) return true;
      _observed = next;
      rebuild();
      _rowControlsListener?.();
      return true;
    },

    getRowControls() {
      const areas = classAreas();
      const legend = DROUGHT_CLASSES.map((c) => ({
        label: `${c.label} km²`,
        color: c.color,
        count: Math.round(areas[c.key] ?? 0),
      }));
      const scope = scopeNow();
      legend.push({
        label:
          _observed === null
            ? `fill = USDM drought category, ${scope.label}; maps are valid on a Tuesday and public on the Thursday`
            : `fill = USDM drought category, ${scope.label}`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      return _dataSource.entities.values
        .filter((e) => e.properties?.part?.getValue?.(now) === 0)
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            week: g("w"),
            released: g("released"),
            dm: g("dm"),
            cls: g("cls"),
            label: g("label"),
            area_km2: g("area_km2"),
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
        newest: _newest,
        weeks: _weeks.length,
        observed: _observed,
        scope: scopeNow().label,
        classes: classAreas(),
      };
    },
  };
  return layer;
}

const droughtLayer = createDroughtLayer();
export default droughtLayer;
