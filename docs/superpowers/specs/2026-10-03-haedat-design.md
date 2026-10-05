# Harmful algal events (HAEDAT) — design (2026-10-03)

Wave 2, item 4 (grill `grill_wildeye_wave2_2026-10-03`: the user said "all" to the survey-2 shortlist; decisions
below are assumed and open to veto).

## Outcome

Switch on **Harmful algal events (HAEDAT)**. Each position HAEDAT records events at is a dot coloured by the illness
most of its events were linked to (PSP, DSP, ASP, NSP, AZP, ciguatera, cyanobacterial toxins, aerosolised toxins,
other, none recorded). A position within 100 km of its events is a filled dot; a regional record (up to 985 km) is a
ring, so a dot in the open ocean or mid-country is not read as an event site. On the time bar the layer shows one
year's events; live shows every event, undated ones included. A click on a dot opens its counts, places, linked
illnesses, top causative taxa, record span and citation; WHAT LIVES HERE reads the events at every position whose
stated range covers the spot.

## Source (probed 2026-10-03)

- The HAEDAT Darwin Core Archive IOC publishes on the OBIS HAB IPT, resource `haedat`, version 3.35 of 2025-05-23
  (`ipt.iobis.org/hab/archive.do?r=haedat&v=3.35`, 14,341 events), pinned by version and sha256.
- Licence: CC BY 4.0, stated in the archive's eml.xml (checked on every run; a file without it is refused) and on the
  DataCite record of doi:10.25607/k68d5v (version 3.35, Provoost and Enevoldsen, read 2026-10-03). The eml's own
  citation points at 10.25607/0wdrmq, which DataCite lists as version 2.2.
- The live site's CSV export (haedat.iode.org) is newer (events into 2026), but we leave it out: its licence is
  unstated and it carries submitters' e-mail addresses. The info box links the live site for later events.
- Positions are HAEDAT's monitoring-grid points or regional centres, each with coordinateUncertaintyInMeters
  (10 km to 985 km). higherGeography is free text that can contradict the point ("California" at a Maine
  position), so the pipeline leaves it out.

## Decisions (assumed, veto any)

1. Source = the CC BY archive, not the newer CSV.
2. Form = one dot per position, coloured by the dominant linked illness; ring when the stated precision is wider
   than 100 km. An event linked to two illnesses counts under both.
3. On the time bar by calendar year (the archive's dates are often ranges or months; the leading four-digit year is
   used, from 1700 on). Live = every event, dated or not.
4. WHAT LIVES HERE reads positions within their stated range, or 25 km, whichever is wider. A spot with none says so
   as a statement ("no event recorded at a HAEDAT position whose range covers this spot"), not as missing data.
5. Undated events (36) count live only and are named in the legend; the 9 events placed off the globe (longitude
   -808.8684) are left off and listed by id in `haedat.json`.

## Design

- **Pipeline** `pipeline/haedat.py`, run once: fetch and check the pinned archive, read events, illness facts and
  causative occurrences, and write `public/data/haedat.json` (positions with lat, lon, uncertaintyKm, countries,
  top three places, top five causative taxa, per-year and undated counts by illness; the undated and off-globe ids;
  the source with its rights text). Contacts, remarks and higherGeography are left out.
- **Layer** `src/data/haedat.js`: a Cesium data source, `getObservedExtent` from the dated years,
  `setObservedTime` picks the year, `readoutAt` for WHAT LIVES HERE, entity descriptions through the details card.
  Share token `ha`.

## Out of scope

Events after archive 3.35; the live CSV; toxin concentrations or bloom extents; any trend across years (reporting
effort varies by country and decade).

## Acceptance

- `pytest pipeline/tests/test_haedat.py` and `npm test` green; new tests seen to fail first; mutants caught.
- A real pipeline run writes `haedat.json`: 14,332 events at 1,828 positions, 36 undated, 1770–2025; size reported.
- `node scripts/qa-haedat.mjs --url <local dev server>` exits 0: the drawn positions and their counts equal an
  independent parse of the raw archive in the QA script; known positions read right in WHAT LIVES HERE live and in
  a scrubbed year; rings and dots follow the stated precision; the details card opens; no page errors. Seen to
  fail on mutant builds.
- Perf gate equal, or a measured, explained acceptance.
