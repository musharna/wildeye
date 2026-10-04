"""The share of each map cell that a binary 10 m raster marks, as a geographic tile pyramid (Cesium's scheme).

Shared by pipeline/tidal_marsh.py and pipeline/seagrass.py. A source GeoTIFF holds 1 where the class is and 0 where it
is not. Each source pixel is assigned, by its centre, to one pixel of the geographic tiling scheme at the finest level,
and each cell keeps two counts: class pixels (read) and all source pixels that fall in it (worked out from the source
grids, not read). A cell's share is the first over the second; where neighbouring source files overlap, an overlap
pixel adds to both counts alike. Longitude is taken modulo 360, so a file georeferenced past 180°E wraps to the west.
Coarser levels add the class counts of their four children and work their totals out the same way, so every level
holds an exact share. A painted pixel is the share in whole percent (1-100, a share under 1.5% drawn as 1).
"""

from __future__ import annotations

import io
import math
import os
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

TILE = 256
EARTH_KM = 6371.0088


class SourceChanged(ValueError):
    """The published file is not the one this pipeline was written for."""


def cell_index(origin: float, n: int, step: float, z: int, axis: str) -> np.ndarray:
    """Finest-level pixel (global, Cesium's geographic scheme) holding the centre of each of n source pixels."""
    centres = origin + (np.arange(n) + 0.5) * step
    if axis == "x":
        # modulo 360: a GeoTIFF georeferenced past 180°E (the tidal marsh release's 180W tiles) wraps west
        return np.floor((centres + 180) % 360 / 360 * 2 ** (z + 1) * TILE).astype(
            np.int64
        )
    return np.floor((90 - centres) / 180 * 2**z * TILE).astype(np.int64)


def row_areas_km2(top: float, rows: int, res: float) -> np.ndarray:
    """Area in km² of one res-degree source pixel in each of `rows` rows from latitude `top` down."""
    lat = np.radians(top - res * np.arange(rows + 1))
    return EARTH_KM**2 * math.radians(res) * (np.sin(lat[:-1]) - np.sin(lat[1:]))


class Grid:
    """Where one source GeoTIFF's pixel centres fall: global finest-level column and row of each column and row."""

    def __init__(self, transform, width: int, height: int, z: int):
        self.gx = cell_index(transform.c, width, transform.a, z, "x")
        self.gy = cell_index(transform.f, height, transform.e, z, "y")

    def counts(self, z: int, max_level: int):
        """([(first column, source columns per column) per run], first row, source rows per row) at level z.

        Columns come in one run, or two where the GeoTIFF crosses the antimeridian."""
        sx, sy = self.gx >> (max_level - z), self.gy >> (max_level - z)
        runs = np.split(sx, np.flatnonzero(np.diff(sx) < 0) + 1)
        return (
            [(r[0], np.bincount(r - r[0])) for r in runs],
            sy[0],
            np.bincount(sy - sy[0]),
        )


def accumulate(src, z: int, counts: dict, band_rows: int = 4096) -> float:
    """Add one GeoTIFF's class pixels to counts[(tx, ty)] (uint16 per finest pixel: at most ~16 x 16 source pixels, twice that on a seam); returns their km²."""
    from rasterio.windows import Window

    grid = Grid(src.transform, src.width, src.height, z)
    col_starts = np.flatnonzero(np.diff(grid.gx, prepend=grid.gx[0] - 1))
    cols = grid.gx[col_starts]
    areas = row_areas_km2(src.transform.f, src.height, src.transform.a)
    row_starts = np.flatnonzero(np.diff(grid.gy, prepend=grid.gy[0] - 1))
    row_ends = np.append(row_starts[1:], src.height)
    km2 = 0.0
    i = 0
    while i < len(row_starts):
        # a band of whole finest rows, about band_rows source rows
        j = i
        while j < len(row_starts) and row_ends[j] - row_starts[i] <= band_rows:
            j += 1
        j = max(j, i + 1)
        r0, r1 = row_starts[i], row_ends[j - 1]
        a = src.read(1, window=Window(0, r0, src.width, r1 - r0))
        if a.max(initial=0) > 1:
            raise SourceChanged(f"{src.name}: values above 1 in rows {r0}-{r1}")
        if a.any():
            km2 += float(a.sum(axis=1, dtype=np.int64) @ areas[r0:r1])
            for k in range(i, j):
                rows = a[row_starts[k] - r0 : row_ends[k] - r0]
                if not rows.any():
                    continue
                per_col = np.add.reduceat(rows.sum(axis=0, dtype=np.uint32), col_starts)
                gy = int(grid.gy[row_starts[k]])
                for c in np.flatnonzero(per_col):
                    gx = int(cols[c])
                    t = counts.get((gx // TILE, gy // TILE))
                    if t is None:
                        t = counts[(gx // TILE, gy // TILE)] = np.zeros(
                            (TILE, TILE), np.uint16
                        )
                    t[gy % TILE, gx % TILE] += per_col[c]
        i = j
    return km2


def totals(tiles, grids: list[Grid], z: int, max_level: int) -> dict:
    """{(tx, ty): source pixels per pixel} at level z for the given tiles, worked out from every source grid."""
    per = [g.counts(z, max_level) for g in grids]
    out = {}
    for tx, ty in tiles:
        t = np.zeros((TILE, TILE), np.uint64)
        x0, y0 = tx * TILE, ty * TILE
        for runs, gy0, cy in per:
            ys = slice(max(y0, gy0), min(y0 + TILE, gy0 + len(cy)))
            if ys.start >= ys.stop:
                continue
            for gx0, cx in runs:
                xs = slice(max(x0, gx0), min(x0 + TILE, gx0 + len(cx)))
                if xs.start >= xs.stop:
                    continue
                t[ys.start - y0 : ys.stop - y0, xs.start - x0 : xs.stop - x0] += (
                    np.outer(
                        cy[ys.start - gy0 : ys.stop - gy0],
                        cx[xs.start - gx0 : xs.stop - gx0],
                    ).astype(np.uint64)
                )
        out[(tx, ty)] = t
    return out


def coarser(counts: dict) -> dict:
    """The next coarser level's class counts: the sum of each 2 x 2 (absent children hold none)."""
    parents: dict = {}
    for (x, y), arr in counts.items():
        big = parents.setdefault(
            (x // 2, y // 2), np.zeros((2 * TILE, 2 * TILE), np.uint64)
        )
        oy, ox = (y % 2) * TILE, (x % 2) * TILE
        big[oy : oy + TILE, ox : ox + TILE] = arr
    return {k: v.reshape(TILE, 2, TILE, 2).sum(axis=(1, 3)) for k, v in parents.items()}


def shares(counts: np.ndarray, total: np.ndarray) -> np.ndarray:
    """Palette indices: the class share in whole percent, halves up, 1-100 where there is any of it, else 0.

    In integers, so a share of exactly n.5% (138 of 240) rounds the same way every time."""
    if (total[counts > 0] == 0).any():
        raise SourceChanged("class pixels counted in a cell no source pixel falls in")
    if (counts > total).any():
        raise SourceChanged("more class pixels than source pixels in a cell: the counts are out of step")
    m, t = counts.astype(np.int64), np.maximum(total, 1).astype(np.int64)
    pct = (200 * m + t) // (2 * t)
    return np.where(counts > 0, np.clip(pct, 1, 100), 0).astype(np.uint8)


def ramp(stops) -> list[list[int]]:
    """101 colours: index 0 (transparent) then shares 1-100 interpolated through (share, rgb) stops."""
    out = [[0, 0, 0]]
    for i in range(1, 101):
        (a, ca), (b, cb) = next(
            (lo, hi) for lo, hi in zip(stops, stops[1:]) if lo[0] <= i <= hi[0]
        )
        t = (i - a) / (b - a)
        out.append([round(x + (y - x) * t) for x, y in zip(ca, cb)])
    return out


def png(arr: np.ndarray, palette: list[list[int]]) -> bytes:
    im = Image.fromarray(np.ascontiguousarray(arr), "P")
    im.putpalette(bytes(c for rgb in palette for c in rgb))
    buf = io.BytesIO()
    # bits=8: the readout's decoder (src/data/pngDecode.js) reads 8-bit images only
    im.save(
        buf,
        "PNG",
        optimize=True,
        bits=8,
        transparency=bytes([0] + [255] * (len(palette) - 1)),
    )
    return buf.getvalue()


def replace_dir(tmp: Path, final: Path) -> None:
    old = final.with_name(f".{final.name}.old")
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(tmp, final)
    shutil.rmtree(old, ignore_errors=True)


def write_pyramid(
    finest: dict, grids: list[Grid], tile_dir: Path, *, max_level: int, palette
) -> tuple[dict, int]:
    """Painted tiles of every level into tile_dir/{z}/{x}/{y}.png; returns ({level: sorted [x, y]}, bytes written)."""
    listed: dict[str, list[list[int]]] = {}
    tile_bytes = 0
    counts = finest
    for z in range(max_level, -1, -1):
        tot = totals(counts, grids, z, max_level)
        listed[str(z)] = sorted([x, y] for x, y in counts)
        for (x, y), arr in counts.items():
            p = tile_dir / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = png(shares(arr, tot[(x, y)]), palette)
            p.write_bytes(data)
            tile_bytes += len(data)
        if z:
            counts = coarser(counts)
    return listed, tile_bytes
