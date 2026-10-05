import * as Cesium from 'cesium';

/**
 * Per-layer data attribution registered into Cesium's credit display.
 *
 * Legal requirement (see DATA_SOURCES.md, findings H10/H11 in
 * docs/pre-ship-audit-2026-07-01.md): every third-party data layer this app can
 * display carries its own license and required attribution (GBIF/OBIS per-record
 * licences, NASA, NOAA, Movebank, ...).
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
    html: 'Land cover, vegetation (EVI), land surface temperature, night lights, forest biomass, species richness, plant productivity, canopy height and anthropogenic biomes: '
      + 'We acknowledge the use of imagery provided by services from NASA\'s '
      + '<a href="https://nasa-gibs.github.io/gibs-api-docs/" target="_blank" rel="noopener">Global Imagery Browse Services (GIBS)</a>, '
      + 'part of NASA\'s Earth Science Data and Information System (ESDIS).',
  },
  {
    key: 'sedac-richness',
    html: 'Amphibian and mammal species richness: CIESIN, Columbia University, and NatureServe (2015), Gridded Species Distribution: '
      + '<a href="https://doi.org/10.7927/H4RR1W66" target="_blank" rel="noopener">Global Amphibian Richness Grids</a> and '
      + '<a href="https://doi.org/10.7927/H4N014G5" target="_blank" rel="noopener">Global Mammal Richness Grids</a>, 2015 Release, '
      + 'NASA SEDAC, from IUCN Red List ranges (April 2013); non-commercial use, share-alike; tiles load from NASA GIBS and are not re-hosted',
  },
  {
    key: 'gibs-gpp-canopy-anthromes',
    html: 'Plant productivity: Running, Mu &amp; Zhao (2021), <a href="https://doi.org/10.5067/MODIS/MOD17A2H.061" target="_blank" rel="noopener">MOD17A2H v061</a>, NASA LP DAAC. '
      + 'Canopy height: Dubayah et al. (2021), <a href="https://doi.org/10.3334/ORNLDAAC/1952" target="_blank" rel="noopener">GEDI L3 Gridded Land Surface Metrics, Version 2</a>, ORNL DAAC. '
      + 'Anthropogenic biomes: Ellis &amp; Ramankutty (2008), <a href="https://doi.org/10.7927/H4H12ZXD" target="_blank" rel="noopener">Anthropogenic Biomes of the World, Version 1</a>, NASA SEDAC. '
      + 'Tiles load from NASA GIBS and are not re-hosted',
  },
  {
    key: 'malaria-atlas',
    html: 'Malaria: <a href="https://data.malariaatlas.org" target="_blank" rel="noopener">Malaria Atlas Project</a>, '
      + 'Plasmodium falciparum parasite rate in children aged 2–10, 2000–2025, 2026-08 release (5 km); '
      + '<a href="https://malariaatlas.org/open-access-policy/" target="_blank" rel="noopener">CC BY 3.0</a>; '
      + 'maps and point estimates load from MAP\'s server and are not re-hosted',
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
    key: 'gmw',
    html: 'Mangrove extent by country: <a href="https://doi.org/10.5281/zenodo.21346457" target="_blank" rel="noopener">Global Mangrove Watch: Timeseries of Mangrove Extent v4.1.12</a> (Bunting, Hilarides, Rosenqvist, Oakes et al. 2026, Zenodo), <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>; country totals shown on Natural Earth map units, coloured by change since 1985.',
  },
  {
    key: 'griis',
    html: 'Introduced species by checklist: GRIIS, ISSG via GBIF, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a> (three lists CC0). <a href="https://www.gbif.org/publisher/cdef28b1-db4e-4c58-aa71-3c5238c2d0b5" target="_blank" rel="noopener">Global Register of Introduced and Invasive Species</a> checklists published by the Invasive Species Specialist Group; each list\'s own citation and DOI are in its info box. Counts shown on Natural Earth map units.',
  },
  {
    key: 'hansen-loss',
    html: 'Forest loss: Source: Hansen/UMD/Google/USGS/NASA. <a href="https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12/download.html" target="_blank" rel="noopener">Global Forest Change 2000–2024 v1.12</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>; Hansen et al. 2013, <i>Science</i> 342:850–853, <a href="https://doi.org/10.1126/science.1244693" target="_blank" rel="noopener">doi:10.1126/science.1244693</a>. Tiles served by Global Forest Watch; recoloured by loss year for display.',
  },
  {
    key: 'surface-water',
    html: 'Surface water: Source: EC JRC/Google. <a href="https://global-surface-water.appspot.com/download" target="_blank" rel="noopener">JRC Global Surface Water</a> occurrence 1984–2021, provided free of charge, without restriction of use; Pekel, Cottam, Gorelick &amp; Belward 2016, <i>Nature</i> 540:418–422, <a href="https://doi.org/10.1038/nature20584" target="_blank" rel="noopener">doi:10.1038/nature20584</a>.',
  },
  {
    key: 'human-footprint',
    html: 'Human footprint: <a href="https://doi.org/10.6084/m9.figshare.16571064.v8" target="_blank" rel="noopener">Global annual Human Footprint 2000–2024</a> (figshare v8), <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>; Mu, Li, Wen, Huang et al. 2022, <i>Scientific Data</i> 9:176, <a href="https://doi.org/10.1038/s41597-022-01284-8" target="_blank" rel="noopener">doi:10.1038/s41597-022-01284-8</a>. Five snapshots (2000, 2006, 2012, 2018, 2024), area-averaged from 1 km to ~5 km and binned for display.',
  },
  {
    key: 'bii',
    html: 'Biodiversity intactness: <a href="https://doi.org/10.5519/k33reyb6" target="_blank" rel="noopener">The Biodiversity Intactness Index developed by The Natural History Museum, London, v2.1.1</a> (Open Access, Limited Release), © The Trustees of the Natural History Museum, London, <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>; De Palma, Contu, Thomas, Duffin, Nix &amp; Purvis 2024, Natural History Museum, <a href="https://doi.org/10.5519/k33reyb6" target="_blank" rel="noopener">doi:10.5519/k33reyb6</a>. Changed: five snapshots (2000, 2005, 2010, 2015, 2020) resampled from 5 arc-minutes to ~5 km tiles and binned to 1% for display; the tiles and <a href="data/bii.json" target="_blank" rel="noopener">bii.json</a> are published under the same licence, not for commercial use.',
  },
  {
    key: 'reptiles',
    html: 'Reptile richness: <a href="https://doi.org/10.5281/zenodo.6499637" target="_blank" rel="noopener">GARD 1.7, updated global distributions for all terrestrial reptiles</a> (Roll &amp; Meiri 2022, Zenodo), <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener">CC0 1.0</a>; Roll, Feldman, Novosolov et al. 2017, <i>Nature Ecology &amp; Evolution</i> 1:1677–1682, <a href="https://doi.org/10.1038/s41559-017-0332-2" target="_blank" rel="noopener">doi:10.1038/s41559-017-0332-2</a>; Caetano, Chapple, Grenyer et al. 2022, <i>PLoS Biology</i> 20(5):e3001544, <a href="https://doi.org/10.1371/journal.pbio.3001544" target="_blank" rel="noopener">doi:10.1371/journal.pbio.3001544</a>. Species whose range overlaps each 0.1° cell, counted from the range maps.',
  },
  {
    key: 'wetlands',
    html: 'Wetlands: <a href="https://www.hydrosheds.org/products/glwd" target="_blank" rel="noopener">Global Lakes and Wetlands Database (GLWD) v2</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>; Lehner, Anand, Fluet-Chouinard, Tan et al. 2025, <i>Earth System Science Data</i> 17:2277–2329, <a href="https://doi.org/10.5194/essd-17-2277-2025" target="_blank" rel="noopener">doi:10.5194/essd-17-2277-2025</a>. Dominant wetland type where wetland covers more than half the cell, shown at ~1.2 km.',
  },
  {
    key: 'obis-grid',
    html: 'Marine records: OBIS (2026) <a href="https://obis.org" target="_blank" rel="noopener">Ocean Biodiversity Information System</a>, Intergovernmental Oceanographic Commission of UNESCO, from the <a href="https://obis.org/data/access/" target="_blank" rel="noopener">OBIS open-data export</a>; records, species and datasets per 1° cell from CC0 1.0 and CC BY 4.0 datasets only, each named with its licence in <a href="data/obis_grid_datasets.json" target="_blank" rel="noopener">obis_grid_datasets.json</a>.',
  },
  {
    key: 'protected-areas',
    html: 'Protected areas: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">Open Database License</a>, read from <a href="https://docs.overturemaps.org/guides/base/" target="_blank" rel="noopener">Overture Maps</a> (base theme, land_use, protected). The lookup files (<a href="data/protected_areas.json" target="_blank" rel="noopener">protected_areas.json</a> and its shards) are a derivative database, published under the ODbL. OpenStreetMap\'s coverage is uneven and it is not an official registry.',
  },
  {
    key: 'camera-traps-edna',
    html: 'Camera traps and eDNA: <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF.org</a> occurrence download (SQL), CC0 1.0 and CC BY 4.0 animal records whose sampling protocol names a camera trap or environmental DNA, counted per 1° cell; the download\'s DOI is in each layer\'s legend and in <a href="data/camera_traps.json" target="_blank" rel="noopener">camera_traps.json</a>, the datasets in <a href="data/camera_traps_datasets.json" target="_blank" rel="noopener">camera_traps_datasets.json</a>. Where the method was used and published, not where animals are.',
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
    key: 'biotime',
    html: 'Assemblage time series: <a href="https://doi.org/10.5281/zenodo.15222193" target="_blank" rel="noopener">BioTIME 2.0</a> (Zenodo 15222193, CC BY 4.0); Dornelas et al. 2025, <i>Global Ecology and Biogeography</i> 34(5): e70003, <a href="https://doi.org/10.1111/geb.70003" target="_blank" rel="noopener">doi:10.1111/geb.70003</a>. Only studies under open-attribution licences are shown; each study\'s own citation and licence are in its info box. Counts are raw taxa and samples per study-year.',
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
    key: 'marine-realms',
    html: "Marine realms: <a href=\"https://doi.org/10.17608/k6.auckland.5596840\" target=\"_blank\" rel=\"noopener\">GIS shape files of realm maps</a> (Mark Costello, figshare, <a href=\"https://creativecommons.org/licenses/by/4.0/\" target=\"_blank\" rel=\"noopener\">CC BY 4.0</a>); Costello, Tsai, Wong, Cheung, Basher &amp; Chaudhary 2017, <i>Nature Communications</i> 8:1057, <a href=\"https://doi.org/10.1038/s41467-017-01121-2\" target=\"_blank\" rel=\"noopener\">doi:10.1038/s41467-017-01121-2</a>. Changed: land removed (<a href=\"https://www.naturalearthdata.com/\" target=\"_blank\" rel=\"noopener\">Natural Earth</a> 10 m, public domain) and boundaries simplified for display; realm names, groups and species counts from the paper's Fig. 1.",
  },
  {
    key: 'freshwater-fish',
    html: "Freshwater fish: <a href=\"https://doi.org/10.5281/zenodo.19511163\" target=\"_blank\" rel=\"noopener\">A global geospatial dataset of freshwater fish species at the drainage-basin scale (updated to December 2024)</a> (Liuyong Ding, Zenodo, <a href=\"https://creativecommons.org/licenses/by/4.0/\" target=\"_blank\" rel=\"noopener\">CC BY 4.0</a>), updating Tedesco et al. 2017, <i>Scientific Data</i> 4:170141, <a href=\"https://doi.org/10.1038/sdata.2017.141\" target=\"_blank\" rel=\"noopener\">doi:10.1038/sdata.2017.141</a>. Changed: boundaries simplified for display; species counts binned and the five largest families per basin taken from the record's species table.",
  },
  {
    key: 'species',
    html: 'Species maps and "what lives here": <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF.org</a> occurrence search and maps (CC0 and CC BY records only); the top datasets behind each list and map are named with a DOI link where GBIF has one, and a gbif.org dataset page otherwise. Names: <a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a> and <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF</a>.',
  },
  {
    key: 'modeled-range',
    html: 'Modeled range: <a href="https://github.com/inaturalist/inatGeoModelTraining" target="_blank" rel="noopener">iNaturalist Geomodel</a>, CC BY 4.0. Shown only for species whose collection passed wildeye\'s monthly check against non-iNaturalist GBIF records, and whose map tiles match the range that was tested.',
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
      '(CC0 / CC-BY records only, except Happywhale sightings, shown under their datasets\' CC BY-NC 4.0; publisher named per record). GBIF subset registered as derived dataset ' +
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
    key: 'reearth-terrain',
    html:
      'Terrain (keyless globe stacks): ' +
      '<a href="https://terrain.reearth.land" target="_blank" rel="noopener">Re:Earth Terrain</a> / ' +
      'Mapterhorn (CC BY 4.0) / EGM2008 (NGA)',
  },
];

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
