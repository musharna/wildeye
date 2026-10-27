# 10 m land cover: drawn tile against the source

Palette in src/data/esriLulc.js against the service's live legend (renderer "Cartographic Renderer for Visualization and Analysis"):

| legend label | service colour | layer colour |
|---|---|---|
| Water | (26, 91, 171) | (26, 91, 171) |
| Trees | (53, 130, 33) | (53, 130, 33) |
| Flooded Vegetation | (135, 209, 158) | (135, 209, 158) |
| Crops | (255, 219, 92) | (255, 219, 92) |
| Built Area | (237, 2, 42) | (237, 2, 42) |
| Bare Ground | (237, 233, 228) | (237, 233, 228) |
| Snow/Ice | (242, 250, 255) | (242, 250, 255) |
| Clouds | (200, 200, 200) | (200, 200, 200) |
| Rangeland | (239, 207, 168) | (239, 207, 168) |

Legend entries not drawn as a class: No Data.

Seeded random points (seed 20261026), uniform on the sphere between 56°S and 75°N, at level-14 tiles:

| year | land points | drawn = getSamples | drawn = Planetary Computer file |
|---|---|---|---|
| 2017 | 50 | 50 of 50 | 50 of 50 |
| 2021 | 50 | 50 of 50 | 50 of 50 |
| 2025 | 50 | 50 of 50 | not on Planetary Computer |

Points getSamples answers with an error: 30; of them drawn transparent with HTTP 400 (sea or no data): 30.

Sampled level-14 tiles where the default rendering (what the layer draws) is identical to the Cartographic Renderer: 192 of 192. Over the named places:

| place | zoom | year | identical | colours in the tile |
|---|---|---|---|---|
| Des Moines, Iowa (city) | 1 | 2017 | yes | 10 |
| Des Moines, Iowa (city) | 1 | 2025 | yes | 10 |
| Des Moines, Iowa (city) | 5 | 2017 | yes | 7 |
| Des Moines, Iowa (city) | 5 | 2025 | yes | 7 |
| Des Moines, Iowa (city) | 9 | 2017 | yes | 7 |
| Des Moines, Iowa (city) | 9 | 2025 | yes | 7 |
| Des Moines, Iowa (city) | 14 | 2017 | yes | 2 |
| Des Moines, Iowa (city) | 14 | 2025 | yes | 2 |
| Manaus, Brazil (city) | 1 | 2017 | yes | 10 |
| Manaus, Brazil (city) | 1 | 2025 | yes | 10 |
| Manaus, Brazil (city) | 5 | 2017 | yes | 7 |
| Manaus, Brazil (city) | 5 | 2025 | yes | 7 |
| Manaus, Brazil (city) | 9 | 2017 | yes | 7 |
| Manaus, Brazil (city) | 9 | 2025 | yes | 8 |
| Manaus, Brazil (city) | 14 | 2017 | yes | 2 |
| Manaus, Brazil (city) | 14 | 2025 | yes | 2 |
| Amazon forest north of Manaus | 1 | 2017 | yes | 10 |
| Amazon forest north of Manaus | 1 | 2025 | yes | 10 |
| Amazon forest north of Manaus | 5 | 2017 | yes | 7 |
| Amazon forest north of Manaus | 5 | 2025 | yes | 7 |
| Amazon forest north of Manaus | 9 | 2017 | yes | 7 |
| Amazon forest north of Manaus | 9 | 2025 | yes | 7 |
| Amazon forest north of Manaus | 14 | 2017 | yes | 1 |
| Amazon forest north of Manaus | 14 | 2025 | yes | 1 |
| Greenland ice sheet | 1 | 2017 | yes | 10 |
| Greenland ice sheet | 1 | 2025 | yes | 10 |
| Greenland ice sheet | 5 | 2017 | yes | 1 |
| Greenland ice sheet | 5 | 2025 | yes | 1 |
| Greenland ice sheet | 9 | 2017 | yes | 1 |
| Greenland ice sheet | 9 | 2025 | yes | 1 |
| Greenland ice sheet | 14 | 2017 | yes | 1 |
| Greenland ice sheet | 14 | 2025 | yes | 1 |

Disagreements (drawn vs getSamples or the file):

| year | lat | lon | drawn | getSamples | file |
|---|---|---|---|---|---|
| none | | | | | |

Named places:

| place | year | drawn | getSamples | file |
|---|---|---|---|---|
| Des Moines, Iowa (city) | 2017 | Built area | Built area | Built area |
| Des Moines, Iowa (city) | 2021 | Built area | Built area | Built area |
| Des Moines, Iowa (city) | 2025 | Built area | Built area | NA |
| Manaus, Brazil (city) | 2017 | Built area | Built area | Built area |
| Manaus, Brazil (city) | 2021 | Built area | Built area | Built area |
| Manaus, Brazil (city) | 2025 | Built area | Built area | NA |
| Amazon forest north of Manaus | 2017 | Trees | Trees | Trees |
| Amazon forest north of Manaus | 2021 | Trees | Trees | Trees |
| Amazon forest north of Manaus | 2025 | Trees | Trees | NA |
| Greenland ice sheet | 2017 | Snow or ice | Snow or ice | Snow or ice |
| Greenland ice sheet | 2021 | Snow or ice | Snow or ice | Snow or ice |
| Greenland ice sheet | 2025 | Snow or ice | Snow or ice | NA |
