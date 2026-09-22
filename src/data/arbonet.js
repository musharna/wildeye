import * as Cesium from "cesium";
import { binsAt, LIVE_WEEKS } from "./hpai.js";
import { extentFromWeekDates, pluck } from "./observedExtent.js";

/**
 * Mosquito- and tick-borne disease cases by state (polygon contract): CDC NNDSS weekly
 * arboviral case counts (ArboNET-fed; West Nile, EEE, La Crosse, St. Louis encephalitis,
 * Jamestown Canyon, Powassan, dengue) from pipeline/arbonet.py, public domain. Each state
 * carries weekly bins of cases ADDED to the year-to-date tally in that week's report, per
 * disease; fill class = cases in scope (the 7-day MMWR bin containing the observed instant,
 * or live the newest LIVE_WEEKS bins — bin logic imported from the avian-influenza layer).
 * Disease chips toggle which diseases count. County counts are not public, so this is state
 * level, and the info box says the counts are provisional report-week additions, not onsets.
 */
const DATA_URL = "data/arbonet.geojson";
// A reported-zero area must read as FILLED grey, not as bare imagery: 0.15 was indistinguishable
// from no polygon at all in the real-app screenshots (2026-09-12 visual critic).
export const EMPTY_ALPHA = 0.35;

// Opacity rises with the class: at one shared 0.55 the dark end of the ramp washed out over satellite
// imagery and read as the "no cases" grey (2026-09-12 visual critic), so the highest counts were the
// least legible. Denser classes cover more of the imagery and keep their teal.
export const CASE_CLASSES = Object.freeze([
  { key: "one", label: "1 case", color: "#99f6e4", alpha: 0.45, test: (n) => n <= 1 },
  { key: "few", label: "2–4 cases", color: "#2dd4bf", alpha: 0.55, test: (n) => n <= 4 },
  { key: "many", label: "5–14 cases", color: "#0d9488", alpha: 0.7, test: (n) => n <= 14 },
  { key: "surge", label: "15+ cases", color: "#134e4a", alpha: 0.85, test: () => true },
]);
export const NO_DATA = Object.freeze({
  key: "none",
  label: "no cases in scope",
  color: "#6b7280",
});

export function caseClass(n) {
  if (!Number.isFinite(n) || n <= 0) return NO_DATA;
  return CASE_CLASSES.find((c) => c.test(n));
}

/** Sum per-disease counts over the bins in scope; `visible[d] === false` drops a disease. */
export function sumBins(bins, visible = {}) {
  const by = {};
  let n = 0;
  for (const b of bins)
    for (const [d, v] of Object.entries(b.n || {})) {
      if (visible[d] === false) continue;
      by[d] = (by[d] || 0) + v;
      n += v;
    }
  return { n, by };
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const dname = (diseases, d) => diseases?.[d]?.name || d;

export function describeState(p, scope, sum, diseases = {}, source = {}) {
  const rows = Object.entries(sum.by)
    .sort((a, b) => b[1] - a[1])
    .map(([d, v]) => `${esc(dname(diseases, d))}: ${v}`)
    .join(" · ");
  const ytd = Object.entries(p.ytd || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([d, v]) =>
        `${esc(dname(diseases, d))} ${v}${Number.isFinite(p.prev_ytd?.[d]) ? ` (${p.prev_ytd[d]} by this week last year)` : ""}`,
    )
    .join(" · ");
  return (
    `<b>${esc(p.name)}</b><br>` +
    `Arboviral disease cases, ${esc(scope.label)}: ${sum.n} case${sum.n === 1 ? "" : "s"}<br>` +
    (rows ? `${rows}<br>` : "") +
    (ytd ? `Year to date as of ${esc(p.asof ?? "?")}: ${ytd}<br>` : "") +
    `<small>Provisional NNDSS counts; a week's cases are those added to the year's tally in that week's report (back-filled, not onset dates). New York City is counted with New York. State level: county counts are not public.</small><br>` +
    `<a href="${esc(source.url || "https://data.cdc.gov/NNDSS/NNDSS-Weekly-Data/x9gk-5huc")}" target="_blank" rel="noopener">${esc(source.name || "CDC NNDSS weekly data")}</a> · ${esc(source.licence || "Public Domain U.S. Government")}`
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

/** Entity options for one state at the observed instant (one per polygon part). */
export function stateEntities(f, observedIso, today, ctx = {}) {
  const p = f.properties || {};
  const scope = binsAt(p.weeks, observedIso, today);
  const sum = sumBins(scope.bins, ctx.visible || {});
  const cls = caseClass(sum.n);
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(
    sum.n > 0 ? cls.alpha : EMPTY_ALPHA,
  );
  const polys =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
  return polys.map((poly, k) => ({
    id: `arbonet:${p.fips}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: color.withAlpha(0.9),
      outlineWidth: 1,
    },
    description: describeState(p, scope, sum, ctx.diseases, ctx.source),
    properties: {
      fips: p.fips,
      name: p.name,
      st: p.st,
      n: sum.n,
      by: sum.by,
      cls: cls.key,
      scope: scope.label,
      part: k,
    },
  }));
}

export function createArbonetLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _diseases = {};
  let _visible = {};
  let _today = null;
  let _newest = null;
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
    const ctx = { visible: _visible, diseases: _diseases, source: _source };
    for (const f of _features)
      for (const e of stateEntities(f, _observed, _today, ctx)) es.add(e);
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
  /** Cases in scope per disease, summed over states (first parts only). */
  const diseaseCounts = () => {
    const c = {};
    for (const e of _dataSource?.entities.values || []) {
      if (e.properties?.part?.getValue?.() !== 0) continue;
      const by = e.properties?.by?.getValue?.() || {};
      for (const [d, v] of Object.entries(by)) c[d] = (c[d] || 0) + v;
    }
    return c;
  };

  const layer = {
    id: "arbonet",
    name: "Mosquito- and tick-borne disease cases (CDC ArboNET)",
    icon: "🦟",
    source:
      "CDC NNDSS weekly arboviral disease cases, ArboNET-fed (Public Domain U.S. Government); Census state boundaries",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("arbonet");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:ArboNET] Initialized");
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
          _lastError = `arbonet.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed arbonet.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _diseases = gj.diseases || {};
        for (const d of Object.keys(_diseases))
          if (!(d in _visible)) _visible[d] = true;
        _today = gj.today ?? null;
        _newest = gj.newest ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:ArboNET] Updated: ${_features.length} states, newest report week ${_newest}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:ArboNET] Load error:", e);
        _lastError = `arbonet.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: colour each state by the MMWR week bin containing the instant. */
    /**
     * Shared observed-time hook: the span this layer can serve, read off the 7-day bins it holds (each `w` is the bin's last day).
     * The bar's domain is the union of these across enabled layers (src/observedTime.js).
     */
    getObservedExtent() {
      return extentFromWeekDates(pluck(_features, "weeks", "w"));
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

    /** Disease chips: { wnv: false } hides West Nile from the sums. */
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
      const per = diseaseCounts();
      const chips = Object.keys(_diseases).map((d) => ({
        id: d,
        label: `${dname(_diseases, d).toUpperCase()} ${per[d] ?? 0}`,
        active: _visible[d] !== false,
        state: _visible[d] !== false ? "active" : "idle",
        title: `${_visible[d] !== false ? "Hide" : "Show"} ${dname(_diseases, d)}`,
        params: { [d]: !(_visible[d] !== false) },
      }));
      const legend = [...CASE_CLASSES, NO_DATA].map((c) => ({
        label: c.label,
        color: c.color,
        count: counts[c.key] ?? 0,
      }));
      legend.push({
        label:
          _observed === null
            ? `state fill = arboviral cases added to the year's tally, last ${LIVE_WEEKS} weeks (newest report week ${_newest ?? "?"}); provisional`
            : "state fill = arboviral cases added to the year's tally in the report week of the observed time; provisional",
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
            (e.properties?.n?.getValue?.(now) ?? 0) > 0,
        )
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            fips: g("fips"),
            name: g("name"),
            st: g("st"),
            cases: g("n"),
            by: g("by"),
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
        newest: _newest,
        observed: _observed,
        classes: classCounts(),
        diseases: diseaseCounts(),
      };
    },
  };
  return layer;
}

const arbonetLayer = createArbonetLayer();
export default arbonetLayer;
