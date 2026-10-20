/**
 * @module pointerReadout
 * @description One plain line giving the latitude and longitude under the pointer, in decimal degrees.
 *
 * Replaces the camera HUD (style name, place summary, clock, ALT/SUN in four corners) with the one
 * reading a map user looks for. Updates at most once per animation frame; hidden while the pointer is
 * off the globe or outside the canvas.
 */

import * as Cesium from 'cesium';

/**
 * Decimal-degree text for a latitude/longitude pair: two decimals (about 1 km), hemisphere letters,
 * longitude wrapped into [-180, 180). The hemisphere follows the rounded value, so -0.001 reads 0.00° N.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {string} e.g. "36.98° N, 77.01° W"; empty when either value is not finite.
 */
export function formatLatLon(latDeg, lonDeg) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return '';
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  const part = (v, pos, neg) => {
    const r = Math.round(v * 100) / 100;
    return `${Math.abs(r).toFixed(2)}° ${r < 0 ? neg : pos}`;
  };
  return `${part(latDeg, 'N', 'S')}, ${part(lon, 'E', 'W')}`;
}

export class PointerReadout {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {HTMLElement | null} el - The element that shows the line.
   */
  constructor(viewer, el) {
    this._viewer = viewer;
    this._el = el;
    this._frame = null;
    this._position = null;
    this._handler = null;
    this._leave = null;
    if (!el || !viewer?.scene?.canvas) return;
    this._handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    this._handler.setInputAction((move) => this._queue(move.endPosition), Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    this._leave = () => {
      this._position = null;
      this._show('');
    };
    viewer.scene.canvas.addEventListener('pointerleave', this._leave);
    this._show('');
  }

  _queue(position) {
    this._position = position;
    if (this._frame !== null) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._update();
    });
  }

  _update() {
    if (!this._position) return;
    const { scene, camera } = this._viewer;
    let cartesian;
    if (scene.globe?.show) {
      const ray = camera.getPickRay(this._position);
      cartesian = ray && scene.globe.pick(ray, scene);
    }
    cartesian ??= camera.pickEllipsoid(this._position, scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84);
    if (!cartesian) {
      this._show('');
      return;
    }
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    this._show(formatLatLon(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)));
  }

  _show(text) {
    if (this._el.textContent !== text) this._el.textContent = text;
    this._el.hidden = !text;
  }

  destroy() {
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    this._frame = null;
    this._handler?.destroy();
    this._handler = null;
    if (this._leave) this._viewer.scene?.canvas?.removeEventListener('pointerleave', this._leave);
    this._leave = null;
  }
}
