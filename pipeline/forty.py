"""Forest Typology 2020 v1 (ForTy; Neumann et al. 2026, Nature Trace with WRI and IIASA, CC BY 4.0) → one geographic tile
pyramid of the most likely forest type: primary, naturally regenerating, planted, plantation, or tree crops and
agroforestry, with other land left clear.

ForTy is 135,542 UTM Cloud-Optimized GeoTIFFs at 10 m (311 GiB), mirrored unchanged on Source Cooperative with a
STAC-geoparquet index, which is pinned by sha256. Each tile holds five class probabilities, 0-250 (255 = no data); other
land is 250 minus their sum, and the class is the argmax of the six (the dataset's README and Earth Engine example).
Only each tile's 16x overview (~160 m, cubic) is read: the pilot of 2026-10-25 measured 0.022 s per tile with 32
threads on msi-4080 and a mean 20 kB, so the whole read is about 50 minutes and 2.7 GB. The six probabilities are
averaged onto Cesium's geographic tiling scheme at MAX_LEVEL (~610 m), weighted by how much of each pixel a tile
covers, so overlapping tiles at zone edges count once each by area; the class is the argmax there. Each coarser
level sums its four children's probabilities and takes the argmax again, so a coarse pixel shows the type most of its
area most likely is, not any forest at all within it. Painted tiles only; forty.json, written last, lists them and is
what the layer reads. A tile that cannot be read after RETRIES attempts fails the run: a hole would read as no forest.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import logging
import math
import os
import shutil
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from .atomic import write_atomic
from .cell_share import png as cell_png
from .cell_share import replace_dir
from .net import urlopen

log = logging.getLogger("forty")
STAC_URL = "https://data.source.coop/epoch/forest-typology-2020/v1/stac/forty_2020_stac.parquet"
# the index served 2026-10-25 (10,491,317 bytes, 135,542 items)
STAC_SHA256 = "c7588a86f162080aba2d17f6ff67a6bfb7015e00373e791bf9750ee1923c5130"
UA = "wildeye/0.1 (forest typology; +https://github.com/musharna)"
TILE = 256
MAX_LEVEL = (
    7  # 256 x 128 tiles at the finest level: 0.0055 degrees, about 610 m at the equator
)
BLOCK_LEVELS = 4  # a block is one tile at MAX_LEVEL - 4: 16 x 16 finest tiles (4096 px) painted at once
OVERVIEW = 16  # read each COG's 16x overview, ~160 m
RETRIES = 3
WORKERS = 32
NODATA = 255
EARTH_KM = 6371.0088
# the dataset's classes in band order (its STAC classification table) and the Earth Engine example's colours
CLASSES = [
    {
        "index": 1,
        "name": "primary_forest",
        "label": "primary forest",
        "rgb": [0x1B, 0x78, 0x37],
    },
    {
        "index": 2,
        "name": "naturally_regenerating_forest",
        "label": "naturally regenerating forest",
        "rgb": [0x7F, 0xBF, 0x7B],
    },
    {
        "index": 3,
        "name": "planted_forest",
        "label": "planted forest",
        "rgb": [0x1D, 0x91, 0xC0],
    },
    {
        "index": 4,
        "name": "plantation_forest",
        "label": "plantation forest",
        "rgb": [0xE6, 0x5F, 0xA9],
    },
    {
        "index": 5,
        "name": "tree_crops_and_agroforestry",
        "label": "tree crops and agroforestry",
        "rgb": [0xE6, 0xAB, 0x02],
    },
]
STAC_CLASSES = [c["name"] for c in CLASSES] + ["other_land"]
PALETTE = [[0, 0, 0]] + [c["rgb"] for c in CLASSES]
SOURCE = {
    "name": "Forest Typology 2020 v1 (ForTy), Nature Trace",
    "licence": "CC BY 4.0",
    "dataset": "doi:10.25452/figshare.plus.32288616.v1",
    "preprint": "doi:10.31223/X58R27",
    "mirror": "https://source.coop/epoch/forest-typology-2020",
    "stacSha256": STAC_SHA256,
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_to(url: str, path: Path) -> None:
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch_stac(
    cache: Path, sha: str = STAC_SHA256, url: str = STAC_URL, fetch_to=_fetch_to
) -> Path:
    """The STAC index from the cache or the mirror; a file whose sha256 is not the pinned one is refused and deleted."""
    path = cache / "forty_2020_stac.parquet"
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(".part")
        fetch_to(url, part)
        os.replace(part, path)
    got = _sha256(path)
    if got != sha:
        path.unlink()
        raise ValueError(
            f"{url}: sha256 {got}, pinned {sha}; the index changed, so the tiles may have too"
        )
    return path


def read_items(path: Path) -> list[dict]:
    """[{id, href, west, south, east, north}] from the STAC index, refused unless every item has the documented class
    table in the documented order."""
    import duckdb

    rows = duckdb.sql(
        "select id, assets.forty.href, bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax,"
        ' list_transform(assets.forty."classification:classes", lambda c: c.name),'
        ' list_transform(assets.forty."classification:classes", lambda c: c.value)'
        " from read_parquet(?)",
        params=[str(path)],
    ).fetchall()
    want_values = list(range(len(STAC_CLASSES)))
    bad = [
        r[0] for r in rows if list(r[6]) != STAC_CLASSES or list(r[7]) != want_values
    ]
    if bad:
        raise ValueError(
            f"{len(bad)} items lack the class table {STAC_CLASSES} (first: {bad[0]})"
        )
    return [
        {
            "id": r[0],
            "href": r[1],
            "west": r[2],
            "south": r[3],
            "east": r[4],
            "north": r[5],
        }
        for r in rows
    ]


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a geographic-scheme tile, y from the north."""
    d = 180 / 2**z
    return (-180 + x * d, 90 - (y + 1) * d, -180 + (x + 1) * d, 90 - y * d)


def open_tile(href: str):
    import rasterio

    path = f"/vsicurl/{href}" if href.startswith("http") else href
    env = {
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
        "GDAL_HTTP_MULTIPLEX": "YES",
    }
    with rasterio.Env(**env), rasterio.open(path) as src:
        ovr = src.overviews(1)
        if OVERVIEW not in ovr:
            raise ValueError(f"{href}: overviews {ovr}, no {OVERVIEW}x")
        level = ovr.index(OVERVIEW)
    with rasterio.Env(**env), rasterio.open(path, overview_level=level) as o:
        if o.count != len(CLASSES) or o.dtypes[0] != "uint8":
            raise ValueError(
                f"{href}: {o.count} bands of {o.dtypes[0]}, expected {len(CLASSES)} of uint8"
            )
        return o.read(), o.transform, o.crs


def probabilities(a: np.ndarray) -> np.ndarray:
    """(5, h, w) uint8 → (7, h, w) float32: the six class probabilities, then validity. No data (255 in the first band)
    is 0 everywhere, so averaging weights each probability by the share of a pixel that has data."""
    valid = a[0] != NODATA
    p = np.minimum(
        a.astype(np.float32), 250
    )  # a cubic overview can overshoot 250 by a little
    other = np.clip(250 - p.sum(0, keepdims=True), 0, None)
    out = np.concatenate([p, other, np.full((1,) + a.shape[1:], 250, np.float32)]) / 250
    out[:, ~valid] = 0
    return out


def paint(
    items: list[dict],
    block: tuple[int, int],
    max_level: int,
    workers: int,
    opener=open_tile,
):
    """(sums, weight) for one block, a tile at level max_level - BLOCK_LEVELS (or 0): the six probabilities and the
    covered share summed over the tiles that touch it, on the block's finest-level pixels."""
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject

    bl = max(0, max_level - BLOCK_LEVELS)
    n = TILE * 2 ** (max_level - bl)
    west, _south, east, north = tile_bounds(bl, *block)
    px = (east - west) / n
    sums = np.zeros((6, n, n), np.float32)
    weight = np.zeros((n, n), np.float32)

    def one(item):
        for attempt in range(RETRIES):
            try:
                a, tf, crs = opener(item["href"])
                break
            except Exception as e:
                if attempt == RETRIES - 1:
                    raise RuntimeError(
                        f"{item['id']}: {RETRIES} reads failed: {e}"
                    ) from e
                time.sleep(2 * (attempt + 1))
        c0 = max(0, int((item["west"] - west) / px) - 2)
        c1 = min(n, math.ceil((item["east"] - west) / px) + 2)
        r0 = max(0, int((north - item["north"]) / px) - 2)
        r1 = min(n, math.ceil((north - item["south"]) / px) + 2)
        if c0 >= c1 or r0 >= r1:
            return None
        out = np.zeros((7, r1 - r0, c1 - c0), np.float32)
        reproject(
            probabilities(a),
            out,
            src_transform=tf,
            src_crs=crs,
            dst_transform=from_origin(west + c0 * px, north - r0 * px, px, px),
            dst_crs="EPSG:4326",
            resampling=Resampling.average,
            # no nodata either side: validity is band 6, and GDAL 3.12.2 writes a genuine 0 next to a declared
            # nodata of 0 as the smallest float (1.4e-45), which classify would read as covered ground
            src_nodata=None,
            dst_nodata=None,
        )
        return r0, r1, c0, c1, out

    with ThreadPoolExecutor(workers) as ex:
        for res in ex.map(one, items):
            if res is not None:
                r0, r1, c0, c1, out = res
                sums[:, r0:r1, c0:c1] += out[:6]
                weight[r0:r1, c0:c1] += out[6]
    return sums, weight


def classify(sums: np.ndarray, weight: np.ndarray) -> np.ndarray:
    """Palette index per pixel: 1-5 for the forest class with the largest summed probability, 0 for other land or
    no data."""
    best = sums.argmax(0)
    return np.where((weight > 0) & (best < len(CLASSES)), best + 1, 0).astype(np.uint8)


def halve(a: np.ndarray) -> np.ndarray:
    """Sum 2 x 2 blocks over the last two axes."""
    h, w = a.shape[-2:]
    return a.reshape(a.shape[:-2] + (h // 2, 2, w // 2, 2)).sum(axis=(-3, -1))


def row_areas_km2(north: float, rows: int, px_deg: float) -> np.ndarray:
    """Area in km² of one pixel in each of `rows` rows from latitude `north` down, px_deg degrees square."""
    lat = np.radians(north - px_deg * np.arange(rows + 1))
    return EARTH_KM**2 * math.radians(px_deg) * (np.sin(lat[:-1]) - np.sin(lat[1:]))


def png(arr: np.ndarray) -> bytes:
    return cell_png(arr, PALETTE)


def _write_tiles(
    tmp: Path, z: int, x0: int, y0: int, idx: np.ndarray, listed: dict
) -> int:
    """The painted tiles of idx, whose top-left tile is (x0, y0) at level z; returns the bytes written."""
    total = 0
    for ty in range(idx.shape[0] // TILE):
        for tx in range(idx.shape[1] // TILE):
            t = idx[ty * TILE : (ty + 1) * TILE, tx * TILE : (tx + 1) * TILE]
            if not t.any():
                continue
            p = tmp / str(z) / str(x0 + tx) / f"{y0 + ty}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = png(t)
            p.write_bytes(data)
            listed.setdefault(str(z), []).append([x0 + tx, y0 + ty])
            total += len(data)
    return total


def build(
    items: list[dict],
    out_dir: Path,
    *,
    max_level: int = MAX_LEVEL,
    workers: int = WORKERS,
    opener=open_tile,
    now=None,
) -> dict:
    """Tiles into out_dir/forty (replaced whole), then out_dir/forty.json; returns the manifest."""
    bl = max(0, max_level - BLOCK_LEVELS)
    blocks: dict[tuple[int, int], list[dict]] = {}
    d = 180 / 2**bl
    for it in items:
        for bx in range(
            max(0, int((it["west"] + 180) // d)),
            min(2 ** (bl + 1), math.ceil((it["east"] + 180) / d)),
        ):
            for by in range(
                max(0, int((90 - it["north"]) // d)),
                min(2**bl, math.ceil((90 - it["south"]) / d)),
            ):
                blocks.setdefault((bx, by), []).append(it)
    tmp = out_dir / ".forty.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    listed: dict[str, list[list[int]]] = {}
    tile_bytes = 0
    km2 = np.zeros(len(CLASSES) + 1)
    coarse: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
    t0 = time.time()
    for k, (block, its) in enumerate(sorted(blocks.items())):
        sums, weight = paint(its, block, max_level, workers, opener)
        west, _south, east, north = tile_bounds(bl, *block)
        idx = classify(sums, weight)
        areas = row_areas_km2(north, idx.shape[0], (east - west) / idx.shape[1])
        km2 += np.bincount(
            idx.ravel(),
            weights=np.repeat(areas, idx.shape[1]),
            minlength=len(CLASSES) + 1,
        )
        for z in range(max_level, bl - 1, -1):
            f = 2 ** (z - bl)
            tile_bytes += _write_tiles(
                tmp, z, block[0] * f, block[1] * f, classify(sums, weight), listed
            )
            if z > bl:
                sums, weight = halve(sums), halve(weight)
        coarse[block] = (sums, weight)  # one level-bl tile
        log.info(
            "block %d/%d %s: %d tiles read, %.0f s",
            k + 1,
            len(blocks),
            block,
            len(its),
            time.time() - t0,
        )
    for z in range(
        bl - 1, -1, -1
    ):  # whole levels above the blocks, from summed probabilities as below
        up: dict[tuple[int, int], list] = {}
        for (x, y), (s, w) in coarse.items():
            big = up.setdefault(
                (x // 2, y // 2),
                [
                    np.zeros((6, 2 * TILE, 2 * TILE), np.float32),
                    np.zeros((2 * TILE, 2 * TILE), np.float32),
                ],
            )
            oy, ox = (y % 2) * TILE, (x % 2) * TILE
            big[0][:, oy : oy + TILE, ox : ox + TILE] = s
            big[1][oy : oy + TILE, ox : ox + TILE] = w
        coarse = {k: (halve(s), halve(w)) for k, (s, w) in up.items()}
        for (x, y), (s, w) in coarse.items():
            tile_bytes += _write_tiles(tmp, z, x, y, classify(s, w), listed)
    for z in range(max_level + 1):
        listed[str(z)] = sorted(listed.get(str(z), []))
    replace_dir(tmp, out_dir / "forty")
    when = (now or (lambda: dt.datetime.now(dt.UTC)))()
    manifest = {
        "generated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxLevel": max_level,
        "tile": "data/forty/{z}/{x}/{y}.png",
        "tiles": listed,
        "classes": [
            {
                "index": c["index"],
                "label": c["label"],
                "rgb": c["rgb"],
                "km2": round(km2[c["index"]]),
            }
            for c in CLASSES
        ],
        "itemsRead": sum(len(v) for v in blocks.values()),
        "items": len(items),
        "tileBytes": tile_bytes,
        "source": SOURCE,
    }
    write_atomic(out_dir / "forty.json", manifest)  # last: the layer reads this one
    return manifest


def main(
    argv=None, *, fetch_to=_fetch_to, sha=STAC_SHA256, opener=open_tile, now=None
) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "forty",
    )
    ap.add_argument("--max-level", type=int, default=MAX_LEVEL)
    ap.add_argument("--workers", type=int, default=WORKERS)
    ap.add_argument(
        "--bbox", help="west,south,east,north: only the tiles inside, for a trial run"
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    items = read_items(fetch_stac(a.cache, sha, fetch_to=fetch_to))
    if a.bbox:
        w, s, e, n = (float(v) for v in a.bbox.split(","))
        items = [
            i
            for i in items
            if i["west"] < e and i["east"] > w and i["south"] < n and i["north"] > s
        ]
    log.info("%d STAC items", len(items))
    m = build(
        items,
        a.out_dir,
        max_level=a.max_level,
        workers=a.workers,
        opener=opener,
        now=now,
    )
    log.info(
        "%d tiles read (with block overlaps), %d tiles written, %.1f MB; km²: %s",
        m["itemsRead"],
        sum(len(v) for v in m["tiles"].values()),
        m["tileBytes"] / 1e6,
        ", ".join(f"{c['label']} {c['km2']:,}" for c in m["classes"]),
    )
    return m


if __name__ == "__main__":
    main()
