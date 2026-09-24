/**
 * Reading a NASA GIBS layer's value at a point (grill A13/A14, stage 3). GIBS tiles are palette PNGs:
 * every opaque pixel is exactly one colour-map entry and no two entries share a colour (probe
 * 2026-09-23), so a value is an exact lookup of one pixel of the raw tile — never of the rendered
 * globe, which is alpha-blended and filtered. An unknown colour is named, never snapped to a neighbour.
 */
const MERCATOR_LIMIT = 85.0511287798;
const TILE = 256;
const WIDE = 10; // a bin wider than 10× the median is shown as a bound or a range, not a midpoint

/** 256-px web-mercator tile and pixel under a point; null beyond the mercator limit. */
export function tilePixel(lat, lon, z) {
  if (!(Math.abs(lat) <= MERCATOR_LIMIT)) return null;
  const n = 2 ** z;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const fx = ((wrapped + 180) / 360) * n;
  const fy =
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const x = Math.floor(fx),
    y = Math.floor(fy);
  return {
    x,
    y,
    px: Math.floor((fx - x) * TILE),
    py: Math.floor((fy - y) * TILE),
  };
}

/** The tile URL (a `{z}/{y}/{x}` template) and pixel for a point at zoom `z`. */
export function gibsTileRequest(template, z, lat, lon) {
  const t = tilePixel(lat, lon, z);
  if (!t) return null;
  const url = template
    .replace("{z}", String(z))
    .replace("{y}", String(t.y))
    .replace("{x}", String(t.x));
  return { url, px: t.px, py: t.py };
}

const tables = new WeakMap();
function tableOf(entry) {
  let t = tables.get(entry);
  if (t) return t;
  const classes = new Map(
    (entry.classes || []).map((c) => [c.rgb.join(","), c.label]),
  );
  const decode = entry.decode || [];
  const values = new Map(decode.map((e, i) => [e.slice(0, 3).join(","), i]));
  const widths = decode
    .filter((e) => e[3] !== null && e[4] !== null)
    .map((e) => e[4] - e[3])
    .sort((a, b) => a - b);
  const median = widths.length ? widths[Math.floor(widths.length / 2)] : 1;
  t = {
    classes,
    values,
    median,
    // from the half-width, so the midpoint of every bin prints inside it (review I1: [12,13) printed as 13)
    decimals: Math.max(0, Math.ceil(-Math.log10(median / 2))),
  };
  tables.set(entry, t);
  return t;
}

const isKelvin = (entry) => entry.ramp?.unit?.trim() === "K";

/** A value interval as text: the midpoint at the table's precision; a wide or open bin as a bound. */
export function formatValue(entry, lo, hi) {
  const t = tableOf(entry);
  const k = isKelvin(entry);
  const show = (v) => (k ? v - 273.15 : v).toFixed(t.decimals);
  const unit = k ? " °C" : entry.ramp?.unit || "";
  const decode = entry.decode || [];
  const first = decode[0],
    last = decode[decode.length - 1];
  const wide = hi === null || lo === null || hi - lo > WIDE * t.median;
  let text;
  if (!wide) text = show((lo + hi) / 2);
  else if (hi === null || (last && last[3] === lo)) text = `≥ ${show(lo)}`;
  else if (lo === null || (first && first[4] === hi)) text = `< ${show(hi)}`;
  else text = `${show(lo)} – ${show(hi)}`;
  return `${text}${unit}`;
}

/** One RGBA pixel of a GIBS tile → class, value, no data, or an unknown colour (named, never snapped). */
export function decodePixel(entry, [r, g, b, a]) {
  if (a === 0) return { kind: "nodata" };
  const key = `${r},${g},${b}`;
  const t = tableOf(entry);
  if (t.classes.has(key)) return { kind: "class", label: t.classes.get(key) };
  if (t.values.has(key)) {
    const [, , , lo, hi] = entry.decode[t.values.get(key)];
    return { kind: "value", lo, hi, text: formatValue(entry, lo, hi) };
  }
  return { kind: "unknown", rgb: [r, g, b] };
}

/** Browser default: exact pixels, no colour-space conversion or premultiplication. */
async function decodeImageDefault(blob) {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return {
    width: canvas.width,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

/**
 * `read(url, px, py) → {rgba, timeActual}`: one fetch per tile URL (LRU of `cacheSize`); a failed fetch
 * is not cached, so the next click retries. `timeActual` is GIBS's `layer-time-actual` date, if sent.
 */
export function createTilePixelReader({
  fetchImpl = (u) => fetch(u),
  decodeImage = decodeImageDefault,
  cacheSize = 32,
} = {}) {
  const cache = new Map();
  const load = async (url) => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`GIBS tile HTTP ${res.status}`);
    const image = await decodeImage(await res.blob());
    const actual = res.headers.get("layer-time-actual");
    return { image, timeActual: actual ? String(actual).slice(0, 10) : null };
  };
  return async function read(url, px, py) {
    let p = cache.get(url);
    if (p) cache.delete(url);
    else p = load(url);
    cache.set(url, p);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    let tile;
    try {
      tile = await p;
    } catch (error) {
      if (cache.get(url) === p) cache.delete(url);
      throw error;
    }
    const i = (py * tile.image.width + px) * 4;
    return {
      rgba: Array.from(tile.image.data.slice(i, i + 4)),
      timeActual: tile.timeActual,
    };
  };
}
