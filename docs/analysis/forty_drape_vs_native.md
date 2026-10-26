# ForTy drape against the native 10 m probabilities

`python3 -m analysis.forty_drape_vs_native` on the build of 2026-10-26T07:11:22Z (seed 20261026). 260 level-7 pixels (~610 m) drawn from 600 random painted tiles: up to 40 per drawn type and 60 clear. For each, the type the drape draws is compared with the type recomputed from every native 10 m pixel whose centre lies in the pixel's footprint (probabilities summed over pixels with data; other land = 250 minus the five bands). The pipeline reads the 16x cubic overview and average-reprojects it; the two routes share only the source files.

**Agreement: 254 of 260 (97.7%).**

| drawn type | n | native agrees | native says instead |
|---|---|---|---|
| clear | 60 | 59 (98%) | naturally regenerating forest 1 |
| primary forest | 40 | 40 (100%) | — |
| naturally regenerating forest | 40 | 40 (100%) | — |
| planted forest | 40 | 39 (98%) | naturally regenerating forest 1 |
| plantation forest | 40 | 38 (95%) | naturally regenerating forest 1, clear 1 |
| tree crops and agroforestry | 40 | 38 (95%) | clear 2 |

Native top-two margin (share of summed probability between the most and second most likely type): median 0.044 where the two disagree (6), 0.461 where they agree (243). Disagreements with a margin above 0.10: 2.

Pixels with no native data inside the footprint: 11 (drawn: clear 11). Median native pixels per footprint: 3087.

Footprints on a seam between source tiles: 33 of 35 agree; inside one tile 213 of 217.

## Area drawn against the preprint's own map-based areas

The legend's areas are of the drape as drawn (one type per ~610 m pixel). The preprint counts its 10 m map (Table 26, Global): a type that is a minority inside most ~610 m pixels loses ground here.

| type | drawn (Mha) | preprint map (Mha) | drawn / preprint |
|---|---|---|---|
| primary forest | 2,363 | 2,330 | 1.014 |
| naturally regenerating forest | 1,485 | 1,508 | 0.985 |
| planted forest | 118 | 129 | 0.915 |
| plantation forest | 68 | 70 | 0.967 |
| tree crops and agroforestry | 122 | 130 | 0.938 |

Samples: `docs/analysis/forty_samples.tsv`.
