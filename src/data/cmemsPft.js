import { createRasterDrapeLayer } from './rasterDrape.js';
import { decodePng } from './pngDecode.js';

/**
 * Dominant phytoplankton group, monthly, from Copernicus-GlobColour (pipeline/cmems_pft.py; spec
 * docs/superpowers/specs/2026-10-07-cmems-phytoplankton-types.md): each 0.25° cell drawn in the colour of the group
 * with the most chlorophyll a in that month's satellite estimate. A click reads the cell from the frame on show and
 * maps its exact colour back to the manifest's classes, so the readout is the class the pipeline painted. Clear cells
 * had no estimate that month (land, cloud, sea ice, polar night). Monthly frames are on the time bar.
 */
export const WIDTH = 1440, HEIGHT = 720; // the 0.25° grid, -180..180 west to east, 90..-90 north to south
export const NO_ESTIMATE = 'no satellite estimate: land, or no clear view this month (cloud, sea ice, polar night)';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Row-major index of the 0.25° cell holding a point; the antimeridian and the poles fall in the edge cells. */
export function cellIndex(lat, lon) {
  const x = Math.min(WIDTH - 1, Math.floor(((((lon + 180) % 360) + 360) % 360) / 0.25));
  const y = Math.min(HEIGHT - 1, Math.max(0, Math.floor((90 - lat) / 0.25)));
  return y * WIDTH + x;
}

/** "2026-09-01T00:00:00Z" → "September 2026": a frame is the mean of the month it is stamped with. */
export function monthLabel(iso) {
  const m = /^(\d{4})-(\d{2})-/.exec(String(iso ?? ''));
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

/** The class label a pixel was painted in; NO_ESTIMATE when clear; throws on any other colour. */
export function classOfPixel(classes, [r, g, b, a]) {
  if (a === 0) return NO_ESTIMATE;
  const hit = a === 255 ? (classes || []).find((c) => c.rgb[0] === r && c.rgb[1] === g && c.rgb[2] === b) : null;
  if (!hit) throw new Error(`phytoplankton cell colour ${r},${g},${b},${a} is not a class colour`);
  return hit.label;
}

async function fetchAndDecode(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`phytoplankton frame HTTP ${res.status}`);
  return decodePng(new Uint8Array(await res.arrayBuffer()));
}

export function createCmemsPftLayer({ fetchImpl = (u) => fetch(u), decodeImage = fetchAndDecode, ...drapeOptions } = {}) {
  const drape = createRasterDrapeLayer({
    id: 'cmems-pft', name: 'Dominant phytoplankton group', icon: '🔬', source: 'E.U. Copernicus Marine Service',
    alpha: 0.7, zrank: 21, ...drapeOptions,
  });
  let enabled = false;
  let grid = null; // { key, image } for the frame last read
  const enable = drape.enable.bind(drape), disable = drape.disable.bind(drape);
  drape.enable = () => { enabled = true; enable(); };
  drape.disable = () => { enabled = false; disable(); };

  /** The dominant group of the cell under a point in the frame on show; null when the layer is off. */
  drape.readoutAt = async (lat, lon) => {
    if (!enabled) return null;
    const { id, name, icon } = drape;
    const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
    const entry = drape.getEntry();
    if (!entry) return row('gap');
    const frame = drape._target(entry);
    if (!frame) return row('gap', { observed: drape.getStats().observed });
    if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) return row('outside');
    const date = monthLabel(frame.time);
    try {
      const key = `${frame.png}?t=${frame.time}`;
      if (grid?.key !== key) grid = { key, image: await decodeImage(key, fetchImpl) };
      const { width, height, data } = grid.image;
      if (width !== WIDTH || height !== HEIGHT) throw new Error(`phytoplankton frame is ${width}×${height}, not ${WIDTH}×${HEIGHT}`);
      const i = cellIndex(lat, lon) * 4;
      return row('class', { date, text: classOfPixel(entry.classes, data.subarray(i, i + 4)) });
    } catch (e) {
      // a failed fetch or decode never reaches `grid`, so the next click reads again
      console.error(`[Data:${id}] readout failed`, { lat, lon, png: frame.png, error: e });
      return row('error', { date, error: e?.message || String(e) });
    }
  };
  return drape;
}

export const cmemsPftLayer = createCmemsPftLayer();
