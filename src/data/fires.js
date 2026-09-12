import * as Cesium from "cesium";

/**
 * Active fires, gridded (point contract, dated): one point per 0.5° cell with at least the
 * file's FRP floor of VIIRS 375 m detections in the last 7 days, from pipeline/fires.py (NASA
 * FIRMS, full and open sharing, cite "NASA FIRMS"). Each cell carries a 6-hour bin series
 * [[k, n, frp], …] where k indexes from the file's `bin0`. Colour = summed fire radiative power
 * (MW) in scope: with the shared observed time set, the 6-hour bin containing the instant; live,
 * the bins starting within LIVE_HOURS of the newest bin's end. Detections are thermal anomalies
 * at overpass time (volcanoes, gas flares and hot rooftops included), not fire perimeters, and
 * the info box says so. Distinct from the browser-side `local-firms` heatmap, which streams the
 * live area API through a keyed proxy.
 */
const DATA_URL = "data/fires.geojson";
const HOUR_MS = 3_600_000;
export const LIVE_HOURS = 24;

export const FRP_CLASSES = Object.freeze([
  { key: "small", label: "< 10 MW", color: "#fde047", test: (f) => f < 10 },
  {
    key: "moderate",
    label: "10 – 50 MW",
    color: "#f97316",
    test: (f) => f < 50,
  },
  {
    key: "large",
    label: "50 – 250 MW",
    color: "#dc2626",
    test: (f) => f < 250,
  },
  { key: "intense", label: "250+ MW", color: "#7f1d1d", test: () => true },
]);
export const NO_DATA = Object.freeze({
  key: "none",
  label: "no detections in scope",
  color: "#6b7280",
});

export function frpClass(frp) {
  if (!Number.isFinite(frp) || frp <= 0) return NO_DATA;
  return FRP_CLASSES.find((c) => c.test(frp));
}

/** File-level bin geometry {bin0Ms, binMs, newestMs, latestMs} from the GeoJSON header; null when malformed (latestMs may be null). */
export function binGeometry(gj) {
  const bin0Ms = Date.parse(gj?.bin0 ?? "");
  const binMs = Number(gj?.bin_hours) * HOUR_MS;
  const newestMs = Date.parse(gj?.newest ?? "");
  if (![bin0Ms, binMs, newestMs].every(Number.isFinite) || binMs <= 0)
    return null;
  const latest = Date.parse(gj?.latest ?? "");
  return {
    bin0Ms,
    binMs,
    newestMs,
    latestMs: Number.isFinite(latest) ? latest : null,
  };
}

const isoOf = (ms) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

/**
 * Bins in scope: the 6-hour bin containing `iso`, or (iso null) every bin whose start is
 * within LIVE_HOURS of the file's newest bin end (the newest bin is still filling, so the
 * label names the latest detection rather than the bin end). Returns { bins, label }.
 */
export function binsAt(bins, iso, geom) {
  if (!geom) return { bins: [], label: "no bin geometry" };
  const list = bins || [];
  if (!iso) {
    const cutoff = geom.newestMs - LIVE_HOURS * HOUR_MS;
    return {
      bins: list.filter((b) => geom.bin0Ms + b[0] * geom.binMs >= cutoff),
      label: `6-h bins since ${isoOf(cutoff)} (latest detection ${geom.latestMs === null ? "?" : isoOf(geom.latestMs)})`,
    };
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { bins: [], label: "invalid time" };
  const k = Math.floor((t - geom.bin0Ms) / geom.binMs);
  const hit = list.filter((b) => b[0] === k);
  const start = geom.bin0Ms + k * geom.binMs;
  return {
    bins: hit,
    label: hit.length
      ? `6 h from ${isoOf(start)}`
      : `no detections in the 6 h from ${isoOf(start)}`,
  };
}

export function sumBins(bins) {
  let n = 0,
    frp = 0;
  for (const b of bins) {
    n += b[1] || 0;
    frp += b[2] || 0;
  }
  return { n, frp };
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const fmt = (x) => (x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString());

export function describeCell(p, lon, lat, scope, sum, source = {}) {
  const cellDeg = Number(source.cell_deg) || 0.5;
  return (
    `<b>Fire cell ${lat.toFixed(2)}, ${lon.toFixed(2)}</b> (${cellDeg}° square)<br>` +
    `${esc(scope.label)}: ${sum.n} detection${sum.n === 1 ? "" : "s"}, <b>${fmt(sum.frp)}</b> MW fire radiative power<br>` +
    `${Number(p.n || 0).toLocaleString()} detections, ${fmt(Number(p.frp || 0))} MW in the file's ${esc(source.days ?? 7)}-day window (peak 6-h bin ${fmt(Number(p.frp_max_bin || 0))} MW)<br>` +
    `<small>VIIRS 375 m thermal anomalies at overpass time — volcanoes, gas flares and hot rooftops included; not fire perimeters; clouds hide fires. Low-confidence pixels dropped.</small><br>` +
    `<a href="${esc(source.url || "https://firms.modaps.eosdis.nasa.gov/")}" target="_blank" rel="noopener">${esc(source.citation || "NASA FIRMS")}</a> · ${esc(source.licence || "NASA full and open sharing")}`
  );
}

/** Entity options for one cell at the observed instant (index-based id: cells are unique by construction). */
export function cellEntity(f, index, observedIso, ctx) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const scope = binsAt(p.bins, observedIso, ctx.geom);
  const sum = sumBins(scope.bins);
  const cls = frpClass(sum.frp);
  const active = sum.n > 0;
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(
    active ? 0.9 : 0.12,
  );
  return {
    id: `fires:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: active ? 4 + Math.min(10, 3 * Math.log10(sum.n + 1)) : 3,
      color,
      outlineColor: Cesium.Color.BLACK.withAlpha(active ? 0.6 : 0.1),
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.4, 1.5e7, 0.5),
    },
    description: describeCell(p, lon, lat, scope, sum, ctx.source),
    properties: {
      lat,
      lon,
      n: sum.n,
      frp: sum.frp,
      cls: cls.key,
      scope: scope.label,
      kind: "fire-cell",
    },
  };
}

export function createFiresLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _geom = null;
  let _newest = null;
  let _latest = null;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const ctx = () => ({ geom: _geom, source: _source });
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    _features.forEach((f, i) => es.add(cellEntity(f, i, _observed, ctx())));
    es.resumeEvents();
  };
  const classCounts = () => {
    const c = {};
    for (const e of _dataSource?.entities.values || []) {
      const k = e.properties?.cls?.getValue?.() ?? "none";
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  };

  const layer = {
    id: "fires",
    name: "Active fires (NASA FIRMS VIIRS)",
    icon: "🔥",
    source:
      'NASA FIRMS VIIRS 375 m active fires, Suomi-NPP + NOAA-20 + NOAA-21 (NASA full and open sharing; cite "NASA FIRMS")',
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("fires");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Fires] Initialized");
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
          _lastError = `fires.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed fires.geojson";
          return false;
        }
        const geom = binGeometry(gj);
        if (!geom) {
          _lastError = "fires.geojson lacks bin0/bin_hours/newest";
          return false;
        }
        _features = gj.features;
        _source = { ...(gj.source || {}), days: gj.days };
        _geom = geom;
        _newest = gj.newest ?? null;
        _latest = gj.latest ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Fires] Updated: ${_features.length} cells, latest detection ${_latest}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Fires] Load error:", e);
        _lastError = `fires.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: colour each cell by the 6-hour bin containing the instant. */
    setObservedTime(iso) {
      if (iso && !Number.isFinite(Date.parse(iso))) return false;
      const next = iso || null;
      if (next === _observed) return true;
      _observed = next;
      rebuild();
      _rowControlsListener?.();
      return true;
    },

    getRowControls() {
      const counts = classCounts();
      const legend = [...FRP_CLASSES, NO_DATA].map((c) => ({
        label: c.label,
        color: c.color,
        count: counts[c.key] ?? 0,
      }));
      const deg = Number(_source.cell_deg) || 0.5;
      legend.push({
        label:
          _observed === null
            ? `dot = ${deg}° cell, colour = fire radiative power in the last ${LIVE_HOURS} h of 6-h bins (latest detection ${_latest ?? "?"}); thermal anomalies, not perimeters`
            : `dot = ${deg}° cell, colour = fire radiative power in the 6-hour bin of the observed time; faded = none detected; thermal anomalies, not perimeters`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      return _dataSource.entities.values
        .filter((e) => (e.properties?.n?.getValue?.(now) ?? 0) > 0)
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            lat: g("lat"),
            lon: g("lon"),
            detections: g("n"),
            frp: g("frp"),
            cls: g("cls"),
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
        newest: _newest,
        latest: _latest,
        observed: _observed,
        classes: classCounts(),
      };
    },
  };
  return layer;
}

const firesLayer = createFiresLayer();
export default firesLayer;
