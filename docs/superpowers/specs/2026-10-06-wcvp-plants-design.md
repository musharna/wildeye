# Native vascular plants per TDWG botanical country (WCVP 16.0) — design (2026-10-06)

Wave 3 of the global bio survey. Decisions: grill `grill_wildeye_wave3_2026-10-06`, decision 3 (delegated).

## Outcome

Switch on **Native plants (WCVP, botanical countries)**. The 369 Level-3 units of the TDWG World Geographical Scheme for
Recording Plant Distributions (WGSRPD) are filled by how many accepted vascular plant species are native there, from 2
(South Sandwich Is.) to 25,490 (Colombia), on 8 half-decade (log) viridis bins; Bouvet I., with none recorded, is
grey. A WHAT LIVES HERE click reads e.g. "Colombia · 25,490 native vascular plant species (7,935 endemic, 701
introduced)"; outside every unit it reads "Not in a botanical country". Clicking a unit opens an info box with the
three counts, the unit's area, the definitions and the credits. The legend says larger units hold more species.
Static: no time bar, no cron (WCVP is republished about yearly; a new release is a new build).

## Sources (read 2026-10-06)

- **WCVP** Darwin Core archive `https://sftp.kew.org/pub/data-repositories/WCVP/wcvp_dwca.zip`, 88,208,088 B,
  Last-Modified 2026-06-04, md5 `76dba53d4a7606923a5b70437fe7d7c8` (pinned; Kew publishes none). `eml.xml`: version
  16.0, intellectualRights CC BY 3.0 Unported; `meta.xml`: distribution licence default CC BY 3.0, rights holder The
  Trustees of the Royal Botanic Gardens, Kew. The eml citation's DOI 10.34885/egs6-cp24 answers 404 at doi.org, so the
  layer cites Govaerts et al. 2021, Scientific Data 8:215, doi:10.1038/s41597-021-00997-6 (CrossRef and Zotero checked).
- `meta.xml` maps columns by index to Darwin Core terms. Core `wcvp_taxon.csv` (1,448,984 rows): taxonID 0, taxonRank
  7, taxonomicStatus 8. Extension `wcvp_distribution.csv` (1,995,338 rows): coreid 0, locality 1, establishmentMeans
  2, locationID 3, occurrenceStatus 4, threatStatus 5. `|`-separated, no quoting, one header row whose names are not
  trusted (it spells `scientfiicname`).
- Vocabularies, every row: establishmentMeans {"", introduced}; occurrenceStatus {"", Doubtful}; threatStatus {"",
  Extinct}. locationID is `TDWG:` + a Level-3 code (368 distinct) or a Level-1/2 number (41 distinct, 1,309 rows;
  204 of them on accepted species).
- **WGSRPD Level 3** `geojson/level3.geojson` from github tdwg/wgsrpd at commit 52da782 (md5
  `021533df6348ba7c81fe0c1bb5ef34fb`): 369 features, `LEVEL3_COD`, `LEVEL3_NAM`, `LEVEL2_COD`, `LEVEL1_COD`; 44,549
  vertices, 19 invalid; antimeridian units already split at ±180°. The repo has no licence file; the tdwg.org footer on
  / and /standards/wgsrpd/ reads "licensed under a Creative Commons Attribution 4.0 International License". Every WCVP
  Level-3 code has a boundary; Bouvet I. (BOU) has no WCVP row.

## Counting rules

Over accepted species only (taxonRank Species, taxonomicStatus Accepted: 365,813):

- **native** in a unit: distinct species with a row there that is not introduced, not Doubtful and not Extinct;
- **introduced**: distinct species with a row there marked introduced, not Doubtful and not Extinct;
- **endemic**: native species whose native rows name that unit and no other place. A native Level-1/2 row could lie
  outside the unit, so it blocks endemism (1 species in 16.0); 186 species are native only at Level 1/2 and are in no
  unit's count.

## Design

- **Pipeline** `pipeline/wcvp_plants.py`, run once: download both files into the cache (`$WILDEYE_CACHE/wcvp`,
  md5-pinned), stop unless eml.xml still says 16.0 under CC BY 3.0, stream both CSVs from the zip by meta.xml's term
  indexes, stop on any value outside the vocabularies, any location that is not a WGSRPD code or any Level-3 code with
  no boundary; simplify with `ecoregions.simplify_geometry` at 0.01° keeping every island (`min_area` 0), cut parts
  wider than 90° (`marine_realms.split_wide`), area from the unsimplified shape, write
  `public/data/plants_wcvp.geojson`. Exactly 369 units with unique codes, ≤ 3 MB (0.83 MB), or the run stops.
- **Layer** `src/data/plantsWcvp.js`: the freshwater fish polygon pattern without chips; the file is refused unless
  each unit's colour is the colour of the bin holding its native count (grey only for none). Share token `vp`. The info
  box reaches the screen through the details card (`BIO_CARD_LAYER_IDS`).

## Not in scope

Area-normalised density, taxa below species, per-unit species lists, Level-1/2 units, a nightly or yearly rebuild.

## Acceptance

- `pytest pipeline/tests/test_wcvp_plants.py`, `node --test src/data/plantsWcvp.test.mjs` and `npm test` green; new
  tests seen to fail; mutants killed.
- Real release: the published counts equal an independent duckdb query over the raw CSVs (in the PR) for all 369
  units; the pinned units are tested in CI against those values.
- `node scripts/qa-plants-wcvp.mjs --url <build>` in a real browser: readout at the pinned points, nothing in the ocean,
  units drawn in their bin colour, info box, legend and credit, share token, no console errors.
