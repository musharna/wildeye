import * as Cesium from "cesium";
import { setStackedImagery } from "./rasterDrape.js";

/**
 * Protected areas mapped in OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0), read from Overture Maps' base theme
 * (land_use, subtype protected) and built by pipeline/protected_areas.py (spec
 * docs/superpowers/specs/2026-10-03-protected-areas-design.md). The globe shows a geographic tile pyramid in three
 * greens (strict reserve or wilderness, national park, other protection); only painted tiles exist, and a tile the
 * manifest does not list is served blank without a request. A WHAT LIVES HERE click reads the point's 1° lookup shard and
 * lists the areas whose polygons hold it, most protective and smallest first. A fixed snapshot, so not on the time bar.
 * OpenStreetMap's coverage is uneven and it is not an official registry: where nobody mapped an area, none is shown.
 */
export const MANIFEST_URL = "data/protected_areas.json";
export const TILE_FAILURE_LIMIT = 8;
export const READOUT_MAX = 3;
const TILE = 256;
const SOURCE = "© OpenStreetMap contributors (ODbL), via Overture Maps";
export const NONE_TEXT = "no protected area mapped here";

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const isGroup = (g) => g === null || (Number.isInteger(g) && g >= 1 && g <= 3);

/** null when protected_areas.json has the shape pipeline/protected_areas.py writes; otherwise what is wrong with it. */
export function validateProtectedManifest(m) {
  if (!m || typeof m !== "object") return "manifest is not an object";
  if (typeof m.release !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(m.release)) return `release ${JSON.stringify(m.release)} is not an Overture release`;
  if (!Number.isInteger(m.maxLevel) || m.maxLevel < 0) return `maxLevel ${JSON.stringify(m.maxLevel)} is not a level`;
  if (typeof m.tile !== "string" || !["{z}", "{x}", "{y}"].every((k) => m.tile.includes(k))) return `tile ${JSON.stringify(m.tile)} lacks {z}, {x} or {y}`;
  if (!m.tiles || typeof m.tiles !== "object") return "tiles is not an object";
  for (let z = 0; z <= m.maxLevel; z += 1) {
    const list = m.tiles[String(z)];
    if (!Array.isArray(list)) return `tiles has no list for level ${z}`;
    for (const t of list) {
      const ok = Array.isArray(t) && t.length === 2 && Number.isInteger(t[0]) && Number.isInteger(t[1]) && t[0] >= 0 && t[0] < 2 ** (z + 1) && t[1] >= 0 && t[1] < 2 ** z;
      if (!ok) return `tile ${JSON.stringify(t)} is not on level ${z}`;
    }
  }
  if (!Array.isArray(m.palette) || m.palette.length !== 4 || !m.palette.every(isRgb)) return "palette is not 4 RGB colours";
  if (!Array.isArray(m.groups) || m.groups.length !== 3 || !m.groups.every((g) => isGroup(g?.index) && g.index !== null && typeof g.label === "string"))
    return "groups is not 3 indexed, labelled groups";
  if (!m.classes || typeof m.classes !== "object" || !Object.values(m.classes).every((c) => isGroup(c?.group) && typeof c.label === "string"))
    return "classes is not a table of group and label";
  const deg = m.shard_degrees;
  if (!Number.isInteger(deg) || deg < 1 || 180 % deg !== 0) return `shard_degrees ${JSON.stringify(deg)} does not divide 180`;
  if (!Number.isInteger(m.coord_scale) || m.coord_scale < 1) return `coord_scale ${JSON.stringify(m.coord_scale)} is not a positive integer`;
  if (typeof m.shard !== "string" || !m.shard.includes("{lat}") || !m.shard.includes("{lon}")) return `shard ${JSON.stringify(m.shard)} lacks {lat} or {lon}`;
  if (!Array.isArray(m.shards)) return "shards is not a list";
  for (const s of m.shards) {
    const ok = Array.isArray(s) && s.length === 2 && Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[0] % deg === 0 && s[1] % deg === 0
      && s[0] >= -90 && s[0] <= 90 - deg && s[1] >= -180 && s[1] <= 180 - deg;
    if (!ok) return `shard ${JSON.stringify(s)} is not a ${deg}° cell's south-west corner`;
  }
  if (!m.counts || !Number.isInteger(m.counts.areas) || m.counts.areas < 0) return "counts lacks the number of areas";
  return null;
}

/** The shard (deg° cell) a point falls in, keyed as the pipeline writes it: south-west corner, 90°N and 180°E folded in. */
export function shardKey(lat, lon, deg) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
  // only a longitude past ±180 wraps: 180 itself folds into the last cell, as the pipeline's min(…, 180 - deg)
  const wrapped = lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
  return `${Math.min(Math.floor(lat / deg) * deg, 90 - deg)}_${Math.min(Math.floor(wrapped / deg) * deg, 180 - deg)}`;
}

/** A ring as the pipeline writes it (integers of 1/scale degree, the first pair absolute, each later one the difference
 * from the one before) → flat [lon, lat, …] degrees. */
export function decodeRing(ring, scale) {
  const out = new Array(ring.length);
  let x = 0, y = 0;
  for (let i = 0; i < ring.length; i += 2) {
    x = i ? x + ring[i] : ring[i];
    y = i ? y + ring[i + 1] : ring[i + 1];
    out[i] = x / scale;
    out[i + 1] = y / scale;
  }
  return out;
}

/** A shard with every ring decoded to degrees. */
export function decodeShard(shard, scale) {
  return { ...shard, areas: shard.areas.map((a) => ({ ...a, polygons: a.polygons.map((rings) => rings.map((r) => decodeRing(r, scale))) })) };
}

/** Whether (lon, lat) is inside a polygon given as flat rings [lon, lat, …] (exterior first): even–odd, so holes are out. */
export function inPolygon(rings, lon, lat) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The shard's areas holding the point, most protective group first, then smallest. */
export function areasAt(shard, lat, lon, classes) {
  const group = (a) => classes[a.class]?.group ?? 0;
  return shard.areas
    .filter((a) => a.polygons.some((rings) => inPolygon(rings, lon, lat)))
    .sort((a, b) => group(b) - group(a) || a.km2 - b.km2);
}

/** One area as a readout phrase: name (kind, designation) · operator · OSM id. */
export function areaText(a, classes) {
  const kind = classes[a.class]?.label ?? a.class;
  const title = a.title && a.title.toLowerCase() !== kind.toLowerCase() ? `, ${a.title}` : "";
  return `${a.name ?? "unnamed"} (${kind}${title})${a.operator ? ` · ${a.operator}` : ""} · OSM ${a.osm}`;
}

export function readoutText(found, classes) {
  if (!found.length) return NONE_TEXT;
  const shown = found.slice(0, READOUT_MAX).map((a) => areaText(a, classes));
  return found.length > READOUT_MAX ? `${shown.join("; ")}; +${found.length - READOUT_MAX} more` : shown.join("; ");
}

let _blank = null;
const blankTile = () => {
  if (!_blank) {
    _blank = document.createElement("canvas");
    _blank.width = TILE;
    _blank.height = TILE;
  }
  return _blank;
};

/** The provider, with tiles the manifest does not list answered by a blank image instead of a request (they were never written). */
export function listedTilesOnly(provider, listed, blank = blankTile) {
  const fetchTile = provider.requestImage.bind(provider);
  provider.requestImage = (x, y, level, request) => (listed.has(`${level}/${x}/${y}`) ? fetchTile(x, y, level, request) : Promise.resolve(blank()));
  return provider;
}

const n = (v) => v.toLocaleString("en-US");

export function createProtectedAreasLayer({
  id = "protected-areas",
  name = "Protected areas (OpenStreetMap)",
  icon = "🛡️",
  fetchImpl = (u) => fetch(u),
  providerFor = (options) => new Cesium.UrlTemplateImageryProvider(options),
  imageryLayerFor = (provider) => new Cesium.ImageryLayer(provider),
  stack = setStackedImagery,
  blank = blankTile,
  zrank = 23,
} = {}) {
  let _viewer = null,
    _imagery = null,
    _enabled = false,
    _manifest = null,
    _listed = null,
    _shardSet = null,
    _shards = new Map(), // key → Promise of the shard; a failed fetch is dropped so the next click retries
    _lastUpdate = null,
    _lastError = null,
    _tileFailures = 0,
    _generation = 0;

  const drop = () => {
    if (!_imagery || !_viewer) return;
    stack(_viewer.imageryLayers, id, null);
    _viewer.imageryLayers.remove(_imagery, true);
    _imagery = null;
  };

  const draw = () => {
    drop();
    _generation += 1;
    _tileFailures = 0;
    _lastError = null;
    const generation = _generation;
    const provider = listedTilesOnly(
      providerFor({
        // the release query busts tiles cached from an earlier build
        url: `${_manifest.tile}?v=${_manifest.release}`,
        tilingScheme: new Cesium.GeographicTilingScheme(),
        tileWidth: TILE,
        tileHeight: TILE,
        maximumLevel: _manifest.maxLevel,
        credit: SOURCE,
      }),
      _listed,
      blank,
    );
    // only listed tiles are requested, and every one was written: any tile error is a fault
    provider.errorEvent.addEventListener((tileError) => {
      if (generation !== _generation) return;
      _tileFailures += 1;
      if (_tileFailures === TILE_FAILURE_LIMIT) {
        _lastError = "map tiles failing";
        console.error(`[Data:${id}] tiles failing`, { error: tileError?.error ?? tileError });
      }
    });
    _imagery = imageryLayerFor(provider);
    _imagery.show = _enabled;
    _viewer.imageryLayers.add(_imagery);
    stack(_viewer.imageryLayers, id, _imagery, zrank);
  };

  const load = async () => {
    try {
      const res = await fetchImpl(MANIFEST_URL);
      if (!res.ok) {
        _lastError = `protected_areas.json HTTP ${res.status}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      const m = await res.json();
      const bad = validateProtectedManifest(m);
      if (bad) {
        _lastError = `Malformed protected_areas.json: ${bad}`;
        console.error(`[Data:${id}] ${_lastError}`);
        return false;
      }
      _manifest = m;
      _listed = new Set(Object.entries(m.tiles).flatMap(([z, list]) => list.map(([x, y]) => `${z}/${x}/${y}`)));
      _shardSet = new Set(m.shards.map(([lat, lon]) => `${lat}_${lon}`));
      return true;
    } catch (e) {
      _lastError = `protected_areas.json load error: ${e?.message || e}`;
      console.error(`[Data:${id}] ${_lastError}`, e);
      return false;
    }
  };

  const shard = (key) => {
    let p = _shards.get(key);
    if (!p) {
      const [lat, lon] = key.split("_");
      const url = `${_manifest.shard.replace("{lat}", lat).replace("{lon}", lon)}?v=${_manifest.release}`;
      p = Promise.resolve(fetchImpl(url)).then(async (res) => {
        if (!res.ok) throw new Error(`shard ${key} HTTP ${res.status}`);
        return decodeShard(await res.json(), _manifest.coord_scale);
      });
      p.catch(() => {
        if (_shards.get(key) === p) _shards.delete(key);
      });
      _shards.set(key, p);
    }
    return p;
  };

  return {
    id,
    name,
    icon,
    source: "OpenStreetMap protected areas via Overture Maps · © OpenStreetMap contributors, ODbL 1.0",
    updateInterval: 24 * 3600000,
    init(viewer) {
      _viewer = viewer;
    },
    enable() {
      _enabled = true;
      if (_imagery) _imagery.show = true;
    },
    disable() {
      _enabled = false;
      if (_imagery) _imagery.show = false;
    },
    async update() {
      if (!_viewer) return false;
      if (!_manifest && !(await load())) return false;
      if (!_imagery || _lastError === "map tiles failing") draw();
      else _imagery.show = _enabled;
      _lastUpdate = Date.now();
      return true;
    },
    destroy() {
      drop();
      _viewer = null;
      _enabled = false;
    },
    getRowControls() {
      if (!_manifest) return { chips: [], legend: [] };
      const legend = _manifest.groups.map((g) => ({ label: g.label, color: `rgb(${_manifest.palette[g.index].join(",")})`, count: _manifest.counts.by_group?.[g.key] ?? null }));
      const small = _manifest.counts.unpainted_at_max_level ?? 0;
      legend.push({
        label: `${n(_manifest.counts.areas)} protected areas mapped in OpenStreetMap (Overture ${_manifest.release})${small ? `, ${n(small)} of them too small to show at about 600 m (a WHAT LIVES HERE click still finds them)` : ""}; OpenStreetMap's coverage is uneven and it is not an official registry · © OpenStreetMap contributors, ODbL`,
        color: "transparent",
        count: null,
      });
      return { chips: [], legend };
    },
    /** The protected areas at a point, from its 5° shard; null when off. */
    async readoutAt(lat, lon) {
      if (!_enabled) return null;
      const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
      if (!_manifest) return row("error", { error: _lastError || "protected_areas.json not loaded yet" });
      const key = shardKey(lat, lon, _manifest.shard_degrees);
      if (!key) return row("outside");
      const date = `OpenStreetMap via Overture ${_manifest.release}`;
      if (!_shardSet.has(key)) return row("value", { text: NONE_TEXT, date });
      let s;
      try {
        s = await shard(key);
      } catch (e) {
        console.error(`[Data:${id}] readout failed`, { lat, lon, key, error: e });
        return row("error", { error: e?.message || String(e) });
      }
      return row("value", { text: readoutText(areasAt(s, lat, lon, _manifest.classes), _manifest.classes), date });
    },
    getStats() {
      return { count: _manifest?.counts.areas ?? 0, lastUpdate: _lastUpdate, error: _lastError, time: _manifest?.release ?? null };
    },
  };
}

export const protectedAreasLayer = createProtectedAreasLayer();
