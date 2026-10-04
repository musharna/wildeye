"""Reptile species richness from GARD 1.7 range maps → a geographic tile pyramid and level-3 group tiles.

Spec: docs/superpowers/specs/2026-10-03-reptile-richness-design.md. Zenodo 10.5281/zenodo.6499637 (CC0) holds one
polygon per species for 10,914 terrestrial reptiles. The shapefile parts are downloaded once and refused unless their
md5 is Zenodo's. Every range is rasterised, over its own bounding box, onto a global 0.1° grid with rasterio's
all_touched rule (a species counts in every cell its range overlaps; the cell-centre rule would drop 1,712 small-range
species), into four counts: lizards, snakes, turtles and other. The total is resampled by nearest neighbour to level 3
of Cesium's geographic tiling (4096 × 2048, so every 0.1° cell keeps its own pixels), one palette colour per count,
coarser levels the mean over cells with any species. Level 3 also gets RGB group tiles (lizards, snakes, turtles) so a
readout can split the total exactly. An unknown group, any species count but 10,914, a count over 255 or tiles over
the budget stop the run; reptiles.json, written last, is what the layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import logging
import os
import shutil
import time
from pathlib import Path

import numpy as np

from .atomic import write_atomic
from .bii import nearest
from .hfp import TILE, _fetch_to, _md5, _png, block_mean, tiles_for_level

log = logging.getLogger("reptiles")
RECORD_API = "https://zenodo.org/api/records/6499637"
CACHE_DIR = "gard"
SHP = "Gard_1_7_ranges"
# Zenodo's md5 of each part (record 6499637, read from the API 2026-10-03)
FILES = {
    f"{SHP}.shp": "47785536b2910edd03fac2ece9d1eead",
    f"{SHP}.shx": "3be9bbf4f45e398d2251214bdc574c98",
    f"{SHP}.dbf": "52f6966f310ff618737d34c8528c4e5a",
    f"{SHP}.prj": "c742bee3d4edfc2948a2ad08de1790a5",
}
EXPECTED_SPECIES = 10914
RES = 0.1  # degrees per grid cell
MAX_LEVEL = 3  # 4096 × 2048: finer than the 0.1° grid (3600 × 1800)
BUDGET_BYTES = 5_000_000
# GARD `group` → count: lizards, snakes, turtles, other (amphisbaenians, crocodilians, the tuatara)
GROUPS = {
    "lizard": 0,
    "snake": 1,
    "turtle": 2,
    "amphisbaenian": 3,
    "croc": 3,
    "Rhynchocephalia": 3,
}
GROUP_NAMES = ("lizards", "snakes", "turtles", "other")
# inferno from dark purple (its near-black start dropped: invisible on the night globe) to pale yellow
RAMP = [
    (74, 12, 107),
    (120, 28, 109),
    (165, 44, 96),
    (207, 68, 70),
    (237, 105, 37),
    (251, 155, 6),
    (247, 209, 61),
    (252, 255, 164),
]
SOURCE = {
    "id": "reptiles",
    "name": "GARD 1.7: global distributions of all terrestrial reptiles (Roll & Meiri)",
    "url": "https://doi.org/10.5281/zenodo.6499637",
    "licence": "CC0 1.0 (Zenodo 10.5281/zenodo.6499637)",
    "citation": "Roll U., Feldman A., Novosolov M. et al. (2017) The global distribution of tetrapods reveals a need "
    "for targeted reptile conservation. Nature Ecology & Evolution 1:1677–1682. doi:10.1038/s41559-017-0332-2; "
    "Caetano G.H.O., Chapple D.G., Grenyer R. et al. (2022) Automated assessment reveals that the extinction risk of "
    "reptiles is widely underestimated across space and phylogeny. PLoS Biology 20(5):e3001544. "
    "doi:10.1371/journal.pbio.3001544",
}


def fetch(cache: Path, *, fetch_to=_fetch_to, want: dict = FILES) -> Path:
    """The record's files in `cache`, each downloaded once; a file is refused (and not kept) unless its md5 is Zenodo's."""
    cache.mkdir(parents=True, exist_ok=True)
    for name, md5 in want.items():
        path = cache / name
        if path.exists():
            got = _md5(path)
            if got != md5:
                raise ValueError(
                    f"{path}: md5 {got} is not Zenodo's {md5}; delete it to fetch again"
                )
            continue
        url = f"{RECORD_API}/files/{name}/content"
        part = cache / f"{name}.part"
        log.info("downloading %s → %s", url, path)
        try:
            fetch_to(url, part)
            got = _md5(part)
            if got != md5:
                raise ValueError(f"{name}: md5 {got} is not Zenodo's {md5}")
            os.replace(part, path)
        finally:
            part.unlink(missing_ok=True)
    return cache


def read_ranges(d: Path):
    """Yield (binomial, group, geo_interface geometry, bbox) per species."""
    import shapefile  # pyshp, as pipeline/ecoregions.py

    rd = shapefile.Reader(str(d / SHP), encoding="utf-8")  # the release's .cpg
    for sr in rd.iterShapeRecords():
        yield (
            sr.record["binomial"],
            sr.record["group"],
            sr.shape.__geo_interface__,
            sr.shape.bbox,
        )


def rasterise(ranges, res: float = RES, expect: int = EXPECTED_SPECIES) -> np.ndarray:
    """(4, rows, cols) uint16 counts per cell: lizards, snakes, turtles, other. Each range is burnt over its bbox only."""
    from rasterio import features
    from rasterio.transform import from_origin

    w, h = int(round(360 / res)), int(round(180 / res))
    counts = np.zeros((len(GROUP_NAMES), h, w), np.uint16)
    n = 0
    for name, group, geom, (x0, y0, x1, y1) in ranges:
        if group not in GROUPS:
            raise ValueError(f"{name}: group {group!r} is not one of {sorted(GROUPS)}")
        n += 1
        c0, c1 = (
            max(int(np.floor((x0 + 180) / res)), 0),
            min(int(np.ceil((x1 + 180) / res)), w),
        )
        r0, r1 = (
            max(int(np.floor((90 - y1) / res)), 0),
            min(int(np.ceil((90 - y0) / res)), h),
        )
        if c1 <= c0 or r1 <= r0:
            raise ValueError(f"{name}: range {x0, y0, x1, y1} is off the globe")
        burnt = features.rasterize(
            [(geom, 1)],
            out_shape=(r1 - r0, c1 - c0),
            transform=from_origin(-180 + c0 * res, 90 - r0 * res, res, res),
            fill=0,
            dtype="uint8",
            all_touched=True,
        )
        if not burnt.any():
            raise ValueError(f"{name}: range overlaps no cell")
        counts[GROUPS[group], r0:r1, c0:c1] += burnt
    if n != expect:
        raise ValueError(f"{n:,} species, not {expect:,}")
    total = counts.sum(0)
    if counts.max() > 255 or total.max() > 255:
        raise ValueError(
            f"a cell holds {int(total.max())} species ({[int(c.max()) for c in counts]} by group): over the 255 a tile pixel can carry"
        )
    return counts


def palette(top: int) -> list[tuple[int, int, int]]:
    """Index 0 (no species, transparent) then one colour per count 1..top along the ramp; all distinct."""
    out = [(0, 0, 0)]
    for k in range(1, top + 1):
        f = (k - 1) / max(top - 1, 1) * (len(RAMP) - 1)
        i = min(int(f), len(RAMP) - 2)
        w = f - i
        out.append(
            tuple(int(round(a * (1 - w) + b * w)) for a, b in zip(RAMP[i], RAMP[i + 1]))
        )
    if len(set(out)) != len(out):
        raise ValueError(f"the ramp gives fewer than {top + 1} distinct colours")
    return out


def levels(total: np.ndarray, max_level: int = MAX_LEVEL):
    """(z, uint8 index) from max_level down to 0: nearest at max_level; each coarser level the mean of the cells with
    any species in its 2 × 2 block, rounded (display only: the readout reads max_level). Every such cell holds at least 1,
    so no mean of them rounds to the transparent 0."""
    field = nearest(total, TILE * 2 ** (max_level + 1))
    field[field == 0] = np.nan
    for z in range(max_level, -1, -1):
        idx = np.zeros(field.shape, np.uint8)
        ok = ~np.isnan(field)
        idx[ok] = np.rint(field[ok]).astype(np.uint8)
        yield z, idx
        if z:
            field = block_mean(field, 2)


def group_png(rgb: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgb), "RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def write_tiles(counts: np.ndarray, out: Path, max_level: int = MAX_LEVEL) -> dict:
    """Display pyramid under out/{z}/{x}/{y}.png and level-max group tiles under out/groups/{x}/{y}.png."""
    total = counts.sum(0)
    top = int(total.max())
    pal = palette(top)
    pal_bytes = bytes(c for rgb in pal for c in rgb) + bytes(3 * (256 - len(pal)))
    trns = bytes([0] + [255] * top)
    sizes = {"display": 0, "groups": 0}
    for z, idx in levels(total, max_level):
        for (x, y), tile in tiles_for_level(idx, z):
            p = out / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = _png(np.ascontiguousarray(tile), pal_bytes, trns)
            p.write_bytes(data)
            sizes["display"] += len(data)
    width = TILE * 2 ** (max_level + 1)
    rgb = np.stack(
        [nearest(counts[k], width).astype(np.uint8) for k in range(3)], axis=-1
    )
    # tiles_for_level checks a 2-D shape: cut the channels with the coordinates it yields for the first one
    for (x, y), _ in tiles_for_level(rgb[..., 0], max_level):
        p = out / "groups" / str(x) / f"{y}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        data = group_png(rgb[y * TILE : (y + 1) * TILE, x * TILE : (x + 1) * TILE])
        p.write_bytes(data)
        sizes["groups"] += len(data)
    return sizes


def main(
    argv=None, *, fetch_to=_fetch_to, want: dict = FILES, expect: int = EXPECTED_SPECIES
) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        ),
    )
    ap.add_argument("--budget", type=int, default=BUDGET_BYTES)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    d = fetch(a.cache / CACHE_DIR, fetch_to=fetch_to, want=want)
    counts = rasterise(read_ranges(d), expect=expect)
    log.info("rasterised %d species (%.0f s)", expect, time.time() - t0)
    staging = a.out_dir / ".reptiles.tmp"
    shutil.rmtree(staging, ignore_errors=True)
    try:
        sizes = write_tiles(counts, staging)
        if sum(sizes.values()) > a.budget:
            raise SystemExit(
                f"{sum(sizes.values()):,} B of tiles is over the {a.budget:,} B budget: nothing published"
            )
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    final, old = a.out_dir / "reptiles", a.out_dir / ".reptiles.old"
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(staging, final)
    shutil.rmtree(old, ignore_errors=True)
    total = counts.sum(0)
    top = int(total.max())
    write_atomic(
        a.out_dir / "reptiles.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "maxLevel": MAX_LEVEL,
            "tile": "data/reptiles/{z}/{x}/{y}.png",
            "groupTile": "data/reptiles/groups/{x}/{y}.png",
            "groups": list(GROUP_NAMES),
            "palette": [list(c) for c in palette(top)],
            "maxSpecies": top,
            "species": expect,
            "resolution": f"{RES}° cells; a species counts in every cell its range overlaps",
            "source": SOURCE,
            "bytes": sizes,
        },
    )
    log.info(
        "wrote %s: %d species, up to %d per cell, %.1f MB (%.0f s)",
        a.out_dir / "reptiles.json",
        expect,
        top,
        sum(sizes.values()) / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
