import * as Cesium from "cesium";

/**
 * Recent wildlife sightings from GBIF + OBIS (CC0 / CC-BY records only),
 * written daily by pipeline/occurrences.py. One point per record; colour by
 * taxon group, alpha fades with record age. Group chips toggle visibility.
 */
const DATA_URL = "data/occurrences.geojson";

export const GROUP_COLORS = Object.freeze({
  whales: "#4fc3f7",
  sharks: "#ff8a65",
  turtles: "#aed581",
  insects: "#ffd54f",
  mammals: "#f8bbd0",
  plants: "#81c784",
  sounds: "#ce93d8",
  invasives: "#ef5350",
  other: "#b0bec5",
});
const GROUP_LABELS = Object.freeze({
  whales: "WHALES",
  sharks: "SHARKS & RAYS",
  turtles: "TURTLES",
  insects: "INSECTS",
  mammals: "MAMMALS",
  plants: "PLANTS (PHENOLOGY)",
  sounds: "SOUNDS (XENO-CANTO)",
  invasives: "INVASIVE AQUATICS (USGS)",
  other: "OTHER",
});

/** 1.0 for today, fading to 0.25 at windowDays old (pure). */
export function ageAlpha(dateStr, nowMs = Date.now(), windowDays = 120) {
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return 0.25;
  const days = Math.max(0, (nowMs - t) / 86_400_000);
  return Math.max(0.25, 1 - 0.75 * Math.min(1, days / windowDays));
}

export function groupColor(group, alpha = 1) {
  return Cesium.Color.fromCssColorString(
    GROUP_COLORS[group] || GROUP_COLORS.other,
  ).withAlpha(alpha);
}

/** Short licence label from a URL/code; unknown licences are shown verbatim, never collapsed. */
export function licenceLabel(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("publicdomain/zero") || s.startsWith("cc0")) return "CC0 1.0";
  if (s.includes("licenses/by/4.0") || s === "cc_by_4_0") return "CC BY 4.0";
  if (s.includes("licenses/by/")) return "CC BY";
  return text || "licence unknown";
}

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** GBIF basis codes (HUMAN_OBSERVATION) read better lowercased; free text (a recordist's name) must keep its case. */
export const basisText = (b) => (/^[A-Z_]+$/.test(String(b || "")) ? String(b).toLowerCase().replace(/_/g, " ") : String(b || ""));

/** @param p feature properties  @param ds optional datasets map from the GeoJSON (dataset_key → meta) */
export function describeOccurrence(p, ds = {}) {
  const src = p.source === "obis" ? "OBIS" : p.source === "npn" ? "USA-NPN" : p.source === "xc" ? "xeno-canto" : p.source === "nas" ? "USGS NAS" : "GBIF";
  const lic = p.license_label || licenceLabel(p.license);
  const meta = (p.dataset_key && ds[p.dataset_key]) || {};
  const link = p.url
    ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${src} record</a>`
    : src;
  const doi = meta.doi
    ? ` · <a href="https://doi.org/${esc(meta.doi)}" target="_blank" rel="noopener">doi:${esc(meta.doi)}</a>`
    : "";
  const publisher = meta.publisher ? ` — ${esc(meta.publisher)}` : "";
  const unc = Number.isFinite(p.uncertainty_m) ? ` · ±${Math.round(p.uncertainty_m)} m` : "";
  return (
    `<b>${esc(p.icon ?? "")} ${esc(p.name)}</b> <i>${esc(p.sci)}</i><br>` +
    `${esc(p.date)} · ${esc(basisText(p.basis))}${unc}<br>` +
    `${esc(meta.title || p.dataset || "dataset unknown")}${publisher}${doi}<br>${link} · ${esc(lic)}`
  );
}

/**
 * `index` is the feature's position in the file and makes the id unique by
 * construction. A coordinate-hash id collided (two records in different
 * pipeline dedupe cells, same 4-decimal string) and Cesium's duplicate-id throw
 * took the whole layer down as LOAD FAILED (2026-09-11).
 */
export function pointEntity(f, nowMs = Date.now(), windowDays = 120, index = 0, datasets = {}) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  const a = ageAlpha(p.date, nowMs, windowDays);
  return {
    id: `occ:${p.taxon}:${p.date}:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 6,
      color: groupColor(p.group, a),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.6 * a),
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.6, 1.5e7, 0.5),
    },
    description: describeOccurrence(p, datasets),
    properties: { ...p, lat, lon },
  };
}

export function createOccurrencesLayer() {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _generatedAt = null;
  let _counts = {};
  let _truncated = [];
  let _datasets = {};
  let _groups = {}; // group -> visible
  let _observedMs = null; // ms of the shared observed time, or null = now
  let _features = [];
  let _windowDays = 120;
  let _groupCounts = {};
  let _rowControlsListener = null;

  const applyVisibility = () => {
    if (!_dataSource) return;
    const cutoff = _observedMs ?? Infinity;
    for (const e of _dataSource.entities.values) {
      const g = e.properties?.group?.getValue?.() ?? "other";
      const d = Date.parse(e.properties?.date?.getValue?.() ?? "");
      e.show = _groups[g] !== false && !(Number.isFinite(d) && d > cutoff);
    }
  };

  /** Rebuild points so alpha reflects age relative to the observed instant. */
  const rebuild = () => {
    if (!_dataSource) return;
    const now = _observedMs ?? Date.now();
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    _features.forEach((f, i) => _dataSource.entities.add(pointEntity(f, now, _windowDays, i, _datasets)));
    _dataSource.entities.resumeEvents();
    applyVisibility();
  };

  const layer = {
    id: "occurrences",
    name: "Wildlife sightings (GBIF + OBIS + USA-NPN)",
    icon: "🐋",
    source: "GBIF + OBIS occurrences (CC0 / CC-BY records only) + USA-NPN phenology (CC BY 4.0)",
    updateInterval: 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("occurrences");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _generatedAt = null;
      _counts = {};
      _groups = {};
      _groupCounts = {};
      console.log("[Data:Occurrences] Initialized");
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
          _lastError = `occurrences.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed occurrences.geojson";
          return false;
        }
        _windowDays = Number(gj.window_days) || 120;
        const gc = {};
        for (const f of gj.features) {
          const g = f.properties?.group ?? "other";
          gc[g] = (gc[g] || 0) + 1;
          if (!(g in _groups)) _groups[g] = true;
        }
        _features = gj.features;
        _datasets = gj.datasets ?? {};
        _groupCounts = gc;
        _count = gj.features.length;
        _counts = gj.counts ?? {};
        _truncated = Array.isArray(gj.truncated) ? gj.truncated : [];
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Occurrences] Updated: ${_count} records, generated ${_generatedAt}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Occurrences] Load error:", e);
        _lastError = `occurrences.geojson load error: ${e?.message || e}`;
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _generatedAt = null;
    },

    /** Shared observed-time hook: records after the instant are hidden, age fades relative to it. */
    setObservedTime(iso) {
      const ms = iso ? Date.parse(iso) : null;
      if (iso && !Number.isFinite(ms)) return false;
      if (ms === _observedMs) return true;
      _observedMs = ms;
      rebuild();
      _rowControlsListener?.();
      return true;
    },

    setParams(params = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "boolean" && k in _groups && _groups[k] !== v) {
          _groups[k] = v;
          changed = true;
        }
      }
      if (changed) {
        applyVisibility();
        _rowControlsListener?.();
      }
      return changed;
    },
    getParams() {
      return { ..._groups };
    },
    getRowControls() {
      const chips = Object.keys(_groupCounts)
        .sort()
        .map((g) => ({
          id: g,
          label: `${GROUP_LABELS[g] || g.toUpperCase()} ${_groupCounts[g]}`,
          active: _groups[g] !== false,
          state: _groups[g] !== false ? "active" : "idle",
          title: `${_groups[g] !== false ? "Hide" : "Show"} ${g}`,
          params: { [g]: !(_groups[g] !== false) },
        }));
      return {
        chips,
        legend: [
          {
            label: "bright = recent · faded = older (up to 120 d)",
            color: "transparent",
            count: null,
          },
          ...(_truncated.length
            ? [{ label: `partial: ${_truncated.join(", ")} hit the per-taxon cap`, color: "transparent", count: null }]
            : []),
        ],
      };
    },
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === "function" ? listener : null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      return _dataSource.entities.values
        .filter((e) => e.show)
        .slice(0, maxCount)
        .map((e) => {
          const p = e.properties;
          const get = (k) => p?.[k]?.getValue(now);
          return {
            id: e.id,
            name: get("name"),
            sci: get("sci"),
            group: get("group"),
            date: get("date"),
            source: get("source"),
            lat: get("lat"),
            lon: get("lon"),
          };
        });
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        perTaxon: _counts,
        truncated: _truncated,
        datasets: Object.keys(_datasets).length,
        observed: _observedMs === null ? null : new Date(_observedMs).toISOString(),
        visible: _dataSource ? _dataSource.entities.values.filter((e) => e.show).length : 0,
      };
    },
  };
  return layer;
}

const occurrencesLayer = createOccurrencesLayer();
export default occurrencesLayer;
