import * as Cesium from "cesium";
import { pointInGeometry } from "./mangroves.js";

/**
 * Marine biogeographic realms (polygon contract, static): Costello et al. 2017 (Nature Communications 8:1057; figshare
 * 10.17608/k6.auckland.5596840, CC BY 4.0), land removed and simplified by pipeline/marine_realms.py (spec
 * docs/superpowers/specs/2026-10-03-marine-realms-design.md). 30 realms from the distributions of 65,000 marine species
 * cover the whole ocean, coast and open water; each has its own colour, and chips toggle the paper's 8 top-level
 * groups. The info box and the point readout give the realm, its group and the share of its species found in no
 * other realm. Nothing varies with time.
 */
const DATA_URL = "data/marine_realms.geojson";
export const FILL_ALPHA = 0.35;
export const EDITION = "2017";

/** Short chip labels for the 8 groups of the paper's Fig. 1 (the full names are up to 80 characters). */
export const GROUP_LABELS = Object.freeze({
  1: "BALTIC",
  2: "BLACK SEA",
  3: "N ATLANTIC, ARCTIC & N PACIFIC",
  4: "MID-TROP N PACIFIC",
  5: "SE PACIFIC",
  6: "TROPICS & WARM SEAS",
  7: "NW PACIFIC",
  8: "SOUTHERN OCEAN",
});

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function formatArea(km2) {
  const v = Number(km2);
  if (!Number.isFinite(v) || v <= 0) return "area unknown";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} million km²`;
  return `${Math.round(v).toLocaleString("en-US")} km²`;
}

/** The readout line for one realm. */
export function realmText(p) {
  return `${p.name} (realm ${p.realm}) · ${p.pct_unique}% of its ${Number(p.species).toLocaleString("en-US")} species unique to it`;
}

export function describeRealm(p, source = {}) {
  return (
    `<b>${esc(p.name)}</b> (realm ${esc(p.realm)} of 30)<br>` +
    `Group: ${esc(p.group_name)}<br>` +
    `Species recorded: ${Number(p.species).toLocaleString("en-US")}; ${esc(p.pct_unique)}% found in no other realm<br>` +
    `Sea area: ${formatArea(p.area_km2)}<br>` +
    `<small>Realms from the distributions of 65,000 marine species (OBIS); boundaries simplified and land removed for display.</small><br>` +
    `<a href="${esc(source.url || "https://doi.org/10.17608/k6.auckland.5596840")}" target="_blank" rel="noopener">${esc(source.name || "Marine biogeographic realms (Costello et al. 2017)")}</a> · ${esc(source.licence || "CC BY 4.0")}`
  );
}

const ring = (coords) => Cesium.Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(
    ring(poly[0]),
    poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))),
  );

/** Entity options for one realm (one per polygon part). */
export function realmEntities(f, source = {}) {
  const p = f.properties || {};
  const color = Cesium.Color.fromCssColorString(p.color || "#9ca3af").withAlpha(FILL_ALPHA);
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  const description = describeRealm(p, source);
  return polys.map((poly, k) => ({
    id: `marine-realms:${p.realm}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: color.withAlpha(0.6),
      outlineWidth: 1,
    },
    description,
    properties: { realm: Number(p.realm), name: p.name, group: Number(p.group), part: k },
  }));
}

/** null when the GeoJSON has the shape pipeline/marine_realms.py writes; otherwise what is wrong with it. */
export function validateRealms(gj) {
  if (!gj || !Array.isArray(gj.features)) return "no features";
  const seen = new Set();
  for (const f of gj.features) {
    const p = f?.properties || {};
    const t = f?.geometry?.type;
    if (!Number.isInteger(p.realm) || p.realm < 1 || p.realm > 30) return `realm ${JSON.stringify(p.realm)} is not 1–30`;
    if (seen.has(p.realm)) return `realm ${p.realm} appears twice`;
    seen.add(p.realm);
    if (t !== "Polygon" && t !== "MultiPolygon") return `realm ${p.realm}: geometry ${t} is not a polygon`;
    if (!(p.group in GROUP_LABELS)) return `realm ${p.realm}: group ${JSON.stringify(p.group)} is not one of the 8`;
    if (typeof p.name !== "string" || !p.name) return `realm ${p.realm}: no name`;
    if (!/^#[0-9a-f]{6}$/i.test(p.color ?? "")) return `realm ${p.realm}: colour ${JSON.stringify(p.color)}`;
  }
  if (seen.size !== 30) return `${seen.size} realms, not 30`;
  return null;
}

export function createMarineRealmsLayer({ fetchImpl = (u) => fetch(u), dataSourceFor = null } = {}) {
  const id = "marine-realms";
  const name = "Marine realms (Costello et al. 2017)";
  const icon = "🐠";
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _groupNames = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  const _groups = {}; // group num (string key) → visible?

  const applyVisibility = () => {
    for (const e of _dataSource?.entities.values || []) {
      const g = e.properties?.group?.getValue?.();
      e.show = _groups[g] !== false;
    }
  };
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features) {
      const g = Number(f.properties.group);
      if (!(g in _groups)) _groups[g] = true;
      for (const e of realmEntities(f, _source)) es.add(e);
    }
    applyVisibility();
    es.resumeEvents();
  };
  const groupCounts = () => {
    const c = {};
    for (const f of _features) c[f.properties.group] = (c[f.properties.group] || 0) + 1;
    return c;
  };

  return {
    id,
    name,
    icon,
    source: "Costello et al. 2017, marine biogeographic realms (figshare) · CC BY 4.0",
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
          _lastError = `marine_realms.geojson HTTP ${res.status}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        const gj = await res.json();
        const bad = validateRealms(gj);
        if (bad) {
          _lastError = `Malformed marine_realms.geojson: ${bad}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _groupNames = gj.groups || {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        _lastError = `marine_realms.geojson load error: ${e?.message || e}`;
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

    /** Chip params: { [groupNum]: boolean } — unknown keys and non-booleans are ignored. */
    setParams(params = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "boolean" && k in _groups && _groups[k] !== v) {
          _groups[k] = v;
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
      return { ..._groups };
    },

    getRowControls() {
      const counts = groupCounts();
      const nums = Object.keys(_groups).map(Number).sort((a, b) => a - b);
      const chips = nums.map((g) => ({
        id: String(g),
        label: `${GROUP_LABELS[g]} ${counts[g] ?? 0}`,
        active: _groups[g] !== false,
        state: _groups[g] !== false ? "active" : "idle",
        title: `${_groups[g] !== false ? "Hide" : "Show"} ${_groupNames[g] || GROUP_LABELS[g]}`,
        params: { [g]: !(_groups[g] !== false) },
      }));
      const legend = _features
        .filter((f) => _groups[f.properties.group] !== false)
        .map((f) => ({ label: `${f.properties.realm} ${f.properties.name}`, color: f.properties.color, count: null }));
      legend.push({
        label: `fill = marine biogeographic realm (Costello et al. 2017: ${_features.length} realms from 65,000 species' distributions; boundaries simplified, land removed)`,
        color: "transparent",
        count: null,
      });
      return { chips, legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },

    /** The realm at a point (any group, shown or not); land reads as no realm. Null when off. */
    async readoutAt(lat, lon) {
      if (!_dataSource?.show) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_features.length) return row("error", { error: _lastError || "not loaded yet" });
      // Containment is half-open, so 180° is in no shape; it is the meridian the shapes start at as -180°.
      const x = ((((lon + 180) % 360) + 360) % 360) - 180;
      const f = _features.find((ft) => pointInGeometry(ft.geometry, x, lat));
      if (!f) return row("class", { text: "Land: not in a marine realm", date: EDITION });
      return row("class", { text: realmText(f.properties), date: EDITION });
    },

    getStats() {
      return { count: _features.length, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt, groups: groupCounts() };
    },
  };
}

export const marineRealmsLayer = createMarineRealmsLayer();
