import * as Cesium from 'cesium';
import { GLOBE_VIEW } from './locations.js';

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
