import * as Cesium from "cesium";
import { extentFromTimes } from "./observedExtent.js";

/**
 * Harmful algal events, HAEDAT (IOC-UNESCO Harmful Algal Event Database, OBIS HAB IPT archive 3.35 of 2025-05-23,
 * CC BY 4.0, doi:10.25607/k68d5v), from pipeline/haedat.py (spec docs/superpowers/specs/2026-10-03-haedat-design.md).
 * One dot per position HAEDAT records events at. A position is a monitoring point or a region's centre, not where an
 * event happened: within 100 km it is a filled dot, wider (a regional record, up to 985 km) a ring, and the info box
 * and the readout say how far it can be off. Colour = the illness most of the position's events in scope were linked
 * to. Live counts every event of any year; with the shared observed time set, only that year's.
 */
export const ILLNESSES = Object.freeze([
  { key: "PSP", label: "PSP (paralytic shellfish poisoning)", color: "#e53935" },
  { key: "DSP", label: "DSP (diarrhetic shellfish poisoning)", color: "#fb8c00" },
  { key: "ASP", label: "ASP (amnesic shellfish poisoning)", color: "#fdd835" },
  { key: "NSP", label: "NSP (neurotoxic shellfish poisoning)", color: "#8e24aa" },
  { key: "AZP", label: "AZP (azaspiracid poisoning)", color: "#3949ab" },
  { key: "CFP", label: "CFP (ciguatera fish poisoning)", color: "#00897b" },
  { key: "Cyano", label: "cyanobacterial toxins", color: "#43a047" },
  { key: "Aerosol", label: "aerosolised toxins", color: "#1e88e5" },
  { key: "Other", label: "other illness", color: "#90a4ae" },
  { key: "None", label: "no illness recorded (discoloration, kills, closures)", color: "#eceff1" },
]);
export const REGIONAL_KM = 100; // wider than this, a position is drawn as a ring: a regional record
export const NEAR_KM = 25; // a click reads positions within their stated range, or this, whichever is wider
/** One boundary for the ring, the info box and the readout: exactly 100 km (the Gulf of Maine point) is a monitoring point. */
export const isRegional = (km) => km > REGIONAL_KM;
const DATA_URL = "data/haedat.json";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const colorOf = (key) => ILLNESSES.find((i) => i.key === key)?.color ?? "#9e9e9e";

/** The UTC calendar year of an instant; null (live) stays null. */
export function yearOf(iso) {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`not an instant: ${iso}`);
  return new Date(t).getUTCFullYear();
}

/** A position's events in scope: live (null) = every event, dated or not; a year = that year's. */
export function eventsAt(p, year) {
  const buckets = year === null ? [...Object.values(p.years), p.undated] : [p.years[String(year)]].filter(Boolean);
  const ill = {};
  let n = 0;
  for (const b of buckets) {
    n += b.n;
    for (const [k, v] of Object.entries(b.ill)) ill[k] = (ill[k] || 0) + v;
  }
  return { n, ill };
}

/** The illness most events were linked to; ties go to the one listed first. */
export function dominant(ill) {
  let best = null;
  for (const { key } of ILLNESSES) if ((ill[key] || 0) > (best ? ill[best] : 0)) best = key;
  return best;
}

export function illnessText(ill) {
  return ILLNESSES.filter((i) => ill[i.key]).sort((a, b) => ill[b.key] - ill[a.key]).map((i) => `${i.key} ${ill[i.key]}`).join(", ");
}

export function precisionText(km) {
  return isRegional(km)
    ? `a regional record: the events happened somewhere within about ${Math.round(km).toLocaleString("en-US")} km of this point`
    : `a HAEDAT monitoring point, within about ${Math.round(km)} km of the events`;
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const scopeLabel = (year) => (year === null ? "all years" : String(year));

export function describePosition(p, year, source = {}) {
  const at = eventsAt(p, year);
  const ys = Object.keys(p.years).map(Number).sort((a, b) => a - b);
  const total = eventsAt(p, null).n;
  const lines = [
    `<b>${plural(at.n, "harmful algal event", "harmful algal events")}</b> · ${scopeLabel(year)}`,
    esc([p.places.join("; "), p.countries.join(", ")].filter(Boolean).join(" · ")),
    `Position: ${precisionText(p.uncertaintyKm)}`,
    `Linked illness: ${esc(illnessText(at.ill))} <small>(an event can be linked to more than one)</small>`,
  ];
  if (p.species.length) lines.push(`Commonest causative taxa: ${p.species.map(([s, n]) => `<i>${esc(s)}</i> (${n})`).join(", ")}`);
  lines.push(
    `${plural(total, "event", "events")} recorded here${ys.length ? `, ${ys[0]}–${ys[ys.length - 1]}` : ""}${p.undated.n ? ` (${p.undated.n} undated)` : ""}`,
  );
  lines.push(
    `<a href="https://doi.org/${esc(source.doi || "10.25607/k68d5v")}" target="_blank" rel="noopener">${esc(source.name || "HAEDAT")}</a>, ${esc(source.publisher || "IOC-UNESCO")} · archive ${esc(source.version || "3.35")} of ${esc(source.published || "2025-05-23")} · CC BY 4.0 · later events: <a href="https://haedat.iode.org" target="_blank" rel="noopener">haedat.iode.org</a>`,
  );
  return lines.join("<br>");
}

/** Entity options for a position in scope; null when it has no events in scope. */
export function positionEntity(p, year, source) {
  const at = eventsAt(p, year);
  if (!at.n) return null;
  const color = Cesium.Color.fromCssColorString(colorOf(dominant(at.ill)));
  const regional = isRegional(p.uncertaintyKm);
  return {
    id: `haedat:${p.lat},${p.lon}`,
    name: `Harmful algal events (${scopeLabel(year)})`,
    position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
    point: {
      pixelSize: (regional ? 8 : 5) + Math.min(10, 3 * Math.log10(at.n + 1)),
      color: regional ? color.withAlpha(0.12) : color,
      outlineColor: regional ? color : Cesium.Color.BLACK.withAlpha(0.7),
      outlineWidth: regional ? 2.5 : 1,
      disableDepthTestDistance: 50_000,
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 1.5e7, 0.6),
    },
    description: describePosition(p, year, source),
    properties: { kind: "haedat-position", n: at.n, dominant: dominant(at.ill), regional, uncertaintyKm: p.uncertaintyKm },
  };
}

export function createHaedatLayer({ fetchImpl = (u) => fetch(u) } = {}) {
  let _viewer = null,
    _dataSource = null,
    _enabled = false,
    _data = null,
    _year = null,
    _shown = 0,
    _lastUpdate = null,
    _lastError = null,
    _rowControlsListener = null;

  const rebuild = () => {
    if (!_dataSource || !_data) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    try {
      es.removeAll();
      _shown = 0;
      for (const p of _data.positions) {
        const e = positionEntity(p, _year, _data.source);
        if (!e) continue;
        es.add(e);
        _shown += 1;
      }
    } finally {
      es.resumeEvents();
    }
  };

  const load = async () => {
    const res = await fetchImpl(DATA_URL);
    if (!res.ok) throw new Error(`haedat.json HTTP ${res.status}`);
    const d = await res.json();
    if (!d || !Array.isArray(d.positions) || !d.positions.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.years && p.undated))
      throw new Error("Malformed haedat.json: positions is not a list of positions with years");
    const unknown = d.positions.flatMap((p) => [...Object.values(p.years), p.undated].flatMap((b) => Object.keys(b.ill))).find((k) => !ILLNESSES.some((i) => i.key === k));
    if (unknown) throw new Error(`haedat.json has an illness the legend does not know: ${unknown}`);
    const keys = ILLNESSES.map((i) => i.key).join(",");
    if ((d.illnesses || []).join(",") !== keys) throw new Error(`haedat.json lists illnesses ${d.illnesses} but the legend has ${keys}`);
    _data = d;
  };

  const layer = {
    id: "haedat",
    name: "Harmful algal events (HAEDAT)",
    icon: "🦠",
    source: "HAEDAT, IOC-UNESCO Harmful Algal Event Database (OBIS HAB IPT archive 3.35, doi:10.25607/k68d5v) · CC BY 4.0",
    updateInterval: 24 * 3600000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource("haedat");
      _dataSource.show = _enabled;
      viewer.dataSources.add(_dataSource);
    },
    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },
    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },
    async update() {
      if (_lastUpdate && !_lastError) return true; // a pinned archive: read once
      try {
        await load();
        _lastError = null;
        _lastUpdate = Date.now();
        rebuild();
        _rowControlsListener?.();
        return true;
      } catch (e) {
        _lastError = e?.message || String(e);
        console.error(`[Data:haedat] ${_lastError}`, e);
        return false;
      }
    },
    destroy(viewer) {
      if (_dataSource) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
    },
    getObservedExtent() {
      const ys = (_data?.positions || []).flatMap((p) => Object.keys(p.years).map(Number));
      if (!ys.length) return null;
      return extentFromTimes([Date.UTC(Math.min(...ys), 0, 1), Date.UTC(Math.max(...ys) + 1, 0, 1) - 1]);
    },
    setObservedTime(iso) {
      let year;
      try {
        year = yearOf(iso);
      } catch {
        return false;
      }
      if (year === _year) return true;
      _year = year;
      rebuild();
      _rowControlsListener?.();
      return true;
    },
    /** Events at the positions whose stated range covers the point (at least NEAR_KM), in scope; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id: "haedat", name: layer.name, icon: layer.icon, status, text: null, date: null, ...extra });
      if (!_data) return row("error", { error: _lastError ?? "HAEDAT not loaded" });
      if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) return row("outside");
      const date = scopeLabel(_year);
      const hits = _data.positions
        .map((p) => ({ p, km: distanceKm(lat, lon, p.lat, p.lon), at: eventsAt(p, _year) }))
        .filter(({ p, km, at }) => at.n > 0 && km <= Math.max(p.uncertaintyKm, NEAR_KM))
        .sort((a, b) => a.km - b.km);
      // a positive statement, not missing data: HAEDAT lists reported events, so none here is not proof of no bloom
      if (!hits.length) return row("class", { text: "no event recorded at a HAEDAT position whose range covers this spot", date });
      const n = hits.reduce((s, h) => s + h.at.n, 0);
      const ill = {};
      for (const h of hits) for (const [k, v] of Object.entries(h.at.ill)) ill[k] = (ill[k] || 0) + v;
      const near = hits[0];
      const text = `${plural(n, "event", "events")} at ${plural(hits.length, "HAEDAT position", "HAEDAT positions")} whose range covers this spot (${illnessText(ill)}); nearest ${Math.round(near.km)} km away, ${isRegional(near.p.uncertaintyKm) ? "a regional record" : "a monitoring point"}`;
      return row("value", { text, date });
    },
    getRowControls() {
      const ill = {};
      for (const p of _data?.positions || []) for (const [k, v] of Object.entries(eventsAt(p, _year).ill)) ill[k] = (ill[k] || 0) + v;
      const legend = ILLNESSES.map((i) => ({ label: i.label, color: i.color, count: ill[i.key] ?? 0 }));
      // undated events count live (at their position) and in no year; off-globe events are never drawn
      const undated = _data?.undated?.length ?? 0;
      const off = _data?.offGlobe?.length ?? 0;
      const left = [_year !== null && undated ? `${plural(undated, "undated event", "undated events")} in no year` : "", off ? `${plural(off, "event", "events")} placed off the globe not drawn` : ""].filter(Boolean).join(" · ");
      legend.push({
        label: `dot = a position HAEDAT records events at, coloured by the commonest linked illness · filled = within ${REGIONAL_KM} km, ring = regional record (up to ~1,000 km) · ${_year === null ? "all years" : _year}${left ? ` · ${left}` : ""} · archive 3.35 (2025-05-23)`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },
    getStats() {
      return { count: _data?.positions.length ?? 0, shown: _shown, lastUpdate: _lastUpdate, error: _lastError, observed: _year };
    },
  };
  return layer;
}

export const haedatLayer = createHaedatLayer();
