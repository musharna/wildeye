/**
 * @module hud
 * @description Camera readout overlay.
 *
 * Shows where the camera is over the Cesium canvas: latitude/longitude,
 * altitude above sea level, sun elevation, the UTC clock, the visual style
 * and a one-line place summary — all updating in real time.
 *
 * The HUD auto-activates when a stylised shader (NVG, FLIR, CRT) is
 * selected and supports three layout variants: tactical, operator, minimal.
 *
 * Color theming is driven by the active shader mode via CSS custom properties.
 */

import * as Cesium from 'cesium';
import { composeLocalityTag } from './hudLocality.js';
import { ellipsoidalToMslDisplayM, ensureGeoidReady, geoidHeight } from './data/geoid.js';

/** Color palettes keyed by shader mode; applied as CSS custom properties. */
const HUD_COLORS = {
  retro:        { main: 'rgba(255, 170, 0, 0.8)',   glow: 'rgba(255, 170, 0, 0.5)',   border: 'rgba(255, 170, 0, 0.2)' },
  _default:     { main: 'rgba(0, 255, 255, 0.6)',   glow: 'rgba(0, 255, 255, 0.4)',   border: 'rgba(0, 255, 255, 0.15)' },
};

/** Shader modes that automatically show the HUD overlay. */
const MILITARY_STYLES = new Set(['retro']);

/** Allowed HUD layout variants. */
const HUD_VARIANTS = new Set(['tactical', 'operator', 'minimal']);
/** The summary line carries the sun elevation and the clock, so it is retyped on this cadence too. */
const HUD_SUMMARY_INTERVAL_MS = 15000;

/**
 * Cell size (degrees) for the ALT readout's geoid-undulation cache. N changes
 * by well under a metre across 0.01° (~1.1 km), so one lookup per cell keeps
 * the 4 Hz telemetry tick off the EGM96 grid without a visible step.
 */
const HUD_GEOID_CELL_DEG = 0.01;

/**
 * Full-screen camera readout overlay rendered on top of the Cesium canvas.
 *
 * Displays lat/lon, altitude, sun elevation, the UTC clock and a rolling
 * place summary line. All values derive from the live camera position and
 * update on independent timer cadences.
 */
export class IntelHUD {
  /**
   * @param {Cesium.Viewer} viewer - The Cesium Viewer instance used for
   *   camera telemetry and coordinate derivation.
   */
  constructor(viewer) {
    this.viewer = viewer;
    this._visible = false;
    this._autoMode = true; // auto show/hide based on style
    this._currentStyle = 'normal';
    this._el = null;
    this._variant = 'tactical';
    this._updateInterval = null;
    this._timestampInterval = null;
    this._summaryInterval = null;
    this._summaryTypingInterval = null;
    this._latestMetrics = null;
    // Swap the "Awaiting telemetry..." placeholder for the summary line as soon as metrics exist.
    this._firstMetricsShown = false;
    // ALT readout datum: the camera height Cesium reports is ELLIPSOIDAL, the
    // number a viewer reads is MSL. N comes from the same lazy 0.5° EGM96
    // grid chunk (~0.69 MB) the flight layers use — requested on the first telemetry tick of a
    // VISIBLE HUD, never at construction, so a hidden HUD costs nothing — and
    // cached per coarse cell. Until it resolves, or if it never does,
    // `ellipsoidalToMslDisplayM` passes the raw height straight through.
    this._geoidRequested = false;
    this._geoidReady = false;
    this._geoidCellKey = null;
    this._geoidN = null;
    // Whether the LAST painted tick actually had N. The grid resolves mid-
    // session, so this flips once — and both altitude readouts have to move
    // together when it does (see the repaint in _updateCameraData).
    this._geoidCorrectionApplied = false;
    // Refresh the summary line as soon as the camera settles, not on the next 15 s tick.
    this._onCameraMoveEnd = () => {
      if (!this._visible) return;
      this._updateCameraData();
      this._setSummaryText(this._composeSummary(), false);
    };

    this._buildDOM();
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this._startTimers();
  }

  /**
   * Construct the HUD DOM structure inside the existing `#intel-hud` element.
   * Populates corner brackets, the mode and summary, the clock, the
   * position readouts, and the bottom lat/lon bar.
   */
  _buildDOM() {
    this._el = document.getElementById('intel-hud');
    if (!this._el) return;

    this._el.innerHTML = `
      <div class="hud-corner hud-top-left">
        <div class="hud-bracket">┌</div>
        <div class="hud-content">
          <div class="hud-mode" id="hud-mode">NORMAL</div>
          <div class="hud-summary-wrap">
            <div class="hud-summary-label">SUMMARY</div>
            <div class="hud-summary" id="hud-summary">Awaiting telemetry...</div>
          </div>
        </div>
      </div>

      <div class="hud-corner hud-top-right">
        <div class="hud-content" style="text-align:right">
          <div id="hud-timestamp">2026-01-01 00:00:00Z</div>
        </div>
        <div class="hud-bracket">┐</div>
      </div>

      <div class="hud-corner hud-bottom-left">
        <div class="hud-bracket">└</div>
        <div class="hud-content">
          <div id="hud-latlon">--°--'--"N ---°--'--"W</div>
        </div>
      </div>

      <div class="hud-corner hud-bottom-right">
        <div class="hud-content" style="text-align:right">
          <div id="hud-alt">ALT: --m   SUN: --° EL</div>
        </div>
        <div class="hud-bracket">┘</div>
      </div>

      <div class="hud-bottom-bar">
        <span id="hud-bottom-line">LAT: --  LON: --</span>
      </div>
    `;
    this._el.dataset.variant = this._variant;
  }

  /**
   * Start all periodic update timers (timestamp, camera telemetry, summary
   * line). Timers run independently at different cadences and are
   * cleaned up in {@link destroy}.
   */
  _startTimers() {
    // Timestamp — every second
    this._timestampInterval = setInterval(() => {
      const el = document.getElementById('hud-timestamp');
      if (el) el.textContent = this._formatUTC();
    }, 1000);

    // Camera-derived data — 4 updates/second (250ms)
    this._updateInterval = setInterval(() => {
      if (!this._visible) return;
      this._updateCameraData();
    }, 250);

    this._summaryInterval = setInterval(() => {
      if (!this._visible) return;
      this._setSummaryText(this._composeSummary(), true);
    }, HUD_SUMMARY_INTERVAL_MS);
  }

  /**
   * Format the current wall-clock time as a UTC Zulu string.
   * @returns {string} Timestamp in `YYYY-MM-DD HH:MM:SSZ` format.
   */
  _formatUTC() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}Z`;
  }

  /**
   * Geoid undulation N at the camera subpoint, memoized per coarse cell.
   * @param {number} latDeg - Camera latitude in decimal degrees.
   * @param {number} lonDeg - Camera longitude in decimal degrees.
   * @returns {number|null} N in metres, or null while the grid is unavailable.
   */
  _geoidUndulationM(latDeg, lonDeg) {
    if (!this._geoidReady) {
      if (!this._geoidRequested) {
        this._geoidRequested = true;
        ensureGeoidReady()
          .then(() => { this._geoidReady = true; })
          .catch(() => { /* readout falls back to the uncorrected height */ });
      }
      return null;
    }
    const key = `${Math.round(latDeg / HUD_GEOID_CELL_DEG)}:${Math.round(lonDeg / HUD_GEOID_CELL_DEG)}`;
    if (key !== this._geoidCellKey) {
      try {
        this._geoidN = geoidHeight(latDeg, lonDeg);
      } catch {
        this._geoidN = null;
      }
      this._geoidCellKey = key;
    }
    return Number.isFinite(this._geoidN) ? this._geoidN : null;
  }

  /**
   * Derive all camera-based telemetry and push values to the DOM.
   * Reads the viewer camera's cartographic position and computes lat/lon
   * DMS, altitude above sea level and sun elevation. Stores results in
   * {@link _latestMetrics}.
   */
  _updateCameraData() {
    const camera = this.viewer.camera;
    const cartographic = camera.positionCartographic;
    if (!cartographic) return;

    const lonDeg = Cesium.Math.toDegrees(cartographic.longitude);
    const latDeg = Cesium.Math.toDegrees(cartographic.latitude);
    const altM = cartographic.height;
    const latDMS = this._toDMS(latDeg, 'lat');
    const lonDMS = this._toDMS(lonDeg, 'lon');

    // Lat/Lon DMS
    const llEl = document.getElementById('hud-latlon');
    if (llEl) llEl.textContent = `${latDMS} ${lonDMS}`;
    const bottomEl = document.getElementById('hud-bottom-line');
    if (bottomEl) {
      bottomEl.textContent = `LAT: ${latDMS}  LON: ${lonDMS}`;
    }

    // Altitude — reported as height above MEAN SEA LEVEL. `altM` is the raw
    // ellipsoidal camera height, which reads far below zero wherever the geoid
    // sits under the ellipsoid: a cockpit parked on the SFO deck (N ≈ -32 m)
    // showed "ALT: -15m", and JFK "ALT: -18m". Subtracting N restores the
    // number a viewer expects without touching the camera or any render path.
    const altEl = document.getElementById('hud-alt');
    const geoidN = this._geoidUndulationM(latDeg, lonDeg);
    const altMslM = ellipsoidalToMslDisplayM(altM, geoidN);
    const sunEl = this._estimateSunElevation(latDeg, lonDeg);
    if (altEl) altEl.textContent = `ALT: ${Math.round(altMslM)}m   SUN: ${sunEl.toFixed(1)}° EL`;

    // `altM` stays the raw ellipsoidal camera height the view band reads.
    // `altMslM` is the ADDITIVE display datum — the only one any readout
    // string should print.
    this._latestMetrics = {
      latDeg,
      lonDeg,
      altM,
      altMslM,
      sunEl,
    };

    // First time we have real telemetry: replace the "Awaiting telemetry..."
    // placeholder with the summary line.
    if (!this._firstMetricsShown) {
      this._firstMetricsShown = true;
      this._setSummaryText(this._composeSummary(), false);
    }

    // The EGM96 grid lands mid-session, and the corner readout picks it up on
    // the very next telemetry tick. The summary line has no such cadence — it
    // repaints on camera settle or its 15 s tick — so without this the corner
    // reads `ALT: 17m` beside a summary still reading `ALT -15M`, for up to
    // fifteen seconds. Repaint the line in the SAME tick the correction turns
    // on (or off, if a lookup starts failing).
    const geoidCorrectionApplied = Number.isFinite(geoidN);
    if (geoidCorrectionApplied !== this._geoidCorrectionApplied) {
      this._geoidCorrectionApplied = geoidCorrectionApplied;
      this._setSummaryText(this._composeSummary(), false);
    }
  }

  /**
   * Convert a decimal-degree value to a degrees-minutes-seconds string.
   * @param {number} decimal - Coordinate in decimal degrees.
   * @param {'lat'|'lon'} type - Axis selector; controls hemisphere letter
   *   and zero-padding width (2 digits for lat, 3 for lon).
   * @returns {string} Formatted DMS string, e.g. `"38°53'23.10"N"`.
   */
  _toDMS(decimal, type) {
    // Round ONCE, in hundredths of an arc-second, then split: rounding the seconds on their own after
    // cutting degrees and minutes printed 134°E as 133°59'60.00"E (seen live 2026-09-25).
    const total = Math.round(Math.abs(decimal) * 360000);
    const deg = Math.floor(total / 360000);
    const min = Math.floor((total % 360000) / 6000);
    const sec = ((total % 6000) / 100).toFixed(2);

    let dir;
    if (type === 'lat') dir = decimal >= 0 ? 'N' : 'S';
    else dir = decimal >= 0 ? 'E' : 'W';

    const degStr = type === 'lon' ? String(deg).padStart(3, '0') : String(deg).padStart(2, '0');
    return `${degStr}°${String(min).padStart(2, '0')}'${String(sec).padStart(5, '0')}"${dir}`;
  }

  /**
   * Estimate current solar elevation angle above the horizon.
   *
   * Uses a simplified astronomical model: solar declination is approximated
   * from the day of year, and elevation is derived from the standard
   * sin(elevation) formula involving latitude, declination, and hour angle.
   *
   * @param {number} lat - Observer latitude in decimal degrees.
   * @param {number} lon - Observer longitude in decimal degrees.
   * @returns {number} Estimated sun elevation in degrees (negative = below horizon).
   */
  _estimateSunElevation(lat, lon) {
    const now = new Date();
    // Approximate local solar time by shifting UTC hours by longitude offset
    const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + lon / 15;
    const solarNoon = 12;
    const hourAngle = (hours - solarNoon) * 15;
    // Solar declination approximation (~23.45 deg amplitude sinusoidal over the year)
    const declination = 23.45 * Math.sin(Cesium.Math.toRadians((360 / 365) * (now.getUTCDate() + 30 * now.getUTCMonth() - 81)));
    const latRad = Cesium.Math.toRadians(lat);
    const decRad = Cesium.Math.toRadians(declination);
    const haRad = Cesium.Math.toRadians(hourAngle);
    // Standard formula: sin(el) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(ha)
    const sinEl = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
    // Clamp to [-1,1] to guard against floating-point drift before asin
    return Cesium.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, sinEl))));
  }

  /**
   * Classify the camera altitude into a named observation band.
   * @param {number} altM - Camera altitude in meters.
   * @returns {'STREET'|'CITY'|'METRO'|'REGIONAL'|'GLOBAL'} Band label.
   */
  _viewBand(altM) {
    if (altM < 1200) return 'STREET';
    if (altM < 5000) return 'CITY';
    if (altM < 30000) return 'METRO';
    if (altM < 250000) return 'REGIONAL';
    return 'GLOBAL';
  }

  /**
   * Return a coarse geographic region label based on lat/lon bounding boxes.
   * @param {number} lat - Latitude in decimal degrees.
   * @param {number} lon - Longitude in decimal degrees.
   * @returns {string} Region name (e.g. `"EUROPE"`, `"NORTHERN OCEANIC GRID"`).
   */
  _regionLabel(lat, lon) {
    if (lat > 72) return 'ARCTIC';
    if (lat < -60) return 'ANTARCTIC';
    if (lat >= 5 && lat <= 83 && lon >= -170 && lon <= -50) return 'NORTH AMERICA';
    if (lat >= -60 && lat <= 15 && lon >= -90 && lon <= -30) return 'SOUTH AMERICA';
    if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45) return 'EUROPE';
    if (lat >= -35 && lat <= 38 && lon >= -20 && lon <= 55) return 'AFRICA';
    if (lat >= 5 && lat <= 80 && lon >= 45 && lon <= 180) return 'ASIA';
    if (lat >= -50 && lat <= 5 && lon >= 110 && lon <= 180) return 'OCEANIA';
    return lat >= 0 ? 'NORTHERN OCEANIC GRID' : 'SOUTHERN OCEANIC GRID';
  }

  /**
   * Compute the approximate width and height (in km) of the camera's
   * current view rectangle on the ground.
   * @param {number} latDeg - Center latitude in decimal degrees (for
   *   longitude-to-km cosine correction).
   * @returns {{ widthKm: number, heightKm: number }|null} View window
   *   dimensions, or null if the view rectangle cannot be computed.
   */
  _viewWindowKm(latDeg) {
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const north = Cesium.Math.toDegrees(rect.north);
    const south = Cesium.Math.toDegrees(rect.south);
    let east = Cesium.Math.toDegrees(rect.east);
    let west = Cesium.Math.toDegrees(rect.west);
    let lonSpan = Math.abs(east - west);
    // Handle antimeridian wrap: if span exceeds 180 deg, take the shorter arc
    if (lonSpan > 180) lonSpan = 360 - lonSpan;
    const latSpan = Math.abs(north - south);
    // 111 km/deg is the approximate surface distance per degree of latitude;
    // longitude distance is scaled by cos(lat) to account for meridian convergence.
    const widthKm = Math.max(0, lonSpan * 111 * Math.cos(Cesium.Math.toRadians(latDeg)));
    const heightKm = Math.max(0, latSpan * 111);
    return { widthKm, heightKm };
  }

  /**
   * Build the one-line semantic summary string from the latest camera metrics.
   * Includes mode, view band, lat/lon, region, altitude,
   * size of the view, sun elevation, and local timezone.
   * @returns {string} Formatted summary line for the HUD summary readout.
   */
  _composeSummary() {
    const m = this._latestMetrics;
    if (!m) return 'Awaiting telemetry...';

    const modeEl = document.getElementById('hud-mode');
    const modeLabel = modeEl?.textContent || 'NORMAL';
    const region = this._regionLabel(m.latDeg, m.lonDeg);
    const band = this._viewBand(m.altM);
    const window = this._viewWindowKm(m.latDeg);
    // Rough local timezone from longitude (15 deg per hour)
    const utcOffset = Math.round(m.lonDeg / 15);
    const localTag = `UTC${utcOffset >= 0 ? '+' : ''}${utcOffset}`;
    // Same MSL datum as the corner ALT readout — the two are on screen
    // together, so they must never disagree. The view band above deliberately
    // keeps the ellipsoidal height: its thresholds were tuned against it.
    const altDisplayM = Number.isFinite(m.altMslM) ? m.altMslM : m.altM;
    const altTag = altDisplayM >= 1000
      ? `${(altDisplayM / 1000).toFixed(1)}KM`
      : `${Math.round(altDisplayM)}M`;
    const winTag = window
      ? `${Math.max(1, Math.round(window.widthKm))}x${Math.max(1, Math.round(window.heightKm))}KM`
      : 'N/A';
    const localityTag = composeLocalityTag(m.latDeg, m.lonDeg);

    return `${modeLabel} ${band} ${localityTag} | ${region} | ALT ${altTag} | VIEW ${winTag} | SUN ${m.sunEl.toFixed(0)}° | ${localTag}`;
  }

  /**
   * Animate the summary text into the DOM using a typewriter effect
   * (2 characters every 24ms).
   * @param {string} text - Full summary string to type out.
   */
  _typeSummary(text) {
    const el = document.getElementById('hud-summary');
    if (!el) return;
    clearInterval(this._summaryTypingInterval);
    let index = 0;
    el.textContent = '';
    this._summaryTypingInterval = setInterval(() => {
      index += 2;
      if (index >= text.length) {
        el.textContent = text;
        clearInterval(this._summaryTypingInterval);
        this._summaryTypingInterval = null;
        return;
      }
      el.textContent = text.slice(0, index);
    }, 24);
  }

  _setSummaryText(text, animate) {
    if (animate) {
      this._typeSummary(text);
      return;
    }
    const el = document.getElementById('hud-summary');
    if (el) el.textContent = text;
  }

  // ── Public API ──────────────────────────

  /**
   * React to a shader-style change. Updates the mode label, HUD color
   * scheme (via CSS custom properties), and auto-shows/hides the overlay
   * when in auto mode.
   * @param {string} styleName - Active style key (e.g. `'retro'`, `'normal'`).
   */
  onStyleChange(styleName) {
    this._currentStyle = styleName;

    // Update mode label
    const modeEl = document.getElementById('hud-mode');
    if (modeEl) {
      const modeNames = { retro: 'CRT' };
      modeEl.textContent = modeNames[styleName] || styleName.toUpperCase();
    }
    // Update color scheme
    const colors = HUD_COLORS[styleName] || HUD_COLORS._default;
    if (this._el) {
      this._el.style.setProperty('--hud-color', colors.main);
      this._el.style.setProperty('--hud-glow', colors.glow);
      this._el.style.setProperty('--hud-border', colors.border);
    }

    // Auto show/hide
    if (this._autoMode) {
      if (MILITARY_STYLES.has(styleName)) {
        this.show();
      } else {
        this.hide();
      }
    }
  }

  /** Make the HUD visible and immediately refresh all readouts. */
  show() {
    this._visible = true;
    if (this._el) this._el.classList.add('active');
    this._updateCameraData(); // immediate update
    this._setSummaryText(this._composeSummary(), false);
  }

  /** Hide the HUD overlay. */
  hide() {
    this._visible = false;
    if (this._el) this._el.classList.remove('active');
  }

  /** Toggle HUD visibility and disable auto-mode (user override). */
  toggle() {
    if (this._visible) {
      this._autoMode = false; // user override
      this.hide();
    } else {
      this._autoMode = false;
      this.show();
    }
  }

  /**
   * Explicit HUD mode control for scene/recording playback.
   * @param {'auto'|'on'|'off'} mode - `'auto'` re-enables style-driven
   *   show/hide; `'on'`/`'off'` force visibility and disable auto-mode.
   */
  setMode(mode) {
    if (mode === 'auto') {
      this._autoMode = true;
      this.onStyleChange(this._currentStyle);
      return;
    }

    this._autoMode = false;
    if (mode === 'on') this.show();
    else this.hide();
  }

  /**
   * Switch the HUD layout variant. Falls back to `'tactical'` if the
   * name is unrecognized.
   * @param {string} variantName - One of `'tactical'`, `'operator'`, `'minimal'`.
   */
  setVariant(variantName) {
    const normalized = String(variantName || '').toLowerCase();
    this._variant = HUD_VARIANTS.has(normalized) ? normalized : 'tactical';
    if (this._el) {
      this._el.dataset.variant = this._variant;
    }
  }

  /**
   * @returns {string} The current HUD layout variant name.
   */
  getVariant() {
    return this._variant;
  }

  /**
   * @returns {'auto'|'on'|'off'} Current HUD mode — `'auto'` when style-driven
   *   show/hide is active, otherwise the explicit visibility override.
   */
  getMode() {
    if (this._autoMode) return 'auto';
    return this._visible ? 'on' : 'off';
  }

  /** @returns {boolean} Whether the HUD is currently visible. */
  get visible() {
    return this._visible;
  }

  /** Tear down all running intervals. Call when discarding the HUD instance. */
  destroy() {
    clearInterval(this._updateInterval);
    clearInterval(this._timestampInterval);
    clearInterval(this._summaryInterval);
    clearInterval(this._summaryTypingInterval);
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
  }
}
