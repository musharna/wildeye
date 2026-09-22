import * as Cesium from "cesium";
import { extentFromWeekDates, pluck } from "./observedExtent.js";

/**
 * HPAI detections in wild birds by county (polygon contract): one filled polygon per
 * county with a laboratory-confirmed detection in the window, from pipeline/hpai.py
 * (USDA APHIS CSV, public domain). Fill class = detections in scope: with the shared
 * observed time set, the 7-day bin containing the instant; live, the newest LIVE_WEEKS
 * bins. Counts reflect sampling effort (hunter harvest, mortality events) as much as
 * virus presence, and the info box says so.
 */
const DATA_URL = "data/hpai.geojson";
const FILL_ALPHA = 0.55;
// A reported-zero area must read as FILLED grey, not as bare imagery: 0.15 was indistinguishable
// from no polygon at all in the real-app screenshots (2026-09-12 visual critic).
export const EMPTY_ALPHA = 0.35;
const DAY_MS = 86_400_000;
export const LIVE_WEEKS = 8;

export const COUNT_CLASSES = Object.freeze([
  { key: "one", label: "1 detection", color: "#fde047", test: (n) => n <= 1 },
  {
    key: "few",
    label: "2–4 detections",
    color: "#f97316",
    test: (n) => n <= 4,
  },
  {
    key: "many",
    label: "5–14 detections",
    color: "#dc2626",
    test: (n) => n <= 14,
  },
  {
    key: "outbreak",
    label: "15+ detections",
    color: "#7f1d1d",
    test: () => true,
  },
]);
export const NO_DATA = Object.freeze({
  key: "none",
  label: "none in scope",
  color: "#6b7280",
});

export function countClass(n) {
  if (!Number.isFinite(n) || n <= 0) return NO_DATA;
  return COUNT_CLASSES.find((c) => c.test(n));
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
      label: `last ${LIVE_WEEKS} weeks to ${today ?? "?"}`,
    };
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { bins: [], label: "invalid time" };
  const hit = (weeks || []).find((w) => {
    const end = Date.parse(`${w.w}T23:59:59.999Z`);
    return t <= end && t > end - 7 * DAY_MS;
  });
  return {
    bins: hit ? [hit] : [],
    label: hit
      ? `week ending ${hit.w}`
      : `no detections in the week of ${iso.slice(0, 10)}`,
  };
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function sumBins(bins) {
  const sp = {};
  let n = 0,
    captive = 0;
  for (const b of bins) {
    n += b.n || 0;
    captive += b.captive || 0;
    for (const [k, v] of Object.entries(b.sp || {})) sp[k] = (sp[k] || 0) + v;
  }
  return { n, captive, sp };
}

export function describeCounty(p, scope, sum, source = {}) {
  const rows = Object.entries(sum.sp)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${esc(k)}: ${v}`)
    .join(" · ");
  return (
    `<b>${esc(p.name)} County, ${esc(p.st)}</b><br>` +
    `HPAI in wild birds, ${esc(scope.label)}: ${sum.n} detection${sum.n === 1 ? "" : "s"}${sum.captive ? ` (${sum.captive} in captive wild birds)` : ""}<br>` +
    (rows ? `${rows}<br>` : "") +
    `${p.n_all ?? 0} detection${p.n_all === 1 ? "" : "s"} in this county since 2022<br>` +
    `<small>Counts follow sampling effort (hunter harvest, mortality events) as much as virus presence.</small><br>` +
    `<a href="${esc(source.url || "https://www.aphis.usda.gov")}" target="_blank" rel="noopener">${esc(source.name || "USDA APHIS")}</a> · ${esc(source.licence || "Public Domain U.S. Government")}`
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

/** Entity options for one county at the observed instant (one per polygon part). */
export function countyEntities(f, observedIso, today, source = {}) {
  const p = f.properties || {};
  const scope = binsAt(p.weeks, observedIso, today);
  const sum = sumBins(scope.bins);
  const cls = countClass(sum.n);
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(
    sum.n > 0 ? FILL_ALPHA : EMPTY_ALPHA,
  );
  const polys =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
  return polys.map((poly, k) => ({
    id: `hpai:${p.fips}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: color.withAlpha(0.9),
      outlineWidth: 1,
    },
    description: describeCounty(p, scope, sum, source),
    properties: {
      fips: p.fips,
      name: p.name,
      st: p.st,
      n: sum.n,
      captive: sum.captive,
      cls: cls.key,
      scope: scope.label,
      part: k,
    },
  }));
}

export function createHpaiLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
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
    for (const f of _features)
      for (const e of countyEntities(f, _observed, _today, _source)) es.add(e);
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
    id: "hpai",
    name: "Avian influenza in wild birds (USDA APHIS)",
    icon: "🦆",
    source:
      "USDA APHIS HPAI wild-bird detections (Public Domain U.S. Government); Census county boundaries",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("hpai");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:HPAI] Initialized");
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
          _lastError = `hpai.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed hpai.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _today = gj.today ?? null;
        _newest = gj.newest ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:HPAI] Updated: ${_features.length} counties, newest detection ${_newest}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:HPAI] Load error:", e);
        _lastError = `hpai.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: colour each county by the 7-day bin containing the instant. */
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

    getRowControls() {
      const counts = classCounts();
      const legend = [...COUNT_CLASSES, NO_DATA].map((c) => ({
        label: c.label,
        color: c.color,
        count: counts[c.key] ?? 0,
      }));
      legend.push({
        label:
          _observed === null
            ? `county fill = confirmed HPAI detections in wild birds, last ${LIVE_WEEKS} weeks (newest ${_newest ?? "?"}); follows sampling effort`
            : "county fill = confirmed HPAI detections in wild birds in the week of the observed time; follows sampling effort",
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
            detections: g("n"),
            captive: g("captive"),
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
      };
    },
  };
  return layer;
}

const hpaiLayer = createHpaiLayer();
export default hpaiLayer;
