import * as Cesium from "cesium";
import { pointInGeometry } from "./mangroves.js";

/**
 * Native vascular plants per TDWG botanical country (polygon contract, static): the World Checklist of Vascular Plants
 * 16.0 (Royal Botanic Gardens, Kew, CC BY 3.0) counted per WGSRPD Level-3 unit (TDWG, CC BY 4.0) by
 * pipeline/wcvp_plants.py (spec docs/superpowers/specs/2026-10-06-wcvp-plants-design.md). 369 units are filled by
 * their number of native accepted species on 8 half-decade (log) bins; a unit with none recorded is grey. The readout
 * and the info box add the endemic and introduced counts. Units differ in size by orders of magnitude and larger units
 * hold more species, which the legend says. Nothing varies with time.
 */
const DATA_URL = "data/plants_wcvp.geojson";
export const FILL_ALPHA = 0.55;
export const EDITION = "WCVP 16.0";
export const BIN_COUNT = 8;
const GOVAERTS = "https://doi.org/10.1038/s41597-021-00997-6";
const WGSRPD = "https://www.tdwg.org/standards/wgsrpd/";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Number(n).toLocaleString("en-US");

export function formatArea(km2) {
  const v = Number(km2);
  if (!Number.isFinite(v) || v <= 0) return "area unknown";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} million km²`;
  return `${Math.round(v).toLocaleString("en-US")} km²`;
}

/** The readout line for one unit. */
export function unitText(p) {
  if (p.native === 0) return `${p.name} · no native vascular plant species recorded (${fmt(p.introduced)} introduced)`;
  return `${p.name} · ${fmt(p.native)} native vascular plant species (${fmt(p.endemic)} endemic, ${fmt(p.introduced)} introduced)`;
}

export function describeUnit(p, source = {}) {
  return (
    `<b>${esc(p.name)}</b> (TDWG ${esc(p.id)})<br>` +
    `Native vascular plant species: ${fmt(p.native)}<br>` +
    `Endemic (native here and nowhere else): ${fmt(p.endemic)}<br>` +
    `Introduced: ${fmt(p.introduced)}<br>` +
    `Unit area: ${formatArea(p.area_km2)}<br>` +
    `<small>Accepted species in WCVP ${esc(source.version || "16.0")}. Native: not introduced, doubtful or extinct here. ` +
    `Larger units hold more species, so compare units of like size. In Europe many endemics are apomictic microspecies ` +
    `(Hieracium, Rubus, Taraxacum) that WCVP accepts as species. Boundaries simplified for display.</small><br>` +
    `<a href="${esc(source.url || "https://sftp.kew.org/pub/data-repositories/WCVP/")}" target="_blank" rel="noopener">${esc(source.name || "World Checklist of Vascular Plants")}</a> · ${esc(source.licence || "CC BY 3.0")}` +
    ` · <a href="${GOVAERTS}" target="_blank" rel="noopener">Govaerts et al. 2021</a>` +
    ` · <a href="${WGSRPD}" target="_blank" rel="noopener">TDWG WGSRPD</a> (CC BY 4.0)`
  );
}

const ring = (coords) => Cesium.Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(
    ring(poly[0]),
    poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))),
  );

/** Entity options for one unit (one per polygon part). */
export function unitEntities(f, source = {}) {
  const p = f.properties || {};
  const color = Cesium.Color.fromCssColorString(p.color).withAlpha(FILL_ALPHA);
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  const description = describeUnit(p, source);
  return polys.map((poly, k) => ({
    id: `plants-wcvp:${p.id}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.25),
      outlineWidth: 1,
    },
    description,
    properties: { id: p.id, name: p.name, native: p.native, part: k },
  }));
}

const count = (v) => Number.isInteger(v) && v >= 0;

/** null when the GeoJSON has the shape pipeline/wcvp_plants.py writes; otherwise what is wrong with it. A unit's colour
 * must be its bin's (or the "none" grey for no native species), and its bin must hold its native count. */
export function validateUnits(gj) {
  if (!gj || !Array.isArray(gj.features) || !gj.features.length) return "no units";
  const bins = Array.isArray(gj.bins) ? gj.bins : [];
  if (bins.length !== BIN_COUNT) return `${bins.length} bins, not ${BIN_COUNT}`;
  if (!/^#[0-9a-f]{6}$/i.test(gj.none_color ?? "")) return `none colour ${JSON.stringify(gj.none_color)}`;
  const seen = new Set();
  for (const f of gj.features) {
    const p = f?.properties || {};
    const t = f?.geometry?.type;
    if (typeof p.id !== "string" || !/^[A-Z]{3}$/.test(p.id)) return `unit id ${JSON.stringify(p.id)}`;
    if (seen.has(p.id)) return `unit ${p.id} appears twice`;
    seen.add(p.id);
    if (t !== "Polygon" && t !== "MultiPolygon") return `unit ${p.id}: geometry ${t} is not a polygon`;
    if (typeof p.name !== "string" || !p.name) return `unit ${p.id}: no name`;
    for (const k of ["native", "endemic", "introduced"]) if (!count(p[k])) return `unit ${p.id}: ${k} ${p[k]}`;
    if (p.endemic > p.native) return `unit ${p.id}: ${p.endemic} endemic of ${p.native} native`;
    if (p.native === 0) {
      if (p.bin !== null || p.color !== gj.none_color) return `unit ${p.id}: no native species but bin ${p.bin}, colour ${p.color}`;
      continue;
    }
    const b = bins[p.bin];
    if (!Number.isInteger(p.bin) || !b) return `unit ${p.id}: bin ${p.bin}`;
    const next = bins[p.bin + 1];
    if (p.native < b.min || (next && p.native >= next.min)) return `unit ${p.id}: ${p.native} native is not in bin ${b.label}`;
    if (p.color !== b.color) return `unit ${p.id}: colour ${p.color} is not bin ${b.label}'s ${b.color}`;
  }
  return null;
}

export function createPlantsWcvpLayer({ fetchImpl = (u) => fetch(u), dataSourceFor = null } = {}) {
  const id = "plants-wcvp";
  const name = "Native plants (WCVP, botanical countries)";
  const icon = "🌿";
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _bins = [];
  let _noneColor = null;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;

  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features) for (const e of unitEntities(f, _source)) es.add(e);
    es.resumeEvents();
  };

  return {
    id,
    name,
    icon,
    source: "World Checklist of Vascular Plants 16.0 (Royal Botanic Gardens, Kew) · CC BY 3.0; TDWG WGSRPD · CC BY 4.0",
    updateInterval: 24 * 3600000, // static file

    init(viewer) {
      _dataSource = dataSourceFor ? dataSourceFor(id) : new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
    },
    enable() {
      if (_dataSource) _dataSource.show = true;
    },
    disable() {
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      try {
        const res = await fetchImpl(DATA_URL);
        if (!res.ok) {
          _lastError = `plants_wcvp.geojson HTTP ${res.status}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        const gj = await res.json();
        const bad = validateUnits(gj);
        if (bad) {
          _lastError = `Malformed plants_wcvp.geojson: ${bad}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _bins = gj.bins;
        _noneColor = gj.none_color;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        _lastError = `plants_wcvp.geojson load error: ${e?.message || e}`;
        console.error(`[Data:${id}] ${_lastError}`, e);
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

    getRowControls() {
      if (!_features.length) return { chips: [], legend: [] };
      const legend = _bins.map((b) => ({ label: `${b.label} native species`, color: b.color, count: null }));
      legend.push({ label: "none recorded", color: _noneColor, count: null });
      legend.push({
        label: `fill = native vascular plant species per botanical country, log scale (${fmt(_features.length)} TDWG Level-3 units, WCVP 16.0). Larger units hold more species: compare units of like size.`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },

    /** The unit(s) at a point, in file order. Null when off. */
    async readoutAt(lat, lon) {
      if (!_dataSource?.show) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_features.length) return row("error", { error: _lastError || "not loaded yet" });
      // Containment is half-open, so 180° is in no shape; it is the meridian the shapes start at as -180°.
      const x = ((((lon + 180) % 360) + 360) % 360) - 180;
      const hits = _features.filter((ft) => pointInGeometry(ft.geometry, x, lat));
      if (!hits.length) return row("class", { text: "Not in a botanical country", date: EDITION });
      return row("class", { text: hits.map((f) => unitText(f.properties)).join("; "), date: EDITION });
    },

    getStats() {
      return { count: _features.length, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt };
    },
  };
}

export const plantsWcvpLayer = createPlantsWcvpLayer();
