# Camera traps and eDNA (GBIF) — design (2026-10-03)

Survey Tier B, the last item (`wildeye_global_bio_coverage_survey_2026-09-22.md:37`). Decisions: grill
`grill_wildeye_camera_trap_edna_2026-10-03` (delegated by the maintainer, "grilling deferred to you"; build on "build").

## Outcome

Two layers, each a 1° grid over the globe, shaded by how many GBIF records the method made there (one colour per
decade, as the OBIS grid):

- **Camera traps (GBIF)**, token `ct`: records whose sampling protocol names a camera trap.
- **eDNA (GBIF)**, token `dn`: animal records whose sampling protocol names environmental DNA.

A WHAT LIVES HERE click reads the cell: records, species, datasets and the three species recorded most, e.g. "1,204
records · 14 species · 3 datasets (Capreolus capreolus, Vulpes vulpes, Sus scrofa)"; a cell with none reads "no camera
trap records" / "no eDNA records". The legend says this is where the method was used and published to GBIF (survey
effort), not where animals are, and credits the GBIF download by its DOI. A fixed snapshot (its date shown): not on the
time bar.

## Source (probed 2026-10-03, live GBIF API, CC0 1.0 + CC BY 4.0 only)

- Camera traps carry no flag of their own. `basisOfRecord = MACHINE_OBSERVATION` (42.4 M) also holds acoustic and
  tracking records. The sampling protocol names the method, as free text, per record: among the 1,000 commonest values
  "camera trapping" 1,829,328, "camera trap" 1,528,330, "camera - surveillance/remote" 391,823, "observed-remote camera"
  221,879, "cameratrap" 67,885, "video taken using a remote camera" 21,490, "photo trap" 18,912.
- GBIF's DNA-derived extension does not mean eDNA: of its 27.9 M animal records, 20.3 M are iBOL specimen barcodes;
  bulk Malaise-trap metabarcoding follows. The extension's own fields (environmental medium and so on) are not in the
  SQL table (`/v1/occurrence/download/describe/sql`, 432 columns). Protocols that name eDNA are: "edna expeditions
  citizen science sampling" 2,649,854, "edna sampling from soil" 24,997, "edna sampling from rhizosphere soil" 14,712.
- Recent records are few (event date 2026-06-01 to 10-03: camera 3,453, DNA-derived 252), so the recent-sightings layer
  is not the place for them.
- GBIF SQL downloads (experimental, `SQL_TSV_ZIP`): GROUP BY runs on GBIF's side, so a download is the per-cell
  aggregate, not 4 M rows. Needs a GBIF account (`~/.config/gbif/credentials`, as `pipeline/gbif_derived.py`). Each
  download gets a DOI, which GBIF asks users to cite.

## Design

- **Methods** `pipeline/camera_traps.py` `METHODS`: a record is a camera-trap record when its lower-cased sampling
  protocol contains "camera trap", "cameratrap", "camera-trap", "camera - surveillance", "remote camera", "photo trap"
  or "trail camera"; an eDNA record when it contains "edna", "e-dna" or "environmental dna". Both are kept to kingdom
  Animalia (the eDNA protocols also carry microbes and plants). Camera wins when both match. A rule on the record's own protocol, not a list of datasets.
- **Download**: one SQL query, CC0 1.0 and CC BY 4.0 only, coordinates present and no geospatial issue, grouped by
  method, 1° cell (floor of lat/lon), dataset and species; submitted, polled and fetched by the pipeline, the zip kept in
  a staging directory named by the download key, so a rerun with `--download <key>` reads nothing new. A download with
  no records for a method (for both, on a `--bbox` check run) stops the run with nothing written: a filter that matches
  nothing is a broken query, not an empty world.
- **Aggregate**: per method and cell: records, distinct species, distinct datasets, top three species by records.
  Dataset titles and publishers from the GBIF dataset API, cached.
- **Outputs**, manifest last: `camera_traps.png` and `edna.png` (360 × 180 palette PNG, one pixel per cell, north up,
  transparent where none), `camera_traps_datasets.json`, `camera_traps.json` (date, download key and DOI, methods,
  palette, cells per method).
- **Layers** `src/data/gbifMethodGrid.js`: one factory, two layers, modelled on obisGrid.js (a
  `SingleTileImageryProvider` per image; the readout looks the cell up in the manifest).

## Not in scope

Wildlife Insights direct (declined earlier); images or media; the recent-sightings feed; microbial DNA; eDNA records
whose protocol does not say so (the extension's fields are not queryable); a monthly cron.

## Acceptance

- `pytest pipeline/tests/test_camera_traps.py`: method rule on planted protocols (each phrase in, look-alikes out,
  kingdom), aggregate on a planted TSV, PNG pixels, end-to-end with nothing written on a malformed or empty download.
  GBIF's own parse of the SQL is a manual check (`python -m pipeline.camera_traps --validate-only`), not a test.
- Real execution: a `--bbox` download and the full download through the pipeline; in the QA, each method's checked
  cell lies between two GBIF search API counts for the same licences and cell: the commonest exact protocol values (≤ ours)
  and no protocol filter (≥ ours).
- `node --test src/data/gbifMethodGrid.test.mjs` and `node scripts/qa-camera-traps.mjs --url <build>` in a real browser:
  the KORA and Norwegian-tundra datasets' busiest cells read their records; a mid-ocean cell reads none; an iBOL-only
  cell reads no eDNA; one drape; the time bar moved (probe extent) without a redraw; legend; no 404 or console errors.
