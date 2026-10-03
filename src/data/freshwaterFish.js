import * as Cesium from "cesium";
import { pointInGeometry } from "./mangroves.js";

/**
 * Freshwater fish per drainage basin (polygon contract, static): Zenodo 10.5281/zenodo.19511163 (CC BY 4.0), the update
 * to December 2024 of Tedesco et al. 2017 (Scientific Data 4:170141), simplified by pipeline/freshwater_fish.py (spec
 * docs/superpowers/specs/2026-10-03-freshwater-fish-design.md). 3,364 river and lake basins are filled by their number
 * of freshwater fish species on 8 log-spaced bins; chips toggle the 7 biogeographic realms. The source's basins
 * overlap in places (some lie wholly inside another), so the readout names every basin under the point. Nothing varies
 * with time.
 */
const DATA_URL = "data/freshwater_fish.geojson";
export const FILL_ALPHA = 0.5;
export const EDITION = "2024";
const TEDESCO = "https://doi.org/10.1038/sdata.2017.141";

/** Chip labels for the source's 7 realms (its `bggrph_` values), in the source's alphabetical order. */
export const REALM_LABELS = Object.freeze({
  Afrotropic: "AFROTROPIC",
  Australasia: "AUSTRALASIA",
  Indomalayan: "INDOMALAYAN",
  Nearctic: "NEARCTIC",
  Neotropic: "NEOTROPIC",
  Oceania: "OCEANIA",
  Palearctic: "PALEARCTIC",
});

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Number(n).toLocaleString("en-US");

export function formatArea(km2) {
  const v = Number(km2);
  if (!Number.isFinite(v) || v <= 0) return "area unknown";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} million km²`;
  return `${Math.round(v).toLocaleString("en-US")} km²`;
}

/** The readout line for one basin. */
export function basinText(p) {
  return `${p.name} · ${fmt(p.species)} freshwater fish species`;
}

export function describeBasin(p, source = {}) {
  const fams = (p.families || []).map(([f, n]) => `${esc(f)} ${fmt(n)}`).join(", ");
  const countries = String(p.country ?? "").split(";").filter(Boolean); // the source joins a basin's countries with ";"
  return (
    `<b>${esc(p.name)}</b><br>` +
    `Realm: ${esc(p.realm)} · ${countries.length > 1 ? "Countries" : "Country"}: ${esc(countries.join(", "))}<br>` +
    `Freshwater fish species: ${fmt(p.species)}<br>` +
    (fams ? `Largest families: ${fams}<br>` : "") +
    `Basin area: ${formatArea(p.area_km2)}<br>` +
    `<small>Species recorded in the basin, valid names to December 2024; native and introduced species are not told apart. Boundaries simplified for display.</small><br>` +
    `<a href="${esc(source.url || "https://doi.org/10.5281/zenodo.19511163")}" target="_blank" rel="noopener">${esc(source.name || "Freshwater fish species per drainage basin")}</a> · ${esc(source.licence || "CC BY 4.0")}` +
    ` · <a href="${TEDESCO}" target="_blank" rel="noopener">Tedesco et al. 2017</a>`
  );
}

const ring = (coords) => Cesium.Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(
    ring(poly[0]),
    poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))),
  );

/** Entity options for one basin (one per polygon part). */
export function basinEntities(f, source = {}) {
  const p = f.properties || {};
  const color = Cesium.Color.fromCssColorString(p.color || "#9ca3af").withAlpha(FILL_ALPHA);
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  const description = describeBasin(p, source);
  return polys.map((poly, k) => ({
    id: `freshwater-fish:${p.id}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.25),
      outlineWidth: 1,
    },
    description,
    properties: { id: p.id, name: p.name, realm: p.realm, species: Number(p.species), part: k },
  }));
}

/** null when the GeoJSON has the shape pipeline/freshwater_fish.py writes; otherwise what is wrong with it. */
export function validateBasins(gj) {
  if (!gj || !Array.isArray(gj.features) || !gj.features.length) return "no basins";
  const bins = Array.isArray(gj.bins) ? gj.bins : [];
  if (bins.length !== 8) return `${bins.length} bins, not 8`;
  const seen = new Set();
  for (const f of gj.features) {
    const p = f?.properties || {};
    const t = f?.geometry?.type;
    if (typeof p.id !== "string" || !p.id) return `basin id ${JSON.stringify(p.id)}`;
    if (seen.has(p.id)) return `basin ${p.id} appears twice`;
    seen.add(p.id);
    if (t !== "Polygon" && t !== "MultiPolygon") return `basin ${p.id}: geometry ${t} is not a polygon`;
    if (!(p.realm in REALM_LABELS)) return `basin ${p.id}: realm ${JSON.stringify(p.realm)} is not one of the 7`;
    if (!Number.isInteger(p.species) || p.species < 1) return `basin ${p.id}: species ${p.species}`;
    if (!Number.isInteger(p.bin) || p.bin < 0 || p.bin > 7) return `basin ${p.id}: bin ${p.bin}`;
    if (!/^#[0-9a-f]{6}$/i.test(p.color ?? "")) return `basin ${p.id}: colour ${JSON.stringify(p.color)}`;
    if (typeof p.name !== "string" || !p.name) return `basin ${p.id}: no name`;
  }
  return null;
}

export function createFreshwaterFishLayer({ fetchImpl = (u) => fetch(u), dataSourceFor = null } = {}) {
  const id = "freshwater-fish";
  const name = "Freshwater fish (drainage basins)";
  const icon = "🐟";
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _bins = [];
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  const _realms = {}; // realm name → visible?

  const applyVisibility = () => {
    for (const e of _dataSource?.entities.values || []) {
      e.show = _realms[e.properties?.realm?.getValue?.()] !== false;
    }
  };
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features) {
      if (!(f.properties.realm in _realms)) _realms[f.properties.realm] = true;
      for (const e of basinEntities(f, _source)) es.add(e);
    }
    applyVisibility();
    es.resumeEvents();
  };
  const realmCounts = () => {
    const c = {};
    for (const f of _features) c[f.properties.realm] = (c[f.properties.realm] || 0) + 1;
    return c;
  };

  return {
    id,
    name,
    icon,
    source: "Tedesco et al. 2017, updated to 2024 (Zenodo 10.5281/zenodo.19511163) · CC BY 4.0",
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
          _lastError = `freshwater_fish.geojson HTTP ${res.status}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        const gj = await res.json();
        const bad = validateBasins(gj);
        if (bad) {
          _lastError = `Malformed freshwater_fish.geojson: ${bad}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _bins = gj.bins;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        _lastError = `freshwater_fish.geojson load error: ${e?.message || e}`;
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

    /** Chip params: { [realm]: boolean } — unknown keys and non-booleans are ignored. */
    setParams(params = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "boolean" && k in _realms && _realms[k] !== v) {
          _realms[k] = v;
          changed = true;
        }
      }
      if (changed) {
        applyVisibility();
        _rowControlsListener?.();
      }
      return changed;
    },
    getParams() {
      return { ..._realms };
    },

    getRowControls() {
      const counts = realmCounts();
      const chips = Object.keys(REALM_LABELS)
        .filter((r) => r in _realms)
        .map((r) => ({
          id: r,
          label: `${REALM_LABELS[r]} ${counts[r] ?? 0}`,
          active: _realms[r] !== false,
          state: _realms[r] !== false ? "active" : "idle",
          title: `${_realms[r] !== false ? "Hide" : "Show"} basins in the ${r} realm`,
          params: { [r]: !(_realms[r] !== false) },
        }));
      const legend = _bins.map((b) => ({ label: `${b.label} species`, color: b.color, count: null }));
      legend.push({
        label: `fill = freshwater fish species in the basin (${fmt(_features.length)} basins, Tedesco et al. 2017 updated to December 2024; boundaries simplified)`,
        color: "transparent",
        count: null,
      });
      return { chips, legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },

    /** Every basin at a point (any realm, shown or not), in file order. Null when off. */
    async readoutAt(lat, lon) {
      if (!_dataSource?.show) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_features.length) return row("error", { error: _lastError || "not loaded yet" });
      // Containment is half-open, so 180° is in no shape; it is the meridian the shapes start at as -180°.
      const x = ((((lon + 180) % 360) + 360) % 360) - 180;
      const hits = _features.filter((ft) => pointInGeometry(ft.geometry, x, lat));
      if (!hits.length) return row("class", { text: "Not in a mapped drainage basin", date: EDITION });
      const text = hits.map((f) => basinText(f.properties)).join("; ");
      return row("class", { text: hits.length > 1 ? `${text} (the source’s basins overlap here)` : text, date: EDITION });
    },

    getStats() {
      return { count: _features.length, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt, realms: realmCounts() };
    },
  };
}

export const freshwaterFishLayer = createFreshwaterFishLayer();
