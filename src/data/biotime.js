import * as Cesium from "cesium";
import { extentFromTimes } from "./observedExtent.js";

/**
 * Assemblage time series, BioTIME 2.0 (Dornelas et al. 2025, Global Ecology and Biogeography 34(5): e70003,
 * doi:10.1111/geb.70003; Zenodo 15222193, CC BY 4.0), site-series contract: one dot per openly licensed study, from
 * pipeline/biotime.py (spec docs/superpowers/specs/2026-10-01-biotime-design.md). With the shared observed time set,
 * a study shows the year containing the instant: sampled that year → its raw count of taxa beside its count of
 * samples; between sampled years → faded, the gap named; outside its span → hidden. Live shows each study's latest
 * sampled year. Counts are raw, so the info box says more samples find more taxa and never states a trend. A study
 * spanning more than the pipeline's wideKm2 draws the 0.01° cells it sampled that year instead of one centroid.
 */
export const TAXA = ["Plants", "Invertebrates", "Fish", "Birds", "Mammals", "Amphibians", "Reptiles", "Fungi", "Multiple"];
const COLORS = ["#66bb6a", "#ffa726", "#42a5f5", "#fdd835", "#a1887f", "#26c6da", "#d4e157", "#ab47bc", "#eceff1"];
const UNKNOWN = "#9e9e9e";
const FADED = 0.25;
const MAX_CITATIONS = 3;

export const taxonColor = (group) => COLORS[TAXA.indexOf(group)] ?? UNKNOWN;

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The UTC calendar year of an instant; null (live) stays null. */
export function yearOf(iso) {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`not an instant: ${iso}`);
  return new Date(t).getUTCFullYear();
}

const sampledYears = (s) => Object.keys(s.years).map(Number).sort((a, b) => a - b);

/** What a study shows in `year` (null = live, its latest sampled year). */
export function studyAt(s, year) {
  const ys = sampledYears(s);
  const y = year ?? ys[ys.length - 1];
  if (s.years[y]) {
    const [taxa, samples] = s.years[y];
    return { status: "sampled", year: y, taxa, samples };
  }
  if (!ys.length || y < ys[0] || y > ys[ys.length - 1]) return { status: "hidden", year: y };
  return { status: "gap", year: y, before: ys.filter((v) => v < y).pop(), after: ys.find((v) => v > y) };
}

export function describeStudy(s, state, source = {}) {
  const ys = sampledYears(s);
  const span = ys.length > 1 ? `${ys[0]}–${ys[ys.length - 1]}` : `${ys[0]}`;
  const lines = [
    `<b>${esc(s.title)}</b>`,
    `${esc(s.organisms)} · ${esc(s.taxa)} · ${esc(s.realm)}`,
    `Sampled in ${plural(ys.length, "year", "years")}, ${span}`,
  ];
  if (state.status === "sampled") {
    lines.push(`${state.year}: ${plural(state.taxa, "taxon", "taxa")} in ${plural(state.samples, "sample", "samples")}`);
    lines.push("<small>Raw counts: more samples find more taxa, so years are not directly comparable.</small>");
  } else if (state.status === "gap") {
    lines.push(`Not sampled in ${state.year} (sampled ${state.before} and ${state.after})`);
  }
  if (s.wide)
    lines.push(
      `<small>Spans about ${Math.round(s.areaKm2).toLocaleString("en-US")} km²: the dots are the places sampled in ${state.year}.</small>`,
    );
  const cites = (s.citations || []).slice(0, MAX_CITATIONS).map((c) => `<small>${esc(c)}</small>`);
  if ((s.citations || []).length > MAX_CITATIONS) cites.push(`<small>+${s.citations.length - MAX_CITATIONS} more</small>`);
  lines.push(...cites);
  if (s.link) lines.push(`<a href="${esc(s.link)}" target="_blank" rel="noopener">Study data source</a>`);
  lines.push(`<small>Licence: ${esc(s.licence)}</small>`);
  lines.push(
    `<a href="https://doi.org/${esc(source.doi || "10.1111/geb.70003")}" target="_blank" rel="noopener">${esc(source.name || "BioTIME 2.0")}</a> (Dornelas et al. 2025) · CC BY 4.0`,
  );
  return lines.join("<br>");
}

/** The span the studies can serve: the first sampled year's first instant to the last year's last. */
export function studiesExtent(studies) {
  const ys = (studies || []).flatMap((s) => Object.keys(s.years || {}).map(Number)).filter(Number.isFinite);
  if (!ys.length) return null;
  const lo = Math.min(...ys),
    hi = Math.max(...ys);
  return extentFromTimes([Date.UTC(lo, 0, 1), Date.UTC(hi + 1, 0, 1) - 1]);
}

const DATA_URL = "data/biotime.json";

/** Entity options for a study drawn as one dot (not wide, or a wide study in a gap year); null when hidden. */
export function studyEntity(s, state, source) {
  if (state.status === "hidden" || (s.wide && state.status === "sampled")) return null;
  const alpha = state.status === "sampled" ? 1 : FADED;
  const color = Cesium.Color.fromCssColorString(taxonColor(s.taxa)).withAlpha(alpha);
  return {
    id: `biotime:${s.id}`,
    name: s.title,
    position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
    point: {
      pixelSize: state.status === "sampled" ? 5 + Math.min(9, 2 * Math.log10(state.samples + 1)) : 5,
      color,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.7 * alpha),
      outlineWidth: 1,
      disableDepthTestDistance: 50_000,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describeStudy(s, state, source),
    properties: { kind: "biotime-study", study: s.id, status: state.status, year: state.year, taxa: state.taxa ?? null, samples: state.samples ?? null },
  };
}

/** The 0.01° cells a wide study sampled in the state's year ([lon, lat] pairs); none unless sampled. */
export function studyCells(s, state, locations) {
  if (!s.wide || state.status !== "sampled") return [];
  return locations?.[String(s.id)]?.[String(state.year)] ?? [];
}

export function createBiotimeLayer({
  fetchImpl = (u) => fetch(u),
  pointsFor = () => new Cesium.PointPrimitiveCollection(),
  clickHandlerFor = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  let _viewer = null,
    _dataSource = null,
    _points = null,
    _click = null,
    _enabled = false,
    _studies = [],
    _byId = new Map(),
    _locations = {},
    _source = {},
    _dropped = {},
    _visible = Object.fromEntries(TAXA.map((t) => [t, true])),
    _year = null,
    _lastUpdate = null,
    _lastError = null,
    _shown = 0,
    _cells = 0,
    _rowControlsListener = null;

  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    try {
      fill(es);
    } finally {
      es.resumeEvents();
    }
  };

  const fill = (es) => {
    es.removeAll();
    _points.removeAll();
    _shown = 0;
    _cells = 0;
    for (const s of _studies) {
      if (_visible[s.taxa] === false) continue;
      const state = studyAt(s, _year);
      const e = studyEntity(s, state, _source);
      if (e) es.add(e);
      const cells = studyCells(s, state, _locations);
      if (e || cells.length) _shown += 1;
      if (!cells.length) continue;
      const color = Cesium.Color.fromCssColorString(taxonColor(s.taxa));
      for (const [lon, lat] of cells)
        _points.add({ id: `biotime-cell:${s.id}`, position: Cesium.Cartesian3.fromDegrees(lon, lat, 0), pixelSize: 4, color, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1, disableDepthTestDistance: 50_000 });
      _cells += cells.length;
    }
  };

  /** A click on a wide study's cell opens that study's info box at the cell. */
  const onClick = (click) => {
    if (!_enabled || !_viewer) return;
    const picked = _viewer.scene.pick(click.position);
    const id = picked?.primitive?.id ?? picked?.id;
    if (typeof id !== "string" || !id.startsWith("biotime-cell:")) return;
    const s = _byId.get(Number(id.slice("biotime-cell:".length)));
    if (!s) return;
    const at = picked.primitive.position;
    _dataSource.entities.removeById("biotime:cell-pick");
    const state = studyAt(s, _year);
    _viewer.selectedEntity = _dataSource.entities.add({
      id: "biotime:cell-pick",
      name: s.title,
      position: at,
      point: { pixelSize: 8, color: Cesium.Color.WHITE.withAlpha(0.9) },
      description: describeStudy(s, state, _source),
      properties: { kind: "biotime-study", study: s.id, status: state.status, year: state.year, taxa: state.taxa ?? null, samples: state.samples ?? null },
    });
  };

  const load = async () => {
    const res = await fetchImpl(DATA_URL);
    if (!res.ok) throw new Error(`biotime.json HTTP ${res.status}`);
    const m = await res.json();
    if (!m || !Array.isArray(m.studies) || !m.studies.every((s) => Number.isInteger(s.id) && s.years && typeof s.years === "object"))
      throw new Error("Malformed biotime.json: studies is not a list of studies with years");
    let locations = {};
    if (m.studies.some((s) => s.wide)) {
      const r = await fetchImpl(m.locations);
      if (!r.ok) throw new Error(`${m.locations} HTTP ${r.status}`);
      locations = await r.json();
    }
    _studies = m.studies;
    _byId = new Map(_studies.map((s) => [s.id, s]));
    _locations = locations;
    _source = m.source || {};
    _dropped = m.dropped || {};
  };

  return {
    id: "biotime",
    name: "Assemblage time series (BioTIME 2.0)",
    icon: "📈",
    source: "BioTIME 2.0 (Dornelas et al. 2025), Zenodo 15222193 · open-licence studies only; per-study citation in the info box",
    updateInterval: 24 * 3600000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource("biotime");
      _dataSource.show = _enabled;
      viewer.dataSources.add(_dataSource);
      _points = viewer.scene.primitives.add(pointsFor());
      _points.show = _enabled;
      _click = clickHandlerFor(viewer.scene.canvas);
      _click.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      if (_points) _points.show = true;
    },
    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      if (_points) _points.show = false;
    },
    async update() {
      if (_lastUpdate && !_lastError) return true; // a fixed release: read once
      try {
        await load();
        _lastError = null;
        _lastUpdate = Date.now();
        rebuild();
        _rowControlsListener?.();
        return true;
      } catch (e) {
        _lastError = e?.message || String(e);
        console.error(`[Data:biotime] ${_lastError}`, e);
        return false;
      }
    },
    destroy(viewer) {
      _click?.destroy();
      _click = null;
      if (_points) viewer.scene.primitives.remove(_points);
      if (_dataSource) viewer.dataSources.remove(_dataSource, true);
      _points = null;
      _dataSource = null;
      _viewer = null;
    },
    getObservedExtent() {
      return studiesExtent(_studies);
    },
    setObservedTime(iso) {
      let year;
      try {
        year = yearOf(iso);
      } catch {
        return false;
      }
      if (year === _year) return true;
      _year = year;
      rebuild();
      _rowControlsListener?.();
      return true;
    },
    setParams(params = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(params))
        if (typeof v === "boolean" && k in _visible && _visible[k] !== v) {
          _visible[k] = v;
          changed = true;
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
      const chips = TAXA.map((t) => ({
        id: t,
        label: t.toUpperCase(),
        active: _visible[t] !== false,
        state: _visible[t] !== false ? "active" : "idle",
        title: `${_visible[t] !== false ? "Hide" : "Show"} ${t}`,
        params: { [t]: !(_visible[t] !== false) },
      }));
      const counts = {};
      for (const s of _studies) if (studyAt(s, _year).status !== "hidden") counts[s.taxa] = (counts[s.taxa] || 0) + 1;
      const legend = TAXA.filter((t) => _visible[t] !== false).map((t) => ({ label: t, color: taxonColor(t), count: counts[t] ?? 0 }));
      const dropped = Object.values(_dropped).reduce((a, b) => a + b, 0);
      legend.push({
        label: `dot = one study (wide studies: the places sampled that year) · ${_year === null ? "latest sampled year" : `${_year}`} · faded = not sampled that year · raw counts, not trends · ${dropped} studies under non-open licences left out`,
        color: "transparent",
        count: null,
      });
      return { chips, legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },
    getStats() {
      return { count: _studies.length, shown: _shown, cells: _cells, lastUpdate: _lastUpdate, error: _lastError, observed: _year };
    },
  };
}

export const biotimeLayer = createBiotimeLayer();
