# Marine records (OBIS grid) — design (2026-10-02)

Survey Tier B item after SEDAC (grill `grill_wildeye_bio_interpolation_2026-09-29` A21/Q8). Decisions: grill
`grill_wildeye_obis_grid_2026-10-02` (delegated by the maintainer, "grill deferred to you"; build on "build").

## Outcome

Switch on **Marine records (OBIS)**. Every 1° cell of the globe where OBIS holds a record from a CC0 or CC BY dataset is
shaded by how many records it holds, one colour per decade (1–9 up to a million and more), so well-surveyed water reads
apart from water nobody has recorded, without first mapping a species. A WHAT LIVES HERE click reads the cell: records,
species, datasets and the years they span; a cell with none reads "no records". The legend says what share of OBIS the
layer shows. A fixed snapshot (its date shown): not on the time bar.

It is not a richness map: records and species both track how hard a cell was looked at, so the species count is a
number on the readout, not the colour.

## Source (probed 2026-10-02)

- OBIS's grid API (`api.obis.org/v3/occurrence/grid/{precision}`) answers 200 with CORS open, but has no licence filter
  (the v3 OpenAPI has none) and carries only a record count. OBIS's licences are per dataset, as free text
  (`/v3/dataset` `intellectualrights`; the record-level `license` is mostly empty): of 6,938 datasets and 237,952,140
  records, CC0 1.0 holds 21.1% of records, CC BY 4.0 56.8%, everything else 22.2% (non-commercial, share-alike,
  no-derivatives, other open licences, restricted or unnamed). 580 datasets say "Attribution Non Commercial (CC-BY)":
  read as non-commercial.
- OBIS's open-data export: one parquet file per dataset, `s3://obis-open-data/occurrence/<dataset id>.parquet` (7,117
  files, 96.66 GB). Columns used: `dataset_id`, `dropped`, `absence`, `interpreted.decimalLatitude`,
  `interpreted.decimalLongitude`, `interpreted.speciesid`, `interpreted.date_year`. DuckDB reads only those over HTTPS
  (a 1.96 M-record dataset in 4–7 s).
- Cite "OBIS (2026) Ocean Biodiversity Information System. Intergovernmental Oceanographic Commission of UNESCO.
  www.obis.org" with the datasets listed (manual.obis.org/policy), as the occurrences layer does.

## Design

- **Licence** `pipeline/obis_licences.py`: every distinct `intellectualrights` text (44 after collapsing whitespace) read
  and classed by hand into CC0, CC BY or out; only unambiguous CC0 and plain CC BY count, the bar of the occurrences
  layer and the effort veil. A text not in the table stops the run: a new wording is read before it reaches the map.
- **Pipeline** `pipeline/obis_grid.py`: list the datasets (licence classed) and the export's files (with ETags); for
  each CC0 / CC BY dataset, DuckDB writes its records per (1° cell, species) to a local staging file named by the
  file's ETag, so a rerun reads only datasets that changed and an interrupted run resumes; then one query sums the
  staging files per cell. Records OBIS flags `dropped` or `absence` are left out, as its API does by default. Cell =
  floor of lat/lon (south-west corner), 90°N and 180°E folded into the last cell. Outputs, the manifest last:
  `obis_grid_datasets.json` (every dataset drawn: id, title, licence, records), `obis_grid.png` (360 × 180 palette
  PNG, one pixel per cell, north up, ColorBrewer RdPu in 7 decade classes, transparent where no records) and
  `obis_grid.json` (date, share, palette, cells `[lat, lon, records, species, datasets, first_year, last_year]`).
- **Layer** `src/data/obisGrid.js`, token `ob`, modelled on wetlands.js: the PNG as one `SingleTileImageryProvider`
  over the globe (each 1° cell exactly one pixel; no tile pyramid), one drape at a time; the readout looks the cell up
  in the manifest, not the image.

## Not in scope

Non-commercial datasets; a richness surface or rarefaction (the interpolation grill); a time filter; a monthly cron
(after the first real build is measured); the occurrences layer's record-level licence filter (it likely drops CC0 /
CC BY OBIS records whose `license` is empty: a separate fix).

## Acceptance

- `pytest pipeline/tests/test_obis_grid.py`: licence table, staging and cell sums on planted records, PNG pixels,
  end-to-end with a dataset out on licence and an unclassed text that writes nothing.
- Real execution: per-dataset totals and per-cell counts for at least 3 datasets equal OBIS's own API
  (`/v3/occurrence?datasetid=…&geometry=<cell>`); a non-commercial dataset in the same run is not drawn.
- `npm test` (layer unit tests) and `node scripts/qa-obis-grid.mjs --url <build>` in a real browser.
