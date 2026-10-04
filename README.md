# wildeye

wildeye is a fork of [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view), a Cesium globe that draws live data over photorealistic 3D tiles. This fork adds biological and environmental data layers.

Live site: https://musharna.github.io/wildeye/

## Layers added in this fork

**Animals**
- Bird migration (radar): nocturnal migration density per US NEXRAD radar, computed with [vol2bird](https://github.com/adokter/vol2bird) every 10 minutes, with a replay of recent nights
- Bird migration (Europe): radar vertical profiles from Aloft
- Wildlife sightings: GBIF, OBIS and USA-NPN records for 22 taxa, xeno-canto sound recordings, and invasive aquatic species from USGS NAS
- Animal tracks: IOOS Animal Telemetry Network deployments and Movebank studies published under CC0 or CC BY
- Acoustic fish detections at Ocean Tracking Network receivers
- Whale detections from NOAA passive acoustic monitoring
- Small mammals, and ticks and mosquitoes, at NEON field sites

**Disease**
- Avian influenza detections in wild birds by county (USDA APHIS)
- Wildlife die-offs and disease events by county (USGS WHISPers)
- H5N1 sequenced samples by state, from Nextstrain builds that use open USDA and GenBank data (United States only)
- Mosquito- and tick-borne disease cases by state (CDC)
- Wastewater virus trend by county (CDC NWSS)

**Plants and land**
- Phenology: leaf, flower, fruit and insect observations (USA-NPN)
- Vegetation greenness (NDVI)
- Deforestation alerts by country (Global Forest Watch)
- Active fires (NASA FIRMS)
- Drought (U.S. Drought Monitor)
- Ecoregions and biomes (RESOLVE 2017)

**Water and ocean**
- River temperature and flow at USGS gages
- Sea surface temperature, chlorophyll-a and sea ice
- Coral bleaching alerts and coral heat stress (NOAA Coral Reef Watch)
- Surface dissolved oxygen and pH (Copernicus Marine Service)
- Tidal marshes 2020, as the share of each ~150 m cell (Worthington et al.)

Most of these layers follow a shared time bar covering the last 30 days.

## Species search

The SPECIES panel finds a species by common or scientific name. Name suggestions come from
iNaturalist, with GBIF as a fallback. The map draws GBIF occurrence records under CC0 or CC BY as
circles whose size and colour show how many records each circle holds, for the last 10 years or
for all years. The panel names the three datasets with the most of those records, with a DOI link
where GBIF has one.

"What lives here" lists the 20 species with the most CC0 and CC BY records within 1, 10 or 50 km
of a point you click, and the five datasets they come from. Each list links to the same search on
gbif.org, where the records can be browsed and downloaded with a citation.

Clicking a marker from a biology layer opens a card with that record's details, citation and
licence.

These features run in the browser and work on the hosted site.

## Where the data comes from

The scripts in `pipeline/` run on a schedule, download each source, and write plain data files to `public/data/`. API keys stay on the machine running the pipelines and never reach the browser. `pipeline/README.md` lists each script and its schedule. A fresh clone shows data without running anything, because `pipeline/seed.sh` copies small committed snapshots into place.

A source is included only if its terms allow the data to be redisplayed. `DATA_SOURCES.md` records the licence and required credit for each source, and lists the sources that were left out and why (for example the World Database on Protected Areas, and the GISAID-based H5N1 builds). The GBIF records in the sightings layer are registered as derived dataset [doi:10.15468/dd.vugb55](https://doi.org/10.15468/dd.vugb55).

## The hosted site

GitHub Pages serves a static build of the same app, and every layer works there.

## Run it locally

```bash
npm ci
npm run seed   # copy the committed data snapshots into public/data/
npm run dev
```

## Tests

```bash
npm test                                   # JavaScript
python -m pytest pipeline/tests            # pipelines
node scripts/qa-gap-layers.mjs --url <url> # headless browser check of the newer layers
```

## Licence

MIT, see `LICENSE`, as for God's Eye View. The data keeps its own terms: `DATA_SOURCES.md` lists each source's licence and required credit.
