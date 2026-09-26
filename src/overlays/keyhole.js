/**
 * Keyhole fade for world-overlay labels: full opacity inside a centred circle, fading to a floor
 * outside it. Moved out of the removed celestial ring (2026-09-26) so the world overlay keeps its
 * behaviour until the overlay itself is removed in the bloat sweep.
 */

/** Outer edge of the keyhole in normalized shader space. */
export const KEYHOLE_OUTER_RADIUS = 1.05;
/** Responsive radial fade band for keyhole-aligned text overlays (0.07 since 2026-08-24). */
export const KEYHOLE_LABEL_FEATHER_RATIO = 0.07;
export const KEYHOLE_LABEL_FEATHER_MAX_RATIO = 0.4;
/** First-run OUTSIDE opacity for keyhole-aligned world overlays (0.01 since 2026-08-24). */
export const KEYHOLE_OUTSIDE_OPACITY_DEFAULT = 0.01;

let keyholeFadeRatio = KEYHOLE_LABEL_FEATHER_RATIO;
let keyholeOutsideOpacity = KEYHOLE_OUTSIDE_OPACITY_DEFAULT;

/** Clamp a number to an inclusive range. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Update the shared fade distance and outside-opacity floor. */
export function setKeyholeFadeTuning({ fadeRatio, outsideOpacity } = {}) {
  if (Number.isFinite(fadeRatio)) {
    keyholeFadeRatio = clamp(fadeRatio, 0, KEYHOLE_LABEL_FEATHER_MAX_RATIO);
  }
  if (Number.isFinite(outsideOpacity)) {
    keyholeOutsideOpacity = clamp(outsideOpacity, 0, 1);
  }
  return getKeyholeFadeTuning();
}

/** Read the current normalized keyhole fade settings. */
export function getKeyholeFadeTuning() {
  return { fadeRatio: keyholeFadeRatio, outsideOpacity: keyholeOutsideOpacity };
}

/** Return the single shared screen-space keyhole circle and label feather. */
export function getKeyholeGeometry(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) {
    return { centerX: 0, centerY: 0, radius: 0, featherPx: 0 };
  }
  const radius = h * 0.5 * KEYHOLE_OUTER_RADIUS;
  return {
    centerX: w * 0.5,
    centerY: h * 0.5,
    radius,
    featherPx: radius * keyholeFadeRatio,
  };
}

/** Compute keyhole opacity from geometry already cached by a hot render loop. */
export function keyholeLabelAlphaFromGeometry(labelX, labelY, geometry) {
  if (!geometry || !(geometry.radius > 0) || !Number.isFinite(labelX) || !Number.isFinite(labelY)) return 0;
  const feather = geometry.featherPx;
  const distance = Math.hypot(labelX - geometry.centerX, labelY - geometry.centerY);
  if (distance <= geometry.radius) return 1;
  if (!(feather > 0) || distance >= geometry.radius + feather) return keyholeOutsideOpacity;
  const progress = clamp((distance - geometry.radius) / feather, 0, 1);
  return 1 - (1 - keyholeOutsideOpacity) * progress;
}
