"""Global 10-meter seagrass maps, 2019-2020 and 2023-2024 (Peng, Li, Krause, Lyons, Murray, Schill, Roelfsema and Asner;
Zenodo 18612240, CC BY 4.0) → one geographic tile pyramid per epoch of the share of each cell that is seagrass.

Spec: docs/superpowers/specs/2026-10-04-seagrass-design.md. Each epoch is one zip of ~300 GeoTIFFs (a 65,536-pixel export
grid, 10 m, uint8, 1 = seagrass, 0 = not, 51°S to 72°N), pinned by sha256 and read in place through GDAL's /vsizip/. The
counting is pipeline/cell_share.py's (shared with the tidal marshes): each cell of the finest level (~150 m at the
equator) holds its seagrass pixels over all its source pixels, at every level exactly, painted in whole percent. Only
painted tiles are written, under seagrass/<epoch>/; seagrass.json, written last, lists them per epoch and is what the
layer reads.
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
from .cell_share import (
    Grid,
    SourceChanged,
    accumulate,
    ramp,
    replace_dir,
    write_pyramid,
)
from .net import urlopen

log = logging.getLogger("seagrass")

RECORD = "https://zenodo.org/api/records/18612240/files"
# the files served 2026-10-04; Zenodo lists md5 2046bf6c62d85f4d57e678bf6ef1cd07 and d371628f0e343244eb47f188f0a89726
EPOCHS = {
    "2019_2020": "f0fe80e60f78c4bc2f1e5c0cef07511f7dc39e76edc9ad2d55900cfd7f08c232",
    "2023_2024": "7f5b62c9343b43aa611acc74bf17da031655a42b0da7a1abc9e18a6b746c010e",
}
RES = 8.983152841195215e-05  # degrees: the release's one pixel size (1/11132°, ~10 m)
MAX_LEVEL = 9  # ~150 m at the equator
UA = "wildeye/0.1 (seagrass; +https://github.com/musharna)"
# share 1-100% → pale aqua to deep sea green (palette index = share); index 0 is transparent
RAMP = ((1, (204, 236, 214)), (50, (65, 174, 118)), (100, (0, 68, 27)))
SOURCE = {
    "name": "Global 10-meter seagrass maps",
    "author": "Peng, Li, Krause, Lyons, Murray, Schill, Roelfsema and Asner",
    "url": "https://doi.org/10.5281/zenodo.18612240",
    "licence": "CC BY 4.0",
}


def palette() -> list[list[int]]:
    return ramp(RAMP)


def zip_name(epoch: str) -> str:
    return f"GlobalSeagrass{epoch}.zip"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_to(url: str, path: Path) -> None:
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=3600
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch(cache: Path, epoch: str, *, sha256: str, fetch_to=_fetch_to) -> Path:
    """One epoch's zip, downloaded once; refused (and not kept) unless its sha256 is the pinned one."""
    path = cache / zip_name(epoch)
    if path.exists():
        got = _sha256(path)
        if got != sha256:
            raise SourceChanged(
                f"{path}: sha256 {got} is not the pinned {sha256}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    url = f"{RECORD}/{zip_name(epoch)}/content"
    log.info("downloading %s", url)
    try:
        fetch_to(url, part)
        got = _sha256(part)
        if got != sha256:
            raise SourceChanged(f"{url}: sha256 {got} is not the pinned {sha256}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def members(zip_path: Path, epoch: str) -> list[str]:
    """The epoch's GeoTIFFs, by name; anything else in the zip but their folder is refused."""
    folder = f"GlobalSeagrass{epoch}/"
    member = re.compile(
        rf"^{re.escape(folder)}GlobalSeagrass{re.escape(epoch)}-\d{{10}}-\d{{10}}\.tif$"
    )
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
    tifs = sorted(n for n in names if member.match(n))
    other = [n for n in names if n not in tifs and n != folder]
    if other or not tifs:
        raise SourceChanged(
            f"{zip_path.name}: unexpected members {other[:5]} ({len(tifs)} GeoTIFFs)"
        )
    return tifs


def check_profile(src, name: str) -> None:
    """Refused unless one uint8 band, EPSG:4326, the release's pixel size, north-up, within ±180° and 60°S-75°N."""
    t, b = src.transform, src.bounds
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
                f"bounds {b}",
                b.left >= -180.001
                and b.right <= 180.001
                and b.bottom >= -60
                and b.top <= 75,
            ),
        ]
        if not ok
    ]
    if problems:
        raise SourceChanged(f"{name}: {'; '.join(problems)}")


def count_epoch(zip_path: Path, epoch: str, max_level: int, band_rows: int = 4096):
    """(finest-level seagrass counts, the source grids, seagrass km², member count) for one epoch."""
    import rasterio

    names = members(zip_path, epoch)
    counts: dict = {}
    grids, km2 = [], 0.0
    for n, name in enumerate(names, start=1):
        with rasterio.open(f"/vsizip/{zip_path}/{name}") as src:
            check_profile(src, name)
            grids.append(Grid(src.transform, src.width, src.height, max_level))
            got = accumulate(src, max_level, counts, band_rows=band_rows)
        km2 += got
        log.info("%s %d/%d %s: %.1f km² of seagrass", epoch, n, len(names), name, got)
    return counts, grids, km2, len(names)


def label(epoch: str) -> str:
    return epoch.replace("_", "–")


def main(
    argv=None, *, fetch_to=_fetch_to, pins=None, now=None, band_rows: int = 4096
) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "seagrass",
    )
    ap.add_argument("--max-level", type=int, default=MAX_LEVEL)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    pins = pins or EPOCHS
    tmp = a.out_dir / ".seagrass.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    epochs, tile_bytes = [], 0
    for epoch, sha in pins.items():
        zip_path = fetch(a.cache, epoch, sha256=sha, fetch_to=fetch_to)
        counts, grids, km2, n = count_epoch(zip_path, epoch, a.max_level, band_rows)
        listed, written = write_pyramid(
            counts, grids, tmp / epoch, max_level=a.max_level, palette=palette()
        )
        tile_bytes += written
        epochs.append(
            {
                "key": epoch,
                "label": label(epoch),
                "year": int(epoch[:4]),
                "members": n,
                "seagrassKm2": round(km2, 1),
                "tileBytes": written,
                "tiles": listed,
            }
        )
        log.info(
            "%s: %.0f km² of seagrass; %d finest tiles, %.1f MB",
            epoch,
            km2,
            len(counts),
            written / 1e6,
        )
        del counts
    replace_dir(tmp, a.out_dir / "seagrass")
    when = (now or (lambda: dt.datetime.now(dt.UTC)))()
    manifest = {
        "generated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxLevel": a.max_level,
        "tile": "data/seagrass/{epoch}/{z}/{x}/{y}.png",
        "epochs": epochs,
        "palette": palette(),
        "tileBytes": tile_bytes,
        "source": SOURCE,
    }
    write_atomic(
        a.out_dir / "seagrass.json", manifest
    )  # last: the layer reads this one
    return manifest


if __name__ == "__main__":
    main()
