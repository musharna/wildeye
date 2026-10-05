"""Intact Forest Landscapes 2000-2025 (the IFL Mapping Team, intactforests.org, CC BY 4.0) → one geographic tile pyramid
coloured by the last edition in which each place was intact.

Spec: docs/superpowers/specs/2026-10-04-ifl-design.md. The five editions (2000, 2013, 2016, 2020, 2025; GeoPackages of
November 2025) are pinned by sha256: a file that differs, cached or fetched, is refused, and so is one whose layout is not
the documented one (table IFL_<year>, EPSG:4326 multipolygons, fields IFL_ID and Area<year>). Each edition is simplified
by a fifth of a finest pixel and burned in order onto Cesium's geographic tiling scheme at level MAX_LEVEL (~610 m),
pixel centres inside a polygon, so each pixel holds the index of the last edition that covers it: 5 = intact in 2025,
1-4 = intact up to that edition and gone by the next ("IFL loss" in the data description's terms: logged, cleared,
fragmented by infrastructure or burned from it, not necessarily deforested). Later editions were not used to correct
earlier ones (2025 update notes), so an edition can cover ground its predecessor did not; those pixels are counted and
published, and the last edition still wins. Coarser levels take the 2 x 2 majority, ties to the more recently intact.
Only painted tiles are written; ifl.json, written last, lists them and is what the layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import logging
import math
import os
import shutil
import sqlite3
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("ifl")
BASE_URL = "https://intactforests.org/shp/"
UA = "wildeye/0.1 (intact forest landscapes; +https://github.com/musharna)"
# (year, sha256 of IFL_<year>.gpkg), the files served 2026-10-04 (Last-Modified 2025-11-11 to 2025-11-28)
EDITIONS = (
    (2000, "1f2252b94a17a716362d9dd9d6f24e44c0896a5ac18be68c8c61be2e2c38e03b"),
    (2013, "da4659b20a8aaf355f246ac18cc5d2ad70e68ea6dfc11d238888d0bb7f2f1e46"),
    (2016, "5d626e9907a472cb7ea6cd0b49c7b13c3c05b4c8f14842f9a1bc73c096b2f632"),
    (2020, "c455014f273cab737977758e842957e15613d3461bf44d77fe8b52c3d5ff8ace"),
    (2025, "0e043943d322558fd36150139fd918a9dae144439e51880037014876decec581"),
)
TILE = 256
MAX_LEVEL = (
    7  # 256 x 128 tiles at the finest level: 0.0055°, about 610 m at the equator
)
BLOCK = 16  # tiles per side of one burned block (4096 px), so a large patch is rasterised once per block, not per tile
SIMPLIFY_DEG = 0.001  # a fifth of a level-7 pixel
EARTH_KM = 6371.0088
# palette index = the last edition intact (1 = 2000 ... 5 = 2025); classes after the data description's Figure 2
CLASSES = [
    {"index": 1, "label": "intact in 2000, not by 2013", "rgb": [255, 221, 0]},
    {"index": 2, "label": "intact in 2013, not by 2016", "rgb": [255, 153, 0]},
    {"index": 3, "label": "intact in 2016, not by 2020", "rgb": [232, 40, 30]},
    {"index": 4, "label": "intact in 2020, not by 2025", "rgb": [150, 0, 24]},
    {"index": 5, "label": "intact forest landscape in 2025", "rgb": [56, 158, 56]},
]
PALETTE = [[0, 0, 0]] + [c["rgb"] for c in CLASSES]
SOURCE = {
    "name": "Intact Forest Landscapes 2000-2025",
    "author": "The IFL Mapping Team",
    "url": "https://intactforests.org/data.ifl.html",
    "licence": "CC BY 4.0",
    "cite": "Potapov et al. 2017, Science Advances 3: e1600821, doi:10.1126/sciadv.1600821",
}
_ENVELOPE_BYTES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}


class IflChanged(ValueError):
    """The published files are not the ones this pipeline was written for."""


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
    cache: Path, year: int, sha256: str, *, base_url: str = BASE_URL, fetch_to=_fetch_to
) -> Path:
    """IFL_<year>.gpkg, downloaded once; refused (and not kept) unless its sha256 is the pinned one."""
    path = cache / f"IFL_{year}.gpkg"
    if path.exists():
        got = _sha256(path)
        if got != sha256:
            raise IflChanged(
                f"{path}: sha256 {got} is not the pinned {sha256}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    url = f"{base_url}IFL_{year}.gpkg"
    log.info("downloading %s", url)
    try:
        fetch_to(url, part)
        got = _sha256(part)
        if got != sha256:
            raise IflChanged(f"{url}: sha256 {got} is not the pinned {sha256}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def gpkg_geometry(blob: bytes):
    """A GeoPackage geometry blob (header, optional envelope, WKB) → shapely geometry."""
    import shapely

    if blob[:2] != b"GP" or blob[2] != 0:
        raise IflChanged(f"not a version-1 GeoPackage geometry: {bytes(blob[:4])!r}")
    flags = blob[3]
    if flags & 0x20:
        raise IflChanged("an extended GeoPackage geometry")
    env = (flags >> 1) & 7
    if env not in _ENVELOPE_BYTES:
        raise IflChanged(f"GeoPackage envelope code {env}")
    return shapely.from_wkb(bytes(blob[8 + _ENVELOPE_BYTES[env] :]))


def read_edition(path: Path, year: int) -> list[dict]:
    """[{id, area_ha, geom}] of one edition, in file order; refused unless the file has the documented layout."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        table = f"IFL_{year}"
        contents = con.execute(
            "select table_name, data_type, srs_id from gpkg_contents"
        ).fetchall()
        if contents != [(table, "features", 4326)]:
            raise IflChanged(
                f"{path.name}: gpkg_contents is {contents}, not one EPSG:4326 feature table {table}"
            )
        geometry = con.execute(
            "select table_name, column_name, geometry_type_name, srs_id from gpkg_geometry_columns"
        ).fetchall()
        if geometry != [(table, "geom", "MULTIPOLYGON", 4326)]:
            raise IflChanged(f"{path.name}: geometry column is {geometry}")
        columns = [r[1] for r in con.execute(f'pragma table_info("{table}")')]
        if columns != ["fid", "geom", "IFL_ID", f"Area{year}"]:
            raise IflChanged(f"{path.name}: columns are {columns}")
        rows = con.execute(
            f'select IFL_ID, "Area{year}", geom from "{table}" order by fid'  # nosec B608 - the table and column names are the ones the file's own gpkg_contents and table_info were just checked to hold (test_an_edition_is_read_only_in_its_documented_layout); a local read-only file
        ).fetchall()
    finally:
        con.close()
    out = []
    for ifl_id, area, blob in rows:
        g = gpkg_geometry(blob)
        if g.geom_type not in ("Polygon", "MultiPolygon") or g.is_empty:
            raise IflChanged(
                f"{path.name}: {ifl_id} is a {g.geom_type}{' (empty)' if g.is_empty else ''}"
            )
        out.append({"id": ifl_id, "area_ha": float(area), "geom": g})
    return out


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a geographic-scheme tile, y from the north."""
    d = 180 / 2**z
    return (-180 + x * d, 90 - (y + 1) * d, -180 + (x + 1) * d, 90 - y * d)


def row_areas_km2(north: float, rows: int, px_deg: float) -> np.ndarray:
    """Area in km² of one pixel in each of `rows` rows from latitude `north` down, px_deg degrees square."""
    lat = np.radians(north - px_deg * np.arange(rows + 1))
    return EARTH_KM**2 * math.radians(px_deg) * (np.sin(lat[:-1]) - np.sin(lat[1:]))


def burn(
    editions: list[list], max_level: int = MAX_LEVEL, block: int = BLOCK
) -> tuple[dict, list[dict]]:
    """({(x, y): uint8 tile} for every finest tile with a painted pixel, [{km2, km2NotInPrevious}] per edition).

    Editions are burned in order onto each block; a pixel whose centre a polygon covers takes that edition's index, so
    it ends as the last edition that covers it. km2 is each edition's own burned area; km2NotInPrevious the part of it
    the edition before did not cover."""
    import shapely
    from rasterio.features import rasterize
    from rasterio.transform import from_bounds

    trees = [shapely.STRtree(geoms) for geoms in editions]
    d = 180 / 2**max_level
    px = d / TILE
    side = block * TILE
    stats = [{"km2": 0.0, "km2NotInPrevious": 0.0} for _ in editions]
    out: dict[tuple[int, int], np.ndarray] = {}
    for bx in range(0, 2 ** (max_level + 1), block):
        for by in range(0, 2**max_level, block):
            w, n = tile_bounds(max_level, bx, by)[0], tile_bounds(max_level, bx, by)[3]
            box = (w, n - block * d, w + block * d, n)
            hits = [sorted(t.query(shapely.box(*box)).tolist()) for t in trees]
            if not any(hits):
                continue
            cur = np.zeros((side, side), np.uint8)
            rows = row_areas_km2(n, side, px)
            for k, (geoms, idx) in enumerate(zip(editions, hits), start=1):
                if not idx:
                    continue
                mask = rasterize(
                    [(geoms[i], 1) for i in idx],
                    out_shape=(side, side),
                    transform=from_bounds(*box, side, side),
                    fill=0,
                    dtype="uint8",
                ).astype(bool)
                stats[k - 1]["km2"] += float(mask.sum(axis=1) @ rows)
                if k > 1:
                    stats[k - 1]["km2NotInPrevious"] += float(
                        (mask & (cur != k - 1)).sum(axis=1) @ rows
                    )
                cur[mask] = k
            for ty in range(block):
                for tx in range(block):
                    t = cur[ty * TILE : (ty + 1) * TILE, tx * TILE : (tx + 1) * TILE]
                    if t.any():
                        out[(bx + tx, by + ty)] = t.copy()
    return out, stats


def _majority(blocks: np.ndarray) -> np.ndarray:
    """(TILE, 2, TILE, 2) → (TILE, TILE): the most frequent non-zero class per 2 x 2 block, ties to the higher, else 0."""
    classes = np.arange(1, len(CLASSES) + 1, dtype=np.uint8)
    score = np.stack(
        [(blocks == c).sum(axis=(1, 3)).astype(np.int16) * 8 + c for c in classes]
    )
    best = classes[score.argmax(axis=0)]
    return np.where(blocks.max(axis=(1, 3)) > 0, best, 0).astype(np.uint8)


def coarser(tiles: dict) -> dict:
    """The next coarser level from its four children (absent children are empty)."""
    parents: dict[tuple[int, int], np.ndarray] = {}
    for (x, y), arr in tiles.items():
        big = parents.setdefault(
            (x // 2, y // 2), np.zeros((2 * TILE, 2 * TILE), np.uint8)
        )
        oy, ox = (y % 2) * TILE, (x % 2) * TILE
        big[oy : oy + TILE, ox : ox + TILE] = arr
    return {k: _majority(v.reshape(TILE, 2, TILE, 2)) for k, v in parents.items()}


def pyramid(finest: dict, max_level: int = MAX_LEVEL):
    """(z, tiles) from max_level down to 0."""
    tiles = finest
    for z in range(max_level, -1, -1):
        yield z, tiles
        if z:
            tiles = coarser(tiles)


def png(arr: np.ndarray) -> bytes:
    im = Image.fromarray(np.ascontiguousarray(arr), "P")
    im.putpalette(bytes(c for rgb in PALETTE for c in rgb))
    buf = io.BytesIO()
    # bits=8: Pillow would pack six colours into 4 bits, and the readout's decoder (src/data/pngDecode.js) reads 8 only
    im.save(
        buf, "PNG", optimize=True, bits=8, transparency=bytes([0] + [255] * len(CLASSES))
    )
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
    editions_meta: list[dict],
    out_dir: Path,
    *,
    max_level: int = MAX_LEVEL,
    now=None,
) -> dict:
    """Tiles into out_dir/ifl (replaced whole), then out_dir/ifl.json; returns the manifest."""
    tmp = out_dir / ".ifl.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    listed: dict[str, list[list[int]]] = {}
    tile_bytes = 0
    for z, tiles in pyramid(finest, max_level):
        listed[str(z)] = sorted([x, y] for x, y in tiles)
        for (x, y), arr in tiles.items():
            p = tmp / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = png(arr)
            p.write_bytes(data)
            tile_bytes += len(data)
    _replace_dir(tmp, out_dir / "ifl")
    when = (now or (lambda: dt.datetime.now(dt.UTC)))()
    manifest = {
        "generated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxLevel": max_level,
        "tile": "data/ifl/{z}/{x}/{y}.png",
        "tiles": listed,
        "classes": CLASSES,
        "editions": editions_meta,
        "tileBytes": tile_bytes,
        "source": SOURCE,
    }
    write_atomic(out_dir / "ifl.json", manifest)  # last: the layer reads this one
    return manifest


def main(argv=None, *, fetch_to=_fetch_to, editions=EDITIONS, now=None) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "ifl",
    )
    ap.add_argument("--max-level", type=int, default=MAX_LEVEL)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    import shapely

    geoms, meta = [], []
    for year, sha in editions:
        rows = read_edition(fetch(a.cache, year, sha, fetch_to=fetch_to), year)
        geoms.append(
            [
                shapely.simplify(r["geom"], SIMPLIFY_DEG, preserve_topology=True)
                for r in rows
            ]
        )
        meta.append(
            {
                "year": year,
                "patches": len(rows),
                "areaHa": round(sum(r["area_ha"] for r in rows)),
            }
        )
        log.info("%d: %d patches, %.1f Mha", year, len(rows), meta[-1]["areaHa"] / 1e6)
    finest, stats = burn(geoms, a.max_level)
    for m, s in zip(meta, stats):
        m["burnedKm2"] = round(s["km2"])
        m["burnedKm2NotInPrevious"] = round(s["km2NotInPrevious"])
    manifest = write(finest, meta, a.out_dir, max_level=a.max_level, now=now)
    log.info(
        "%d finest tiles, %d tiles in all, %.1f MB; burned vs stated area: %s",
        len(finest),
        sum(len(v) for v in manifest["tiles"].values()),
        manifest["tileBytes"] / 1e6,
        ", ".join(
            f"{m['year']} {m['burnedKm2'] / (m['areaHa'] / 100):.4f}" for m in meta
        ),
    )
    return manifest


if __name__ == "__main__":
    main()
