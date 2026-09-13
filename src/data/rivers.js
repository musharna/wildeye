import * as Cesium from "cesium";

/**
 * USGS river temperature and flow (site-series contract): one point per stream gage,
 * coloured by the daily-mean water temperature class (fish thermal-stress bands) and
 * sized by daily-mean discharge, from pipeline/rivers.py (USGS Water Data OGC API `daily`
 * collection, U.S. public domain). Each gage carries a 30-day daily series (`d0`, `t[]`, `q[]`
 * aligned per day, null = no value; days are the gage's local calendar days); with the shared
 * observed time set a gage shows the day whose date matches the instant's UTC date, live it
 * shows its newest day with a temperature. Values are provisional and subject to USGS revision.
 */
const DATA_URL = "data/rivers.geojson";
const DAY_MS = 86_400_000;
const FADED = 0.2;

/** Daily-mean water temperature classes (°C), labelled against EPA Region 10 (2003) "Guidance for
 *  Pacific Northwest State and Tribal Temperature Water Quality Standards", Table 1 (salmon and
 *  trout), read 2026-09-12: juvenile "Rearing Preference Temp." 10–17 °C (constant) / < 18 °C (7DADM);
 *  "Disease Risk … High > 18 - 20°C (constant)"; adult "Lethal Temp. (1 Week Exposure) 21- 22°C
 *  (constant)" and "Migration Blockage and Migration Delay 21 - 22°C (average)"; juvenile "Lethal
 *  Temp. (1 Week Exposure) 23 - 26°C (constant)". Those are constant-exposure values; a daily
 *  mean is not a constant exposure, so the bands are context, not a mortality call. */
export const TEMP_CLASSES = [
  { key: "cold", label: "< 10 °C cold", max: 10, color: "#4fc3f7" },
  {
    key: "cool",
    label: "10–18 °C salmonid rearing range",
    max: 18,
    color: "#81c784",
  },
  {
    key: "warm",
    label: "18–22 °C salmonid stress (high disease risk)",
    max: 22,
    color: "#fff176",
  },
  {
    key: "hot",
    label: "22–25 °C above adult salmonid lethal / migration-blockage 21–22 °C",
    max: 25,
    color: "#ff8a65",
  },
  {
    key: "lethal",
    label: "> 25 °C in juvenile salmonid 1-week lethal range 23–26 °C",
    max: Infinity,
    color: "#e53935",
  },
];
export const NO_DATA = {
  key: "none",
  label: "no temperature that day",
  color: "#9ca3af",
};

/** A daily mean that departs by more than SPIKE_C °C from the median of up to three valid days on each
 *  side is a suspect reading (sensor out of water, logger fault), not a real temperature: river daily
 *  means move a few °C a day. A fixed ceiling cannot do this job — Boiling River (YNP) really is 52 °C,
 *  while the St. Louis River near Skibo, MN read 17.8 → 41.0 → 16.8 on 2026-09-10 (live data). */
export const SPIKE_C = 8;
export const SUSPECT = {
  key: "suspect",
  label: "suspect reading (spike vs neighbouring days)",
  color: "#a78bfa",
};

export function isSpike(series, i) {
  const v = series?.[i];
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const nb = [...series.slice(Math.max(0, i - 3), i), ...series.slice(i + 1, i + 4)].filter(
    (x) => typeof x === "number" && Number.isFinite(x),
  );
  if (nb.length < 2) return false;
  const s = nb.sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.abs(v - median) > SPIKE_C;
}

export function tempClass(t) {
  if (typeof t !== "number" || !Number.isFinite(t)) return NO_DATA;
  return TEMP_CLASSES.find((c) => t < c.max);
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** Index of the day `iso` (UTC calendar day) in a series starting `d0`, or -1. */
function dayIndex(d0, len, iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  const i = Math.floor((t - Date.parse(`${d0}T00:00:00Z`)) / DAY_MS);
  return i >= 0 && i < len ? i : -1;
}

/**
 * The day bin in scope for a gage: the UTC calendar day containing `iso`, or (iso null)
 * the newest day with a temperature. Returns { d, t, q, label } (t/q null when missing).
 */
export function dayAt(p, iso) {
  const t = p.t || [];
  const q = p.q || [];
  if (!iso) {
    const l = p.latest;
    if (!l) return { d: null, t: null, q: null, suspect: false, label: "no data" };
    const li = dayIndex(p.d0, t.length, `${l.d}T12:00:00Z`);
    return {
      d: l.d,
      t: l.t ?? null,
      q: l.q ?? null,
      suspect: li >= 0 && isSpike(t, li),
      label: `latest daily mean, ${l.d}`,
    };
  }
  if (!Number.isFinite(Date.parse(iso)))
    return { d: null, t: null, q: null, suspect: false, label: "invalid time" };
  const i = dayIndex(p.d0, Math.max(t.length, q.length), iso);
  const day = iso.slice(0, 10);
  if (i < 0)
    return {
      d: null,
      t: null,
      q: null,
      suspect: false,
      label: `no record for ${day} in the 30-day window`,
    };
  const d = new Date(Date.parse(`${p.d0}T00:00:00Z`) + i * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { d, t: t[i] ?? null, q: q[i] ?? null, suspect: isSpike(t, i), label: `daily mean, ${d}` };
}

const fmtQ = (q) =>
  q === null || q === undefined
    ? "—"
    : `${q.toLocaleString("en-US", { maximumFractionDigits: q < 10 ? 2 : 0 })} ft³/s`;

export function describeGage(p, scope, source = {}) {
  const cls = scope.suspect ? SUSPECT : tempClass(scope.t);
  return (
    `<b>${esc(p.name)}</b> · USGS ${esc(p.site)} (${esc(p.state)})${p.sensor ? ` · temperature sensor: ${esc(p.sensor)}` : ""}<br>` +
    `${esc(scope.label)}: water <b>${scope.t === null ? "—" : `${scope.t.toFixed(1)} °C`}</b> (${esc(cls.label)})${scope.suspect ? " — excluded from the temperature bands; check the USGS record" : ""} · flow <b>${esc(fmtQ(scope.q))}</b>${scope.q !== null && scope.q < 0 ? " (negative = reverse flow, typical of tidally affected gages)" : ""}<br>` +
    `<small>Daily means; provisional data are subject to revision. Temperature bands follow EPA (2003) salmonid thresholds, which are constant-exposure values.</small><br>` +
    `<a href="https://waterdata.usgs.gov/monitoring-location/${esc(p.site)}/" target="_blank" rel="noopener">${esc(source.name || "USGS Water Services")}</a> · ${esc(source.licence || "Public Domain U.S. Government")}. Reference to USGS data does not imply endorsement.`
  );
}

/** Entity options for one gage at the observed instant. */
export function gageEntity(f, iso, ctx) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const scope = dayAt(p, iso);
  const showT = ctx.visible.temperature !== false;
  const showQ = ctx.visible.discharge !== false;
  const cls = !showT ? NO_DATA : scope.suspect ? SUSPECT : tempClass(scope.t);
  const hasData = (showT && scope.t !== null) || (showQ && scope.q !== null);
  const alpha = hasData ? 1 : FADED;
  // Size encodes flow MAGNITUDE: tidally affected gages report negative daily means when the
  // flow reverses (165 values on 2026-09-12), and log10 of a negative is NaN, which gave Cesium a
  // NaN point size and stopped the whole render loop.
  const size =
    showQ && scope.q !== null
      ? 4 + Math.min(14, 2.5 * Math.log10(Math.abs(scope.q) + 1))
      : 6;
  return {
    id: `rivers:${p.site}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: size,
      color: Cesium.Color.fromCssColorString(cls.color).withAlpha(alpha),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.7 * alpha),
      outlineWidth: 1,
      disableDepthTestDistance: 50_000,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describeGage(p, scope, ctx.source),
    properties: {
      site: p.site,
      name: p.name,
      state: p.state,
      lat,
      lon,
      day: scope.d,
      temp: scope.t,
      flow: scope.q,
      cls: cls.key,
      hasData,
      scope: scope.label,
      kind: "usgs-gage",
    },
  };
}

export function createRiversLayer() {
  let _dataSource = null;
  let _features = [];
  let _visible = { temperature: true, discharge: true };
  let _source = {};
  let _dataEnd = null;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null; // ISO or null = latest day
  let _rowControlsListener = null;

  const ctx = () => ({ visible: _visible, source: _source });
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features) es.add(gageEntity(f, _observed, ctx()));
    es.resumeEvents();
  };
  /** Gages with data in scope, per temperature class (legend counts). */
  const classCounts = () => {
    const c = {};
    let active = 0;
    for (const e of _dataSource?.entities.values || []) {
      if (!e.properties?.hasData?.getValue?.()) continue;
      active++;
      const k = e.properties?.cls?.getValue?.();
      if (k) c[k] = (c[k] || 0) + 1;
    }
    return { c, active };
  };

  const layer = {
    id: "rivers",
    name: "River temperature and flow (USGS gages)",
    icon: "🏞️",
    source:
      "USGS Water Data APIs, daily values (U.S. public domain; provisional)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("rivers");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Rivers] Initialized");
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
          _lastError = `rivers.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed rivers.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _dataEnd = gj.data_end ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Rivers] Updated: ${_features.length} gages, daily record to ${_dataEnd}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Rivers] Load error:", e);
        _lastError = `rivers.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: each gage shows the UTC day containing the instant. */
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
      const { c, active } = classCounts();
      const chips = [
        ["temperature", "TEMPERATURE", "colour by water temperature class"],
        ["discharge", "DISCHARGE", "size by discharge"],
      ].map(([id, label, what]) => ({
        id,
        label,
        active: _visible[id] !== false,
        state: _visible[id] !== false ? "active" : "idle",
        title: `${_visible[id] !== false ? "Stop" : "Start"} ${what}`,
        params: { [id]: !(_visible[id] !== false) },
      }));
      const legend =
        _visible.temperature !== false
          ? TEMP_CLASSES.map((k) => ({
              label: k.label,
              color: k.color,
              count: c[k.key] ?? 0,
            }))
          : [];
      if (_visible.temperature !== false && c[SUSPECT.key])
        legend.push({ label: SUSPECT.label, color: SUSPECT.color, count: c[SUSPECT.key] });
      legend.push({
        label: NO_DATA.label,
        color: NO_DATA.color,
        count: c[NO_DATA.key] ?? 0,
      });
      legend.push({
        label:
          _observed === null
            ? `dot = USGS gage, colour = daily-mean water temperature (salmonid stress bands), size = discharge · latest day (record to ${_dataEnd ?? "?"}) · ${active} reporting`
            : `dot = USGS gage, colour = daily-mean water temperature on the observed day, size = discharge · faded = no value that day · ${active} reporting`,
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
        .filter((e) => e.properties?.hasData?.getValue?.(now))
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            site: g("site"),
            name: g("name"),
            state: g("state"),
            lat: g("lat"),
            lon: g("lon"),
            day: g("day"),
            temp_c: g("temp"),
            flow_cfs: g("flow"),
            tempClass: g("cls"),
            scope: g("scope"),
          };
        });
    },

    getStats() {
      const { c, active } = classCounts();
      return {
        count: _features.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        dataEnd: _dataEnd,
        observed: _observed,
        active,
        classes: c,
      };
    },
  };
  return layer;
}

const riversLayer = createRiversLayer();
export default riversLayer;
