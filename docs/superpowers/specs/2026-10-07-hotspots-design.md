# Biodiversity hotspots (Conservation International, version 2016.1) — design (2026-10-07)

Decisions: the maintainer's brief of 2026-10-07 (route = the marine realms pattern; areas filled, outer limits outline
only; CC BY-SA 4.0 share-alike; land premise check before any UI; exactly 36 hotspots). KBAs, CEPF ecosystem profiles
and other priority maps are out of scope.

## Outcome

Switch on **Biodiversity hotspots (CI 2016.1)**. The 36 biodiversity hotspots are drawn on land, each filled in its own
translucent colour with an outline. For the 17 hotspots made of scattered islands or patches, a dashed line in the
hotspot's colour marks the **outer limit**, which the source metadata defines as the line that groups a hotspot's
islands and patches into one unit for display; it is not part of the hotspot. A WHAT LIVES HERE click reads
"Sundaland biodiversity hotspot · 1,501,000 km²" inside a hotspot, "Inside the outer limit of Wallacea: not part of
the hotspot itself (the line groups its islands)" between the islands, and "Not in a biodiversity hotspot" elsewhere.
Clicking a hotspot opens a card with its name, area, the two criteria, the share-alike licence and the note that an
IUCN-led re-evaluation of the hotspots is under way. Static: no time bar.

## Source (read 2026-10-07)

- Zenodo record 3261807 (concept 3261806), "Biodiversity Hotspots (version 2016.1)", published 2016-04-25, deposited
  2019-09-09; creators Hoffman, Koenig (Conservation International), Bunting (BirdLife), Costanza (NC State), Williams
  (CSIRO). Licence field `cc-by-sa-4.0` (API, read live 2026-10-07). One file `hotspots_2016_1.zip`, 14,215,303 B,
  md5 `c47d115deb7a139174af3c32ed5edf68` (pinned).
- The zip's README (dated 2018-04-23): "This dataset is available under the Creative Commons Attribution-ShareAlike 4.0
  International (CC BY-SA 4.0)". The older `hotspots_2016_1.shp.xml` (synced 2015-08-03) still carries CI's 2012
  terms of use (no modification; a supplementary licence for distribution over the Internet). The later README and
  the Zenodo record, deposited by CI's own authors, are read as superseding them; the maintainer rules on this before
  merge (PR body).
- Shapefile `hotspots_2016_1.shp`, WGS 84 (`.prj` GCS_WGS_1984), 53 rows, fields `NAME`, `Type`: 36 `hotspot area`
  rows (36 distinct names) and 17 `outer limit` rows. Bounds 57.2° S – 47.3° N, ±180°. North American Coastal Plain is
  invalid as given (repaired with make_valid); New Zealand and Polynesia-Micronesia cross the antimeridian.
- `outer_limit` in the metadata: "Polygon that forms the limits of lines that group together islands and/or other
  patches of land that are part of a hotspot to form a single logical unit. The outer limit is not part of the hotspot
  itself but is used for display purposes and to form a grouping of regions that define the hotspot."
- Criteria (Zenodo text and metadata): at least 1,500 endemic vascular plant species, and at least 70% of the primary
  native vegetation lost. Citations: Myers, Mittermeier, Mittermeier, da Fonseca & Kent 2000, Nature 403:853–858,
  doi:10.1038/35002501; Mittermeier, Turner, Larsen, Brooks & Gascon 2011, in Biodiversity Hotspots (Springer) pp.
  3–22, doi:10.1007/978-3-642-20992-5_1 (both CrossRef-checked 2026-10-07: first author and year).
- No newer boundary file: an IUCN-led two-year re-evaluation of the hotspots was announced in October 2025 (Newcastle
  University press release of 13 October 2025, read 2026-10-07: "There are currently 36 terrestrial hotspots, which
  cover 16.7% of Earth's land surface").

## Premise check (null arm, run before the layer)

Hotspot areas must sit on land. Share of hotspot-area area (geodesic km², unsimplified, valid shapes) on Natural Earth
10 m land (`land.fetch_land_zip`, sha256-pinned), measured 2026-10-07: **99.43%** at no shift; **83.29%** shifted 1° E
and 1° N; 77.16% shifted 1° W and 1° S; 93.25% shifted 0.25° E and N. No shift is clearly best, so the layer was built.
The pipeline repeats the no-shift and 1° E / 1° N arms on every run and stops unless no shift is ≥ 95% and at least 5
points above the shifted arm.

## Design

- **Pipeline** `pipeline/hotspots.py`, run once: download the zip into the cache (`$WILDEYE_CACHE/hotspots`,
  md5-pinned and refused otherwise, as `marine_realms.fetch`), read with pyshp, stop on any `Type` other than the two,
  on anything but exactly the 36 named hotspot areas once each, or on an outer limit that is not one of the 36 or
  appears twice. Repair, simplify with `ecoregions.simplify_geometry` at **0.02°**, dropping parts and holes under
  **0.0005 deg²** (about 6 km² at the equator; the largest part always kept), cut parts wider than 90° into strips
  (`marine_realms.split_wide`), area in km² from the unsimplified area shapes (`gfw.geometry_area_km2`), one colour per
  hotspot (golden-angle hues, two lightness steps), land premise gate, write `public/data/hotspots.geojson` under the
  same CC BY-SA 4.0. Over 3 MB, nothing is written.
- **Layer** `src/data/hotspots.js`: the marine realms polygon pattern without chips. Areas: translucent fill and
  outline per polygon part. Outer limits: dashed polylines (rhumb lines, the shapefile's straight lon/lat edges) in the
  hotspot's colour. `readoutAt` by point-in-polygon (`mangroves.js` `pointInGeometry`) on the published shapes; the
  info box reaches the screen through the details card (`BIO_CARD_LAYER_IDS`). Share token `hs`.

## Constraints

- Generated data stays out of git (`.gitignore`); no change to other layers' files or tokens; the registry count goes
  from 67 to 68.
- Output ≤ 3 MB; areas are from the unsimplified shapes. The readout reads the simplified shapes: a point farther than
  the tolerance plus the 0.001° grid from every raw boundary reads what the raw shapes say, except on islets under the
  dropped-part threshold, which read as outer limit or nothing.

## Acceptance

- `pytest pipeline/tests/test_hotspots.py` (through CI's `uv run` command), `node --test src/data/hotspots.test.mjs`
  and `npm test` green; every new test seen to fail for its stated reason; `mutate-run` mutants killed or justified.
- Real run on the cached zip: 36 areas + 17 outer limits, every part valid, ≤ 3 MB, premise gate passed.
- `scripts/qa_hotspots_truth.py` reads the raw shapefile with pyogrio + shapely (not `pipeline/hotspots.py`) and fixes
  the known answer at pre-registered points: centres, points 0.05° inside and outside hotspot edges, outer-limit-only
  points between islands, points outside everything, and either side of the antimeridian.
- `node scripts/qa-hotspots.mjs --url <local build>` in a real browser: readout at every truth point equals the truth
  script's answer; render picks hit the hotspot named; info box; legend and credit; share token; no console errors.
