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
  already runs on 10 species), or `null` while not yet checked or when its tiles could not be fetched.
- Shown only when `iou >= species_iou_min` = **0.70**.
- A run with any `null` still writes the file, logs the count, and exits 3, so jobd shows it failed.

Cost, measured 2026-09-30: the 2,931 Arachnida species span 20,861 z3 tiles (median 4 a species, p90 18,
max 64); at ≤ 1 request/s that is about 8 h. The first estimate (3–4 h, from 10 species in run 4950) was low.
So the list names every species from its first write (`iou: null`, which the card reads as "couldn't be
checked this month", not "not in the model"), rewrites itself every 200 species, and a later run of the same
geomodel version checks only the species still `null`. A killed or timed-out run keeps its progress; a
collection too big for one month fills in over several. Groups that fail add nothing.

Each run downloads into its own directory under the work root and removes only that (`run_workdir`): the
monthly check and a listing can overlap, and the check used to remove the whole shared root.

### Skim first, then full (decided with the maintainer 2026-09-30)

iNaturalist's API docs (`api.inaturalist.org/v1/swagger.json`, read 2026-09-30): "we throttle API usage to a
max of 100 requests per minute, though we ask that you try to keep it to 60 requests per minute or lower, and
to keep under 10,000 requests per day". A full check of Arachnida is 20,861 tiles: two days at least. So:

- **Skim** (`--mode skim`): one tile per species, the z3 tile holding most of its tested range (about 2,900
  requests for Arachnida). Its IoU becomes the species' `iou` with `check: "skim"`, and `iou_skim` keeps it.
  It catches a served map that is mostly a different shape; it cannot settle a species near the 0.70 line.
- **Full** (`--mode full`, default): every tile, at most `--max-tiles` a run (9,000 a day), replacing skim
  scores with `check: "full"` and keeping `iou_skim`. Full checks are never redone or overwritten by a skim.
- The card shows a skim-checked species like any other, with "map spot-checked" in its note.
- Why it matters: of the first 400 Arachnida species fully checked, 5 scored below 0.2 (the served map is
  another shape: Cheiracanthium inclusum 0.03, Steatoda grossa 0.09, two very common spiders), 2 scored
  0.2–0.7, 13 scored 0.7–0.8, and 380 scored ≥ 0.8. Without a per-species check about 1 species in 70 would
  show a map that was not the one validated.

**Calibration gate, fixed before the run** (`--mode skim --include-full` records `iou_skim` beside a full
check without changing it). Sample: the 7 fully checked species below 0.70, the 13 in 0.70–0.80, and 100
drawn at random (seed 20260930) from the 380 at ≥ 0.80. The skim is used only if (1) all 5 species with a full
IoU below 0.2 skim below 0.70, and (2) at least 95 of the 100 skim at ≥ 0.70. If either fails, no skim scores
are shown and the list fills in by full checks only.

**Calibration result (job 5021, 2026-09-30 20:57 EDT): FAIL.** (2) passed, 100/100. (1) failed: only
Tetragnatha extensa (full 0.02) skimmed below 0.70 (0.30); Cheiracanthium inclusum 0.98, Steatoda grossa
0.99, Neomolgus littoralis 0.96 and Varroa destructor 0.91 all skimmed as agreeing. All five are ranges whose
bounds span the globe (-180 to 180, 1-4% of the box filled): the served map agrees where most of the range is
and differs elsewhere. So the one-tile skim is not used, as fixed above.

**What replaced it: full checks only, cheapest first.** Of the 400 fully checked, the 322 compact ranges had
1 failure (Nephila comorana 0.63, which the skim did flag) and the 78 globe-spanning ranges had 6. Skimming
only compact ranges fits that data, but it is a rule drawn from the data that failed the gate, resting on one
compact failure, so it is not used. Instead `--mode full` checks the cheapest species first (compact
Arachnida: 2,251 species, 9,889 tiles; globe-spanning: 280 species, 6,272 tiles, still to check on 09-30), so a
day's budget fully checks the most species. `pipeline/run_geomodel_full.sh` runs it daily: at most 8,000
tiles in any 24 h, counted from the list's `tile_log` (every run appends when and how many it asked, whatever
model version), so an early cron or a rerun asks nothing more; a lock refuses a second concurrent run (exit 75). The
monthly `run_geomodel_check.sh` writes only the verdicts. Arachnida: about 1,000 species more on 09-30 (2,500
tiles, to stay under the day's 10,000 with 4992's 4,700 and the 01:30 check), the rest by about 2026-10-03.

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
- `node scripts/qa-modeled-range.mjs` passes against the local preview (its own script: qa-species is one long
  flow, and these checks need request interception):
  an arachnid shows the switch; on, tiles come from api.inaturalist.org at z ≤ 3 and nothing else;
  the field is styled apart from records; the credit is present; a readout inside and outside reads as
  above; a bird shows "iNaturalist's range maps for birds failed our accuracy check"; a forced 429 shows the throttling line (not a blank);
  a new species resets the switch.
- A realistic pan/zoom session with the field on draws 0 HTTP 429 (Q4 flip check).
- `node scripts/qa-species.mjs` (all checks) still passes: the row adds to the SPECIES body, whose fold at
  667x375 has about 5 px to spare. The row therefore sits under WHAT LIVES HERE, not in the chosen-species
  block (inside it, the action fell below the fold; panel-fold, 2026-09-30).
- The maintainer looks at it and says.

## Constraints

- Static site: the browser fetches iNaturalist tiles directly; no new hosted tiles (Q4 (a)).
- No new npm or Python packages.
- Headless Chrome on the laptop: swiftshader only.
- QA waits on conditions, never fixed sleeps.
