"""Known answers for scripts/qa-kelp.mjs, read from the pinned release zip without pipeline/kelp.py.

Usage: python3 -B scripts/qa_kelp_truth.py <cache dir holding Intensifying_MHWs_Protection_Global_Kelp.zip>
→ JSON on stdout.

The pipeline counts subpixel centres on a 64 x 64 subgrid of each level-9 cell (GDAL rasterize). This script uses a
different method: for each QA cell it intersects the cell's lon/lat box with the polygons (shapely, after make_valid)
and takes the share of area, both projected to a Lambert azimuthal equal-area CRS centred on the cell (pyproj). It also
counts B, the 64 x 64 subpixels of the cell that a polygon boundary passes through: the drawn share can differ from the
exact one by at most B/4096 (spec 2026-10-07-kelp-forests-design.md, "Error bound").

Cells: in each of California (Monterey), southern Chile, Tasmania and South Africa (Cape Peninsula), the cell with the
highest share and the cell nearest 50% (a cell on a polygon edge); the densest cell in the Falklands and in Peru
(country field); the densest cell within 0.2° of the polygon nearest the antimeridian; and two cells with no kelp: the
clear cell nearest Monterey's densest one (in a tile the pipeline writes) and one in the open Pacific.
"""

import json
import sys
from math import floor
from pathlib import Path

import numpy as np
import pyogrio
import pyproj
import shapely

MEMBER = "Intensifying_MHWs_Protection_Global_Kelp/Data/Global_Floating_Kelp/Global_Kelp_Canopy_2-24.shp"
ZIP = "Intensifying_MHWs_Protection_Global_Kelp.zip"
Z = 9
D = 360 / (2 ** (Z + 1) * 256)  # a level-9 cell, degrees
SUB = 64
# (name, south, west, north, east)
REGIONS = [
    ("Monterey, California", 36.5, -122.0, 36.65, -121.85),
    ("Southern Chile", -53.7, -72.6, -53.4, -72.2),
    ("Tasmania", -43.3, 147.8, -43.0, 148.1),
    ("Cape Peninsula, South Africa", -34.2, 18.3, -34.0, 18.5),
]
FALKLANDS = ("Falklands", -51.9, -61.2, -51.6, -60.8)
OPEN_SEA = ("Open Pacific", 30.0, -140.0)


def cell_of(lat, lon):
    return floor((lon + 180) / D), floor((90 - lat) / D)


def cell_box(gx, gy):
    return shapely.box(
        -180 + gx * D, 90 - (gy + 1) * D, -180 + (gx + 1) * D, 90 - gy * D
    )


def centre(gx, gy):
    return 90 - (gy + 0.5) * D, -180 + (gx + 0.5) * D


class Kelp:
    def __init__(self, zpath: Path):
        df = pyogrio.read_dataframe(f"/vsizip/{zpath}/{MEMBER}", columns=["Country"])
        self.country = df["Country"].to_numpy()
        self.polys = shapely.make_valid(shapely.force_2d(df.geometry.to_numpy()))
        self.tree = shapely.STRtree(self.polys)

    def near(self, geom):
        return self.polys[self.tree.query(geom, predicate="intersects")]

    def quick_shares(self, idx):
        """{cell: planar share} for every cell the polygons idx touch: for picking cells only."""
        out = {}
        for p in self.polys[idx]:
            x0, y0, x1, y1 = shapely.bounds(p)
            for gx in range(floor((x0 + 180) / D), floor((x1 + 180) / D) + 1):
                for gy in range(floor((90 - y1) / D), floor((90 - y0) / D) + 1):
                    a = shapely.area(shapely.intersection(p, cell_box(gx, gy)))
                    if a > 0:
                        out[(gx, gy)] = out.get((gx, gy), 0.0) + a / D**2
        return out

    def truth(self, gx, gy):
        """(exact share in percent on an equal-area projection, B boundary subpixels) for one cell."""
        box = cell_box(gx, gy)
        lat, lon = centre(gx, gy)
        laea = pyproj.Transformer.from_crs(
            "EPSG:4326",
            f"+proj=laea +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m",
            always_xy=True,
        )

        def proj(g):
            return shapely.transform(
                g, lambda c: np.column_stack(laea.transform(c[:, 0], c[:, 1]))
            )

        polys = self.near(box)
        if not len(polys):
            return 0.0, 0
        inside = shapely.union_all(shapely.intersection(polys, box))
        share = 100 * shapely.area(proj(inside)) / shapely.area(proj(box))
        edges = shapely.intersection(shapely.union_all(shapely.boundary(polys)), box)
        step = D / SUB
        x0, y1 = -180 + gx * D, 90 - gy * D
        subs = shapely.box(
            x0 + np.repeat(np.arange(SUB), SUB) * step,
            y1 - (np.tile(np.arange(SUB), SUB) + 1) * step,
            x0 + (np.repeat(np.arange(SUB), SUB) + 1) * step,
            y1 - np.tile(np.arange(SUB), SUB) * step,
        )
        b = int(shapely.intersects(subs, edges).sum()) if not edges.is_empty else 0
        return float(share), b


def point(kelp, region, kind, gx, gy):
    share, b = kelp.truth(gx, gy)
    lat, lon = centre(gx, gy)
    return {
        "region": region,
        "kind": kind,
        "lat": lat,
        "lon": lon,
        "gx": gx,
        "gy": gy,
        "share": round(share, 4),
        "boundSubpixels": b,
        "boundPp": round(100 * b / SUB**2, 2),
    }


def main(cache: Path) -> dict:
    kelp = Kelp(cache / ZIP)
    points = []
    for name, s, w, n, e in [*REGIONS, FALKLANDS]:
        idx = kelp.tree.query(shapely.box(w, s, e, n), predicate="intersects")
        cells = kelp.quick_shares(idx)
        if not cells:
            raise SystemExit(f"{name}: no kelp in the box: the region list is wrong")
        dense = max(cells, key=lambda c: (cells[c], c))
        points.append(point(kelp, name, "densest", *dense))
        if name == FALKLANDS[0]:
            continue
        edge = min(cells, key=lambda c: (abs(cells[c] - 0.5), c))
        points.append(point(kelp, name, "edge", *edge))
        if name.startswith("Monterey"):
            # the clear cell nearest the densest, in its own level-9 tile: a written tile with a transparent pixel
            tx, ty = dense[0] // 256, dense[1] // 256
            for r in range(1, 256):
                ring = [
                    (dense[0] + dx, dense[1] + dy)
                    for dx in range(-r, r + 1)
                    for dy in range(-r, r + 1)
                    if max(abs(dx), abs(dy)) == r
                ]
                clear = [
                    c
                    for c in sorted(ring)
                    if c[0] // 256 == tx
                    and c[1] // 256 == ty
                    and not len(kelp.near(cell_box(*c)))
                ]
                if clear:
                    points.append(point(kelp, name, "clear-in-written-tile", *clear[0]))
                    break
    peru = np.flatnonzero(kelp.country == "Peru")
    cells = kelp.quick_shares(peru)
    points.append(
        point(kelp, "Peru", "densest", *max(cells, key=lambda c: (cells[c], c)))
    )
    # the polygon nearest ±180°, and the densest cell within 0.2° of it
    b = shapely.bounds(kelp.polys)
    far = int(np.argmax(np.maximum(np.abs(b[:, 0]), np.abs(b[:, 2]))))
    fx0, fy0, fx1, fy1 = b[far]
    idx = kelp.tree.query(
        shapely.box(fx0 - 0.2, fy0 - 0.2, fx1 + 0.2, fy1 + 0.2), predicate="intersects"
    )
    cells = kelp.quick_shares(idx)
    points.append(
        point(
            kelp,
            "Nearest the antimeridian",
            "densest",
            *max(cells, key=lambda c: (cells[c], c)),
        )
    )
    name, lat, lon = OPEN_SEA
    points.append(point(kelp, name, "open-sea", *cell_of(lat, lon)))
    return {"features": len(kelp.polys), "points": points}


if __name__ == "__main__":
    print(json.dumps(main(Path(sys.argv[1]))))
