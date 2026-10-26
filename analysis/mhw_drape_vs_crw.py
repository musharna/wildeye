"""Does the mhw drape say what NOAA Coral Reef Watch says? One day's drape, drawn by pipeline.raster from PacIOOS
ERDDAP's mhw_5km exactly as rasters.json asks (every 5th 0.05-degree cell), against NOAA's own daily 5 km netCDF and
NOAA's own coloured plain image for the same day, both from the STAR archive (not PacIOOS): the category code at each
drape cell's centre, and the colour NOAA drew there. Writes docs/analysis/mhw_drape_vs_crw.md.
Run: python3 -m analysis.mhw_drape_vs_crw [YYYYMMDD]
"""

import collections
import io
import json
import signal
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image

from pipeline.net import urlopen
from pipeline.raster import fetch_erddap_grid

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(1500)
ROOT = Path(__file__).resolve().parents[1]
DAY = sys.argv[1] if len(sys.argv) > 1 else "20261024"
STAR = "https://www.star.nesdis.noaa.gov/pub/socd/mecb/crw/data/marine_heatwave/v1.0.1/category"
NC = f"{STAR}/nc/{DAY[:4]}/noaa-crw_mhw_v1.0.1_category_{DAY}.nc"
PNG = f"{STAR}/image_plain/daily/png/{DAY[:4]}/noaa-crw_mhw_v1.0.1_category_{DAY}.png"
UA = {
    "User-Agent": "wildeye/0.1 (marine heatwave legend check; +https://github.com/musharna)"
}


def get(url, timeout=600):
    for attempt in range(3):
        try:
            with urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except OSError as e:  # the laptop's IPv6 drops a connection now and then
            if attempt == 2:
                raise
            sys.stderr.write(f"retrying {url}: {e}\n")


product = next(
    p
    for p in json.loads((ROOT / "pipeline/rasters.json").read_text())
    if p["id"] == "mhw"
)
iso = f"{DAY[:4]}-{DAY[4:6]}-{DAY[6:]}T12:00:00Z"
variant = product | {
    "erddap_grid": product["erddap_grid"]
    | {"url": product["erddap_grid"]["url"].replace("(last)", f"({iso})")}
}
rgba, when, extras = fetch_erddap_grid(variant)
assert when == iso, (when, iso)
b = extras["bounds"]
h, w = rgba.shape[:2]
colour_code = {tuple(c["rgb"]): k for k, c in enumerate(product["classes"])}
labels = [c["label"] for c in product["classes"]]


def drape_class(px):
    """The drape's class at a pixel: its code by exact colour (hidden classes keep their colour at alpha 0), 'clear'
    for the (0,0,0,0) of a cell with no value, 'off' for any other colour."""
    rgb = tuple(int(v) for v in px[:3])
    if px[3] == 0 and rgb == (0, 0, 0):
        return "clear"
    k = colour_code.get(rgb)
    return (
        "off"
        if k is None or (px[3] == 0) != bool(product["classes"][k].get("hidden"))
        else k
    )


with tempfile.NamedTemporaryFile(suffix=".nc") as f:
    f.write(get(NC))
    f.flush()
    with xr.open_dataset(f.name, mask_and_scale=False) as ds:
        name = next(v for v in ds.data_vars if "category" in v)
        native = np.asarray(ds[name].values).squeeze()
        nlat, nlon = np.asarray(ds["lat"].values), np.asarray(ds["lon"].values)
noaa = np.asarray(Image.open(io.BytesIO(get(PNG))).convert("RGB"))
# The image is north-up; the netCDF's lat runs south to north (its row 0 is -89.975). Indexed with the netCDF's row,
# the image disagreed on 52% of category cells; its own north-up row agrees on all of them.
assert nlat[0] < nlat[-1], "the netCDF's lat now runs north to south: drop the flip"
noaa = noaa[::-1]
assert noaa.shape[:2] == native.shape, (noaa.shape, native.shape)

code_vs_drape = collections.Counter()
colour_vs_drape = collections.Counter()
for r in range(h):
    lat = b["north"] - (r + 0.5) * (b["north"] - b["south"]) / h
    i = int(np.argmin(np.abs(nlat - lat)))
    assert abs(nlat[i] - lat) < 1e-3, (lat, nlat[i])
    for c in range(w):
        lon = b["west"] + (c + 0.5) * (b["east"] - b["west"]) / w
        j = int(np.argmin(np.abs(nlon - lon)))
        assert abs(nlon[j] - lon) < 1e-3, (lon, nlon[j])
        d = drape_class(rgba[r, c])
        code_vs_drape[(int(native[i, j]), d)] += 1
        n = colour_code.get(
            tuple(int(v) for v in noaa[i, j]), tuple(int(v) for v in noaa[i, j])
        )
        colour_vs_drape[(n, d)] += 1


def name_of(x):
    return labels[x] if isinstance(x, int) and 0 <= x < len(labels) else str(x)


def table(counter, left):
    rows = [f"| {left} | drape | cells |", "|---|---|---:|"]
    rows += [
        f"| {name_of(a)} | {name_of(d)} | {n:,} |"
        for (a, d), n in sorted(counter.items(), key=lambda kv: -kv[1])
    ]
    return "\n".join(rows)


codes_agree = sum(
    n for (a, d), n in code_vs_drape.items() if isinstance(a, int) and a == d
)
codes_valid = sum(n for (a, d), n in code_vs_drape.items() if 0 <= a < len(labels))
colours_agree = sum(
    n for (a, d), n in colour_vs_drape.items() if isinstance(a, int) and a == d
)
colours_valid = sum(n for (a, d), n in colour_vs_drape.items() if isinstance(a, int))
out = ROOT / "docs/analysis/mhw_drape_vs_crw.md"
out.write_text(f"""# Marine heatwave drape against NOAA Coral Reef Watch, {iso[:10]}

Written by `python3 -m analysis.mhw_drape_vs_crw {DAY}`. The drape is drawn by `pipeline.raster.fetch_erddap_grid` from
PacIOOS ERDDAP `mhw_5km`, as `pipeline/rasters.json` asks ({w}x{h}, every 5th 0.05° cell). Each drape cell's centre is
looked up in two NOAA files from the STAR archive, not PacIOOS:

- the daily netCDF, `{NC.rsplit("/", 1)[1]}`: the category code there;
- the plain coloured image, `{PNG.rsplit("/", 1)[1]}`: the colour NOAA drew there, named by the class it matches.

**Codes:** {codes_agree:,} of {codes_valid:,} drape cells where NOAA's code is a category (0–5) show that category.
**Colours:** {colours_agree:,} of {colours_valid:,} drape cells where NOAA drew a category colour show that category.

## NOAA code against the drape

NOAA's file marks land with its fill value 251 (the product page lists -127 and -1 for land and climatological sea ice;
neither occurs in the file). "clear" is a drape cell with no value.

{table(code_vs_drape, "NOAA code")}

## NOAA's colour against the drape

A colour that is not one of the six category colours is shown as its RGB.

{table(colour_vs_drape, "NOAA colour")}
""")
print(out.read_text())
