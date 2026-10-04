"""Mammal species richness from the MDD v1.2 range maps → a geographic tile pyramid and level-3 group tiles.

Spec: docs/superpowers/specs/2026-10-04-mammal-richness-design.md. Zenodo 10.5281/zenodo.6644198 (CC BY 4.0) holds one
range polygon per species for the 6,362 wild extant mammals of the Mammal Diversity Database v1.2 (Marsh et al. 2022),
as one zipped GeoPackage per order. Each zip is downloaded once and refused unless its md5 is Zenodo's; each GeoPackage
is extracted beside it, read, and deleted. Every range is rasterised, over its own bounding box, onto a global 0.1° grid
with rasterio's all_touched rule (a species counts in every cell its range overlaps), into four counts: rodents, bats,
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
# Zenodo's md5 of each file used (record 6644198, read from the API 2026-10-04); MDD_Mammalia.zip repeats the orders
FILES = {
    "MDD_Afrosoricida.zip": "010b4ebfa2f3a6c048b4f5a107f8c832",
    "MDD_Artiodactyla.zip": "66d9dd023ff5f08003403e1146c6878b",
    "MDD_Carnivora.zip": "0c8ac8dcbfae968f3a3bde052eafcdb5",
    "MDD_Chiroptera.zip": "3ecf49e018f4ab9654e22258776076fc",
    "MDD_Cingulata.zip": "712f4c15e188e640a2a66b42d70bd301",
    "MDD_Dasyuromorphia.zip": "a52903bb9161e42bcd7bf69b4b25c216",
    "MDD_Dermoptera.zip": "70aa0f1fe5699c2e29c4adb684ca1bb7",
    "MDD_Didelphimorphia.zip": "6947eae1a64a2f804a00174cc4782e6c",
    "MDD_Diprotodontia.zip": "e7e087448d683daa3f038137e9d1f3b2",
    "MDD_Eulipotyphla.zip": "a6bc6a36fb2cff75314d88c0c4057e96",
    "MDD_Hyracoidea.zip": "75e03137f812843d84d2f3527b48c9d9",
    "MDD_Lagomorpha.zip": "c743c3074b3410a8c50b84631d4e3790",
    "MDD_Macroscelidea.zip": "d7608188b607d0f391ee3e5a78752c60",
    "MDD_Microbiotheria.zip": "6272985e06f4c00b8469415e8f3d2566",
    "MDD_Monotremata.zip": "0508a96e6a74bcab4c67858d3aaa44cd",
    "MDD_Notoryctemorphia.zip": "d327954aaf726337db138e03061c952d",
    "MDD_Paucituberculata.zip": "928d18fff093c2ec7690e882109c73ae",
    "MDD_Peramelemorphia.zip": "a16f6c5ef5fe8e0aeedc4e57c212d081",
    "MDD_Perissodactyla.zip": "cef638facedec39f15fb781ed667ec14",
    "MDD_Pholidota.zip": "eb60331ad29f8adc2e031979017602ee",
    "MDD_Pilosa.zip": "c84e1b3e3e4383a0a110d423bfc63f54",
    "MDD_Primates.zip": "b86186911dca2184634b0bf4f26f60b8",
    "MDD_Proboscidea.zip": "d6cc403fd705cd460b93af77920ca38a",
    "MDD_Rodentia.zip": "116f53920981f5b1ca6cb80fcdc4116b",
    "MDD_Scandentia.zip": "54fbf63a8b0c389bb905e117858eeb35",
    "MDD_Sirenia.zip": "404a1f1f3ada855a7b0bebc14d892cd6",
    "MDD_Tubulidentata.zip": "54b84a682354612be46914aa99ad8d37",
    SPECIES_LIST: "4a800c367f7f8d767779d2f68df40f93",
}
EXPECTED_SPECIES = 6362
RES = 0.1  # degrees per grid cell
MAX_LEVEL = 3  # 4096 × 2048: finer than the 0.1° grid (3600 × 1800)
BUDGET_BYTES = 6_000_000
# MDD order → count: rodents, bats, primates, other
GROUPS = {"RODENTIA": 0, "CHIROPTERA": 1, "PRIMATES": 2}
GROUP_NAMES = ("rodents", "bats", "primates", "other")
MEMBER = re.compile(r"^(?P<order>[A-Za-z]+)/MDD_(?P=order)\.gpkg$")
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


def read_ranges(d: Path, zips, batch: int = 20):
    """Yield (scientific name, ORDER, shapely geometry, bounds) per species, order zip by order zip."""
    import pyogrio.raw
    import shapely

    for zname in zips:
        zpath = d / zname
        with zipfile.ZipFile(zpath) as z:
            names = [n for n in z.namelist() if not n.endswith("/")]
        if len(names) != 1 or not MEMBER.match(names[0]):
            raise ValueError(
                f"{zname}: members {names[:5]} are not one <Order>/MDD_<Order>.gpkg"
            )
        order = MEMBER.match(names[0])["order"]
        if f"MDD_{order}.zip" != zname:
            raise ValueError(f"{zname} holds {names[0]}")
        # GDAL reads a GeoPackage inside a zip ~30x slower than from disk (SQLite seeks through the deflate stream:
        # Primates 71 s against 2 s extracted), so each one is extracted beside its zip and deleted once read
        with tempfile.TemporaryDirectory(dir=d, prefix=".extract-") as tmp:
            with zipfile.ZipFile(zpath) as z:
                path = z.extract(names[0], tmp)
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


def rasterise(ranges, listed: dict[str, str], res: float = RES) -> np.ndarray:
    """(4, rows, cols) uint16 counts per cell: rodents, bats, primates, other. Each range is burnt over its bbox only."""
    from rasterio import features
    from rasterio.transform import from_origin

    w, h = int(round(360 / res)), int(round(180 / res))
    counts = np.zeros((len(GROUP_NAMES), h, w), np.uint16)
    seen = set()
    for name, order, geom, (x0, y0, x1, y1) in ranges:
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
        counts[GROUPS.get(order, 3), r0:r1, c0:c1] += burnt
    missing = sorted(set(listed) - seen)
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
    zips = sorted(n for n in want if n.endswith(".zip"))
    counts = rasterise(read_ranges(d, zips), listed)
    log.info("rasterised %d species (%.0f s)", len(listed), time.time() - t0)
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
            "species": len(listed),
            "resolution": f"{RES}° cells; a species counts in every cell its range overlaps",
            "source": SOURCE,
            "bytes": sizes,
        },
    )
    log.info(
        "wrote %s: %d species, up to %d per cell, %.1f MB (%.0f s)",
        a.out_dir / "mammals.json",
        len(listed),
        top,
        sum(sizes.values()) / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
