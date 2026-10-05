# Intact forest landscapes 2000–2025 — design

Wave 2, item 5 of 8 (ledger `grill_wildeye_wave2_2026-10-03.md`; decisions assumed, open to veto).

## Outcome

A layer **Intact forest landscapes 2000–2025** (🌲, token `if`): one drape of the five IFL editions, each place
coloured by the last edition it was intact in:

| class | colour | meaning |
|---|---|---|
| 1 | yellow | intact in 2000, not by 2013 |
| 2 | orange | intact in 2013, not by 2016 |
| 3 | red | intact in 2016, not by 2020 |
| 4 | dark red | intact in 2020, not by 2025 |
| 5 | green | intact forest landscape in 2025 |

The classes follow Figure 2 of the data description (2025 extent and the reduction by period); the colours are ours. A WHAT LIVES HERE click names the class at the point, or says
"not an intact forest landscape in any edition, 2000–2025". It is a fixed map, so it is not on the time bar.

## Source

- **Files:** The IFL Mapping Team, `https://intactforests.org/shp/IFL_<year>.gpkg` for 2000, 2013, 2016, 2020 and 2025
  (Last-Modified 2025-11-11 to 2025-11-28; 282–344 MB each). The sha256 of each is pinned in `pipeline/ifl.py`.
- **Licence:** CC BY 4.0, read live on `intactforests.org/data.ifl.html` 2026-10-04. Credit the source and explain
  changes; the credit line states the simplification, the ~610 m tiles and the colouring.
- **Cite:** Potapov et al. 2017, Science Advances 3:e1600821, doi:10.1126/sciadv.1600821 (CrossRef: Potapov, 2017).
- **Definition** (intactforests.org/concept.html): at least 500 km² and 10 km wide, within today's forest zone,
  minimally influenced by human economic activity.

## Pipeline (`pipeline/ifl.py`)

1. **Fetch:** each edition once into the cache. A download whose sha256 is not the pinned one is refused and deleted.
   A cached file that no longer matches is refused with "delete it to fetch again".
2. **Read:** sqlite3, no GDAL. The layout is checked before any row is read:
   - `gpkg_contents` is exactly one EPSG:4326 feature table `IFL_<year>`
   - the geometry column is `geom` MULTIPOLYGON 4326
   - the columns are `fid, geom, IFL_ID, Area<year>`

   Geometry blobs are parsed per the GeoPackage standard (envelope codes 0–4; extended geometries refused).
3. **Burn:** polygons simplified by 0.001° (a fifth of a pixel), then rasterised edition by edition, in year order,
   onto 16 × 16-tile blocks at level 7 (256 × 128 tiles, 0.0055°, ~610 m). A pixel whose centre a polygon covers takes
   that edition's index, so it ends as the last edition covering it.
4. **Areas:** each edition's burned km² (exact spherical row areas) and the part of it the edition before did not cover.
5. **Pyramid:** coarser levels take the most common non-empty class of each 2 × 2, ties to the more recent.
6. **Write:** 8-bit palette PNGs (the readout's decoder reads 8-bit only), painted tiles only, listed per level in `ifl.json`. The manifest also carries the classes,
   the editions (patches, stated hectares, burned km², new ground) and the source.

**Real run (2026-10-04):**

| edition | patches | stated Mha | burned / stated | km² not in previous |
|---|---|---|---|---|
| 2000 | 2,221 | 1,280.9 | 1.0004 | 0 |
| 2013 | 2,138 | 1,189.3 | 1.0004 | 1,785 |
| 2016 | 2,097 | 1,161.4 | 1.0005 | 1,475 |
| 2020 | 2,053 | 1,126.2 | 1.0005 | 1,649 |
| 2025 | 2,014 | 1,086.2 | 1.0006 | 1,822 |

The stated areas give 2000→2025 a decline of 194.7 Mha (15.2%), the figure in the data description's section 3.2.
3,439 tiles (2,160 at level 7), 7.3 MB.

## Defects and limits

- **Editions are not strictly nested.** Each is mapped anew, so 6,731 km² of later editions lie outside the edition
  before (0.06% of 2025's area). That ground shows as the later edition. The legend states the total, and the
  manifest has it per edition.
- **Small slivers vanish.** A sliver narrower than a pixel (~610 m) can drop out at level 7, and coarser levels show
  only the majority class.
- **Ground never intact is unpainted.** Ground outside every edition is transparent: the layer does not separate
  "forest that was never intact" from "not forest". The forest-zone file is left out.

## Frontend (`src/data/ifl.js`)

- `listedTilesOnly` from the protected-areas layer serves unlisted tiles as blank, with no request.
- The readout decodes the level-7 pixel through `geoTilePixel` and `createTilePixelReader`. An unlisted tile answers
  "none" without a read. An odd colour or a failed read is an error row.
- The build time (`generated_at`) is a query string on tile URLs, for both the drape and the readout.

## Acceptance

- `pytest pipeline/tests/test_ifl.py` runs on verbatim fixture GeoPackages: four real patches and five editions,
  covering all five classes. Expected classes come from shapely on the unsimplified polygons.
- `node --test src/data/ifl.test.mjs`
- `node scripts/qa-ifl.mjs --url <dev server>` against the real build. The independent source is the pinned
  GeoPackages, re-read with sqlite3 and shapely in a Python helper.
- Mutants via `mutate-run` for the pipeline, the module and the QA wiring.
- `npm run perf:load` EQUAL.

## Constraints

- No other layer changes.
- `public/data/ifl/` and `ifl.json` are gitignored generated data, copied in before a deploy (one-shot pipeline, no cron).
