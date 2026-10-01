"""Human Footprint (Mu et al. 2022) as a geographic tile pyramid, five snapshots 2000–2024.

Spec: docs/superpowers/specs/2026-10-01-human-footprint-design.md. Each year is one float32 GeoTIFF (Mollweide, 1 km,
0–50, NaN = no data) in a zip on figshare 16571064 v8, CC BY 4.0; figshare's md5 of every zip is pinned here and a file
that differs, cached or fetched, is refused. Each epoch is reprojected to lon/lat by area average at the finest level,
averaged down for the coarser ones, put in 50 bins with one palette colour each, and cut into 256-px tiles on Cesium's
geographic tiling scheme (level z: 2^(z+1) × 2^z tiles). Every tile is written, empty ones too: a missing tile is a
404 the layer would count as a failure. hfp.json, written last, is what the layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import logging
import os
import shutil
import time
import urllib.request
import warnings
from pathlib import Path

import numpy as np
from PIL import Image

from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("hfp")
ARTICLE = "16571064"
VERSION = 8
FILE_URL = "https://ndownloader.figshare.com/files/{}"
# year → (figshare file id, figshare's md5 of the zip), read from the v8 article API 2026-10-01
EPOCHS = {
    2000: (30716462, "a582397d23abdf633b5cf810c393da66"),
    2006: (30716528, "88b7b9fbdc2a0c37919bbcefd1356865"),
    2012: (30716543, "963f745780a09e356e7158a6ef6613c5"),
    2018: (30716561, "400b076f341d74fa1e980a9ad08a3a4d"),
    2024: (59321030, "0d5b9c10bc4a3947a7eb1eaf22db6975"),
}
TILE = 256
NODATA = 50  # palette index of "no data" (transparent); bins are 0–49
# ColorBrewer YlOrRd, 9 classes: pale yellow (wild) to dark red (cities)
RAMP = [
    (255, 255, 204),
    (255, 237, 160),
    (254, 217, 118),
    (254, 178, 76),
    (253, 141, 60),
    (252, 78, 42),
    (227, 26, 28),
    (189, 0, 38),
    (128, 0, 38),
]
UA = "wildeye/0.1 (human footprint)"
SOURCE = {
    "id": "hfp",
    "name": "Human Footprint 2000–2024 (Mu et al.)",
    "doi": "10.1038/s41597-022-01284-8",
    "data": f"https://doi.org/10.6084/m9.figshare.{ARTICLE}.v{VERSION}",
    "licence": "CC BY 4.0 (figshare article licence)",
    "citation": "Mu, H., Li, X., Wen, Y., Huang, J., et al. (2022). A global record of annual terrestrial Human Footprint "
    "dataset from 2000 to 2018. Scientific Data 9, 176. doi:10.1038/s41597-022-01284-8",
}


def palette() -> list[tuple[int, int, int]]:
    """50 colours along the ramp, one per bin; distinct, so a tile pixel names its bin exactly."""
    out = []
    for k in range(50):
        f = k / 49 * (len(RAMP) - 1)
        i = min(int(f), len(RAMP) - 2)
        w = f - i
        out.append(
            tuple(int(round(a * (1 - w) + b * w)) for a, b in zip(RAMP[i], RAMP[i + 1]))
        )
    return out


def quantise(a: np.ndarray) -> np.ndarray:
    """Values → bins [k, k+1) for k = 0–48 and [49, 50]; NaN → NODATA. A value outside 0–50 is refused."""
    bad = ~np.isnan(a) & ((a < 0) | (a > 50))
    if bad.any():
        raise ValueError(
            f"{int(bad.sum())} values outside 0–50 (e.g. {float(a[bad][0])})"
        )
    out = np.full(a.shape, NODATA, np.uint8)
    ok = ~np.isnan(a)
    out[ok] = np.minimum(np.floor(a[ok]), 49).astype(np.uint8)
    return out


def block_mean(a: np.ndarray, f: int) -> np.ndarray:
    """Mean of each f × f block, no data ignored; a block with no data at all stays NaN."""
    h, w = a.shape
    blocks = a.reshape(h // f, f, w // f, f)
    with warnings.catch_warnings():
        warnings.simplefilter(
            "ignore", RuntimeWarning
        )  # "Mean of empty slice" is the all-NaN block, kept NaN
        return np.nanmean(blocks, axis=(1, 3)).astype(np.float32)


def tiles_for_level(index: np.ndarray, z: int):
    """((x, y), 256 × 256 bin array) for every tile of level z on the geographic tiling scheme."""
    nx, ny = 2 ** (z + 1), 2**z
    if index.shape != (ny * TILE, nx * TILE):
        raise ValueError(
            f"level {z} needs {nx * TILE} × {ny * TILE}, got {index.shape[1]} × {index.shape[0]}"
        )
    for x in range(nx):
        for y in range(ny):
            yield (x, y), index[y * TILE : (y + 1) * TILE, x * TILE : (x + 1) * TILE]


def pyramid(field: np.ndarray, max_level: int):
    """(z, bins) from max_level down to 0; each coarser level is the 2 × 2 average of the finer field, binned after."""
    for z in range(max_level, -1, -1):
        yield z, quantise(field)
        if z:
            field = block_mean(field, 2)


def render_equirect(src: str, width: int) -> np.ndarray:
    """The GeoTIFF at `src` (any GDAL path) reprojected to lon/lat, width × width/2, by area average; NaN = no data."""
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    with rasterio.open(src) as r:
        data, transform, crs = r.read(1), r.transform, r.crs
    dst = np.full((width // 2, width), np.nan, np.float32)
    reproject(
        data,
        dst,
        src_transform=transform,
        src_crs=crs,
        src_nodata=np.nan,
        dst_transform=from_bounds(-180, -90, 180, 90, width, width // 2),
        dst_crs="EPSG:4326",
        dst_nodata=np.nan,
        resampling=Resampling.average,
        num_threads=4,
    )
    return dst


def _fetch_to(url: str, path: Path) -> None:
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=600
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def _md5(path: Path) -> str:
    h = hashlib.md5(
        usedforsecurity=False
    )  # figshare publishes an md5 of each file: a download check
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_epoch(cache: Path, year: int, *, fetch_to=_fetch_to, epochs=EPOCHS) -> Path:
    """The pinned zip for `year`, downloaded once; refused (and not kept) unless its md5 is figshare's."""
    file_id, want = epochs[year]
    path = cache / f"hfp{year}.zip"
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


def _png(bins: np.ndarray, pal_bytes: bytes, trns: bytes) -> bytes:
    im = Image.fromarray(bins, "P")
    im.putpalette(pal_bytes)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True, transparency=trns)
    return buf.getvalue()


def write_epoch(zip_path: Path, year: int, out_dir: Path, max_level: int) -> int:
    """Render one epoch's pyramid into out_dir/hfp/<year>, replacing any earlier one whole. Returns bytes written."""
    pal = palette()
    pal_bytes = bytes(c for rgb in pal for c in rgb) + bytes(3)
    trns = bytes([255] * NODATA + [0])
    field = render_equirect(
        f"/vsizip/{zip_path.resolve()}/hfp{year}.tif", TILE * 2 ** (max_level + 1)
    )
    final = out_dir / "hfp" / str(year)
    tmp = out_dir / "hfp" / f".{year}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    total = 0
    for z, bins in pyramid(field, max_level):
        for (x, y), tile in tiles_for_level(bins, z):
            p = tmp / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = _png(np.ascontiguousarray(tile), pal_bytes, trns)
            p.write_bytes(data)
            total += len(data)
    old = out_dir / "hfp" / f".{year}.old"
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(tmp, final)
    shutil.rmtree(old, ignore_errors=True)
    return total


def main(argv=None, *, fetch_to=_fetch_to, epochs=EPOCHS):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "hfp",
    )
    ap.add_argument(
        "--max-level",
        type=int,
        default=4,
        help="finest tile level; 4 = 8192 × 4096, about 4.9 km",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    sizes = {}
    for year in sorted(epochs):
        zip_path = fetch_epoch(a.cache, year, fetch_to=fetch_to, epochs=epochs)
        sizes[year] = write_epoch(zip_path, year, a.out_dir, a.max_level)
        log.info(
            "%d: %.1f MB of tiles (%.0f s)", year, sizes[year] / 1e6, time.time() - t0
        )
    write_atomic(
        a.out_dir / "hfp.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "years": sorted(epochs),
            "maxLevel": a.max_level,
            "tile": "data/hfp/{year}/{z}/{x}/{y}.png",
            "palette": [list(c) for c in palette()],
            "bins": "k = 0–48 is [k, k+1); 49 is [49, 50]",
            "resolution": f"about {40075 / (TILE * 2 ** (a.max_level + 1)):.1f} km at the equator, area average of 1 km",
            "source": SOURCE,
            "bytes": sizes,
        },
    )
    log.info(
        "wrote %s: %d epochs, %.1f MB (%.0f s)",
        a.out_dir / "hfp.json",
        len(sizes),
        sum(sizes.values()) / 1e6,
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
