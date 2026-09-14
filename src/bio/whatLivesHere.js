import * as Cesium from 'cesium';
import { EARTH_RADIUS_KM, gbifPortalAnyLocationUrl, gbifPortalUrl, polygonRefusal, yearLabel } from './gbif.js';

/**
 * "What lives here" (spec: docs/superpowers/specs/2026-09-13-species-search-design.md). The SPECIES panel
 * arms a one-shot click. A click on the ground lists the 20 species with the most CC0 and CC BY GBIF records
 * within the chosen radius, and names the 5 datasets with the most of those records, with DOI links (R-7u). A click on a marker is left to the normal click; a click on the sky stays armed. The searched
 * circle is outlined on the ground with a small cross at the clicked point, neither pickable, while the card shows that search's
 * status or list: the outline goes when the card
 * stops showing it for any reason (closed, dismissed, or replaced by a marker's details), when WHAT LIVES HERE is armed again, and
 * when another search replaces it.
 */
export const HEADING = 'What lives here';

export function classifyClick({ picked, position }) {
  if (picked && picked.id !== undefined && picked.id !== null) return 'entity';
  if (!position) return 'sky';
  return 'ground';
}

/** Marks the outline primitive, so it can be found in scene.groundPrimitives (scripts/qa-species.mjs does). */
export const AREA_OUTLINE_ROLE = 'what-lives-here-area';
/** --accent in style.css */
const OUTLINE_COLOR = '#00d4ff';

/**
 * `vertices` points on the circle of `radiusKm` around a point, by the spherical destination-point formula, so a circle at a
 * pole or across ±180° works too. Longitudes are wrapped into [-180, 180).
 */
export function circleOutline({ lat, lon, radiusKm, vertices = 64 }) {
  const rad = Math.PI / 180;
  const delta = radiusKm / EARTH_RADIUS_KM;
  const lat1 = lat * rad;
  const points = [];
  for (let i = 0; i < vertices; i += 1) {
    const bearing = (2 * Math.PI * i) / vertices;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(bearing));
    const lon2 = lon * rad + Math.atan2(Math.sin(bearing) * Math.sin(delta) * Math.cos(lat1), Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2));
    points.push({ lon: ((((lon2 / rad + 180) % 360) + 360) % 360) - 180, lat: lat2 / rad });
  }
  return points;
}

/** Arm length of the centre mark, as a fraction of the search radius. */
export const CENTRE_MARK_FRACTION = 0.08;

/** The centre mark: a north–south and an east–west arm through the clicked point, each end CENTRE_MARK_FRACTION of the radius away. */
export function centreMark({ lat, lon, radiusKm }) {
  const [north, east, south, west] = circleOutline({ lat, lon, radiusKm: radiusKm * CENTRE_MARK_FRACTION, vertices: 4 });
  return [[north, south], [east, west]];
}

/**
 * The searched circle as a thin ground outline in the accent colour, with the centre mark. One primitive, so both share a lifecycle, and
 * allowPicking: false, so clicks on them reach the globe and markers.
 */
export function areaOutlinePrimitive({ lat, lon, radiusKm }) {
  const line = (points, loop) => new Cesium.GeometryInstance({
    geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(points.flatMap((p) => [p.lon, p.lat])), loop, width: 2 }),
    attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(OUTLINE_COLOR)) },
  });
  const primitive = new Cesium.GroundPolylinePrimitive({
    geometryInstances: [line(circleOutline({ lat, lon, radiusKm }), true), ...centreMark({ lat, lon, radiusKm }).map((arm) => line(arm, false))],
    appearance: new Cesium.PolylineColorAppearance(),
    allowPicking: false,
  });
  primitive.wildeyeRole = AREA_OUTLINE_ROLE;
  return primitive;
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
  // The outline seam: drawArea({ lat, lon, radiusKm }) returns a handle (null when nothing was drawn); clearArea(handle) removes it.
  drawArea = (area) => {
    if (!Cesium.GroundPolylinePrimitive.isSupported(viewer.scene)) {
      console.error('[what-lives-here] cannot outline the searched circle: ground polylines need WEBGL_depth_texture', { area });
      return null;
    }
    return viewer.scene.groundPrimitives.add(areaOutlinePrimitive(area));
  },
  clearArea = (primitive) => { viewer.scene.groundPrimitives.remove(primitive); },
}) {
  let armed = false;
  let controller = null;
  let area = null; // the outline of the circle the card describes

  const removeArea = () => {
    if (area === null) return;
    clearArea(area);
    area = null;
  };

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
    removeArea();
    try {
      area = drawArea({ lat, lon, radiusKm });
    } catch (error) {
      // The outline is a visual aid: a synchronous failure to build or add it is logged with its context, and the search goes on
      // without it. Failures inside the primitive's update() or its geometry workers come later and are not caught here.
      console.error('[what-lives-here] could not outline the searched circle', { lat, lon, radiusKm, error });
      area = null;
    }
    card.showStatus({ heading: HEADING, message: `Searching GBIF within ${radiusKm} km…` });
    try {
      const near = await client.speciesNear({ lat, lon, radiusKm, years }, { signal });
      if (near.species.length === 0) {
        card.showStatus({ heading: HEADING, message: `No CC0/CC BY records within ${radiusKm} km for ${yearLabel(years)}. Try a larger radius or all years.` });
        return near;
      }
      // Names and datasets are looked up together under the search's signal, so a newer search or a cancel aborts both. A failed lookup
      // is logged and listed with its error; an abort ends the search.
      const lookUp = (items, find, what, failed) => Promise.all(items.map((item) => find(item.key).catch((error) => {
        if (error?.name === 'AbortError') throw error;
        console.error(`[what-lives-here] ${what} lookup failed`, { key: item.key, error });
        return failed(item, error);
      })));
      const [names, datasets] = await Promise.all([
        lookUp(near.species, (key) => client.speciesName(key, { signal }), 'name', (s, error) => ({ key: s.key, scientificName: `GBIF taxon ${s.key}`, commonName: null, error: error.message })),
        lookUp(near.datasets, (key) => client.dataset(key, { signal }), 'dataset', (d, error) => ({ key: d.key, title: null, doi: null, error: error.message })),
      ]);
      // gbif.org's location filter is a polygon. Where the circle cannot be one (the search used geoDistance), the card says
      // so and links the same licences and years with no location filter.
      const circleOnGbif = polygonRefusal({ lat, lon, radiusKm }) === null;
      card.showList({
        heading: HEADING,
        filterLine: `CC0 and CC BY records · ${yearLabel(years)} · within ${radiusKm} km · ${near.total.toLocaleString('en-US')} records`,
        entries: near.species.map((s, i) => ({ key: s.key, count: s.count, scientificName: names[i].scientificName, commonName: names[i].commonName, error: names[i].error })),
        datasets: near.datasets.map((d, i) => ({ key: d.key, count: d.count, title: datasets[i].title, doi: datasets[i].doi, error: datasets[i].error })),
        footer: circleOnGbif ? 'Occurrence data: GBIF.org, CC0 and CC BY records only' : 'Occurrence data: GBIF.org, CC0 and CC BY records, all locations',
        footerHref: circleOnGbif ? gbifPortalUrl({ lat, lon, radiusKm, years }) : gbifPortalAnyLocationUrl({ years }),
        footerNote: circleOnGbif ? null : "gbif.org can't show this area as a circle",
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
      controller?.abort(); // a search still in flight must not replace the prompt or leave a Retry for the old spot
      removeArea(); // the prompt no longer describes the old circle
      setArmed(true);
      card.showStatus({ heading: HEADING, message: 'Click a spot on the globe. Esc cancels.' });
    },
    disarm() { setArmed(false); },
    /** The card was dismissed: abort the search it was waiting for (aborted searches are silent), disarm, remove the outline. */
    cancel() { controller?.abort(); setArmed(false); removeArea(); },
    /**
     * The card stopped showing this controller's status or list (its onListEnd): remove the outline, and abort a search still in
     * flight, whose card is gone. Armed state is left alone: a marker's details can replace the prompt while it is armed.
     */
    listEnded() { controller?.abort(); removeArea(); },
    handleClick,
    destroy() { handler.destroy(); controller?.abort(); removeArea(); },
  };
}
