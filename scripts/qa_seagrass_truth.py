"""Known answers for scripts/qa-seagrass.mjs, read from the pinned release zips without pipeline/seagrass.py.

Usage: python3 -B scripts/qa_seagrass_truth.py <cache dir holding GlobalSeagrass2019_2020.zip and 2023_2024.zip>
→ JSON on stdout.

For each coastal region it reads, in each epoch's zip, the 10 m window of the one GeoTIFF that covers it and counts, for
every level-9 pixel of Cesium's geographic tiling scheme whose source pixels all lie inside the window, the source
pixels whose centre falls in it and how many are seagrass (np.unique over the pixels' cell keys, not the pipeline's
per-row sums). From the 2023-2024 counts of each region it takes the cell with the highest share, the cells nearest 50%
and 30%, and where there are such cells, one at exactly n.5%, one under 1.5% and one with none; it gives each cell's
centre and its share in both epochs in whole percent, halves up (Fraction), any seagrass at least 1.
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
EPOCHS = ["2019_2020", "2023_2024"]
# (name, south, west, north, east): seagrass meadows, each inside one GeoTIFF of the release's export grid
REGIONS = [
    ("Florida Bay, Florida", 24.95, -80.85, 25.15, -80.6),
    ("Shark Bay, Western Australia", -25.95, 113.65, -25.75, 113.9),
    ("Moreton Bay, Queensland", -27.45, 153.25, -27.25, 153.4),
    ("Banc d'Arguin, Mauritania", 19.9, -16.45, 20.15, -16.25),
    ("Bay of Palma, Mallorca", 39.45, 2.55, 39.55, 2.75),
    ("Gazi Bay, Kenya", -4.48, 39.45, -4.36, 39.58),
]


def share(m: int, t: int) -> int:
    if not m:
        return 0
    return max(1, min(100, floor(Fraction(100 * m, t) + Fraction(1, 2))))


def centre(gx: int, gy: int) -> tuple[float, float]:
    return 90 - (gy + 0.5) / ROWS * 180, (gx + 0.5) / COLS * 360 - 180


def region_cells(src, s, w, n, e) -> dict:
    """{(gx, gy): (seagrass, total)} for the level-9 cells wholly inside the window."""
    win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths()
    a = src.read(1, window=win)
    t = src.window_transform(win)
    lon = t.c + (np.arange(a.shape[1]) + 0.5) * t.a
    lat = t.f + (np.arange(a.shape[0]) + 0.5) * t.e
    gx = np.floor((lon + 180) % 360 / 360 * COLS).astype(np.int64)
    gy = np.floor((90 - lat) / 180 * ROWS).astype(np.int64)
    keys = (gy[:, None] * COLS + gx[None, :]).ravel()
    uniq, inv, total = np.unique(keys, return_inverse=True, return_counts=True)
    grass = np.bincount(inv, weights=a.ravel().astype(np.float64)).astype(np.int64)
    # a cell cut by the window's edge holds pixels outside it: only cells strictly inside are kept
    out = {}
    for k, m, tot in zip(uniq.tolist(), grass.tolist(), total.tolist()):
        y, x = divmod(k, COLS)
        if gx[0] < x < gx[-1] and gy[0] < y < gy[-1]:
            out[(x, y)] = (m, tot)
    return out


def epoch_cells(zpath: Path):
    with zipfile.ZipFile(zpath) as z:
        names = sorted(n for n in z.namelist() if n.endswith(".tif"))
    bounds = {}
    for name in names:
        with rasterio.open(f"/vsizip/{zpath}/{name}") as src:
            bounds[name] = src.bounds
    cells = {}
    for label, s, w, n, e in REGIONS:
        covering = [
            k
            for k, b in bounds.items()
            if b.left < w and b.right > e and b.bottom < s and b.top > n
        ]
        if len(covering) != 1:
            raise SystemExit(
                f"{zpath.name} {label}: {len(covering)} GeoTIFFs cover it: the region list is wrong"
            )
        with rasterio.open(f"/vsizip/{zpath}/{covering[0]}") as src:
            cells[label] = region_cells(src, s, w, n, e)
    return len(names), cells


def main(cache: Path) -> dict:
    members, cells = {}, {}
    for epoch in EPOCHS:
        members[epoch], cells[epoch] = epoch_cells(cache / f"GlobalSeagrass{epoch}.zip")
    points = []
    for label, *_ in REGIONS:
        now, then = cells["2023_2024"][label], cells["2019_2020"][label]
        if now.keys() != then.keys():
            raise SystemExit(f"{label}: the two epochs' windows hold different cells")
        grassy = [(x, y, m, t) for (x, y), (m, t) in now.items() if m]
        if not grassy:
            raise SystemExit(
                f"{label}: no seagrass in 2023-2024: the region list is wrong"
            )

        def near(f):
            return min(
                grassy, key=lambda c: (abs(Fraction(c[2], c[3]) - f), c[0], c[1])
            )

        picks = {
            "highest": max(grassy, key=lambda c: (Fraction(c[2], c[3]), c[0], c[1])),
            "middle": near(Fraction(1, 2)),
            "near-30": near(Fraction(3, 10)),
        }
        halves = [
            c
            for c in grassy
            if Fraction(100 * c[2], c[3]).denominator == 2
            and Fraction(100 * c[2], c[3]) > 2
        ]
        if halves:
            picks["exact-half"] = min(
                halves, key=lambda c: (c[0], c[1])
            )  # n.5%: rounds up
        faint = [c for c in grassy if Fraction(100 * c[2], c[3]) < Fraction(3, 2)]
        if faint:
            picks["faint"] = min(faint, key=lambda c: (c[0], c[1]))
        clear = [(x, y, m, t) for (x, y), (m, t) in now.items() if not m]
        if clear:
            # the clear cell nearest the meadow: it lies in a written tile, so the readout decodes a transparent pixel
            hx, hy = picks["highest"][:2]
            picks["clear"] = min(
                clear, key=lambda c: ((c[0] - hx) ** 2 + (c[1] - hy) ** 2, c[0], c[1])
            )
        for kind, (x, y, m, tot) in picks.items():
            lat, lon = centre(x, y)
            m0, t0 = then[(x, y)]
            points.append(
                {
                    "region": label,
                    "kind": kind,
                    "lat": lat,
                    "lon": lon,
                    "gx": x,
                    "gy": y,
                    "total": tot,
                    "grass": {"2023_2024": m, "2019_2020": m0},
                    "share": {"2023_2024": share(m, tot), "2019_2020": share(m0, t0)},
                }
            )
    return {"members": members, "points": points}


if __name__ == "__main__":
    print(json.dumps(main(Path(sys.argv[1]))))
