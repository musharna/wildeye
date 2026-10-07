# SBTN Natural Lands v1.1: GFW tile colour vs raw class

Produced by `python3 -m analysis.natlands_legend --per-class 5 --rare-per-class 10 --seed 20261006`; one row a point in `natlands_legend_samples.tsv`. Colour = RGBA of the level-12 tile pixel (`https://tiles.globalforestwatch.org/sbtn_natural_lands_classification/v1.1/default_pro/{z}/{x}/{y}.png`); class = the raw classification GeoTIFF (`https://storage.googleapis.com/lcl_public/SBTN_NaturalLands/v1_1/classification/natLands_v1_1_{tile}.tif`) over that pixel's footprint. Pure = every raw pixel overlapping the tile pixel is one class; homogeneous (a subset) = one class over the footprint plus 2 raw pixels on every side. Classes 16, 17, 18, 19, 20, 21 got up to 10 extra points per raw tile.

Points: 1688 from 15 raw tiles; pure: 1304; homogeneous: 848.

## Class x colour (pure points; homogeneous in brackets)

| value | class | category | `185,185,30,255` | `211,211,211,255` | `36,110,36,255` | `0,0,0,0` | drawn as | GFW declared |
|---|---|---|---|---|---|---|---|---|
| 0 | no data (0) |  |  |  |  | 60 (57) | `0,0,0,0` | `0,0,0,0` |
| 2 | natural forests | natural |  |  | 129 (84) |  | `36,110,36,255` | `36,110,36,255` |
| 3 | natural short vegetation | natural | 107 (54) |  |  |  | `185,185,30,255` | `185,185,30,255` |
| 4 | natural water | natural | 114 (90) |  |  |  | `185,185,30,255` | `185,185,30,255` |
| 5 | mangroves | natural |  |  | 21 (19) |  | `36,110,36,255` | `36,110,36,255` |
| 6 | bare | natural | 101 (80) |  |  |  | `185,185,30,255` | `185,185,30,255` |
| 7 | snow | natural | 14 (9) |  |  |  | `185,185,30,255` | `185,185,30,255` |
| 8 | wetland natural forests | natural |  |  | 41 (22) |  | `36,110,36,255` | `36,110,36,255` |
| 9 | natural peat forests | natural |  |  | 71 (51) |  | `36,110,36,255` | `36,110,36,255` |
| 10 | wetland natural short vegetation | natural | 80 (38) |  |  |  | `185,185,30,255` | `185,185,30,255` |
| 11 | natural peat short vegetation | natural | 80 (53) |  |  |  | `185,185,30,255` | `185,185,30,255` |
| 12 | crop | non-natural |  | 182 (108) |  |  | `211,211,211,255` | `211,211,211,255` |
| 13 | built | non-natural |  | 102 (61) |  |  | `211,211,211,255` | `211,211,211,255` |
| 14 | non-natural tree cover | non-natural |  | 61 (40) |  |  | `211,211,211,255` | `211,211,211,255` |
| 15 | non-natural short vegetation | non-natural |  | 73 (42) |  |  | `211,211,211,255` | `211,211,211,255` |
| 16 | non-natural water | non-natural |  | 7 (3) |  |  | `211,211,211,255` | `211,211,211,255` |
| 17 | wetland non-natural tree cover | non-natural |  | 6 (1) |  |  | `211,211,211,255` | `211,211,211,255` |
| 18 | non-natural peat tree cover | non-natural |  | 24 (18) |  |  | `211,211,211,255` | `211,211,211,255` |
| 19 | wetland non-natural short vegetation | non-natural |  | 12 (7) |  |  | `211,211,211,255` | `211,211,211,255` |
| 20 | non-natural peat short vegetation | non-natural |  | 17 (9) |  |  | `211,211,211,255` | `211,211,211,255` |
| 21 | non-natural bare | non-natural |  | 2 (2) |  |  | `211,211,211,255` | `no stop` |

Classes in the sheet with no pure point: none.

## Per colour

Agreement = share of the points drawn in the colour whose raw class is one of the classes it stands for.

| colour | classes it stands for | homogeneous | pure | all points (majority class) |
|---|---|---|---|---|
| `185,185,30,255` | 3 natural short vegetation, 4 natural water, 6 bare, 7 snow, 10 wetland natural short vegetation, 11 natural peat short vegetation | 324/324 = 100.0% | 496/496 = 100.0% | 618/641 = 96.4% |
| `211,211,211,255` | 12 crop, 13 built, 14 non-natural tree cover, 15 non-natural short vegetation, 16 non-natural water, 17 wetland non-natural tree cover, 18 non-natural peat tree cover, 19 wetland non-natural short vegetation, 20 non-natural peat short vegetation, 21 non-natural bare | 291/291 = 100.0% | 486/486 = 100.0% | 637/648 = 98.3% |
| `36,110,36,255` | 2 natural forests, 5 mangroves, 8 wetland natural forests, 9 natural peat forests | 176/176 = 100.0% | 262/262 = 100.0% | 326/335 = 97.3% |
| `0,0,0,0` | 0 no data (0) | 57/57 = 100.0% | 60/60 = 100.0% | 62/64 = 96.9% |

## Per class

| value | class | pure points in its colour | homogeneous points in its colour |
|---|---|---|---|
| 0 | no data (0) | 60/60 = 100.0% | 57/57 = 100.0% |
| 2 | natural forests | 129/129 = 100.0% | 84/84 = 100.0% |
| 3 | natural short vegetation | 107/107 = 100.0% | 54/54 = 100.0% |
| 4 | natural water | 114/114 = 100.0% | 90/90 = 100.0% |
| 5 | mangroves | 21/21 = 100.0% | 19/19 = 100.0% |
| 6 | bare | 101/101 = 100.0% | 80/80 = 100.0% |
| 7 | snow | 14/14 = 100.0% | 9/9 = 100.0% |
| 8 | wetland natural forests | 41/41 = 100.0% | 22/22 = 100.0% |
| 9 | natural peat forests | 71/71 = 100.0% | 51/51 = 100.0% |
| 10 | wetland natural short vegetation | 80/80 = 100.0% | 38/38 = 100.0% |
| 11 | natural peat short vegetation | 80/80 = 100.0% | 53/53 = 100.0% |
| 12 | crop | 182/182 = 100.0% | 108/108 = 100.0% |
| 13 | built | 102/102 = 100.0% | 61/61 = 100.0% |
| 14 | non-natural tree cover | 61/61 = 100.0% | 40/40 = 100.0% |
| 15 | non-natural short vegetation | 73/73 = 100.0% | 42/42 = 100.0% |
| 16 | non-natural water | 7/7 = 100.0% | 3/3 = 100.0% |
| 17 | wetland non-natural tree cover | 6/6 = 100.0% | 1/1 = 100.0% |
| 18 | non-natural peat tree cover | 24/24 = 100.0% | 18/18 = 100.0% |
| 19 | wetland non-natural short vegetation | 12/12 = 100.0% | 7/7 = 100.0% |
| 20 | non-natural peat short vegetation | 17/17 = 100.0% | 9/9 = 100.0% |
| 21 | non-natural bare | 2/2 = 100.0% | 2/2 = 100.0% |

## Second route: GFW's declared colormap

`https://data-api.globalforestwatch.org/asset/fc4e9c41-06fe-4f95-86a3-718caae4e8fa/creation_options`: every sampled class with a stop is drawn in the colour the colormap declares; no stop for 21 non-natural bare (drawn as observed above).
