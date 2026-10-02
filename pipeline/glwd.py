"""Wetlands from the Global Lakes and Wetlands Database v2 (Lehner et al. 2025) as a geographic tile pyramid.

Spec: docs/superpowers/specs/2026-10-01-wetlands-design.md. GLWD's `main_class_50pct` grid (15″, ~500 m, lon/lat,
56°S–84°N) gives the dominant of 33 wetland classes where wetland covers more than half the cell, 0 where it does not
and 255 over the sea. It comes in one zip on figshare 28519994 v1 (CC BY 4.0) whose md5 is pinned here; a file that
differs, cached or fetched, is refused. Every level of Cesium's geographic tiling scheme is warped straight from the
500 m grid by mode with the sea excluded, so a coastal pixel takes the majority of its land cells. Tile palette
index = class id, NODATA for the sea; dryland and sea are both transparent and told apart by colour. Only these
rendered tiles are published: the authors ask that the data not be redistributed in its original format. Every tile is
written, empty ones too; glwd.json, written last, is what the layer reads.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import logging
import os
import shutil
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

from .atomic import write_atomic
from .hfp import TILE, _md5, _png, tiles_for_level
from .net import urlopen

log = logging.getLogger("glwd")
FILE_URL = "https://ndownloader.figshare.com/files/{}"
# (figshare file id, figshare's md5) of GLWD_v2_0_combined_classes_tif.zip, read from the v1 article API 2026-10-01
SOURCE = (54001814, "aea80ff46211b349ffbaa871442fd0ed")
INNER = "GLWD_v2_0_combined_classes/GLWD_v2_0_main_class_50pct.tif"
LEGEND = "GLWD_Legend_v2_0.csv"
SRC_NODATA = 255
NODATA = 34  # tile palette index of the sea / outside the data; 0 is dryland, 1–33 the classes
DRYLAND_RGB = (0, 0, 0)
NODATA_RGB = (255, 255, 255)
UA = "wildeye/0.1 (wetlands)"
FAMILIES = (
    "Lakes and open water",
    "Rivers and riverine wetlands",
    "Marshes and swamps",
    "Peatlands",
    "Coastal wetlands",
    "Salt pans",
    "Ephemeral wetlands",
    "Rice paddies",
)
_W, _R, _M, _P, _C, _S, _E, _RP = FAMILIES
# class id → (colour, family); names come from GLWD's legend CSV, not from here
CLASS_COLOURS = {
    1: ((31, 120, 180), _W),  # freshwater lake
    2: ((107, 174, 214), _W),  # saline lake
    3: ((8, 69, 148), _W),  # reservoir
    6: ((158, 202, 225), _W),  # other permanent waterbody
    4: ((0, 109, 119), _R),  # large river
    5: ((0, 150, 136), _R),  # large estuarine river
    7: ((102, 194, 165), _R),  # small streams
    10: ((1, 102, 94), _R),  # riverine, regularly flooded, forested
    11: ((90, 180, 172), _R),
    12: ((0, 128, 110), _R),
    13: ((128, 205, 193), _R),
    14: ((20, 90, 80), _R),
    15: ((170, 222, 210), _R),  # riverine, seasonally saturated, non-forested
    8: ((35, 110, 50), _M),  # lacustrine, forested
    9: ((120, 190, 110), _M),
    16: ((0, 90, 40), _M),  # palustrine, regularly flooded, forested
    17: ((65, 171, 93), _M),
    18: ((40, 130, 60), _M),
    19: ((161, 217, 155), _M),
    22: ((102, 64, 32), _P),  # arctic/boreal peatland, forested
    23: ((170, 120, 70), _P),
    24: ((120, 72, 40), _P),  # temperate
    25: ((190, 140, 90), _P),
    26: ((84, 48, 5), _P),  # tropical/subtropical
    27: ((140, 81, 10), _P),
    28: ((118, 42, 131), _C),  # mangrove
    29: ((153, 112, 171), _C),  # saltmarsh
    30: ((194, 165, 207), _C),  # large river delta
    31: ((90, 30, 110), _C),  # other coastal wetland
    32: ((241, 105, 163), _S),  # salt pan, saline/brackish wetland
    20: ((166, 130, 80), _E),  # ephemeral, forested
    21: ((223, 194, 125), _E),
    33: ((240, 200, 30), _RP),  # rice paddies
}
SOURCE_META = {
    "id": "glwd",
    "name": "Global Lakes and Wetlands Database v2 (Lehner et al.)",
    "doi": "10.5194/essd-17-2277-2025",
    "data": "https://doi.org/10.6084/m9.figshare.28519994.v1",
    "site": "https://www.hydrosheds.org/products/glwd",
    "licence": "CC BY 4.0 (GLWD Technical Documentation 4.1); rendered tiles only, the data are not redistributed",
    "citation": "Lehner, B., Anand, M., Fluet-Chouinard, E., Tan, F., et al. (2025). Mapping the world's inland surface "
    "waters: an upgrade to the Global Lakes and Wetlands Database (GLWD v2). Earth System Science Data 17, 2277–2329. "
    "doi:10.5194/essd-17-2277-2025",
}


def read_legend(zip_path: Path) -> dict[int, str]:
    """GLWD's own class names, id → name, from the legend CSV in the zip; anything but ids 0–33 is refused."""
    with zipfile.ZipFile(zip_path) as z:
        text = z.read(LEGEND).decode("ascii")
    legend = {
        int(r["GLWD_ID"]): r["Class_name"].strip()
        for r in csv.DictReader(io.StringIO(text))
    }
    if sorted(legend) != list(range(34)):
        raise ValueError(f"{LEGEND}: legend ids {sorted(legend)} are not 0–33")
    return legend


def render_level(grid: np.ndarray, transform, z: int) -> np.ndarray:
    """Level z of the geographic pyramid (2^(z+1) × 2^z tiles) from the source grid: the mode of the cells under each
    pixel, the sea not voting; a pixel with no land cells is NODATA."""
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    w, h = TILE * 2 ** (z + 1), TILE * 2**z
    dst = np.full((h, w), SRC_NODATA, np.uint8)
    reproject(
        grid,
        dst,
        src_transform=transform,
        src_crs="EPSG:4326",
        src_nodata=SRC_NODATA,
        dst_transform=from_bounds(-180, -90, 180, 90, w, h),
        dst_crs="EPSG:4326",
        dst_nodata=SRC_NODATA,
        resampling=Resampling.mode,
        num_threads=4,
    )
    bad = (dst > 33) & (dst != SRC_NODATA)
    if bad.any():
        raise ValueError(
            f"{int(bad.sum())} pixels hold values outside 0–33 (e.g. {int(dst[bad][0])})"
        )
    dst[dst == SRC_NODATA] = NODATA
    return dst


def _fetch_to(url: str, path: Path) -> None:
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=1800
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch_source(cache: Path, *, fetch_to=_fetch_to, source=SOURCE) -> Path:
    """The pinned zip, downloaded once; refused (and not kept) unless its md5 is figshare's."""
    file_id, want = source
    path = cache / "GLWD_v2_0_combined_classes_tif.zip"
    if path.exists():
        got = _md5(path)
        if got != want:
            raise ValueError(
                f"{path}: md5 {got} is not figshare's {want}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".zip.part")
    url = FILE_URL.format(file_id)
    log.info("downloading %s → %s", url, path)
    try:
        fetch_to(url, part)
        got = _md5(part)
        if got != want:
            raise ValueError(f"{url}: md5 {got} is not figshare's {want}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def main(argv=None, *, fetch_to=_fetch_to, source=SOURCE):
    import rasterio

    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "glwd",
    )
    ap.add_argument(
        "--max-level",
        type=int,
        default=6,
        help="finest tile level; 6 = 32768 × 16384, about 1.2 km",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    zip_path = fetch_source(a.cache, fetch_to=fetch_to, source=source)
    legend = read_legend(zip_path)
    with rasterio.open(f"/vsizip/{zip_path.resolve()}/{INNER}") as r:
        grid, transform = r.read(1), r.transform
    log.info("read %d × %d (%.0f s)", grid.shape[1], grid.shape[0], time.time() - t0)
    pal = [DRYLAND_RGB] + [CLASS_COLOURS[k][0] for k in range(1, 34)] + [NODATA_RGB]
    pal_bytes = bytes(c for rgb in pal for c in rgb)
    trns = bytes([0] + [255] * 33 + [0])
    final, tmp, old = (
        a.out_dir / "glwd",
        a.out_dir / ".glwd.tmp",
        a.out_dir / ".glwd.old",
    )
    shutil.rmtree(tmp, ignore_errors=True)
    total = 0
    for z in range(a.max_level, -1, -1):
        level = render_level(grid, transform, z)
        for (x, y), tile in tiles_for_level(level, z):
            p = tmp / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = _png(np.ascontiguousarray(tile), pal_bytes, trns)
            p.write_bytes(data)
            total += len(data)
        log.info("level %d: %.1f MB so far (%.0f s)", z, total / 1e6, time.time() - t0)
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(tmp, final)
    shutil.rmtree(old, ignore_errors=True)
    write_atomic(
        a.out_dir / "glwd.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "maxLevel": a.max_level,
            "tile": "data/glwd/{z}/{x}/{y}.png",
            "resolution": f"about {40075 / (TILE * 2 ** (a.max_level + 1)):.1f} km at the equator, mode of 500 m cells",
            "dryland": list(DRYLAND_RGB),
            "noData": list(NODATA_RGB),
            "classes": [
                {
                    "id": k,
                    "name": legend[k],
                    "rgb": list(CLASS_COLOURS[k][0]),
                    "family": CLASS_COLOURS[k][1],
                }
                for k in range(1, 34)
            ],
            "families": [
                {
                    "name": f,
                    "rgb": list(
                        next(c for c, fam in CLASS_COLOURS.values() if fam == f)
                    ),
                }
                for f in FAMILIES
            ],
            "source": SOURCE_META,
            "bytes": total,
        },
    )
    log.info(
        "wrote %s: %.1f MB (%.0f s)",
        a.out_dir / "glwd.json",
        total / 1e6,
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
