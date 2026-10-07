"""Known answers for scripts/qa-soil-bacteria.mjs, read straight from the release without pipeline/soil_bacteria.py.

Usage: python3 -I scripts/qa_soil_bacteria_truth.py <ensemble.zip> → JSON on stdout.

The zip's md5 must be Zenodo's (record 21133869). bacteria_mean.nc and bacteria_std.nc are opened with xarray on the
h5netcdf engine (the pipeline uses netCDF4 and index arithmetic). Coastal cells are found by walking in from the sea a
cell centre at a time until the model has a value; the point read is 0.04° from that cell's centre toward the sea, so
it sits near the cell's seaward edge. Every value is read with .sel(lat, lon, method="nearest") at the point itself
(the nearest centre to a point is the centre of the cell holding it), and the selected centre must lie within 0.05° of
the point on both axes. Ocean points must be blank. Each land point also records its inland neighbour's values, which
the QA uses as a negative control: they must not match what the site shows. Every land cell is read again at its four
corners, 0.045° in from both edges, where the level-3 pixel under the point is often the next cell's; the control
there is the cell diagonally across the corner.
"""

import hashlib
import io
import json
import signal
import sys
import zipfile

import numpy as np
import xarray as xr

ZIP_MD5 = "822beb1e913521d4831b4d12320f4278"
OFF = 0.04  # degrees from the cell centre toward the sea
CORNER = (
    0.045  # degrees from the cell centre on both axes: inside the cell, near a corner
)

# (name, fixed coordinate, walking axis, first centre, step): walk from the sea toward land along `axis`
WALKS = [
    ("Africa west coast (Senegal)", 14.75, "lon", -19.95, 0.1),
    ("Africa east coast (Somalia)", 2.05, "lon", 49.95, -0.1),
    ("Africa north coast (Libya)", 15.05, "lat", 34.95, -0.1),
    ("Africa south coast (South Africa)", 20.05, "lat", -39.95, 0.1),
    ("South America west coast (Chile)", -33.45, "lon", -74.95, 0.1),
    ("Australia north coast", 132.05, "lat", -9.95, -0.1),
    ("Australia south coast", 135.05, "lat", -39.95, 0.1),
]
# (name, lat, lon): fixed points, inside a cell near its antimeridian edge or in the interior
FIXED = [
    ("Chukotka, east of 180 W", 67.05, -179.99),
    ("Chukotka, west of 180 E", 67.05, 179.99),
    ("Fiji, east of 180 W", -16.85, -179.99),
    ("Fiji, west of 180 E", -16.85, 179.99),
    ("central Amazon", -3.01, -60.09),
    ("Sahara", 23.09, 10.01),
]
OCEAN = [("mid Pacific", 0.05, -149.95), ("South Atlantic", -30.05, -15.05)]


def half_up(x: float) -> int:
    return int(np.floor(x + 0.5))


def main(zip_path: str) -> dict:
    with open(zip_path, "rb") as fh:
        got = hashlib.md5(fh.read(), usedforsecurity=False).hexdigest()
    if got != ZIP_MD5:
        raise SystemExit(f"{zip_path}: md5 {got} is not Zenodo's {ZIP_MD5}")
    with zipfile.ZipFile(zip_path) as z:
        mean = xr.open_dataset(
            io.BytesIO(z.read("bacteria_mean.nc")), engine="h5netcdf"
        )["richness"]
        sd = xr.open_dataset(io.BytesIO(z.read("bacteria_std.nc")), engine="h5netcdf")[
            "richness"
        ]

    def at(lat, lon):
        m = mean.sel(lat=lat, lon=lon, method="nearest")
        s = sd.sel(lat=lat, lon=lon, method="nearest")
        clat, clon = float(m["lat"]), float(m["lon"])
        if abs(clat - lat) > 0.05 or abs(clon - lon) > 0.05:
            raise SystemExit(
                f"{lat}, {lon}: nearest centre {clat}, {clon} is not the cell holding the point"
            )
        return clat, clon, float(m), float(s)

    points = []

    def land(name, lat, lon, inland):
        clat, clon, m, s = at(lat, lon)
        if np.isnan(m) or np.isnan(s):
            raise SystemExit(f"{name}: {lat}, {lon} is blank in the model")
        nlon = (
            clon + inland[1] + 180
        ) % 360 - 180  # the neighbour across 180° is on the other side
        _, _, nm, ns = at(clat + inland[0], nlon)
        points.append(
            {
                "name": name,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "cell": [round(clat, 6), round(clon, 6)],
                "raw": [m, s],
                "mean": half_up(m),
                "sd": half_up(s),
                "neighbour": None if np.isnan(nm) else [half_up(nm), half_up(ns)],
            }
        )

    for name, fixed, axis, start, step in WALKS:
        for k in range(200):
            v = start + k * step
            lat, lon = (fixed, v) if axis == "lon" else (v, fixed)
            if not np.isnan(at(lat, lon)[2]):
                break
        else:
            raise SystemExit(f"{name}: no land in 200 cells")
        if k == 0:
            raise SystemExit(
                f"{name}: the walk starts on land, so the cell found is not coastal"
            )
        sea = -np.sign(step)
        d = (0.0, sea * OFF) if axis == "lon" else (sea * OFF, 0.0)
        inland = (0.0, -sea * 0.1) if axis == "lon" else (-sea * 0.1, 0.0)
        clat, clon = at(lat, lon)[:2]
        land(name, clat + d[0], clon + d[1], inland)
    for name, lat, lon in FIXED:
        land(name, lat, lon, (0.0, 0.1 if lon < 0 else -0.1))
    # Each of those cells again at its four corners, 0.045° in from both edges: the pixel under such a point is often the
    # next cell's (level 3 has 0.088° pixels on 0.1° cells), so these check the readout's snap to the cell. The control
    # is the cell diagonally across that corner.
    for p in list(points):
        clat, clon = p["cell"]
        for tag, sn, we in (("NE", 1, 1), ("NW", 1, -1), ("SE", -1, 1), ("SW", -1, -1)):
            lat, lon = clat + sn * CORNER, clon + we * CORNER
            if abs(lon) >= 180:
                continue
            land(f"{p['name']}, {tag} corner", lat, lon, (sn * 0.1, we * 0.1))
    ocean = []
    for name, lat, lon in OCEAN:
        clat, clon, m, s = at(lat, lon)
        if not (np.isnan(m) and np.isnan(s)):
            raise SystemExit(f"{name}: {lat}, {lon} has a value ({m}, {s})")
        ocean.append(
            {
                "name": name,
                "lat": lat,
                "lon": lon,
                "cell": [round(clat, 6), round(clon, 6)],
            }
        )
    return {
        "zip_md5": got,
        "method": "xarray h5netcdf .sel(method='nearest') at the point",
        "points": points,
        "ocean": ocean,
    }


if __name__ == "__main__":
    signal.signal(
        signal.SIGALRM,
        lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
    )
    signal.alarm(300)
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: python3 -I scripts/qa_soil_bacteria_truth.py <ensemble.zip>"
        )
    json.dump(main(sys.argv[1]), sys.stdout, indent=1)
    sys.stdout.write("\n")
