"""Global floating kelp forests (Arafeh-Dalmau et al. 2025, Zenodo 14816612, CC BY 4.0) → a geographic tile pyramid of
the share of each cell covered by kelp canopy ever detected.

Spec: docs/superpowers/specs/2026-10-07-kelp-forests-design.md. The release zip is pinned by Zenodo's md5 and its kelp
shapefile (426,489 polygons, EPSG:4326, every satellite pixel where floating kelp canopy was ever detected: Landsat
1984 onward in some regions, a Sentinel-2 mosaic of 2015-2019 elsewhere) is read in place through GDAL's /vsizip/.
Each cell of Cesium's geographic tiling scheme at MAX_LEVEL (~150 m at the equator) is split into SUB x SUB
subpixels, and every polygon is burnt onto that subgrid by GDAL's rasterize (a subpixel counts when its centre is
inside), one block of BLOCK x BLOCK cells at a time over the blocks its bounding box touches. A cell's share is its
kelp subpixels over SUB²; the pyramid, the shares and the PNGs are pipeline/cell_share.py's, shared with the tidal
marshes and seagrass. Columns are worked out unwrapped and taken modulo 360°, so a polygon across the antimeridian
splits between the world's last and first columns. A changed file, a feature count other than 426,489, a count above
a cell's total, drawn and polygon areas more than 0.5% apart, or tiles over the byte budget stop the run, and nothing
is published; kelp.json, written last, lists the painted tiles and is what the layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import shutil
import time
from pathlib import Path

import numpy as np

from .atomic import write_atomic
from .cell_share import (
    EARTH_KM,
    TILE,
    SourceChanged,
    ramp,
    replace_dir,
    row_areas_km2,
    write_pyramid,
)
from .hfp import _fetch_to, _md5

log = logging.getLogger("kelp")

ZIP_NAME = "Intensifying_MHWs_Protection_Global_Kelp.zip"
ZIP_URL = f"https://zenodo.org/api/records/14816612/files/{ZIP_NAME}/content"
ZIP_MD5 = (
    "2a0e3acf3e0a36e7d178de68176db508"  # Zenodo's, read from the record API 2026-10-07
)
MEMBER = "Intensifying_MHWs_Protection_Global_Kelp/Data/Global_Floating_Kelp/Global_Kelp_Canopy_2-24.shp"
EXPECTED_FEATURES = 426489
MAX_LEVEL = (
    9  # 1024 x 512 tiles at the finest level: 0.00137°, about 150 m at the equator
)
SUB = 64  # subpixels per cell side: ~2.4 m, max error 1.04 pp in the spec's comparison
BLOCK = 32  # cells per block side: a block's raster is at most 2048 x 2048 bytes
BUDGET_BYTES = 25_000_000
AREA_TOLERANCE = 0.005  # drawn vs polygon area on the sphere
# share 1-100% → pale yellow through orange to dark brown (ColorBrewer YlOrBr ends); index 0 is transparent
RAMP = ((1, (255, 237, 160)), (50, (236, 112, 20)), (100, (102, 37, 6)))
SOURCE = {
    "name": "Global floating kelp forests (Global_Kelp_Canopy_2-24)",
    "author": "Arafeh-Dalmau, Villaseñor-Derbez, Schoeman, Mora-Soto, Bell et al.",
    "url": "https://doi.org/10.5281/zenodo.14816612",
    "licence": "CC BY 4.0",
    "cite": "Arafeh-Dalmau et al. 2025, Nature Communications 16, doi:10.1038/s41467-025-58054-4",
}


def palette() -> list[list[int]]:
    return ramp(RAMP)


def fetch(
    cache: Path, *, md5: str = ZIP_MD5, url: str = ZIP_URL, fetch_to=_fetch_to
) -> Path:
    """The release zip, downloaded once; refused (and not kept) unless its md5 is Zenodo's."""
    path = cache / ZIP_NAME
    if path.exists():
        got = _md5(path)
        if got != md5:
            raise SourceChanged(
                f"{path}: md5 {got} is not Zenodo's {md5}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    log.info("downloading %s", url)
    try:
        fetch_to(url, part)
        got = _md5(part)
        if got != md5:
            raise SourceChanged(f"{url}: md5 {got} is not Zenodo's {md5}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def read_polygons(path: str, *, expect: int = EXPECTED_FEATURES) -> np.ndarray:
    """The kelp polygons, 2D, as a shapely array; refused unless EPSG:4326, polygons only and `expect` of them."""
    import pyogrio
    import shapely

    meta, _, geom, _ = pyogrio.raw.read(path, columns=[], read_geometry=True)
    crs = meta.get("crs") or ""
    if crs != "EPSG:4326":
        raise SourceChanged(f"{path}: crs {crs!r} is not EPSG:4326")
    if len(geom) != expect:
        raise SourceChanged(
            f"{path}: {len(geom):,} features, not the {expect:,} of the pinned release"
        )
    polys = shapely.force_2d(shapely.from_wkb(geom))
    kinds = set(shapely.get_type_id(polys).tolist())
    if not kinds <= {3, 6}:  # Polygon, MultiPolygon
        raise SourceChanged(f"{path}: geometry types {sorted(kinds)}, not polygons")
    return polys


def sphere_km2(polys) -> float:
    """Area of the polygons on the sphere of radius EARTH_KM (Lambert cylindrical equal-area: x = λR, y = R sin φ)."""
    import shapely

    def ea(c):
        return np.column_stack(
            [np.radians(c[:, 0]) * EARTH_KM, np.sin(np.radians(c[:, 1])) * EARTH_KM]
        )

    return float(shapely.area(shapely.transform(polys, ea)).sum())


class Subgrid:
    """The virtual global raster of SUB x SUB subpixels per finest cell, in cell_share.Grid's shape: every cell at
    level z holds (SUB * 2**(max_level - z))² subpixel centres, so cell_share.totals reads the totals from it."""

    def __init__(self, sub: int):
        self.sub = sub

    def counts(self, z: int, max_level: int):
        per = self.sub << (max_level - z)
        return (
            [(0, np.full(2 ** (z + 1) * TILE, per, np.int64))],
            0,
            np.full(2**z * TILE, per, np.int64),
        )


def subpixel_spans(bounds: np.ndarray, *, max_level: int, sub: int):
    """Per polygon: first and past-last subpixel column (unwrapped: may be < 0 or past the world's width) and row
    (clipped to the world) whose centres can lie inside its bounding box."""
    step = 360 / (2 ** (max_level + 1) * TILE * sub)
    rows = 2**max_level * TILE * sub
    x0, y0, x1, y1 = bounds.T
    if (x1 - x0 > 180).any():
        bad = int(np.flatnonzero(x1 - x0 > 180)[0])
        raise SourceChanged(
            f"polygon {bad} is {x1[bad] - x0[bad]:.1f}° wide: an antimeridian crossing written the long way round"
        )
    c0 = np.floor((x0 + 180) / step - 0.5).astype(np.int64)
    c1 = np.floor((x1 + 180) / step - 0.5).astype(np.int64) + 1
    r0 = np.clip(np.floor((90 - y1) / step - 0.5).astype(np.int64), 0, rows)
    r1 = np.clip(np.floor((90 - y0) / step - 0.5).astype(np.int64) + 1, 0, rows)
    return c0, c1, r0, r1, step


def blocks_of(c0, c1, r0, r1, *, sub: int, block: int) -> dict:
    """{(bx, by): [polygon indices]} for every block (unwrapped bx) a polygon's subpixel span touches."""
    span = sub * block
    bx0, bx1 = np.floor_divide(c0, span), np.floor_divide(np.maximum(c1 - 1, c0), span)
    by0, by1 = np.floor_divide(r0, span), np.floor_divide(np.maximum(r1 - 1, r0), span)
    out: dict = {}
    for i in np.flatnonzero((c1 > c0) & (r1 > r0)).tolist():
        for bx in range(int(bx0[i]), int(bx1[i]) + 1):
            for by in range(int(by0[i]), int(by1[i]) + 1):
                out.setdefault((bx, by), []).append(i)
    return out


def burn(
    polys,
    *,
    max_level: int = MAX_LEVEL,
    sub: int = SUB,
    block: int = BLOCK,
    progress=None,
) -> tuple[dict, float]:
    """({(tx, ty): uint16 kelp subpixels per finest cell}, drawn km²): every polygon burnt onto the subgrid."""
    import shapely
    from rasterio import features
    from rasterio.transform import Affine

    width_cells = 2 ** (max_level + 1) * TILE
    c0, c1, r0, r1, step = subpixel_spans(
        shapely.bounds(polys), max_level=max_level, sub=sub
    )
    blocks = blocks_of(c0, c1, r0, r1, sub=sub, block=block)
    span = sub * block
    counts: dict = {}
    km2 = 0.0
    for n, ((bx, by), idx) in enumerate(sorted(blocks.items()), start=1):
        # the window: the block cut to its polygons' extent, snapped out to whole cells
        wc0 = max(bx * span, int(c0[idx].min()) // sub * sub)
        wc1 = min((bx + 1) * span, -(-int(c1[idx].max()) // sub) * sub)
        wr0 = max(by * span, int(r0[idx].min()) // sub * sub)
        wr1 = min((by + 1) * span, -(-int(r1[idx].max()) // sub) * sub)
        if wc1 <= wc0 or wr1 <= wr0:
            continue
        h, w = wr1 - wr0, wc1 - wc0
        a = features.rasterize(
            ((polys[i], 1) for i in idx),
            out_shape=(h, w),
            transform=Affine(step, 0, -180 + wc0 * step, 0, -step, 90 - wr0 * step),
            fill=0,
            dtype="uint8",
        )
        if not a.any():
            continue
        km2 += float(
            a.sum(axis=1, dtype=np.int64)
            @ row_areas_km2(90 - wr0 * step, h, step, step)
        )
        cells = a.reshape(h // sub, sub, w // sub, sub).sum(
            axis=(1, 3), dtype=np.uint16
        )
        gy0, gx0 = wr0 // sub, wc0 // sub
        for r, c in zip(*np.nonzero(cells)):
            # columns past 180° wrap to the world's other edge
            gy, gx = gy0 + int(r), (gx0 + int(c)) % width_cells
            key = (gx // TILE, gy // TILE)
            t = counts.get(key)
            if t is None:
                t = counts[key] = np.zeros((TILE, TILE), np.uint16)
            t[gy % TILE, gx % TILE] += cells[r, c]
        if progress and n % 2000 == 0:
            progress(n, len(blocks), km2)
    return counts, km2


def write(
    finest: dict,
    meta: dict,
    out_dir: Path,
    *,
    max_level: int = MAX_LEVEL,
    sub: int = SUB,
    budget: int = BUDGET_BYTES,
    now=None,
) -> dict:
    """Tiles into out_dir/kelp (replaced whole), then out_dir/kelp.json; returns the manifest.

    Over the byte budget, or on a count above a cell's total, nothing in out_dir changes."""
    tmp = out_dir / ".kelp.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        listed, tile_bytes = write_pyramid(
            finest, [Subgrid(sub)], tmp, max_level=max_level, palette=palette()
        )
        if tile_bytes > budget:
            raise SourceChanged(
                f"{tile_bytes:,} B of tiles is over the {budget:,} B budget: nothing published"
            )
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    replace_dir(tmp, out_dir / "kelp")
    when = (now or (lambda: dt.datetime.now(dt.UTC)))()
    manifest = {
        "generated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxLevel": max_level,
        "tile": "data/kelp/{z}/{x}/{y}.png",
        "tiles": listed,
        "palette": palette(),
        "subpixels": sub,
        **meta,
        "tileBytes": tile_bytes,
        "source": SOURCE,
    }
    write_atomic(out_dir / "kelp.json", manifest)  # last: the layer reads this one
    return manifest


def check_areas(
    drawn: float, polygons: float, tolerance: float = AREA_TOLERANCE
) -> None:
    """Refused unless the counted subpixels' area is within `tolerance` of the polygons' own area."""
    if not polygons > 0 or abs(drawn / polygons - 1) > tolerance:
        raise SourceChanged(
            f"drawn {drawn:.1f} km² vs polygons {polygons:.1f} km²: more than {tolerance:.1%} apart, nothing published"
        )


def main(
    argv=None,
    *,
    fetch_to=_fetch_to,
    md5: str = ZIP_MD5,
    expect: int = EXPECTED_FEATURES,
    now=None,
) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "kelp",
    )
    ap.add_argument("--max-level", type=int, default=MAX_LEVEL)
    ap.add_argument("--budget", type=int, default=BUDGET_BYTES)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.monotonic()
    zip_path = fetch(a.cache, md5=md5, fetch_to=fetch_to)
    polys = read_polygons(f"/vsizip/{zip_path}/{MEMBER}", expect=expect)
    polygon_km2 = sphere_km2(polys)
    log.info("%d polygons, %.2f km² on the sphere", len(polys), polygon_km2)

    def progress(n, total, km2):
        log.info(
            "block %d/%d: %.1f km² drawn (%.0f s)", n, total, km2, time.monotonic() - t0
        )

    counts, drawn_km2 = burn(polys, max_level=a.max_level, progress=progress)
    check_areas(drawn_km2, polygon_km2)
    meta = {
        "features": len(polys),
        "kelpKm2": round(polygon_km2, 1),
        "drawnKm2": round(drawn_km2, 1),
    }
    manifest = write(
        counts, meta, a.out_dir, max_level=a.max_level, budget=a.budget, now=now
    )
    log.info(
        "%.1f km² of kelp (%.1f drawn); %d finest tiles, %d in all, %.2f MB (%.0f s)",
        polygon_km2,
        drawn_km2,
        len(counts),
        sum(len(v) for v in manifest["tiles"].values()),
        manifest["tileBytes"] / 1e6,
        time.monotonic() - t0,
    )
    return manifest


if __name__ == "__main__":
    main()
