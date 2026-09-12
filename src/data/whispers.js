import * as Cesium from "cesium";
import { binsAt, LIVE_WEEKS } from "./hpai.js";

/**
 * Wildlife mortality and morbidity events by county (polygon contract): USGS WHISPers
 * events from pipeline/whispers.py, public domain. Fill class = events starting in scope
 * (the 7-day bin containing the observed instant, or live the newest LIVE_WEEKS bins —
 * the same bin logic as the avian-influenza layer, imported from it). The info box lists
 * the county's recent events with species, diagnoses and animals affected, and says that
 * diagnoses are provisional until laboratory results arrive.
 */
const DATA_URL = "data/whispers.geojson";
const FILL_ALPHA = 0.55;
// A reported-zero area must read as FILLED grey, not as bare imagery: 0.15 was indistinguishable
// from no polygon at all in the real-app screenshots (2026-09-12 visual critic).
export const EMPTY_ALPHA = 0.35;

export const EVENT_CLASSES = Object.freeze([
  { key: "one", label: "1 event", color: "#c4b5fd", test: (n) => n <= 1 },
  { key: "two", label: "2 events", color: "#8b5cf6", test: (n) => n <= 2 },
  {
    key: "several",
    label: "3–4 events",
    color: "#6d28d9",
    test: (n) => n <= 4,
  },
  { key: "cluster", label: "5+ events", color: "#3b0764", test: () => true },
]);
export const NO_DATA = Object.freeze({
  key: "none",
  label: "no events in scope",
  color: "#6b7280",
});

export function eventClass(n) {
  if (!Number.isFinite(n) || n <= 0) return NO_DATA;
  return EVENT_CLASSES.find((c) => c.test(n));
}

export function sumBins(bins) {
  const sp = {};
  let n = 0,
    affected = 0;
  for (const b of bins) {
    n += b.n || 0;
    affected += b.affected || 0;
    for (const [k, v] of Object.entries(b.sp || {})) sp[k] = (sp[k] || 0) + v;
  }
  return { n, affected, sp };
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function describeCounty(p, scope, sum, source = {}) {
  const inScope = new Set(scope.bins.map((b) => b.w));
  const events = (p.events || [])
    .filter((e) => {
      // an event belongs to the bin whose week end is the first at or after its start
      const w = scope.bins.find((b) => {
        const end = Date.parse(`${b.w}T23:59:59Z`);
        const t = Date.parse(`${e.start}T00:00:00Z`);
        return t <= end && t > end - 7 * 86_400_000;
      });
      return !!w && inScope.has(w.w);
    })
    .slice(0, 5);
  const rows = events
    .map(
      (e) =>
        `${esc(e.start)}${e.end && e.end !== e.start ? `–${esc(e.end)}` : ""}: ${esc((e.species || []).slice(0, 3).join(", ") || "species not listed")}` +
        `${e.affected ? ` · ${e.affected} affected` : ""}${(e.diagnoses || []).length ? ` · ${esc(e.diagnoses.slice(0, 2).join("; "))}` : ""}${e.complete ? "" : " · open"}`,
    )
    .join("<br>");
  return (
    `<b>${esc(p.name)} County, ${esc(p.st)}</b><br>` +
    `Wildlife mortality/morbidity, ${esc(scope.label)}: ${sum.n} event${sum.n === 1 ? "" : "s"}${sum.affected ? `, ~${sum.affected.toLocaleString()} animals` : ""}<br>` +
    (rows ? `${rows}<br>` : "") +
    `${p.n ?? 0} event${p.n === 1 ? "" : "s"} in this county in the file's window<br>` +
    `<small>Reported by partner agencies as investigated; "Pending" and "suspect" diagnoses change when lab results arrive. Counts are observations, not a census.</small><br>` +
    `<a href="${esc(source.url || "https://whispers.usgs.gov")}" target="_blank" rel="noopener">${esc(source.name || "USGS WHISPers")}</a> · ${esc(source.licence || "Public Domain U.S. Government")}`
  );
}

const ring = (coords) =>
  Cesium.Cartesian3.fromDegreesArray(
    coords.flatMap(([lon, lat]) => [lon, lat]),
  );
const hierarchy = (poly) =>
  new Cesium.PolygonHierarchy(
    ring(poly[0]),
    poly.slice(1).map((h) => new Cesium.PolygonHierarchy(ring(h))),
  );

export function countyEntities(f, observedIso, today, source = {}) {
  const p = f.properties || {};
  const scope = binsAt(p.weeks, observedIso, today);
  const sum = sumBins(scope.bins);
  const cls = eventClass(sum.n);
  const color = Cesium.Color.fromCssColorString(cls.color).withAlpha(
    sum.n > 0 ? FILL_ALPHA : EMPTY_ALPHA,
  );
  const polys =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
  return polys.map((poly, k) => ({
    id: `whispers:${p.fips}:${k}`,
    polygon: {
      hierarchy: hierarchy(poly),
      material: color,
      outline: true,
      outlineColor: color.withAlpha(0.9),
      outlineWidth: 1,
    },
    description: describeCounty(p, scope, sum, source),
    properties: {
      fips: p.fips,
      name: p.name,
      st: p.st,
      n: sum.n,
      affected: sum.affected,
      cls: cls.key,
      scope: scope.label,
      part: k,
    },
  }));
}

export function createWhispersLayer() {
  let _dataSource = null;
  let _features = [];
  let _source = {};
  let _today = null;
  let _newest = null;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observed = null;
  let _rowControlsListener = null;

  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    for (const f of _features)
      for (const e of countyEntities(f, _observed, _today, _source)) es.add(e);
    es.resumeEvents();
  };
  const classCounts = () => {
    const c = {};
    for (const e of _dataSource?.entities.values || []) {
      if (e.properties?.part?.getValue?.() !== 0) continue;
      const k = e.properties?.cls?.getValue?.() ?? "none";
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  };

  const layer = {
    id: "whispers",
    name: "Wildlife die-offs and disease events (USGS WHISPers)",
    icon: "🦌",
    source:
      "USGS National Wildlife Health Center WHISPers (Public Domain U.S. Government); Census county boundaries",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("whispers");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:WHISPers] Initialized");
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
          _lastError = `whispers.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed whispers.geojson";
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
          `[Data:WHISPers] Updated: ${_features.length} counties, newest event ${_newest}`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:WHISPers] Load error:", e);
        _lastError = `whispers.geojson load error: ${e?.message || e}`;
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
      const legend = [...EVENT_CLASSES, NO_DATA].map((c) => ({
        label: c.label,
        color: c.color,
        count: counts[c.key] ?? 0,
      }));
      legend.push({
        label:
          _observed === null
            ? `county fill = wildlife mortality/morbidity events reported to USGS, last ${LIVE_WEEKS} weeks (newest ${_newest ?? "?"}); diagnoses provisional`
            : "county fill = wildlife mortality/morbidity events starting in the week of the observed time; diagnoses provisional",
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
        .filter(
          (e) =>
            e.properties?.part?.getValue?.(now) === 0 &&
            (e.properties?.n?.getValue?.(now) ?? 0) > 0,
        )
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            fips: g("fips"),
            name: g("name"),
            st: g("st"),
            events: g("n"),
            affected: g("affected"),
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
        observed: _observed,
        classes: classCounts(),
      };
    },
  };
  return layer;
}

const whispersLayer = createWhispersLayer();
export default whispersLayer;
