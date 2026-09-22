import * as Cesium from "cesium";
import { extentFromMonths, pluck } from "./observedExtent.js";

/**
 * NEON small-mammal trapping (site-series contract): one point per NEON site, sized
 * by captures per 100 trap-nights and coloured by the dominant species, from
 * pipeline/neon.py (NSF NEON, CC BY 4.0). Each site carries a monthly series; with the
 * shared observed time set, a site shows the calendar month containing the instant,
 * live it shows its newest month with effort. Sites are compared with their own history
 * only — habitats and effort differ, so nothing ranks sites against each other.
 */
const DATA_URL = "data/neon.geojson";
const FADED = 0.2;
const PALETTE = [
  "#ffb74d",
  "#4fc3f7",
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

/** The month bin in scope: the calendar month containing `iso`, or (iso null) the newest bin. */
export function monthAt(months, iso) {
  const list = months || [];
  if (!iso)
    return list.length
      ? { bin: list[0], label: `latest bout, ${list[0].m}` }
      : { bin: null, label: "no data" };
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { bin: null, label: "invalid time" };
  const key = new Date(t).toISOString().slice(0, 7);
  const bin = list.find((b) => b.m === key) || null;
  return { bin, label: bin ? `bout in ${key}` : `no trapping in ${key}` };
}

export function describeSite(p, scope, source = {}) {
  const b = scope.bin;
  const rows = b
    ? Object.entries(b.species)
        .sort((a, c) => c[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `<i>${esc(k)}</i>: ${v}`)
        .join(" · ")
    : "";
  return (
    `<b>${esc(p.name)}</b> (${esc(p.site)}, ${esc(p.site_type || "site")})<br>` +
    (b
      ? `${esc(scope.label)}: ${b.captures} capture${b.captures === 1 ? "" : "s"} in ${b.trapnights} trap-nights = <b>${b.per100 ?? "?"}</b> per 100 · ${b.individuals} tagged individual${b.individuals === 1 ? "" : "s"}${b.release === "PROVISIONAL" ? " · provisional" : ""}<br>`
      : `${esc(scope.label)}<br>`) +
    (rows ? `${rows}<br>` : "") +
    `<small>Compared with this site's own history only; habitats and effort differ between sites.</small><br>` +
    `<a href="${esc(source.url || "https://data.neonscience.org")}" target="_blank" rel="noopener">${esc(source.name || "NSF NEON")}</a> · ${esc(source.licence || "CC BY 4.0")}`
  );
}

export function siteEntity(f, index, iso, ctx) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const scope = monthAt(p.months, iso);
  const b = scope.bin;
  const visibleSpecies = b
    ? Object.entries(b.species).filter(([k]) => ctx.visible[k] !== false)
    : [];
  const dominant = visibleSpecies.sort((a, c) => c[1] - a[1])[0]?.[0] ?? null;
  const active = !!b && visibleSpecies.length > 0;
  const alpha = active ? 1 : FADED;
  const css = dominant ? speciesColor(dominant, ctx.species) : "#9ca3af";
  const color = Cesium.Color.fromCssColorString(css).withAlpha(alpha);
  const per100 = active ? (b.per100 ?? 0) : 0;
  return {
    id: `neon:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 6 + Math.min(14, 4 * Math.log10(per100 + 1)),
      color,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.7 * alpha),
      outlineWidth: 1,
      disableDepthTestDistance: 50_000,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describeSite(p, scope, ctx.source),
    properties: {
      site: p.site,
      name: p.name,
      lat,
      lon,
      month: b?.m ?? null,
      per100: active ? b.per100 : null,
      captures: active ? b.captures : 0,
      dominant,
      active,
      kind: "neon-site",
    },
  };
}

export function createNeonLayer() {
  let _dataSource = null;
  let _features = [];
  let _species = [];
  let _visible = {};
  let _source = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const ctx = () => ({ visible: _visible, species: _species, source: _source });
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    _features.forEach((f, i) => es.add(siteEntity(f, i, _observed, ctx())));
    es.resumeEvents();
  };
  const activeCounts = () => {
    const c = {};
    let active = 0;
    for (const e of _dataSource?.entities.values || []) {
      if (!e.properties?.active?.getValue?.()) continue;
      active++;
      const d = e.properties?.dominant?.getValue?.();
      if (d) c[d] = (c[d] || 0) + 1;
    }
    return { c, active };
  };

  const layer = {
    id: "neon",
    name: "Small mammals at NEON sites",
    icon: "🐭",
    source: "NSF NEON small mammal box trapping DP1.10072.001 (CC BY 4.0)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("neon");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _species = [];
      _visible = {};
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:NEON] Initialized");
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
          _lastError = `neon.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed neon.geojson";
          return false;
        }
        _features = gj.features;
        const tally = {};
        for (const f of _features)
          for (const [k, v] of Object.entries(f.properties?.species || {}))
            tally[k] = (tally[k] || 0) + v;
        _species = Object.entries(tally)
          .sort((a, b) => b[1] - a[1])
          .map(([k]) => k);
        for (const sp of _species) if (!(sp in _visible)) _visible[sp] = true;
        _source = gj.source || {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:NEON] Updated: ${_features.length} sites, ${_species.length} species`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:NEON] Load error:", e);
        _lastError = `neon.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: each site shows the calendar month containing the instant. */
    /**
     * Shared observed-time hook: the span this layer can serve, read off the months it holds.
     * The bar's domain is the union of these across enabled layers (src/observedTime.js).
     */
    getObservedExtent() {
      return extentFromMonths(pluck(_features, "months", "m"));
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
      const top = _species.slice(0, 8); // chips for the eight commonest species; the rest stay visible
      const chips = top.map((sp) => ({
        id: sp,
        label: sp.toUpperCase(),
        active: _visible[sp] !== false,
        state: _visible[sp] !== false ? "active" : "idle",
        title: `${_visible[sp] !== false ? "Hide" : "Show"} ${sp}`,
        params: { [sp]: !(_visible[sp] !== false) },
      }));
      const legend = top
        .filter((sp) => _visible[sp] !== false)
        .map((sp) => ({
          label: sp,
          color: speciesColor(sp, _species),
          count: c[sp] ?? 0,
        }));
      legend.push({
        label:
          _observed === null
            ? `dot = NEON site, size = captures per 100 trap-nights in its latest bout, colour = commonest species · ${active} sites`
            : `dot = NEON site, size = captures per 100 trap-nights in the month of the observed time · faded = no trapping · ${active} sites`,
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
        .filter((e) => e.properties?.active?.getValue?.(now))
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            site: g("site"),
            name: g("name"),
            lat: g("lat"),
            lon: g("lon"),
            month: g("month"),
            per100: g("per100"),
            captures: g("captures"),
            dominant: g("dominant"),
          };
        });
    },

    getStats() {
      return {
        count: _features.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        species: _species.length,
        observed: _observed,
        active: activeCounts().active,
      };
    },
  };
  return layer;
}

const neonLayer = createNeonLayer();
export default neonLayer;
