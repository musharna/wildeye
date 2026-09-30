# Modeled range in the species card — design (2026-09-30)

Step 2 of the bio-interpolation wave (grill: `grill_wildeye_bio_interpolation_2026-09-29`, Q4, Q6, Q7, A11,
A12, A18, A19). Gated by step 1 (`docs/superpowers/specs/2026-09-29-geomodel-harness-design.md`).

## Outcome

Pick a species in the SPECIES panel. If its iNaturalist geomodel collection passed the latest monthly check
and its tiles match the range that was tested, the card offers an opt-in "Modeled range" switch (off by
default). On, iNaturalist's thresholded geomodel range is drawn as a soft tinted field under the species'
records, credited "Modeled range: iNaturalist Geomodel, CC BY 4.0". A WHAT LIVES HERE click inside it reads
"Inside modeled range — expected nearby", outside it "Outside modeled range", each with "iNaturalist Geomodel ·
<group> passed validation <Month YYYY>". Every other species gets one line saying why there is no switch.

## Pipeline: the per-species list

`pipeline/geomodel_species.py` reads the verdicts file and writes `public/data/geomodel_species.json`. The
monthly `pipeline/run_geomodel_check.sh` runs it after the check succeeds, so a failure here never loses
verdicts, and it can be rerun alone:

- `generated_at`, `geomodel_version`, `verdicts_generated_at`, `species_iou_min`.
- `groups`: every collection's `verdict` and GBIF `include` / `exclude` keys (from `GROUPS`), so the browser
  can place a species in its collection from GBIF's classification.
- `species`: for every species in every `pass` collection, keyed by scientific name:
  `{id: <iNaturalist taxon id>, group, iou}`, where `iou` is `tile_agreement()` at z3 (the check the harness
  already runs on 10 species), or `null` when its tiles could not be fetched.
- Shown only when `iou >= species_iou_min` = **0.70**.
- A run with any `null` still writes the file, logs the count, and exits 3, so jobd shows it failed.

Cost: all 2,931 Arachnida species at ≤ 1 tile request/s, about 3–4 h on top of the check (run 4950 logged
1.5–7 s a species). Groups that fail add nothing.

## Browser

- `src/data/modeledRange.js`: loads the list lazily (first species pick), and places a chosen GBIF taxon
  (`/v1/species/{key}`: canonical name, kingdom/phylum/class/order/family/genus keys) in one state:
  `shown`, `tiles-disagree` (IoU below the floor), `unchecked` (IoU null), `group-failed`,
  `group-insufficient`, `not-in-model` (no collection, or a passing collection without this name),
  `not-species` (rank above species), `no-list` (file missing or unreadable: said, never blank).
- The layer: `UrlTemplateImageryProvider` on
  `https://api.inaturalist.org/v2/geomodel/{id}/{z}/{x}/{y}.png?thresholded=true`, 512 px tiles,
  `maximumLevel: 3`, stacked at zrank 990 (under the species records at 1000; observations as entities are
  above all imagery), layer alpha 0.45. Not a drape: it does not switch other drapes off.
- Requests to api.inaturalist.org are capped at 2 in flight (Cesium `RequestScheduler.requestsByServer`).
- An HTTP 429 from a tile sets the card error "iNaturalist is limiting map requests — try again in a
  minute", at once, not after the 8-failure limit other errors use.
- Readout: the switch's layer joins `readGibsLayers` in `src/main.js`; `readoutAt(lat, lon)` reads one pixel
  of the z3 tile (existing `createTilePixelReader`); alpha > 0 is inside.
- The switch resets to off on every new species.
- Credit in `DATA_CREDITS` and `DATA_SOURCES.md`.

## Rulings (new since the grill; made 2026-09-30 by the implementer, open to the maintainer's veto)

1. **Per-species check = the harness's own tile IoU, run for every species in a passing collection,
   floor 0.70.** The 2026-09-30 ruling required a per-species check before a tile range is shown. The
   browser has no GeoPackage to compare with, so the pipeline precomputes it. Known values: 15 of 20 random
   birds ≥ 0.85, the other 5 at 0.80–0.83 (coarse z3 rasters of small ranges), Anser cygnoides 0.03,
   Stemonitis fusca 0.14. 0.70 sits clear of both clusters. Fixed before the first per-species run.
2. **Thresholded tiles only; the readout is in/out.** What was tested is the thresholded range. Continuous
   tiles would need an alpha→value mapping the harness has not proven (grill Q7: "numbers only if proven").
   Outside the field reads "Outside modeled range", not "none here": absence of a model range is not an
   absence of the species (A19 intent).
3. **Match by scientific name** between GBIF's canonical name and the GeoPackage name. A synonym that
   differs reads `not-in-model`, which says so; no guessing.
4. **Modeled-range state is not in share links** (the species itself is). Out of scope for this step.

## Acceptance

- `pytest pipeline/tests` and `npm test` exit 0; pipeline tests use fake sources (seen to fail first).
- A real per-species run for Arachnida writes `geomodel_species.json`; Anser cygnoides (in a failing
  collection) and a planted disagreeing species are not shown.
- `node scripts/qa-species.mjs --checks modeled-range` passes against the local preview:
  an arachnid shows the switch; on, tiles come from api.inaturalist.org at z ≤ 3 and nothing else;
  the field is styled apart from records; the credit is present; a readout inside and outside reads as
  above; a bird shows "Aves failed validation"; a forced 429 shows the throttling line (not a blank);
  a new species resets the switch.
- A realistic pan/zoom session with the field on draws 0 HTTP 429 (Q4 flip check).
- The maintainer looks at it and says.

## Constraints

- Static site: the browser fetches iNaturalist tiles directly; no new hosted tiles (Q4 (a)).
- No new npm or Python packages.
- Headless Chrome on the laptop: swiftshader only.
- QA waits on conditions, never fixed sleeps.
