# Marine heatwave drape against NOAA Coral Reef Watch, 2026-10-24

Written by `python3 -m analysis.mhw_drape_vs_crw 20261024`. The drape is drawn by `pipeline.raster.fetch_erddap_grid` from
PacIOOS ERDDAP `mhw_5km`, as `pipeline/rasters.json` asks (1440x720, every 5th 0.05° cell). Each drape cell's centre is
looked up in two NOAA files from the STAR archive, not PacIOOS:

- the daily netCDF, `noaa-crw_mhw_v1.0.1_category_20261024.nc`: the category code there;
- the plain coloured image, `noaa-crw_mhw_v1.0.1_category_20261024.png`: the colour NOAA drew there, named by the class it matches.

**Codes:** 518,504 of 518,504 drape cells where NOAA's code is a category (0–5) show that category.
**Colours:** 518,504 of 518,504 drape cells where NOAA drew a category colour show that category.

## NOAA code against the drape

NOAA's file marks land with its fill value 251 (the product page lists -127 and -1 for land and climatological sea ice;
neither occurs in the file). "clear" is a drape cell with no value.

| NOAA code | drape | cells |
|---|---|---:|
| 251 | clear | 518,296 |
| no heatwave | no heatwave | 263,402 |
| moderate | moderate | 164,656 |
| strong | strong | 64,529 |
| severe | severe | 20,199 |
| extreme | extreme | 4,810 |
| beyond extreme | beyond extreme | 908 |

## NOAA's colour against the drape

A colour that is not one of the six category colours is shown as its RGB.

| NOAA colour | drape | cells |
|---|---|---:|
| (150, 150, 150) | clear | 348,997 |
| no heatwave | no heatwave | 263,402 |
| (255, 255, 255) | clear | 169,299 |
| moderate | moderate | 164,656 |
| strong | strong | 64,529 |
| severe | severe | 20,199 |
| extreme | extreme | 4,810 |
| beyond extreme | beyond extreme | 908 |
