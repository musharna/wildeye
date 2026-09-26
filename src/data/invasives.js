import * as Cesium from "cesium";
import { pointInGeometry } from "./mangroves.js";

/**
 * Introduced species per GRIIS checklist (polygon contract): one filled Natural Earth map unit per national
 * or overseas checklist of the Global Register of Introduced and Invasive Species, as the Invasive Species
 * Specialist Group (ISSG) publishes it on GBIF (CC BY 4.0, three lists CC0), from pipeline/griis.py.
 * Fill = introduced species on the list, in log bins; it is a count of listed species, not a severity.
 * The invasive count is read on each list's own basis (GRIIS impact flag or a spread category), which are not
 * comparable, so it lives in the readout and the info box only. Off the time bar: the date is the list's version.
 * Wave item 4 (grill_wildeye_next_wave_2026-09-25, GRIIS mini-grill Q13/Q14, A22–A33).
 */
const DATA_URL = "data/griis.geojson";
const FILL_ALPHA = 0.55;

export const BINS = Object.freeze([
  { key: "lt100", label: "< 100", color: "#fcc5c0", max: 100 },
  { key: "lt300", label: "100 – 300", color: "#fa9fb5", max: 300 },
  { key: "lt1k", label: "300 – 1,000", color: "#f768a1", max: 1000 },
  { key: "lt3k", label: "1,000 – 3,000", color: "#c51b8a", max: 3000 },
  { key: "ge3k", label: "≥ 3,000", color: "#7a0177", max: Infinity },
]);
const BASES = Object.freeze({ impact: "evidence of impact", spread: "spreading", "not stated": null });

export function binOf(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`introduced ${n} is not a species count`);
  return BINS.find((b) => n < b.max);
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (v) => v.toLocaleString("en-US");
const invasivePart = (p) =>
  p.basis === "not stated" ? "invasive: not stated on this list" : `invasive ${num(p.invasive)} (${BASES[p.basis]})`;

/** The "What's here" line (A30); no species names in v1. */
export function readoutText(p) {
  const presence = p.presence === "not stated" ? " (presence not stated on the list)" : "";
  return `Introduced species on the GRIIS list: ${num(p.introduced)}${presence} · ${invasivePart(p)} · ${p.area} list, ${p.version.slice(0, 4)}`;
}

export function describeList(p) {
  const basis = {
    impact: "flagged invasive on the list (GRIIS: evidence of impact in this area)",
    spread: "invasive or widespread invasive by degree of establishment (spreading; not the GRIIS impact flag)",
    "not stated": "the list does not state which are invasive",
  }[p.basis];
  return (
    `<b>${esc(p.area)}</b><br>` +
    `<b>${num(p.introduced)}</b> introduced species on the GRIIS list` +
    (p.presence === "not stated" ? " (the list does not state presence; all its rows are counted)" : "") +
    `<br>` +
    (p.basis === "not stated" ? `${esc(basis)}<br>` : `${num(p.invasive)} ${esc(basis)}<br>`) +
    `List version ${esc(p.version)}<br>` +
    `<small>${esc(p.citation)}</small><br>` +
    `<a href="${esc(`https://doi.org/${encodeURI(p.doi || "")}`)}" target="_blank" rel="noopener">doi:${esc(p.doi)}</a> · ${esc(p.licence)} · ` +
    `GRIIS, ISSG via GBIF · shapes: Natural Earth. A count of listed species, not a measure of harm; lists differ in effort and date.`
  );
}

const ring = (coords) => Cesium.Cartesian3.fromDegreesArray(coords.flatMap(([lon, lat]) => [lon, lat]));
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(ring(poly[0]), poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))));

function listEntities(f) {
  const p = f.properties;
  const bin = binOf(p.introduced);
  const color = Cesium.Color.fromCssColorString(bin.color).withAlpha(FILL_ALPHA);
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  const description = describeList(p);
  return polys.map((poly, k) => ({
    id: `griis:${p.key}:${k}`,
    // height 0: flat on the ellipsoid. Without it Cesium drapes each of the ~1,480 parts over terrain (ground
    // primitive, ~6 fps on an Intel iGPU) and drops the outline. Globe depth testing is off, so nothing hides it.
    polygon: { hierarchy: hierarchy(poly), height: 0, material: color, outline: true, outlineColor: color.withAlpha(0.8), outlineWidth: 1 },
    description,
    properties: { key: p.key, area: p.area, bin: bin.key, part: k },
  }));
}

function validate(gj) {
  if (!gj || !Array.isArray(gj.features)) return "Malformed griis.geojson: no features array";
  if (!Array.isArray(gj.not_drawn) || !Array.isArray(gj.protected_areas))
    return "Malformed griis.geojson: not_drawn and protected_areas must be arrays";
  for (const f of gj.features) {
    const p = f.properties || {};
    if (!Number.isInteger(p.introduced) || p.introduced < 0) return `Malformed griis.geojson: ${p.area} introduced ${JSON.stringify(p.introduced)}`;
    if (!(p.basis in BASES)) return `Malformed griis.geojson: ${p.area} basis ${JSON.stringify(p.basis)}`;
    if ((p.basis === "not stated") !== (p.invasive === null) || (p.invasive !== null && !Number.isInteger(p.invasive)))
      return `Malformed griis.geojson: ${p.area} invasive ${JSON.stringify(p.invasive)} with basis ${p.basis}`;
    if (typeof p.version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.version)) return `Malformed griis.geojson: ${p.area} version ${JSON.stringify(p.version)}`;
    if (!f.geometry || !["Polygon", "MultiPolygon"].includes(f.geometry.type)) return `Malformed griis.geojson: ${p.area} has no polygon`;
  }
  return null;
}

export function createInvasivesLayer() {
  const id = "griis";
  const name = "Introduced species by checklist (GRIIS)";
  const icon = "🦎";
  let _dataSource = null;
  let _features = [];
  let _notDrawn = [];
  let _protected = [];
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;

  const binCounts = () => {
    const c = Object.fromEntries(BINS.map((b) => [b.key, 0]));
    for (const f of _features) c[binOf(f.properties.introduced).key] += 1;
    return c;
  };

  return {
    id,
    name,
    icon,
    source: "GRIIS, ISSG via GBIF (CC BY 4.0; three lists CC0); Natural Earth map units (public domain)",
    updateInterval: 24 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log("[Data:GRIIS] Initialized");
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
          _lastError = `griis.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        const bad = validate(gj);
        if (bad) {
          _lastError = bad;
          console.error(`[Data:GRIIS] ${bad}`);
          return false;
        }
        _features = gj.features;
        _notDrawn = gj.not_drawn;
        _protected = gj.protected_areas;
        _generatedAt = gj.generated_at ?? null;
        if (_dataSource) {
          const es = _dataSource.entities;
          es.suspendEvents();
          es.removeAll();
          for (const f of _features) for (const e of listEntities(f)) es.add(e);
          es.resumeEvents();
        }
        _lastUpdate = Date.now();
        _lastError = null;
        _rowControlsListener?.();
        console.log(`[Data:GRIIS] Updated: ${_features.length} lists drawn, ${_notDrawn.length} not drawn`);
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:GRIIS] Load error:", e);
        _lastError = `griis.geojson load error: ${e?.message || e}`;
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

    /** "What's here" row: the drawn checklist the point falls in (Natural Earth 50m shapes). */
    async readoutAt(lat, lon) {
      if (!_dataSource?.show) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_lastUpdate) return row("error", { error: _lastError || "not loaded yet" });
      const f = _features.find((x) => pointInGeometry(x.geometry, lon, lat));
      if (!f) return row("class", { text: "Not in an area with a drawn GRIIS list" });
      return row("class", { text: readoutText(f.properties), date: f.properties.version });
    },

    getRowControls() {
      const counts = binCounts();
      const legend = BINS.map((b) => ({ label: b.label, color: b.color, count: counts[b.key] }));
      const note = (label) => legend.push({ label, color: "transparent", count: null });
      note("fill = introduced species on the GRIIS list for that area (a count of listed species, not harm; lists differ in effort and date); no fill = no GRIIS list drawn");
      if (_notDrawn.length)
        note(`not drawn (smaller than a Natural Earth map unit, or sharing one): ${_notDrawn.map((n) => `${n.area} ${num(n.introduced)}`).join(", ")}`);
      if (_protected.length) note(`${_protected.length} protected-area lists not drawn`);
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
        bins: binCounts(),
        notDrawn: _notDrawn.length,
        protectedAreas: _protected.length,
      };
    },
  };
}

export const invasivesLayer = createInvasivesLayer();
export default invasivesLayer;
