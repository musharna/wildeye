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
     `style=scaled.circles` with no `bin`, and `srs=EPSG:3857`. Never `density`. (Designed as hexagon tiles; changed to circles: see
     Implementation notes.)
   - `speciesNear({lat, lon, radiusKm, years})`: `/v1/occurrence/search?geoDistance=lat,lon,Rkm`,
     both licences, year range, `hasCoordinate=true&hasGeospatialIssue=false&facet=speciesKey&facetLimit=20&limit=0`
     → `{total, species:[{key, count}]}`. (Searched differently: see Implementation notes.)
   - `speciesName(key)`: `/v1/species/{key}` → `{scientificName, vernacularName, class}`; session cache,
     at most 4 in flight.
   - Every request: 8 s timeout, `AbortController`; a newer search aborts the older one.
3. `src/data/species.js` — data layer `species` (token `sp`, `requiresBackend` false).
   - Cesium `UrlTemplateImageryProvider` from `densityTileTemplate`, declaring GBIF's 512 px tiles, at layer alpha 1 (the style
     sets each class's opacity), stacked above the raster drapes. (Designed at alpha 0.7: see Implementation notes.)
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
   - "What lives here" button. Credit line: names from iNaturalist, records from GBIF.org, top datasets named with a DOI link where GBIF
     has one and a gbif.org dataset page otherwise.
   - While the map is on: the record-count legend, then the taxon's top 3 datasets (see Implementation notes).
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
  in DATA_SOURCES.md before the Pages deploy. (Read from Internet Archive captures, which the user accepted on 2026-09-14: see
  Implementation notes.)

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
  `UrlTemplateImageryProvider` lays tiles out in Web Mercator, so without it the map is drawn in the wrong place.
- The map draws GBIF's unbinned `scaled.circles` style, the user's choice on 2026-09-14. With no `bin`, every Elasticsearch geohash cell
  that holds records is one circle, whose width, fill, opacity and line are set by its record count (github.com/gbif/maps
  `mapnik-server/src/main/node/cartocss/scaled-circles.mss`, last changed in commit 9dd3dba): up to 10 records 6 px #fed976 at opacity 1
  with a 1 px #fe9724 line, up to 100 7 px #fd8d3c at 0.8, up to 1,000 10 px #fd8d3c at 0.7, up to 10,000 16 px #f03b20 at 0.6, and more
  30 px #bd0026 at 0.6. The layer draws at alpha 1, so each class keeps its style opacity.
- Binned hexagons were dropped: `adhoc` bins one point per geohash cell, so small hexagons holding records drew empty (19% to 69% of the
  monarch's at `hexPerTile=30`, zooms 3, 6 and 9), and the coarse per-zoom sizes that avoided that painted wide stretches of ocean
  (114,954 px more than 8 px from land at the 12,000 km view).
- On the final template (2026-09-14), 0 record-bearing cells went undrawn in the tiles measured at zooms 2, 3, 5, 6, 8 and 9 for the
  monarch and for Bombus affinis. At the 12,000 km view, six captures of the same setup gave 1,614–1,909 species pixels more than 8 px
  from land and a median smallest-class circle core of 10.62–12.05 px; the spread comes from which tiles had loaded at capture time.
- GBIF serves `@1x` tiles 512 px square, and `UrlTemplateImageryProvider` assumes 256 px unless told, so it drew every GBIF pixel at about
  half size. The provider declares 512: the smallest circles at the Upper Midwest view measured 4.4 px across at 256 and
  8.9 px declared 512 (median core diameter).
- The legend lists the five classes as solid circles at the style's width in CSS px, each in the colour the globe draws that class at the
  default 12,000 km view over the Esri World Imagery basemap, each circle's class read from its tile's own record count. The three lowest
  classes were measured in the default LAST 10 YEARS map, around the centres of circles whose centre no other circle reaches (three runs).
  That map has no circle of the two highest classes, and their circles always overlap others, so they were measured in the ALL YEARS map
  from the pixels only their own circle covers (two runs: 51 circles of up to 10,000 records, 2 above). Where several circles above 10,000
  stack, the globe draws a deeper magenta than the swatch (visual critic 7 saw one): 472 of the 473 such pixels in that view lie under 2 to
  5 circles. Solid style fills at their opacity on the dark panel showed colours the map never has (CIEDE2000 16.6–23.0 from the rendered
  classes). The colours hold from far out only: at the 1,700 km Upper Midwest view the circles of up to 100 and up to 1,000 records look
  stronger, about 10 L* darker and twice as saturated (CIEDE2000 11–13 from the swatches). The caption says "Records per circle · colours as
  seen from far out; closer up they look stronger". `SPECIES_MAP_LEGEND` in `src/bio/gbif.js` holds the classes, their colours and the map
  each colour was measured in, `src/bio/gbif.test.mjs` pins the classes to the style file, and `scripts/species-legend-probe.mjs`
  (`--years`), `species-legend-colours.py` and `species-legend-fit.py` (`--mode`) re-measure them against a preview build.
- Limitation: circle size and count follow GBIF's cell size, which changes with tile zoom, so circles change size where Cesium draws two
  tile zooms side by side. At the equator in the 400×800 phone view, where GBIF zoom 2 meets zoom 1, the median circle width goes from
  11.5 px to 39.5 px (3.4×), an edge in density that the records do not have.
- "What lives here" searches a 32-vertex polygon (`geometry`), its gbif.org link carries the same polygon, because gbif.org ignores
  `geo_distance`, and the outline drawn on the globe has the same 32 vertices, so the card's count, the link and the outline describe one
  area. 32 comes from real-browser clicks on 2026-09-14, not from a documented limit: gbif.org opened area links of up to 1,253 characters
  to records and a 1,508-character 64-vertex link to 0 results or an error, for a reason not found in gbif-web's source or in replayed
  requests. At 32 vertices a 50 km circle gives a link of about 821 characters (850 at the longest coordinates), and a test keeps every
  radius under 1,000. A circle centred beyond ±85° latitude, or one that would cross ±180°, is searched with `geoDistance` instead, and its
  link carries only the licences and years.
- Datasets are credited by name, each linked to its DOI where GBIF has one and to its gbif.org dataset page otherwise, the user's choice on
  2026-09-14, because GBIF's data user agreement says "Users must publicly acknowledge ... the Data Publishers whose biodiversity data they
  have used, where appropriate through use of a Digital Object Identifier (DOI)". "What lives here" asks its one occurrence search for a
  second facet, `datasetKey` (5, with per-facet limits so species stay 20), and the SPECIES panel asks the taxon's top 3
  (`facet=datasetKey&datasetKey.facetLimit=3`) for the chosen years and licences, with `hasCoordinate=true` like the map tiles (GBIF's adhoc
  tiles add that filter and no geospatial-issue filter: the monarch z0 tile totalled 42,244 records, the search with hasCoordinate=true
  42,244, and with hasGeospatialIssue=false as well 42,240). A failed panel search shows inside the block, under its heading and above its
  gbif.org link, in a polite live region, with Retry, which keeps keyboard focus in the block. Each dataset is looked up at
  `/v1/dataset/{key}` (one pooled lookup per key for the session) and listed as its title linked to its DOI on doi.org, or to its gbif.org
  page, with its record count. The panel links the taxon's records on gbif.org with `taxonKey` and
  `checklistKey=d7dddbf4-2cf0-4f39-9b2a-bb099caae36c`, the GBIF Backbone Taxonomy. The app's taxon keys are Backbone keys, the default of
  the API and the map tiles, but since 2026-06-18 gbif.org reads taxon keys under Catalogue of Life XR unless a link names a checklist, and
  there a Backbone key matches no record: the link without the checklist opened to 0 results in a real browser, and with it to the monarch's
  42,244 records. qa-species compares each gbif.org link's API count with the count the app showed or used; only a click checks gbif.org's
  page itself. A dataset's licence is never shown: the iNaturalist Research-grade dataset is CC BY-NC while its CC BY records pass the
  record filter.
- The GBIF and iNaturalist terms pages answer scripts with 403, so their text was read from Internet Archive captures, which the user
  accepted on 2026-09-14. DATA_SOURCES.md quotes them with the capture timestamps.
- The SPECIES panel lists, in order, the search box, its suggestions, the status line, the chosen species with the map switch, WHAT LIVES
  HERE, the year and radius chips, the legend, the Top datasets and the credit. Its body scrolls under a fixed header. Below the body,
  inside the panel, a "more ↓" row of its own shows while more of the body is below and hides at the end, at every window size; its height
  is always laid out and only its visibility changes, so it never covers content (a fade and an overlaying hint before it both hid content).
  The Top datasets heading scrolls with its links. The left panel stack's natural height counts children hidden with `visibility` and the
  panel's bottom border; without them the body overflowed on tall windows, by the hidden row and by 1 px. On a 400x800 phone the left panel
  stack ends at half height, so the panel tightens its spacing to keep the action and both chip rows whole without scrolling, and at the end
  of the scroll every Top datasets link is whole with its focus ring. On a 375x667 phone the chip rows need a scroll (measured in
  qa-species).
- The details card sanitizes layer descriptions with DOMPurify. Only http, https and mailto links survive, and each opens in a new
  tab with `rel="noopener noreferrer"`.
- Only HTTP and network errors count as tile failures. GBIF answers an empty tile with 204, which Cesium reports as an error of
  its own.
- Dismissing the card cancels the search it was waiting for. The searched circle's outline shows exactly while the card shows
  that search's status or list.
