import * as Cesium from 'cesium';
import { retroShader } from './styles/retro.js';
import { animeShader } from './styles/anime.js';
import { noirShader } from './styles/noir.js';
import { snowShader } from './styles/snow.js';
import { GLOBE_VIEW, flyToGlobeView } from './camera.js';
import { interruptCameraMotion } from './cameraVerbs.js';
import { IntelHUD } from './hud.js';
import { ShareLinkManager } from './sharelink.js';
import { LayerStateCoordinator } from './data/layerState.js';
import { renderMapStackChips, syncMapStackChips } from './mapStackChips.js';
import {
  aggregateLayerLoading,
  createGlobalStatusNotice,
  createLoadingFeedbackState,
  presentGlobalLoadingStatus,
  reduceLoadingFeedback,
} from './loadingFeedback.js';
import { setSplitFlapText } from './splitFlap.js';
import {
  allocatePanelStackHeights,
  panelStackAutoCollapseIndices,
  resolveLeftStackBottomBoundary,
  resolvePanelStackCorridor,
  measureLeftPanelNaturalHeight,
  phoneAccordionSiblingsToCollapse,
} from './panelStackLayout.js';
import { SHORT_HEADER_SELECTOR, SHORT_VIEWPORT_QUERY, topBelowHeader } from './bio/shortViewport.js';
import { beginDeferredNavigation, reassertNavigationHandoff } from './navigationPolicy.js';
import { holdContinuousRender, releaseContinuousRender, governorRequestRender } from './renderGovernor.js';

/** Duration (ms) for shader intensity crossfade between style presets. */
const TRANSITION_DURATION_MS = 500;
/** Map of style name to its GLSL shader module for post-process stages. */
const STYLES = { retro: retroShader, anime: animeShader, noir: noirShader, snow: snowShader };
/** Versioned localStorage namespace prefix to invalidate stale panel layouts. */
const PANEL_LAYOUT_STORAGE_VERSION = 'v6';
const SHARE_PANEL_STATE_SPECS = Object.freeze([
  { id: 'control-panel', pinnable: true },
  { id: 'data-panel' },
  { id: 'species-panel' },
]);
/**
 * Position keys are versioned separately from collapsed-state keys so layout
 * default changes (e.g. right-rail origin) can reset positions without also
 * resetting every panel's open/closed preference.
 */
const PANEL_POSITION_STORAGE_VERSION = 'v8';
/** One remeasure after HUD variant changes, whose visibility transitions can outlive the first frame. */
const PANEL_LAYOUT_SETTLE_MS = 240;
/**
 * Fixed UI regions that can occupy the left accordion's vertical lane.
 * Rectangles are filtered at runtime for visibility and horizontal overlap,
 * so right-side/center controls do not reduce the lane unless they actually
 * intersect it at the current viewport size.
 */
const LEFT_STACK_OBSTACLE_SELECTOR = [
  '#title-bar',
  '#style-indicator',
  '#top-center-actions',
  '#intel-hud .hud-top-left',
  '#intel-hud .hud-top-right',
  '#intel-hud .hud-bottom-left',
  '#intel-hud .hud-bottom-right',
  '#intel-hud .hud-bottom-bar',
  '#cesium-credits .cesium-credit-logoContainer',
  '#cesium-credits .cesium-credit-textContainer',
  '#control-panel',
].join(', ');
/** Display labels shown in the mini-status readout for each active style. */
const STYLE_STATUS_LABELS = {
  normal: 'NORMAL',
  retro: 'CRT',
  anime: 'ANIME',
  noir: 'NOIR',
  snow: 'SNOW',
};
/**
 * Unsharp-mask strength, always on: the 49% default of the removed DISPLAY panel's Sharpen
 * slider (amount = 0.1 + 0.49 × 2). Bloom was off by default and went with the panel.
 */
const SHARPEN_AMOUNT = 1.08;

/**
 * GLSL fragment shader implementing an unsharp-mask sharpening filter.
 * Samples a 3x3 neighborhood, computes box blur, then adds the
 * difference (center - blur) scaled by `amount` for edge enhancement.
 */
const SHARPEN_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform vec2 colorTextureDimensions;
  uniform float amount;
  in vec2 v_textureCoordinates;

  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 texel = 1.0 / colorTextureDimensions;
    vec4 center = texture(colorTexture, uv);
    vec4 blur = (
      texture(colorTexture, uv + vec2(-texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,     -texel.y)) +
      texture(colorTexture, uv + vec2( texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2(-texel.x,  0.0))     +
      center +
      texture(colorTexture, uv + vec2( texel.x,  0.0))     +
      texture(colorTexture, uv + vec2(-texel.x,  texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,      texel.y)) +
      texture(colorTexture, uv + vec2( texel.x,  texel.y))
    ) / 9.0;
    vec4 sharpened = center + (center - blur) * amount;
    out_FragColor = vec4(clamp(sharpened.rgb, 0.0, 1.0), center.a);
  }
`;

/**
 * Central UI orchestrator for wildeye.
 *
 * Responsibilities:
 * - CesiumJS PostProcessStage pipeline: registers per-style GLSL stages
 *   (CRT, anime, noir, snow) and manages intensity crossfades, plus a fixed
 *   sharpen pass.
 * - Collapsible panel system with localStorage persistence.
 * - Recording mode with safe-frame overlay and HUD mode switching.
 * - Share link encoding/decoding (delegates to ShareLinkManager).
 * - Toast notification system and Intel HUD lifecycle.
 */

export class StyleManager {
  /**
   * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
   * @param {object} [options]
   */
  constructor(viewer, { mapStackController = null } = {}) {
    this.viewer = viewer;
    this.mapStackController = mapStackController;
    this.stages = {};
    this.activeStyle = 'normal';
    document.documentElement.dataset.gevStyle = this.activeStyle;
    this.transitions = new Map();
    this.startTime = Date.now();

    this._sharpenStage = null;
    this._recordingMode = false;
    this._recordingConfig = { hidePanels: true, hudMode: 'minimal', safeFrame: '16:9' };
    this._preRecordingHudState = null;
    this._animFrameId = null;
    this._lastLoadingFeedbackUpdateAt = 0;
    this._loadingFeedbackState = createLoadingFeedbackState();
    this._loadingFeedbackEvent = null;
    this._loadingFeedbackTicker = null;
    this._globalStatusNotice = null;
    this._globeResetPromise = null;
    this._globeResetHandler = null;
    this._clearSelectedLayersPromise = null;
    this._clearSelectedLayersManagerPromise = null;
    this._clearSelectedLayersHandler = null;
    this._dataManager = null;
    this._leftStackLayoutFrame = null;
    this._leftStackReconsiderAutoCollapse = false;
    this._leftStackResizeObserver = null;
    this._leftStackMutationObserver = null;
    this._leftStackHudTransitionHandler = null;
    this._leftStackPanelTransitionHandler = null;
    this._leftStackCollapsedHeights = new Map();
    this._leftStackPreferredPanelId = null;
    this._adaptivePanelSettleTimer = null;
    this._windowResizeHandler = null;
    this._loadingVisibilityHandler = null;
    this._navigationOwnerChangedRemover = null;
    this._navigationGeneration = 0;
    this._initialShareState = null;
    this._initialShareNavigationGeneration = null;
    this._initialShareRestoreTimeout = null;
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    this._disposed = false;

    // DOM refs
    this._styleIndicator = document.getElementById('active-style-name');
    this._mapStackChips = document.getElementById('map-stack-chips');
    this._mapStackStatus = document.getElementById('map-stack-status');
    this._mapStackChangeHandler = null;
    this._cleanViewExitBtn = document.getElementById('clean-view-exit');
    this._leftPanelStack = document.getElementById('left-panel-stack');
    this._shareBtn = document.getElementById('share-btn');
    this._clearSelectedLayersBtn = document.getElementById('clear-selected-layers');
    this._globalLoadingStatus = document.getElementById('global-loading-status');
    this._globalLoadingLabel = document.getElementById('global-loading-label');
    this._globalLoadingDetail = document.getElementById('global-loading-detail');
    this._resetGlobeBtn = document.getElementById('reset-globe-view');
    this._toast = document.getElementById('toast');
    this._styleMiniValue = document.getElementById('style-mini-value');
    this._safeFrameOverlay = document.getElementById('safe-frame-overlay');
    this._safeFrameBox = document.getElementById('safe-frame-box');

    // Intel HUD
    this.hud = new IntelHUD(viewer);

    // Share Link Manager
    this.shareLinkManager = new ShareLinkManager(viewer, {
      onRestore: async (state) => {
        const {
          style,
          hudVisible,
          mapStack,
          panelState,
        } = state || {};
        // Ignore the retired 'ai-edit' style from older share links.
        if (style && style !== 'normal' && style !== 'ai-edit') {
          this.setStyle(style, { restore: true });
        }
        if (typeof hudVisible === 'boolean') {
          this.hud.setMode(hudVisible ? 'on' : 'off');
          this._scheduleAdaptivePanelLayout({ settle: true });
        }
        const mapStackRestore = mapStack
          ? this._setMapStack(mapStack, { syncShare: false })
          : Promise.resolve();
        if (panelState) this._restorePanelState(panelState);
        await mapStackRestore;
        this._syncShareState();
      },
      isNavigationCurrent: (generation) => generation === this._navigationGeneration,
      cancelOwnedNavigation: () => this.viewer.camera.cancelFlight(),
    });
    this.shareLinkManager.setPanelStateProvider(() => this._buildSharePanelState());
    // Parse before panel chrome initializes so every valid share URL starts
    // from deterministic markup defaults instead of recipient-local panel
    // preferences. Encoded panel fields are applied after all panels exist.
    this._initialShareState = this.shareLinkManager.parseInitialHash();
    this._initialCompareParam = this._initialShareState?.compare ?? null;

    this._initStages();
    this._initSharpen();
    this._initUI();
    this._initMapStackControl();
    this._initPanelChrome();
    this._initLeftPanelAdaptiveLayout();
    this._initShareButton();
    this._initClearSelectedLayersButton();
    this._initResetGlobeButton();
    this.hud.setMode('on');
    this._initRecordingOverlay();
    this._startAnimationLoop();
    this._updateStyleMiniStatus();

    // Restore from URL hash if present
    const savedState = this._initialShareState;
    this._initialShareRestorePromise = savedState
      ? new Promise((resolve) => { this._resolveInitialShareRestore = resolve; })
      : Promise.resolve({ status: 'not-requested', share: null, layers: [] });
    if (savedState) {
      this._hasShareState = true;
      // Reserve camera authority now; the delayed mesh-friendly flight may
      // run only if no newer navigation has won.
      this._initialShareNavigationGeneration = this._beginDeferredNavigation();
      this._initialShareRestoreTimeout = setTimeout(() => {
        this._initialShareRestoreTimeout = null;
        if (this._disposed) return;
        const generation = this._initialShareNavigationGeneration;
        const applyCamera = Number.isInteger(generation)
          && this._reassertNavigationHandoff(generation);
        void (async () => {
          try {
            const share = await this.shareLinkManager.applyState(savedState, {
              applyCamera,
              navigationToken: generation,
            });
            const layers = await (this._layerStateRestorePromise || Promise.resolve([]));
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({ status: 'settled', share, layers });
          } catch (error) {
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'failed',
              error: String(error?.message || error),
              share: null,
              layers: [],
            });
          }
        })();
      }, 1500);
    } else {
      this._syncShareState();
    }
    // A recipient can orbit before or during the delayed share flight. That
    // gesture keeps ordinary layer state but revokes the passive base camera
    // so delayed work cannot seize navigation.
    this._initialShareGestureHandler = () => {
      if (
        this._disposed
        || !this._hasShareState
        || !this._resolveInitialShareRestore
      ) return;
      this._stampNavigation();
    };
    this.viewer?.canvas?.addEventListener('pointerdown', this._initialShareGestureHandler, {
      passive: true,
    });
    this.viewer?.canvas?.addEventListener('wheel', this._initialShareGestureHandler, {
      passive: true,
    });

    this._windowResizeHandler = () => {
      this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    };
    window.addEventListener('resize', this._windowResizeHandler);
    // The loading-chip ticker is stopped while the tab is hidden (it can do no
    // useful work off-screen and must not hold a 60ms timer there). Resample on
    // return so the time-driven reducer catches up on real elapsed time — and
    // re-arms its own ticker if the batch is still running.
    this._loadingVisibilityHandler = () => {
      if (!document.hidden) this._updateGlobalLoadingFeedback();
    };
    document.addEventListener('visibilitychange', this._loadingVisibilityHandler);
    this._navigationOwnerChangedRemover = viewer.trackedEntityChanged.addEventListener((entity) => {
      if (entity && !this._disposed) this._stampNavigation();
    });
  }

  /** Advance camera authority: any older deferred flight is now stale. */
  _stampNavigation() {
    this._navigationGeneration += 1;
    return this._navigationGeneration;
  }

  /** Release the camera from any follow or flight before a new destination. */
  _releaseFollowCamera() {
    this.viewer.trackedEntity = undefined;
    interruptCameraMotion('explicit-navigation');
    this.viewer.camera.cancelFlight();
    try {
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch { /* teardown race */ }
  }

  /** Accept a delayed lookup without releasing its current camera owner. */
  _beginDeferredNavigation() {
    return beginDeferredNavigation({
      disposed: this._disposed,
      stamp: () => this._stampNavigation(),
    });
  }

  /** Final authority check and release immediately before a delayed flight. */
  _reassertNavigationHandoff(generation) {
    return reassertNavigationHandoff({
      generation,
      currentGeneration: this._navigationGeneration,
      disposed: this._disposed,
      release: () => this._releaseFollowCamera(),
    });
  }

  /**
   * Creates one CesiumJS PostProcessStage per visual style and registers
   * it with the scene. Each stage starts with intensity 0 (invisible)
   * so crossfade transitions can animate it in later.
   * @returns {void}
   */
  _initStages() {
    for (const [name, shader] of Object.entries(STYLES)) {
      const uniforms = { intensity: 0.0 };

      // Auto-detect time uniform — animated shaders (CRT scanlines, snow, etc.)
      // declare `uniform float time` and receive elapsed seconds each frame.
      if (shader.fragmentShader.includes('uniform float time')) {
        uniforms.time = 0.0;
      }

      // Initialize custom uniforms from shader metadata (e.g. gain, pixelation)
      if (shader.uniforms) {
        for (const [uName, uMeta] of Object.entries(shader.uniforms)) {
          uniforms[uName] = uMeta.default;
        }
      }

      const stage = new Cesium.PostProcessStage({
        name: `godsEyeView_${name}`,
        fragmentShader: shader.fragmentShader,
        uniforms,
      });

      // Zero-intensity stages are DISABLED (perf wave 1): a stage costs a
      // full-screen pass only while its style is showing or fading.
      stage.enabled = false;
      this.viewer.scene.postProcessStages.add(stage);
      this.stages[name] = stage;
    }
    // Frozen after init — cached so the per-frame animation loop doesn't
    // rebuild Object.entries arrays every frame.
    this._stageEntries = Object.entries(this.stages);
  }

  /**
   * Single write path for style-stage intensity: keeps `enabled` in
   * lockstep so zero-intensity stages cost nothing (see _initStages).
   * The stage enables on the same
   * frame the first non-zero intensity lands, so crossfades never pop.
   * @param {Cesium.PostProcessStage} stage - Style post-process stage.
   * @param {number} value - Intensity in [0, 1].
   * @returns {void}
   */
  _setStageIntensity(stage, value) {
    if (!stage) return;
    stage.uniforms.intensity = value;
    stage.enabled = value > 0.001;
    // An animated shader becoming visible needs the style loop (its clock)
    // running again; the loop self-stops when nothing visible animates.
    if (stage.enabled && stage.uniforms.time !== undefined) this._startAnimationLoop();
    governorRequestRender('style-stage');
  }

  /**
   * Adds the custom unsharp-mask sharpen stage at its fixed strength (SHARPEN_AMOUNT).
   * @returns {void}
   */
  _initSharpen() {
    this._sharpenStage = new Cesium.PostProcessStage({
      name: 'godsEyeView_sharpen',
      fragmentShader: SHARPEN_SHADER,
      uniforms: { amount: SHARPEN_AMOUNT },
    });
    this.viewer.scene.postProcessStages.add(this._sharpenStage);
  }

  /**
   * Wires up the style buttons and keyboard shortcuts (1-5 style keys,
   * H/O/V/F hotkeys, Escape) and the clean-view exit button.
   * @returns {void}
   */
  _initUI() {
    // Style buttons
    document.querySelectorAll('.style-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setStyle(btn.dataset.style));
    });

    // Keyboard shortcuts: 1-5, H, V, F
    this._globalKeydownHandler = (e) => {
      // Ignore when interacting with a form control. Global hotkeys
      // ('1'-'5', 'h', 'v', 'f') otherwise fire while a <select> dropdown is
      // focused and its native type-ahead is in use, or while typing in a
      // text field (M9).
      if (e.target?.matches?.('select, input, textarea')) return;

      const keyMap = {
        '1': 'normal', '2': 'retro', '3': 'anime', '4': 'noir', '5': 'snow',
      };
      if (keyMap[e.key]) this.setStyle(keyMap[e.key]);
      if (e.key.toLowerCase() === 'h') {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this.hud.toggle();
        this._scheduleAdaptivePanelLayout({ settle: true });
        this._syncShareState();
      }
      if (e.key.toLowerCase() === 'v') this.toggleCleanView();
      if (e.key.toLowerCase() === 'f') {
        document.getElementById('data-panel').classList.toggle('active');
      }
    };
    document.addEventListener('keydown', this._globalKeydownHandler);

    if (this._cleanViewExitBtn) {
      this._cleanViewExitBtn.addEventListener('click', () => this.toggleCleanView(false));
    }

  }

  /**
   * Renders the map stack chip row from the matching controller entries.
   * @returns {void}
   */
  _initMapStackControl() {
    if (!this._mapStackChips || !this.mapStackController) return;

    if (!this._mapStackChangeHandler) {
      // Provider-driven transitions (notably Esri tile-error fallback) do not
      // pass through `_setMapStack()`. Follow the controller's existing public
      // event so the lit tile, the status line, AND the durable share state all
      // describe the rendered source — without the share sync, a silent
      // fallback leaves copyLink() encoding a stack that is no longer shown.
      this._mapStackChangeHandler = (event) => {
        this._renderMapStackState(event.detail);
        this._syncShareState();
      };
      window.addEventListener('gev:map-stack-changed', this._mapStackChangeHandler);
    }

    renderMapStackChips(this._mapStackChips, this.mapStackController.getStacks(), {
      activeId: this.mapStackController.getActiveId(),
      onSelect: (stackId) => { this._setMapStack(stackId); },
    });

    this._renderMapStackState(this.mapStackController.getState());
  }

  /**
   * Switches the active map/globe source stack.
   * @param {string} stackId - Map stack id.
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true] - Whether to update the share link.
   * @returns {Promise<void>}
   */
  async _setMapStack(stackId, { syncShare = true } = {}) {
    if (!this.mapStackController) return;
    if (syncShare) this.shareLinkManager?.claimRestoreLane?.('map');
    const before = this.mapStackController.getActiveId();
    this._renderMapStackState(this.mapStackController.getState('switching'));
    const state = await this.mapStackController.setStack(stackId);
    this._renderMapStackState(state);

    if (state?.activeId === before && stackId !== before && state?.lastError) {
      this._showToast(state.lastError);
    }
    if (syncShare) this._syncShareState();
  }

  /**
   * Syncs the map stack chip row and status chip with controller state. The
   * lit chip always follows `state.activeId`, never the click — a rejected or
   * superseded switch therefore leaves the genuinely active stack lit.
   * @param {object} state - Map stack controller state.
   * @returns {void}
   */
  _renderMapStackState(state) {
    if (!state) return;
    syncMapStackChips(this._mapStackChips, state.activeId);
    if (this._mapStackStatus) {
      const stack = state.activeStack;
      const label = state.status === 'switching'
        ? '...'
        : (stack?.shortLabel || stack?.label || 'MAP');
      this._mapStackStatus.textContent = label;
      this._mapStackStatus.classList.toggle('warn', !!state.lastError);
    }
  }

  /**
   * Keeps both responsive panel lanes on the same measured layout commit. HUD
   * visibility transitions can outlive the first animation frame, so variant
   * changes receive one bounded settling pass.
   * @param {{settle?: boolean}} [options] Whether to remeasure after transitions.
   * @returns {void}
   */
  _scheduleAdaptivePanelLayout({ settle = false } = {}) {
    this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    if (!settle) return;
    clearTimeout(this._adaptivePanelSettleTimer);
    this._adaptivePanelSettleTimer = setTimeout(() => {
      this._adaptivePanelSettleTimer = null;
      this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    }, PANEL_LAYOUT_SETTLE_MS);
  }

  _syncShareState() {
    this.shareLinkManager.onVisualChange({
      hudVisible: this.hud.visible,
      mapStack: this.mapStackController?.getActiveId?.() || 'esri-imagery',
    });
  }

  /**
   * Initializes panel collapse buttons and restores persisted collapsed state.
   * Also sets up hover-expand behavior for the style presets panel.
   * @returns {void}
   */
  _initPanelChrome() {
    const targets = new Set();
    document.querySelectorAll('.panel-collapse-btn[data-collapse-target]').forEach((btn) => {
      const targetId = btn.dataset.collapseTarget;
      if (targetId) targets.add(targetId);
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.collapseTarget;
        if (!targetId) return;
        const nextCollapsed = !document.getElementById(targetId)?.classList.contains('collapsed');
        this.setPanelCollapsed(targetId, nextCollapsed, { explicit: true });
      });
    });

    for (const targetId of targets) {
      this._restorePanelCollapsedState(targetId, {
        allowStored: !this._initialShareState,
      });
    }
    // The command dock always starts compact; the tray reveals on hover,
    // focus, or click and collapses again after the interaction moves away.
    this.setPanelCollapsed('control-panel', true, { syncShare: false, persist: false });
    this._initAutoHoverPanel('control-panel', { openDelayMs: 140, closeDelayMs: 420 });
    this._initCommandDockPins();
    this._maybeNotifyLayoutReset();
  }

  /**
   * Allows the command-dock tray to remain open until explicitly unpinned.
   * @returns {void}
   */
  _initCommandDockPins() {
    document.querySelectorAll('.dock-pin-btn[data-pin-target]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const panelId = button.dataset.pinTarget;
        this._setCommandDockPanelPinState(panelId);
      });
    });
  }

  _setCommandDockPanelPinState(panelId, pin, {
    restore = false,
    persist = true,
    syncShare = true,
  } = {}) {
    const panelEl = document.getElementById(panelId);
    const button = document.querySelector(`.dock-pin-btn[data-pin-target="${panelId}"]`);
    if (!panelEl || !button) return undefined;
    const shouldPin = typeof pin === 'boolean'
      ? pin
      : !panelEl.classList.contains('dock-pinned');
    panelEl.classList.toggle('dock-pinned', shouldPin);
    button.setAttribute('aria-pressed', String(shouldPin));
    if (shouldPin) {
      this.setPanelCollapsed(panelId, false, {
        explicit: !restore,
        restore,
        persist,
        syncShare: false,
      });
    } else {
      if (!restore && !panelEl.matches(':hover')) {
        this.setPanelCollapsed(panelId, true, {
          explicit: true,
          persist,
          syncShare: false,
        });
      }
    }
    if (syncShare) {
      if (!restore) this.shareLinkManager?.claimRestoreLane?.('panel', panelId);
      this.shareLinkManager?.onPanelStateChange?.();
    }
    return shouldPin;
  }

  /**
   * One-time toast when stored v6 panel positions are superseded by the v7
   * layout defaults (positions reset; collapsed states are preserved).
   * @returns {void}
   */
  _maybeNotifyLayoutReset() {
    try {
      const marker = `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.layoutResetNotified`;
      if (localStorage.getItem(marker)) return;
      localStorage.setItem(marker, '1');
      const hadOldPositions = Object.keys(localStorage)
        .some((key) => key.startsWith('godsEyeView.v6.panelPos.'));
      if (hadOldPositions) {
        this._showToast('Panel layout updated — positions reset to new defaults');
      }
    } catch {
      // storage unavailable
    }
  }

  /**
   * Configures intentional hover-expand / leave-collapse behavior on a panel.
   * Uses separate open/close timers to prevent accidental flicker from fast
   * mouse passes. Wheel events cancel pending opens to avoid surprise expansion
   * during scroll-through.
   * @param {string} panelId - DOM id of the panel element.
   * @param {object} [options]
   * @param {number} [options.openDelayMs=850] - Hover dwell time before auto-expanding.
   * @param {number} [options.closeDelayMs=1000] - Delay after pointer leaves before collapsing.
   * @returns {void}
   */
  _initAutoHoverPanel(panelId, { openDelayMs = 850, closeDelayMs = 1000 } = {}) {
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    const disclosure = panelEl.querySelector(`[data-dock-toggle-target="${panelId}"]`);
    let openTimer = null;
    let closeTimer = null;
    let lastWheelTime = 0;
    let disclosureFocusTimer = null;

    const clearOpen = () => {
      if (!openTimer) return;
      clearTimeout(openTimer);
      openTimer = null;
    };

    const clearClose = () => {
      if (!closeTimer) return;
      clearTimeout(closeTimer);
      closeTimer = null;
    };

    const scheduleOpen = () => {
      clearOpen();
      openTimer = window.setTimeout(() => {
        openTimer = null;
        if (!panelEl.matches(':hover')) return;
        if (performance.now() - lastWheelTime < 280) return;
        if (!panelEl.classList.contains('collapsed')) return;
        this.setPanelCollapsed(panelId, false);
      }, openDelayMs);
    };

    // Focus inside the tray defers the unpinned auto-dismiss, but only for the
    // KEYBOARD: the disclosure hands focus to a Map Source tile on Enter/Space,
    // and closing the tray out from under that focus would strand the caret.
    // Plain `document.activeElement` is the wrong test — Chromium focuses a
    // <button> on mouse press, so once Map Source moved into this tray a tile
    // CLICK left focus parked inside and the popover never dismissed on
    // mouse-away (owner field report). `:focus-visible` is the platform's own
    // pointer-vs-keyboard focus signal, so keyboard focus still holds the tray
    // open while a clicked tile does not. A browser without `:focus-visible`
    // keeps the conservative hold.
    const keyboardFocusInside = () => {
      const active = document.activeElement;
      if (!active || !panelEl.contains(active)) return false;
      try { return active.matches(':focus-visible'); } catch { return true; }
    };

    const scheduleClose = () => {
      clearClose();
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        if (panelEl.matches(':hover') || keyboardFocusInside()) return;
        if (panelEl.classList.contains('dock-pinned')) return;
        if (panelEl.classList.contains('collapsed')) return;
        this.setPanelCollapsed(panelId, true);
      }, closeDelayMs);
    };

    panelEl.addEventListener('wheel', () => {
      lastWheelTime = performance.now();
      clearOpen();
    }, { passive: true });

    panelEl.addEventListener('click', (event) => {
      if (event.target.closest('.panel-collapse-btn, .dock-tray-toggle')) return;
      clearOpen();
      clearClose();
      if (panelEl.classList.contains('collapsed')) {
        this.setPanelCollapsed(panelId, false, { explicit: true });
      }
    });

    panelEl.addEventListener('pointerenter', (event) => {
      const pointerType = event.pointerType || 'mouse';
      if (pointerType !== 'mouse' && pointerType !== 'pen') return;
      clearClose();
      if (panelEl.classList.contains('collapsed')) {
        scheduleOpen();
      }
    });

    panelEl.addEventListener('pointerleave', (event) => {
      const pointerType = event.pointerType || 'mouse';
      if (pointerType !== 'mouse' && pointerType !== 'pen') return;
      clearOpen();
      scheduleClose();
    });

    panelEl.addEventListener('pointerdown', () => {
      clearOpen();
      clearClose();
    });

    const focusMapSource = () => {
      if (panelId !== 'control-panel') return;
      panelEl.querySelector('.map-stack-chip.active, .map-stack-chip')?.focus?.({ preventScroll: true });
    };

    const scheduleMapSourceFocus = () => {
      clearTimeout(disclosureFocusTimer);
      disclosureFocusTimer = window.setTimeout(() => {
        disclosureFocusTimer = null;
        if (!panelEl.classList.contains('collapsed')) focusMapSource();
      }, 240);
    };

    const toggleDisclosure = ({ focusSource = false } = {}) => {
      clearOpen();
      clearClose();
      const shouldOpen = panelEl.classList.contains('collapsed');
      this.setPanelCollapsed(panelId, !shouldOpen, { explicit: true });
      if (shouldOpen && focusSource) scheduleMapSourceFocus();
    };

    disclosure?.addEventListener('click', (event) => {
      event.stopPropagation();
      // Keep native button activation semantics: Enter activates on keydown,
      // Space on keyup, and pointer clicks report a non-zero detail. Scheduling
      // focus from the synthesized click avoids a key latch that can outlive the
      // disclosure after a long Enter hold moves focus into the tray.
      toggleDisclosure({ focusSource: event.detail === 0 });
    });
    disclosure?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // The application-level Space shortcut must not steal activation from a
      // focused disclosure. One non-repeating keydown is enough; no keyup latch
      // is retained after focus moves into the tray.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      toggleDisclosure({ focusSource: true });
    });

    panelEl.addEventListener('focusin', () => clearClose());
    panelEl.addEventListener('focusout', (event) => {
      if (panelEl.contains(event.relatedTarget)) return;
      scheduleClose();
    });
    panelEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || panelEl.classList.contains('collapsed')) return;
      event.preventDefault();
      clearOpen();
      clearClose();
      this.setPanelCollapsed(panelId, true, { explicit: true });
      disclosure?.focus?.({ preventScroll: true });
    });
  }

  /**
   * Connects the layer data manager for loading feedback and durable layer state.
   * @param {object|null} dataManager - The DataManager instance, or null to detach.
   * @returns {void}
   */
  attachDataManager(dataManager) {
    this._dataManager = dataManager || null;
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        this._loadingFeedbackEvent = change;
        this._updateGlobalLoadingFeedback(performance.now());
      });
    }
    this._updateGlobalLoadingFeedback(performance.now());
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    if (this._dataManager) {
      this._layerStateCoordinator = new LayerStateCoordinator(this._dataManager, this.shareLinkManager);
      this._layerStateRestorePromise = this._layerStateCoordinator.start({
        shareLayerState: this._initialShareState?.layerState || null,
        // Any valid camera/style share isolates recipient-local preferences,
        // including legacy and malformed-v2 layer payloads.
        allowLocalState: !this._initialShareState,
      });
    }
  }

  /*
   * Cross-mode cancellation and failure deliberately settle on Context OFF.
   *
   * A reinstatement transaction lived here for three review rounds and was
   * removed on purpose. Restoring the prior mode is genuinely racy: the prior
   * mode has to be read before the teardown, but a second request arriving
   * while the first reinstatement is mid-activation reads `_contextMode` as
   * null and inherits nothing, so two overlapping cancellations still land on
   * OFF — and the only fix is a cross-transaction "logical prior mode" chain,
   * which is new shared mutable state read while an earlier transaction is
   * still awaiting. That trades a rare wrong resting state for a permanent
   * interleaving hazard.
   *
   * The defect that started this was the LIE, not the OFF: the transition
   * claimed to have cancelled cleanly while silently leaving Context off. So
   * the resting state stays OFF and is REPORTED as such, with the failed layer
   * ids preserved. A restore feature can be rebuilt post-launch on the
   * generation discipline the surrounding transaction already follows.
   */

  /**
   * Returns the versioned localStorage key for a panel's collapsed state.
   * @param {string} panelId - DOM id of the panel.
   * @returns {string} localStorage key.
   */
  _panelCollapseStorageKey(panelId) {
    return `godsEyeView.${PANEL_LAYOUT_STORAGE_VERSION}.panelCollapsed.${panelId}`;
  }

  /**
   * Restores a panel's collapsed/expanded state from localStorage.
   * Falls back to the CSS class default if no saved state exists.
   * @param {string} panelId - DOM id of the panel.
   * @returns {void}
   */
  _restorePanelCollapsedState(panelId, { allowStored = true } = {}) {
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    let collapsed = panelEl.classList.contains('collapsed');
    let stored = null;
    if (allowStored) {
      try {
        stored = localStorage.getItem(this._panelCollapseStorageKey(panelId));
        if (stored === '1') collapsed = true;
        if (stored === '0') collapsed = false;
      } catch {
        // storage unavailable
      }
    }
    panelEl.classList.toggle('collapsed', collapsed);
    this._syncPanelCollapseButton(panelEl);
  }

  /**
   * Persists a panel's collapsed state ('1' or '0') to localStorage.
   * @param {string} panelId - DOM id of the panel.
   * @param {boolean} collapsed - Whether the panel is collapsed.
   * @returns {void}
   */
  _savePanelCollapsedState(panelId, collapsed) {
    try {
      localStorage.setItem(this._panelCollapseStorageKey(panelId), collapsed ? '1' : '0');
    } catch {
      // storage unavailable
    }
  }

  /**
   * Initializes the adaptive left accordion. The layout engine measures the
   * actual HUD/chrome rectangles that intersect the left lane, then decides
   * whether collapsed sibling labels can remain visible beside the expanded
   * panel. No decision is keyed to a specific panel or HUD variant.
   * @returns {void}
   */
  _initLeftPanelAdaptiveLayout() {
    const stack = this._leftPanelStack;
    if (!stack) return;

    if (typeof ResizeObserver !== 'undefined') {
      this._leftStackResizeObserver = new ResizeObserver(() => {
        this._scheduleLeftPanelLayout();
      });
      this._leftStackResizeObserver.observe(stack);
      stack.querySelectorAll(':scope > [data-panel-id]').forEach((panel) => {
        this._leftStackResizeObserver.observe(panel);
        const inner = [...panel.children].find((child) => !child.classList.contains('panel-glow'));
        if (inner) this._leftStackResizeObserver.observe(inner);
      });
      document.querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR).forEach((element) => {
        this._leftStackResizeObserver.observe(element);
      });
    }

    if (typeof MutationObserver !== 'undefined') {
      this._leftStackMutationObserver = new MutationObserver(() => {
        this._scheduleLeftPanelLayout();
      });
      this._leftStackMutationObserver.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      const hud = document.getElementById('intel-hud');
      if (hud) {
        this._leftStackMutationObserver.observe(hud, {
          attributes: true,
          attributeFilter: ['class', 'data-variant'],
        });
      }
      const credits = document.getElementById('cesium-credits');
      if (credits) {
        this._leftStackMutationObserver.observe(credits, {
          subtree: true,
          childList: true,
        });
      }
    }

    const transitionHud = document.getElementById('intel-hud');
    if (transitionHud) {
      this._leftStackHudTransitionHandler = (event) => {
        if (event.propertyName === 'opacity' || event.propertyName === 'visibility') {
          this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
        }
      };
      transitionHud.addEventListener('transitionend', this._leftStackHudTransitionHandler);
    }

    // R9-I1: the lane reads each panel's computed visibility, and a visibility transition (the data panel's F toggle, clean view) changes it
    // only at an end: a hiding panel reads visible until the transition ends, and a showing panel reads hidden as it starts. The class
    // change's pass runs as it starts, so the transition's end schedules another; without it the lane kept the mode it had before the change.
    this._leftStackPanelTransitionHandler = (event) => {
      if (event.propertyName === 'visibility' && event.target.parentElement === stack) this._scheduleLeftPanelLayout();
    };
    stack.addEventListener('transitionend', this._leftStackPanelTransitionHandler);

    this._scheduleLeftPanelLayout();
  }

  /**
   * Batches adaptive accordion work into one animation frame.
   * @returns {void}
   */
  _scheduleLeftPanelLayout({ reconsiderAutoCollapse = false } = {}) {
    if (reconsiderAutoCollapse) this._leftStackReconsiderAutoCollapse = true;
    if (!this._leftPanelStack || this._leftStackLayoutFrame !== null) return;
    this._leftStackLayoutFrame = requestAnimationFrame(() => {
      this._leftStackLayoutFrame = null;
      if (this._leftStackReconsiderAutoCollapse) {
        this._leftStackReconsiderAutoCollapse = false;
        for (const panel of this._leftPanelStack.querySelectorAll('.layout-auto-collapsed')) {
          panel.classList.remove('collapsed', 'layout-auto-collapsed');
          this._syncPanelCollapseButton(panel);
        }
      }
      this._syncLeftPanelAdaptiveLayout();
    });
  }

  /**
   * Estimates an expanded panel's unconstrained content height from its
   * visible direct children and their scroll extents. This avoids treating a
   * flex-grown panel as naturally tall while still accounting for nested lists.
   * @param {HTMLElement} panel - Expanded accordion panel.
   * @returns {number} Natural height in rendered CSS pixels.
   */
  _measureLeftPanelNaturalHeight(panel) {
    return measureLeftPanelNaturalHeight(panel);
  }

  /**
   * Measures a live obstacle-free corridor for the left accordion and toggles
   * focus mode only when the expanded panel plus sibling labels cannot fit.
   * Safe boundaries are written as viewport-relative CSS values.
   * @returns {void}
   */
  _syncLeftPanelAdaptiveLayout() {
    const stack = this._leftPanelStack;
    if (!stack) return;

    const panels = [...stack.querySelectorAll(':scope > [data-panel-id]')];
    if (!panels.length) return;
    if (!this.hud.visible || this.hud.getVariant() !== 'tactical') {
      for (const panel of panels.filter((item) => item.classList.contains('layout-auto-collapsed'))) {
        panel.classList.remove('collapsed', 'layout-auto-collapsed');
        this._syncPanelCollapseButton(panel);
      }
    }

    // The existing narrow-screen composition has its own full-width stack.
    // Keep this desktop lane engine from fighting those dedicated rules. Fix round 5: a short viewport (SHORT_VIEWPORT_QUERY) at any width
    // has its own stack rules too (style.css); the lane engine gave it a 38 px band there, so an open panel showed only its header.
    if (window.matchMedia('(max-width: 720px)').matches || window.matchMedia(SHORT_VIEWPORT_QUERY).matches) {
      stack.classList.remove('layout-focus');
      stack.classList.remove('layout-tail');
      stack.style.removeProperty('--left-stack-safe-top');
      stack.style.removeProperty('--left-stack-safe-bottom');
      stack.style.removeProperty('--left-stack-centered-height');
      stack.dataset.layoutMode = 'mobile';
      for (const panel of panels) {
        panel.removeAttribute('aria-hidden');
        panel.style.removeProperty('--left-panel-allocated-height');
      }
      // Fix round 6 (critic r5 S1): on a short viewport the stack's column and the card's column start below the header boxes over them,
      // measured here (the title grows with the window), not at a fixed 70/76 px, which covered the tagline on windows wider than 720 px.
      const root = document.documentElement;
      if (window.matchMedia(SHORT_VIEWPORT_QUERY).matches) {
        const boxes = [...document.querySelectorAll(SHORT_HEADER_SELECTOR)].map((element) => element.getBoundingClientRect());
        const stackLeft = stack.getBoundingClientRect().left;
        // 4 px below the header, the gap the pills keep between each other: at 568x320 the three 38 px pills need all but 3.6 px of what is left.
        const stackTop = topBelowHeader({ boxes, left: stackLeft, right: stackLeft + Math.min(460, window.innerWidth - 32), viewportHeight: window.innerHeight, gap: 4 });
        const card = document.getElementById('bio-card');
        const cardLeft = parseFloat(card ? getComputedStyle(card).getPropertyValue('--short-card-left') : '') || 200;
        const cardTop = topBelowHeader({ boxes, left: cardLeft, right: window.innerWidth - 16, viewportHeight: window.innerHeight });
        root.style.setProperty('--short-stack-top', `${Math.max(stackTop, 8)}px`);
        root.style.setProperty('--short-card-top', `${Math.max(cardTop, 8)}px`);
      } else {
        root.style.removeProperty('--short-stack-top');
        root.style.removeProperty('--short-card-top');
      }
      return;
    }

    const viewportHeight = Math.max(1, window.innerHeight);
    const stackRect = stack.getBoundingClientRect();
    const baseTop = viewportHeight * 0.26;
    const baseBottomInset = viewportHeight * 0.04;
    const safeGap = viewportHeight * 0.012;
    let obstacleSafeTop = viewportHeight * 0.04;
    let safeTop = baseTop;
    let safeBottom = viewportHeight - baseBottomInset;
    const bottomObstacles = [];

    for (const obstacle of document.querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR)) {
      if (stack.contains(obstacle)) continue;
      let hiddenByAncestor = false;
      for (let element = obstacle; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          hiddenByAncestor = true;
          break;
        }
      }
      if (hiddenByAncestor) continue;
      const rect = obstacle.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const overlapsHorizontally = rect.right > stackRect.left && rect.left < stackRect.right;
      if (!overlapsHorizontally) continue;

      if (rect.top < baseTop && rect.bottom <= viewportHeight * 0.5) {
        const obstacleBottom = rect.bottom + safeGap;
        obstacleSafeTop = Math.max(obstacleSafeTop, obstacleBottom);
        safeTop = Math.max(safeTop, obstacleBottom);
      } else if (rect.top >= baseTop) {
        bottomObstacles.push({ top: rect.top });
      }
    }
    safeBottom = resolveLeftStackBottomBoundary({
      baseBottom: safeBottom,
      obstacles: bottomObstacles,
      safeGap,
    });

    const obstacleSafeBottom = safeBottom;

    // Keep the accordion visually centered when the balanced corridor remains
    // useful. During live viewport-height changes, retain the aligned lane
    // instead of extending a tiny midpoint corridor through a lower obstacle.
    const minimumLaneHeight = viewportHeight * 0.16;
    ({ safeTop, safeBottom } = resolvePanelStackCorridor({
      viewportHeight,
      safeTop,
      safeBottom,
      obstacleSafeTop,
      obstacleSafeBottom,
      minimumHeight: minimumLaneHeight,
    }));
    const viewportMidpoint = viewportHeight * 0.5;
    for (const panel of panels) {
      const rect = panel.getBoundingClientRect();
      if (panel.classList.contains('collapsed') && rect.height > 0) {
        this._leftStackCollapsedHeights.set(panel.id, rect.height);
      }
    }

    const expandedPanelsInDomOrder = panels.filter((panel) => !panel.classList.contains('collapsed'));
    const preferredExpandedPanel = expandedPanelsInDomOrder.find(
      (panel) => panel.id === this._leftStackPreferredPanelId,
    );
    // Auto-collapse is a presentation fallback, not permission to undo the
    // user's newest disclosure. Measure and allocate that explicitly opened
    // panel first so an older expanded sibling yields when the corridor cannot
    // usefully present both (for example Map Stack followed by Scenes).
    const expandedPanels = preferredExpandedPanel
      ? [preferredExpandedPanel, ...expandedPanelsInDomOrder.filter((panel) => panel !== preferredExpandedPanel)]
      : expandedPanelsInDomOrder;
    // Clear the prior pass before reading intrinsic heights. The allocated
    // outer height and the inner scroller otherwise feed their constrained
    // size back into the next HUD-mode calculation.
    for (const panel of expandedPanels) {
      panel.style.removeProperty('--left-panel-allocated-height');
    }
    const availableHeight = Math.max(0, safeBottom - safeTop);
    const naturalExpandedHeights = expandedPanels.map((panel) => this._measureLeftPanelNaturalHeight(panel));
    const naturalExpandedHeight = naturalExpandedHeights.reduce((sum, height) => sum + height, 0);
    const siblingHeight = panels.reduce((total, panel) => {
      if (!panel.classList.contains('collapsed')) return total;
      const measured = this._leftStackCollapsedHeights.get(panel.id);
      return total + (measured || panel.getBoundingClientRect().height || 0);
    }, 0);
    let requiredHeight = siblingHeight;

    const rowGap = parseFloat(getComputedStyle(stack).rowGap) || 0;
    if (expandedPanels.length) {
      requiredHeight += naturalExpandedHeight;
      requiredHeight += rowGap * Math.max(0, panels.length - 1);
    } else {
      requiredHeight += rowGap * Math.max(0, panels.length - 1);
    }

    const wasFocused = stack.classList.contains('layout-focus');
    const wasTail = stack.classList.contains('layout-tail');
    const wasConstrained = wasFocused || wasTail;
    const stabilityBand = viewportHeight * 0.01;
    const exceedsCenteredCorridor = expandedPanels.length > 0 && (wasConstrained
      ? requiredHeight > availableHeight - stabilityBand * 2
      : requiredHeight > availableHeight - stabilityBand);
    const tailRequiredHeight = naturalExpandedHeight
      + siblingHeight
      + rowGap * Math.max(0, panels.length - 1);
    // A compact expansion should not make the whole control stack jump down
    // merely to center a few short rows. Preserve the normal top anchor when
    // the centered stack would begin below it; tall stacks can still grow
    // upward around the viewport midpoint as their content requires.
    const centeredTailTop = viewportMidpoint - tailRequiredHeight * 0.5;
    const tailLayoutTop = Math.min(centeredTailTop, safeTop);
    const tailLayoutBottom = tailLayoutTop + tailRequiredHeight;
    const tailAvailableHeight = Math.max(0, obstacleSafeBottom - obstacleSafeTop);
    const tailTolerance = wasTail ? stabilityBand : -stabilityBand;
    const shouldTail = expandedPanels.length > 0
      && tailLayoutTop >= obstacleSafeTop - tailTolerance
      && tailLayoutBottom <= obstacleSafeBottom + tailTolerance;
    const shouldFocus = exceedsCenteredCorridor && !shouldTail;
    // Focus mode owns the lane, so let every expanded panel share the full
    // obstacle-safe corridor. Tail/normal layouts keep the balanced
    // viewport centering used for compact accordion stacks.
    const layoutTop = shouldFocus
      ? obstacleSafeTop
      : shouldTail ? tailLayoutTop : safeTop;
    const layoutBottom = shouldFocus
      ? obstacleSafeBottom
      : shouldTail ? tailLayoutBottom : safeBottom;
    const topPct = (layoutTop / viewportHeight) * 100;
    const bottomPct = ((viewportHeight - layoutBottom) / viewportHeight) * 100;
    const topValue = `${topPct.toFixed(3)}vh`;
    const bottomValue = `${bottomPct.toFixed(3)}vh`;
    const expandedAvailableHeight = shouldFocus
      ? Math.max(0, layoutBottom - layoutTop
        - rowGap * Math.max(0, expandedPanels.length - 1))
      : naturalExpandedHeight;
    const allocatedExpandedHeights = allocatePanelStackHeights({
      naturalHeights: naturalExpandedHeights,
      availableHeight: expandedAvailableHeight,
    });
    const autoCollapseIndices = this.hud.visible ? panelStackAutoCollapseIndices({
      naturalHeights: naturalExpandedHeights,
      allocatedHeights: allocatedExpandedHeights,
      collapseLaterPanels: shouldFocus && this.hud.getVariant() === 'tactical',
    }) : [];
    if (autoCollapseIndices.length) {
      for (const index of autoCollapseIndices) {
        const panel = expandedPanels[index];
        panel.classList.add('collapsed', 'layout-auto-collapsed');
        this._syncPanelCollapseButton(panel);
      }
      this._scheduleLeftPanelLayout();
      return;
    }
    if (stack.style.getPropertyValue('--left-stack-safe-top') !== topValue) {
      stack.style.setProperty('--left-stack-safe-top', topValue);
    }
    if (stack.style.getPropertyValue('--left-stack-safe-bottom') !== bottomValue) {
      stack.style.setProperty('--left-stack-safe-bottom', bottomValue);
    }
    stack.style.removeProperty('--left-stack-centered-height');
    for (const panel of panels) panel.style.removeProperty('--left-panel-allocated-height');
    expandedPanels.forEach((panel, index) => {
      panel.style.setProperty('--left-panel-allocated-height', `${allocatedExpandedHeights[index].toFixed(1)}px`);
    });

    stack.classList.toggle('layout-focus', shouldFocus);
    stack.classList.toggle('layout-tail', shouldTail);
    stack.dataset.layoutMode = shouldFocus ? 'focus' : shouldTail ? 'tail' : 'normal';
    stack.dataset.safeTopPct = topPct.toFixed(2);
    stack.dataset.safeBottomPct = (100 - bottomPct).toFixed(2);
    stack.dataset.availableHeightPct = ((availableHeight / viewportHeight) * 100).toFixed(2);
    stack.dataset.requiredHeightPct = ((requiredHeight / viewportHeight) * 100).toFixed(2);
    stack.dataset.tailAvailableHeightPct = ((tailAvailableHeight / viewportHeight) * 100).toFixed(2);
    stack.dataset.expandedCount = String(expandedPanels.length);

    for (const panel of panels) {
      const hiddenSibling = shouldFocus && panel.classList.contains('collapsed');
      if (hiddenSibling) panel.setAttribute('aria-hidden', 'true');
      else panel.removeAttribute('aria-hidden');
    }
  }

  /**
   * Updates collapse button glyphs based on panel state. Right-rail panels
   * use directional arrows; left-stack panels use +/- symbols.
   * @param {HTMLElement} panelEl - The panel DOM element.
   * @returns {void}
   */
  _syncPanelCollapseButton(panelEl) {
    const collapsed = panelEl.classList.contains('collapsed');
    panelEl.querySelectorAll('.panel-collapse-btn[data-collapse-target]').forEach((btn) => {
      if (btn.closest('[data-panel-id]') !== panelEl) return;
      btn.textContent = collapsed ? '+' : '−';
      btn.setAttribute('aria-expanded', String(!collapsed));
      const panelName = panelEl.querySelector('.panel-title, .pp-header-label')?.textContent?.trim() || 'panel';
      const action = collapsed ? 'Expand' : 'Collapse';
      btn.title = `${action} ${panelName}`;
      btn.setAttribute('aria-label', `${action} ${panelName}`);
    });
    const dockToggle = panelEl.querySelector(`[data-dock-toggle-target="${panelEl.id}"]`);
    if (dockToggle) {
      const panelName = panelEl.querySelector('.panel-title')?.textContent?.trim() || 'panel';
      const action = collapsed ? 'Expand' : 'Collapse';
      dockToggle.setAttribute('aria-expanded', String(!collapsed));
      dockToggle.setAttribute('aria-label', `${action} ${panelName}`);
      dockToggle.title = `${action} ${panelName}`;
    }
  }

  _buildSharePanelState() {
    const specs = [];
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const panelEl = document.getElementById(spec.id);
      if (!panelEl) continue;
      // Responsive auto-collapse is presentation only; the recipient should
      // restore the user's explicit expanded preference at its own viewport.
      const collapsed = panelEl.classList.contains('layout-auto-collapsed')
        ? false
        : panelEl.classList.contains('collapsed');
      const entry = { id: spec.id, collapsed };
      if (spec.pinnable) entry.pinned = panelEl.classList.contains('dock-pinned');
      specs.push(entry);
    }
    return specs.length ? { specs } : null;
  }

  _restorePanelState(panelState) {
    if (!panelState || !Array.isArray(panelState.specs)) return;
    const specsById = new Map(panelState.specs.map((spec) => [spec.id, spec]));
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const state = specsById.get(spec.id);
      if (!state || typeof state.collapsed !== 'boolean') continue;
      if (spec.pinnable && typeof state.pinned === 'boolean') {
        this._setCommandDockPanelPinState(spec.id, state.pinned, {
          restore: true,
          persist: false,
          syncShare: false,
        });
      }
      const nextCollapsed = state.pinned && spec.pinnable ? false : state.collapsed;
      this.setPanelCollapsed(spec.id, nextCollapsed, {
        restore: true,
        persist: false,
        syncShare: false,
      });
    }
    this.shareLinkManager?.onPanelStateChange?.();
  }

  /**
   * Programmatically collapses or expands a panel, persists the state,
   * and triggers layout recalculation for dependent panels.
   * @param {string} panelId - DOM id of the panel.
   * @param {boolean} collapsed - Whether to collapse the panel.
   * @param {object} [options] Disclosure ownership options.
   * @param {boolean} [options.explicit=false] Whether a direct user action owns the panel lane.
   * @returns {void}
   */
  setPanelCollapsed(panelId, collapsed, {
    explicit = false,
    restore = false,
    persist = true,
    syncShare = true,
  } = {}) {
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    if (explicit && !restore) this.shareLinkManager?.claimRestoreLane?.('panel', panelId);
    const nextCollapsed = Boolean(collapsed);
    const wasAutoCollapsed = panelEl.classList.contains('layout-auto-collapsed');
    const leftOwnerPanel = this._leftPanelStack?.contains(panelEl) ? panelEl : null;
    const priorLeftOwner = this._leftStackPreferredPanelId;
    if (explicit && !restore && !nextCollapsed && leftOwnerPanel) {
      this._leftStackPreferredPanelId = leftOwnerPanel.id;
    } else if (explicit && !restore && nextCollapsed && leftOwnerPanel?.id === this._leftStackPreferredPanelId) {
      this._leftStackPreferredPanelId = null;
    }
    if (panelEl.classList.contains('collapsed') === nextCollapsed && !wasAutoCollapsed) {
      this._syncPanelCollapseButton(panelEl);
      if (priorLeftOwner !== this._leftStackPreferredPanelId) {
        this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
      }
      return;
    }
    panelEl.classList.remove('layout-auto-collapsed');
    // Final review m-1: at phone width the left stack is an accordion (one open panel; the others' pills are hidden, style.css), so opening a
    // panel collapses the open ones, whatever opened it; a share link restoring several open panels ends with the last one open.
    if (!nextCollapsed && leftOwnerPanel && (window.matchMedia('(max-width: 720px)').matches || window.matchMedia(SHORT_VIEWPORT_QUERY).matches)) {
      const stackPanels = [...this._leftPanelStack.querySelectorAll(':scope > [data-panel-id]')]
        .map((panel) => ({ id: panel.id, collapsed: panel.classList.contains('collapsed') }));
      for (const siblingId of phoneAccordionSiblingsToCollapse({ panels: stackPanels, openedId: panelId })) {
        this.setPanelCollapsed(siblingId, true, { restore, persist, syncShare });
      }
    }
    panelEl.classList.toggle('collapsed', nextCollapsed);
    this._syncPanelCollapseButton(panelEl);
    if (persist !== false) this._savePanelCollapsedState(panelId, nextCollapsed);
    this._scheduleLeftPanelLayout({
      reconsiderAutoCollapse: this._leftPanelStack?.contains(panelEl) === true,
    });
    if (syncShare) this.shareLinkManager?.onPanelStateChange?.();
  }

  /**
   * Toggles "clean view" mode which hides all UI panels via a CSS body class.
   * @param {boolean} [forceEnabled] - Explicit on/off. Omit to toggle.
   * @returns {void}
   */
  toggleCleanView(forceEnabled) {
    const shouldEnable = typeof forceEnabled === 'boolean'
      ? forceEnabled
      : !document.body.classList.contains('ui-clean-view');
    document.body.classList.toggle('ui-clean-view', shouldEnable);
    this._scheduleLeftPanelLayout();
  }

  /**
   * Resets the safe-frame overlay to its inactive state on init.
   * @returns {void}
   */
  _initRecordingOverlay() {
    if (!this._safeFrameOverlay || !this._safeFrameBox) return;
    this._safeFrameOverlay.classList.remove('active', 'ratio-9-16', 'ratio-16-9');
  }

  /**
   * Enters or exits recording mode. When active, hides UI chrome via a body class,
   * displays a safe-frame composition overlay (16:9 or 9:16), and switches
   * the HUD to the specified mode. Exiting restores the HUD mode and layout
   * variant that were active before recording started.
   * @param {boolean} enabled - Whether to enable recording mode.
   * @param {object} [options]
   * @param {boolean} [options.hidePanels=true] - Hide all panel chrome.
   * @param {string} [options.hudMode='minimal'] - HUD mode while recording ('off'|'minimal'|'full'|'auto').
   * @param {string} [options.safeFrame='16:9'] - Aspect ratio for the safe-frame overlay.
   * @returns {void}
   */
  setRecordingMode(enabled, options = {}) {
    const { hidePanels = true, hudMode = 'minimal', safeFrame = '16:9' } = options;
    this._recordingMode = !!enabled;
    this._recordingConfig = { hidePanels, hudMode, safeFrame };

    document.body.classList.toggle('recording-mode', this._recordingMode && hidePanels);

    if (this._safeFrameOverlay) {
      this._safeFrameOverlay.classList.remove('ratio-9-16', 'ratio-16-9');
      this._safeFrameOverlay.classList.toggle('active', this._recordingMode);
      this._safeFrameOverlay.classList.add(safeFrame === '9:16' ? 'ratio-9-16' : 'ratio-16-9');
    }

    if (this._recordingMode) {
      // Snapshot the user's HUD state once per recording session so exit can
      // restore it (re-entrant calls must not capture mid-recording state).
      if (!this._preRecordingHudState) {
        this._preRecordingHudState = {
          mode: this.hud.getMode(),
          variant: this.hud.getVariant(),
        };
      }
      if (hudMode === 'off') {
        this.hud.setMode('off');
      } else if (hudMode === 'full' || hudMode === 'minimal') {
        this.hud.setMode('on');
        this.hud.setVariant(hudMode === 'minimal' ? 'minimal' : 'tactical');
      } else {
        this.hud.setMode('auto');
      }
    } else {
      const saved = this._preRecordingHudState;
      this._preRecordingHudState = null;
      if (saved) {
        this.hud.setVariant(saved.variant);
      }
      this.hud.setMode(saved ? saved.mode : 'auto');
      if (this._safeFrameOverlay) {
        this._safeFrameOverlay.classList.remove('active', 'ratio-9-16', 'ratio-16-9');
      }
    }
    this._scheduleAdaptivePanelLayout({ settle: true });
    this._syncShareState();
  }

  // ── Parameter Sliders ─────────────────────────

  // ── Style switching ───────────────────────────

  /**
   * Switches the active visual style. Handles full lifecycle:
   * 1. Crossfades the previous shader stage intensity to 0.
   * 2. Crossfades the new shader stage intensity to 1.
   * 3. Updates button highlights, style indicator and HUD.
   * @param {string} styleName - Target style ('normal'|'retro'|'anime'|'noir'|'snow').
   * @param {object} [options]
   * @param {boolean} [options.restore=false] - A share-link restore, which must not claim the visual lane.
   * @returns {void}
   */
  setStyle(styleName, { restore = false } = {}) {
    if (!restore) this.shareLinkManager?.claimRestoreLane?.('visual');
    if (styleName === this.activeStyle) return;

    const previousStyle = this.activeStyle;
    this.activeStyle = styleName;
    document.documentElement.dataset.gevStyle = styleName;

    // Transition out the previous shader style
    if (previousStyle !== 'normal' && this.stages[previousStyle]) {
      this._startTransition(previousStyle, this.stages[previousStyle].uniforms.intensity, 0.0);
    }

    // Transition in the new shader style
    if (styleName !== 'normal' && this.stages[styleName]) {
      this._startTransition(styleName, this.stages[styleName].uniforms.intensity, 1.0);
    }

    // Update button UI
    document.querySelectorAll('.style-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.style === styleName);
    });

    // Update style indicator
    const displayNames = { retro: 'CRT' };
    this._styleIndicator.textContent = displayNames[styleName] || styleName.toUpperCase();
    this._updateStyleMiniStatus(styleName);

    // Notify HUD (color adaptation + auto show/hide)
    this.hud.onStyleChange(styleName);
    this._scheduleAdaptivePanelLayout({ settle: true });

    window.dispatchEvent(new CustomEvent('gev:style-change', {
      detail: { style: styleName },
    }));

    // Notify share link manager
    this.shareLinkManager.onStyleChange(styleName);
    this._syncShareState();
  }

  // ── Shader transitions ────────────────────────

  /**
   * Enqueues a smooth intensity transition for a shader stage. The animation
   * loop interpolates from `fromValue` to `toValue` over TRANSITION_DURATION_MS.
   * @param {string} styleName - Name of the shader stage to transition.
   * @param {number} fromValue - Starting intensity (typically current value).
   * @param {number} toValue - Target intensity (0.0 to fade out, 1.0 to fade in).
   * @returns {void}
   */
  _startTransition(styleName, fromValue, toValue) {
    this.transitions.set(styleName, {
      start: performance.now(),
      from: fromValue,
      to: toValue,
    });
    this._startAnimationLoop();
  }

  /**
   * Sample the manager's layer set and paint the global loading chip.
   * Driven by manager events AND by a ticker, because the underlying state
   * machine is TIME-driven (reveal delay, long-load threshold, terminal
   * dwell) — see _armLoadingFeedbackTicker.
   * @param {number} [now] - performance.now() sample.
   * @returns {void}
   */
  _updateGlobalLoadingFeedback(now = performance.now()) {
    if (!this._globalLoadingStatus) return;
    const summary = aggregateLayerLoading(this._dataManager?.getAll?.() || []);
    this._loadingFeedbackState = reduceLoadingFeedback(
      this._loadingFeedbackState,
      summary,
      now,
      this._loadingFeedbackEvent,
    );
    this._loadingFeedbackEvent = null;
    const presentation = presentGlobalLoadingStatus(
      this._globalStatusNotice,
      this._loadingFeedbackState,
      summary,
      now,
    );
    if (this._globalStatusNotice?.persistent !== true
        && Number.isFinite(this._globalStatusNotice?.hideAt)
        && now >= this._globalStatusNotice.hideAt) {
      this._globalStatusNotice = null;
    }
    // Loading phases and universal notices both have time-driven transitions.
    // Compute this after arbitration: a queued finite notice starts its dwell
    // only on its first visible frame, then keeps the ticker alive to expiry.
    const noticeNeedsTicker = Number.isFinite(this._globalStatusNotice?.hideAt);
    if (this._loadingFeedbackState?.phase !== 'idle' || noticeNeedsTicker) {
      this._armLoadingFeedbackTicker();
    }
    this._globalLoadingStatus.hidden = !presentation;
    if (!presentation) {
      delete this._globalLoadingStatus.dataset.state;
      return;
    }
    this._globalLoadingStatus.dataset.state = presentation.state;
    // Split-flap the LABEL only ("LOADING LIVE DATA" -> "LOAD COMPLETE").
    // setSplitFlapText is a no-op when the text is unchanged, which matters
    // here: this runs on every 60 ms and 500 ms tick. The detail line is the
    // live layer roster inside an ellipsised, width-capped span — flapping a
    // list that churns as layers join would be noise, not delight.
    setSplitFlapText(this._globalLoadingLabel, presentation.label);
    this._globalLoadingDetail.textContent = presentation.detail;
  }

  /** Show a message in the universal top-center status banner. */
  _showGlobalStatusNotice(message, options = {}) {
    const now = performance.now();
    this._globalStatusNotice = createGlobalStatusNotice(message, now, options);
    this._updateGlobalLoadingFeedback(now);
  }

  /**
   * Style animation loop — self-stopping (perf wave 2). Runs only while a
   * crossfade is in flight or an animated (time-uniform) stage is visible,
   * holding continuous scene render for exactly that long. Re-armed by
   * _startTransition and by _setStageIntensity enabling an animated stage.
   * The traffic sync chip no longer rides this loop — it has its own 500 ms
   * interval (see _startTrafficChipTicker).
   */
  _startAnimationLoop() {
    if (this._animFrameId) return; // already running
    const update = () => {
      const now = performance.now();
      const elapsedSec = (Date.now() - this.startTime) / 1000.0;

      // Update transitions — interpolate each active crossfade
      for (const [styleName, transition] of this.transitions) {
        const elapsed = now - transition.start;
        const t = Math.min(elapsed / TRANSITION_DURATION_MS, 1.0);
        // Ease-in-out quadratic: smooth acceleration then deceleration
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const value = transition.from + (transition.to - transition.from) * eased;

        this._setStageIntensity(this.stages[styleName], value);

        if (t >= 1.0) {
          this._setStageIntensity(this.stages[styleName], transition.to);
          this.transitions.delete(styleName);
        }
      }

      // Update time uniforms for animated shaders. Zero-intensity stages
      // are disabled (see _initStages), so enabled === visible here; only these keep
      // the loop and its continuous-render hold alive.
      let animatedStageVisible = false;
      for (const [, stage] of this._stageEntries) {
        if (stage.enabled && stage.uniforms.time !== undefined) {
          stage.uniforms.time = elapsedSec;
          // Chain mode keeps zero-intensity stages ENABLED for pass parity —
          // only a stage that is actually VISIBLE keeps the loop (and the
          // continuous-render hold) alive, or a settled CRT session would
          // hold the loop forever via an invisible snow stage.
          if (stage.uniforms.intensity > 0.001) animatedStageVisible = true;
        }
      }

      const needed = this.transitions.size > 0 || animatedStageVisible;
      if (needed) holdContinuousRender('style-anim');
      else releaseContinuousRender('style-anim');
      if (!needed) {
        this._animFrameId = null;
        return; // settled — the next transition/animated stage re-arms us
      }
      this._animFrameId = requestAnimationFrame(update);
    };
    this._animFrameId = requestAnimationFrame(update);
  }

  /**
   * Self-stopping 60 ms ticker for the global loading chip.
   *
   * The chip used to ride the style rAF loop, which perf wave 2 made
   * self-stopping — leaving the chip frozen mid-state whenever no crossfade
   * or animated shader was running (it would never reveal, never cross the
   * long-load threshold, and never dwell out). Its reducer
   * (src/loadingFeedback.js) is time-driven, so it needs real ticks; it is
   * also pure DOM, so it takes NO governor hold and requests no render.
   * Armed by _updateGlobalLoadingFeedback whenever loading leaves idle or a
   * universal notice begins, and stops once both have settled.
   * (rebase 2026-08-16: main's loading chip vs wave 2's stopped loop)
   * @returns {void}
   */
  _armLoadingFeedbackTicker() {
    // Never arm behind a hidden tab: the reducer cannot usefully advance a
    // chip nobody can see, and the old `return` INSIDE the interval left the
    // 60ms timer scheduled for the entire hidden period (a batch completing
    // while hidden could never clear it — the idle check sat behind the
    // hidden guard). visibilitychange resamples and re-arms on return.
    if (this._loadingFeedbackTicker || document.hidden) return;
    this._loadingFeedbackTicker = setInterval(() => {
      if (document.hidden) {
        this._stopLoadingFeedbackTicker();
        return;
      }
      const now = performance.now();
      this._lastLoadingFeedbackUpdateAt = now;
      this._updateGlobalLoadingFeedback(now);
      const noticeNeedsTicker = Number.isFinite(this._globalStatusNotice?.hideAt);
      if (this._loadingFeedbackState?.phase === 'idle' && !noticeNeedsTicker) {
        this._stopLoadingFeedbackTicker();
      }
    }, 60);
  }

  /** Stop the loading-chip ticker if it is running. Idempotent. */
  _stopLoadingFeedbackTicker() {
    if (!this._loadingFeedbackTicker) return;
    clearInterval(this._loadingFeedbackTicker);
    this._loadingFeedbackTicker = null;
  }

  /**
   * Updates the collapsed mini-status readout with the active style label.
   * @param {string} [styleName=this.activeStyle] - Style name to display.
   * @returns {void}
   */
  _updateStyleMiniStatus(styleName = this.activeStyle) {
    if (!this._styleMiniValue) return;
    this._styleMiniValue.textContent = STYLE_STATUS_LABELS[styleName] || String(styleName || 'normal').toUpperCase();
  }

  /** Wire the persistent reset-to-globe control. */
  _initResetGlobeButton() {
    this._globeResetHandler = () => { this.resetToGlobeView(); };
    this._resetGlobeBtn?.addEventListener('click', this._globeResetHandler);
  }

  /** Wire the top-center action that clears only manager-owned data layers. */
  _initClearSelectedLayersButton() {
    if (!this._clearSelectedLayersBtn) return;
    this._clearSelectedLayersHandler = () => { void this.clearSelectedLayers(); };
    this._clearSelectedLayersBtn.addEventListener('click', this._clearSelectedLayersHandler);
  }

  /**
   * Clear every selected data layer without resetting visual, map, HUD, or
   * camera state. A layer may still release camera work it owns as part of its
   * established disable lifecycle.
   * @returns {Promise<object>} Aggregate manager lifecycle truth for the batch.
   */
  clearSelectedLayers() {
    if (this._clearSelectedLayersPromise) return this._clearSelectedLayersPromise;
    if (!this._dataManager?.clearSelectedLayers) {
      return Promise.resolve({ targetIds: [], items: [], clearedIds: [], notClearedIds: [] });
    }
    const notificationToken = Symbol('clear-selected-layers');
    this._clearSelectedLayersBtn.disabled = true;
    this._clearSelectedLayersBtn.setAttribute('aria-label', 'Clearing selected data layers');

    const managerOperation = this._dataManager.clearSelectedLayers({
      origin: 'user',
      notificationToken,
    });
    this._clearSelectedLayersManagerPromise = managerOperation;
    const operation = managerOperation.then((result) => {
      if (result.targetIds.length === 0) {
        this._showToast('No selected data layers');
      } else if (result.notClearedIds.length > 0) {
        this._showToast(`${result.notClearedIds.length} data layer${result.notClearedIds.length === 1 ? '' : 's'} could not be cleared`);
      } else {
        this._showToast(`Cleared ${result.clearedIds.length} data layer${result.clearedIds.length === 1 ? '' : 's'}`);
      }
      return result;
    }).catch((error) => {
      console.warn('[Data] clear selected layers failed', error);
      this._showToast('Selected data layers could not be cleared');
      return {
        targetIds: [],
        items: [],
        clearedIds: [],
        notClearedIds: [],
        error,
      };
    }).finally(() => {
      this._clearSelectedLayersBtn.disabled = false;
      this._clearSelectedLayersBtn.setAttribute('aria-label', 'Clear selected data layers');
      this._clearSelectedLayersManagerPromise = null;
      this._clearSelectedLayersPromise = null;
    });
    this._clearSelectedLayersPromise = operation;
    return operation;
  }

  /**
   * Release every camera owner and return to the canonical full-globe frame.
   * Repeated requests adopt the in-flight reset rather than cancelling it.
   * @returns {Promise<object>} Reset result: ok, cancelled, heightKm, centeredOn.
   */
  resetToGlobeView() {
    if (this._globeResetPromise) return this._globeResetPromise;
    this._stampNavigation();
    interruptCameraMotion('reset-globe');
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

    let resolveReset;
    const resetPromise = new Promise((resolve) => { resolveReset = resolve; });
    this._globeResetPromise = resetPromise;
    let settled = false;
    let timer = null;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const carto = this.viewer.camera.positionCartographic;
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(2)),
          longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(2)),
        },
      };
      this._resetGlobeBtn?.setAttribute('aria-label', 'Reset to full globe view');
      this._globeResetPromise = null;
      resolveReset(result);
    };
    timer = window.setTimeout(() => {
      const height = this.viewer.camera.positionCartographic?.height;
      finish(!Number.isFinite(height) || Math.abs(height - GLOBE_VIEW.heightM) > 1000);
    }, 4200);
    this._resetGlobeBtn?.setAttribute('aria-label', 'Resetting to full globe view');
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  // ── Share Button ─────────────────────────────

  /**
   * Wires the share button click to copy the current share link to the clipboard.
   * @returns {void}
   */
  _initShareButton() {
    this._shareBtn.addEventListener('click', async () => {
      const success = await this.shareLinkManager.copyLink();
      this._showToast(success ? 'Link copied!' : 'Copy failed');
    });
  }

  /**
   * Displays a temporary toast notification for 2 seconds.
   * @param {string} message - Text to show in the toast.
   * @returns {void}
   */
  _showToast(message) {
    this._toast.textContent = message;
    this._toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast.classList.remove('visible');
    }, 2000);
  }

  // ── HUD Toggle ───────────────────────────────

  /** Whether a share link was used to load the page */
  get hasShareState() {
    return !!this._hasShareState;
  }

  /** The share link's raw `cmp`, for main.js to restore once the share restore settles. */
  get initialCompareParam() {
    return this._initialCompareParam ?? null;
  }

  /** Terminal result for the complete initial share restoration. */
  get initialRestorePromise() {
    return this._initialShareRestorePromise || Promise.resolve({ status: 'not-requested' });
  }

  _settleInitialShareRestore(result) {
    if (!this._resolveInitialShareRestore) return;
    const resolve = this._resolveInitialShareRestore;
    this._resolveInitialShareRestore = null;
    resolve(result);
    window.dispatchEvent(new CustomEvent('gev:initial-share-restore-settled', { detail: result }));
  }

  /**
   * Tear down the StyleManager — cancel animation loop, clear intervals,
   * and release resources. Call this before discarding the instance to
   * prevent leaked rAF loops and event listeners.
   * @returns {Promise<void>} Resolves once teardown is complete.
   */
  async dispose() {
    if (this._disposed) return;
    this._globalStatusNotice = null;
    if (this._globalLoadingStatus) this._globalLoadingStatus.hidden = true;
    this._disposed = true;
    // Revoke persistence/hash authority before teardown can emit manager changes.
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    clearTimeout(this._initialShareRestoreTimeout);
    this._initialShareRestoreTimeout = null;
    this._settleInitialShareRestore({ status: 'destroyed', share: null, layers: [] });
    if (this._initialShareGestureHandler) {
      this.viewer?.canvas?.removeEventListener('pointerdown', this._initialShareGestureHandler);
      this.viewer?.canvas?.removeEventListener('wheel', this._initialShareGestureHandler);
      this._initialShareGestureHandler = null;
    }
    this.shareLinkManager?.destroy();
    if (this._mapStackChangeHandler) {
      window.removeEventListener('gev:map-stack-changed', this._mapStackChangeHandler);
      this._mapStackChangeHandler = null;
    }
    this._stampNavigation();
    this._navigationOwnerChangedRemover?.();
    this._navigationOwnerChangedRemover = null;
    this._dataManagerUnsubscribe?.();
    this._dataManagerUnsubscribe = null;
    if (this._globeResetHandler) {
      this._resetGlobeBtn?.removeEventListener('click', this._globeResetHandler);
      this._globeResetHandler = null;
    }
    if (this._clearSelectedLayersBtn && this._clearSelectedLayersHandler) {
      this._clearSelectedLayersBtn.removeEventListener('click', this._clearSelectedLayersHandler);
      this._clearSelectedLayersHandler = null;
    }
    if (this._windowResizeHandler) {
      window.removeEventListener('resize', this._windowResizeHandler);
      this._windowResizeHandler = null;
    }
    if (this._loadingVisibilityHandler) {
      document.removeEventListener('visibilitychange', this._loadingVisibilityHandler);
      this._loadingVisibilityHandler = null;
    }
    this._stopLoadingFeedbackTicker();
    if (this._globalKeydownHandler) {
      document.removeEventListener('keydown', this._globalKeydownHandler);
      this._globalKeydownHandler = null;
    }
    // Cancel the rAF animation loop and release its governor hold. (perf wave 2 fix)
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    releaseContinuousRender('style-anim');
    if (this._loadingFeedbackTicker) {
      clearInterval(this._loadingFeedbackTicker);
      this._loadingFeedbackTicker = null;
    }
    if (this._leftStackLayoutFrame !== null) {
      cancelAnimationFrame(this._leftStackLayoutFrame);
      this._leftStackLayoutFrame = null;
    }
    clearTimeout(this._adaptivePanelSettleTimer);
    this._adaptivePanelSettleTimer = null;
    this._leftStackResizeObserver?.disconnect();
    this._leftStackResizeObserver = null;
    this._leftStackMutationObserver?.disconnect();
    this._leftStackMutationObserver = null;
    if (this._leftStackHudTransitionHandler) {
      document.getElementById('intel-hud')?.removeEventListener(
        'transitionend',
        this._leftStackHudTransitionHandler,
      );
      this._leftStackHudTransitionHandler = null;
    }
    if (this._leftStackPanelTransitionHandler) {
      this._leftPanelStack?.removeEventListener('transitionend', this._leftStackPanelTransitionHandler);
      this._leftStackPanelTransitionHandler = null;
    }
    // Clear transitions
    this.transitions.clear();
  }
}
