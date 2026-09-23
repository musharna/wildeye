import * as Cesium from 'cesium';

/**
 * Per-layer data attribution registered into Cesium's credit display.
 *
 * Legal requirement (see DATA_SOURCES.md, findings H10/H11 in
 * docs/pre-ship-audit-2026-07-01.md): every third-party data layer this app can
 * display carries its own license and required attribution — ODbL (OSM
 * datacenters/dams, adsb.lol, Overpass roads), CC BY-NC-SA (TeleGeography
 * cables), NASA FIRMS, CelesTrak, USGS, City of Austin, GBFS operators, OpenSky.
 * The MIT code license does NOT cover this data.
 *
 * These credits are registered ONCE at init as STATIC credits with
 * showOnScreen=false, so they live in the expandable bottom-left "Data
 * attribution" lightbox (Cesium's credit popover) rather than cluttering the
 * on-globe line. Always-present is intentional and reversible: the lightbox is
 * the app's canonical attribution surface and DATA_SOURCES.md is the
 * machine-readable index. Strings are copied verbatim from DATA_SOURCES.md — if
 * you add a data source, add it there AND here.
 */

/**
 * Attribution entries. `html` is the credit markup; keep it minimal and
 * link out where DATA_SOURCES.md provides a canonical URL. Order roughly
 * follows DATA_SOURCES.md (live sources, then bundled snapshots).
 * @type {{ key: string, html: string }[]}
 */
export const DATA_CREDITS = [
  // ── Live sources ────────────────────────────────────────────────
  {
    key: 'opensky',
    html:
      'Flights: OpenSky Network — Schäfer et al., ' +
      '“Bringing Up OpenSky”, IPSN 2014 · ' +
      '<a href="https://opensky-network.org" target="_blank" rel="noopener">opensky-network.org</a> ' +
      '(non-commercial)',
  },
  {
    key: 'adsblol',
    html:
      'Military flights, aircraft traces &amp; bounded regional flight fallback: ' +
      '<a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'aisstream',
    html:
      'Live vessels (AIS): ' +
      '<a href="https://aisstream.io" target="_blank" rel="noopener">AISStream.io</a>',
  },
  {
    key: 'celestrak',
    html:
      'Satellites (TLEs): CelesTrak ' +
      '(<a href="https://celestrak.org" target="_blank" rel="noopener">celestrak.org</a>), ' +
      'Dr. T.S. Kelso',
  },
  {
    key: 'launch-library-2',
    html:
      'Space mission launch, payload &amp; recovery metadata: ' +
      '<a href="https://ll.thespacedevs.com/docs/" target="_blank" rel="noopener">Launch Library 2 — The Space Devs</a> ' +
      '(API documentation and rate limits)',
  },
  {
    key: 'usgs',
    html: 'Earthquakes: Data courtesy of the U.S. Geological Survey',
  },
  {
    key: 'aloft-baltrad',
    html:
      'European bird migration profiles: ' +
      '<a href="https://aloftdata.eu" target="_blank" rel="noopener">Aloft / BALTRAD_VPTS</a> ' +
      '(CC0, doi:10.5281/zenodo.14711024)',
  },
  {
    key: 'noaa-crw',
    html: 'Coral bleaching alerts, degree heating weeks, HotSpot and sea ice: Courtesy <a href="https://coralreefwatch.noaa.gov" target="_blank" rel="noopener">NOAA Coral Reef Watch</a> (daily 5 km products v3.1; Bleaching Alert Area on the legacy 0–4 scale)',
  },
  {
    key: 'noaa-ndvi-cdr',
    html: 'Vegetation greenness: <a href="https://www.ncei.noaa.gov/products/climate-data-records/normalized-difference-vegetation-index" target="_blank" rel="noopener">NOAA NDVI Climate Data Record</a> (VIIRS daily 0.05°, NCEI THREDDS WMS)',
  },
  {
    key: 'nasa-gibs',
    html: 'Land cover, vegetation (EVI), land surface temperature, night lights and forest biomass: '
      + 'We acknowledge the use of imagery provided by services from NASA\'s '
      + '<a href="https://nasa-gibs.github.io/gibs-api-docs/" target="_blank" rel="noopener">Global Imagery Browse Services (GIBS)</a>, '
      + 'part of NASA\'s Earth Science Data and Information System (ESDIS).',
  },
  {
    key: 'ioos-atn',
    html: 'Animal tracks: <a href="https://atn.ioos.us" target="_blank" rel="noopener">IOOS Animal Telemetry Network</a> — each deployment carries its own citation and licence in the info box',
  },
  {
    key: 'otn',
    html: 'Acoustic detections: <a href="https://oceantrack.org" target="_blank" rel="noopener">Ocean Tracking Network</a> (CC BY 4.0; each receiver carries its project citation in the info box)',
  },
  {
    key: 'aphis-hpai',
    html: 'Avian influenza in wild birds: <a href="https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/wild-birds" target="_blank" rel="noopener">USDA APHIS</a> (Public Domain U.S. Government; county boundaries from the U.S. Census Bureau)',
  },
  {
    key: 'movebank',
    html: 'Animal tracks: <a href="https://www.movebank.org" target="_blank" rel="noopener">Movebank</a> curated public studies (CC0 / CC BY only) — each track carries its study citation and licence in the info box',
  },
  {
    key: 'xeno-canto',
    html: 'Sound recordings: <a href="https://xeno-canto.org" target="_blank" rel="noopener">xeno-canto</a> (CC0 / CC BY recordings only; each record names its recordist and links to the recording — audio is never rehosted)',
  },
  {
    key: 'neon',
    html: 'Small mammals: <a href="https://data.neonscience.org/data-products/DP1.10072.001" target="_blank" rel="noopener">NSF NEON small mammal box trapping (DP1.10072.001)</a>, provisional and released data, CC BY 4.0. NEON (National Ecological Observatory Network) is funded by the U.S. National Science Foundation.',
  },
  {
    key: 'gfw',
    html: 'Deforestation alerts: <a href="https://www.globalforestwatch.org" target="_blank" rel="noopener">Global Forest Watch</a> integrated alerts (GLAD-L, GLAD-S2, RADD; CC BY 4.0), aggregated by country; country shapes made with Natural Earth',
  },
  {
    key: 'cmems',
    html: 'Ocean oxygen and pH: Generated using E.U. Copernicus Marine Service Information; <a href="https://doi.org/10.48670/moi-00015" target="_blank" rel="noopener">Global Ocean Biogeochemistry Analysis and Forecast</a> (daily 0.25° surface analysis)',
  },
  {
    key: 'arbonet',
    html: "Arboviral disease cases: <a href=\"https://data.cdc.gov/NNDSS/NNDSS-Weekly-Data/x9gk-5huc\" target=\"_blank\" rel=\"noopener\">CDC NNDSS Weekly Data</a> (ArboNET-fed), Public Domain U.S. Government; state boundaries from the U.S. Census Bureau. Reference to CDC data does not imply endorsement by CDC, HHS or the U.S. Government.",
  },
  {
    key: 'phenology',
    html: "Phenology: Data were provided by the <a href=\"https://www.usanpn.org/data/observational\" target=\"_blank\" rel=\"noopener\">USA National Phenology Network</a> and the many participants who contribute to its Nature's Notebook program (CC BY 4.0, doi:10.5066/F78S4N1V).",
  },
  {
    key: 'neon-vectors',
    html: "Ticks and mosquitoes: <a href=\"https://data.neonscience.org/data-products/DP1.10093.001\" target=\"_blank\" rel=\"noopener\">NSF NEON ticks sampled using drag cloths (DP1.10093.001)</a> and <a href=\"https://data.neonscience.org/data-products/DP1.10043.001\" target=\"_blank\" rel=\"noopener\">mosquitoes sampled from CO2 traps (DP1.10043.001)</a>, provisional and released data, CC BY 4.0. NEON (National Ecological Observatory Network) is funded by the U.S. National Science Foundation.",
  },
  {
    key: 'cetaceans',
    html: "Whale detections: <a href=\"https://passiveacoustics.fisheries.noaa.gov/pacm/\" target=\"_blank\" rel=\"noopener\">NOAA NEFSC Passive Acoustic Cetacean Map</a> (Public Domain U.S. Government; Courtesy: National Oceanic and Atmospheric Administration; PACM and contributor citations in the info box).",
  },
  {
    key: 'drought',
    html: "Drought: <a href=\"https://droughtmonitor.unl.edu/\" target=\"_blank\" rel=\"noopener\">U.S. Drought Monitor</a>. The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC.",
  },
  {
    key: 'h5n1',
    html: "H5N1 sampled spread: <a href=\"https://nextstrain.org/avian-flu\" target=\"_blank\" rel=\"noopener\">Nextstrain avian-flu</a> genome-focused H5N1 builds (Moncla lab and the Nextstrain team); sequences and metadata shared by USDA NVSL via NCBI GenBank and SRA (public domain). US only; aggregated counts, no sequences or per-sample data.",
  },
  {
    key: 'fires',
    html: "Active fires (gridded): <a href=\"https://firms.modaps.eosdis.nasa.gov/\" target=\"_blank\" rel=\"noopener\">NASA FIRMS</a> VIIRS 375 m (Suomi-NPP, NOAA-20, NOAA-21), part of NASA's ESDIS/LANCE; full and open sharing, provided \"as is\".",
  },
  {
    key: 'ecoregions',
    html: "Ecoregions and biomes: <a href=\"https://ecoregions.appspot.com/\" target=\"_blank\" rel=\"noopener\">RESOLVE Ecoregions 2017</a> (CC BY 4.0), Dinerstein et al. 2017, <i>BioScience</i> 67(6):534\u2013545, <a href=\"https://doi.org/10.1093/biosci/bix014\" target=\"_blank\" rel=\"noopener\">doi:10.1093/biosci/bix014</a>. Boundaries simplified for display.",
  },
  {
    key: 'species',
    html: 'Species maps and "what lives here": <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF.org</a> occurrence search and maps (CC0 and CC BY records only); the top datasets behind each list and map are named with a DOI link where GBIF has one, and a gbif.org dataset page otherwise. Names: <a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a> and <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF</a>.',
  },
  {
    key: 'rivers',
    html: "River temperature and flow: <a href=\"https://waterdata.usgs.gov\" target=\"_blank\" rel=\"noopener\">U.S. Geological Survey</a> Water Data APIs (public domain; provisional data subject to revision). Any use of trade, firm, or product names is for descriptive purposes only and does not imply endorsement by the U.S. Government.",
  },
  {
    key: 'whispers',
    html: 'Wildlife die-offs and disease events: <a href="https://whispers.usgs.gov" target="_blank" rel="noopener">USGS WHISPers</a>, National Wildlife Health Center (Public Domain U.S. Government; county boundaries from the U.S. Census Bureau). Reference to USGS data does not imply endorsement.',
  },
  {
    key: 'usgs-nas',
    html: 'Invasive aquatic species: <a href="https://nas.er.usgs.gov" target="_blank" rel="noopener">USGS Nonindigenous Aquatic Species Database</a> (Public Domain U.S. Government). Reference to USGS data does not imply endorsement.',
  },
  {
    key: 'cdc-nwss',
    html: 'Wastewater virus trend: <a href="https://www.cdc.gov/wastewater" target="_blank" rel="noopener">CDC National Wastewater Surveillance System</a> (Public Domain U.S. Government; county boundaries from the U.S. Census Bureau). Reference to CDC data does not imply endorsement by CDC, HHS or the U.S. Government.',
  },
  {
    key: 'gbif-obis',
    html:
      'Wildlife sightings: <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF</a> and ' +
      '<a href="https://obis.org" target="_blank" rel="noopener">OBIS</a> occurrence records ' +
      '(CC0 / CC-BY records only; publisher named per record). GBIF subset registered as derived dataset ' +
      '<a href="https://doi.org/10.15468/dd.vugb55" target="_blank" rel="noopener">doi:10.15468/dd.vugb55</a>',
  },
  {
    key: 'noaa-viirs-chl',
    html: 'Chlorophyll-a: <a href="https://coastwatch.noaa.gov" target="_blank" rel="noopener">NOAA CoastWatch</a> VIIRS S-NPP/NOAA-20 gap-filled daily 4 km',
  },
  {
    key: 'noaa-oisst',
    html: 'Sea surface temperature: <a href="https://www.ncei.noaa.gov/products/optimum-interpolation-sst" target="_blank" rel="noopener">NOAA/NCEI OISST v2.1</a> (Huang et al. 2020)',
  },
  {
    key: 'nexrad-vol2bird',
    html:
      'Bird migration: NOAA NEXRAD Level II (AWS Open Data) processed with ' +
      '<a href="https://github.com/adokter/vol2bird" target="_blank" rel="noopener">vol2bird</a>',
  },
  {
    key: 'overpass',
    html:
      'Road geometry (traffic): ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'military-installations-osm',
    html:
      'Mapped installation context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0; incomplete mapped context)',
  },
  {
    key: 'cockpit-place-osm',
    html:
      'Cockpit place context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      'via Nominatim (ODbL 1.0)',
  },
  {
    key: 'open-meteo',
    html:
      'Cockpit current conditions: ' +
      '<a href="https://open-meteo.com/en/licence" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> ' +
      '(CC BY 4.0)',
  },
  {
    key: 'google-news-rss',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://policies.google.com/terms" target="_blank" rel="noopener">Google News RSS</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'gdelt',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://www.gdeltproject.org/about.html" target="_blank" rel="noopener">GDELT Project</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'austin-cctv',
    html:
      'CCTV cameras &amp; frames: City of Austin, TX — ' +
      '<a href="https://data.austintexas.gov" target="_blank" rel="noopener">data.austintexas.gov</a>',
  },
  {
    key: 'caltrans-cctv',
    html:
      'CCTV cameras &amp; frames (California): Caltrans — ' +
      '<a href="https://cwwp2.dot.ca.gov/" target="_blank" rel="noopener">cwwp2.dot.ca.gov</a>',
  },
  {
    key: 'tfl-cctv',
    html:
      'CCTV cameras &amp; frames (London): ' +
      '<a href="https://tfl.gov.uk/info-for/open-data-users/" target="_blank" rel="noopener">Powered by TfL Open Data</a>. ' +
      'Contains OS data © Crown copyright and database rights.',
  },
  {
    key: 'gbfs',
    html: 'Bikeshare availability: GBFS operator feeds (e.g. Austin BCycle)',
  },
  {
    key: 'radio-browser',
    html:
      'Internet-radio station directory: ' +
      '<a href="https://www.radio-browser.info/" target="_blank" rel="noopener">Radio Browser</a> ' +
      '(public domain; audio delivered directly by each broadcaster)',
  },
  {
    key: 'reearth-terrain',
    html:
      'Terrain (keyless globe stacks): ' +
      '<a href="https://terrain.reearth.land" target="_blank" rel="noopener">Re:Earth Terrain</a> / ' +
      'Mapterhorn (CC BY 4.0) / EGM2008 (NGA)',
  },
  // ── Bundled snapshots ───────────────────────────────────────────
  {
    key: 'datacenters',
    html:
      'Datacenters: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'dams',
    html:
      'Dams: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0) + Open Infrastructure Map',
  },
  {
    key: 'firms',
    html:
      'Active fires: NASA FIRMS — we acknowledge the use of data and/or imagery ' +
      'from NASA’s Fire Information for Resource Management System ' +
      '(<a href="https://earthdata.nasa.gov/firms" target="_blank" rel="noopener">earthdata.nasa.gov/firms</a>), ' +
      'part of NASA’s Earth Observing System Data and Information System (EOSDIS)',
  },
  {
    key: 'telegeography',
    html:
      'Submarine cables: © TeleGeography — ' +
      '<a href="https://www.submarinecablemap.com" target="_blank" rel="noopener">submarinecablemap.com</a> ' +
      '(CC BY-NC-SA 3.0 — NonCommercial)',
  },
];

/**
 * Conditional credits — registered via `registerDynamicCredit` only when the
 * corresponding capability actually activates (deliberately NOT part of
 * DATA_CREDITS, which is always-on). TomTom terms require attribution when
 * their flow data is displayed; keyless installs never show it, so the
 * credit only appears once live traffic-flow mode activates.
 * @type {{ key: string, html: string }}
 */
export const TOMTOM_CREDIT = {
  key: 'tomtom',
  html:
    'Traffic flow data © ' +
    '<a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>',
};

/** Registered when the first Natural Earth region outline resolves (public
 * domain — no attribution required; credited as a courtesy). */
export const NATURAL_EARTH_CREDIT = {
  key: 'natural-earth',
  html:
    'Physical region boundaries from ' +
    '<a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a> (public domain)',
};

/** @type {Set<string>} Keys of dynamic credits already registered this session. */
const _dynamicCreditKeys = new Set();

/**
 * Register a conditional credit at the moment its data source activates.
 * Idempotent per `credit.key`; lands in the same "Data attribution" popover
 * as the static credits (showOnScreen=false).
 * @param {Cesium.Viewer} viewer — the initialized Cesium viewer
 * @param {{ key: string, html: string }} credit — e.g. `TOMTOM_CREDIT`
 * @returns {boolean} True when the credit is (now) registered.
 */
export function registerDynamicCredit(viewer, credit) {
  const creditDisplay = viewer?.creditDisplay;
  if (!creditDisplay || typeof creditDisplay.addStaticCredit !== 'function') {
    return false;
  }
  if (!credit?.key || !credit?.html) return false;
  if (_dynamicCreditKeys.has(credit.key)) return true;
  creditDisplay.addStaticCredit(new Cesium.Credit(credit.html, false));
  _dynamicCreditKeys.add(credit.key);
  return true;
}

/**
 * Register every per-layer data credit into the viewer's credit display.
 * Idempotent: safe to call once at init. Credits are static and always
 * present in the "Data attribution" popover.
 * @param {Cesium.Viewer} viewer — the initialized Cesium viewer
 */
export function registerDataCredits(viewer) {
  const creditDisplay = viewer?.creditDisplay;
  if (!creditDisplay || typeof creditDisplay.addStaticCredit !== 'function') {
    return;
  }
  for (const { html } of DATA_CREDITS) {
    // showOnScreen=false → lives in the expandable "Data attribution" popover,
    // not the on-globe credit line.
    creditDisplay.addStaticCredit(new Cesium.Credit(html, false));
  }
}
