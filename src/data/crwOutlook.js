import { createRasterDrapeLayer } from './rasterDrape.js';

/**
 * NOAA Coral Reef Watch Four-Month Coral Bleaching Heat Stress Outlook (v5, CFSv2, 0.5°): the newest weekly issue,
 * drawn as the stress level reached by at least 60% of the model runs (pipeline/crw_outlook.py; spec
 * docs/superpowers/specs/2026-10-03-crw-outlook-design.md). A click reads the cell's level at 60% and at 90% from the
 * pipeline's readout image (R = 60%, G = 90%, 255 = not covered), so the readout is the file's class, not a colour
 * read back off the drape. A forecast, not an observation: it is not on the time bar and always shows the newest issue.
 */
export const LEVELS = Object.freeze(['no stress', 'Watch', 'Warning', 'Alert Level 1', 'Alert Level 2']);
export const NOT_COVERED = 255;
const WIDTH = 720, HEIGHT = 360; // the 0.5° grid, -180..180 west to east, 90..-90 north to south

/** Row-major index of the 0.5° cell holding a point; the antimeridian and the poles fall in the edge cells. */
export function cellIndex(lat, lon) {
  const x = Math.min(WIDTH - 1, Math.floor((((lon + 180) % 360) + 360) % 360 / 0.5));
  const y = Math.min(HEIGHT - 1, Math.max(0, Math.floor((90 - lat) / 0.5)));
  return y * WIDTH + x;
}

/**
 * The cell's outlook in words. The level at P% is the highest level that at least P% of the model runs reach, so 0 at
 * 90% means fewer than 90% reach even Watch, not that 90% predict no stress.
 */
export function outlookText(low, high, [pLow, pHigh] = [60, 90]) {
  if (low === 0) return `No stress: fewer than ${pLow}% of model runs reach Watch`;
  if (low === high) return `${LEVELS[low]} reached by ${pHigh}% of model runs`;
  const second = high === 0 ? `fewer than ${pHigh}% reach Watch` : `${LEVELS[high]} by ${pHigh}%`;
  return `${LEVELS[low]} reached by ${pLow}% of model runs; ${second}`;
}

async function decodeInBrowser(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`outlook readout image HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
}

export function createCrwOutlookLayer({ fetchImpl = (u) => fetch(u), decodeImage = decodeInBrowser, ...drapeOptions } = {}) {
  const drape = createRasterDrapeLayer({
    id: 'crw-outlook', name: 'Coral bleaching heat stress outlook, next four months', icon: '🔮', source: 'NOAA Coral Reef Watch',
    alpha: 0.75, zrank: 85, ...drapeOptions,
  });
  let enabled = false;
  let grid = null; // { key, image } for the issue last read
  const enable = drape.enable.bind(drape), disable = drape.disable.bind(drape);
  drape.enable = () => { enabled = true; enable(); };
  drape.disable = () => { enabled = false; disable(); };

  /** The level at 60% and at 90% for the cell under a point, from the newest issue; null when the layer is off. */
  drape.readoutAt = async (lat, lon) => {
    if (!enabled) return null;
    const { id, name, icon } = drape;
    const row = (status, extra = {}) => ({ id, name, icon, status, text: null, date: null, ...extra });
    const o = drape.getEntry()?.outlook;
    if (!o) return row('gap');
    if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) return row('outside');
    const date = `outlook ${o.start} to ${o.end}`;
    try {
      const key = `${o.data_png}?${o.icwk}`;
      if (grid?.key !== key) grid = { key, image: await decodeImage(key, fetchImpl) };
      const { width, height, data } = grid.image;
      if (width !== WIDTH || height !== HEIGHT) throw new Error(`outlook readout image is ${width}×${height}, not ${WIDTH}×${HEIGHT}`);
      const i = cellIndex(lat, lon) * 4;
      const [low, high] = [data[i], data[i + 1]];
      if (low === NOT_COVERED && high === NOT_COVERED) return row('nodata', { date });
      if (!(low <= 4 && high <= 4 && high <= low)) throw new Error(`outlook readout cell has levels ${low}/${high}`);
      return row('value', { date, text: outlookText(low, high, o.probabilities) });
    } catch (e) {
      // a failed fetch or decode never reaches `grid`, so the next click reads again
      console.error(`[Data:${id}] readout failed`, { lat, lon, png: o.data_png, error: e });
      return row('error', { date, error: e?.message || String(e) });
    }
  };
  return drape;
}

export const crwOutlookLayer = createCrwOutlookLayer();
