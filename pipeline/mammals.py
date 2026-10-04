"""Mammal species richness from the MDD v1.2 range maps → a geographic tile pyramid and level-3 group tiles.

Spec: docs/superpowers/specs/2026-10-04-mammal-richness-design.md. Zenodo 10.5281/zenodo.6644198 (CC BY 4.0) holds one
range polygon per species for the 6,362 wild extant mammals of the Mammal Diversity Database v1.2 (Marsh et al. 2022),
as one zipped GeoPackage per order, all 27 stored in MDD_Mammalia.zip. The bundle is downloaded once and refused unless its
md5 is Zenodo's; each order zip is copied out of it and each GeoPackage extracted with Info-ZIP unzip, read, and deleted. Every range is counted, over its own bounding box, on a global 0.1° grid
in every cell it overlaps (the cell's centre lies in the range, or the range's outline touches the cell), into four counts: rodents, bats,
primates and other. The species read must be exactly the 6,362 of the release's own list, each once, under the taxonomic
order the list gives it. The total is resampled by nearest neighbour to level 3 of Cesium's geographic tiling, one palette colour per
count, coarser levels the mean over cells with any species; level 3 also gets RGB group tiles (rodents, bats, primates)
so a readout can split the total exactly. A count over 255 or tiles over the budget stop the run; mammals.json, written
last, is what the layer reads.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import logging
import os
import re
import shutil
import subprocess  # nosec B404 - runs unzip with a fixed argument list, no shell
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np

from .atomic import write_atomic
from .bii import nearest
from .hfp import TILE, _fetch_to, _md5, _png, tiles_for_level
from .reptiles import group_png, levels

log = logging.getLogger("mammals")
RECORD_API = "https://zenodo.org/api/records/6644198"
CACHE_DIR = "mdd"
SPECIES_LIST = "mdd_spList_wFamilieswOrders_mapped_6362species.csv"
# Zenodo's md5 of each file used (record 6644198, read from the API 2026-10-04). MDD_Mammalia.zip stores all 27 order
# zips as exported 2021-06-22; the record's standalone order zips are an export of 2021-06-11 whose Sirenia lacks the
# three manatees, so only the bundle is used.
RELEASE = "MDD_Mammalia.zip"
FILES = {
    RELEASE: "758a24a37669a701c1c809c0bfac3da7",
    SPECIES_LIST: "4a800c367f7f8d767779d2f68df40f93",
}
EXPECTED_ORDERS = 27
EXPECTED_SPECIES = 6362  # rows of the release's list
# Where the list and the maps disagree (checked against every name in the bundle 2026-10-04). The record's description
# says these two bats have no spatial information, though the list of mapped species names them:
UNMAPPED = frozenset({"Nycticeius aenobarbus", "Phoniscus aerosus"})
# and one civet's map spells the epithet differently from the list (Paradoxurus philippensis); the list's name is kept
MAP_NAMES = {"Paradoxurus philippinensis": "Paradoxurus philippensis"}
MAPPED_SPECIES = EXPECTED_SPECIES - len(UNMAPPED)
RES = 0.1  # degrees per grid cell
# An outline within this of a grid line (~1 cm) is taken to run along it, not into the cell beyond (see overlapped).
EDGE_EPS = 1e-7
MAX_LEVEL = 3  # 4096 × 2048: finer than the 0.1° grid (3600 × 1800)
BUDGET_BYTES = 6_000_000
# MDD order → count: rodents, bats, primates, other
GROUPS = {"RODENTIA": 0, "CHIROPTERA": 1, "PRIMATES": 2}
GROUP_NAMES = ("rodents", "bats", "primates", "other")
UNZIP = shutil.which("unzip")
ORDER_ZIP = re.compile(r"^MDD_[A-Za-z]+\.zip$")
# 24 order zips hold <Order>/MDD_<Order>.gpkg; Artiodactyla, Carnivora and Sirenia hold MDD_<Order>.gpkg at the root
MEMBER = re.compile(r"^(?:(?P<folder>[A-Za-z]+)/)?MDD_(?P<order>[A-Za-z]+)\.gpkg$")
# deep blue-violet through teal and green to pale yellow; no channel ever falls, so more species is always lighter, and
# each segment moves one channel by at least as many steps as it spans, so 255 counts get 255 distinct colours
RAMP = [(40, 25, 105), (40, 115, 140), (80, 200, 150), (250, 240, 170)]
SOURCE = {
    "id": "mammals",
    "name": "Range maps for the Mammal Diversity Database v1.2 taxonomy (Marsh et al.)",
    "url": "https://doi.org/10.5281/zenodo.6644198",
    "licence": "CC BY 4.0 (Zenodo 10.5281/zenodo.6644198)",
    "citation": "Marsh C.J., Sica Y.V., Burgin C.J. et al. (2022) Expert range maps of global mammal distributions "
    "harmonised to three taxonomic authorities. Journal of Biogeography 49:979–992. doi:10.1111/jbi.14330",
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


def species_list(path: Path) -> dict[str, str]:
    """{scientific name: ORDER} from the release's list of the mapped species."""
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    out = {}
    for r in rows:
        name = r["MDD_SciName"]
        if name in out:
            raise ValueError(f"{path.name}: {name} is listed twice")
        out[name] = r["Order"].upper()
    return out


def read_ranges(d: Path, zips, batch: int = 1):
    """Yield (scientific name, ORDER, shapely geometry, bounds) per species, order zip by order zip. One feature per
    read by default: a large whale's range is ~440 MB of WKB, and 20 of them at once ran out of memory."""
    import pyogrio.raw
    import shapely

    if UNZIP is None:
        raise RuntimeError("Info-ZIP unzip is not on PATH: it extracts the release's Deflate64 order zips")

    for zname in zips:
        zpath = d / zname
        with zipfile.ZipFile(zpath) as z:
            # the bundle's order zips also carry the release's citation.txt
            names = [n for n in z.namelist() if not n.endswith("/") and n != "citation.txt"]
        m = MEMBER.match(names[0]) if len(names) == 1 else None
        if not m:
            raise ValueError(
                f"{zname}: members {names[:5]} are not one [<Order>/]MDD_<Order>.gpkg"
            )
        order = m["order"]
        if f"MDD_{order}.zip" != zname or m["folder"] not in (None, order):
            raise ValueError(f"{zname} holds {names[0]}")
        # GDAL reads a GeoPackage inside a zip ~30x slower than from disk (SQLite seeks through the deflate stream:
        # Primates 71 s against 2 s extracted), so each one is extracted beside its zip and deleted once read. Info-ZIP
        # unzip does it: the release packs its two largest orders (Chiroptera, Rodentia) with Deflate64, which Python's
        # zipfile cannot inflate. The member name matched MEMBER, so it holds no unzip wildcard.
        with tempfile.TemporaryDirectory(dir=d, prefix=".extract-") as tmp:
            subprocess.run([UNZIP, "-q", str(zpath), names[0], "-d", tmp], check=True)  # nosec B603 - fixed argv, no shell
            path = str(Path(tmp) / names[0])
            n = pyogrio.read_info(path)["features"]
            for off in range(0, n, batch):
                _, _, geom, fields = pyogrio.raw.read(
                    path,
                    columns=["sciname", "order"],
                    skip_features=off,
                    max_features=batch,
                )
                for g, name, o in zip(shapely.from_wkb(geom), fields[0], fields[1]):
                    if o.upper() != order.upper():
                        raise ValueError(f"{zname}: {name} is in order {o}")
                    yield name, order.upper(), g, g.bounds


def overlapped(geom, r0: int, r1: int, c0: int, c1: int, res: float = RES) -> np.ndarray:
    """uint8 (r1 - r0, c1 - c0): 1 in each cell of the window the range overlaps, i.e. the range and the cell share
    interior (shapely: intersects and not touches): the cell's centre lies in the range (shapely, prepared) or the range's
    outline crosses the cell's interior. The crossing is rasterio's all_touched on the outline as lines, burnt on four
    grids moved EDGE_EPS diagonally (north-west, north-east, south-west, south-east) off the true one, and kept where all
    agree. Burnt once, an outline running exactly along a grid line went to whichever side the window origin's float
    rounding chose (east or south on an exact origin), so a range counted in a cell where it has no area, and only when
    the window (the range's own bounds) reached that cell. On opposite grids such a line falls on opposite sides; where
    two such lines meet at a grid node (an inner corner), the cell in the corner is missed by both on the grid moved
    towards it. A crossing within EDGE_EPS of a cell's edge is not counted. Avoids GDAL's polygon fill, which walks every
    edge for every row: ~14 min for a whale range of 27 M vertices against ~31 s here."""
    import shapely
    from rasterio import features
    from rasterio.transform import from_origin

    shapely.prepare(geom)
    xs = -180 + (np.arange(c0, c1) + 0.5) * res
    inside = np.zeros((r1 - r0, c1 - c0), bool)
    for i in range(r1 - r0):
        inside[i] = shapely.contains_xy(geom, xs, np.full_like(xs, 90 - (r0 + i + 0.5) * res))
    outline = shapely.boundary(geom)
    edge = [
        features.rasterize(
            [(outline, 1)],
            out_shape=(r1 - r0, c1 - c0),
            transform=from_origin(-180 + c0 * res + sx, 90 - r0 * res + sy, res, res),
            fill=0,
            dtype="uint8",
            all_touched=True,
        ).astype(bool)
        for sx in (-EDGE_EPS, EDGE_EPS)
        for sy in (-EDGE_EPS, EDGE_EPS)
    ]
    return (inside | np.logical_and.reduce(edge)).astype(np.uint8)


def read_release(path: Path, batch: int = 1):
    """read_ranges over the order zips stored in MDD_Mammalia.zip, each copied out beside it, read and deleted."""
    with zipfile.ZipFile(path) as outer:
        names = [n for n in outer.namelist() if not n.endswith("/") and n != "citation.txt"]
        odd = [n for n in names if not ORDER_ZIP.match(n)]
        if len(names) != EXPECTED_ORDERS or odd:
            raise ValueError(
                f"{path.name}: {len(names)} members, not {EXPECTED_ORDERS} MDD_<Order>.zip (unexpected: {odd})"
            )
        for name in sorted(names):
            with tempfile.TemporaryDirectory(dir=path.parent, prefix=".order-") as tmp:
                with outer.open(name) as src, open(Path(tmp) / name, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 24)
                yield from read_ranges(Path(tmp), [name], batch)


def rasterise(ranges, listed: dict[str, str], res: float = RES) -> np.ndarray:
    """(4, rows, cols) uint16 counts per cell: rodents, bats, primates, other. Each range is counted over its bbox only."""
    w, h = int(round(360 / res)), int(round(180 / res))
    counts = np.zeros((len(GROUP_NAMES), h, w), np.uint16)
    seen = set()
    for name, order, geom, (x0, y0, x1, y1) in ranges:
        name = MAP_NAMES.get(name, name)
        if name in UNMAPPED:
            raise ValueError(f"{name} is mapped, though the record says it has no map")
        if name in seen:
            raise ValueError(f"{name}: mapped twice")
        if listed.get(name) != order:
            raise ValueError(
                f"{name} ({order}) is not on the release's list as {listed.get(name)}"
            )
        seen.add(name)
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
        burnt = overlapped(geom, r0, r1, c0, c1, res)
        if not burnt.any():
            raise ValueError(f"{name}: range overlaps no cell")
        counts[GROUPS.get(order, 3), r0:r1, c0:c1] += burnt
    missing = sorted(set(listed) - seen - UNMAPPED)
    if missing:
        raise ValueError(f"{len(missing)} listed species have no range: {missing[:5]}")
    total = counts.sum(0)
    if total.max() > 255:
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


def main(argv=None, *, fetch_to=_fetch_to, want: dict = FILES) -> int:
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
    listed = species_list(d / SPECIES_LIST)
    counts = rasterise(read_release(d / RELEASE), listed)
    mapped = len(set(listed) - UNMAPPED)
    log.info("rasterised %d species (%.0f s)", mapped, time.time() - t0)
    staging = a.out_dir / ".mammals.tmp"
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
    final, old = a.out_dir / "mammals", a.out_dir / ".mammals.old"
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(staging, final)
    shutil.rmtree(old, ignore_errors=True)
    top = int(counts.sum(0).max())
    write_atomic(
        a.out_dir / "mammals.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "maxLevel": MAX_LEVEL,
            "tile": "data/mammals/{z}/{x}/{y}.png",
            "groupTile": "data/mammals/groups/{x}/{y}.png",
            "groups": list(GROUP_NAMES),
            "palette": [list(c) for c in palette(top)],
            "maxSpecies": top,
            "species": mapped,
            "resolution": f"{RES}° cells; a species counts in every cell its range overlaps",
            "source": SOURCE,
            "bytes": sizes,
        },
    )
    log.info(
        "wrote %s: %d species, up to %d per cell, %.1f MB (%.0f s)",
        a.out_dir / "mammals.json",
        mapped,
        top,
        sum(sizes.values()) / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
