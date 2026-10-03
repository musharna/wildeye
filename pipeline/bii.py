"""Biodiversity Intactness Index (NHM v2.1.1) as a geographic tile pyramid, five snapshots 2000–2020.

Spec: docs/superpowers/specs/2026-10-03-bii-design.md. The release is one zip of five float64 GeoTIFFs (EPSG:4326,
5 arc-minutes, 0–100 %, NaN = no data), CC BY-NC-SA 4.0. NHM's file server answers scripts with a Cloudflare
challenge, so the zip is downloaded once in a browser and read from the cache; its sha256 is pinned and any other file
is refused. Each year is resampled to 8192 × 4096 by nearest neighbour (the source is coarser, so a level-4 pixel holds
one source value exactly), averaged down for the coarser levels, put in 100 one-percent bins with one palette colour
each, and cut into 256-px tiles on Cesium's geographic tiling scheme with pipeline/hfp.py's helpers. All five years are
staged and measured against the budget before they replace the published ones; bii.json, written last, is what the
layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import logging
import os
import shutil
import time
from pathlib import Path

import numpy as np

from .atomic import write_atomic
from .hfp import TILE, _png, block_mean, tiles_for_level

log = logging.getLogger("bii")
ZIP_NAME = "bii-v2-1-1-nhm-data-portal.zip"
# sha256 of the zip as NHM served it to a browser, 2026-10-03 (45,890,222 B)
ZIP_SHA256 = "4bcc68c57396a0e82670f5319fcaeb747d7a52f9d91b21d36ae6a88d099178d1"
YEARS = (2000, 2005, 2010, 2015, 2020)
TIF = "bii-{year}_v2-1-1.tif"
DOWNLOAD = (
    "https://data.nhm.ac.uk/dataset/ed428544-c494-4289-961c-1a5adf8fae74/resource/"
    "c4c281c4-befa-4e1b-a162-ba2f25e5ae82/download/bii-v2-1-1-nhm-data-portal.zip"
)
SOURCE_CELLS = 12  # 5 arc-minutes: 12 cells a degree
NODATA = 100  # palette index of "no data" (transparent); bins are 0–99
BUDGET_BYTES = 40_000_000
# ColorBrewer YlGn, 9 classes: pale yellow (degraded) to dark green (intact)
RAMP = [
    (255, 255, 229),
    (247, 252, 185),
    (217, 240, 163),
    (173, 221, 142),
    (120, 198, 121),
    (65, 171, 93),
    (35, 132, 67),
    (0, 104, 55),
    (0, 69, 41),
]
SOURCE = {
    "id": "bii",
    "name": "Biodiversity Intactness Index v2.1.1 (Natural History Museum, London)",
    "doi": "10.5519/k33reyb6",
    "licence": "CC BY-NC-SA 4.0 (README and LICENSE.txt of the release); © The Trustees of the Natural History Museum, London",
    "citation": "De Palma, A., Contu, S., Thomas, G. E., Duffin, C., Nix, S., Purvis, A. (2024). The Biodiversity "
    "Intactness Index developed by The Natural History Museum, London, v2.1.1 (Open Access, Limited Release) "
    "[Data set]. Natural History Museum. https://doi.org/10.5519/k33reyb6",
}


def palette() -> list[tuple[int, int, int]]:
    """100 colours along the ramp, one per bin; distinct, so a tile pixel names its bin exactly."""
    out = []
    for k in range(100):
        f = k / 99 * (len(RAMP) - 1)
        i = min(int(f), len(RAMP) - 2)
        w = f - i
        out.append(
            tuple(int(round(a * (1 - w) + b * w)) for a, b in zip(RAMP[i], RAMP[i + 1]))
        )
    return out


def quantise(a: np.ndarray) -> np.ndarray:
    """Values → bins [k, k+1) for k = 0–98 and [99, 100]; NaN → NODATA. A value outside 0–100 is refused."""
    bad = ~np.isnan(a) & ((a < 0) | (a > 100))
    if bad.any():
        raise ValueError(
            f"{int(bad.sum())} values outside 0–100 (e.g. {float(a[bad][0])})"
        )
    out = np.full(a.shape, NODATA, np.uint8)
    ok = ~np.isnan(a)
    out[ok] = np.minimum(np.floor(a[ok]), 99).astype(np.uint8)
    return out


def pyramid(field: np.ndarray, max_level: int):
    """(z, bins) from max_level down to 0; each coarser level is the 2 × 2 average of the finer field, binned after."""
    for z in range(max_level, -1, -1):
        yield z, quantise(field)
        if z:
            field = block_mean(field, 2)


def check_grid(transform, width: int, height: int) -> None:
    """The source must be the global 5 arc-minute grid the nearest-neighbour index below assumes."""
    want = (
        (transform.a, 1 / SOURCE_CELLS),
        (transform.e, -1 / SOURCE_CELLS),
        (transform.c, -180.0),
        (transform.f, 90.0),
    )
    if (width, height) != (360 * SOURCE_CELLS, 180 * SOURCE_CELLS) or any(
        abs(got - exp) > 1e-6 for got, exp in want
    ):
        raise ValueError(
            f"source grid {width} × {height}, {tuple(transform)[:6]} is not global 5 arc-minutes"
        )


def nearest(src: np.ndarray, width: int) -> np.ndarray:
    """`src` (the global 5' grid) at width × width/2 by nearest neighbour: each pixel takes the source cell under its centre."""
    h, w = src.shape
    cols = np.floor((np.arange(width) + 0.5) * w / width).astype(np.intp)
    rows = np.floor((np.arange(width // 2) + 0.5) * h / (width // 2)).astype(np.intp)
    return src[np.ix_(rows, cols)].astype(np.float32)


def read_year(zip_path: Path, year: int) -> np.ndarray:
    """One year's raster from the zip, after checking its grid; float64 kept until binned (NaN = no data)."""
    import rasterio

    with rasterio.open(f"/vsizip/{zip_path.resolve()}/{TIF.format(year=year)}") as r:
        check_grid(r.transform, r.width, r.height)
        a = r.read(1)
        if r.nodata is not None and not np.isnan(r.nodata):
            a = np.where(a == r.nodata, np.nan, a)
    return a


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def checked_zip(cache: Path, want: str = ZIP_SHA256) -> Path:
    """The cached release zip; SystemExit naming the browser download when absent, ValueError when it is not the pinned file."""
    path = cache / ZIP_NAME
    if not path.exists():
        raise SystemExit(
            f"{path} is missing. NHM's file server refuses scripts (Cloudflare challenge): download\n  {DOWNLOAD}\n"
            f"in a browser (accepting its CC BY-NC-SA 4.0 terms) and put it at {path}"
        )
    got = sha256(path)
    if got != want:
        raise ValueError(
            f"{path}: sha256 {got} is not the pinned release {want}; a changed file needs a reviewed pin"
        )
    return path


def write_year(field: np.ndarray, out: Path, max_level: int) -> int:
    """Every tile of every level of one year under `out`. Returns bytes written."""
    pal = palette()
    pal_bytes = bytes(c for rgb in pal for c in rgb) + bytes(3 * (256 - len(pal)))
    trns = bytes([255] * NODATA + [0])
    total = 0
    for z, bins in pyramid(field, max_level):
        for (x, y), tile in tiles_for_level(bins, z):
            p = out / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = _png(np.ascontiguousarray(tile), pal_bytes, trns)
            p.write_bytes(data)
            total += len(data)
    return total


def main(argv=None, *, want_sha256: str = ZIP_SHA256, years=YEARS) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "bii",
    )
    ap.add_argument(
        "--max-level",
        type=int,
        default=4,
        help="finest tile level; 4 = 8192 × 4096, about 4.9 km",
    )
    ap.add_argument("--budget", type=int, default=BUDGET_BYTES)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    if TILE * 2 ** (a.max_level + 1) < 360 * SOURCE_CELLS:
        # nearest neighbour coarser than the source skips cells: the readout would no longer be the source value
        raise SystemExit(
            f"--max-level {a.max_level} is coarser than the 5' source; 4 or more keeps every cell"
        )
    t0 = time.time()
    zip_path = checked_zip(a.cache, want_sha256)
    staging = a.out_dir / ".bii.tmp"
    shutil.rmtree(staging, ignore_errors=True)
    sizes = {}
    try:
        for year in years:
            field = nearest(read_year(zip_path, year), TILE * 2 ** (a.max_level + 1))
            sizes[year] = write_year(field, staging / str(year), a.max_level)
            log.info(
                "%d: %.1f MB of tiles (%.0f s)",
                year,
                sizes[year] / 1e6,
                time.time() - t0,
            )
        if sum(sizes.values()) > a.budget:
            raise SystemExit(
                f"{sum(sizes.values()):,} B of tiles is over the {a.budget:,} B budget: nothing published"
            )
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    final, old = a.out_dir / "bii", a.out_dir / ".bii.old"
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(staging, final)
    shutil.rmtree(old, ignore_errors=True)
    write_atomic(
        a.out_dir / "bii.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "years": list(years),
            "maxLevel": a.max_level,
            "tile": "data/bii/{year}/{z}/{x}/{y}.png",
            "palette": [list(c) for c in palette()],
            "bins": "k = 0–98 is [k, k+1) %; 99 is [99, 100] %",
            "resolution": f"about {40075 / (TILE * 2 ** (a.max_level + 1)):.1f} km tiles of the 5 arc-minute (~10 km) source",
            "source": SOURCE,
            "bytes": sizes,
        },
    )
    log.info(
        "wrote %s: %d years, %.1f MB (%.0f s)",
        a.out_dir / "bii.json",
        len(sizes),
        sum(sizes.values()) / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
