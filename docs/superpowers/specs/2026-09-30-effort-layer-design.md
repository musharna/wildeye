# Recording effort in the species card — design (2026-09-30)

Step 3 of the bio-interpolation wave (grill: `grill_wildeye_bio_interpolation_2026-09-29`, Q5, Q8, Q9, A1–A4 of
step 3). Stacked on step 2 (`docs/superpowers/specs/2026-09-30-modeled-range-design.md`): same card, same files.

## Outcome

Pick a species in the SPECIES panel. Below WHAT LIVES HERE, a **RECORDING EFFORT** switch (off by default) draws
where anyone recorded the species' **class** on GBIF (all arachnids for a spider, all birds for a goose), as
purple-to-white hexagons under the species' own records. Its note says what it counts and from where:
"Where anyone recorded spiders and other arachnids · GBIF CC0/CC BY, 2017–2026 · purple few, white many". An
empty patch on the species map can then be read as "nobody looked" (no hexagons) or "people looked and did not
find it" (hexagons, no records).

Q9 (deferred to my pick): the species' class, not all life, because an all-life map is mostly "where people
are": on tile z2/1/1 (North Atlantic, last 10 years, CC0/CC BY) all records cover 52% of the tile with 25% of
it in GBIF's top colour class; arachnids cover 11% with 1% in the top class (birds: 42%, 27%). Target-group
effort (records of related taxa as the measure of where anyone looked) is the standard way species-distribution
work separates absence from no effort.

## Tiles

- `api.gbif.org/v2/map/occurrence/adhoc/{z}/{x}/{y}@1x.png` with `taxonKey=<classKey>`, the backbone
  `checklistKey`, `license=CC0_1_0&license=CC_BY_4_0`, the species map's year filter (LAST 10 YEARS / ALL
  YEARS, following it when it changes), `srs=EPSG:3857`, `bin=hex`, `hexPerTile=60`, `style=purpleWhite.poly`.
  `adhoc` because the precomputed `density` tiles ignore `license=` (gbif.js) and, probed 2026-09-30 with no
  taxon, came back as empty 1,096-byte tiles. adhoc with a class answered 200 in 0.7–4.5 s a tile.
- Style: purpleWhite over the Esri imagery stays readable over forest, desert and sea; green vanished into
  vegetation, iNaturalist's red clashed with the species circles drawn on top, purpleYellow went muddy
  (composited at the tile's real alpha over the World Imagery tile, 2026-09-30).
- Drawn under the species' records and the modeled range (z-rank 980 < 990 < 1000). Off means no layer at all,
  so a switched-off map asks GBIF for nothing.
- The class key comes from the species' GBIF record (`classKey`). A species with none gets no switch and the
  note "No effort map: GBIF lists no class for this species".
- The class is named in plain words where it is one of the geomodel collections' (`GROUP_PLAIN_NAMES`: birds,
  mammals, amphibians, insects, spiders and other arachnids, ray-finned fish); otherwise "class <GBIF name>".
- Failing tiles say so in the note ("map tiles failing", after `TILE_FAILURE_LIMIT`), never a quiet blank.

## Not in scope

WHAT LIVES HERE readout of effort counts; share links (as ruling 4 of step 2); effort relative to the species
(ratio maps); any server-side or cached tiles.

## Acceptance

- `npm test` (unit: the tile URL, class naming, every note state, the switch, rebuild on year change, a new
  species switches it off) and `pytest pipeline/tests` unchanged.
- `scripts/qa-effort.mjs` against a real build: off by default and no GBIF effort tile asked; on draws tiles that
  carry the class key, both licences and the year filter, all 200; under the species records; the label fits
  its pill; switching ALL YEARS asks tiles without a year; picking a species of another class changes the key
  and switches it off; a species with no class shows no switch; one picture framed on the hexagons.
- `scripts/qa-species.mjs`, all checks (the row must not push WHAT LIVES HERE below the fold).
- The maintainer looks and says.
