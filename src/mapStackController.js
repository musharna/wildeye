import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';

/** The two keyless basemaps. Esri World Imagery is the default. */
export const MAP_STACKS = [
  {
    id: 'esri-imagery',
    label: 'Esri Satellite',
    shortLabel: 'SAT',
    kind: 'esri-imagery',
  },
  {
    id: 'osm',
    label: 'OSM',
    shortLabel: 'OSM',
    kind: 'osm',
  },
];

/** A share link naming a retired stack (Google 3D, Bing, Bing Road) or an unknown id lands here. */
export const DEFAULT_MAP_STACK = 'esri-imagery';

const DEFAULT_OSM_CREDIT = '© OpenStreetMap contributors';

// Esri World Imagery — the keyless satellite basemap and the default landing.
// The classic ArcGIS Online tile service answers without a key;
// attribution is required and the provider carries the service's own credit
// line. Terms note in DATA_SOURCES.md.
const ESRI_WORLD_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_IMAGERY_CREDIT =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
// The on-screen notice Esri requires when a third-party library draws its
// service. Rendered via an explicit static credit (see _syncEsriAttribution) —
// the provider's own `credit` option is ignored for tiled ArcGIS servers.
const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

// Keyless global ellipsoidal terrain (Re:Earth Terrain / Mapterhorn, CC BY 4.0,
// EGM2008 geoid via NGA) — quantized-mesh 1.0, `ellipsoid` data-type.
// Constructed via `.fromUrl()`, never a hand-built `{z}/{x}/{y}.terrain` URL.
const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';
// Terrain waits until the camera first comes below this height, then stays. The opening view is ~18,000 km up, where
// relief is below a pixel (Himalaya side by side, with and without terrain: identical at 5,000 km, no visible relief at
// 2,000 km), yet its ~1.6 MB of tiles held a slow-4G first visit ~5 s longer (grill_wildeye_cesium_2026-09-27, Q4).
export const TERRAIN_BELOW_M = 2_000_000;

/**
 * Controls the active basemap: the imagery layer under the globe and the
 * keyless terrain beneath it.
 */
export class MapStackController {
  constructor(viewer, {
    initialStack = DEFAULT_MAP_STACK,
    onChange = null,
    onError = null,
  } = {}) {
    this.viewer = viewer;
    this._onChange = onChange;
    this._onError = onError;
    this._activeId = this.getStack(initialStack) ? initialStack : DEFAULT_MAP_STACK;
    this._imageryLayer = null;
    this._activeImageryProvider = null;
    this._removeImageryErrorListener = null;
    this._esriFallbackPending = false;
    this._imageryProviders = new Map();
    this._isSwitching = false;
    this._lastError = null;
    // The keyless terrain is installed the first time the camera comes below TERRAIN_BELOW_M, and kept.
    this._terrainInstalled = false;
    this._terrainPending = null;
    this._removeTerrainWatch = null;
    // Cache of the constructed keyless Re:Earth CesiumTerrainProvider, so
    // repeat switches don't refetch `layer.json`.
    this._reearthTerrainProvider = null;
    // Monotonic switch counter. setStack() awaits network-bound provider
    // creation; a rapid A→B switch where A (e.g. slow Esri) resolves AFTER B
    // (fast OSM) would otherwise revert the user's last choice (M7). Each call
    // captures a generation and aborts its own commit once superseded.
    this._switchGen = 0;
  }

  getStacks() {
    return MAP_STACKS.map((stack) => ({ ...stack }));
  }

  getStack(id) {
    return MAP_STACKS.find((stack) => stack.id === id) || null;
  }

  getActiveId() {
    return this._activeId;
  }

  /**
   * Monotonic id of the most recently STARTED switch.
   *
   * A switch is only superseded by another `setStack()` — nothing else moves
   * this number — so a caller that must know whether the globe it is looking
   * at is still the one IT asked for can compare this across its own await.
   * Unchanged (or advanced by exactly its own call) means no newer switch has
   * claimed the globe.
   * @returns {number}
   */
  getSwitchGeneration() {
    return this._switchGen;
  }

  getActiveStack() {
    return this.getStack(this._activeId);
  }

  async setStack(id, { silent = false } = {}) {
    const stack = this.getStack(id) || this.getStack(DEFAULT_MAP_STACK);

    const gen = ++this._switchGen;
    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');

    try {
      const activation = await this._activateGlobeStack(stack, gen);
      // A newer switch started while we were awaiting the provider — that call
      // owns the final state now, so don't commit ours or emit a stale 'ready'.
      if (gen !== this._switchGen) return this.getState();
      this._activeId = activation?.effectiveStackId || stack.id;
      if (activation?.fallbackMessage) {
        this._lastError = activation.fallbackMessage;
        this._onError?.(activation.fallbackMessage, stack);
      }
      // Show/hide of tilesets + imagery swaps need a frame in idle mode;
      // subsequent tile loads self-request via Cesium. (perf wave 2)
      governorRequestRender('map-stack');
      if (!silent) this._emitChange('ready');
    } catch (error) {
      if (gen !== this._switchGen) return this.getState();
      const message = error?.message || String(error);
      this._lastError = message;
      this._onError?.(message, stack);
      if (!silent) this._emitChange('error');
    } finally {
      // Only the latest switch clears the switching flag; a superseded call
      // must not stomp a newer switch that is still in progress.
      if (gen === this._switchGen) this._isSwitching = false;
    }

    return this.getState();
  }

  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
    };
  }

  async _activateGlobeStack(stack, gen) {
    const resolution = await this._getImageryProvider(stack);
    // A newer switch started while the provider was resolving — don't touch the
    // scene's imagery layers, the winning switch already owns them (M7).
    if (gen != null && gen !== this._switchGen) return;
    this._removeImageryLayer();

    this._imageryLayer = new Cesium.ImageryLayer(resolution.provider);
    this._activeImageryProvider = resolution.provider;
    this.viewer.imageryLayers.add(this._imageryLayer, 0);
    this._syncEsriAttribution(resolution.effectiveStackId);
    this._watchEsriProvider(resolution, gen);

    this._watchForTerrain();
    return resolution;
  }

  /**
   * Show or hide the required "Powered by Esri" notice with the Esri layer's
   * own lifecycle.
   *
   * This cannot ride on the provider's `credit` option: Cesium IGNORES that
   * option for tiled ArcGIS MapServer sources, so passing it there displays
   * nothing and the app would be using the service without the attribution
   * Esri requires of third-party libraries. It is an ON-SCREEN credit (not the
   * lightbox, where per-layer data credits live) because that is what the
   * requirement asks for, and it is removed when another stack takes over so
   * the globe never claims a source it is not showing.
   */
  _syncEsriAttribution(activeStackId) {
    const creditDisplay = this.viewer?.scene?.frameState?.creditDisplay;
    if (!creditDisplay) return;
    const wanted = activeStackId === 'esri-imagery';
    if (wanted === !!this._esriCreditShown) return;
    if (!this._esriCredit) {
      this._esriCredit = new Cesium.Credit(ESRI_ATTRIBUTION_HTML, true);
    }
    try {
      if (wanted) creditDisplay.addStaticCredit(this._esriCredit);
      else creditDisplay.removeStaticCredit(this._esriCredit);
      this._esriCreditShown = wanted;
    } catch {
      // A Cesium build without static-credit removal must not break switching.
    }
  }

  async _getImageryProvider(stack) {
    if (this._imageryProviders.has(stack.id)) {
      return this._imageryProviders.get(stack.id);
    }

    let provider;
    let effectiveStackId = stack.id;
    let fallbackMessage = null;
    if (stack.kind === 'esri-imagery') {
      try {
        provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY_URL, {
          credit: ESRI_IMAGERY_CREDIT,
          enablePickFeatures: false,
        });
      } catch (error) {
        // The keyless DEFAULT landing must never strand a first run on a blank
        // globe because Esri is unreachable — fall back to OSM tiles for this
        // session. (The fallback is cached under this stack id like any other
        // provider, so the session won't re-probe Esri; a restart does.)
        console.warn('[MapStack] Esri World Imagery unavailable, falling back to OSM:', error?.message || error);
        provider = new Cesium.OpenStreetMapImageryProvider({
          url: 'https://tile.openstreetmap.org/',
          credit: DEFAULT_OSM_CREDIT,
        });
        effectiveStackId = 'osm';
        fallbackMessage = 'Esri Satellite is unavailable; using OSM';
      }
    } else if (stack.kind === 'osm') {
      provider = new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        credit: DEFAULT_OSM_CREDIT,
      });
    } else {
      throw new Error(`Unsupported map stack: ${stack.id}`);
    }

    const resolution = { provider, effectiveStackId, fallbackMessage };
    this._imageryProviders.set(stack.id, resolution);
    if (effectiveStackId === 'osm' && !this._imageryProviders.has('osm')) {
      this._imageryProviders.set('osm', { provider, effectiveStackId: 'osm', fallbackMessage: null });
    }
    return resolution;
  }

  /**
   * Esri provider construction can succeed while its first tile requests fail.
   * Two failures for the active provider trigger the same truthful OSM fallback
   * as a construction failure; one transient error is left to Cesium's retry.
   */
  _watchEsriProvider(resolution, gen) {
    if (resolution.effectiveStackId !== 'esri-imagery') return;
    const errorEvent = resolution.provider?.errorEvent;
    if (!errorEvent?.addEventListener) return;
    let failures = 0;
    this._removeImageryErrorListener = errorEvent.addEventListener((error) => {
      if (gen !== this._switchGen || this._activeImageryProvider !== resolution.provider) return;
      const retryCount = Number(error?.timesRetried);
      failures = Number.isInteger(retryCount) && retryCount >= 0
        ? Math.max(failures + 1, retryCount + 1)
        : failures + 1;
      if (failures < 2 || this._esriFallbackPending) return;
      this._esriFallbackPending = true;
      const message = 'Esri Satellite tile requests failed; using OSM';
      this._onError?.(message, this.getStack('esri-imagery'));
      void this.setStack('osm', { silent: true }).then((state) => {
        if (state?.activeId === 'osm') {
          this._lastError = message;
          this._emitChange('error');
        }
      }).finally(() => {
        this._esriFallbackPending = false;
      });
    });
  }

  _removeImageryLayer() {
    if (this._removeImageryErrorListener) {
      this._removeImageryErrorListener();
      this._removeImageryErrorListener = null;
    }
    if (!this._imageryLayer) return;
    this.viewer.imageryLayers.remove(this._imageryLayer, false);
    this._imageryLayer = null;
    this._activeImageryProvider = null;
  }

  /**
   * Installs the keyless terrain on the first rendered frame whose camera is below TERRAIN_BELOW_M. Terrain does not
   * depend on the imagery stack, so it is armed once and outlives every switch. `preRender` fires only on frames that
   * render, so the watch costs nothing while the globe is idle, and it is removed as soon as terrain is on its way.
   */
  _watchForTerrain() {
    if (this._terrainInstalled || this._terrainPending || this._removeTerrainWatch) return;
    const check = () => {
      if (this.viewer.camera.positionCartographic.height >= TERRAIN_BELOW_M) return;
      this._removeTerrainWatch?.();
      this._removeTerrainWatch = null;
      this._installKeylessTerrain();
    };
    this._removeTerrainWatch = this.viewer.scene.preRender.addEventListener(check);
    check();
  }

  /**
   * Installs the keyless terrain once. `CesiumTerrainProvider.fromUrl()` is async (it fetches `layer.json`); a call
   * made while one is in flight joins it.
   */
  _installKeylessTerrain() {
    if (this._terrainInstalled) return Promise.resolve();
    this._terrainPending ||= this._getKeylessTerrainProvider().then((provider) => {
      this.viewer.terrainProvider = provider;
      this._terrainInstalled = true;
      governorRequestRender('map-stack');
    });
    return this._terrainPending;
  }

  /**
   * Resolves (and caches) the keyless terrain provider: Re:Earth ellipsoidal
   * quantized-mesh terrain, or the flat `EllipsoidTerrainProvider` if the
   * Re:Earth endpoint can't be constructed. Never throws.
   * @returns {Promise<Cesium.TerrainProvider>}
   */
  async _getKeylessTerrainProvider() {
    if (this._reearthTerrainProvider) return this._reearthTerrainProvider;
    try {
      this._reearthTerrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
    } catch (error) {
      console.warn('[mapStackController] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:', error);
      this._reearthTerrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
    return this._reearthTerrainProvider;
  }

  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }
}
