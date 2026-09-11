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
  other: "#b0bec5",
});
const GROUP_LABELS = Object.freeze({
  whales: "WHALES",
  sharks: "SHARKS & RAYS",
  turtles: "TURTLES",
  insects: "INSECTS",
  mammals: "MAMMALS",
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

export function describeOccurrence(p) {
  const src = p.source === "obis" ? "OBIS" : "GBIF";
  const lic = /zero/i.test(p.license || "") ? "CC0" : "CC-BY";
  const link = p.url
    ? `<a href="${p.url}" target="_blank" rel="noopener">${src} record</a>`
    : src;
  return (
    `<b>${p.icon ?? ""} ${p.name}</b> <i>${p.sci}</i><br>` +
    `${p.date} · ${String(p.basis || "")
      .toLowerCase()
      .replace(/_/g, " ")}<br>` +
    `${p.dataset ?? "dataset unknown"}<br>${link} · ${lic}`
  );
}

/**
 * `index` is the feature's position in the file and makes the id unique by
 * construction. A coordinate-hash id collided (two records in different
 * pipeline dedupe cells, same 4-decimal string) and Cesium's duplicate-id throw
 * took the whole layer down as LOAD FAILED (2026-09-11).
 */
export function pointEntity(f, nowMs = Date.now(), windowDays = 120, index = 0) {
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
    description: describeOccurrence(p),
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
  let _groups = {}; // group -> visible
  let _groupCounts = {};
  let _rowControlsListener = null;

  const applyVisibility = () => {
    if (!_dataSource) return;
    for (const e of _dataSource.entities.values) {
      const g = e.properties?.group?.getValue?.() ?? "other";
      e.show = _groups[g] !== false;
    }
  };

  const layer = {
    id: "occurrences",
    name: "Wildlife sightings (GBIF + OBIS)",
    icon: "🐋",
    source: "GBIF + OBIS occurrences (CC0 / CC-BY records only)",
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
        const now = Date.now();
        const win = Number(gj.window_days) || 120;
        _dataSource.entities.suspendEvents();
        _dataSource.entities.removeAll();
        const gc = {};
        gj.features.forEach((f, i) => {
          const g = f.properties?.group ?? "other";
          gc[g] = (gc[g] || 0) + 1;
          if (!(g in _groups)) _groups[g] = true;
          _dataSource.entities.add(pointEntity(f, now, win, i));
        });
        _dataSource.entities.resumeEvents();
        _groupCounts = gc;
        _count = gj.features.length;
        _counts = gj.counts ?? {};
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        applyVisibility();
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
      };
    },
  };
  return layer;
}

const occurrencesLayer = createOccurrencesLayer();
export default occurrencesLayer;
