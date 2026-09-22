import * as Cesium from "cesium";
import { extentFromWeekDates, pluck } from "./observedExtent.js";

/**
 * County wastewater virus trend (polygon contract): one filled polygon per county
 * with NWSS sampling, coloured by the population-weighted 15-day trend of its
 * sites (log10 ratio, each site against its own history — CDC's footnote forbids
 * comparing concentrations across sites, and pipeline/wastewater.py never does).
 * Weekly values let the shared observed time pick the week at or before the
 * instant; counties with no value for that week fade to "no data".
 */
const DATA_URL = "data/wastewater.geojson";
const FILL_ALPHA = 0.55;
// A no-data area must read as FILLED grey, not bare imagery: 0.12–0.18 was indistinguishable from no polygon
// in the real-app screenshots (2026-09-12); arbonet, hpai and whispers use the same value.
export const EMPTY_ALPHA = 0.35;

export const TREND_CLASSES = Object.freeze([
  { key: "falling", label: "falling (< −0.15 log₁₀, below ~70% of prior 15 d)", color: "#3b82f6", test: (t) => t < -0.15 },
  // Light midpoint of the blue→orange diverging scale. It was grey #9ca3af, which over terrain looked like the
  // "no value" grey once that fill became visible (2026-09-12 visual critic).
  { key: "stable", label: "stable (−0.15 … +0.15)", color: "#fde68a", test: (t) => t <= 0.15 },
  { key: "rising", label: "rising (+0.15 … +0.5, up to ~3×)", color: "#f97316", test: (t) => t <= 0.5 },
  { key: "surging", label: "surging (> +0.5 log₁₀, more than ~3×)", color: "#dc2626", test: () => true },
]);
export const NO_DATA = Object.freeze({ key: "none", label: "no value that week", color: "#6b7280" });

export function trendClass(t) {
  if (!Number.isFinite(t)) return NO_DATA;
  return TREND_CLASSES.find((c) => c.test(t));
}

/** Newest weekly value whose week end is at or before `iso`; null when the instant precedes every week or none has a value. */
export function trendAtOrBefore(weeks, iso) {
  const tMs = iso ? Date.parse(iso) : Infinity;
  if (!Number.isFinite(tMs) && iso) return null;
  let best = null;
  for (const w of weeks || []) {
    const wMs = Date.parse(`${w.w}T23:59:59Z`);
    if (!Number.isFinite(wMs) || wMs > tMs || !Number.isFinite(w.t)) continue;
    if (best === null || wMs > Date.parse(`${best.w}T23:59:59Z`)) best = w;
  }
  return best;
}

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function describeCounty(p, week, source = {}) {
  const cls = trendClass(week?.t);
  const val = week ? `${week.t > 0 ? "+" : ""}${week.t.toFixed(2)} log₁₀ (${cls.key}) · week ending ${esc(week.w)} · ${week.n} site${week.n === 1 ? "" : "s"}` : "no value for this week";
  return (
    `<b>${esc(p.name)} County, ${esc(p.st)}</b><br>` +
    `SARS-CoV-2 wastewater trend: ${val}<br>` +
    `${p.sites} sampling site${p.sites === 1 ? "" : "s"}, ~${Number(p.pop || 0).toLocaleString()} people served<br>` +
    `<small>Each site is compared with its own prior 15 days; sites are never compared with each other.</small><br>` +
    `<a href="${esc(source.url || "https://www.cdc.gov/wastewater")}" target="_blank" rel="noopener">${esc(source.name || "CDC NWSS")}</a> · ${esc(source.licence || "Public Domain U.S. Government")}`
  );
}

const ring = (coords) => Cesium.Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));
const hierarchy = (poly) => new Cesium.PolygonHierarchy(ring(poly[0]), poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))));

/** Entity options for one county feature at the observed instant (one per polygon part). */
export function countyEntities(f, observedIso, source = {}) {
  const p = f.properties || {};
  const week = trendAtOrBefore(p.weeks, observedIso);
  const cls = trendClass(week?.t);
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(week ? FILL_ALPHA : EMPTY_ALPHA);
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  return polys.map((poly, k) => ({
    id: `ww:${p.fips}:${k}`,
    polygon: { hierarchy: hierarchy(poly), material: color, outline: true, outlineColor: color.withAlpha(0.9), outlineWidth: 1 },
    description: describeCounty(p, week, source),
    properties: { fips: p.fips, name: p.name, st: p.st, sites: p.sites, pop: p.pop, trend: week?.t ?? null, week: week?.w ?? null, cls: cls.key, part: k },
  }));
}

export function createWastewaterLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null; // ISO or null = latest
  let _rowControlsListener = null;

  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features) for (const e of countyEntities(f, _observed, _source)) es.add(e);
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
    id: "wastewater",
    name: "Wastewater virus trend (CDC NWSS)",
    icon: "🧫",
    source: "CDC National Wastewater Surveillance System (Public Domain U.S. Government); Census county boundaries",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("wastewater");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = []; _lastError = null; _lastUpdate = null;
      console.log("[Data:Wastewater] Initialized");
    },
    enable() { if (_dataSource) _dataSource.show = true; },
    disable() { if (_dataSource) _dataSource.show = false; },

    async update() {
      try {
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
        if (!res.ok) { _lastError = `wastewater.geojson HTTP ${res.status}`; return false; }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) { _lastError = "Malformed wastewater.geojson"; return false; }
        _features = gj.features;
        _source = gj.source || {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(`[Data:Wastewater] Updated: ${_features.length} counties`);
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Wastewater] Load error:", e);
        _lastError = `wastewater.geojson load error: ${e?.message || e}`;
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) { viewer.dataSources.remove(_dataSource, true); _dataSource = null; }
      _features = []; _lastUpdate = null; _lastError = null;
    },

    /** Shared observed-time hook: colour each county by the week at or before the instant. */
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
      const legend = [...TREND_CLASSES, NO_DATA].map((c) => ({ label: c.label, color: c.color, count: counts[c.key] ?? 0 }));
      legend.push({ label: "SARS-CoV-2 in sewage, county fill = population-weighted trend of its sites vs their own prior 15 days", color: "transparent", count: null });
      return { chips: [], legend };
    },
    setRowControlsListener(l) { _rowControlsListener = typeof l === "function" ? l : null; },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      return _dataSource.entities.values
        .filter((e) => e.properties?.part?.getValue?.(now) === 0)
        .slice(0, maxCount)
        .map((e) => { const g = (k) => e.properties?.[k]?.getValue(now); return { id: e.id, fips: g("fips"), name: g("name"), st: g("st"), trend: g("trend"), week: g("week"), cls: g("cls"), sites: g("sites") }; });
    },

    getStats() {
      return { count: _features.length, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt, observed: _observed, classes: classCounts() };
    },
  };
  return layer;
}

const wastewaterLayer = createWastewaterLayer();
export default wastewaterLayer;
