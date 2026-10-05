"""Known answers for scripts/qa-tidal-marsh.mjs, read from the pinned release zip without pipeline/tidal_marsh.py.

Usage: python3 -B scripts/qa_tidal_marsh_truth.py <cache dir holding tidal_marsh_v2_6.zip>  → JSON on stdout.

For seven coastal regions it reads the 10 m window of the one GeoTIFF that covers it and counts, for every level-9 pixel
of Cesium's geographic tiling scheme whose source pixels all lie inside the window, the source pixels whose centre
falls in it and how many are marsh (np.unique over the pixels' cell keys, not the pipeline's per-row sums). From each
region it takes the cell with the highest share, the cells nearest 50% and 30%, and where there are such cells, one at
exactly n.5%, one under 1.5% and one with none; it gives each cell's centre and its share in whole percent, halves up
(Fraction), any marsh at least 1. The release georeferences its 180W tiles at 180-190°E, so a region west of 170°W is
looked up 360° east and its cells keyed by longitude modulo 360.
"""

import json
import sys
import zipfile
from fractions import Fraction
from math import floor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds

Z = 9
COLS, ROWS = 2 ** (Z + 1) * 256, 2**Z * 256
# (name, south, west, north, east): estuaries the paper's map covers, each inside one 10° GeoTIFF
REGIONS = [
    ("The Wash, England", 52.75, 0.05, 53.0, 0.5),
    ("Sapelo Island, Georgia", 31.3, -81.45, 31.6, -81.2),
    ("Terrebonne Bay, Louisiana", 29.15, -90.9, 29.45, -90.5),
    ("Yancheng, Jiangsu", 33.0, 120.55, 33.4, 120.95),
    ("Bahía Blanca, Argentina", -39.0, -62.4, -38.7, -62.0),
    ("Western Port, Victoria", -38.45, 145.2, -38.2, 145.6),
    ("Adak Island, Aleutians", 51.7, -178.05, 51.95, -176.55),
]


def share(m: int, t: int) -> int:
    if not m:
        return 0
    return max(1, min(100, floor(Fraction(100 * m, t) + Fraction(1, 2))))


def centre(gx: int, gy: int) -> tuple[float, float]:
    return 90 - (gy + 0.5) / ROWS * 180, (gx + 0.5) / COLS * 360 - 180


def region_cells(src, s, w, n, e):
    win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths()
    a = src.read(1, window=win)
    t = src.window_transform(win)
    lon = t.c + (np.arange(a.shape[1]) + 0.5) * t.a
    lat = t.f + (np.arange(a.shape[0]) + 0.5) * t.e
    gx = np.floor((lon + 180) % 360 / 360 * COLS).astype(np.int64)
    gy = np.floor((90 - lat) / 180 * ROWS).astype(np.int64)
    keys = (gy[:, None] * COLS + gx[None, :]).ravel()
    uniq, inv, total = np.unique(keys, return_inverse=True, return_counts=True)
    marsh = np.bincount(inv, weights=a.ravel().astype(np.float64)).astype(np.int64)
    # a cell cut by the window's edge holds pixels outside it: only cells strictly inside are kept
    inner = []
    for k, m, tot in zip(uniq.tolist(), marsh.tolist(), total.tolist()):
        y, x = divmod(k, COLS)
        if gx[0] < x < gx[-1] and gy[0] < y < gy[-1]:
            inner.append((x, y, m, tot))
    return inner


def main(cache: Path) -> dict:
    zpath = cache / "tidal_marsh_v2_6.zip"
    names = sorted(n for n in zipfile.ZipFile(zpath).namelist() if n.endswith(".tif"))
    bounds = {}
    for name in names:
        with rasterio.open(f"/vsizip/{zpath}/{name}") as src:
            bounds[name] = src.bounds
    points = []
    for label, s, w, n, e in REGIONS:
        def covering(w, e):
            return [k for k, b in bounds.items() if b.left < w and b.right > e and b.bottom < s and b.top > n]

        if not covering(w, e):
            w, e = w + 360, e + 360
        (name,) = covering(w, e)
        with rasterio.open(f"/vsizip/{zpath}/{name}") as src:
            cells = region_cells(src, s, w, n, e)
        marshy = [c for c in cells if c[2]]
        if not marshy:
            raise SystemExit(f"{label}: no marsh in {name}: the region list is wrong")
        picks = {
            "highest": max(marshy, key=lambda c: (Fraction(c[2], c[3]), c[0], c[1])),
            "middle": min(
                marshy,
                key=lambda c: (abs(Fraction(c[2], c[3]) - Fraction(1, 2)), c[0], c[1]),
            ),
        }
        picks["near-30"] = min(marshy, key=lambda c: (abs(Fraction(c[2], c[3]) - Fraction(3, 10)), c[0], c[1]))
        halves = [c for c in marshy if Fraction(100 * c[2], c[3]).denominator == 2 and Fraction(100 * c[2], c[3]) > 2]
        if halves:
            picks["exact-half"] = min(halves, key=lambda c: (c[0], c[1]))  # n.5%: rounds up
        faint = [c for c in marshy if Fraction(100 * c[2], c[3]) < Fraction(3, 2)]
        if faint:
            picks["faint"] = min(faint, key=lambda c: (c[0], c[1]))
        clear = [c for c in cells if not c[2]]
        if clear:
            # the clear cell nearest the marsh: it lies in a written tile, so the readout decodes a transparent pixel
            hx, hy = picks["highest"][:2]
            picks["clear"] = min(
                clear, key=lambda c: ((c[0] - hx) ** 2 + (c[1] - hy) ** 2, c[0], c[1])
            )
        for kind, (x, y, m, tot) in picks.items():
            lat, lon = centre(x, y)
            points.append(
                {
                    "region": label,
                    "member": name,
                    "kind": kind,
                    "lat": lat,
                    "lon": lon,
                    "gx": x,
                    "gy": y,
                    "marsh": m,
                    "total": tot,
                    "share": share(m, tot),
                }
            )
    return {"members": len(names), "points": points}


if __name__ == "__main__":
    print(json.dumps(main(Path(sys.argv[1]))))
