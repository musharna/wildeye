# Amphibian and mammal richness from SEDAC via GIBS (2026-10-02)

Tier B data PR 1 of the bio-interpolation wave (grill `grill_wildeye_bio_interpolation_2026-09-29`, A25). Two NASA
GIBS layers, drawn straight from GIBS like the five GIBS layers already on the site (`src/data/gibsLayer.js`).

## Outcome

- Two layers: **Amphibian richness (IUCN 2013)** (`gibs-amphibians`, token `am`) and **Mammal richness (IUCN 2013)**
  (`gibs-mammals`, token `mm`). They use GIBS ids `Amphibian_Richness_All_Species_2013` and
  `Mammal_Richness_Grids_All_Species_2013` (Web Mercator, to level 7, palette PNG).
- A WHAT LIVES HERE click reads the count exactly: `🐸 Amphibian richness (IUCN 2013): 12 species · 2013`.
  A transparent pixel reads `no data here`: GIBS draws "No Species" and "No Data" both transparent, so a tile
  cannot tell zero species from no data, and the legend says so.
- The layers ignore the time bar: the data are one 2013 snapshot. GIBS serves them with no time dimension, at the
  URL date `default`, and labels every tile `layer-time-actual: 2899-12-31` (probe 2026-10-02). That placeholder
  is not shown as a date.

## Changes the real data forced (each with a test that fails on the old code)

1. `pipeline/gibs.py` `parse_colormap` picked the data colour map as "the one whose legend has more than one
   entry". SEDAC's No Data map has two ("No Species", "No Data"). The data map is the one with an opaque entry.
2. `_interval` read only `[lo,hi)`. SEDAC's entries are single counts, `[12]`; they decode to `lo = hi = 12`.
3. `formatValue` printed a bin's midpoint; an exact value (`lo === hi`) prints as itself, `12`, not `12.0`.
4. `gibsLayer.js`: a manifest entry with no served times is an undated layer. Its URL has no date segment
   (GIBS serves it at `/default/{TileMatrixSet}/…`). Its readout date is the entry's `asOf` (`2013`), written by
   `pipeline/gibs.py` from its `LAYERS` table.
5. GIBS's empty SEDAC tile in EPSG:3857 is an all-black palette PNG with no tRNS chunk (EPSG:4326's has one), so
   the colour map's transparent "No Data" black arrives opaque. `parse_colormap` writes `noData`: the colours the
   map only ever declares transparent. The readout reads an opaque pixel of such a colour as no data, and the
   layer keys black out (Cesium `colorToAlpha`) only when black is in `noData` and no data colour is within
   Cesium's threshold of it. GEDI draws black as data and EVI draws 0,0,1, so theirs stays.

## Licence (read live 2026-10-02, NASA CMR UseConstraints for both DOIs)

"Users are free to use, copy, distribute, transmit, and adapt the work for non-commercial purposes, without
restriction, as long as clear attribution of the source is provided and all distributions carry the same
share-alike provision." wildeye is a free, non-commercial app (DATA_SOURCES.md release policy). The browser loads
the tiles from GIBS; nothing is re-hosted or redistributed. The grids derive from IUCN 2013 ranges. Birds are
not in SEDAC's grids, and the IUCN terms bar redistributing derivative works, so tiles are never copied.

Citation, as registered at DataCite (read 2026-10-02): Center for International Earth Science Information
Network – CIESIN – Columbia University, and NatureServe. 2015. Gridded Species Distribution: Global Amphibian
Richness Grids, 2015 Release, doi:10.7927/H4RR1W66; Global Mammal Richness Grids, 2015 Release,
doi:10.7927/H4N014G5. NASA SEDAC. The ranges are the IUCN Red List's, downloaded April 2013. NASA CMR's citation
names IUCN and CIESIN as creators instead; the DOI registry's creators are used.

## Acceptance

- `npm test` and `pytest pipeline/tests/test_gibs.py` exit 0, each new test seen to fail first.
- `python3 -m pipeline.gibs` against live GIBS writes both entries with `times: []`, `asOf: "2013"` and a decode
  table of opaque counts.
- `node scripts/qa-gibs.mjs` (real browser, swiftshader) draws both layers and reads a known count. The
  Amazon (a few km from 3°S, 60°W) has dozens of amphibian species; the open ocean reads no data.

## Constraints

No change to the five existing GIBS entries in `gibs.json` except the new `noData` list (land cover [0,0,0], EVI
three, LST [64,64,64], none for GEDI and night lights): the regenerated file is compared for them. No
threatened-only variants (later, if wanted). No re-hosting. Share tokens `am` and `mm` are unused today.
