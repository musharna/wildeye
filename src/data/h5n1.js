import * as Cesium from "cesium";
import { extentFromWeekDates, pluck } from "./observedExtent.js";

/**
 * H5N1 sampled spread (site-series contract): one point per place in the Nextstrain
 * avian-flu genome-focused H5N1 builds (the North American cattle outbreak HA build and
 * the D1.1 genome build, both open USDA/NCBI data), from pipeline/h5n1.py. A point is a
 * division centroid where the build has one, else a country centroid, sized by sequenced
 * samples and coloured by the dominant host category. With the shared observed time set,
 * each point shows the 7-day bin containing the instant; live shows the last WINDOW_WEEKS
 * bins of the sampled record, whose end date is stated in the legend because sequences
 * reach the builds weeks after collection. Counts are sequencing effort, not incidence —
 * the info box says so. The GISAID-fed builds are not used (see the pipeline docstring).
 */
const DATA_URL = "data/h5n1.geojson";
export const WINDOW_WEEKS = 13;
const DAY_MS = 86_400_000;
const FADED = 0.2;

export const HOST_COLORS = Object.freeze({
  poultry: "#fb923c",
  "wild bird": "#38bdf8",
  cattle: "#a3e635",
  human: "#f43f5e",
  other: "#94a3b8",
});
export const HOST_LABELS = Object.freeze({
  poultry: "POULTRY",
  "wild bird": "WILD BIRDS",
  cattle: "CATTLE",
  human: "HUMANS",
  other: "OTHER (MAMMALS, INSECTS, UNKNOWN)",
});

export const hostColor = (cat) => HOST_COLORS[cat] || HOST_COLORS.other;

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/**
 * Bins in scope: the single 7-day bin (w−6 d … w] containing `iso`, or (iso null) the
 * newest WINDOW_WEEKS bins of the record ending `dataEnd`. Returns { bins, label }.
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
      : `no sequenced samples in the week of ${iso.slice(0, 10)}`,
  };
}

/** Per-category and per-clade sums over the bins in scope; `visible` hides categories. */
export function sumWeeks(bins, visible = {}) {
  const n = {};
  const c = {};
  for (const b of bins) {
    for (const [k, v] of Object.entries(b.n || {}))
      if (visible[k] !== false) n[k] = (n[k] || 0) + v;
    for (const [k, v] of Object.entries(b.c || {})) c[k] = (c[k] || 0) + v;
  }
  return { n, c, total: Object.values(n).reduce((a, b) => a + b, 0) };
}

export function describePlace(p, scope, sum, source = {}) {
  const rows = Object.entries(sum.n)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(k)}: ${v}`)
    .join(" · ");
  const clades = Object.entries(sum.c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${esc(k)} (${v})`)
    .join(", ");
  const where =
    p.level === "division"
      ? `${esc(p.loc)}, ${esc(p.country)}`
      : `${esc(p.loc)} <small>(${esc(p.level)} centroid; no finer place in the build)</small>`;
  return (
    `<b>${where}</b><br>` +
    `${esc(scope.label)}: ${sum.total} sequenced H5N1 sample${sum.total === 1 ? "" : "s"}<br>` +
    (rows ? `${rows}<br>` : "") +
    (clades ? `GenoFLU genotype: ${clades}<br>` : "") +
    `${p.n ?? 0} sample${p.n === 1 ? "" : "s"} here in the file's window<br>` +
    `<small>Coverage is the United States only: the open USDA / NCBI builds (cattle-outbreak B3.13 and D1.1). Counts follow surveillance and sequencing effort (herd testing, outbreak response, wild-bird sampling), not infection rates. Aggregated counts only.</small><br>` +
    `<a href="${esc(source.url || "https://nextstrain.org/avian-flu")}" target="_blank" rel="noopener">${esc(source.name || "Nextstrain avian-flu")}</a> · data: USDA / NCBI GenBank (public domain)`
  );
}

/** Entity options for one place at the observed instant (index-based id: names may repeat across countries). */
export function placeEntity(f, index, iso, ctx) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const scope = binsAt(p.weeks, iso, ctx.dataEnd);
  const sum = sumWeeks(scope.bins, ctx.visible);
  const dominant =
    Object.entries(sum.n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const alpha = sum.total > 0 ? 1 : FADED;
  const color = Cesium.Color.fromCssColorString(
    dominant ? hostColor(dominant) : "#9ca3af",
  ).withAlpha(alpha);
  return {
    id: `h5n1:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 6 + Math.min(16, 4 * Math.log10(sum.total + 1)),
      color,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.7 * alpha),
      outlineWidth: 1,
      disableDepthTestDistance: 50_000,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describePlace(p, scope, sum, ctx.source),
    properties: {
      loc: p.loc,
      level: p.level,
      country: p.country,
      lat,
      lon,
      total: sum.total,
      dominant,
      scope: scope.label,
      kind: "h5n1-place",
    },
  };
}

export function createH5n1Layer() {
  let _dataSource = null;
  let _features = [];
  let _categories = [];
  let _visible = {};
  let _source = {};
  let _dataEnd = null;
  let _genotypes = [];
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const ctx = () => ({ dataEnd: _dataEnd, visible: _visible, source: _source });
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    _features.forEach((f, i) => es.add(placeEntity(f, i, _observed, ctx())));
    es.resumeEvents();
  };
  /** Places with ≥1 sample in scope, per dominant category (legend counts). */
  const activeCounts = () => {
    const c = {};
    let active = 0;
    for (const e of _dataSource?.entities.values || []) {
      if ((e.properties?.total?.getValue?.() ?? 0) <= 0) continue;
      active++;
      const d = e.properties?.dominant?.getValue?.();
      if (d) c[d] = (c[d] || 0) + 1;
    }
    return { c, active };
  };

  const layer = {
    id: "h5n1",
    name: "H5N1 sampled spread (Nextstrain)",
    icon: "🧬",
    source:
      "Nextstrain avian-flu H5N1 genome-focused builds (USDA / NCBI GenBank data, public domain); aggregated counts only",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("h5n1");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _categories = [];
      _visible = {};
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:H5N1] Initialized");
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
          _lastError = `h5n1.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed h5n1.geojson";
          return false;
        }
        _features = gj.features;
        const present = new Set(
          _features.flatMap((f) => Object.keys(f.properties?.hosts || {})),
        );
        const order = Array.isArray(gj.categories)
          ? gj.categories
          : Object.keys(HOST_COLORS);
        _categories = order.filter((k) => present.has(k));
        for (const k of _categories) if (!(k in _visible)) _visible[k] = true;
        _source = gj.source || {};
        _dataEnd = gj.data_end ?? null;
        _genotypes = Array.isArray(gj.clades) ? gj.clades : [];
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:H5N1] Updated: ${_features.length} places, sampled record to ${_dataEnd}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:H5N1] Load error:", e);
        _lastError = `h5n1.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: each place shows the 7-day bin containing the instant. */
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
      const chips = _categories.map((k) => ({
        id: k,
        label: HOST_LABELS[k] || k.toUpperCase(),
        active: _visible[k] !== false,
        state: _visible[k] !== false ? "active" : "idle",
        title: `${_visible[k] !== false ? "Hide" : "Show"} ${k}`,
        params: { [k]: !(_visible[k] !== false) },
      }));
      const legend = _categories
        .filter((k) => _visible[k] !== false)
        .map((k) => ({ label: k, color: hostColor(k), count: c[k] ?? 0 }));
      legend.push({
        label:
          _observed === null
            ? `US only (open USDA/NCBI builds), genotypes ${_genotypes.join(", ") || "?"} · dot = place, size = sequenced H5N1 samples in the last ${WINDOW_WEEKS} weeks of the record (ends ${_dataEnd ?? "?"}; sequences lag collection) · colour = main host · ${active} active; follows sequencing effort`
            : `US only, genotypes ${_genotypes.join(", ") || "?"} · dot = place, size = sequenced samples collected in the week of the observed time (record ends ${_dataEnd ?? "?"}) · faded = none · ${active} active`,
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
            loc: g("loc"),
            level: g("level"),
            country: g("country"),
            lat: g("lat"),
            lon: g("lon"),
            samples: g("total"),
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
        categories: _categories.length,
        observed: _observed,
        active: activeCounts().active,
      };
    },
  };
  return layer;
}

const h5n1Layer = createH5n1Layer();
export default h5n1Layer;
