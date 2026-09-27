import * as Cesium from 'cesium';

/**
 * Absolute full-earth camera preset: the reset-globe button and the fresh-session
 * start view.
 */
export const GLOBE_VIEW = Object.freeze({
  heightM: 18000000,
  pitchDeg: -90,
  durationS: 2.8,
});

/**
 * Fly straight out to the full-earth globe view, keeping the current sub-camera
 * point centered so the user's continent stays in front of them.
 * @param {Cesium.Viewer} viewer
 * @param {{duration?: number, onComplete?: Function, onCancel?: Function}} options
 * @returns {{latitude: number, longitude: number, heightM: number}}
 */
export function flyToGlobeView(viewer, options = {}) {
  const carto = viewer.camera.positionCartographic;
  const longitude = Cesium.Math.toDegrees(carto.longitude);
  const latitude = Cesium.Math.toDegrees(carto.latitude);
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, GLOBE_VIEW.heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(GLOBE_VIEW.pitchDeg),
      roll: 0,
    },
    duration: finitePositive(options.duration) || GLOBE_VIEW.durationS,
    endTransform: Cesium.Matrix4.IDENTITY,
    // Cesium's Camera.flyTo reads `complete`/`cancel`. `onComplete`/`onCancel`
    // are this module's OWN option names and are silently ignored by Cesium —
    // spelling them through to flyTo meant the reset never resolved on the
    // flight's own events and every caller fell back to its watchdog timeout.
    complete: options.onComplete,
    cancel: options.onCancel,
  });
  return { latitude, longitude, heightM: GLOBE_VIEW.heightM };
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Where a fresh session (no share link) opens: the whole globe, straight down,
 * centred on the Atlantic so the Americas, Europe and Africa are all in view.
 */
export const START_VIEW = Object.freeze({ longitude: -30, latitude: 20 });

/**
 * Put the camera on the whole-globe start view, without a flight.
 * @param {Cesium.Viewer} viewer
 * @returns {void}
 */
export function showWholeGlobe(viewer) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(START_VIEW.longitude, START_VIEW.latitude, GLOBE_VIEW.heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(GLOBE_VIEW.pitchDeg),
      roll: 0,
    },
  });
}
