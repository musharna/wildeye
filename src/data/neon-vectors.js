import * as Cesium from "cesium";

/**
 * NEON ticks + mosquitoes (site-series contract, clone of neon.js): one point per NEON site
 * and per vector kind, from pipeline/neon_vectors.py (NSF NEON DP1.10093.001 drag-cloth
 * ticks and DP1.10043.001 CO2-trap mosquitoes, CC BY 4.0). Ticks draw as a filled amber
 * dot sized by ticks per 1000 m² dragged; mosquitoes as a teal ring sized by mosquitoes per
 * trap-night (24 trap-hours). Each site carries one monthly series per kind; with the
 * shared observed time set a site shows the calendar month containing the instant, live it
 * shows its newest month with effort. Months whose lab identification is still pending are
 * drawn faded (effort known, count unknown). Sites are compared with their own history only.
 */
const DATA_URL = "data/neon-vectors.geojson";
const FADED = 0.2;
export const KINDS = {
  ticks: { label: "ticks", color: "#ffb74d", unit: "per 1000 m² dragged" },
  mosquitoes: { label: "mosquitoes", color: "#4dd0e1", unit: "per trap-night" },
};

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** The month bin in scope: the calendar month containing `iso`, or (iso null) the newest bin with a lab count —
 * lab identification lags fieldwork by months, so the newest bin is usually pending (live run 2026-09-12: 75 of 93
 * newest bins pending); falls back to the newest pending bin when no month has been identified yet. */
export function monthAt(months, iso, what = "sampling") {
  const list = months || [];
  if (!iso) {
    const counted = list.find((b) => !b.pending);
    if (counted)
      return { bin: counted, label: `latest identified ${what}, ${counted.m}` };
    return list.length
      ? { bin: list[0], label: `latest ${what}, ${list[0].m}` }
      : { bin: null, label: `no ${what}` };
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { bin: null, label: "invalid time" };
  const key = new Date(t).toISOString().slice(0, 7);
  const bin = list.find((b) => b.m === key) || null;
  return { bin, label: bin ? `${what} in ${key}` : `no ${what} in ${key}` };
}

/** Rate for a bin (null when pending) and the effort phrase. */
export function binRate(kind, b) {
  if (!b) return { rate: null, effort: "" };
  if (kind === "ticks")
    return {
      rate: b.per1000,
      effort: `${b.drags} drag${b.drags === 1 ? "" : "s"} over ${b.area_m2} m²`,
    };
  return {
    rate: b.per_trapnight,
    effort: `${b.traps} trap${b.traps === 1 ? "" : "s"}, ${b.trap_hours} trap-hours`,
  };
}

const breakdown = (obj, italic) =>
  Object.entries(obj || {})
    .sort((a, c) => c[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => (italic ? `<i>${esc(k)}</i>: ${v}` : `${esc(k)}: ${v}`))
    .join(" · ");

export function describeSite(p, kind, scope, source = {}) {
  const b = scope.bin;
  const K = KINDS[kind];
  const { rate, effort } = binRate(kind, b);
  let line = `${esc(scope.label)}<br>`;
  if (b && b.pending)
    line = `${esc(scope.label)}: ${effort} · <b>identification pending</b> at the lab${b.release === "PROVISIONAL" ? " · provisional" : ""}<br>`;
  else if (b)
    line = `${esc(scope.label)}: ${b.count} ${K.label} in ${effort} = <b>${rate ?? "?"}</b> ${K.unit}${b.release === "PROVISIONAL" ? " · provisional" : ""}<br>`;
  const stages = b && kind === "ticks" ? breakdown(b.stages, false) : "";
  const genera = b ? breakdown(b.genera, true) : "";
  const url =
    kind === "ticks" ? source.url : source.url_mosquitoes || source.url;
  return (
    `<b>${esc(p.name)}</b> (${esc(p.site)}, ${esc(p.site_type || "site")}) · ${K.label}<br>` +
    line +
    (stages ? `life stages — ${stages}<br>` : "") +
    (genera ? `genera — ${genera}<br>` : "") +
    `<small>Compared with this site's own history only; habitats and effort differ between sites.${kind === "mosquitoes" ? " Count = identified × 1/proportion sorted; one trap-night = 24 trap-hours." : ""}</small><br>` +
    `<a href="${esc(url || "https://data.neonscience.org")}" target="_blank" rel="noopener">${esc(source.name || "NSF NEON")}</a> · ${esc(source.licence || "CC BY 4.0")}`
  );
}

export function siteEntity(f, index, kind, iso, ctx) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const scope = monthAt(p[kind], iso, kind === "ticks" ? "drags" : "trapping");
  const b = scope.bin;
  const shown = ctx.visible[kind] !== false;
  const active = shown && !!b && !b.pending;
  const alpha = active ? 1 : FADED;
  const { rate } = binRate(kind, b);
  const r = active ? (rate ?? 0) : 0;
  const css = KINDS[kind].color;
  const base = Cesium.Color.fromCssColorString(css);
  const ring = kind === "mosquitoes";
  return {
    id: `nv:${kind}:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    show: shown && !!b,
    point: {
      pixelSize: (ring ? 10 : 6) + Math.min(14, 4 * Math.log10(r + 1)),
      color: ring ? base.withAlpha(0.15 * alpha) : base.withAlpha(alpha),
      outlineColor: ring
        ? base.withAlpha(alpha)
        : Cesium.Color.BLACK.withAlpha(0.7 * alpha),
      outlineWidth: ring ? 2 : 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describeSite(p, kind, scope, ctx.source),
    properties: {
      site: p.site,
      name: p.name,
      lat,
      lon,
      kind,
      month: b?.m ?? null,
      rate: active ? rate : null,
      count: active ? b.count : null,
      pending: !!b?.pending,
      active,
      layer: "neon-vectors",
    },
  };
}

export function createNeonVectorsLayer() {
  let _dataSource = null;
  let _features = [];
  let _visible = { ticks: true, mosquitoes: true };
  let _source = {};
  let _months = {};
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const ctx = () => ({ visible: _visible, source: _source });
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    _features.forEach((f, i) => {
      for (const kind of Object.keys(KINDS))
        if ((f.properties?.[kind] || []).length)
          es.add(siteEntity(f, i, kind, _observed, ctx()));
    });
    es.resumeEvents();
  };
  const activeCounts = () => {
    const c = { ticks: 0, mosquitoes: 0 };
    let active = 0;
    for (const e of _dataSource?.entities.values || []) {
      if (!e.properties?.active?.getValue?.()) continue;
      active++;
      c[e.properties.kind.getValue()]++;
    }
    return { c, active };
  };

  const layer = {
    id: "neon-vectors",
    name: "Ticks and mosquitoes (NEON)",
    icon: "🪳",
    source:
      "NSF NEON ticks DP1.10093.001 + mosquitoes DP1.10043.001 (CC BY 4.0)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("neon-vectors");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:NEONVectors] Initialized");
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
          _lastError = `neon-vectors.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed neon-vectors.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _months = gj.months || {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:NEONVectors] Updated: ${_features.length} sites, ${_dataSource?.entities.values.length ?? 0} marks`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:NEONVectors] Load error:", e);
        _lastError = `neon-vectors.geojson load error: ${e?.message || e}`;
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
      const chips = Object.entries(KINDS).map(([k, K]) => ({
        id: k,
        label: K.label.toUpperCase(),
        active: _visible[k] !== false,
        state: _visible[k] !== false ? "active" : "idle",
        title: `${_visible[k] !== false ? "Hide" : "Show"} ${K.label}`,
        params: { [k]: !(_visible[k] !== false) },
      }));
      const legend = Object.entries(KINDS)
        .filter(([k]) => _visible[k] !== false)
        .map(([k, K]) => ({
          label: `${K.label} ${K.unit}${_months[k]?.length ? `, newest month ${_months[k][0]}` : ""}`,
          color: K.color,
          count: c[k] ?? 0,
        }));
      legend.push({
        label:
          _observed === null
            ? `dot = ticks, ring = mosquitoes at a NEON site, size = rate in its latest identified month · faded = no month identified by the lab yet · ${active} marks`
            : `dot = ticks, ring = mosquitoes at a NEON site, size = rate in the month of the observed time · faded = pending · ${active} marks`,
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
            kind: g("kind"),
            month: g("month"),
            rate: g("rate"),
            count: g("count"),
          };
        });
    },

    getStats() {
      return {
        count: _features.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        observed: _observed,
        months: _months,
        active: activeCounts().active,
      };
    },
  };
  return layer;
}

const neonVectorsLayer = createNeonVectorsLayer();
export default neonVectorsLayer;
