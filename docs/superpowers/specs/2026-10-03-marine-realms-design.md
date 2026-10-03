# Marine biogeographic realms (Costello et al. 2017) — design (2026-10-03)

Survey Tier B row "Marine Ecoregions/Pelagic Provinces" (`wildeye_global_bio_coverage_survey_2026-09-22.md`). MEOW was
the first pick and is parked: TNC's Data Basin copy is labelled CC BY-NC 3.0, but the authors' own metadata in the same
zip forbids "any … distribution … in whole or in part" without the MEOW Working Group's approval; PPOW is distributed
only under UNEP-WCMC's no-redistribution licence. The maintainer deferred asking TNC; these realms are the open
alternative. Decisions: grill `grill_wildeye_meow_2026-10-03` (delegated).

## Outcome

Switch on **Marine realms (Costello et al. 2017)**. The whole ocean, coast and open water, is filled by 30 biogeographic
realms derived from the distributions of 65,000 marine species (OBIS), each in its own colour; chips toggle the 8
top-level groups of the paper's Fig. 1. A WHAT LIVES HERE click at sea reads e.g. "Black Sea (realm 2) · 84% of its
species unique to it"; land reads nothing. Clicking a realm opens an info box with its group, species count, share of
unique species and area. Static: no time bar.

## Source (read 2026-10-03)

- figshare 10.17608/k6.auckland.5596840 v1, "GIS shape files of realm maps" (Mark Costello), licence CC BY 4.0 (API);
  `MarineRealmsShapeFile.zip`, 18,200,938 B, figshare md5 61402e9aa9c58d0c1a4afcc4146bb094 (matched on download). The
  shapefile's own metadata: "Free too use with proper citation". WGS84, 30 polygons, one integer field `Realm`.
- Names, groups, % unique species and species counts are not in the shapefile: they are read from Fig. 1 of the paper
  (Costello, Tsai, Wong, Cheung, Basher, Chaudhary 2017, Nature Communications 8:1057, doi:10.1038/s41467-017-01121-2,
  CrossRef-checked 2026-10-03) and tabled in `pipeline/marine_realms.py`. The text's own list (Black Sea 84%, Red Sea
  74%, Chile 68%, Inner Baltic 63%, South-East Pacific 59% = realms 2, 14, 25, 1, 10) matches the figure.
- Checked on the raw shapes: points in the Black Sea, Red Sea, Inner Baltic, Mediterranean, Gulf of Mexico, Gulf of
  California, Southern Ocean, Tasman Sea, Chile and Gulf of Guinea fall in the realm the figure numbers them; land points
  (Kansas, Sahara, Antarctica, Siberia) in none; the union is within 0.1% of the sum of areas (little overlap).
  Islands are not: Borneo, Madagascar, Sri Lanka, Britain, Honshu, Iceland, Cuba, New Zealand, Hawaii and Tasmania all
  fall inside a realm, so the pipeline removes land (below).

## Design

- **Pipeline** `pipeline/marine_realms.py`, run once: download the zip into the cache (md5-pinned, the pattern of
  `hfp.fetch_epoch`), read with pyshp, subtract Natural Earth 10 m land (`land.fetch_land_zip`, public domain, read
  with pyshp since geopandas is not in CI), attach the Fig. 1 table, simplify with `ecoregions.simplify_geometry`, area from the
  unsimplified sea (`gfw.geometry_area_km2`), one colour per realm, write `public/data/marine_realms.geojson`. Exactly
  30 realms or the run stops; over 5 MB or the run stops.
- **Layer** `src/data/marineRealms.js`: `ecoregions.js`'s polygon pattern (entities, fill alpha, info box, chips) with
  the 8 groups as chips, plus `readoutAt` by point-in-polygon (`mangroves.js` `pointInGeometry`). Share token `mr`. The info box reaches the
  screen through the details card (`BIO_CARD_LAYER_IDS`), since Cesium's own info box is off.

## Not in scope

MEOW/PPOW (parked, above); the paper's alternative analyses (hexagons, Sørensen, Infomaps); per-realm species lists.

## Acceptance

- `pytest pipeline/tests/test_marine_realms.py`, `node --test src/data/marineRealms.test.mjs` and `npm test` green; new
  tests seen to fail; mutants caught.
- Real file: 30 realms, every feature valid, ≤ 5 MB; each pre-registered sea point reads, on the simplified output, the
  realm it reads on the raw shapes; pre-registered land points, islands included, read none.
- `node scripts/qa-marine-realms.mjs --url <build>` in a real browser: readout at the pre-registered points equals the
  raw-shape realm and the paper's name and % unique; land reads nothing; group chips hide and show; info box; legend and
  credit; no console errors.
