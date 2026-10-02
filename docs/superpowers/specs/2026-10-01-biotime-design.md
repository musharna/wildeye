# Assemblage time series (BioTIME 2.0) — design (2026-10-01)

Step 5d of the bio-interpolation wave (grill `grill_wildeye_bio_interpolation_2026-09-29`: Q8 Tier A one PR each;
Q15 (a) and A1–A4 of step 5d, accepted `ok` 2026-10-01).

## Outcome

Switch on **Assemblage time series (BioTIME 2.0)**. Each openly licensed BioTIME study is a dot coloured by taxon
group (plants, invertebrates, fish, birds, mammals, amphibians, reptiles, fungi, multiple). On the time bar a study
shows in the years it was sampled and is faded, with the gap named, in the years between; outside its span it is
hidden. Clicking a study reads its title, organisms, realm and span, and for the shown year the raw count beside its
denominator, e.g. "1998: 212 taxa in 40 samples", with the study's own citation and licence. A study spanning more
than 10,000 km² is not one dot: it draws the locations it sampled in the shown year.

Counts are raw. More samples find more taxa, so the readout says so and never states or implies a trend; the
per-study change analysis (rarefaction) was rejected for this step (Q15 (c)).

## Source (probed 2026-10-01)

- Zenodo 15222193, BioTIME v2 issue of 2025-04-15 (record CC BY 4.0; the older 14514183 is the Dec-2024 issue).
  `biotime_v2_query_15April25.rds` (173,851,491 B) and `biotime_v2_metadata_15April25.csv`, both md5-pinned; a file
  whose md5 differs, cached or fetched, is refused. `references_biotime_v2_15April25.csv` gives each study's citation.
- The rds is one data frame: 11,989,233 records × 16 columns (STUDY_ID, YEAR, SAMPLE_DESC, LATITUDE, LONGITUDE,
  valid_name, ABUNDANCE, BIOMASS, …) over 708 studies, 553,253 distinct locations, 1874–2023. The median location
  was sampled in one year, so the time series live at study level.
- Each study carries its own licence as free text (`PERMISSIONS`, 70+ spellings). Kept: open-attribution (CC0,
  CC BY, PDDL, ODC-By, Open Government Licence, Licence Ouverte, public domain), 559 studies. Dropped: non-commercial
  (37), share-alike (ODbL, CC BY-SA: 70; their terms would bind the derived counts), unclear (blank, "Citation
  required", "Public": 42). Every distinct string is mapped in an explicit table; a string not in it fails the run.
- Cite Dornelas et al. 2025, BioTIME 2.0: expanding and improving a database of biodiversity time series, Global
  Ecology and Biogeography 34(5): e70003, doi:10.1111/geb.70003 (CrossRef-checked), and each study's own citation.

## Design

- **Extract** `pipeline/biotime_extract.R`: a lossless format step only. It reads the rds and writes the six needed
  columns (STUDY_ID, YEAR, SAMPLE_DESC, LATITUDE, LONGITUDE, valid_name) to a gzipped CSV. Every count and every
  decision is made in Python, under pytest.
- **Pipeline** `pipeline/biotime.py`, run once: fetch and check the pinned files, run the extract, classify licences,
  and for each kept study and year count distinct `valid_name` (taxa) and distinct `SAMPLE_DESC` (samples). Writes
  `public/data/biotime.json` (studies with id, title, organisms, taxon group, realm, centroid, area, licence,
  citation, link and per-year [taxa, samples]; the source; the dropped counts by reason) and, for wide studies,
  their per-year sampled locations rounded to 0.01°. No contact fields and no raw records are published.
- **Layer** `src/data/biotime.js`: the site-series contract (as OTN): a Cesium data source, `getObservedExtent` from
  the sampled years, `setObservedTime` picks the year; live shows every study at its latest sampled year. Chips per
  taxon group. Share token `bt`.

## Not in scope

Trends, rarefaction or any comparison across years; abundance and biomass values; share-alike, non-commercial or
unclear-licence studies; the raw records.

## Acceptance

- `pytest pipeline/tests/test_biotime.py` and `npm test` green; new tests seen to fail first; mutants caught.
- A real pipeline run (jobd) writes `biotime.json` for 559 studies; its size is reported.
- `node scripts/qa-biotime.mjs` against a local build exits 0: the layer draws; for three studies the readout's taxa
  and sample counts in a given year match an independent R count from the rds; a dropped non-commercial study is
  absent; every shown study's licence is open-attribution; a wide study draws locations, not a centroid; a year
  between sampled years reads the gap; no 404s; no page errors. Seen to fail on a mutant build.
- Perf gates equal, or a measured, explained acceptance.
