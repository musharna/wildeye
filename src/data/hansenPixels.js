/**
 * Pixels of the Global Forest Watch tree-cover-loss DATA tiles (Hansen/UMD GFC v1.12, 30% canopy). No Cesium
 * import: the recolour worker loads this module too.
 *
 * Encoding (probed 2026-09-25, `…/umd_tree_cover_loss/v1.12/dynamic/{z}/{x}/{y}.png?implementation=tcd_30`):
 * alpha 0 = no loss; otherwise blue = loss year − 2000 (1–24), red = intensity (255 at full resolution, an
 * average when zoomed out), green = 0. The tiles are data, not a picture, so they are recoloured before drawing.
 */
export const FIRST_YEAR = 2001;
export const LAST_YEAR = 2024;
const LAST_CODE = LAST_YEAR - 2000;

/** One raw RGBA pixel → loss year, no loss, or an unrecognised value (named, never guessed). */
export function decodeLossPixel([r, g, b, a]) {
  if (a === 0) return { kind: "none" };
  if (g !== 0 || b < 1 || b > LAST_CODE) return { kind: "unknown", rgba: [r, g, b, a] };
  return { kind: "loss", year: 2000 + b };
}

/** The highest year code drawn at an observed instant: its year (null = live = all years). */
export function maxCodeFor(iso) {
  if (!iso) return LAST_CODE;
  const year = Number(String(iso).slice(0, 4));
  return Math.max(0, Math.min(LAST_CODE, year - 2000));
}

// yellow → orange → deep red, the first loss year to the last
const STOPS = [
  [253, 224, 71],
  [234, 88, 12],
  [127, 29, 29],
];

/** Ramp colour of a loss year, [r, g, b]. */
export function rampColour(year) {
  if (!(year >= FIRST_YEAR && year <= LAST_YEAR)) throw new Error(`no ramp colour for ${year}: loss years are ${FIRST_YEAR}–${LAST_YEAR}`);
  const t = ((year - FIRST_YEAR) / (LAST_YEAR - FIRST_YEAR)) * (STOPS.length - 1);
  const i = Math.min(Math.floor(t), STOPS.length - 2);
  const f = t - i;
  return STOPS[i].map((c, k) => Math.round(c + (STOPS[i + 1][k] - c) * f));
}

const RAMP = new Uint8Array((LAST_CODE + 1) * 3);
for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) RAMP.set(rampColour(y), (y - 2000) * 3);

/** In place: loss up to `maxCode` takes its ramp colour with alpha = intensity; everything else transparent. */
export function recolourPixels(data, maxCode) {
  for (let i = 0; i < data.length; i += 4) {
    const code = data[i + 2];
    if (data[i + 3] === 0 || data[i + 1] !== 0 || code < 1 || code > maxCode) {
      data[i + 3] = 0;
      continue;
    }
    data[i + 3] = data[i];
    data[i] = RAMP[code * 3];
    data[i + 1] = RAMP[code * 3 + 1];
    data[i + 2] = RAMP[code * 3 + 2];
  }
  return data;
}
