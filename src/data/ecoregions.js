import * as Cesium from "cesium";

/**
 * Terrestrial ecoregions and biomes (polygon contract, static): RESOLVE Ecoregions 2017
 * (Dinerstein et al. 2017, CC BY 4.0) simplified by pipeline/ecoregions.py. One filled
 * polygon per ecoregion (846), coloured by its biome with the RESOLVE biome palette;
 * chips toggle the 14 biomes. Nothing here varies with time, so the layer has no
 * setObservedTime. The info box gives the ecoregion, biome, realm, Nature Needs Half
 * category and area. Fill alpha is drape-like (0.35) so the globe stays readable under it.
 */
const DATA_URL = "data/ecoregions.geojson";
export const FILL_ALPHA = 0.35;

/** RESOLVE 2017 biome palette (the shapefile's COLOR_BIO column), keyed by BIOME_NUM. */
export const BIOMES = Object.freeze({
  1: {
    name: "Tropical & Subtropical Moist Broadleaf Forests",
    color: "#38A700",
  },
  2: { name: "Tropical & Subtropical Dry Broadleaf Forests", color: "#CCCD65" },
  3: { name: "Tropical & Subtropical Coniferous Forests", color: "#88CE66" },
  4: { name: "Temperate Broadleaf & Mixed Forests", color: "#00734C" },
  5: { name: "Temperate Conifer Forests", color: "#458970" },
  6: { name: "Boreal Forests/Taiga", color: "#7AB6F5" },
  7: {
    name: "Tropical & Subtropical Grasslands, Savannas & Shrublands",
    color: "#FEAA01",
  },
  8: { name: "Temperate Grasslands, Savannas & Shrublands", color: "#FEFF73" },
  9: { name: "Flooded Grasslands & Savannas", color: "#BEE7FF" },
  10: { name: "Montane Grasslands & Shrublands", color: "#D6C39D" },
  11: { name: "Tundra", color: "#9ED7C2" },
  12: { name: "Mediterranean Forests, Woodlands & Scrub", color: "#FE0000" },
  13: { name: "Deserts & Xeric Shrublands", color: "#CC6767" },
  14: { name: "Mangroves", color: "#FE01C4" },
});
export const UNKNOWN_BIOME = Object.freeze({
  name: "unknown biome",
  color: "#9ca3af",
});

/** Nature Needs Half categories (RESOLVE NNH column). */
export const NNH = Object.freeze({
  1: "Half Protected",
  2: "Nature Could Reach Half Protected",
  3: "Nature Could Recover",
  4: "Nature Imperiled",
});

/** Short chip labels for the 14 biomes (the full names are 40–55 characters). */
const CHIP_LABELS = Object.freeze({
  1: "TROP MOIST FOREST",
  2: "TROP DRY FOREST",
  3: "TROP CONIFER",
  4: "TEMP BROADLEAF",
  5: "TEMP CONIFER",
  6: "BOREAL",
  7: "TROP GRASSLAND",
  8: "TEMP GRASSLAND",
  9: "FLOODED GRASSLAND",
  10: "MONTANE GRASSLAND",
  11: "TUNDRA",
  12: "MEDITERRANEAN",
  13: "DESERT",
  14: "MANGROVES",
});

export function biomeOf(num) {
  return BIOMES[Number(num)] || UNKNOWN_BIOME;
}

export function formatArea(km2) {
  const v = Number(km2);
  if (!Number.isFinite(v) || v <= 0) return "area unknown";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} million km²`;
  return `${Math.round(v).toLocaleString()} km²`;
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function describeEcoregion(p, source = {}) {
  const biome = biomeOf(p.biome);
  const nnh = NNH[Number(p.nnh)] || "not categorised";
  return (
    `<b>${esc(p.name)}</b><br>` +
    `Biome: <span style="color:${biome.color}">■</span> ${esc(p.biome_name || biome.name)}<br>` +
    `Realm: ${esc(p.realm || "unknown")}<br>` +
    `Nature Needs Half: ${esc(nnh)}<br>` +
    `Area: ${formatArea(p.area_km2)}<br>` +
    `<small>Boundaries simplified for display; ecoregion ID ${esc(p.eco_id)}.</small><br>` +
    `<a href="${esc(source.url || "https://ecoregions.appspot.com/")}" target="_blank" rel="noopener">${esc(source.name || "RESOLVE Ecoregions 2017")}</a> · ${esc(source.licence || "CC BY 4.0")}`
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

/** Entity options for one ecoregion (one per polygon part). */
export function ecoregionEntities(f, source = {}) {
  const p = f.properties || {};
  const biome = biomeOf(p.biome);
  const color = Cesium.Color.fromCssColorString(biome.color).withAlpha(
    FILL_ALPHA,
  );
  const polys =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
  const description = describeEcoregion(p, source);
  return polys.map((poly, k) => ({
    id: `ecoregions:${p.eco_id}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: color.withAlpha(0.6),
      outlineWidth: 1,
    },
    description,
    properties: {
      eco_id: p.eco_id,
      name: p.name,
      biome: Number(p.biome),
      biome_name: p.biome_name || biome.name,
      realm: p.realm,
      nnh: Number(p.nnh),
      area_km2: p.area_km2,
      part: k,
    },
  }));
}

export function createEcoregionsLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  const _biomes = {}; // biome num (string key) → visible?

  const applyVisibility = () => {
    for (const e of _dataSource?.entities.values || []) {
      const b = e.properties?.biome?.getValue?.();
      e.show = _biomes[b] !== false;
    }
  };
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features) {
      const b = Number(f.properties?.biome);
      if (!(b in _biomes)) _biomes[b] = true;
      for (const e of ecoregionEntities(f, _source)) es.add(e);
    }
    applyVisibility();
    es.resumeEvents();
  };
  const biomeCounts = () => {
    const c = {};
    for (const f of _features) {
      const b = Number(f.properties?.biome);
      c[b] = (c[b] || 0) + 1;
    }
    return c;
  };

  const layer = {
    id: "ecoregions",
    name: "Ecoregions and biomes (RESOLVE 2017)",
    icon: "🗺️",
    source: "RESOLVE Ecoregions 2017, Dinerstein et al. 2017 (CC BY 4.0)",
    updateInterval: 24 * 3600000, // static file; the runner is monthly

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("ecoregions");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Ecoregions] Initialized");
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
          _lastError = `ecoregions.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed ecoregions.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Ecoregions] Updated: ${_features.length} ecoregions`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Ecoregions] Load error:", e);
        _lastError = `ecoregions.geojson load error: ${e?.message || e}`;
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

    /** Chip params: { [biomeNum]: boolean } — unknown keys and non-booleans are ignored. */
    setParams(params = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "boolean" && k in _biomes && _biomes[k] !== v) {
          _biomes[k] = v;
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
      return { ..._biomes };
    },

    getRowControls() {
      const counts = biomeCounts();
      const nums = Object.keys(_biomes)
        .map(Number)
        .sort((a, b) => a - b);
      const chips = nums.map((b) => ({
        id: String(b),
        label: `${CHIP_LABELS[b] || biomeOf(b).name.toUpperCase()} ${counts[b] ?? 0}`,
        active: _biomes[b] !== false,
        state: _biomes[b] !== false ? "active" : "idle",
        title: `${_biomes[b] !== false ? "Hide" : "Show"} ${biomeOf(b).name}`,
        params: { [b]: !(_biomes[b] !== false) },
      }));
      const legend = nums
        .filter((b) => _biomes[b] !== false)
        .map((b) => ({
          label: biomeOf(b).name,
          color: biomeOf(b).color,
          count: counts[b] ?? 0,
        }));
      legend.push({
        label: `fill = biome of each RESOLVE 2017 ecoregion (${_features.length} ecoregions, static; boundaries simplified)`,
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
        .filter((e) => e.show && e.properties?.part?.getValue?.(now) === 0)
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            eco_id: g("eco_id"),
            name: g("name"),
            biome: g("biome_name"),
            realm: g("realm"),
            nnh: NNH[g("nnh")] || null,
            area_km2: g("area_km2"),
          };
        });
    },

    getStats() {
      return {
        count: _features.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        biomes: biomeCounts(),
      };
    },
  };
  return layer;
}

const ecoregionsLayer = createEcoregionsLayer();
export default ecoregionsLayer;
