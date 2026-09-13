import * as Cesium from 'cesium';
import { gbifPortalUrl, yearLabel } from './gbif.js';

/**
 * "What lives here" (spec: docs/superpowers/specs/2026-09-13-species-search-design.md). The SPECIES panel
 * arms a one-shot click. A click on the ground lists the 20 species with the most CC0 and CC BY GBIF records
 * within the chosen radius. A click on a marker is left to the normal click; a click on the sky stays armed.
 */
export const HEADING = 'What lives here';

export function classifyClick({ picked, position }) {
  if (picked && picked.id !== undefined && picked.id !== null) return 'entity';
  if (!position) return 'sky';
  return 'ground';
}

export function createWhatLivesHere({
  viewer,
  client,
  card,
  getParams,
  onPickSpecies,
  onArmedChange = () => {},
  handlerFor = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  doc = document,
}) {
  let armed = false;
  let controller = null;

  const setArmed = (value) => {
    if (armed === value) return;
    armed = value;
    viewer.scene.canvas.style.cursor = value ? 'crosshair' : '';
    onArmedChange(value);
  };

  const groundAt = (windowPosition) => {
    const scene = viewer.scene;
    let cartesian = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
    if (!cartesian) cartesian = viewer.camera.pickEllipsoid(windowPosition, scene.globe.ellipsoid);
    return cartesian || null;
  };

  async function run(lat, lon) {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const { years, radiusKm } = getParams();
    card.showStatus({ heading: HEADING, message: `Searching GBIF within ${radiusKm} km…` });
    try {
      const near = await client.speciesNear({ lat, lon, radiusKm, years }, { signal });
      if (near.species.length === 0) {
        card.showStatus({ heading: HEADING, message: `No CC0/CC BY records within ${radiusKm} km for ${yearLabel(years)}. Try a larger radius or all years.` });
        return near;
      }
      const names = await Promise.all(near.species.map((s) => client.speciesName(s.key, { signal }).catch((error) => {
        if (error?.name === 'AbortError') throw error;
        console.error('[what-lives-here] name lookup failed', { key: s.key, error });
        return { key: s.key, scientificName: `GBIF taxon ${s.key}`, commonName: null, error: error.message };
      })));
      card.showList({
        heading: HEADING,
        filterLine: `CC0 and CC BY records · ${yearLabel(years)} · within ${radiusKm} km · ${near.total.toLocaleString('en-US')} records`,
        entries: near.species.map((s, i) => ({ key: s.key, count: s.count, scientificName: names[i].scientificName, commonName: names[i].commonName, error: names[i].error })),
        footer: 'Occurrence data: GBIF.org, CC0 and CC BY records only',
        footerHref: gbifPortalUrl({ lat, lon, radiusKm, years }),
        onRow: (row) => onPickSpecies({ taxonKey: row.key, name: row.primary }),
      });
      return near;
    } catch (error) {
      if (error?.name === 'AbortError') return null;
      console.error('[what-lives-here] GBIF search failed', { lat, lon, radiusKm, years, error });
      card.showStatus({ heading: HEADING, message: `GBIF search failed (${error.message})`, retry: () => run(lat, lon) });
      return null;
    }
  }

  /** One canvas click. Returns the query promise for a ground click while armed, else null. */
  function handleClick(event) {
    if (!armed) return null;
    const picked = viewer.scene.pick(event.position);
    const position = groundAt(event.position);
    const kind = classifyClick({ picked, position });
    if (kind === 'entity') return null;
    if (kind === 'sky') {
      card.showStatus({ heading: HEADING, message: 'Click on the globe, not the sky.' });
      return null;
    }
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    setArmed(false);
    return run(Cesium.Math.toDegrees(cartographic.latitude), Cesium.Math.toDegrees(cartographic.longitude));
  }

  const handler = handlerFor(viewer.scene.canvas);
  handler.setInputAction((event) => { void handleClick(event); }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && armed) setArmed(false);
  });

  return {
    get armed() { return armed; },
    arm() {
      setArmed(true);
      card.showStatus({ heading: HEADING, message: 'Click a spot on the globe. Esc cancels.' });
    },
    disarm() { setArmed(false); },
    handleClick,
    destroy() { handler.destroy(); controller?.abort(); },
  };
}
