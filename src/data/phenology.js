import * as Cesium from "cesium";
import { binsAt, LIVE_WEEKS } from "./hpai.js";

/**
 * Phenology status by site (site-series contract): one point per USA-NPN Nature's
 * Notebook site, from pipeline/phenology.py (CC BY 4.0). Each site carries weekly bins
 * per phenophase class — leaves, flowers, fruits, insect activity, bird activity — with
 * the number of "yes" status reports, the number of reports at all (checked) and the
 * species reported. Colour = class with the most "yes" reports in scope among the classes
 * whose chip is on; size = "yes" reports; faded = checked, none reported. With the shared
 * observed time set, the 7-day bin containing the instant; live, the newest LIVE_WEEKS
 * bins (the same bin logic as the avian-influenza layer, imported from it). Reports are
 * observer visits, not a census, and the info box says so.
 */
const DATA_URL = "data/phenology.geojson";
const FADED = 0.2;

export const CLASSES = Object.freeze([
  { key: "leaves", label: "LEAVES", name: "leaves", color: "#66bb6a" },
  { key: "flowers", label: "FLOWERS", name: "flowers", color: "#f48fb1" },
  { key: "fruits", label: "FRUITS", name: "fruits", color: "#ff8a65" },
  {
    key: "insects",
    label: "INSECTS",
    name: "insect activity/emergence",
    color: "#ffd54f",
  },
  {
    key: "birds",
    label: "BIRDS",
    name: "birds present (arrival)",
    color: "#4fc3f7",
  },
]);
const CLASS_BY_KEY = Object.fromEntries(CLASSES.map((c) => [c.key, c]));
export const NO_YES_COLOR = "#9ca3af";

export function classColor(key) {
  return CLASS_BY_KEY[key]?.color ?? NO_YES_COLOR;
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** Sum per-class yes/checked/species over the bins in scope; classes with `visible[k] === false` are skipped. */
export function sumBins(bins, visible = {}) {
  const yes = {},
    obs = {},
    sp = {};
  for (const b of bins) {
    for (const [k, v] of Object.entries(b.obs || {})) {
      if (visible[k] === false) continue;
      obs[k] = (obs[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(b.yes || {})) {
      if (visible[k] === false) continue;
      yes[k] = (yes[k] || 0) + v;
      for (const [name, n] of Object.entries(b.sp?.[k] || {})) {
        sp[k] = sp[k] || {};
        sp[k][name] = (sp[k][name] || 0) + n;
      }
    }
  }
  const total = Object.values(yes).reduce((a, b) => a + b, 0);
  const checked = Object.values(obs).reduce((a, b) => a + b, 0);
  const dominant =
    Object.entries(yes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { yes, obs, sp, total, checked, dominant };
}

export function describeSite(p, scope, sum, source = {}) {
  const rows = CLASSES.filter((c) => sum.obs[c.key] > 0)
    .map((c) => {
      const y = sum.yes[c.key] || 0;
      const names = Object.entries(sum.sp[c.key] || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([n, v]) => `${esc(n)} (${v})`)
        .join(", ");
      return `<span style="color:${c.color}">●</span> ${esc(c.name)}: ${y ? `<b>${y} yes</b>` : "none"} of ${sum.obs[c.key]} report${sum.obs[c.key] === 1 ? "" : "s"}${names ? ` · ${names}` : ""}`;
    })
    .join("<br>");
  return (
    `<b>Nature's Notebook site ${esc(p.site)}${p.st ? `, ${esc(p.st)}` : ""}</b><br>` +
    `${esc(scope.label)}: ${sum.total} "yes" report${sum.total === 1 ? "" : "s"} of ${sum.checked} phenophase check${sum.checked === 1 ? "" : "s"}<br>` +
    (rows ? `${rows}<br>` : "") +
    `${p.n ?? 0} "yes" report${p.n === 1 ? "" : "s"} at this site in the file's window<br>` +
    `<small>Status reports are observer visits, not a census; a class missing here was not checked at this site.</small><br>` +
    `<a href="${esc(source.url || "https://www.usanpn.org")}" target="_blank" rel="noopener">${esc(source.name || "USA National Phenology Network")}</a> · ${esc(source.licence || "CC BY 4.0")}`
  );
}

/** Entity options for one site at the observed instant. */
export function siteEntity(f, index, iso, ctx) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const scope = binsAt(p.weeks, iso, ctx.today);
  const sum = sumBins(scope.bins, ctx.visible);
  const alpha = sum.total > 0 ? 1 : FADED;
  const color = Cesium.Color.fromCssColorString(
    classColor(sum.dominant),
  ).withAlpha(alpha);
  return {
    id: `phenology:${index}`,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 4 + Math.min(12, 4 * Math.log10(sum.total + 1)),
      color,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.7 * alpha),
      outlineWidth: 1,
      disableDepthTestDistance: 50_000,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describeSite(p, scope, sum, ctx.source),
    properties: {
      site: p.site,
      st: p.st,
      lat,
      lon,
      total: sum.total,
      checked: sum.checked,
      dominant: sum.dominant,
      yes: { ...sum.yes },
      scope: scope.label,
      kind: "phenology-site",
    },
  };
}

export function createPhenologyLayer() {
  let _dataSource = null;
  let _features = [];
  let _visible = Object.fromEntries(CLASSES.map((c) => [c.key, true]));
  let _source = {};
  let _today = null;
  let _newest = null;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const ctx = () => ({ today: _today, visible: _visible, source: _source });
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    _features.forEach((f, i) => es.add(siteEntity(f, i, _observed, ctx())));
    es.resumeEvents();
  };
  /** Sites with ≥1 "yes" in scope per class (a site counts in every class it reported), plus the active total. */
  const activeCounts = () => {
    const c = {};
    let active = 0;
    for (const e of _dataSource?.entities.values || []) {
      if ((e.properties?.total?.getValue?.() ?? 0) <= 0) continue;
      active++;
      const yes = e.properties?.yes?.getValue?.() || {};
      for (const k of Object.keys(yes)) if (yes[k] > 0) c[k] = (c[k] || 0) + 1;
    }
    return { c, active };
  };

  const layer = {
    id: "phenology",
    name: "Phenology: leaves, flowers, fruit, emergence (USA-NPN)",
    icon: "🌸",
    source:
      "USA National Phenology Network, Nature's Notebook status reports (CC BY 4.0)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("phenology");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Phenology] Initialized");
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
          _lastError = `phenology.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed phenology.geojson";
          return false;
        }
        _features = gj.features;
        _source = gj.source || {};
        _today = gj.today ?? null;
        _newest = gj.newest ?? null;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Phenology] Updated: ${_features.length} sites, newest report ${_newest}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Phenology] Load error:", e);
        _lastError = `phenology.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: each site shows the 7-day bin containing the instant. */
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
      const chips = CLASSES.map((cl) => ({
        id: cl.key,
        label: cl.label,
        active: _visible[cl.key] !== false,
        state: _visible[cl.key] !== false ? "active" : "idle",
        title: `${_visible[cl.key] !== false ? "Hide" : "Show"} ${cl.name}`,
        params: { [cl.key]: !(_visible[cl.key] !== false) },
      }));
      const legend = CLASSES.filter((cl) => _visible[cl.key] !== false).map(
        (cl) => ({
          label: `${cl.name} reported`,
          color: cl.color,
          count: c[cl.key] ?? 0,
        }),
      );
      legend.push({
        label:
          _observed === null
            ? `dot = Nature's Notebook site, colour = class with most "yes" reports in the last ${LIVE_WEEKS} weeks (newest ${_newest ?? "?"}), size = reports · faded = checked, none reported · ${active} active`
            : `dot = Nature's Notebook site, colour = class with most "yes" reports in the week of the observed time · faded = checked, none reported · ${active} active`,
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
            site: g("site"),
            st: g("st"),
            lat: g("lat"),
            lon: g("lon"),
            reports: g("total"),
            checked: g("checked"),
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
        newest: _newest,
        observed: _observed,
        active: activeCounts().active,
        classes: activeCounts().c,
      };
    },
  };
  return layer;
}

const phenologyLayer = createPhenologyLayer();
export default phenologyLayer;
