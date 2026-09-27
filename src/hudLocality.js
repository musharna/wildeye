/**
 * @module hudLocality
 * @description The locality half of the HUD summary line: the camera's
 * hemisphere-tagged "<lat> <lon>".
 *
 * Split out of `hud.js` so it is unit-testable on its own.
 */

/**
 * Format one hemisphere-tagged coordinate, e.g. `21.33N` / `157.80W`.
 * @param {number} value Signed decimal degrees.
 * @param {string} positive Suffix when the value is >= 0.
 * @param {string} negative Suffix when the value is < 0.
 * @returns {string}
 */
function coordinateTag(value, positive, negative) {
  return `${Math.abs(value).toFixed(2)}${value >= 0 ? positive : negative}`;
}

/**
 * Build the locality tag for the HUD summary line.
 * @param {number} latDeg Camera latitude in decimal degrees.
 * @param {number} lonDeg Camera longitude in decimal degrees.
 * @returns {string} `<lat> <lon>`, e.g. `21.31N 157.86W`.
 */
export function composeLocalityTag(latDeg, lonDeg) {
  return `${coordinateTag(latDeg, 'N', 'S')} ${coordinateTag(lonDeg, 'E', 'W')}`;
}
