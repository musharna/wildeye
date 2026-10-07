"""Known answers for scripts/qa-cmems-zooc.mjs, read straight from Copernicus Marine without pipeline/raster.py.

Usage: python3 -B scripts/qa_cmems_zooc_truth.py <data dir holding rasters.json and rasters/cmems-zooc.png>
→ JSON on stdout. Needs CMEMS_USER / CMEMS_PASS (source ~/.config/wildeye/env).

For the day the manifest shows it opens the dataset with xarray (copernicusmarine.open_dataset), and in each region
box takes the ocean cell with the highest (upwelling, high latitude) or lowest (gyre) surface zooc. The point read is
inside that cell and inside the drape pixel the cell is drawn as (the drape spans the manifest bounds edge to edge),
so a click there reads that cell. The PNG pixel's colour is inverted through the manifest ramp by rendering a dense
log-spaced set of values with this file's own log10 interpolation (not ramp_rgba) and keeping every value drawn in
that exact colour: the pixel stands for the interval [lo, hi], and the raw value must lie in it.
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# (name, kind, south, west, north, east); kind picks the max, min or median cell in the box. The upwelling maxima
# sit at the variable's valid_max 5 (317 cells on 2026-10-07): they check the clamped top; the medians check numbers.
REGIONS = [
    ("Peru upwelling", "max", -16.0, -80.0, -10.0, -75.0),
    ("Peru upwelling, box median", "median", -16.0, -80.0, -10.0, -75.0),
    ("Equatorial Pacific, box median", "median", -2.0, -140.0, 2.0, -100.0),
    ("Benguela upwelling", "max", -28.0, 12.0, -20.0, 16.0),
    ("North Pacific gyre", "min", 20.0, -160.0, 30.0, -140.0),
    ("South Pacific gyre", "min", -30.0, -125.0, -20.0, -110.0),
    ("Norwegian Sea", "max", 62.0, -5.0, 70.0, 10.0),
]
LAND = ("Sahara (land)", 23.0, 12.0)


def render(values, ramp):
    """Log10 interpolation of `values` through the ramp's stops, rounded to 8 bits: an independent rendering."""
    stops = np.asarray(ramp["stops"], float)
    lo, hi = ramp["min"], ramp["max"]
    t = np.clip(np.log10(np.maximum(values, lo) / lo) / np.log10(hi / lo), 0, 1)
    x = t * (len(stops) - 1)
    i = np.minimum(np.floor(x).astype(int), len(stops) - 2)
    f = (x - i)[:, None]
    return np.rint(stops[i] * (1 - f) + stops[i + 1] * f).astype(int)


def main(data_dir):
    import copernicusmarine as cm

    entry = next(
        p
        for p in json.loads((data_dir / "rasters.json").read_text())["products"]
        if p["id"] == "cmems-zooc"
    )
    ramp, b = entry["ramp"], entry["bounds"]
    assert ramp.get("log") is True, ramp
    png = np.asarray(
        Image.open(data_dir / "rasters" / "cmems-zooc.png").convert("RGBA")
    )
    height, width = png.shape[:2]
    day = entry["time"][:10]
    ds = cm.open_dataset(
        username=os.environ["CMEMS_USER"],
        password=os.environ["CMEMS_PASS"],
        dataset_id="cmems_mod_glo_bgc-plankton_anfc_0.25deg_P1D-m",
        variables=["zooc"],
        minimum_depth=0,
        maximum_depth=1,
    )
    da = ds["zooc"].sel(time=np.datetime64(day)).isel(depth=0)
    lat = np.asarray(ds["latitude"].values, float)
    lon = np.asarray(ds["longitude"].values, float)
    field = np.asarray(
        da.values, float
    )  # rows south to north, as the dataset stores them
    grid = np.logspace(np.log10(ramp["min"]), np.log10(ramp["max"]), 400001)
    drawn = render(grid, ramp)

    def drape_pixel(la, lo_):
        px = min(
            width - 1,
            int(np.floor((lo_ - b["west"]) / (b["east"] - b["west"]) * width)),
        )
        py = min(
            height - 1,
            int(np.floor((b["north"] - la) / (b["north"] - b["south"]) * height)),
        )
        return px, py

    points = []
    for name, kind, s, w, n, e in REGIONS:
        rows = np.nonzero((lat >= s) & (lat <= n))[0]
        cols = np.nonzero((lon >= w) & (lon <= e))[0]
        box = field[np.ix_(rows, cols)]
        if kind == "median":
            k = np.nanargmin(np.abs(box - np.nanmedian(box)))
        else:
            k = np.nanargmax(box) if kind == "max" else np.nanargmin(box)
        r, c = rows[k // box.shape[1]], cols[k % box.shape[1]]
        # the cell spans its centre ± 0.125°; the drape pixel the same cell is drawn as is row (top-down) height-1-r,
        # column c. A point 0.05° south and 0.1° east of the centre is inside both (checked, not assumed).
        la, lo_ = float(lat[r]) - 0.05, float(lon[c]) + 0.1
        px, py = drape_pixel(la, lo_)
        if (px, py) != (int(c), height - 1 - int(r)):
            raise SystemExit(
                f"{name}: point {la},{lo_} is drawn by pixel {px},{py}, not cell {c},{height - 1 - r}"
            )
        raw = float(field[r, c])
        rgba = png[py, px].tolist()
        same = np.all(drawn == np.asarray(rgba[:3]), axis=1)
        if not same.any():
            raise SystemExit(f"{name}: PNG colour {rgba} is not one the ramp draws")
        lo_v, hi_v = float(grid[same].min()), float(grid[same].max())
        points.append(
            {
                "name": name,
                "lat": round(la, 4),
                "lon": round(lo_, 4),
                "cell": [float(lat[r]), float(lon[c])],
                "raw": raw,
                "png_rgba": rgba,
                "png_lo": lo_v,
                "png_hi": hi_v,
                "raw_in_png_interval": bool(
                    lo_v * (1 - 2e-5) <= raw <= hi_v * (1 + 2e-5)
                ),
            }
        )
    name, la, lo_ = LAND
    px, py = drape_pixel(la, lo_)
    r = int(np.argmin(np.abs(lat - la)))
    c = int(np.argmin(np.abs(lon - lo_)))
    land = {
        "name": name,
        "lat": la,
        "lon": lo_,
        "raw_is_nan": bool(np.isnan(field[r, c])),
        "png_alpha": int(png[py, px, 3]),
    }
    json.dump({"day": day, "points": points, "land": land}, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main(Path(sys.argv[1]))
