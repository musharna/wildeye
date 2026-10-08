# Antarctic penguin breeding colonies — design (2026-10-07)

## Outcome

Switch on **Penguin colonies (Antarctic)** (🐧, token `pg`): one dot per breeding site × species south of 60°S, coloured
by species (Adélie, chinstrap, gentoo, emperor, king, macaroni). Where several species breed at one site their dots
sit side by side around it, a fixed number of screen pixels apart, so each one can be seen and clicked. A click opens the details card: site name and
region, species, the latest counts with their type (nests, chicks or adults) and season, each count's accuracy, the
number of surveys and the span of seasons, and the citation. A site × species with no count says "recorded present,
not counted". WHAT LIVES HERE names the nearest colony site within 10 km and each of its species' latest counts.
Counts of different types are never added, compared or used to size a dot. Not on the time bar.

## Acceptance check

```
uv run --python 3.13 --with pytest --with numpy --with pillow --with boto3 --with arm-pyart --with openpyxl \
  --with rasterio --with pyproj --with duckdb --with pyogrio --with shapely \
  pytest pipeline/tests/test_penguins.py -q -p no:cacheprovider                     # exit 0 (CI's env)
node --test src/data/penguins.test.mjs                                               # exit 0
npm test                                                                             # exit 0 (registry 67 -> 68)
~/miniconda3/bin/python3 -m pipeline.penguins                                        # writes public/data/penguins.json
~/miniconda3/bin/python3 scripts/penguins_coast_check.py                             # exit 0: premise holds
npm run build && node scripts/qa-penguins.mjs --url http://127.0.0.1:<port>/         # exit 0
```

`scripts/qa-penguins.mjs` takes its known answers from `scripts/qa_penguins_truth.R`, which reads the raw `.rda`
files with R itself and never touches the pipeline's code or output.

## Source (read 2026-10-07)

- **Release:** the authors' Antarctic Penguin Biogeography Project database in the `mapppdr` R package, GitHub
  CCheCastaldo/mapppdr tag v3.1 (2026-08-21; the tag is the commit 88c73a507e0921b2541c218c71eaf16721bc6502, "updates
  mapppdr package from v3.0 to v3.1 matching v3.1 MAPPPD_source release"). Release tarball 2,283,668 bytes, md5
  cfa87ca7b876cd3aa50947e9c6c1f23c (the same bytes on a second download today).
- **Pin:** GitHub builds tarballs on request and does not promise their bytes, so the pipeline does not use the
  tarball. It fetches the four files it reads from `raw.githubusercontent.com` at the commit SHA, which serves the
  committed blob, and refuses any whose sha256 is not pinned: `data/penguin_obs.rda`, `data/sites.rda`,
  `data/species.rda`, `README.md` (each equal to the tarball's copy).
- **Licence:** README "Licenses": "This database is licensed under a Creative Commons Attribution 4.0 International
  License"; code GPL-3 (no code is used). The pipeline refuses a README that no longer says so. Release notes ask to
  cite Che-Castaldo, Humphries & Lynch (2023) Biodiversity Data Journal 11: e101476, doi:10.3897/BDJ.11.e101476, and
  the versioned dataset via SCAR-AntOBIS, doi:10.48361/zftxkr.
- **Format:** only `.rda` (R save files, gzip, serialisation version 3); `mapppd_db/` is an empty submodule of a
  private repository and `data-raw/` holds only a mask script. CI has neither R nor an R reader package, so
  `pipeline/rda.py` reads the format in plain Python: data frames of character, integer, logical and double columns
  (Date as a double with class "Date"); any other R type stops the read. Checked against R: every cell of the three
  tables (5,487 + 729 + 7 rows, 81,220 cells) equal to `write.csv` from R 4.3.3.
- **Contents:** `penguin_obs` 5,487 records (site_id, species_id, citekey, month, day, doy, date, year, season, type
  ∈ nests/chicks/adults, presence 0/1, count, accuracy 1–5, vantage); `sites` 729 (site_id, site_name, region,
  ccamlr_id, latitude, longitude; 77.7–60.6°S); `species` 7 (one, UNPE "unknown penguin", has no records).
- **Meanings** (the BDJ paper and `man/penguin_obs.Rd`): `season` is the austral summer by its first year (a count of
  25 Feb 2011 is season 2010), shown as "2010/11". `accuracy` is the Croxall and Kirkwood (1979) five-point scale,
  1 most precise, 5 "order-of-magnitude" (all satellite estimates). A record with presence 0 is a survey that found
  none (count 0); a record with presence 1 and no count is presence only. The paper defines an event (a survey) as "a
  survey conducted at a specific site and time, using a specific sampling protocol, and reported in a specific
  publication"; the same survey can appear in more than one publication, and the authors keep both.
- **Not used:** penguinmap.com (its terms bar commercial use); the SCAR IPT archive v2.3 (CC BY, data end 2022-02-12).

## Decisions

1. One point per site × species with at least one presence record: 918 points at 726 sites (ADPE 287, CHPE 369,
   EMPE 68, GEPE 142, KIPE 8, MCPE 44). This equals the authors' own `site_species` table. The 6 site × species whose
   every record is an absence (DARX, DEEI, GREI ×2, UNN2 Adélie/chinstrap, LEDD emperor) are not breeding colonies
   and are not drawn; they are listed in the output. *(The brief said "at least one record"; drawing a "colony" where
   the species was only ever recorded absent would contradict the layer's name. Open to veto.)*
2. **Latest counts:** the records with a count (0 included) in the latest season that has any count, all of them,
   newest date first, undated last. The release often holds several counts in one season (70 site × species: nests
   and chicks of one survey, two parties on one day, the same survey from two publications), and the authors keep
   them all; the card lists each with its type, date if known and accuracy, rather than pick one. A 0 reads "0 nests
   (none found)".
3. **Presence only:** a site × species with no count says "recorded present, not counted" with its latest season (12
   points, e.g. LAZN emperor 2018–2022). When the latest record is presence only and later than the latest count, the
   card says so under the count (none in v3.1, handled).
4. **Surveys:** distinct (citekey, season, date, vantage) per site × species, following the paper's event definition;
   the card also gives the record count and the first and last season.
5. Colour by species; constant dot size (counts of different types cannot share a scale). At a shared site the dots
   (10 px, as billboards) sit on a circle round it, the first in species order at the top and the rest clockwise,
   neighbours 12 px apart centre to centre; one scale-by-distance for the dots and their offsets, so the cluster keeps
   its shape. Not on the time bar. *(The first build drew concentric rings of points; qa-penguins showed the outer
   ring covering the inner dot from 30 km and a click in the middle of each ring opening the next species in.)*
6. WHAT LIVES HERE: the nearest site within 10 km of the click, every species there with its latest counts, and how
   many other colony sites are within 10 km.

## Premise check (before UI)

`scripts/penguins_coast_check.py`: share of points within 5 km of the Natural Earth 10 m land boundary (the file
pinned by `pipeline/land.py`), per species, distance in Antarctic polar stereographic (EPSG:3031), against the same
points shifted 0.5° in longitude and latitude (four diagonal directions). Emperors are judged separately: they breed
on sea ice, often away from the mapped coast. The check fails unless, for every non-emperor species with at least 20
points, the unshifted share is at least 0.6 and at least 3 times each shifted share. Natural Earth 10 m drops many
small Antarctic islands, so the unshifted shares are expected below 1.

Result (2026-10-07, before any UI; share within 5 km, unshifted vs the four shifts):

| species | n | unshifted | shifted (+,+ / −,+ / +,− / −,−) | verdict |
|---|---|---|---|---|
| Adélie | 287 | 0.683 | 0.087 / 0.059 / 0.101 / 0.167 | pass |
| chinstrap | 369 | 0.859 | 0.081 / 0.016 / 0.106 / 0.133 | pass |
| gentoo | 142 | 0.908 | 0.218 / 0.092 / 0.085 / 0.282 | pass |
| macaroni | 44 | 0.841 | 0.045 / 0.000 / 0.023 / 0.023 | pass |
| king | 8 | 1.000 | 0.125 / 0.000 / 0.125 / 0.250 | reported (n < 20) |
| emperor | 68 | 0.485 (median 5.9 km) | 0.044 / 0.044 / 0.162 / 0.162 | reported (sea ice) |

The 91 Adélie points beyond 5 km all lie at sea in Natural Earth (none inland); the farthest are small islands it
does not draw (Clark Island 72 km, Cruzen Island 51 km, the Danger Islands' Heroina, Earle, Beagle and Darwin
Islands 22–25 km). The coordinates are right as read.

## Pipeline (`pipeline/penguins.py`)

Fetch the four pinned files into `$WILDEYE_CACHE/penguins/v3.1` (default `~/.cache/wildeye/penguins/v3.1`), check
the README licence, read the three tables through `pipeline/rda.py`, refuse anything the decisions above do not cover
(an unknown type, species or site; presence not 0/1; a negative count; presence 0 with a count above 0; accuracy
outside 1–5; a site outside 90–55°S; a duplicate site id), and write `public/data/penguins.json`: per point the site
id, name, region, lat, lon, species, record and survey counts, first and last season, the latest counts (type,
count, date, accuracy, vantage), the latest presence-only season if later; the absence-only pairs; the species list;
the source with its licence text.

## Layer (`src/data/penguins.js`)

A Cesium data source of points with descriptions for the details card (`BIO_CARD_LAYER_IDS`), a legend per species
with its point count, `readoutAt` for WHAT LIVES HERE. No `setObservedTime`/`getObservedExtent`.

## Out of scope

MAPPPD population projections, penguinmap.com content, at-sea tracking, trends across seasons, any total across
sites or types.
