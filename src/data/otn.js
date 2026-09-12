import * as Cesium from "cesium";

/**
 * OTN acoustic detections (site-series contract): one point per receiver station,
 * sized by how many tagged animals were heard there and coloured by the dominant
 * species, from pipeline/otn.py (Ocean Tracking Network ERDDAP, CC BY 4.0). Detections
 * are events at fixed receivers, so nothing here is a path. With the shared observed
 * time set, each station shows the 7-day bin containing the instant; live shows the
 * last WINDOW_WEEKS bins of the public record, whose end date is stated in the legend
 * because collaborators' embargoes keep it about a year behind today.
 */
const DATA_URL = "data/otn.geojson";
export const WINDOW_WEEKS = 13;
const DAY_MS = 86_400_000;
const FADED = 0.2;

const PALETTE = [
  "#4fc3f7",
  "#ffb74d",
  "#aed581",
  "#f06292",
  "#ce93d8",
  "#fff176",
  "#80cbc4",
  "#ff8a65",
  "#b0bec5",
  "#a1887f",
];

export function speciesColor(species, order) {
  const i = Math.max(0, order.indexOf(species));
  return PALETTE[i % PALETTE.length];
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** Sum per-species counts (and animals) over the bins in scope; `visible` filters species. */
function sumWeeks(bins, visible) {
  const n = {};
  let animals = 0;
  for (const b of bins) {
    for (const [sp, c] of Object.entries(b.n || {}))
      if (visible[sp] !== false) n[sp] = (n[sp] || 0) + c;
    animals = Math.max(animals, b.a || 0);
  }
  return { n, total: Object.values(n).reduce((a, b) => a + b, 0), animals };
}

/**
 * Bins in scope for a station at `iso`: the single 7-day bin (w−6 d … w] containing the
 * instant, or (iso null) the newest WINDOW_WEEKS bins of the record ending `dataEnd`.
 * Returns { bins, label }.
 */
export function binsAt(weeks, iso, dataEnd) {
  if (!iso) {
    const cutoff = dataEnd
      ? Date.parse(`${dataEnd}T00:00:00Z`) - (WINDOW_WEEKS - 1) * 7 * DAY_MS
      : -Infinity;
    return {
      bins: (weeks || []).filter(
        (w) => Date.parse(`${w.w}T00:00:00Z`) >= cutoff,
      ),
      label: `last ${WINDOW_WEEKS} weeks to ${dataEnd ?? "?"}`,
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
      : `no public detections in the week of ${iso.slice(0, 10)}`,
  };
}

export function describeStation(p, scope, sum, project = {}, source = {}) {
  const rows = Object.entries(sum.n)
    .sort((a, b) => b[1] - a[1])
    .map(([sp, c]) => `${esc(sp)} <i>${esc(p.sci?.[sp] || "")}</i>: ${c}`)
    .join("<br>");
  return (
    `<b>Receiver ${esc(p.station || "(unnamed)")}</b> · ${esc(project.project_name || p.project)}<br>` +
    `${scope.label}: ${sum.total} detection${sum.total === 1 ? "" : "s"}${sum.animals ? ` · up to ${sum.animals} tagged animal${sum.animals === 1 ? "" : "s"} in a week` : ""}<br>` +
    (rows ? `${rows}<br>` : "") +
    `<small>Detections are events at this fixed receiver, not positions between receivers.</small><br>` +
    (project.project_citation
      ? `<small>${esc(project.project_citation)}</small><br>`
      : "") +
    `<a href="${esc(project.project_infourl || source.url || "https://oceantrack.org")}" target="_blank" rel="noopener">${esc(source.name || "Ocean Tracking Network")}</a> · ${esc(source.licence || "CC BY 4.0")}`
  );
}

/** Entity options for one station at the observed instant (index-based id: names repeat across projects). */
export function stationEntity(f, index, iso, ctx) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const scope = binsAt(p.weeks, iso, ctx.dataEnd);
  const sum = sumWeeks(scope.bins, ctx.visible);
  const dominant =
    Object.entries(sum.n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const alpha = sum.total > 0 ? 1 : FADED;
  const css = dominant ? speciesColor(dominant, ctx.species) : "#9ca3af";
  const color = Cesium.Color.fromCssColorString(css).withAlpha(alpha);
  return {
    id: `otn:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 5 + Math.min(14, 3 * Math.log10(sum.total + 1)),
      color,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.7 * alpha),
      outlineWidth: 1,
      disableDepthTestDistance: 50_000,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describeStation(
      p,
      scope,
      sum,
      ctx.projects?.[p.project],
      ctx.source,
    ),
    properties: {
      station: p.station,
      project: p.project,
      lat,
      lon,
      total: sum.total,
      animals: sum.animals,
      dominant,
      scope: scope.label,
      kind: "otn-station",
    },
  };
}

export function createOtnLayer() {
  let _dataSource = null;
  let _features = [];
  let _species = [];
  let _visible = {};
  let _projects = {};
  let _source = {};
  let _dataEnd = null;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null; // ISO or null = latest public window
  let _rowControlsListener = null;

  const ctx = () => ({
    dataEnd: _dataEnd,
    visible: _visible,
    species: _species,
    projects: _projects,
    source: _source,
  });
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    _features.forEach((f, i) => es.add(stationEntity(f, i, _observed, ctx())));
    es.resumeEvents();
  };
  /** Stations with ≥1 detection in scope, per dominant species (legend counts). */
  const activeCounts = () => {
    const c = {};
    let active = 0;
    for (const e of _dataSource?.entities.values || []) {
      const t = e.properties?.total?.getValue?.() ?? 0;
      if (t <= 0) continue;
      active++;
      const d = e.properties?.dominant?.getValue?.();
      if (d) c[d] = (c[d] || 0) + 1;
    }
    return { c, active };
  };

  const layer = {
    id: "otn",
    name: "Acoustic detections (Ocean Tracking Network)",
    icon: "🐟",
    source:
      "Ocean Tracking Network ERDDAP (CC BY 4.0; per-project citation in the info box)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("otn");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _species = [];
      _visible = {};
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:OTN] Initialized");
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
          _lastError = `otn.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed otn.geojson";
          return false;
        }
        _features = gj.features;
        _species = Array.isArray(gj.species) ? gj.species : [];
        for (const sp of _species) if (!(sp in _visible)) _visible[sp] = true;
        _projects = gj.projects || {};
        _source = gj.source || {};
        _dataEnd = gj.data_end ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:OTN] Updated: ${_features.length} stations, ${_species.length} species, public record to ${_dataEnd}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:OTN] Load error:", e);
        _lastError = `otn.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: each station shows the 7-day bin containing the instant. */
    setObservedTime(iso) {
      if (iso && !Number.isFinite(Date.parse(iso))) return false;
      const next = iso || null;
      if (next === _observed) return true;
      _observed = next;
      rebuild();
      _rowControlsListener?.();
      return true;
    },

    setParams(params = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "boolean" && k in _visible && _visible[k] !== v) {
          _visible[k] = v;
          changed = true;
        }
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
      const { c, active } = activeCounts();
      const chips = _species.map((sp) => ({
        id: sp,
        label: sp.toUpperCase(),
        active: _visible[sp] !== false,
        state: _visible[sp] !== false ? "active" : "idle",
        title: `${_visible[sp] !== false ? "Hide" : "Show"} ${sp}`,
        params: { [sp]: !(_visible[sp] !== false) },
      }));
      const legend = _species
        .filter((sp) => _visible[sp] !== false)
        .map((sp) => ({
          label: sp,
          color: speciesColor(sp, _species),
          count: c[sp] ?? 0,
        }));
      legend.push({
        label:
          _observed === null
            ? `dot = receiver, size = detections in the last ${WINDOW_WEEKS} weeks of the public record (ends ${_dataEnd ?? "?"}; OTN embargo) · ${active} active`
            : `dot = receiver, size = detections in the week of the observed time · faded = none heard · ${active} active`,
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
        .filter((e) => (e.properties?.total?.getValue?.(now) ?? 0) > 0)
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            station: g("station"),
            project: g("project"),
            lat: g("lat"),
            lon: g("lon"),
            detections: g("total"),
            dominant: g("dominant"),
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
        dataEnd: _dataEnd,
        species: _species.length,
        observed: _observed,
        active: activeCounts().active,
      };
    },
  };
  return layer;
}

const otnLayer = createOtnLayer();
export default otnLayer;
