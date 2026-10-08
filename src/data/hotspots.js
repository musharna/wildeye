import * as Cesium from "cesium";
import { pointInGeometry } from "./mangroves.js";
import { formatArea } from "./marineRealms.js";

/**
 * Biodiversity hotspots (polygon contract, static): Conservation International's 2016.1 boundaries (Zenodo
 * 10.5281/zenodo.3261807, CC BY-SA 4.0), simplified by pipeline/hotspots.py (spec
 * docs/superpowers/specs/2026-10-07-hotspots-design.md). The 36 hotspots are filled, each in its own colour, with an
 * outline. A hotspot made of scattered islands or patches also has an outer limit, drawn as a dashed line in its
 * colour: the source metadata defines it as the line that groups the hotspot's islands into one unit for display, not
 * part of the hotspot. The readout names the hotspot under a point, else the outer limit, else none. Nothing varies
 * with time; an IUCN-led re-evaluation of the hotspots has been under way since October 2025.
 */
const DATA_URL = "data/hotspots.geojson";
export const FILL_ALPHA = 0.35;
export const EDITION = "2016.1";
export const HOTSPOTS = 36;
export const NONE_TEXT = "Not in a biodiversity hotspot";
const DASH_SWATCH = (c) => `repeating-linear-gradient(90deg, ${c} 0 4px, transparent 4px 7px)`;

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The readout line for a point in a hotspot. */
export function areaText(p) {
  return `${p.name} biodiversity hotspot · ${formatArea(p.area_km2)}`;
}

/** The readout line for a point inside one or more outer limits and no hotspot. */
export function outerText(names) {
  return names.length === 1
    ? `In the outer limit of ${names[0]}, which groups the hotspot's islands; not part of the hotspot`
    : `In the outer limits of ${names.join(" and ")}, which group each hotspot's islands; not part of these hotspots`;
}

const sourceLink = (source) =>
  `<a href="${esc(source.url || "https://doi.org/10.5281/zenodo.3261807")}" target="_blank" rel="noopener">${esc(source.name || "Biodiversity Hotspots (version 2016.1), Conservation International")}</a> · ${esc(source.licence || "CC BY-SA 4.0")}`;

export function describeArea(p, source = {}) {
  return (
    `<b>${esc(p.name)}</b>: biodiversity hotspot (Conservation International, version 2016.1)<br>` +
    `Land area: ${formatArea(p.area_km2)}<br>` +
    `A hotspot holds at least 1,500 endemic vascular plant species and has lost at least 70% of its primary native vegetation (Myers et al. 2000).<br>` +
    `<small>Boundaries simplified for display; islets under about 6 km² are not drawn. These are the 2016 boundaries: an IUCN-led re-evaluation of the hotspots has been under way since October 2025.</small><br>` +
    sourceLink(source)
  );
}

export function describeOuter(p, source = {}) {
  return (
    `<b>Outer limit of ${esc(p.name)}</b><br>` +
    `This line groups the hotspot's islands and patches of land into one unit for display. The outer limit is not part of the hotspot itself (source metadata).<br>` +
    sourceLink(source)
  );
}

const ring = (coords) => Cesium.Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(
    ring(poly[0]),
    poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))),
  );
const partsOf = (g) => (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]);

const onMeridian180 = (a, b) => Math.abs(a[0]) === 180 && Math.abs(b[0]) === 180;

/** The stretches of a closed ring to draw as a limit: every edge except those lying on ±180°, where the source cut a
 * limit that crosses the antimeridian in two (New Zealand's and Polynesia-Micronesia's). Drawn, those edges would be
 * a dashed line along the date line that is no limit at all. A ring with no such edge is one run, as given. */
export function limitRuns(coords) {
  const n = coords.length - 1; // closed: the last point repeats the first
  const at = (i) => coords[i % n];
  const isCut = (i) => onMeridian180(at(i), at(i + 1));
  let first = -1;
  for (let i = 0; i < n && first < 0; i += 1) if (isCut(i)) first = i;
  if (first < 0) return [coords];
  // walk once round the ring from the vertex after a cut edge; every cut edge closes a run, the last one included
  const runs = [];
  let run = [at(first + 1)];
  for (let e = first + 1; e <= first + n; e += 1) {
    if (isCut(e)) {
      if (run.length > 1) runs.push(run);
      run = [at(e + 1)];
    } else run.push(at(e + 1));
  }
  return runs;
}

/** Entity options for one feature: a filled polygon per hotspot part, or dashed lines along each outer-limit part's
 * outer ring less its edges on ±180° (`limitRuns`); the ring's holes are the hotspot's own coastlines, already
 * outlined by the fill. `index` is the hotspot's place. */
export function hotspotEntities(f, index, source = {}) {
  const p = f.properties || {};
  const base = Cesium.Color.fromCssColorString(p.color || "#9ca3af");
  const properties = { kind: p.kind, name: p.name };
  if (p.kind === "outer") {
    const description = describeOuter(p, source);
    return partsOf(f.geometry).flatMap((poly, k) => limitRuns(poly[0]).map((run, r) => ({
      id: `hotspots:outer:${index}:${k}:${r}`,
      polyline: {
        positions: ring(run),
        width: 2,
        arcType: Cesium.ArcType.RHUMB, // the shapefile's edges are straight in lon/lat
        material: new Cesium.PolylineDashMaterialProperty({ color: base.withAlpha(0.9), dashLength: 12 }),
      },
      description,
      properties,
    })));
  }
  const fill = base.withAlpha(FILL_ALPHA);
  const description = describeArea(p, source);
  return partsOf(f.geometry).map((poly, k) => ({
    id: `hotspots:area:${index}:${k}`,
    polygon: { hierarchy: hierarchy(poly), material: fill, outline: true, outlineColor: base.withAlpha(0.8), outlineWidth: 1 },
    description,
    properties,
  }));
}

/** null when the GeoJSON has the shape pipeline/hotspots.py writes; otherwise what is wrong with it. */
export function validateHotspots(gj) {
  if (!gj || !Array.isArray(gj.features)) return "no features";
  const areas = new Map();
  const outers = new Set();
  for (const f of gj.features) {
    const p = f?.properties || {};
    const t = f?.geometry?.type;
    if (p.kind !== "area" && p.kind !== "outer") return `kind ${JSON.stringify(p.kind)} is neither "area" nor "outer"`;
    if (typeof p.name !== "string" || !p.name) return `a ${p.kind} with no name`;
    if (t !== "Polygon" && t !== "MultiPolygon") return `'${p.name}': geometry ${t} is not a polygon`;
    if (!/^#[0-9a-f]{6}$/i.test(p.color ?? "")) return `'${p.name}': colour ${JSON.stringify(p.color)}`;
    if (p.kind === "area") {
      if (areas.has(p.name)) return `'${p.name}' hotspot area appears twice`;
      if (!(Number(p.area_km2) > 0)) return `'${p.name}': area ${JSON.stringify(p.area_km2)}`;
      areas.set(p.name, p.color);
    } else {
      if (outers.has(p.name)) return `'${p.name}' outer limit appears twice`;
      outers.add(p.name);
    }
  }
  if (areas.size !== HOTSPOTS) return `${areas.size} hotspot areas, not ${HOTSPOTS}`;
  for (const f of gj.features.filter((x) => x.properties.kind === "outer")) {
    const { name, color } = f.properties;
    if (!areas.has(name)) return `outer limit of '${name}', which is not a hotspot area`;
    if (areas.get(name) !== color) return `'${name}' outer limit is not in its hotspot's colour`;
  }
  return null;
}

export function createHotspotsLayer({ fetchImpl = (u) => fetch(u), dataSourceFor = null } = {}) {
  const id = "hotspots";
  const name = "Biodiversity hotspots (CI 2016.1)";
  const icon = "🌺";
  let _dataSource = null;
  let _areas = [];
  let _outers = [];
  let _source = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;

  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    const index = new Map(_areas.map((f, i) => [f.properties.name, i]));
    for (const f of [..._areas, ..._outers]) {
      for (const e of hotspotEntities(f, index.get(f.properties.name), _source)) es.add(e);
    }
    es.resumeEvents();
  };

  return {
    id,
    name,
    icon,
    source: "Conservation International, Biodiversity Hotspots 2016.1 (Zenodo) · CC BY-SA 4.0",
    updateInterval: 24 * 3600000, // static file

    init(viewer) {
      _dataSource = dataSourceFor ? dataSourceFor(id) : new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _areas = [];
      _outers = [];
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
          _lastError = `hotspots.geojson HTTP ${res.status}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        const gj = await res.json();
        const bad = validateHotspots(gj);
        if (bad) {
          _lastError = `Malformed hotspots.geojson: ${bad}`;
          console.error(`[Data:${id}] ${_lastError}`);
          return false;
        }
        _areas = gj.features.filter((f) => f.properties.kind === "area");
        _outers = gj.features.filter((f) => f.properties.kind === "outer");
        _source = gj.source || {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        _lastError = `hotspots.geojson load error: ${e?.message || e}`;
        console.error(`[Data:${id}] ${_lastError}`, e);
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _areas = [];
      _outers = [];
      _lastUpdate = null;
      _lastError = null;
    },

    getRowControls() {
      const legend = _areas.map((f) => ({ label: f.properties.name, color: f.properties.color, count: null }));
      legend.push({
        label: "dashed line = outer limit: groups a hotspot's islands and patches into one unit for display; not part of the hotspot",
        color: DASH_SWATCH("#d1d5db"),
        count: null,
      });
      legend.push({
        label: `fill = biodiversity hotspot (Conservation International 2016.1, ${_areas.length} hotspots): at least 1,500 endemic vascular plant species and at least 70% of primary native vegetation lost. Boundaries simplified; an IUCN-led re-evaluation has been under way since October 2025.`,
        color: "transparent",
        count: null,
      });
      return { legend };
    },

    /** The hotspot at a point, else the outer limits holding it, else none. Null when off. */
    async readoutAt(lat, lon) {
      if (!_dataSource?.show) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_areas.length) return row("error", { error: _lastError || "not loaded yet" });
      // Containment is half-open, so 180° is in no shape; it is the meridian the shapes start at as -180°.
      const x = ((((lon + 180) % 360) + 360) % 360) - 180;
      const area = _areas.find((f) => pointInGeometry(f.geometry, x, lat));
      if (area) return row("class", { text: areaText(area.properties), date: EDITION });
      const outer = _outers.filter((f) => pointInGeometry(f.geometry, x, lat)).map((f) => f.properties.name);
      return row("class", { text: outer.length ? outerText(outer) : NONE_TEXT, date: EDITION });
    },

    getStats() {
      return { count: _areas.length, outerLimits: _outers.length, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt };
    },
  };
}

export const hotspotsLayer = createHotspotsLayer();
