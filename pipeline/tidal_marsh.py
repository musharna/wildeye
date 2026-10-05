"""Global tidal marshes 2020 (Worthington et al. 2024, Zenodo 8420753 v2.6, CC BY 4.0) → a geographic tile pyramid of
the share of each cell that is tidal marsh.

Spec: docs/superpowers/specs/2026-10-04-tidal-marshes-design.md. The zip of 154 GeoTIFFs (10° tiles, 10 m, uint8, 1 =
tidal marsh, 0 = not, 60°N to 60°S) is pinned by sha256 and read in place through GDAL's /vsizip/, row bands in file
order. Each 10 m pixel is assigned, by its centre, to one pixel of Cesium's geographic tiling scheme at level MAX_LEVEL
(~150 m at the equator), and each cell keeps two counts: marsh pixels, and all pixels of the source that fall in it,
the second worked out from the source grids rather than read. A cell's share is the first over the second; neighbouring
source tiles overlap by up to one pixel, and an overlap pixel adds to both counts alike. Longitude is taken modulo 360:
the release georeferences its 180W tiles at 180-190°E, so their first column falls at the east edge of the world and the
rest at its west edge. Coarser levels add the marsh counts of their four children and work their totals out the same
way, so every level holds an exact share. A painted pixel is the share in whole percent (1-100, a share under 1.5% drawn
as 1); unpainted means no marsh mapped there. The counting is pipeline/cell_share.py's, shared with the seagrass maps.
Only painted tiles are written; tidal_marsh.json, written last, lists them and is what the layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import logging
import math
import os
import re
import shutil
import urllib.request
import zipfile
from pathlib import Path

from .atomic import write_atomic
from .cell_share import (  # noqa: F401 - re-exported: test_tidal_marsh.py reads them here
    EARTH_KM,
    TILE,
    Grid,
    accumulate,
    cell_index,
    coarser,
    ramp,
    replace_dir,
    shares,
    totals,
    write_pyramid,
)
from .cell_share import SourceChanged as MarshChanged
from .net import urlopen

log = logging.getLogger("tidal_marsh")

ZIP_NAME = "tidal_marsh_v2_6.zip"
ZIP_URL = "https://zenodo.org/api/records/8420753/files/tidal_marsh_v2_6.zip/content"
# the file served 2026-10-04: Zenodo lists md5 1bab179f7506b3525d2e9a2c28e27001 for it
ZIP_SHA256 = "931ca7c24c2f683993cadec6a5f8372de87ba3fb8b07a7900e4f41c1873612e8"
MEMBER = re.compile(r"^Final_Rasters/tidal_marsh_\d{1,3}[EW]_\d{1,2}[NS]_v2_6\.tif$")
RES = 8.983152841195213e-05  # degrees: the release's one pixel size (1/11132.0°, ~10 m)
MAX_LEVEL = (
    9  # 1024 x 512 tiles at the finest level: 0.00137°, about 150 m at the equator
)
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


def palette() -> list[list[int]]:
    return ramp(RAMP)


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
    listed, tile_bytes = write_pyramid(
        finest, grids, tmp, max_level=max_level, palette=palette()
    )
    replace_dir(tmp, out_dir / "tidal_marsh")
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
