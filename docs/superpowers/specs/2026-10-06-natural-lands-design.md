# Natural lands 2020 (SBTN Natural Lands Map v1.1) — design

Wave 3, item 1 of 2 (ledger `grill_wildeye_wave3_2026-10-06.md`, decision 2; decisions assumed, open to veto).

## Outcome

A layer **Natural lands 2020 (SBTN Natural Lands Map)** (🌄, token `nl`): one drape, drawn as served from Global
Forest Watch's tile cache, nothing re-hosted (0 MB of the Pages budget). It takes part in the one-drape rule, is not on
the time bar (a 2020 baseline) and has no click readout. The legend names, for each of the cache's three colours, every
class it stands for:

| colour | legend | classes (value: sheet name) |
|---|---|---|
| (36, 110, 36) | Natural forest | 2 natural forests, 5 mangroves, 8 wetland natural forests, 9 natural peat forests |
| (185, 185, 30) | Other natural land and water | 3 natural short vegetation, 4 natural water, 6 bare, 7 snow, 10 wetland natural short vegetation, 11 natural peat short vegetation |
| (211, 211, 211) | Non-natural land | 12 crop, 13 built, 14 non-natural tree cover, 15 non-natural short vegetation, 16 non-natural water, 17 wetland non-natural tree cover, 18 non-natural peat tree cover, 19 wetland non-natural short vegetation, 20 non-natural peat short vegetation, 21 non-natural bare |

Transparent: no data (value 0) and everything outside the map (oceans, Greenland, Antarctica).

## Source

- **Tiles:** `https://tiles.globalforestwatch.org/sbtn_natural_lands_classification/v1.1/default_pro/{z}/{x}/{y}.png`
  (GFW data-api dataset `sbtn_natural_lands_classification` v1.1, asset `fc4e9c41…`). Web-mercator XYZ, 256 px RGBA,
  `access-control-allow-origin: *`, `max-age=31536000`. `creation_options`: `max_zoom` 12, `max_static_zoom` 9,
  `resampling: mode`. A tile not yet rendered answers 307 to `/dynamic/{z}/{x}/{y}.png?implementation=default_pro`,
  which draws and stores it. Outside the map every tile is 200 and transparent (no 404s), so any tile error is a fault.
- **Max zoom:** 12. Tiles past 12 are served but are exact 2× nearest-neighbour upsamples of their level-12 parent
  (0 differing pixels over four children, levels 12→16; level 11→12 differs, the control). A level-12 pixel is ~38 m at
  the equator, the raw grid 0.00025° (~28 m).
- **Raw data:** `storage.googleapis.com/lcl_public/SBTN_NaturalLands/v1_1/classification/natLands_v1_1_{tile}.tif`,
  10° tiles named by their top-left corner, 40000 px, uint8. The class names come from the sheet the README links.
- **Licence:** CC BY-SA 4.0 (README line 50, read 2026-10-06 and re-read by the QA on every run). The tiles are drawn as
  served, not adapted.
- **Cite (README, verbatim):** Mazur, E., M. Sims, E. Goldman, M. Schneider, M.D. Pirri, C.R. Beatty, F. Stolle,
  Stevenson, M. 2025. “SBTN Natural Lands Map v1.1: Technical Documentation”. *Science Based Targets for Land Version
  1-- Supplementary Material*. Science Based Targets Network. The PDF resolves (200, 3.3 MB); its title page lists
  these authors, Mazur first, v1.1, last updated 18 February 2025.

## Legend evidence (`analysis/natlands_legend.py`)

For 15 raw tiles on every continent, points of every class present (from each file's 1/32 overview, a uniform 3×3
block where possible; 10 extra per tile for the rare non-natural classes 16–21) are moved to the centre of the
level-12 tile pixel under them. The raw pixels overlapping that pixel give the class. The tile's RGBA is read from the
PNG. Result in `docs/analysis/natlands_legend_crosstab.md`, points in `natlands_legend_samples.tsv`:

- 1,688 points; 1,304 pure (every raw pixel under the tile pixel is one class), 848 homogeneous (one class with
  2 raw pixels of margin). Every class 2–21 has pure points (class 21: 2, class 17: 6, class 16: 7).
- Per colour, pure and homogeneous points agree 100% (green 262/262, yellow 496/496, grey 486/486, clear 60/60). Over
  all points, majority class (mixed pixels included): 97.3%, 96.4%, 98.3%, 96.9%.
- Second route: GFW's declared colormap gives every class 2–20 the same colour. It has no stop for 21, which the
  samples show drawn grey. Value 1 is white in the colormap but never occurs in the sampled files.

Three colours for 20 classes, so the mapping is not one to one. A click cannot tell crop from built, or water from
bare, so there is no readout (`oneColourPerClass(GROUPS)` is false, and a test pins it).

## Frontend (`src/data/naturalLands.js`)

`UrlTemplateImageryProvider` with Cesium's default web-mercator scheme, `maximumLevel` 12, alpha 1 (as GIBS draws
its categorical layers, so screen colours equal the legend's), zrank 21 with the other land drapes. The pattern is
IFL's: 8 tile errors in one provider generation mark the layer failing, and the next update builds a fresh provider.
`GROUPS` is the table above.

## Acceptance

- `npm test` (Node 24). `src/data/naturalLands.test.mjs` checks:
  - URL and real provider scheme.
  - Every homogeneous sample against `GROUPS`.
  - The class partition and the legend text.
  - No readout, and not on the time bar (main.js lists).
  - Drape membership in main.js plus the one-drape rule on the real manager.
  - Failure handling and the credit.
- `node scripts/qa-natural-lands.mjs --url http://127.0.0.1:<port>/` checks:
  - **Live source:** licence, `max_zoom`, colormap against `GROUPS`, nothing past 12.
  - **Real browser:** not fetched before on; another drape goes off; at three known points from different raw tiles
    the rendered globe is the group colour (basemap control); tiles finish 200 through any redirect and reach the
    served max zoom; no time-bar hook; no readout row; legend and credit text; share token; no page errors.

## Out of scope

The SBTN natural forests map, the binary natural/non-natural map, and a readout of the class.
