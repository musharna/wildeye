import * as Cesium from 'cesium';
import { decodeLayerStateParams, encodeLayerStateParams } from './data/layerState.js';

/**
 * Share Links — URL Hash State Management
 *
 * Encodes camera position + style into the URL hash so links can be shared.
 * Format: #v=2&lat=37.77&lon=-122.42&alt=800&heading=0&pitch=-35&roll=0&style=crt&hv=1&map=esri-imagery&l=…&lo=…&ui=…
 *
 * Retired fields that old links may still carry are ignored on parse: bloom, bi, bv, sharpen, si,
 * hud (layout), cr (celestial ring), sc/scf/sce (scope mask), sp (style parameters), and the
 * styles nvg/flir, which restore as normal (removed with the DISPLAY panel, 2026-09-26).
 */

const DEBOUNCE_MS = 500;

// Style name mapping: internal → URL-friendly
const STYLE_TO_URL = {
  normal: 'normal',
  retro: 'crt',
  anime: 'anime',
  noir: 'noir',
  snow: 'snow',
};

const SHARE_UI_STATE_PARAM = 'ui';
const SHARE_CREATED_AT_PARAM = 'at';

const SHARE_PANEL_STATE_REGISTRY = Object.freeze([
  { id: 'control-panel', token: 'c', pinnable: true },
  { id: 'location-bar', token: 'l', pinnable: true },
  { id: 'data-panel', token: 'd', pinnable: false },
  // Retired panel tokens stay unknown and are never reissued: 'k' (Map Stack), 's' (Scenes), 'v' (CCTV),
  // 'r' (Radio), 'g' (Global Context), 'p' (DISPLAY), 'm' (style parameters).
  { id: 'species-panel', token: 'b', pinnable: false },
]);

const SHARE_PANEL_STATE_BY_TOKEN = Object.freeze(new Map(
  SHARE_PANEL_STATE_REGISTRY.map((entry) => [entry.token, entry]),
));

const URL_TO_STYLE = Object.fromEntries(
  Object.entries(STYLE_TO_URL).map(([k, v]) => [v, k])
);

export class ShareLinkManager {
  constructor(viewer, {
    onRestore,
    isNavigationCurrent,
    cancelOwnedNavigation,
  } = {}) {
    this.viewer = viewer;
    this._onRestore = onRestore; // callback: ({ style, hudVisible, mapStack, panelState }) => void
    this._debounceTimer = null;
    this._currentStyle = 'normal';
    this._hudVisible = false;
    this._mapStack = 'esri-imagery';
    this._layerStateProvider = null;
    this._panelStateProvider = null;
    this._initialRestorePending = false;
    this._restoreAuthority = {
      visual: 0,
      map: 0,
      panels: new Map(),
    };
    this._destroyed = false;
    this._restoreGeneration = 0;
    this._activeCameraFlight = null;
    this._isNavigationCurrent = typeof isNavigationCurrent === 'function'
      ? isNavigationCurrent
      : () => true;
    this._cancelOwnedNavigation = typeof cancelOwnedNavigation === 'function'
      ? cancelOwnedNavigation
      : null;

    // Listen for camera changes
    this._removeCameraChanged = this.viewer.camera.changed.addEventListener(() => {
      this._scheduleUpdate();
    });
  }

  /**
   * Parse URL hash on page load. Returns parsed state or null.
   */
  parseInitialHash() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;

    const params = new URLSearchParams(hash);
    const lat = parseFloat(params.get('lat'));
    const lon = parseFloat(params.get('lon'));

    // Coordinates drive Cartesian conversion, so reject non-finite URL values
    // before marking a share restoration as pending. `parseFloat('Infinity')`
    // is not NaN and would otherwise reach Cesium asynchronously at startup.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const parseOr = (value, fallback) => {
      const num = parseFloat(value);
      return Number.isFinite(num) ? num : fallback;
    };

    const style = URL_TO_STYLE[params.get('style')] || 'normal';
    const decodedLayerState = decodeLayerStateParams(params);
    const state = {
      lat,
      lon,
      alt: parseOr(params.get('alt'), 800),
      heading: parseOr(params.get('heading'), 0),
      pitch: parseOr(params.get('pitch'), -35),
      roll: parseOr(params.get('roll'), 0),
      style,
      hudVisible: params.get('hv') === '1',
      mapStack: params.get('map') || 'esri-imagery',
      layerState: decodedLayerState,
      layerStateInvalid: params.get('v') === '2'
        && params.has('l')
        && decodedLayerState === null,
      panelState: decodePanelStateParams(params),
      compare: params.get('cmp'),
      sharedAtMs: decodeShareCreatedAtMs(params),
    };
    state.restoreAuthority = {
      visual: this._restoreAuthority.visual,
      map: this._restoreAuthority.map,
      panels: new Map(this._restoreAuthority.panels),
    };

    // Hold URL writes until the complete incoming state has been restored.
    this._initialRestorePending = true;
    return state;
  }

  /**
   * Apply a parsed state to the viewer + style manager.
   */
  async applyState(state, { applyCamera = true, navigationToken = null } = {}) {
    if (this._destroyed || !state) return { succeeded: false, reason: 'unavailable' };
    const view = {
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
      orientation: {
        heading: Cesium.Math.toRadians(state.heading),
        pitch: Cesium.Math.toRadians(state.pitch),
        roll: Cesium.Math.toRadians(state.roll),
      },
    };
    let cameraPromise = Promise.resolve({ status: applyCamera ? 'superseded' : 'skipped' });
    if (applyCamera && this._isNavigationCurrent(navigationToken)) {
      const restoreGeneration = ++this._restoreGeneration;
      let settleCamera;
      cameraPromise = new Promise((resolve) => { settleCamera = resolve; });
      const releaseOwnedFlight = (status = 'cancelled') => {
        if (this._activeCameraFlight?.restoreGeneration === restoreGeneration) {
          this._activeCameraFlight = null;
        }
        settleCamera({ status });
      };
      this._activeCameraFlight = { restoreGeneration, navigationToken, settle: releaseOwnedFlight };
      // Re-apply the final pose only while this share restoration still owns
      // navigation. A later user or voice command wins over delayed restore.
      this.viewer.camera.flyTo({
        ...view,
        duration: 3.0,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => {
          if (
            this._destroyed
            || restoreGeneration !== this._restoreGeneration
            || !this._isNavigationCurrent(navigationToken)
          ) {
            releaseOwnedFlight('superseded');
            return;
          }
          this.viewer.camera.setView(view);
          this.viewer.scene?.requestRender?.();
          releaseOwnedFlight('applied');
        },
        cancel: () => releaseOwnedFlight('cancelled'),
      });
    }

    // Notify the style manager via callback
    const reserved = state.restoreAuthority || null;
    const visualCurrent = !reserved || reserved.visual === this._restoreAuthority.visual;
    const mapCurrent = !reserved || reserved.map === this._restoreAuthority.map;
    let panelState = state.panelState;
    if (reserved && panelState?.specs) {
      panelState = {
        specs: panelState.specs.filter((spec) => (
          (reserved.panels?.get(spec.id) || 0) === (this._restoreAuthority.panels.get(spec.id) || 0)
        )),
      };
      if (panelState.specs.length === 0) panelState = null;
    }
    let restoreStatus = 'skipped';
    if (this._onRestore) {
      await this._onRestore({
        style: visualCurrent ? state.style : undefined,
        hudVisible: visualCurrent ? state.hudVisible : undefined,
        mapStack: mapCurrent ? state.mapStack : undefined,
        panelState,
      });
      restoreStatus = 'applied';
    }
    const camera = await cameraPromise;
    return {
      succeeded: !this._destroyed,
      camera: camera.status,
      visual: visualCurrent ? restoreStatus : 'superseded',
      map: mapCurrent ? restoreStatus : 'superseded',
      panels: panelState ? restoreStatus : (state.panelState ? 'superseded' : 'skipped'),
    };
  }

  /** Release initial hash suppression only after every restore owner settles. */
  completeInitialRestore() {
    if (!this._initialRestorePending) return;
    this._initialRestorePending = false;
    this._scheduleUpdate();
  }

  /** Mark a newer explicit action as owner of one delayed restore lane. */
  claimRestoreLane(lane, panelId = null) {
    if (!this._initialRestorePending) return;
    if (lane === 'panel' && panelId) {
      this._restoreAuthority.panels.set(panelId, (this._restoreAuthority.panels.get(panelId) || 0) + 1);
    } else if (lane === 'visual' || lane === 'map') {
      this._restoreAuthority[lane] += 1;
    }
  }

  /** Install the finalized durable layer-state source used by URL generation. */
  setLayerStateProvider(provider) {
    this._layerStateProvider = typeof provider === 'function' ? provider : null;
  }

  /** Install the finalized panel-state source used by URL generation. */
  setPanelStateProvider(provider) {
    this._panelStateProvider = typeof provider === 'function' ? provider : null;
  }

  /** Install the swipe-compare source: returns the `cmp` value while compare is on, else null. */
  setCompareParamProvider(provider) {
    this._compareParamProvider = typeof provider === 'function' ? provider : null;
  }

  /** Called when compare starts, ends, changes a side, or moves its divider. */
  onCompareStateChange() {
    this._scheduleUpdate();
  }

  /** Called only when the durable layer preference model changes. */
  onLayerStateChange() {
    this._scheduleUpdate();
  }

  /** Called when the panel-state provider changes. */
  onPanelStateChange(panelId = null) {
    if (panelId) this.claimRestoreLane('panel', panelId);
    this._scheduleUpdate();
  }

  _encodePanelStateParam(params, panelState) {
    if (!panelState || !Array.isArray(panelState.specs) || panelState.specs.length === 0) {
      params.delete(SHARE_UI_STATE_PARAM);
      return;
    }
    const assignments = [];
    for (const spec of SHARE_PANEL_STATE_REGISTRY) {
      const state = panelState.specs.find((entry) => entry.id === spec.id);
      if (!state || typeof state.collapsed !== 'boolean') continue;
      assignments.push(`${spec.token}.c.${state.collapsed ? '1' : '0'}`);
      if (spec.pinnable && typeof state.pinned === 'boolean') {
        assignments.push(`${spec.token}.p.${state.pinned ? '1' : '0'}`);
      }
    }
    if (assignments.length) params.set(SHARE_UI_STATE_PARAM, assignments.join('_'));
    else params.delete(SHARE_UI_STATE_PARAM);
  }

  /** Called by StyleManager when style/toggles change */
  onStyleChange(styleName) {
    this._currentStyle = styleName;
    this._scheduleUpdate();
  }

  /** Called by StyleManager when HUD visibility or the map stack changes. */
  onVisualChange({ hudVisible, mapStack } = {}) {
    if (typeof hudVisible === 'boolean') this._hudVisible = hudVisible;
    if (typeof mapStack === 'string') this._mapStack = mapStack;
    this._scheduleUpdate();
  }

  /** Copy a current-state snapshot with a copy-time timestamp. Returns true on success. */
  async copyLink({ nowMs = Date.now() } = {}) {
    const params = this._buildHashParams();
    if (!params) return false;
    params.set(SHARE_CREATED_AT_PARAM, String(Math.floor(nowMs / 1000)));
    const copiedUrl = new URL(window.location.href);
    copiedUrl.hash = params.toString();
    try {
      await navigator.clipboard.writeText(copiedUrl.href);
      return true;
    } catch {
      return false;
    }
  }

  _scheduleUpdate() {
    if (this._destroyed || this._initialRestorePending) return;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._updateHash(), DEBOUNCE_MS);
  }

  _updateHash() {
    if (this._destroyed || this._initialRestorePending) return;
    const params = this._buildHashParams();
    if (!params) return;
    history.replaceState(null, '', `#${params.toString()}`);
  }

  /** Build a deterministic snapshot without mutating history. */
  _buildHashParams() {
    if (this._destroyed) return null;
    const camera = this.viewer.camera;
    const carto = camera.positionCartographic;
    if (!carto) return null;

    const params = new URLSearchParams();
    params.set('v', '2');
    params.set('lat', Cesium.Math.toDegrees(carto.latitude).toFixed(4));
    params.set('lon', Cesium.Math.toDegrees(carto.longitude).toFixed(4));
    params.set('alt', Math.round(carto.height).toString());
    params.set('heading', Math.round(Cesium.Math.toDegrees(camera.heading)).toString());
    params.set('pitch', Math.round(Cesium.Math.toDegrees(camera.pitch)).toString());
    params.set('roll', Math.round(Cesium.Math.toDegrees(camera.roll)).toString());
    params.set('style', STYLE_TO_URL[this._currentStyle] || 'normal');
    params.set('hv', this._hudVisible ? '1' : '0');
    params.set('map', this._mapStack);
    const layerState = this._layerStateProvider?.();
    if (layerState) encodeLayerStateParams(params, layerState);
    this._encodePanelStateParam(params, this._panelStateProvider?.());
    const cmp = this._compareParamProvider?.();
    if (cmp) params.set('cmp', cmp);

    // Copy-time metadata is intentionally absent here. `copyLink()` adds a
    // fresh timestamp to its ephemeral URL without aging the live address.
    params.delete(SHARE_CREATED_AT_PARAM);
    return params;
  }

  /** Cancel owned work and release listeners without disturbing newer navigation. */
  destroy() {
    if (this._destroyed) return;
    const activeFlight = this._activeCameraFlight;
    if (activeFlight && this._isNavigationCurrent(activeFlight.navigationToken)) {
      this._cancelOwnedNavigation?.();
    }
    activeFlight?.settle?.('destroyed');
    this._restoreGeneration += 1;
    this._activeCameraFlight = null;
    this._destroyed = true;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    this._removeCameraChanged?.();
    this._removeCameraChanged = null;
    this._layerStateProvider = null;
    this._panelStateProvider = null;
    this._onRestore = null;
  }
}

/** Decode a strict positive epoch-seconds copy timestamp for age classification. */
export function decodeShareCreatedAtMs(params, { nowMs = Date.now() } = {}) {
  const raw = params?.get?.(SHARE_CREATED_AT_PARAM);
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds)) return null;
  const timestampMs = seconds * 1000;
  if (!Number.isSafeInteger(timestampMs) || timestampMs > nowMs) return null;
  return timestampMs;
}

/** Decode the shareable collapsed and pinned state for known panels. */
export function decodePanelStateParams(params) {
  if (params.get('v') !== '2' || !params.has(SHARE_UI_STATE_PARAM)) return null;
  const raw = String(params.get(SHARE_UI_STATE_PARAM) || '').trim();
  if (!raw) return null;
  const stateById = new Map();
  for (const assignment of raw.split('_')) {
    if (!assignment) continue;
    const [token, field, value, ...extra] = assignment.split('.');
    if (extra.length) continue;
    const spec = SHARE_PANEL_STATE_BY_TOKEN.get(token);
    if (!spec || (field !== 'c' && field !== 'p')) continue;
    if (value !== '0' && value !== '1') continue;
    const bool = value === '1';
    const current = stateById.get(spec.id) || { id: spec.id, collapsed: null, pinned: null };
    if (field === 'c') current.collapsed = bool;
    else if (field === 'p' && spec.pinnable) current.pinned = bool;
    stateById.set(spec.id, current);
  }
  const specs = Array.from(stateById.values())
    .filter((entry) => typeof entry.collapsed === 'boolean');
  return specs.length ? { specs } : null;
}
