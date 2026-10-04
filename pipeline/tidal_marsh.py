"""Global tidal marshes 2020 (Worthington et al. 2024, Zenodo 8420753 v2.6, CC BY 4.0) → a geographic tile pyramid of
the share of each cell that is tidal marsh.

Spec: docs/superpowers/specs/2026-10-04-tidal-marshes-design.md. The zip of 154 GeoTIFFs (10° tiles, 10 m, uint8, 1 =
tidal marsh, 0 = not, 60°N to 60°S) is pinned by sha256 and read in place through GDAL's /vsizip/, row bands in file
order. Each 10 m pixel is assigned, by its centre, to one pixel of Cesium's geographic tiling scheme at level MAX_LEVEL
(~150 m at the equator), and each cell keeps two counts: marsh pixels, and all pixels of the source that fall in it,
the second worked out from the source grids rather than read. A cell's share is the first over the second; neighbouring
source tiles overlap by up to one pixel, and an overlap pixel adds to both counts alike. Longitude is taken modulo 360:
the release georeferences its 180W tiles at 180-190°E, so their first column falls at the east edge of the world and the
rest at its west edge. Coarser levels add the marsh
counts of their four children and work their totals out the same way, so every level holds an exact share. A painted
pixel is the share in whole percent (1-100, a share under 1.5% drawn as 1); unpainted means no marsh mapped there.
Only painted tiles are written; tidal_marsh.json, written last, lists them and is what the layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import logging
import math
import os
import re
import shutil
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("tidal_marsh")

ZIP_NAME = "tidal_marsh_v2_6.zip"
ZIP_URL = "https://zenodo.org/api/records/8420753/files/tidal_marsh_v2_6.zip/content"
# the file served 2026-10-04: Zenodo lists md5 1bab179f7506b3525d2e9a2c28e27001 for it
ZIP_SHA256 = "931ca7c24c2f683993cadec6a5f8372de87ba3fb8b07a7900e4f41c1873612e8"
MEMBER = re.compile(r"^Final_Rasters/tidal_marsh_\d{1,3}[EW]_\d{1,2}[NS]_v2_6\.tif$")
RES = 8.983152841195213e-05  # degrees: the release's one pixel size (1/11132.0°, ~10 m)
TILE = 256
MAX_LEVEL = (
    9  # 1024 x 512 tiles at the finest level: 0.00137°, about 150 m at the equator
)
EARTH_KM = 6371.0088
UA = "wildeye/0.1 (tidal marshes; +https://github.com/musharna)"
# share 1-100% → light green to deep blue (palette index = share); index 0 is transparent
RAMP = ((1, (199, 233, 180)), (50, (29, 145, 192)), (100, (8, 29, 88)))
SOURCE = {
    "name": "Global tidal marshes 2020, v2.6",
    "author": "Worthington, Spalding, Landis, Maxwell, Navarro, Smart and Murray",
    "url": "https://doi.org/10.5281/zenodo.8420753",
    "licence": "CC BY 4.0",
    "cite": "Worthington et al. 2024, Global Ecology and Biogeography 33: e13852, doi:10.1111/geb.13852",
}


class MarshChanged(ValueError):
    """The published file is not the one this pipeline was written for."""


def palette() -> list[list[int]]:
    out = [[0, 0, 0]]
    for i in range(1, 101):
        (a, ca), (b, cb) = next(
            (lo, hi) for lo, hi in zip(RAMP, RAMP[1:]) if lo[0] <= i <= hi[0]
        )
        t = (i - a) / (b - a)
        out.append([round(x + (y - x) * t) for x, y in zip(ca, cb)])
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_to(url: str, path: Path) -> None:
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=1800
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch(
    cache: Path, *, sha256: str = ZIP_SHA256, url: str = ZIP_URL, fetch_to=_fetch_to
) -> Path:
    """The release zip, downloaded once; refused (and not kept) unless its sha256 is the pinned one."""
    path = cache / ZIP_NAME
    if path.exists():
        got = _sha256(path)
        if got != sha256:
            raise MarshChanged(
                f"{path}: sha256 {got} is not the pinned {sha256}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    log.info("downloading %s", url)
    try:
        fetch_to(url, part)
        got = _sha256(part)
        if got != sha256:
            raise MarshChanged(f"{url}: sha256 {got} is not the pinned {sha256}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def members(zip_path: Path) -> list[str]:
    """The release's GeoTIFFs, by name; anything else in the zip but its folder is refused."""
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
    tifs = sorted(n for n in names if MEMBER.match(n))
    other = [n for n in names if n not in tifs and n != "Final_Rasters/"]
    if other or not tifs:
        raise MarshChanged(
            f"{zip_path.name}: unexpected members {other[:5]} ({len(tifs)} GeoTIFFs)"
        )
    return tifs


def check_profile(src, name: str) -> None:
    """Refused unless one uint8 band, EPSG:4326, the release's pixel size, north-up, within 60°N-60°S."""
    t = src.transform
    problems = [
        what
        for what, ok in [
            (f"{src.count} bands", src.count == 1),
            (f"dtype {src.dtypes[0]}", src.dtypes[0] == "uint8"),
            (f"crs {src.crs}", src.crs is not None and src.crs.to_epsg() == 4326),
            (
                f"pixel {t.a}, {t.e}",
                math.isclose(t.a, RES, rel_tol=1e-9)
                and math.isclose(-t.e, RES, rel_tol=1e-9),
            ),
            ("rotated", t.b == 0 and t.d == 0),
            (
                f"bounds {src.bounds}",
                src.bounds.top <= 60.001 and src.bounds.bottom >= -60.001,
            ),
        ]
        if not ok
    ]
    if problems:
        raise MarshChanged(f"{name}: {'; '.join(problems)}")


def cell_index(origin: float, n: int, step: float, z: int, axis: str) -> np.ndarray:
    """Finest-level pixel (global, Cesium's geographic scheme) holding the centre of each of n source pixels."""
    centres = origin + (np.arange(n) + 0.5) * step
    if axis == "x":
        # modulo 360: a 180W GeoTIFF lies at 180-190°E
        return np.floor((centres + 180) % 360 / 360 * 2 ** (z + 1) * TILE).astype(
            np.int64
        )
    return np.floor((90 - centres) / 180 * 2**z * TILE).astype(np.int64)


def row_areas_km2(top: float, rows: int) -> np.ndarray:
    """Area in km² of one source pixel in each of `rows` rows from latitude `top` down."""
    lat = np.radians(top - RES * np.arange(rows + 1))
    return EARTH_KM**2 * math.radians(RES) * (np.sin(lat[:-1]) - np.sin(lat[1:]))


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
        return [(r[0], np.bincount(r - r[0])) for r in runs], sy[0], np.bincount(sy - sy[0])


def accumulate(src, z: int, marsh: dict, band_rows: int = 4096) -> float:
    """Add one GeoTIFF's marsh pixels to marsh[(tx, ty)] (uint16 counts per finest pixel: at most ~16 x 16 source pixels, twice that on a seam); returns its marsh km²."""
    from rasterio.windows import Window

    grid = Grid(src.transform, src.width, src.height, z)
    col_starts = np.flatnonzero(np.diff(grid.gx, prepend=grid.gx[0] - 1))
    cols = grid.gx[col_starts]
    areas = row_areas_km2(src.transform.f, src.height)
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
            raise MarshChanged(f"{src.name}: values above 1 in rows {r0}-{r1}")
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
                    t = marsh.get((gx // TILE, gy // TILE))
                    if t is None:
                        t = marsh[(gx // TILE, gy // TILE)] = np.zeros(
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
                t[ys.start - y0 : ys.stop - y0, xs.start - x0 : xs.stop - x0] += np.outer(
                    cy[ys.start - gy0 : ys.stop - gy0], cx[xs.start - gx0 : xs.stop - gx0]
                ).astype(np.uint64)
        out[(tx, ty)] = t
    return out


def coarser(marsh: dict) -> dict:
    """The next coarser level's marsh counts: the sum of each 2 x 2 (absent children hold none)."""
    parents: dict = {}
    for (x, y), arr in marsh.items():
        big = parents.setdefault(
            (x // 2, y // 2), np.zeros((2 * TILE, 2 * TILE), np.uint64)
        )
        oy, ox = (y % 2) * TILE, (x % 2) * TILE
        big[oy : oy + TILE, ox : ox + TILE] = arr
    return {k: v.reshape(TILE, 2, TILE, 2).sum(axis=(1, 3)) for k, v in parents.items()}


def shares(marsh: np.ndarray, total: np.ndarray) -> np.ndarray:
    """Palette indices: the marsh share in whole percent, halves up, 1-100 where there is any marsh, else 0.

    In integers, so a share of exactly n.5% (138 of 240) rounds the same way every time."""
    if (total[marsh > 0] == 0).any():
        raise MarshChanged("marsh counted in a cell no source pixel falls in")
    if (marsh > total).any():
        raise MarshChanged("more marsh pixels than source pixels in a cell: the counts are out of step")
    m, t = marsh.astype(np.int64), np.maximum(total, 1).astype(np.int64)
    pct = (200 * m + t) // (2 * t)
    return np.where(marsh > 0, np.clip(pct, 1, 100), 0).astype(np.uint8)


def png(arr: np.ndarray) -> bytes:
    im = Image.fromarray(np.ascontiguousarray(arr), "P")
    im.putpalette(bytes(c for rgb in palette() for c in rgb))
    buf = io.BytesIO()
    # bits=8: the readout's decoder (src/data/pngDecode.js) reads 8-bit images only
    im.save(buf, "PNG", optimize=True, bits=8, transparency=bytes([0] + [255] * 100))
    return buf.getvalue()


def _replace_dir(tmp: Path, final: Path) -> None:
    old = final.with_name(f".{final.name}.old")
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(tmp, final)
    shutil.rmtree(old, ignore_errors=True)


def write(
    finest: dict,
    grids: list[Grid],
    meta: dict,
    out_dir: Path,
    *,
    max_level: int,
    now=None,
) -> dict:
    """Tiles into out_dir/tidal_marsh (replaced whole), then out_dir/tidal_marsh.json; returns the manifest."""
    tmp = out_dir / ".tidal_marsh.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    listed: dict[str, list[list[int]]] = {}
    tile_bytes = 0
    marsh = finest
    for z in range(max_level, -1, -1):
        tot = totals(marsh, grids, z, max_level)
        listed[str(z)] = sorted([x, y] for x, y in marsh)
        for (x, y), arr in marsh.items():
            p = tmp / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = png(shares(arr, tot[(x, y)]))
            p.write_bytes(data)
            tile_bytes += len(data)
        if z:
            marsh = coarser(marsh)
    _replace_dir(tmp, out_dir / "tidal_marsh")
    when = (now or (lambda: dt.datetime.now(dt.UTC)))()
    manifest = {
        "generated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxLevel": max_level,
        "tile": "data/tidal_marsh/{z}/{x}/{y}.png",
        "tiles": listed,
        "palette": palette(),
        "year": 2020,
        "version": "2.6",
        **meta,
        "tileBytes": tile_bytes,
        "source": SOURCE,
    }
    write_atomic(
        out_dir / "tidal_marsh.json", manifest
    )  # last: the layer reads this one
    return manifest


def main(argv=None, *, fetch_to=_fetch_to, sha256=ZIP_SHA256, now=None) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "tidal_marsh",
    )
    ap.add_argument("--max-level", type=int, default=MAX_LEVEL)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    import rasterio

    zip_path = fetch(a.cache, sha256=sha256, fetch_to=fetch_to)
    names = members(zip_path)
    marsh: dict = {}
    grids, km2 = [], 0.0
    for n, name in enumerate(names, start=1):
        with rasterio.open(f"/vsizip/{zip_path}/{name}") as src:
            check_profile(src, name)
            grids.append(Grid(src.transform, src.width, src.height, a.max_level))
            got = accumulate(src, a.max_level, marsh)
        km2 += got
        log.info("%d/%d %s: %.1f km² of marsh", n, len(names), name, got)
    meta = {"members": len(names), "marshKm2": round(km2, 1)}
    manifest = write(marsh, grids, meta, a.out_dir, max_level=a.max_level, now=now)
    log.info(
        "%.0f km² of tidal marsh; %d finest tiles, %d in all, %.1f MB",
        km2,
        len(marsh),
        sum(len(v) for v in manifest["tiles"].values()),
        manifest["tileBytes"] / 1e6,
    )
    return manifest


if __name__ == "__main__":
    main()
