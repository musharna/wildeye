import * as Cesium from "cesium";

/**
 * Antarctic penguin breeding colonies, from the Antarctic Penguin Biogeography Project database (the authors' mapppdr
 * R package v3.1, 2026-08-21, CC BY 4.0; Che-Castaldo, Humphries & Lynch 2023, doi:10.3897/BDJ.11.e101476), through
 * pipeline/penguins.py (spec docs/superpowers/specs/2026-10-07-penguins-design.md).
 * One dot per breeding site x species, coloured by species. Where several species breed at one site their dots sit
 * side by side around the site, a fixed number of screen pixels apart (clusterOffsets), so each can be seen and clicked
 * at every zoom. A first build drew them as concentric rings of points: in qa-penguins the outer ring covered the inner
 * dot from 30 km whichever was added first, and a real click in the middle of each ring opened the next species in.
 * The dot size never carries a count: nests, chicks and adults are different
 * measures and are never added or compared. Not on the time bar: a click shows each colony's latest counts and the span
 * of its surveys.
 */
export const SPECIES = Object.freeze([
  { id: "ADPE", label: "Adélie penguin", color: "#1e88e5" },
  { id: "CHPE", label: "chinstrap penguin", color: "#fdd835" },
  { id: "EMPE", label: "emperor penguin", color: "#8e24aa" },
  { id: "GEPE", label: "gentoo penguin", color: "#fb8c00" },
  { id: "KIPE", label: "king penguin", color: "#e53935" },
  { id: "MCPE", label: "macaroni penguin", color: "#43a047" },
]);
export const TYPES = Object.freeze(["nests", "chicks", "adults"]);
/** The release's vantage values (man/penguin_obs.Rd), in words; an unknown one stops the load. */
export const VANTAGES = Object.freeze({
  aerial: "aerial count",
  "aerial photo": "aerial photo",
  ground: "ground count",
  "ground photo": "ground photo",
  landsat: "Landsat image",
  "offshore vessel": "count from a ship",
  sentinel: "Sentinel image",
  uav: "drone photo",
  vhr: "very-high-resolution satellite image",
});
export const NEAR_KM = 10; // WHAT LIVES HERE names the nearest colony site within this distance
export const DOT_PX = 10; // a dot's diameter at scale 1
export const GAP_PX = 2; // between neighbouring dots of one site, at scale 1
// one scale for the dots and their offsets, so a site's cluster keeps its shape at every zoom
const SCALE = new Cesium.NearFarScalar(2.0e5, 1.4, 1.5e7, 0.7);

/**
 * Screen offsets (px at scale 1, x right, y down) for n dots at one site: one sits on the site; two or more sit on a
 * circle round it, the first at the top and the rest clockwise, with neighbours DOT_PX + GAP_PX apart centre to centre.
 */
export function clusterOffsets(n) {
  if (n === 1) return [[0, 0]];
  const r = (DOT_PX + GAP_PX) / (2 * Math.sin(Math.PI / n));
  return Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n;
    return [r * Math.sin(a), -r * Math.cos(a)];
  });
}

/** A filled circle with a dark outline, as an SVG data URL (no canvas, so it builds in node tests too). */
export function dotImage(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_PX}" height="${DOT_PX}"><circle cx="${DOT_PX / 2}" cy="${DOT_PX / 2}" r="${DOT_PX / 2 - 0.75}" fill="${color}" stroke="#000" stroke-opacity="0.75" stroke-width="1.5"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
const EDITION = "mapppdr v3.1 (2026-08-21)";
const DATA_URL = "data/penguins.json";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (n) => n.toLocaleString("en-US");
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const speciesOf = (id) => SPECIES.find((s) => s.id === id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An austral breeding season by its first year: 2025 is the 2025/26 summer. */
export function seasonLabel(y) {
  return `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
}

/** '2025-12-22' → '22 Dec 2025'. */
export function dateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) throw new Error(`not a date: ${iso}`);
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

/** One count in words, with its own type: '2,707 nests' or '0 nests (none found)'. */
export function countText(c) {
  const type = c.count === 1 ? { nests: "nest", chicks: "chick", adults: "adult" }[c.type] : c.type;
  return `${num(c.count)} ${type}${c.count === 0 ? " (none found)" : ""}`;
}

function countDetail(c) {
  const parts = [VANTAGES[c.vantage], c.date ? dateLabel(c.date) : null, c.accuracy ? `accuracy ${c.accuracy} of 5` : "accuracy not stated"];
  return `${countText(c)} <small>(${esc(parts.filter(Boolean).join(", "))})</small>`;
}

/** The latest-counts line(s) for the card. */
export function latestText(p) {
  const lines = [];
  if (p.latest) {
    const n = p.latest.counts.length;
    lines.push(`${n === 1 ? "Latest count" : `Latest counts (${n}, not added)`}, ${seasonLabel(p.latest.season)} season: ${p.latest.counts.map(countDetail).join("; ")}`);
  } else {
    lines.push(`No count in this release: recorded present, not counted, latest in ${seasonLabel(p.presentOnly)}`);
  }
  if (p.latest && p.presentOnly) lines.push(`Recorded present, not counted, in ${seasonLabel(p.presentOnly)}`);
  return lines;
}

/** The species' latest counts in short form, for WHAT LIVES HERE. */
export function shortLatest(p) {
  const sp = speciesOf(p.species).label.replace(/ penguin$/, "");
  if (!p.latest) return `${sp} present, not counted (${seasonLabel(p.presentOnly)})`;
  return `${sp} ${p.latest.counts.map(countText).join(", ")} (${seasonLabel(p.latest.season)})`;
}

const span = (p) => (p.first === p.last ? seasonLabel(p.first) : `${seasonLabel(p.first)} to ${seasonLabel(p.last)}`);

export function describePoint(p, source = {}) {
  const sp = speciesOf(p.species);
  const lines = [
    `<b>${esc(sp.label[0].toUpperCase() + sp.label.slice(1))}</b> · ${esc(p.name)}`,
    esc([p.region, `${Math.abs(p.lat).toFixed(3)}°S ${Math.abs(p.lon).toFixed(3)}°${p.lon < 0 ? "W" : "E"}`].filter(Boolean).join(" · ")),
    ...latestText(p),
    `${plural(p.surveys, "survey", "surveys")} (${plural(p.records, "record", "records")}), ${span(p)}`,
    `<small>Accuracy is the Croxall and Kirkwood scale: 1 most precise, 5 order of magnitude. Nests, chicks and adults are different measures.</small>`,
    `<a href="https://doi.org/${esc(source.doi || "10.3897/BDJ.11.e101476")}" target="_blank" rel="noopener">Antarctic Penguin Biogeography Project</a> (Che-Castaldo, Humphries &amp; Lynch 2023) · <a href="https://doi.org/${esc(source.datasetDoi || "10.48361/zftxkr")}" target="_blank" rel="noopener">dataset</a> · ${esc(EDITION)} · CC BY 4.0`,
  ];
  return lines.join("<br>");
}

/** Points grouped by site: {site: [points in SPECIES order]}. */
export function bySite(points) {
  const order = new Map(SPECIES.map((s, i) => [s.id, i]));
  const sites = new Map();
  for (const p of points) {
    if (!sites.has(p.site)) sites.set(p.site, []);
    sites.get(p.site).push(p);
  }
  for (const ps of sites.values()) ps.sort((a, b) => order.get(a.species) - order.get(b.species));
  return sites;
}

/** Entity options for a point, `slot` = its place among the site's `n` species (SPECIES order). */
export function pointEntity(p, slot = 0, n = 1, source = undefined) {
  const [dx, dy] = clusterOffsets(n)[slot];
  return {
    id: `penguins:${p.site}:${p.species}`,
    name: `${speciesOf(p.species).label}, ${p.name}`,
    position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
    billboard: {
      image: dotImage(speciesOf(p.species).color),
      width: DOT_PX,
      height: DOT_PX,
      pixelOffset: new Cesium.Cartesian2(dx, dy),
      scaleByDistance: SCALE,
      pixelOffsetScaleByDistance: SCALE,
      disableDepthTestDistance: 50_000,
    },
    description: describePoint(p, source),
    properties: { kind: "penguin-colony", site: p.site, species: p.species, slot },
  };
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Refuse a file the card cannot describe truthfully; returns the data. */
export function validate(d) {
  if (!d || !Array.isArray(d.points) || !d.points.length) throw new Error("Malformed penguins.json: no points");
  for (const p of d.points) {
    const where = `${p?.site} ${p?.species}`;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || p.lat > -55 || p.lat < -90) throw new Error(`penguins.json: ${where} has no position south of 55°S`);
    if (!speciesOf(p.species)) throw new Error(`penguins.json has a species the legend does not know: ${p.species}`);
    if (!Number.isInteger(p.surveys) || !Number.isInteger(p.records) || !Number.isInteger(p.first) || !Number.isInteger(p.last)) throw new Error(`penguins.json: ${where} has no survey counts`);
    if (!p.latest && !Number.isInteger(p.presentOnly)) throw new Error(`penguins.json: ${where} has neither a count nor a presence record`);
    for (const c of p.latest?.counts ?? []) {
      if (!TYPES.includes(c.type)) throw new Error(`penguins.json: ${where} has a count type the card does not know: ${c.type}`);
      if (c.vantage !== null && !(c.vantage in VANTAGES)) throw new Error(`penguins.json: ${where} has a vantage the card does not know: ${c.vantage}`);
      if (!Number.isInteger(c.count) || c.count < 0) throw new Error(`penguins.json: ${where} has a count that is not a whole number: ${c.count}`);
    }
    if (p.latest && !p.latest.counts.length) throw new Error(`penguins.json: ${where} has a latest season with no counts`);
  }
  return d;
}

export function createPenguinsLayer({ fetchImpl = (u) => fetch(u) } = {}) {
  let _dataSource = null,
    _enabled = false,
    _data = null,
    _sites = null,
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
      for (const ps of _sites.values()) {
        for (let slot = 0; slot < ps.length; slot += 1) {
          es.add(pointEntity(ps[slot], slot, ps.length, _data.source));
          _shown += 1;
        }
      }
    } finally {
      es.resumeEvents();
    }
  };

  const layer = {
    id: "penguins",
    name: "Penguin colonies (Antarctic)",
    icon: "🐧",
    source: "Antarctic Penguin Biogeography Project database, mapppdr v3.1 (Che-Castaldo, Humphries & Lynch 2023, doi:10.3897/BDJ.11.e101476) · CC BY 4.0",
    updateInterval: 24 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("penguins");
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
      if (_lastUpdate && !_lastError) return true; // a pinned release: read once
      try {
        const res = await fetchImpl(DATA_URL);
        if (!res.ok) throw new Error(`penguins.json HTTP ${res.status}`);
        _data = validate(await res.json());
        _sites = bySite(_data.points);
        _lastError = null;
        _lastUpdate = Date.now();
        rebuild();
        _rowControlsListener?.();
        return true;
      } catch (e) {
        _lastError = e?.message || String(e);
        console.error(`[Data:penguins] ${_lastError}`, e);
        return false;
      }
    },
    destroy(viewer) {
      if (_dataSource) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
    },
    /** The nearest colony site within NEAR_KM and each of its species' latest counts; null when the layer is off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id: "penguins", name: layer.name, icon: layer.icon, status, text: null, date: null, ...extra });
      if (!_data) return row("error", { error: _lastError ?? "penguin colonies not loaded" });
      if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) return row("outside");
      const near = [..._sites.values()]
        .map((ps) => ({ ps, km: distanceKm(lat, lon, ps[0].lat, ps[0].lon) }))
        .filter((s) => s.km <= NEAR_KM)
        .sort((a, b) => a.km - b.km);
      if (!near.length) return row("class", { text: `no penguin breeding site recorded within ${NEAR_KM} km`, date: EDITION });
      const { ps, km } = near[0];
      const others = near.length - 1;
      const text = `${ps[0].name} (${km < 1 ? "under 1" : Math.round(km)} km): ${ps.map(shortLatest).join("; ")}${others ? ` · ${plural(others, "other breeding site", "other breeding sites")} within ${NEAR_KM} km` : ""}`;
      return row("value", { text, date: EDITION });
    },
    getRowControls() {
      const n = new Map(SPECIES.map((s) => [s.id, 0]));
      for (const p of _data?.points ?? []) n.set(p.species, n.get(p.species) + 1);
      const legend = SPECIES.map((s) => ({ label: s.label, color: s.color, count: n.get(s.id) }));
      const absent = _data?.absentOnly?.length ?? 0;
      legend.push({
        label: `dot = a breeding site of that species · dots side by side = several species at one site · click for the latest counts${absent ? ` · ${plural(absent, "site and species", "sites and species")} only ever recorded absent not drawn` : ""} · ${EDITION}`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    setRowControlsListener(l) {
      _rowControlsListener = typeof l === "function" ? l : null;
    },
    getStats() {
      return { count: _data?.points.length ?? 0, shown: _shown, sites: _sites?.size ?? 0, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}

export const penguinsLayer = createPenguinsLayer();
