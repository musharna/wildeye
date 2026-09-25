import * as Cesium from "cesium";

/**
 * Mangrove extent by country, 1985–2025 (polygon contract): one filled Natural Earth map unit per
 * country or territory in Global Mangrove Watch v4.1.12 (Bunting et al. 2026, CC BY 4.0), from
 * pipeline/gmw.py. Fill = change in mangrove extent from 1985 to the observed year, in diverging
 * classes; the info box and the readout give the extent with its 95% bounds. Per-year bounds are
 * shown, not tested against each other, so the classes make no significance claim.
 * Wave item 3a (grill_wildeye_next_wave_2026-09-25 Q11).
 */
const DATA_URL = "data/gmw.geojson";
const FILL_ALPHA = 0.55;
export const EMPTY_ALPHA = 0.35; // same visible no-data grey as gfw, arbonet, hpai, whispers

export const CHANGE_CLASSES = Object.freeze([
  { key: "loss-high", label: "< −20% since 1985", color: "#8c510a", test: (p) => p < -20 },
  { key: "loss", label: "−20 to −5%", color: "#d8b365", test: (p) => p < -5 },
  { key: "stable", label: "−5 to +5% (little change)", color: "#f5f5f5", test: (p) => p < 5 },
  { key: "gain", label: "+5 to +50%", color: "#5ab4ac", test: (p) => p < 50 },
  { key: "gain-high", label: "> +50%", color: "#01665e", test: () => true },
]);
export const NEW_SINCE = Object.freeze({ key: "new", label: "none mapped in 1985", color: "#a78bfa" });
export const NO_DATA = Object.freeze({ key: "none", label: "no mangrove extent mapped for this year", color: "#6b7280" });

/** The record year shown at an observed instant: live = the last year; after the record = the last year, flagged; before = none. */
export function yearAt(iso, years) {
  const [first, last] = years;
  if (!iso) return { year: last, latest: true };
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const y = new Date(t).getUTCFullYear();
  if (y < first) return { year: null, latest: false };
  if (y >= last) return { year: last, latest: true };
  return { year: y, latest: false };
}

export const pctChange = (ha0, ha) => (ha0 > 0 && Number.isFinite(ha) ? ((ha - ha0) / ha0) * 100 : null);

export function changeClass(ha0, ha) {
  if (!Number.isFinite(ha) || ha <= 0) return NO_DATA;
  if (!(ha0 > 0)) return NEW_SINCE;
  const p = pctChange(ha0, ha);
  return CHANGE_CLASSES.find((c) => c.test(p));
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd point-in-polygon over a GeoJSON Polygon/MultiPolygon; x = lon, y = lat. */
export function pointInGeometry(g, x, y) {
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  return polys.some((poly) => inRing(poly[0], x, y) && !poly.slice(1).some((h) => inRing(h, x, y)));
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ha = (v) => Math.round(v).toLocaleString("en-US");
export function fmtPct(p) {
  const a = Math.abs(p);
  const s = a < 10 ? a.toFixed(1).replace(/\.0$/, "") : String(Math.round(a));
  return `${p < 0 ? "−" : "+"}${s}%`;
}

/** Values for one country at a shown year: extent, bounds, change since the first year (null when none in 1985). */
function valuesAt(p, year, years) {
  const i = year - years[0];
  return { ha: p.ha[i], lo: p.lo[i], hi: p.hi[i], pct: pctChange(p.ha[0], p.ha[i]) };
}

export function describeCountry(p, shown, years, source = {}) {
  const head = `<b>${esc(p.name)}</b> (${esc(p.iso)})<br>`;
  const foot =
    `<small>Extent corrected for the GMW accuracy assessment; the 95% bounds are per year, so a change smaller than them may not be real.</small><br>` +
    `<a href="${esc(source.url || "https://doi.org/10.5281/zenodo.21346457")}" target="_blank" rel="noopener">${esc(source.name || "Global Mangrove Watch")}</a> v${esc(source.version || "?")} · ${esc(source.licence || "CC BY 4.0")} · shapes: Natural Earth`;
  if (shown.year === null) return `${head}no mangrove extent mapped before ${years[0]}<br>${foot}`;
  const v = valuesAt(p, shown.year, years);
  return (
    head +
    `${shown.year}: <b>${ha(v.ha)} ha</b> of mangrove (95%: ${ha(v.lo)}–${ha(v.hi)} ha)<br>` +
    (v.pct === null ? `none mapped in ${years[0]}` : `${fmtPct(v.pct)} since ${years[0]} (${ha(p.ha[0])} ha)`) +
    (shown.latest ? ` · latest year in the record` : "") +
    `<br>${foot}`
  );
}

const ring = (coords) => Cesium.Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(ring(poly[0]), poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))));

export function countryEntities(f, shown, years, source = {}) {
  const p = f.properties || {};
  const cls = shown.year === null ? NO_DATA : changeClass(p.ha[0], valuesAt(p, shown.year, years).ha);
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(cls === NO_DATA ? EMPTY_ALPHA : FILL_ALPHA);
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  const description = describeCountry(p, shown, years, source);
  return polys.map((poly, k) => ({
    id: `gmw:${p.iso}:${k}`,
    polygon: { hierarchy: hierarchy(poly), material: color, outline: true, outlineColor: color.withAlpha(0.8), outlineWidth: 1 },
    description,
    properties: { iso: p.iso, name: p.name, cls: cls.key, year: shown.year, part: k },
  }));
}

function validate(gj) {
  if (!gj || !Array.isArray(gj.features)) return "Malformed gmw.geojson: no features array";
  const y = gj.years;
  if (!Array.isArray(y) || y.length !== 2 || !Number.isInteger(y[0]) || !Number.isInteger(y[1]) || y[1] < y[0])
    return `Malformed gmw.geojson: years ${JSON.stringify(y)} is not [first, last]`;
  const n = y[1] - y[0] + 1;
  for (const f of gj.features) {
    const p = f.properties || {};
    for (const k of ["ha", "lo", "hi"])
      if (!Array.isArray(p[k]) || p[k].length !== n) return `Malformed gmw.geojson: ${p.iso} ${k} has ${p[k]?.length} values for years ${y[0]}–${y[1]}`;
  }
  return null;
}

export function createMangrovesLayer() {
  const id = "gmw";
  const name = "Mangrove extent by country (Global Mangrove Watch)";
  const icon = "🌿";
  let _dataSource = null;
  let _features = [];
  let _years = null;
  let _missing = [];
  let _source = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const shown = () => yearAt(_observed, _years);
  const rebuild = () => {
    if (!_dataSource || !_years) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    const s = shown();
    for (const f of _features) for (const e of countryEntities(f, s, _years, _source)) es.add(e);
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

  return {
    id,
    name,
    icon,
    source: "Global Mangrove Watch v4.1.12 (Bunting et al. 2026, CC BY 4.0); Natural Earth map units (public domain)",
    updateInterval: 24 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log("[Data:GMW] Initialized");
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
          _lastError = `gmw.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        const bad = validate(gj);
        if (bad) {
          _lastError = bad;
          console.error(`[Data:GMW] ${bad}`);
          return false;
        }
        _features = gj.features;
        _years = gj.years;
        _missing = gj.missing || [];
        _source = gj.source || {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(`[Data:GMW] Updated: ${_features.length} countries, ${_years[0]}–${_years[1]}, v${_source.version}`);
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:GMW] Load error:", e);
        _lastError = `gmw.geojson load error: ${e?.message || e}`;
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _features = [];
      _years = null;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Shared observed-time hook: the whole record, first Jan 1 to last Dec 31 (src/observedTime.js unions these). */
    getObservedExtent() {
      if (!_years || !_features.length) return null;
      return { startMs: Date.UTC(_years[0], 0, 1), endMs: Date.UTC(_years[1], 11, 31, 23, 59, 59, 999) };
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

    /** "What's here" row: the country the point falls in, with its extent in the shown year (Natural Earth 50m shapes). */
    async readoutAt(lat, lon) {
      if (!_dataSource?.show) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_years) return row("error", { error: _lastError || "not loaded yet" });
      const s = shown();
      if (s.year === null) return row("nodata", { date: String(new Date(Date.parse(_observed)).getUTCFullYear()) });
      const f = _features.find((x) => pointInGeometry(x.geometry, lon, lat));
      if (!f) return row("class", { text: "Not in a country with mapped mangroves", date: `${_years[0]}–${_years[1]}` });
      const p = f.properties;
      const v = valuesAt(p, s.year, _years);
      const change = v.pct === null ? `none mapped in ${_years[0]}` : `${fmtPct(v.pct)} since ${_years[0]}`;
      return row("class", { text: `${p.name}: ${ha(v.ha)} ha (95%: ${ha(v.lo)}–${ha(v.hi)}), ${change}`, date: String(s.year) });
    },

    getRowControls() {
      const counts = classCounts();
      const legend = [...CHANGE_CLASSES, NEW_SINCE, NO_DATA].map((c) => ({ label: c.label, color: c.color, count: counts[c.key] ?? 0 }));
      const s = _years ? shown() : null;
      legend.push({
        label: s
          ? `country fill = change in mangrove extent since ${_years[0]}, to ${s.year ?? "(before the record)"}${s.latest ? " (latest year)" : ""}; Global Mangrove Watch v${_source.version ?? "?"}, 95% bounds in each info box`
          : "country fill = change in mangrove extent since 1985 (not loaded)",
        color: "transparent",
        count: null,
      });
      if (_missing.length)
        legend.push({
          label: `not drawn (no Natural Earth shape): ${_missing.map((m) => `${m.name} ${ha(m.ha_last)} ha`).join(", ")}`,
          color: "transparent",
          count: null,
        });
      return { chips: [], legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },

    getStats() {
      return {
        count: _features.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        version: _source.version ?? null,
        observed: _observed,
        year: _years ? shown().year : null,
        classes: classCounts(),
        missing: _missing.length,
      };
    },
  };
}

export const mangrovesLayer = createMangrovesLayer();
export default mangrovesLayer;
