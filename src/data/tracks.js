import * as Cesium from "cesium";
import { extentFromTimes, pluck } from "./observedExtent.js";

/**
 * Animal tracks (track contract): one polyline per segment of a tagged animal's
 * deployment, written by pipeline/tracks.py (IOOS ATN + curated Movebank studies). Colour
 * and chips are by animal group (GROUP_COLORS, fixed per group so a colour always means the
 * same kind of animal); the species is in the info box and the readout. A file with a track
 * outside the five groups is refused loudly and the last good load stays. With the shared observed time set inside a
 * track's span, the track is drawn only up to that instant with a head marker
 * interpolated inside the segment; tracks that do not span the instant are shown
 * faded. Never interpolates across a gap (segments are already split there).
 * While the time bar plays, the in-span set glides from each tick's instant to the next over the tick
 * (docs/superpowers/specs/2026-10-01-tracks-glide-design.md): its positions and shows are callbacks of an
 * animated instant, through the same clipSegmentMs, so every frame draws what a paused bar at that instant draws.
 */
const DATA_URL = "data/tracks.geojson";

/** Legend order = pipeline/tracks.py GROUPS. */
export const GROUP_COLORS = Object.freeze({
  "whales & dolphins": "#4fc3f7",
  seals: "#ce93d8",
  "land mammals": "#ffb74d",
  birds: "#fff176",
  reptiles: "#aed581",
});
const FADED = 0.22;

export function groupColor(group) {
  const css = GROUP_COLORS[group];
  if (!css) throw new Error(`tracks: no colour for group ${JSON.stringify(group)}`);
  return Cesium.Color.fromCssColorString(css);
}

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function describeTrack(p) {
  const link = p.url
    ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.source_name || p.source)}</a>`
    : esc(p.source_name || p.source);
  return (
    `<b>${esc(p.species)}</b> <i>${esc(p.sci || "")}</i><br>` +
    `tag ${esc(p.animal)} · ${esc(p.start?.slice(0, 10))} → ${esc(p.end?.slice(0, 10))} · ${p.n} fixes` +
    (p.segment ? ` · segment ${p.segment + 1}` : "") +
    `<br>` +
    `${esc(p.institution || "")}<br>` +
    (p.citation ? `<small>${esc(p.citation)}</small><br>` : "") +
    `${link} · ${esc(p.license ? String(p.license).split(",")[0] : "licence unknown")}`
  );
}

/**
 * Positions of a segment up to `tMs` (pure). Returns null when the instant is before the
 * first fix; the full segment when at/after the last; otherwise the fixes at or before
 * `tMs` plus the interpolated head. `times` are ISO strings parallel to `coords`.
 */
export function clipSegment(coords, times, tMs) {
  return clipSegmentMs(coords, times.map((t) => Date.parse(t)), tMs);
}

/** clipSegment with the fix times already parsed to epoch ms (the layer parses each file once, not every step). */
export function clipSegmentMs(coords, ts, tMs) {
  const n = Math.min(coords.length, ts.length);
  if (n === 0) return null;
  if (!Number.isFinite(tMs) || tMs < ts[0]) return null;
  if (tMs >= ts[n - 1])
    return { coords: coords.slice(0, n), head: coords[n - 1], complete: true };
  let i = 0;
  while (i + 1 < n && ts[i + 1] <= tMs) i++;
  const f = (tMs - ts[i]) / Math.max(1, ts[i + 1] - ts[i]);
  const head = [
    coords[i][0] + f * (coords[i + 1][0] - coords[i][0]),
    coords[i][1] + f * (coords[i + 1][1] - coords[i][1]),
  ];
  return { coords: [...coords.slice(0, i + 1), head], head, complete: false };
}

/** `clock` (ms, monotonic) drives the glide between play ticks; tests pass their own. */
export function createTracksLayer({ clock = () => performance.now() } = {}) {
  let _dataSource = null;
  let _features = [];
  let _groups = []; // groups present, legend order
  let _species = [];
  let _visible = {}; // group → bool
  let _counts = {}; // group → segments
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _observedMs = null;
  let _motion = null; // { stepMs, tickMs } while the time bar plays, else null
  let _rowControlsListener = null;
  // Built once per load (and again only when the time bar is switched on or off): one base line per segment,
  // full length, bright with no observed time and faded with one. A time step then touches only the segments in
  // span at the instant: their base line is hidden and a separate ":live" line (clipped, bright) plus head drawn.
  // Cesium rebuilds a whole batch when one line in it changes, so the ~1,100 base lines never change on a step;
  // only the small in-span set (≤44 of 1,114 per weekly step, median 0) is rebuilt.
  let _ts = []; // feature → fix times in epoch ms, parsed once per load
  let _base = []; // feature → base line entity (null when the segment has < 2 fixes)
  let _live = new Map(); // feature → { line, head } while the observed time is inside its span
  // Base lines whose segment enters or leaves its span inside the playing tick: their show is a callback.
  let _baseDyn = new Set();

  const isShown = (i) => _visible[_features[i].properties.group] !== false;

  const pointGraphics = (color, alpha) => ({
    pixelSize: 7,
    color: color.withAlpha(alpha),
    outlineColor: Cesium.Color.BLACK.withAlpha(0.7 * alpha),
    outlineWidth: 1,
    disableDepthTestDistance: 50_000, // as neon/otn/occurrences: never through the Earth
  });
  const toCartesians = (coords) => coords.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 0));

  const inSpan = (i, a) => {
    const ts = _ts[i];
    const n = Math.min(_features[i].geometry.coordinates.length, ts.length);
    return ts[0] <= a && a < ts[n - 1];
  };
  const resetShow = (graphics) => {
    if (graphics.show !== undefined) graphics.show = undefined;
  };

  /**
   * Bring the in-span set up to _observedMs: add, move or drop only the segments whose state changed. While playing,
   * the set is every segment that covers some moment of the tick [t0, t0 + step], drawn by callbacks of the animated
   * instant `at()`, which runs from t0 to the next tick's instant over one tick and then holds.
   */
  const step = () => {
    if (!_dataSource || _observedMs === null) return;
    const es = _dataSource.entities;
    const m = _motion;
    const t0 = _observedMs;
    const t1 = m ? t0 + m.stepMs : t0;
    const c0 = m ? clock() : 0;
    const at = m ? () => t0 + (t1 - t0) * Math.min(1, Math.max(0, (clock() - c0) / m.tickMs)) : () => t0;
    const now = new Set();
    _features.forEach((f, i) => {
      const ts = _ts[i];
      const n = Math.min(f.geometry.coordinates.length, ts.length);
      if (_base[i] && n >= 2 && ts[0] <= t1 && t0 < ts[n - 1]) now.add(i);
    });
    es.suspendEvents();
    for (const [i, { line, head }] of _live) {
      if (now.has(i)) continue;
      es.remove(line);
      es.remove(head);
      _base[i].show = isShown(i);
      if (_baseDyn.delete(i)) resetShow(_base[i].polyline);
      _live.delete(i);
    }
    for (const i of now) {
      const coords = _features[i].geometry.coordinates;
      const ts = _ts[i];
      let positions, headPos;
      if (m) {
        const cart = toCartesians(coords);
        let lastA = NaN;
        let last = null;
        const clipNow = () => {
          const a = at();
          if (a !== lastA) [lastA, last] = [a, clipSegmentMs(coords, ts, a)];
          return last;
        };
        positions = new Cesium.CallbackProperty(() => {
          const c = clipNow();
          if (!c) return [];
          if (c.complete) return cart;
          return [...cart.slice(0, c.coords.length - 1), Cesium.Cartesian3.fromDegrees(c.head[0], c.head[1], 0)];
        }, false);
        headPos = new Cesium.CallbackPositionProperty(() => {
          const h = clipNow()?.head ?? coords[0];
          return Cesium.Cartesian3.fromDegrees(h[0], h[1], 0);
        }, false);
      } else {
        const c = clipSegmentMs(coords, ts, t0);
        positions = toCartesians(c.coords);
        headPos = Cesium.Cartesian3.fromDegrees(c.head[0], c.head[1], 0);
      }
      let had = _live.get(i);
      if (!had) {
        const p = _features[i].properties;
        const color = groupColor(p.group);
        const show = isShown(i);
        const id = _base[i].id;
        const line = es.add({
          id: `${id}:live`,
          show,
          polyline: { positions, width: 3, material: color, clampToGround: false, arcType: Cesium.ArcType.GEODESIC },
          description: describeTrack(p),
          properties: { ...p, kind: "track" },
        });
        const head = es.add({
          id: `${id}:head`,
          show,
          position: headPos,
          point: pointGraphics(color, 1),
          description: describeTrack(p),
          properties: { ...p, kind: "head" },
        });
        had = { line, head, dyn: false }; // dyn: its shows are callbacks of the playing tick
        _live.set(i, had);
      } else {
        had.line.polyline.positions = positions;
        had.head.position = headPos;
      }
      const n = Math.min(coords.length, ts.length);
      if (m && !(ts[0] <= t0 && t1 < ts[n - 1])) {
        // enters or leaves its span inside this tick: the live line and head show while it is in span, the faded
        // base line while it is not
        const live = new Cesium.CallbackProperty(() => inSpan(i, at()), false);
        had.line.polyline.show = live;
        had.head.point.show = live;
        had.dyn = true;
        _base[i].polyline.show = new Cesium.CallbackProperty(() => !inSpan(i, at()), false);
        _base[i].show = isShown(i);
        _baseDyn.add(i);
      } else {
        if (had.dyn) {
          resetShow(had.line.polyline);
          resetShow(had.head.point);
          had.dyn = false;
        }
        if (_baseDyn.delete(i)) resetShow(_base[i].polyline);
        _base[i].show = false;
      }
    }
    es.resumeEvents();
  };

  /** Rebuild everything: on load, and when the observed time is switched on or off (every base line restyles). */
  const rebuild = () => {
    if (!_dataSource) return;
    const es = _dataSource.entities;
    es.suspendEvents();
    es.removeAll();
    _live = new Map();
    _baseDyn = new Set();
    _base = [];
    const timed = _observedMs !== null;
    const lastSeg = {}; // dataset → highest segment index: the head dot marks the last fix once per deployment
    for (const f of _features) { const q = f.properties || {}; lastSeg[q.dataset] = Math.max(lastSeg[q.dataset] ?? -1, q.segment ?? 0); }
    _features.forEach((f, i) => {
      const p = f.properties || {};
      const coords = f.geometry.coordinates;
      _base[i] = null;
      if (coords.length < 2) return;
      const color = groupColor(p.group);
      const alpha = timed ? FADED : 1;
      const id = `trk:${p.dataset}:${p.segment}:${i}`;
      const show = _visible[p.group] !== false;
      _base[i] = es.add({
        id,
        show,
        polyline: {
          positions: toCartesians(coords),
          width: 2,
          material: color.withAlpha(alpha),
          clampToGround: false,
          arcType: Cesium.ArcType.GEODESIC,
        },
        description: describeTrack(p),
        properties: { ...p, kind: "track" },
      });
      if (!timed && (p.segment ?? 0) === lastSeg[p.dataset]) {
        const head = coords[coords.length - 1];
        es.add({
          id: `${id}:head`,
          show,
          position: Cesium.Cartesian3.fromDegrees(head[0], head[1], 0),
          point: pointGraphics(color, 1),
          description: describeTrack(p),
          properties: { ...p, kind: "head" },
        });
      }
    });
    es.resumeEvents();
    step();
  };

  const applyVisibility = () => {
    if (!_dataSource) return;
    for (const e of _dataSource.entities.values) {
      const g = e.properties?.group?.getValue?.();
      e.show = _visible[g] !== false;
    }
    // an in-span segment is drawn by its live line; one entering or leaving its span mid-tick shows its base by callback
    for (const i of _live.keys()) if (!_baseDyn.has(i)) _base[i].show = false;
  };

  const layer = {
    id: "tracks",
    name: "Animal tracks (IOOS ATN + Movebank)",
    icon: "🦭",
    source: "IOOS Animal Telemetry Network + curated Movebank studies (per-track licence + citation)",
    updateInterval: 6 * 3600000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource("tracks");
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _features = [];
      _groups = [];
      _species = [];
      _visible = {};
      _counts = {};
      _lastError = null;
      _lastUpdate = null;
      console.log("[Data:Tracks] Initialized");
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
          _lastError = `tracks.geojson HTTP ${res.status}`;
          return false;
        }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) {
          _lastError = "Malformed tracks.geojson";
          return false;
        }
        const ungrouped = gj.features.filter((f) => !(f.properties?.group in GROUP_COLORS)).length;
        if (ungrouped) {
          _lastError = `tracks.geojson: ${ungrouped} of ${gj.features.length} tracks have no known group`;
          console.warn(`[Data:Tracks] ${_lastError}`);
          return false;
        }
        const counts = {};
        for (const f of gj.features) {
          const g = f.properties.group;
          counts[g] = (counts[g] || 0) + 1;
          if (!(g in _visible)) _visible[g] = true;
        }
        _features = gj.features;
        _ts = _features.map((f) => (f.properties.times || []).map((t) => Date.parse(t)));
        _groups = Object.keys(GROUP_COLORS).filter((g) => g in counts);
        _species = [...new Set(gj.features.map((f) => f.properties?.species ?? "unknown"))].sort();
        _counts = counts;
        _generatedAt = gj.generated_at ?? null;
        _lastUpdate = Date.now();
        _lastError = null;
        rebuild();
        _rowControlsListener?.();
        console.log(
          `[Data:Tracks] Updated: ${_features.length} segments, ${_species.length} species in ${_groups.length} groups`,
        );
        return true;
      } catch (e) {
        _dataSource?.entities.resumeEvents();
        console.warn("[Data:Tracks] Load error:", e);
        _lastError = `tracks.geojson load error: ${e?.message || e}`;
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

    /** Shared observed-time hook: clip tracks to the instant, fade tracks outside their span. */
    /**
     * Shared observed-time hook: the span this layer can serve, read off the first and last fix of every track — archived telemetry reaches back years.
     * The bar's domain is the union of these across enabled layers (src/observedTime.js).
     */
    getObservedExtent() {
      return extentFromTimes([...pluck(_features, "start"), ...pluck(_features, "end")]);
    },

    /** `motion` is the time bar's play state (observedTime.playState()): while playing, glide to the next step over one tick. */
    setObservedTime(iso, motion) {
      const ms = iso ? Date.parse(iso) : null;
      if (iso && !Number.isFinite(ms)) return false;
      const playing = !!motion?.playing && ms !== null;
      if (playing && !(Number.isFinite(motion.stepMs) && motion.stepMs > 0 && Number.isFinite(motion.tickMs) && motion.tickMs > 0))
        throw new Error(`tracks: play needs a positive finite step and tick, got ${JSON.stringify(motion)}`);
      const m = playing ? { stepMs: motion.stepMs, tickMs: motion.tickMs } : null;
      if (ms === _observedMs && m?.stepMs === _motion?.stepMs && m?.tickMs === _motion?.tickMs) return true;
      const wasTimed = _observedMs !== null;
      _observedMs = ms;
      _motion = m;
      if (wasTimed !== (ms !== null)) rebuild();
      else step();
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
        applyVisibility();
        _rowControlsListener?.();
      }
      return changed;
    },
    getParams() {
      return { ..._visible };
    },
    getRowControls() {
      const chips = _groups.map((g) => ({
        id: g,
        label: `${g.toUpperCase()} ${_counts[g] ?? 0}`,
        active: _visible[g] !== false,
        state: _visible[g] !== false ? "active" : "idle",
        title: `${_visible[g] !== false ? "Hide" : "Show"} ${g}`,
        params: { [g]: !(_visible[g] !== false) },
      }));
      const legend = _groups.map((g) => ({
        label: g,
        color: GROUP_COLORS[g],
        count: null,
      }));
      legend.push({
        label:
          _observedMs === null
            ? "dot = last fix"
            : "dot = position at the observed time · faded = outside the track's dates",
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
        .filter((e) => e.show && e.point?.show?.getValue?.(now) !== false && e.properties?.kind?.getValue?.(now) === "head")
        .slice(0, maxCount)
        .map((e) => {
          const g = (k) => e.properties?.[k]?.getValue(now);
          return {
            id: e.id,
            species: g("species"),
            group: g("group"),
            sci: g("sci"),
            animal: g("animal"),
            start: g("start"),
            end: g("end"),
            n: g("n"),
          };
        });
    },

    getStats() {
      return {
        count: _features.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        generatedAt: _generatedAt,
        species: _species.length,
        observed:
          _observedMs === null ? null : new Date(_observedMs).toISOString(),
      };
    },
  };
  return layer;
}

const tracksLayer = createTracksLayer();
export default tracksLayer;
