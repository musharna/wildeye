import * as Cesium from 'cesium';
import { HAS_BACKEND } from './backend.js';
import { StyleManager } from './ui.js';
import { flyToAustin } from './camera.js';
import { DataLayerManager } from './data/manager.js';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import earthquakesLayer from './data/earthquakes.js';
import birdsLayer from './data/birds.js';
import aloftLayer from './data/aloft.js';
import occurrencesLayer from './data/occurrences.js';
import tracksLayer from './data/tracks.js';
import wastewaterLayer from './data/wastewater.js';
import otnLayer from './data/otn.js';
import hpaiLayer from './data/hpai.js';
import neonLayer from './data/neon.js';
import gfwLayer from './data/gfw.js';
import whispersLayer from './data/whispers.js';
import riversLayer from './data/rivers.js';
import ecoregionsLayer from './data/ecoregions.js';
import speciesLayer, { DEFAULT_SPECIES_PARAMS } from './data/species.js';
import { createBioClient } from './bio/gbif.js';
import { createWhatLivesHere } from './bio/whatLivesHere.js';
import { createShortViewportRegions } from './bio/shortViewport.js';
import { createSpeciesPanel } from './bio/speciesPanel.js';
import { createDetailsCard } from './bio/detailsCard.js';
import firesLayer from './data/fires.js';
import h5n1Layer from './data/h5n1.js';
import droughtLayer from './data/drought.js';
import cetaceansLayer from './data/cetaceans.js';
import neonVectorsLayer from './data/neon-vectors.js';
import phenologyLayer from './data/phenology.js';
import arbonetLayer from './data/arbonet.js';
import { crwBleachingLayer, oisstLayer, chlorALayer, crwDhwLayer, crwHotspotLayer, crwSeaIceLayer, ndviLayer, cmemsO2Layer, cmemsPhLayer, setDrapeSplit, drapeStackState, onDrapeRestack } from './data/rasterDrape.js';
import { gibsLandCoverLayer, gibsEviLayer, gibsLstLayer, gibsNightLightsLayer, gibsBiomassLayer } from './data/gibsLayer.js';
import { installDrapeExclusivity } from './data/drapeExclusive.js';
import { createCompare, encodeCompareParam, decodeCompareParam } from './compare.js';
import { installCompareUi } from './compareUi.js';
import { stackAboveChrome } from './bottomStack.js';
import { createObservedTime, attachObservedTime, installObservedTimeUi } from './observedTime.js';
import satellitesLayer from './data/satellites.js';
import rocketLaunchesLayer from './data/rocketLaunches.js';
import trafficLayer from './data/traffic.js';
import cctvLayer from './data/cctv.js';
import radioLayer from './data/radio.js';
import bikeshareLayer from './data/bikeshare.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import militaryInstallationsLayer from './data/militaryInstallations.js';
import militaryAwarenessLayer from './data/militaryAwareness.js';
import localDataLayers from './data/localLayers.js';
import { LAYER_STATE_REGISTRY } from './data/layerState.js';
import { registerDataCredits } from './data/dataCredits.js';
import { SceneDirector } from './scenes/director.js';
import { initGevVoiceCommands } from './voice/gevRealtime.js';
import { MapStackController } from './mapStackController.js';
import { initAnnotations } from './annotations/index.js';
import { initLogoGaze } from './logoGaze.js';
import { initCockpitCloudEffects } from './cockpitCloudEffects.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';
import { installScopeMask } from './scopeMask.js';
import { initFirstRunExperience } from './firstRunExperience.js';
import { initKeySetup } from './keySetup.js';
import { loadPhotorealisticTileset } from './mapStartup.js';

initLogoGaze();
// Static host (GitHub Pages): hide server-only surfaces marked data-requires-backend in index.html.
if (!HAS_BACKEND) document.body.classList.add('static-host');

/**
 * Extract a human-readable error message from any thrown value.
 * Handles Error objects, strings, and plain objects with message/error fields.
 * @param {*} error — caught exception value
 * @returns {string} best-effort error description
 */
function describeError(error) {
  if (!error) return 'Unknown initialization error';
  if (error instanceof Error) {
    if (error.message && error.message.trim()) return error.message.trim();
    return error.name || 'Initialization error';
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object') {
    const maybeMessage = String(error.message || error.error || '').trim();
    if (maybeMessage) return maybeMessage;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // ignore serialization error
    }
  }
  return String(error);
}

/**
 * GOD'S EYE VIEW — Main Entry Point
 * Initializes CesiumJS with Google Photorealistic 3D Tiles,
 * style system, intelligence HUD, location presets, and share links.
 */
async function init() {
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');

  try {
    loaderStatus.textContent = 'Configuring viewer...';

    // A direct Google key provides Google 3D plus GEV place search. Cesium ion
    // can host the same 3D tiles and also powers Bing/world-terrain stacks.
    const cesiumToken = import.meta.env.CESIUM_ION_TOKEN;
    const googleApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
    if (googleApiKey) window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;

    // Create the Cesium viewer with minimal chrome
    const viewer = new Cesium.Viewer('cesiumContainer', {
      timeline: false,
      animation: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false,
      selectionIndicator: false,
      infoBox: false,
      baseLayer: false,
      // Visible attribution container — Google Maps / 3D Tiles credits are
      // required by Google's Terms of Service, so they must be shown (styled
      // subtly via #cesium-credits). The credit line stays visible in
      // clean-view AND recording modes too (ToS requires attribution while the
      // content is displayed — those are the exact modes used to record
      // demos), including the "Data attribution" link that opens the per-layer
      // license popover.
      creditContainer: (() => {
        const el = document.createElement('div');
        el.id = 'cesium-credits';
        document.body.appendChild(el);
        return el;
      })(),
      msaaSamples: 4,
      contextOptions: {
        webgl: {
          preserveDrawingBuffer: true,
        },
      },
    });

    // Cap the default render loop at 60 fps. Cesium's loop otherwise runs at
    // the display's refresh rate — 120 Hz on ProMotion panels — doubling GPU
    // and CPU burn for zero visual benefit in a map app whose animation
    // cadences (poll interpolation, trail fades, style crossfades) are all
    // designed against wall-clock time, not frame count. Measured on the
    // 2026-08-05 perf investigation as a strict halving of idle burn on
    // 120 Hz hardware; a no-op on 60 Hz displays. (perf item 2)
    viewer.targetFrameRate = 60;

    // Register per-layer data attribution into the "Data attribution" popover.
    // Required by each source's license (ODbL, CC BY-NC-SA, NASA FIRMS, etc.);
    // strings are verbatim from DATA_SOURCES.md. Static + always-present in the
    // expandable bottom-left credit lightbox (showOnScreen=false), so they never
    // clutter the on-globe line. See docs/pre-ship-audit-2026-07-01.md H11.
    registerDataCredits(viewer);

    // Hide Cesium's default globe — Google Photorealistic 3D Tiles provide their own
    // globe at all LODs (street level → orbital). The default globe's 2D imagery
    // clips through 3D tile buildings at close range.
    viewer.scene.globe.show = false;

    // Keep a sky behind Google 3D Tiles, but soften Cesium's high-intensity
    // default atmosphere. With the globe hidden its bright limb otherwise
    // reads as a hard cyan seam where distant photoreal tiles meet the sky.
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;

    loaderStatus.textContent = googleApiKey || cesiumToken
      ? 'Loading Google 3D Tiles...'
      : 'Loading the keyless globe...';
    // Pass only the members mapStartup uses: handing over the whole namespace
    // object makes Rollup keep all of Cesium (rebuildCesium tree-shakes it).
    const photoreal = await loadPhotorealisticTileset({
      GoogleMaps: Cesium.GoogleMaps,
      Ion: Cesium.Ion,
      createGooglePhotorealistic3DTileset: Cesium.createGooglePhotorealistic3DTileset,
    }, {
      googleApiKey,
      cesiumToken,
    });
    const tileset = photoreal.tileset;
    if (tileset) {
      viewer.scene.primitives.add(tileset);
      // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
      // Google Photorealistic 3D Tiles provide their own terrain/elevation.
      viewer.scene.globe.show = false;
      console.info(`[Init] Google 3D Tiles loaded via ${photoreal.route}.`);
    } else {
      if (photoreal.errors.length) {
        const tileError = photoreal.errors.at(-1);
        console.warn('[Init] Google 3D Tiles unavailable, using the keyless globe:', tileError);
        const tileErrorDetail = describeError(tileError);
        loaderStatus.textContent = `Google 3D Tiles unavailable (${tileErrorDetail}). Loading the keyless globe...`;
      }
      viewer.scene.globe.show = true;
    }

    loaderStatus.textContent = 'Initializing systems...';

    const mapStackController = new MapStackController(viewer, {
      googleTileset: tileset,
      cesiumToken,
      initialStack: tileset ? 'photoreal' : 'esri-imagery',
      // Task 5 (height-datum fix): rebroadcast stack changes as a window
      // CustomEvent so data layers (CCTV per-regime ground resolution) can
      // react without coupling MapStackController to layer modules. Fires on
      // 'switching'/'ready'/'error'; listeners derive the surface regime from
      // live scene state, so intermediate emissions are harmless.
      onChange: (state) => {
        window.dispatchEvent(new CustomEvent('gev:map-stack-changed', { detail: state }));
      },
      onError: (message) => console.warn('[MapStack]', message),
    });
    await mapStackController.setStack(tileset ? 'photoreal' : 'esri-imagery', { silent: true });

    // Initialize the style manager (post-processing, HUD, locations, share links)
    const styleManager = new StyleManager(viewer, { mapStackController });
    // The previous multi-canvas weather compositor remains disabled. Cockpit
    // clouds use a separate, capped low-resolution GPU pass that never attaches
    // Cesium fog or post-process stages and is fully stopped in map mode.
    const weatherEffects = null;
    const cockpitCloudEffects = initCockpitCloudEffects(viewer);

    // If no share link state, do default fly-to Austin
    if (!styleManager.hasShareState) {
      loaderStatus.textContent = 'Flying to Austin, TX...';
      flyToAustin(viewer);
    } else {
      loaderStatus.textContent = 'Restoring shared view...';
    }

    // Initialize data layer manager
    const dataManager = new DataLayerManager(viewer, {
      allowQaRegistration: import.meta.env.DEV,
    });
    dataManager.register(flightsLayer);
    dataManager.register(militaryFlightsLayer);
    dataManager.register(earthquakesLayer);
    dataManager.register(birdsLayer);
    dataManager.register(aloftLayer);
    dataManager.register(crwBleachingLayer);
    dataManager.register(oisstLayer);
    dataManager.register(chlorALayer);
    dataManager.register(crwDhwLayer);
    dataManager.register(crwHotspotLayer);
    dataManager.register(crwSeaIceLayer);
    dataManager.register(ndviLayer);
    dataManager.register(cmemsO2Layer);
    dataManager.register(cmemsPhLayer);
    const gibsLayers = [gibsLandCoverLayer, gibsEviLayer, gibsLstLayer, gibsNightLightsLayer, gibsBiomassLayer];
    for (const layer of gibsLayers) dataManager.register(layer);
    // One drape at a time (W0-3) — except the two sides of a swipe compare (GIBS stage 2).
    const drapeLayers = [crwBleachingLayer, oisstLayer, chlorALayer, crwDhwLayer, crwHotspotLayer, crwSeaIceLayer, ndviLayer, cmemsO2Layer, cmemsPhLayer, ...gibsLayers];
    const drapeIds = drapeLayers.map((l) => l.id);
    const compare = createCompare({
      dataManager,
      drapeIds,
      setSplit: (id, dir) => setDrapeSplit(viewer.imageryLayers, id, dir),
      setPosition: (p) => {
        viewer.scene.splitPosition = p;
        governorRequestRender('compare-divider');
      },
    });
    installDrapeExclusivity(dataManager, drapeIds, { exempt: compare.exempt });
    styleManager.shareLinkManager.setCompareParamProvider(() => encodeCompareParam(compare.getState()));
    compare.subscribe(() => styleManager.shareLinkManager.onCompareStateChange());
    const initialCmp = styleManager.initialCompareParam;
    if (initialCmp) {
      // After the share restore: its layer lane would otherwise leave only the last-restored drape on.
      styleManager.initialRestorePromise
        .then(() => {
          const c = decodeCompareParam(initialCmp, drapeIds);
          return c && compare.set(c.left, c.right, c.position);
        })
        .catch((e) => console.error(`[compare] share link cmp=${initialCmp} not restored:`, e));
    }
    dataManager.register(occurrencesLayer);
    dataManager.register(tracksLayer);
    dataManager.register(wastewaterLayer);
    dataManager.register(otnLayer);
    dataManager.register(hpaiLayer);
    dataManager.register(neonLayer);
    dataManager.register(gfwLayer);
    dataManager.register(whispersLayer);
    dataManager.register(riversLayer);
    dataManager.register(ecoregionsLayer);
    dataManager.register(firesLayer);
    dataManager.register(h5n1Layer);
    dataManager.register(droughtLayer);
    dataManager.register(cetaceansLayer);
    dataManager.register(neonVectorsLayer);
    dataManager.register(phenologyLayer);
    dataManager.register(arbonetLayer);
    dataManager.register(speciesLayer);
    // Shared observed-time selector: one bar, every bio layer samples its own data at the instant.
    // No domain constant: the bar spans the union of what the enabled layers declare they can
    // serve (getObservedExtent), so it cannot advertise hours no layer has data for.
    const observedTime = createObservedTime();
    const observedLayers = [birdsLayer, crwBleachingLayer, oisstLayer, chlorALayer, crwDhwLayer, crwHotspotLayer, crwSeaIceLayer, ndviLayer, cmemsO2Layer, cmemsPhLayer, occurrencesLayer, tracksLayer, wastewaterLayer, otnLayer, hpaiLayer, neonLayer, gfwLayer, whispersLayer, arbonetLayer, phenologyLayer, neonVectorsLayer, cetaceansLayer, droughtLayer, h5n1Layer, firesLayer, riversLayer, ...gibsLayers.filter((l) => l !== gibsBiomassLayer)];
    attachObservedTime(observedTime, dataManager, observedLayers);
    installObservedTimeUi(observedTime, dataManager, observedLayers);
    // After the time bar's store exists: a scrub relabels each compare side (a gap has no restack).
    const compareUi = installCompareUi({
      doc: document,
      compare,
      dataManager,
      container: document.getElementById('cesiumContainer'),
      drapes: drapeLayers.map((l) => ({ id: l.id, name: l.name })),
      onRestack: onDrapeRestack,
      observedTime,
    });
    // Bottom-centre is one stack above the dock and the map credits: time bar, then compare pill | panel.
    stackAboveChrome({
      doc: document,
      below: () => [document.getElementById('command-dock'), document.getElementById('cesium-credits')],
      items: () => [
        document.getElementById('observed-time'),
        [compareUi.toggle, compareUi.panel],
      ],
    });
    dataManager.register(satellitesLayer);
    dataManager.register(rocketLaunchesLayer);
    rocketLaunchesLayer.attachDataManager(dataManager);
    dataManager.register(trafficLayer);
    dataManager.register(cctvLayer);
    dataManager.register(radioLayer);
    dataManager.register(bikeshareLayer);
    dataManager.register(aisLiveVesselsLayer);
    dataManager.register(militaryInstallationsLayer);
    dataManager.register(militaryAwarenessLayer);
    militaryAwarenessLayer.attachDataManager(dataManager);
    for (const layer of localDataLayers) {
      dataManager.register(layer);
    }
    // Restoration starts only after the complete production registry is sealed.
    dataManager.finalizeRegistrations(LAYER_STATE_REGISTRY);
    if (import.meta.env.DEV) {
      window.__gevQaRegisterLayer = (targetManager, layerModule) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.registerForQa(layerModule);
      };
      window.__gevQaUnregisterLayer = (targetManager, layerId) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.unregisterForQa(layerId);
      };
    }
    dataManager.buildTogglePanel(document.getElementById('data-toggles'));
    styleManager.attachDataManager(dataManager);
    // Biology details card: Cesium's info box is off, so this is where biology markers show their details.
    // Dismissing the card cancels the what-lives-here search it was waiting for (the controller is created below), and the
    // searched circle's outline goes whenever the card stops showing that search's list, e.g. when a marker's details replace it.
    let whatLivesHere = null;
    const bioCard = createDetailsCard({ viewer, layerName: (id) => dataManager.layers.get(id)?.module?.name || id, onDismiss: () => whatLivesHere?.cancel(), onListEnd: () => whatLivesHere?.listEnded() });
    document.body.appendChild(bioCard.element);
    document.body.appendChild(bioCard.announcer);
    // Species search and "what lives here" (docs/superpowers/specs/2026-09-13-species-search-design.md).
    const bioClient = createBioClient();
    let speciesPanel = null;
    // Fix round 4: on a short viewport the open left panel and the card take turns, so neither covers the other or the pick target
    // (src/bio/shortViewport.js; style.css gives each its region). The fold is temporary, so it is not persisted or shared.
    createShortViewportRegions({
      stack: document.getElementById('left-panel-stack'),
      cardElement: bioCard.element,
      dismissCard: () => bioCard.element.querySelector('.bio-card-close')?.click(),
      setPanelCollapsed: (id, collapsed) => styleManager.setPanelCollapsed(id, collapsed, { persist: false, syncShare: false }),
    });
    // Stage 3 "What's here": a WHAT LIVES HERE click also reads every enabled GIBS layer at the spot (grill A14).
    const readGibsLayers = ({ lat, lon }) => gibsLayers
      .filter((l) => dataManager.isEnabled(l.id))
      .map((l) => ({ icon: l.icon, name: l.name, result: l.readoutAt(lat, lon) }));
    whatLivesHere = createWhatLivesHere({
      viewer,
      client: bioClient,
      card: bioCard,
      getParams: () => dataManager.getLayerParams('species') || DEFAULT_SPECIES_PARAMS,
      onPickSpecies: ({ taxonKey, name }) => {
        speciesPanel?.chooseTaxon({ taxonKey, name }).catch((error) => console.error('[species] could not map the picked species', { taxonKey, error }));
      },
      onArmedChange: () => speciesPanel?.render(),
      readLayers: readGibsLayers,
    });
    speciesPanel = createSpeciesPanel({ dataManager, speciesLayer, client: bioClient, whatLivesHere });

    // Initialize deterministic scene playback for social clip capture
    const sceneDirector = new SceneDirector(viewer, styleManager, dataManager);

    // Initialize the voice "whiteboard" annotation engine (world-space renderer)
    const annotations = initAnnotations({ viewer, tileset });

    // Keep startup chrome truthful: a share is not restored until camera,
    // visual/map/panel lanes, and every requested layer have terminated.
    void Promise.all([
      styleManager.initialRestorePromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]).finally(() => {
      loadingScreen.classList.add('hidden');
      // Reveal only after the loading cover has yielded. transitionend can be
      // absent under reduced motion, so a bounded fallback makes this reliable.
      let firstRunRevealed = false;
      const revealFirstRun = () => {
        if (firstRunRevealed) return;
        firstRunRevealed = true;
        // dataManager is passed explicitly: the globe missions enable bundled
        // keyless layers through it, and reaching for styleManager._dataManager
        // would make a private field part of this feature's contract.
        initFirstRunExperience({ styleManager, dataManager });
      };
      loadingScreen.addEventListener('transitionend', revealFirstRun, { once: true });
      setTimeout(revealFirstRun, 900);
    });

    // Provider Settings (the POWER UP chip + dialog). Fire-and-forget: the
    // module removes its own surface when the dev-server endpoint is absent
    // (prod builds, non-local visitors), so this costs prod exactly nothing.
    if (HAS_BACKEND) void initKeySetup();

    // Expose for debugging
    // Idle render governor: flips the scene into requestRenderMode whenever
    // nothing animates per frame. Installed AFTER every module above has had
    // its chance to register pre-install holds. (perf wave 2)
    installRenderGovernor(viewer);

    // The explicit scope mask replaces the emergent six-pass artifact —
    // see src/scopeMask.js. Installed before the UI so the DISPLAY-rail
    // toggle finds it live.
    installScopeMask(viewer);

    // The follow camera recomputes the tracked target's dead-reckon position
    // every frame — tracking anything is a per-frame animation. (perf wave 2)
    viewer.trackedEntityChanged.addEventListener(() => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    });

    // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
    // stop the default render loop outright — a hidden canvas repaints for
    // nobody, and browser rAF throttling still lets throttled frames burn
    // GPU. Holder/data state is untouched, so return is seamless: restore
    // the loop, refresh the one DOM surface we gated, render a frame.
    const syncVisibilitySuspension = () => {
      const hidden = document.hidden;
      viewer.useDefaultRenderLoop = !hidden;
      cockpitCloudEffects?.setSuspended?.(hidden);
      if (!hidden) {
        if (dataManager._panelRefreshPendingOnVisible) {
          dataManager._panelRefreshPendingOnVisible = false;
          dataManager._refreshTogglePanel();
        }
        governorRequestRender('visibility-restore');
      }
    };
    document.addEventListener('visibilitychange', syncVisibilitySuspension);
    // Apply the CURRENT state too — bootstrap can complete while the tab is
    // already hidden, and waiting for the next transition would leave the
    // loop burning behind a hidden tab. (perf wave 2 fix)
    syncVisibilitySuspension();

    window.__godsEyeView = {
      // QA (scripts/qa-readout.mjs, qa-known-answer.mjs): every enabled GIBS layer's readout rows at a point.
      readoutAt: (lat, lon) => Promise.all(readGibsLayers({ lat, lon }).map((r) => r.result)),
      viewer,
      styleManager,
      tileset,
      dataManager,
      // the shared observed-time store: qa-observed-time asserts the bar's span against the data
      observedTime,
      // swipe compare + what each stacked drape is drawing: qa-compare asserts the split on the live layers
      compare,
      drapeStack: () => drapeStackState(viewer.imageryLayers),
      sceneDirector,
      mapStackController,
      annotations,
      weatherEffects,
      cockpitCloudEffects,
      getRenderGovernorDiagnostics,
      requestRender: governorRequestRender,
    };
    // The voice agent needs the server's OpenAI Realtime session proxy; a static host has none.
    if (HAS_BACKEND) window.__godsEyeView.voiceCommands = initGevVoiceCommands({ viewer, styleManager, dataManager, sceneDirector, annotations });

  } catch (error) {
    console.error("God's Eye View initialization failed:", error);
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  }
}

init();
