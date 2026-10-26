"""AlphaEarth Foundations Satellite Embedding v1 (Google, Google DeepMind; CC BY 4.0) → one geographic tile pyramid
of where land in 2025 looks unlike any of the three years before it, more than it usually does.

The dataset is one 64-dimensional unit vector per 10 m pixel per year, 2017-2025, in UTM files of 8192 x 8192 pixels
(81.92 km) listed in a geoparquet index, which is pinned by sha256. Only each file's 128x overview is read: 64 x 64
cells of 1.28 km, each the renormalized mean of its pixels' vectors. The score is the one frozen by the pilot of
2026-10-26 (analysis/aef_change_pilot.py, aef_change_stats.py, docs/analysis/aef-change-pilot.md): nov3(k) is the cosine
distance from year k to the closest of years k-3..k-1, so a state seen recently (the other crop of a rotation, regrowth)
scores low, and score = (nov3(2025) - median nov3(2020..2024)) / max(1.4826 MAD, FLOOR), how unusual this year's
novelty is for this cell. A cell is flagged above THRESHOLD, the intact-forest 99.9th percentile on the pilot tiles,
and drawn in one of four bands. Cells with no data in any year, and cells next to them (partly covered: they flagged
33% vs 5% on the pilot tiles), have no score; so do locations without all nine years.

Phase 1 scores every location once into a cache of chunks, so an interrupted run resumes. Phase 2 paints Cesium's
geographic tiling scheme to MAX_LEVEL (~1.2 km), each pixel taking the score of the cell under its centre; a coarser
pixel is painted where at least COVER of its scored area is flagged, in the median band of the flagged part, so a
diffuse wash of single flags does not fill a zoomed-out map and a fire covering a quarter of a pixel still shows.
Painted tiles only; aef_change.json, written last, lists them and is what the layer reads. A file that cannot be read
after RETRIES attempts fails the run: a hole would read as no change.

The pilot measured 72 overview reads/s with 64 threads on msi-4080, so the ~296,000 reads take about 70 minutes.
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
from .forty import halve, row_areas_km2, tile_bounds
from .net import urlopen

log = logging.getLogger("aef_change")
BUCKET = "https://storage.googleapis.com/alphaearth_foundations/satellite_embedding/v1/annual"
INDEX_URL = f"{BUCKET}/aef_index.parquet"
# the index served 2026-10-26 (69,600,467 bytes, last modified 2026-02-27, 34,266 locations)
INDEX_SHA256 = "5d216665ff2e4b8871157d217230cc42d542f1ac9a4b224c16d5c1dbff9cb947"
UA = "wildeye/0.1 (land change; +https://github.com/musharna)"
YEARS = list(range(2017, 2026))
TARGET = 2025
HISTORY = list(range(2020, 2025))
LOOKBACK = 3
CELL = 64  # cells per file side at the overview read
FLOOR = 0.003  # frozen with the threshold before the held-out run (grill ledger)
THRESHOLD = 6.5
BANDS = [
    6.5,
    10.0,
    20.0,
    40.0,
]  # lower edges; on the pilot + held-out tiles 28%, 42%, 54%, 93% of flags sat on 2025 forest loss
SCORE_VERSION = 2  # bump when the score changes, so a cache of old scores is not reused (2: novelty relative to the file)
MIN_CELLS = 64  # a file with fewer scored cells has no file median to measure against
TILE = 256
MAX_LEVEL = 6  # 0.011 degrees, about 1.2 km at the equator
BLOCK_LEVELS = (
    4  # a block is one tile at MAX_LEVEL - 4: 16 x 16 finest tiles painted at once
)
COVER = 0.25
CHUNK = 256
RETRIES = 3
WORKERS = 64
NO_SCORE = 255
CLASSES = [
    {"index": 1, "label": "unusual change", "min": 6.5, "rgb": [0xFE, 0xD9, 0x76]},
    {"index": 2, "label": "strong change", "min": 10.0, "rgb": [0xFD, 0x8D, 0x3C]},
    {"index": 3, "label": "very strong change", "min": 20.0, "rgb": [0xE3, 0x1A, 0x1C]},
    {"index": 4, "label": "extreme change", "min": 40.0, "rgb": [0x80, 0x00, 0x26]},
]
assert [c["min"] for c in CLASSES] == BANDS and BANDS[0] == THRESHOLD
PALETTE = [[0, 0, 0]] + [c["rgb"] for c in CLASSES]
SOURCE = {
    "name": "AlphaEarth Foundations Satellite Embedding v1 (annual)",
    "licence": "CC BY 4.0",
    "attribution": "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.",
    "index": INDEX_URL,
    "indexSha256": INDEX_SHA256,
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
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=300
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch_index(
    cache: Path, sha: str = INDEX_SHA256, url: str = INDEX_URL, fetch_to=_fetch_to
) -> Path:
    """The file index from the cache or the bucket; a file whose sha256 is not the pinned one is refused and deleted."""
    path = cache / "aef_index.parquet"
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(".part")
        fetch_to(url, part)
        os.replace(part, path)
    got = _sha256(path)
    if got != sha:
        path.unlink()
        raise ValueError(
            f"{url}: sha256 {got}, pinned {sha}; the index changed, so the files may have too"
        )
    return path


def read_locations(path: Path) -> tuple[list[dict], int]:
    """([location], how many lack a year): one location per UTM file footprint, with its file for every year, in a
    fixed order. A footprint whose CRS differs between years is refused."""
    import duckdb

    rows = duckdb.execute(
        "select utm_zone, utm_west, utm_south, utm_east, utm_north, list(distinct crs),"
        " min(wgs84_west), min(wgs84_south), max(wgs84_east), max(wgs84_north),"
        " list(year order by year), list(path order by year)"
        " from read_parquet(?) group by utm_zone, utm_west, utm_south, utm_east, utm_north"
        " order by utm_zone, utm_west, utm_south",
        [str(path)],
    ).fetchall()
    locs, skipped = [], 0
    for zone, uw, us, ue, un, crs, w, s, e, n, years, paths in rows:
        if len(crs) != 1:
            raise ValueError(f"{zone} {uw},{us}: CRS differs between years {crs}")
        by_year = dict(zip(years, paths, strict=True))
        if len(by_year) != len(years):
            raise ValueError(f"{zone} {uw},{us}: two files for one year")
        if any(y not in by_year for y in YEARS):
            skipped += 1
            continue
        locs.append(
            {
                "key": f"{zone}_{round(uw)}_{round(us)}",
                "crs": crs[0],
                "utm": (uw, us, ue, un),
                "wgs84": (w, s, e, n),
                "paths": {y: by_year[y] for y in YEARS},
            }
        )
    return locs, skipped


def open_overview(path: str):
    """(64 x CELL x CELL int8 array, north-up transform) of the overview CELL cells across. AEF files are stored
    south-up (positive pixel height, origin at the south edge); rows are flipped so row 0 is the north edge."""
    import rasterio

    url = (
        "/vsicurl/" + path.replace("gs://", "https://storage.googleapis.com/")
        if "://" in path
        else path
    )
    env = {
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tiff,.tif",
        "GDAL_HTTP_MAX_RETRY": "4",
    }
    with rasterio.Env(**env):
        with rasterio.open(url) as ds:
            factor = ds.width // CELL
            if (
                ds.width != ds.height
                or ds.width != factor * CELL
                or factor not in ds.overviews(1)
            ):
                raise ValueError(
                    f"{path}: {ds.width} x {ds.height}, overviews {ds.overviews(1)}: no {CELL}-cell overview"
                )
            level = ds.overviews(1).index(factor)
        with rasterio.open(url, overview_level=level) as ds:
            if ds.count != 64 or ds.dtypes[0] != "int8":
                raise ValueError(
                    f"{path}: {ds.count} bands of {ds.dtypes[0]}, expected 64 of int8"
                )
            a = ds.read()
            tf = ds.transform
    if a.shape != (64, CELL, CELL):
        raise ValueError(f"{path}: overview shape {a.shape}")
    if tf.b != 0 or tf.d != 0:
        raise ValueError(f"{path}: rotated transform {tf}")
    if tf.e > 0:
        a = a[:, ::-1, :]
        tf = rasterio.Affine(tf.a, 0, tf.c, 0, -tf.e, tf.f + tf.e * CELL)
    return a, tf


def unit(a: np.ndarray) -> np.ndarray:
    """De-quantized (README: (v/127.5)² · sign(v)) and normalized vectors, NaN where all 64 values are no data (-128)."""
    v = a.astype(np.float32)
    d = (v / 127.5) ** 2 * np.sign(v)
    norm = np.linalg.norm(d, axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        d = d / norm
    d[:, (a == -128).all(0) | (norm == 0)] = np.nan
    return d


def score(arrays: dict[int, np.ndarray]) -> np.ndarray:
    """CELL x CELL float32 score from {year: 64 x CELL x CELL int8}; NaN where any year has no data, and next to it."""
    e = {y: unit(arrays[y]) for y in YEARS}
    bad = np.zeros(e[TARGET].shape[1:], bool)
    for v in e.values():
        bad |= np.isnan(v[0])
    pad = np.pad(bad, 1)
    h, w = bad.shape
    near = np.zeros_like(bad)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            near |= pad[dy : dy + h, dx : dx + w]

    if (~near).sum() < MIN_CELLS:
        return np.full(near.shape, np.nan, np.float32)

    def nov3(k):
        """Novelty of year k, less the file's median novelty that year: some files' years were made differently
        and sit ~0.02 from every other year in every cell (whole-file blocks in the Sahara), which this cancels."""
        n = np.min(
            np.stack([1.0 - (e[k] * e[j]).sum(0) for j in range(k - LOOKBACK, k)]), 0
        )
        return n - np.median(n[~near])

    hist = np.stack([nov3(k) for k in HISTORY])
    med = np.median(hist, 0)
    mad = 1.4826 * np.median(np.abs(hist - med), 0)
    with np.errstate(invalid="ignore"):
        z = (nov3(TARGET) - med) / np.maximum(mad, FLOOR)
    z[near] = np.nan
    return z.astype(np.float32)


def band(z: np.ndarray) -> np.ndarray:
    """uint8 per cell: NO_SCORE, 0 below the threshold, else the band 1-4."""
    out = np.full(z.shape, NO_SCORE, np.uint8)
    ok = np.isfinite(z)
    out[ok] = np.searchsorted(BANDS, z[ok], side="right")
    return out


def score_location(loc: dict, opener=open_overview) -> np.ndarray:
    uw, _us, ue, un = loc["utm"]
    size = (ue - uw) / CELL
    arrays = {}
    for y in YEARS:
        for attempt in range(RETRIES):
            try:
                a, tf = opener(loc["paths"][y])
                break
            except Exception as e:
                if attempt == RETRIES - 1:
                    raise RuntimeError(
                        f"{loc['key']} {y}: {RETRIES} reads failed: {e}"
                    ) from e
                time.sleep(2 * (attempt + 1))
        if (
            abs(tf.c - uw) > 1
            or abs(tf.f - un) > 1
            or abs(tf.a - size) > 1e-6
            or abs(tf.e + size) > 1e-6
        ):
            raise ValueError(
                f"{loc['key']} {y}: overview transform {tf} is not the index's footprint {loc['utm']}"
            )
        arrays[y] = a
    return score(arrays)


def score_all(
    locs: list[dict], cache: Path, workers: int = WORKERS, opener=open_overview
) -> dict[str, np.ndarray]:
    """{key: score} for every location, from cached chunks where present; each chunk is written when complete."""
    cache.mkdir(parents=True, exist_ok=True)
    out: dict[str, np.ndarray] = {}
    t0 = time.time()
    n_chunks = math.ceil(len(locs) / CHUNK)
    with ThreadPoolExecutor(workers) as ex:
        for i in range(n_chunks):
            part = locs[i * CHUNK : (i + 1) * CHUNK]
            keys = [loc["key"] for loc in part]
            path = cache / f"chunk_{i:05d}.npz"
            if path.exists():
                with np.load(path) as f:
                    if list(f["keys"]) == keys:
                        out.update(zip(keys, f["z"], strict=True))
                        continue
                log.warning("%s holds other locations: rescoring it", path.name)
            z = np.stack(list(ex.map(lambda loc: score_location(loc, opener), part)))
            tmp = path.with_suffix(".tmp.npz")
            np.savez_compressed(tmp, keys=np.array(keys), z=z)
            os.replace(tmp, path)
            out.update(zip(keys, z, strict=True))
            done = (i + 1) * CHUNK
            log.info(
                "chunk %d/%d scored, %.0f s, %.0f locations/min",
                i + 1,
                n_chunks,
                time.time() - t0,
                60 * min(done, len(locs)) / max(1.0, time.time() - t0),
            )
    return out


def paint_block(
    locs: list[dict],
    scores: dict[str, np.ndarray],
    block: tuple[int, int],
    max_level: int,
) -> np.ndarray:
    """uint8 bands (NO_SCORE where nothing is scored) on one block's finest-level pixels, each taking the cell under its
    centre. Files of one zone tile its plane without overlap and each file's data stops at its zone's edge, whose
    partial cells have no score, so the first scored cell found wins."""
    from pyproj import Transformer

    bl = max(0, max_level - BLOCK_LEVELS)
    n = TILE * 2 ** (max_level - bl)
    west, _south, east, north = tile_bounds(bl, *block)
    px = (east - west) / n
    out = np.full((n, n), NO_SCORE, np.uint8)
    transformers: dict[str, Transformer] = {}
    for loc in locs:
        w, s, e, nn = loc["wgs84"]
        c0, c1 = max(0, int((w - west) / px)), min(n, math.ceil((e - west) / px))
        r0, r1 = max(0, int((north - nn) / px)), min(n, math.ceil((north - s) / px))
        if c0 >= c1 or r0 >= r1:
            continue
        tr = transformers.get(loc["crs"]) or transformers.setdefault(
            loc["crs"], Transformer.from_crs("EPSG:4326", loc["crs"], always_xy=True)
        )
        lon = west + (np.arange(c0, c1) + 0.5) * px
        lat = north - (np.arange(r0, r1) + 0.5) * px
        lon2, lat2 = np.meshgrid(lon, lat)
        x, y = tr.transform(lon2, lat2)
        uw, _us, ue, un = loc["utm"]
        size = (ue - uw) / CELL
        col = np.floor((x - uw) / size)
        row = np.floor((un - y) / size)
        inside = (col >= 0) & (col < CELL) & (row >= 0) & (row < CELL)
        b = np.full(x.shape, NO_SCORE, np.uint8)
        b[inside] = band(scores[loc["key"]])[
            row[inside].astype(int), col[inside].astype(int)
        ]
        win = out[r0:r1, c0:c1]
        fill = (win == NO_SCORE) & (b != NO_SCORE)
        win[fill] = b[fill]
    return out


def one_hot(bands: np.ndarray) -> np.ndarray:
    """(len(CLASSES) + 1, h, w) float32: per pixel, 1 in the slot of its band (0 = scored, not flagged)."""
    k = len(CLASSES) + 1
    return (bands[None] == np.arange(k, dtype=np.uint8)[:, None, None]).astype(
        np.float32
    )


def classify(counts: np.ndarray) -> np.ndarray:
    """Palette index per pixel from per-band scored area: the median band of the flagged area where flagged area is at
    least COVER of the scored area, else 0 (clear)."""
    scored = counts.sum(0)
    flagged = counts[1:].sum(0)
    cum = np.cumsum(counts[1:], 0)
    median = (cum >= flagged / 2).argmax(0) + 1
    return np.where((flagged > 0) & (flagged >= COVER * scored), median, 0).astype(
        np.uint8
    )


def _write_tiles(
    tmp: Path, z: int, x0: int, y0: int, idx: np.ndarray, listed: dict
) -> int:
    total = 0
    for ty in range(idx.shape[0] // TILE):
        for tx in range(idx.shape[1] // TILE):
            t = idx[ty * TILE : (ty + 1) * TILE, tx * TILE : (tx + 1) * TILE]
            if not t.any():
                continue
            p = tmp / str(z) / str(x0 + tx) / f"{y0 + ty}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = cell_png(t, PALETTE)
            p.write_bytes(data)
            listed.setdefault(str(z), []).append([x0 + tx, y0 + ty])
            total += len(data)
    return total


def build(
    locs: list[dict],
    scores: dict[str, np.ndarray],
    out_dir: Path,
    *,
    skipped: int = 0,
    locations: int | None = None,
    max_level: int = MAX_LEVEL,
    now=None,
) -> dict:
    """Tiles into out_dir/aef_change (replaced whole), then out_dir/aef_change.json; returns the manifest."""
    bl = max(0, max_level - BLOCK_LEVELS)
    d = 180 / 2**bl
    blocks: dict[tuple[int, int], list[dict]] = {}
    for loc in locs:
        w, s, e, n = loc["wgs84"]
        for bx in range(
            max(0, int((w + 180) // d)), min(2 ** (bl + 1), math.ceil((e + 180) / d))
        ):
            for by in range(
                max(0, int((90 - n) // d)), min(2**bl, math.ceil((90 - s) / d))
            ):
                blocks.setdefault((bx, by), []).append(loc)
    tmp = out_dir / ".aef_change.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    listed: dict[str, list[list[int]]] = {}
    tile_bytes = 0
    km2 = np.zeros(len(CLASSES) + 1)
    coarse: dict[tuple[int, int], np.ndarray] = {}
    for block, its in sorted(blocks.items()):
        bands = paint_block(its, scores, block, max_level)
        west, _south, east, north = tile_bounds(bl, *block)
        areas = row_areas_km2(north, bands.shape[0], (east - west) / bands.shape[1])
        scored = bands != NO_SCORE
        km2 += np.bincount(
            bands[scored],
            weights=np.broadcast_to(areas[:, None], bands.shape)[scored],
            minlength=len(CLASSES) + 1,
        )[: len(CLASSES) + 1]
        counts = one_hot(bands)
        for z in range(max_level, bl - 1, -1):
            f = 2 ** (z - bl)
            tile_bytes += _write_tiles(
                tmp, z, block[0] * f, block[1] * f, classify(counts), listed
            )
            if z > bl:
                counts = halve(counts)
        coarse[block] = counts
    for z in range(bl - 1, -1, -1):
        up: dict[tuple[int, int], np.ndarray] = {}
        for (x, y), c in coarse.items():
            big = up.setdefault(
                (x // 2, y // 2),
                np.zeros((len(CLASSES) + 1, 2 * TILE, 2 * TILE), np.float32),
            )
            oy, ox = (y % 2) * TILE, (x % 2) * TILE
            big[:, oy : oy + TILE, ox : ox + TILE] = c
        coarse = {k: halve(c) for k, c in up.items()}
        for (x, y), c in coarse.items():
            tile_bytes += _write_tiles(tmp, z, x, y, classify(c), listed)
    for z in range(max_level + 1):
        listed[str(z)] = sorted(listed.get(str(z), []))
    replace_dir(tmp, out_dir / "aef_change")
    when = (now or (lambda: dt.datetime.now(dt.UTC)))()
    manifest = {
        "generated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxLevel": max_level,
        "tile": "data/aef_change/{z}/{x}/{y}.png",
        "tiles": listed,
        "classes": [
            {
                "index": c["index"],
                "label": c["label"],
                "min": c["min"],
                "rgb": c["rgb"],
                "km2": round(km2[c["index"]]),
            }
            for c in CLASSES
        ],
        "scoredKm2": round(km2.sum()),
        "score": {
            "target": TARGET,
            "history": [HISTORY[0], HISTORY[-1]],
            "lookback": LOOKBACK,
            "floor": FLOOR,
            "threshold": THRESHOLD,
            "cover": COVER,
        },
        "locations": len(locs) + skipped if locations is None else locations,
        "locationsScored": len(locs),
        "locationsSkipped": skipped,
        "tileBytes": tile_bytes,
        "source": SOURCE,
    }
    write_atomic(
        out_dir / "aef_change.json", manifest
    )  # last: the layer reads this one
    return manifest


def main(
    argv=None, *, fetch_to=_fetch_to, sha=INDEX_SHA256, opener=open_overview, now=None
) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "aef",
    )
    ap.add_argument("--max-level", type=int, default=MAX_LEVEL)
    ap.add_argument("--workers", type=int, default=WORKERS)
    ap.add_argument(
        "--bbox",
        help="west,south,east,north: only the locations inside, for a trial run",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    locs, skipped = read_locations(fetch_index(a.cache, sha, fetch_to=fetch_to))
    total = len(locs) + skipped
    if a.bbox:
        w, s, e, n = (float(v) for v in a.bbox.split(","))
        locs = [
            x
            for x in locs
            if x["wgs84"][0] < e
            and x["wgs84"][2] > w
            and x["wgs84"][1] < n
            and x["wgs84"][3] > s
        ]
    log.info(
        "%d locations with all %d years (%d of %d lack a year)",
        len(locs),
        len(YEARS),
        skipped,
        total,
    )
    tag = "all" if not a.bbox else hashlib.sha256(a.bbox.encode()).hexdigest()[:8]
    scores = score_all(
        locs, a.cache / f"scores_{sha[:12]}_v{SCORE_VERSION}_{tag}", a.workers, opener
    )
    m = build(
        locs,
        scores,
        a.out_dir,
        skipped=skipped,
        locations=total,
        max_level=a.max_level,
        now=now,
    )
    log.info(
        "%d tiles written, %.1f MB; scored %s km²; flagged km²: %s",
        sum(len(v) for v in m["tiles"].values()),
        m["tileBytes"] / 1e6,
        f"{m['scoredKm2']:,}",
        ", ".join(f"{c['label']} {c['km2']:,}" for c in m["classes"]),
    )
    return m


if __name__ == "__main__":
    main()
