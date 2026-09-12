import * as Cesium from "cesium";

/**
 * Deforestation alerts by country (polygon contract): one filled country per Natural
 * Earth shape with GFW integrated alerts in the window, from pipeline/gfw.py (Global Forest
 * Watch, CC BY 4.0). Fill = alert area per 10,000 km² of the country PER WEEK, so a single
 * observed week and the live LIVE_WEEKS window share one scale. Alerts flag likely
 * tree-cover disturbance from three satellite systems, not confirmed deforestation, and
 * the info box says so.
 */
const DATA_URL = "data/gfw.geojson";
const FILL_ALPHA = 0.5;
const DAY_MS = 86_400_000;
export const LIVE_WEEKS = 4;

export const DENSITY_CLASSES = Object.freeze([
  {
    key: "trace",
    label: "< 2.5 ha / 10,000 km² / week",
    color: "#fde68a",
    test: (d) => d < 2.5,
  },
  { key: "low", label: "2.5 – 50", color: "#f59e0b", test: (d) => d < 50 },
  { key: "high", label: "50 – 250", color: "#dc2626", test: (d) => d < 250 },
  {
    key: "severe",
    label: "> 250 ha / 10,000 km² / week",
    color: "#7f1d1d",
    test: () => true,
  },
]);
export const NO_DATA = Object.freeze({
  key: "none",
  label: "no alerts in scope",
  color: "#6b7280",
});

export function densityClass(d) {
  if (!Number.isFinite(d) || d <= 0) return NO_DATA;
  return DENSITY_CLASSES.find((c) => c.test(d));
}

/** Bins in scope: the 7-day bin (w−6 d … w] containing `iso`, or (iso null) the newest LIVE_WEEKS bins ending `today`. */
export function binsAt(weeks, iso, today) {
  if (!iso) {
    const cutoff = today
      ? Date.parse(`${today}T00:00:00Z`) - (LIVE_WEEKS - 1) * 7 * DAY_MS
      : -Infinity;
    return {
      bins: (weeks || []).filter(
        (w) => Date.parse(`${w.w}T00:00:00Z`) >= cutoff,
      ),
      span: LIVE_WEEKS,
      label: `last ${LIVE_WEEKS} weeks to ${today ?? "?"}`,
    };
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { bins: [], span: 1, label: "invalid time" };
  const hit = (weeks || []).find((w) => {
    const end = Date.parse(`${w.w}T23:59:59.999Z`);
    return t <= end && t > end - 7 * DAY_MS;
  });
  return {
    bins: hit ? [hit] : [],
    span: 1,
    label: hit
      ? `week ending ${hit.w}`
      : `no alerts in the week of ${iso.slice(0, 10)}`,
  };
}

/** ha per 10,000 km² per week over the bins in scope. */
export function density(bins, span, areaKm2) {
  if (!areaKm2) return null;
  const ha = bins.reduce((a, b) => a + (b.ha || 0), 0);
  return ha / span / (areaKm2 / 1e4);
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function describeCountry(p, scope, d, source = {}) {
  const n = scope.bins.reduce((a, b) => a + (b.n || 0), 0);
  const ha = scope.bins.reduce((a, b) => a + (b.ha || 0), 0);
  return (
    `<b>${esc(p.name)}</b> (${esc(p.iso)})<br>` +
    `${esc(scope.label)}: ${n.toLocaleString()} alert${n === 1 ? "" : "s"} over ~${Math.round(ha).toLocaleString()} ha` +
    (Number.isFinite(d)
      ? ` = <b>${d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString()}</b> ha per 10,000 km² per week`
      : "") +
    `<br>` +
    `${Math.round(p.area_km2 || 0).toLocaleString()} km² country · ${Number(p.n || 0).toLocaleString()} alerts in the whole record<br>` +
    `<small>Integrated GLAD-L / GLAD-S2 / RADD alerts, medium and high confidence: likely tree-cover disturbance, not confirmed deforestation.</small><br>` +
    `<a href="${esc(source.url || "https://www.globalforestwatch.org")}" target="_blank" rel="noopener">${esc(source.name || "Global Forest Watch")}</a> · ${esc(source.licence || "CC BY 4.0")} · shapes: Natural Earth`
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

/** Entity options for one country at the observed instant (one per polygon part). */
export function countryEntities(f, observedIso, today, source = {}) {
  const p = f.properties || {};
  const scope = binsAt(p.weeks, observedIso, today);
  const d = density(scope.bins, scope.span, p.area_km2);
  const cls = densityClass(d);
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(
    cls === NO_DATA ? 0.12 : FILL_ALPHA,
  );
  const polys =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
  return polys.map((poly, k) => ({
    id: `gfw:${p.iso}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: color.withAlpha(0.8),
      outlineWidth: 1,
    },
    description: describeCountry(p, scope, d, source),
    properties: {
      iso: p.iso,
      name: p.name,
      density: d,
      cls: cls.key,
      scope: scope.label,
      part: k,
    },
  }));
}

export function createGfwLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _today = null;
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
      for (const e of countryEntities(f, _observed, _today, _source)) es.add(e);
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
    id: "gfw",
    name: "Deforestation alerts by country (Global Forest Watch)",
    icon: "🌳",
    source:
      "Global Forest Watch integrated alerts (CC BY 4.0); Natural Earth country shapes (public domain)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("gfw");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:GFW] Initialized");
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
          _lastError = `gfw.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed gfw.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _today = gj.today ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:GFW] Updated: ${_features.length} countries, version ${_source.version}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:GFW] Load error:", e);
        _lastError = `gfw.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: colour each country by the 7-day bin containing the instant. */
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
      const counts = classCounts();
      const legend = [...DENSITY_CLASSES, NO_DATA].map((c) => ({
        label: c.label,
        color: c.color,
        count: counts[c.key] ?? 0,
      }));
      legend.push({
        label:
          _observed === null
            ? `country fill = alert area per 10,000 km² per week, last ${LIVE_WEEKS} weeks (GFW version ${_source.version ?? "?"}); likely disturbance, not confirmed loss`
            : "country fill = alert area per 10,000 km² in the week of the observed time; likely disturbance, not confirmed loss",
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
            iso: g("iso"),
            name: g("name"),
            density: g("density"),
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
        observed: _observed,
        classes: classCounts(),
      };
    },
  };
  return layer;
}

const gfwLayer = createGfwLayer();
export default gfwLayer;
