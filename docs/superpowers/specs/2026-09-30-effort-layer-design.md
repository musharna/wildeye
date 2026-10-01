# Recording effort in the species card — design (2026-09-30)

Step 3 of the bio-interpolation wave (grill: `grill_wildeye_bio_interpolation_2026-09-29`, Q5, Q8, Q9, A1–A4 of
step 3). Stacked on step 2 (`docs/superpowers/specs/2026-09-30-modeled-range-design.md`): same card, same files.

## Outcome

Pick a species in the SPECIES panel. Below WHAT LIVES HERE, a **RECORDING EFFORT** switch (off by default) draws
a grey veil from how often anyone recorded the species' **class** on GBIF (all arachnids for a spider, all birds
for a goose): darkest where nobody did, clearer the more they did, under the species' own records, which stay the
only colour on the map. Its note says how to read it and what it counts: "Darker = fewer records of spiders and
other arachnids, darkest = none · GBIF CC0/CC BY, 2017–2026". An empty patch on the species map can then be read
as "nobody looked" (dark) or "people looked and did not find it" (clear, no records).

Display (Q10, 2026-10-01, the maintainer's pick "d" of four): the first build drew purple-to-white hexagons, and
purple hexagons under orange circles read as two competing colour schemes. eBird Status and Trends greys out
where data are insufficient and keeps colour for the species; GBIF and iNaturalist show record density only. So:
one neutral grey whose opacity is the shortfall of effort.

Q9 (deferred to my pick): the species' class, not all life, because an all-life map is mostly "where people
are": on tile z2/1/1 (North Atlantic, last 10 years, CC0/CC BY) all records cover 52% of the tile with 25% of
it in GBIF's top colour class; arachnids cover 11% with 1% in the top class (birds: 42%, 27%). Target-group
effort (records of related taxa as the measure of where anyone looked) is the standard way species-distribution
work separates absence from no effort.

## Tiles

- `api.gbif.org/v2/map/occurrence/adhoc/{z}/{x}/{y}.mvt` (vector tile, unbinned) with `taxonKey=<classKey>`,
  the backbone `checklistKey`, `license=CC0_1_0&license=CC_BY_4_0`, the species map's year filter (LAST 10
  YEARS / ALL YEARS, following it when it changes), `srs=EPSG:3857`. `adhoc` because the precomputed `density`
  tiles ignore `license=` (gbif.js) and, probed 2026-09-30 with no taxon, came back as empty 1,096-byte tiles.
  A tile with no records answers 204 with no body.
- Counts, not pictures: each feature of the tile carries its record count (`total`). The veil sums them into
  16 × 16 even cells a tile (each feature in the cell holding the middle of its bounds; the tile's edge buffer
  holds clipped copies of the neighbours' cells and is left to them) and shades each cell by records per km²
  (cell area from its level and latitude, so the same ground keeps its shade as the view zooms): 0.72 opacity
  with none, 0.58 up to 1 record per 10,000 km², clear from 1 per km², log-linear between. Not GBIF's
  hexagons: `bin=hex` left places with 5 to 7,398 records empty (z3 x2 y3, arachnids, 2026-10-01; the vector
  tile's hexagons are missing there too, so it is the binning, not the drawing), and a veil read off drawn
  colours could not tell an empty hexagon from a dropped one.
- Tiles stop at level 7 (cells about 20 km at the equator); Cesium enlarges level 7 beyond. The decoders (`pbf`,
  `@mapbox/vector-tile`) load with the first tile, not with the app.
- Drawn under the species' records and the modeled range (z-rank 980 < 990 < 1000). Off means no layer at all,
  so a switched-off map asks GBIF for nothing.
- The class key comes from the species' GBIF record (`classKey`). A species with none gets no switch and the
  note "No effort map: GBIF lists no class for this species".
- The class is named in plain words where it is one of the geomodel collections' (`GROUP_PLAIN_NAMES`: birds,
  mammals, amphibians, insects, spiders and other arachnids, ray-finned fish); otherwise "class <GBIF name>".
- The first failing tile is said in the note ("effort map tiles failing: clear patches may be missing data"): an
  undrawn tile leaves its patch unveiled, which reads as well recorded.

## Not in scope

WHAT LIVES HERE readout of effort counts; share links (as ruling 4 of step 2); effort relative to the species
(ratio maps); any server-side or cached tiles.

## Acceptance

- `npm test` (unit: the tile URL, class naming, every note state, the switch, rebuild on year change, a new
  species switches it off; the veil from a real GBIF vector tile in `src/data/fixtures`, the cell areas, the
  shade per km²) and `pytest pipeline/tests` unchanged.
- `scripts/qa-effort.mjs` against a real build: off by default and no GBIF effort tile asked; on draws tiles that
  carry the class key, both licences and the year filter, all 200 or 204 with at least one 200; under the species
  records; read from a screenshot, the veil darkens unrecorded tundra (64° N 100° W) at least 20 points more than
  Washington, DC and leaves DC within 25%; the label fits its pill; switching ALL YEARS asks tiles without a
  year; picking a species of another class changes the key and switches it off; a species with no class shows no
  switch.
- `scripts/qa-species.mjs`, all checks (the row must not push WHAT LIVES HERE below the fold).
- The maintainer looks and says.
