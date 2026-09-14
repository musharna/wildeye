# wildeye — Species search, "what lives here", and the biology details card

Date: 2026-09-13. Status: DESIGN APPROVED (sections 1–3 approved in chat 2026-09-13); spec awaiting user review.

## Goal
Let a visitor ask the two questions the fixed 22-taxon sightings layer cannot answer: "where has this
species been recorded?" and "what has been recorded here?". Fix, on the way, the pre-existing bug that
clicking any biology marker shows nothing. Everything runs in the browser so it works on the GitHub
Pages build (no `/api`).

## Findings this design rests on (verified 2026-09-13)
- Biology details never display. `src/main.js:121` sets `infoBox: false`; nothing listens to
  `viewer.selectedEntityChanged`; `gev:entity-selected` is consumed only by aircraft readouts. Live
  Pages probe: clicking `occ:blue-whale:2026-09-01:0` sets `viewer.selectedEntity`, but the page text
  contains neither "Blue whale", "Balaenoptera" nor "human observation". Citations and licences that
  DATA_SOURCES.md says are "in the info box" are therefore invisible.
- 19 layers set `entity.description`; biology layers name their `CustomDataSource` by layer id
  (e.g. `new Cesium.CustomDataSource("occurrences")`, `src/data/occurrences.js:157`).
- Layer rows render only chips and a legend (`src/data/manager.js:2087`), so a text box needs its own panel.
- GBIF: `/v1/occurrence/search` with `geoDistance`, `license`, `facet=speciesKey` → 200, CORS `*`, 0.49 s
  (39,210 records within 10 km of 44.46,-110.83). `/v2/map/occurrence/density` IGNORES `license=`
  (identical bytes with and without); `/v2/map/occurrence/adhoc` applies `license=` and `year=`.
  `/v1/species/match` returns the keys already in `pipeline/taxa.json` (Danaus plexippus 5133088).
- GBIF vernacular search ranks common names badly ("monarch" → Monarchidae, Monarcha…; "red maple" →
  a moth). iNaturalist `/v1/taxa/autocomplete` ranks them first (Danaus plexippus, Megaptera
  novaeangliae, Acer rubrum), CORS `*`.
- iNaturalist API docs (swagger.json, read 2026-09-13): "The API is intended to support application
  development, not data scraping." "…we ask that you try to keep it to 60 requests per minute or lower,
  and to keep under 10,000 requests per day." Terms of Service page: 403 to scripts, UNREAD.
  GBIF terms pages: 403 to scripts, UNREAD.

## Components
1. `src/bio/detailsCard.js` — shared HUD card.
   - Listens to `viewer.selectedEntityChanged`. Opens when the entity's owning data source
     (`entity.entityCollection.owner.name`) is in `BIO_CARD_LAYER_IDS` and the entity has a
     `description`. Flights, satellites and other inherited layers keep their own readouts.
   - Detail mode renders the layer-built description HTML (fields already escaped by each layer).
   - List mode (`showList({title, filterLine, rows, footer})`) for "what lives here"; row strings from
     GBIF/iNaturalist are inserted with `textContent`, never `innerHTML`.
   - Closes on its close button, Escape, or when the selection clears.
   - `BIO_CARD_LAYER_IDS`: occurrences, tracks, otn, cetaceans, neon, neon-vectors, phenology, rivers,
     hpai, whispers, h5n1, arbonet, wastewater, fires, gfw, drought, ecoregions, birds, fishing.
2. `src/bio/gbif.js` — request builders and parsers, no DOM.
   - `inatSuggest(q)`: iNaturalist `/v1/taxa/autocomplete?q=&per_page=8`; client-side limiter ≤ 60/min.
   - `gbifMatch(scientificName)`: `/v1/species/match?name=&strict=true` → `acceptedUsageKey ?? usageKey`,
     or `null` ("not in GBIF").
   - `gbifSuggest(q)`: `/v1/species/suggest` — used only when iNaturalist fails, with a visible notice.
   - `densityTileTemplate({taxonKey, years})`: `/v2/map/occurrence/adhoc/{z}/{x}/{y}@1x.png` with
     `taxonKey`, `license=CC0_1_0&license=CC_BY_4_0`, `year=<from>,<to>` (omitted for all years),
     `style=classic.poly&bin=hex`. Never `density`. (Built differently: see Implementation notes.)
   - `speciesNear({lat, lon, radiusKm, years})`: `/v1/occurrence/search?geoDistance=lat,lon,Rkm`,
     both licences, year range, `hasCoordinate=true&hasGeospatialIssue=false&facet=speciesKey&facetLimit=20&limit=0`
     → `{total, species:[{key, count}]}`.
   - `speciesName(key)`: `/v1/species/{key}` → `{scientificName, vernacularName, class}`; session cache,
     at most 4 in flight.
   - Every request: 8 s timeout, `AbortController`; a newer search aborts the older one.
3. `src/data/species.js` — data layer `species` (token `sp`, `requiresBackend` false).
   - Cesium `UrlTemplateImageryProvider` from `densityTileTemplate`, alpha 0.7, stacked above the
     raster drapes. (Built at alpha 1: see Implementation notes.)
   - `getParams/setParams`: `{taxonKey, years: 'recent'|'all', radiusKm: 1|10|50}`; `recent` = the
     last 10 calendar years including the current one.
   - Share-link option group in `src/data/layerState.js` (taxon key, years, radius); the display name
     is looked up again on load. Registered-layer count test 44 → 45.
   - Tile failures (Cesium `errorEvent`) counted; repeated failures surface "map tiles failing" in the panel.
4. `src/bio/speciesPanel.js` + `#species-panel` markup — SPECIES panel in `#left-panel-stack`,
   registered alongside `scene-panel` in the `src/ui.js` panel list.
   - Search box: suggestions after 3 letters and a 300 ms pause (common name, scientific name, rank).
   - Chosen species chip with on/off (enables/disables the `species` layer).
   - Year chips: last 10 years (default) / all years. Radius chips: 1 / 10 (default) / 50 km.
   - "What lives here" button. Credit line: names from iNaturalist, records from GBIF.org.
5. `src/bio/whatLivesHere.js` — arm, then click.
   - Button arms a one-shot `LEFT_CLICK`; cursor becomes a crosshair; Escape disarms.
   - Click on an entity: the normal click wins, no query, stays armed. Click on sky/space
     (`camera.pickEllipsoid` undefined): stays armed, message "click on the globe".
   - Click on ground: `speciesNear` → `speciesName` for the 20 keys → card list: total records,
     20 rows (common name, scientific name, count), filter line ("CC0 and CC BY records · 2017–2026 ·
     within 10 km"), footer "Occurrence data: GBIF.org, CC0 and CC BY records only" linking to the same
     query on gbif.org.
   - Clicking a row selects that species in the panel and turns the density map on.

## Errors (visible, never swallowed)
- Suggestions: "iNaturalist didn't answer (HTTP <status>|timeout)"; GBIF scientific-name suggestions
  shown with that notice.
- Card list: "GBIF search failed (<reason>)" with Retry.
- Zero results is its own message: "No CC0/CC BY records within <R> km for <years>" plus a hint to
  widen radius or years.
- Card render errors: `console.error` with layer id and entity id; marker clicks keep working.

## Credits and legal
- `src/data/dataCredits.js`: GBIF.org (occurrence search and maps, CC0/CC BY records only) and
  iNaturalist (taxon names). DATA_SOURCES.md rows for both with the verified facts above.
- Release gate: read GBIF terms and the iNaturalist Terms of Service in a browser and record quotes
  in DATA_SOURCES.md before the Pages deploy.

## Testing
- Unit (node --test, no network), each seen failing against a wrong implementation:
  - `densityTileTemplate` uses `adhoc`, carries both licence params and the year range (fails if `density`).
  - `speciesNear` parser; `speciesName` concurrency never exceeds 4; iNaturalist limiter ≤ 60/min.
  - Card decision: biology data source + description → open; flights entity → closed; no description → closed.
  - `species` share options round-trip; registered-layer count 45.
  - `whatLivesHere`: entity hit → no query; ground hit → exactly one `speciesNear`.
- Real execution (puppeteer, local static build then live Pages):
  - Click a sighting → card shows its name and licence line (today's failing blue-whale probe).
  - Search "monarch" → tile requests go to `/v2/map/occurrence/adhoc` with both licence params.
  - What lives here at Yellowstone → ≥ 1 species row; 0 failed requests.
  - `scripts/qa-static-controls.mjs` crawl covers the SPECIES panel.
- Visual: independent critic subagent reviews screenshots of card, panel and density map.

## Rollout
- Code on `main-wildeye`, deployed with `pipeline/deploy_pages.sh`.
- README and CHANGELOG entries in a draft PR for the user to read.

## Out of scope
Season/year replay, biology scenes, new data layers from the 2026-09-13 source triage, voice aliases,
IUCN badges in the species list (IUCN stays dormant until its token exists).

## Implementation notes (2026-09-13)
What the build changed from the design above, and why.
- Map tiles request `srs=EPSG:3857`. GBIF's `adhoc` endpoint defaults to EPSG:4326, and Cesium's
  `UrlTemplateImageryProvider` lays tiles out in Web Mercator, so without it the hexagons are drawn in the wrong place.
- The map style is `classic-noborder.poly` at layer alpha 1, not `classic.poly` at 0.7. Opaque fills keep a hexagon's colour
  independent of the imagery under it. Against the Esri basemap at the 12,000 km view, the sparsest class has a median contrast
  of 2.36:1 over land and 2.78:1 over ocean (1.90:1 and 2.18:1 with `classic.poly` at 0.7). No fill reaches 3:1 there: the
  globe's ground atmosphere lightens the basemap so much that even white measures 2.54:1 over that land.
- The legend lists the record-count classes of that style (github.com/gbif/maps,
  `mapnik-server/src/main/node/cartocss/classic-noborder-poly.mss`): up to 10, 100, 1,000, 10,000 and 100,000 records per
  hexagon, and more. Each swatch is its class colour as the globe draws it, fitted at the 12,000 km view as
  0.794 × style colour + (25.5, 28.3, 55.0) per channel. The fit holds at that camera height; closer views draw purer colours.
  The top class does not occur in the monarch map, so its colour is predicted, not sampled. `SPECIES_MAP_LEGEND` in
  `src/bio/gbif.js` holds the classes and colours, and `src/bio/gbif.test.mjs` pins them to the style the tiles use.
- "What lives here" searches a 64-vertex polygon (`geometry`), and its gbif.org link carries the same polygon, because gbif.org
  ignores `geo_distance`. A circle centred beyond ±85° latitude, or one that would cross ±180°, is searched with `geoDistance`
  instead, and its link carries only the licences and years.
- The details card sanitizes layer descriptions with DOMPurify. Only http, https and mailto links survive, and each opens in a new
  tab with `rel="noopener noreferrer"`.
- Only HTTP and network errors count as tile failures. GBIF answers an empty tile with 204, which Cesium reports as an error of
  its own.
- Dismissing the card cancels the search it was waiting for. The searched circle's outline shows exactly while the card shows
  that search's status or list.
- Hexagons can mismatch where Cesium mixes GBIF zoom levels across the view. Square bins were tested at 128 px (empty stripes)
  and 256 px (a blurred map) and rejected.
- The `adhoc` endpoint aggregates records into Elasticsearch geohash cells whose size depends on the zoom, and bins one point per
  cell into hexagons (github.com/gbif/maps `AdHocMapsResource`, github.com/gbif/occurrence `BaseEsHeatmapRequestBuilder`).
  Where a hexagon is about one cell wide or smaller, some hexagons that hold records draw empty: with `hexPerTile=30`, 19% of the
  hexagons with monarch records in tile 3/2/2, 53% in 6/16/23 and 74% in 9/130/190 (compared with the point-level `density`
  tiles, 2026-09-13).
