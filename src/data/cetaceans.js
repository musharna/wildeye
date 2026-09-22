import * as Cesium from "cesium";
import { extentFromWeekDates, pluck } from "./observedExtent.js";

/**
 * Whale detections from NOAA passive acoustics (site-series contract): one point per
 * recording station (a fixed mooring/buoy site, or a glider/drifting deployment placed at
 * the mean of its in-window positions) from pipeline/cetaceans.py (NOAA NEFSC Passive
 * Acoustic Cetacean Map, U.S. Government public domain). Each station carries weekly bins
 * of DAYS WITH A DETECTION per species (not calls, not animals), days the analysts marked
 * "possible", and days analysed at all — so "nothing heard" is distinguishable from
 * "no recorder". With the shared observed time set, a station shows the 7-day bin
 * containing the instant; live shows the last WINDOW_WEEKS bins of the public record,
 * whose end date is stated in the legend because PACM's public files lag months behind.
 */
const DATA_URL = "data/cetaceans.geojson";
export const WINDOW_WEEKS = 13;
const DAY_MS = 86_400_000;
const FADED = 0.2;

const PALETTE = [
  "#ef5350",
  "#4fc3f7",
  "#aed581",
  "#ffb74d",
  "#7986cb",
  "#a1887f",
  "#f06292",
  "#fff176",
  "#80cbc4",
  "#b0bec5",
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

/** Sum detection days (n), possible days (m) and analysed days (e) over the bins in scope; `visible` filters species. */
export function sumWeeks(bins, visible = {}) {
  const n = {};
  const m = {};
  let effort = 0;
  for (const b of bins) {
    for (const [sp, c] of Object.entries(b.n || {}))
      if (visible[sp] !== false) n[sp] = (n[sp] || 0) + c;
    for (const [sp, c] of Object.entries(b.m || {}))
      if (visible[sp] !== false) m[sp] = (m[sp] || 0) + c;
    effort += b.e || 0;
  }
  return {
    n,
    m,
    total: Object.values(n).reduce((a, b) => a + b, 0),
    possible: Object.values(m).reduce((a, b) => a + b, 0),
    effort,
  };
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
      : `no analysed recordings in the week of ${iso.slice(0, 10)}`,
  };
}

const PLATFORM_TEXT = (s) =>
  String(s || "recorder")
    .toLowerCase()
    .replace(/_/g, " ");

export function describeStation(p, scope, sum, orgName = "", source = {}) {
  const rows = Object.entries(sum.n)
    .sort((a, b) => b[1] - a[1])
    .map(([sp, c]) => `${esc(sp)}: ${c} day${c === 1 ? "" : "s"}`)
    .join("<br>");
  const maybe = Object.entries(sum.m)
    .sort((a, b) => b[1] - a[1])
    .map(([sp, c]) => `${esc(sp)} ${c}`)
    .join(", ");
  const qc = (p.qc || []).map((q) => PLATFORM_TEXT(q)).join(", ");
  return (
    `<b>${esc(p.station || "(unnamed)")}</b> · ${esc(orgName || p.org)}<br>` +
    `${esc(PLATFORM_TEXT(p.platform))}${p.mobile ? " (mobile; placed at its mean position)" : ""}${qc ? ` · ${esc(qc)}` : ""}<br>` +
    `${esc(scope.label)}: ${sum.total} species-day${sum.total === 1 ? "" : "s"} with detections over ${sum.effort} analysed day${sum.effort === 1 ? "" : "s"} <small>(a day heard for two species counts twice)</small><br>` +
    (rows ? `${rows}<br>` : "") +
    (maybe ? `possible: ${maybe}<br>` : "") +
    `<small>Counts are days with an acoustic detection at this recorder, not calls or animals; coverage follows where recorders were deployed.</small><br>` +
    (source.citation ? `<small>${esc(source.citation)}</small><br>` : "") +
    `<a href="${esc(source.url || "https://passiveacoustics.fisheries.noaa.gov/pacm/")}" target="_blank" rel="noopener">${esc(source.name || "NOAA Passive Acoustic Cetacean Map")}</a> · ${esc(source.licence || "Public Domain U.S. Government")}`
  );
}

/** Entity options for one station at the observed instant (index-based id). */
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
    id: `cetaceans:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 5 + Math.min(14, 6 * Math.log10(sum.total + 1)),
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
      ctx.organizations?.[p.org],
      ctx.source,
    ),
    properties: {
      station: p.station,
      org: p.org,
      platform: p.platform,
      lat,
      lon,
      total: sum.total,
      possible: sum.possible,
      effort: sum.effort,
      dominant,
      scope: scope.label,
      kind: "cetacean-station",
    },
  };
}

export function createCetaceansLayer() {
  let _dataSource = null;
  let _features = [];
  let _species = [];
  let _visible = {};
  let _organizations = {};
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
    organizations: _organizations,
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
  /** Stations with ≥1 detection day in scope, per dominant species (legend counts). */
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
    id: "cetaceans",
    name: "Whale detections (NOAA passive acoustics)",
    icon: "🐋",
    source:
      "NOAA NEFSC Passive Acoustic Cetacean Map (Public Domain U.S. Government; PACM + contributor citation in the info box)",
    updateInterval: 24 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("cetaceans");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _species = [];
      _visible = {};
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Cetaceans] Initialized");
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
          _lastError = `cetaceans.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed cetaceans.geojson";
          return false;
        }
        _features = gj.features;
        _species = Array.isArray(gj.species) ? gj.species : [];
        for (const sp of _species) if (!(sp in _visible)) _visible[sp] = true;
        _organizations = gj.organizations || {};
        _source = gj.source || {};
        _dataEnd = gj.data_end ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Cetaceans] Updated: ${_features.length} stations, ${_species.length} species, public record to ${_dataEnd}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Cetaceans] Load error:", e);
        _lastError = `cetaceans.geojson load error: ${e?.message || e}`;
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
            ? `dot = recorder, size = species-days with detections in the last ${WINDOW_WEEKS} weeks of the public record (ends ${_dataEnd ?? "?"}; NOAA PACM lags months) · faded = analysed, none heard · ${active} active`
            : `dot = recorder, size = species-days with detections in the week of the observed time · faded = none heard · ${active} active`,
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
            org: g("org"),
            platform: g("platform"),
            lat: g("lat"),
            lon: g("lon"),
            speciesDetectionDays: g("total"),
            analysedDays: g("effort"),
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

const cetaceansLayer = createCetaceansLayer();
export default cetaceansLayer;
