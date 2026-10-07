"""Which SBTN Natural Lands classes each colour of GFW's tile cache stands for, read from the raw data.

The legend of the Natural Lands drape (src/data/naturalLands.js) rests on this table, not on colour names. For a
spread of 10-degree raw classification tiles on every continent, it picks points of every class present (candidates
from the file's 1/32 overview, where a 3x3 overview block is one class when possible), moves each to the centre of the
GFW level-12 tile pixel under it, and reads at full resolution:

- every raw 0.00025-degree pixel that overlaps that tile pixel's footprint (majority class and its share), and
  a window two raw pixels wider on each side (homogeneous = one class over the whole window, so the 38 m tile pixel
  and the 28 m raw grid cannot disagree by resampling); pure = every raw pixel overlapping the footprint is one class;
- the RGBA of that tile pixel, decoded from the PNG bytes.

Classes that are rare at 30 m (non-natural water, wetland/peat non-natural classes, non-natural bare) get extra points
from a second random stream, so the base draw is the same with or without them.

Outputs (committed): docs/analysis/natlands_legend_samples.tsv (one row a point) and
docs/analysis/natlands_legend_crosstab.md (class x colour counts over pure points with the homogeneous subset, the
colour each class is drawn in, and per-colour agreement). GFW's declared colormap (data-api creation_options) is
compared with the observed mapping as a second, independent route; the run exits 1 if they disagree for any class
seen. A class the colormap has no stop for is listed, not counted as a disagreement.

Tiles are cached in analysis/.cache/natlands/ and fetched politely (3 at a time, 0.3 s apart).
Run: python3 -m analysis.natlands_legend --per-class 5 --rare-per-class 10 [--seed 20261006]
"""

from __future__ import annotations

import argparse
import collections
import csv
import io
import json
import math
import random
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window

from pipeline.net import urlopen

TILE_URL = "https://tiles.globalforestwatch.org/sbtn_natural_lands_classification/v1.1/default_pro/{z}/{x}/{y}.png"
RAW_URL = "https://storage.googleapis.com/lcl_public/SBTN_NaturalLands/v1_1/classification/natLands_v1_1_{tile}.tif"
SHEET_CSV = "https://docs.google.com/spreadsheets/d/13w0Ezo5OMTInsBOn6OrBN-G580YqVvIWhsxgyeK3GuY/export?format=csv"
ASSET_OPTIONS = "https://data-api.globalforestwatch.org/asset/fc4e9c41-06fe-4f95-86a3-718caae4e8fa/creation_options"
UA = "wildeye-natural-lands-legend (github.com/musharna/wildeye)"
Z = 12  # the cache's finest level (creation_options max_zoom; z13+ are exact upsamples of z12, probed 2026-10-06)
TILE = 256
RAW_RES = 0.00025
RARE = (16, 17, 18, 19, 20, 21)
MARGIN = 2  # raw pixels added on each side of the footprint for the homogeneity window
# 10-degree tiles named by their top-left corner (00N_060W spans 0..10 S, 60..50 W), chosen to cover every continent
# and the rare classes: peat (Hudson Bay, Cuvette Centrale, Sumatra, West Siberia), mangroves (Sundarbans, Sumatra),
# snow (Alps, Himalaya, Greenland), bare (Sahara, Tibet), wetlands (Sudd), and crop/built regions.
RAW_TILES = [
    "00N_060W",
    "20S_050W",
    "50N_100W",
    "60N_090W",
    "50N_010E",
    "30N_000E",
    "10N_030E",
    "00N_010E",
    "10N_100E",
    "30N_080E",
    "40N_080E",
    "30S_140E",
    "70N_060E",
    "40N_110E",
    "70N_050W",
]
OVERVIEW = 1250  # 40000 / 32: the file's coarsest overview
UA_HEADERS = {"User-Agent": UA}
OUT_DIR = Path("docs/analysis")
CACHE = Path("analysis/.cache/natlands")


def get(url: str, tries: int = 4) -> bytes:
    req = urllib.request.Request(url, headers=UA_HEADERS)
    for k in range(tries):
        try:
            with urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — retried, then re-raised with the URL
            if k == tries - 1:
                raise RuntimeError(f"GET {url} failed after {tries} tries: {e}") from e
            time.sleep(2 ** (k + 1))
    raise AssertionError("unreachable")


def read_classes() -> dict[int, tuple[str, str]]:
    """Classification value -> (name, category) from the README's class sheet, read live."""
    rows = list(csv.reader(io.StringIO(get(SHEET_CSV).decode("utf-8"))))
    out, inside = {}, False
    for r in rows:
        if r and r[0].strip():
            inside = r[0].strip() == "Natural Lands: classification"
        if inside and len(r) >= 6 and r[1].strip().isdigit():
            out[int(r[1])] = (r[3].strip(), r[5].strip())
    if not out or min(out) != 2:
        raise RuntimeError(f"class sheet changed shape: parsed {out}")
    return out


def declared_colormap() -> dict[int, tuple[int, int, int, int]]:
    d = json.loads(get(ASSET_OPTIONS))["data"]
    if d.get("max_zoom") != Z:
        raise RuntimeError(
            f"tile cache max_zoom is {d.get('max_zoom')}, not {Z}: re-probe before trusting this table"
        )
    cm = d["symbology"]["colormap"]
    return {
        int(float(k)): (v["red"], v["green"], v["blue"], v["alpha"])
        for k, v in cm.items()
    }


def mercator_y(lat: float) -> float:
    return (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2


def lat_of(fy: float) -> float:
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy))))


def tile_pixel(lat: float, lon: float):
    """Global level-12 pixel under a point, its centre, and its footprint (west, south, east, north) in degrees."""
    n = 2**Z * TILE
    gx, gy = int((lon + 180) / 360 * n), int(mercator_y(lat) * n)
    west, east = gx / n * 360 - 180, (gx + 1) / n * 360 - 180
    north, south = lat_of(gy / n), lat_of((gy + 1) / n)
    centre = (lat_of((gy + 0.5) / n), (gx + 0.5) / n * 360 - 180)
    return gx, gy, centre, (west, south, east, north)


_tile_lock = threading.Lock()
_tile_cache: dict[tuple[int, int], np.ndarray] = {}


def tile_rgba(x: int, y: int) -> np.ndarray:
    with _tile_lock:
        if (x, y) in _tile_cache:
            return _tile_cache[(x, y)]
    path = CACHE / f"{Z}_{x}_{y}.png"
    if path.exists():
        data = path.read_bytes()
    else:
        time.sleep(0.3)
        data = get(TILE_URL.format(z=Z, x=x, y=y))
        path.write_bytes(data)
    arr = np.array(Image.open(io.BytesIO(data)).convert("RGBA"))
    if arr.shape != (TILE, TILE, 4):
        raise RuntimeError(f"tile {Z}/{x}/{y} is {arr.shape}, not {TILE}x{TILE} RGBA")
    with _tile_lock:
        _tile_cache[(x, y)] = arr
    return arr


def candidates(ds, classes: set[int], per_class: int, rng: random.Random, rare_per_class: int = 0, rare_rng=None):
    """(class, lat, lon) points from the overview: a uniform 3x3 block when the class has one, else any cell. Rare
    classes then get up to `rare_per_class` more from `rare_rng`, never repeating a cell."""
    ov = ds.read(1, out_shape=(OVERVIEW, OVERVIEW))
    step = (ds.bounds.right - ds.bounds.left) / OVERVIEW
    uniform = np.zeros_like(ov, dtype=bool)
    c = ov[1:-1, 1:-1]
    same = np.ones_like(c, dtype=bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            same &= ov[1 + dy : OVERVIEW - 1 + dy, 1 + dx : OVERVIEW - 1 + dx] == c
    uniform[1:-1, 1:-1] = same
    out = []
    for v in sorted(int(u) for u in np.unique(ov)):
        if v not in classes and v not in (0, 1):
            print(f"  value {v} in overview is not in the class sheet", file=sys.stderr)
        pool = np.argwhere((ov == v) & uniform)
        kind = "uniform"
        if len(pool) == 0:
            pool, kind = np.argwhere(ov == v), "any"
        pool = list(map(tuple, pool))
        picked = rng.sample(pool, min(per_class, len(pool)))
        if v in RARE and rare_rng is not None:
            rest = sorted(set(pool) - set(picked))
            picked += rare_rng.sample(rest, min(rare_per_class, len(rest)))
        for r, col in picked:
            out.append(
                (
                    v,
                    ds.bounds.top - (r + 0.5) * step,
                    ds.bounds.left + (col + 0.5) * step,
                    kind,
                )
            )
    return out


def sample(ds, raw_tile: str, v_ov: int, lat: float, lon: float, kind: str) -> dict:
    gx, gy, (clat, clon), (w, s, e, n) = tile_pixel(lat, lon)
    inv = ~ds.transform
    c0, r0 = inv * (w, n)
    c1, r1 = inv * (e, s)
    # raw pixels that overlap the footprint (above ~45 degrees a tile pixel can be shorter than a raw pixel, so it may
    # hold no raw pixel centre at all)
    cols = range(math.floor(c0), math.ceil(c1))
    rows = range(math.floor(r0), math.ceil(r1))
    if not cols or not rows:
        raise RuntimeError(f"empty footprint at {lat},{lon}")
    wc0, wr0 = cols.start - MARGIN, rows.start - MARGIN
    win = Window(wc0, wr0, len(cols) + 2 * MARGIN, len(rows) + 2 * MARGIN)
    block = ds.read(1, window=win, boundless=True, fill_value=255)
    foot = block[MARGIN:-MARGIN, MARGIN:-MARGIN]
    counts = collections.Counter(int(v) for v in foot.ravel())
    major, k = counts.most_common(1)[0]
    rgba = tile_rgba(gx // TILE, gy // TILE)[gy % TILE, gx % TILE]
    return {
        "raw_tile": raw_tile,
        "pick": f"{v_ov}:{kind}",
        "lat": repr(clat),
        "lon": repr(clon),
        "z": Z,
        "x": gx // TILE,
        "y": gy // TILE,
        "px": gx % TILE,
        "py": gy % TILE,
        "rgba": ",".join(str(int(t)) for t in rgba),
        "raw_class": major,
        "share": round(k / foot.size, 3),
        "homogeneous": int(len(np.unique(block)) == 1 and 255 not in counts),
        "pure": int(len(counts) == 1 and 255 not in counts),
        "footprint": " ".join(f"{a}:{b}" for a, b in sorted(counts.items())),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-class", type=int, default=4)
    ap.add_argument("--rare-per-class", type=int, default=10)
    ap.add_argument("--seed", type=int, default=20261006)
    ap.add_argument("--tiles", nargs="*", default=RAW_TILES)
    a = ap.parse_args(argv)
    CACHE.mkdir(parents=True, exist_ok=True)
    classes = read_classes()
    declared = declared_colormap()
    rng = random.Random(a.seed)
    rare_rng = random.Random(a.seed + 1)
    rows = []
    env = rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
        GDAL_HTTP_MAX_RETRY="4",
    )
    with env:
        for t in a.tiles:
            url = "/vsicurl/" + RAW_URL.format(tile=t)
            try:
                ds = rasterio.open(url)
            except rasterio.errors.RasterioIOError as e:
                print(f"{t}: no raw tile ({e})", file=sys.stderr)
                rows.append({"raw_tile": t, "pick": "missing"})
                continue
            with ds:
                if ds.res != (RAW_RES, RAW_RES):
                    raise RuntimeError(f"{t}: resolution {ds.res}, expected {RAW_RES}")
                picks = candidates(ds, set(classes), a.per_class, rng, a.rare_per_class, rare_rng)
                print(
                    f"{t}: {len(picks)} points over classes {sorted({p[0] for p in picks})}",
                    file=sys.stderr,
                )
                # tiles are fetched in parallel; rasterio reads stay on this thread (a dataset is not thread-safe)
                with ThreadPoolExecutor(3) as pool:
                    list(
                        pool.map(
                            lambda p: tile_rgba(
                                *(c // TILE for c in tile_pixel(p[1], p[2])[:2])
                            ),
                            picks,
                        )
                    )
                rows.extend(sample(ds, t, *p) for p in picks)
    pts = [r for r in rows if r.get("pick") != "missing"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fields = [
        "raw_tile",
        "pick",
        "lat",
        "lon",
        "z",
        "x",
        "y",
        "px",
        "py",
        "rgba",
        "raw_class",
        "share",
        "homogeneous",
        "pure",
        "footprint",
    ]
    with open(OUT_DIR / "natlands_legend_samples.tsv", "w", newline="") as f:
        w = csv.DictWriter(f, fields, delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(pts)
    return report(
        pts,
        classes,
        declared,
        [r["raw_tile"] for r in rows if r.get("pick") == "missing"],
        a,
    )


def name(v: int, classes) -> str:
    return (
        classes[v][0]
        if v in classes
        else {
            0: "no data (0)",
            1: "value 1 (not in the sheet)",
            255: "outside the file",
        }.get(v, f"value {v}")
    )


def report(pts, classes, declared, missing, a) -> int:
    pure = [r for r in pts if r["pure"]]
    homo = [r for r in pts if r["homogeneous"]]
    tab = collections.defaultdict(collections.Counter)  # class -> colour -> n, pure points
    htab = collections.defaultdict(collections.Counter)  # the homogeneous subset
    for r in pure:
        tab[r["raw_class"]][r["rgba"]] += 1
    for r in homo:
        htab[r["raw_class"]][r["rgba"]] += 1
    colours = sorted({r["rgba"] for r in pure}, key=lambda c: (c.endswith(",0"), c))
    drawn = {v: cnt.most_common(1)[0][0] for v, cnt in tab.items()}  # the colour each class is drawn in
    groups = collections.defaultdict(list)
    for v, c in drawn.items():
        groups[c].append(v)
    lines = [
        "# SBTN Natural Lands v1.1: GFW tile colour vs raw class",
        "",
        f"Produced by `python3 -m analysis.natlands_legend --per-class {a.per_class} --rare-per-class {a.rare_per_class} "
        f"--seed {a.seed}`; one row a point in `natlands_legend_samples.tsv`. Colour = RGBA of the level-12 tile pixel "
        f"(`{TILE_URL}`); class = the raw classification GeoTIFF (`{RAW_URL}`) over that pixel's footprint. "
        "Pure = every raw pixel overlapping the tile pixel is one class; homogeneous (a subset) = one class over the "
        f"footprint plus {MARGIN} raw pixels on every side. Classes {', '.join(map(str, RARE))} got up to "
        f"{a.rare_per_class} extra points per raw tile.",
        "",
        f"Points: {len(pts)} from {len({r['raw_tile'] for r in pts})} raw tiles"
        + (f" (no raw file for {', '.join(missing)})" if missing else "")
        + f"; pure: {len(pure)}; homogeneous: {len(homo)}.",
        "",
        "## Class x colour (pure points; homogeneous in brackets)",
        "",
        "| value | class | category | " + " | ".join(f"`{c}`" for c in colours) + " | drawn as | GFW declared |",
        "|---" * (len(colours) + 5) + "|",
    ]
    disagree, no_stop = [], []
    for v in sorted(tab):
        cat = classes[v][1] if v in classes else ""
        if v in declared:
            dec = ",".join(map(str, declared[v]))
            if dec != drawn[v]:
                disagree.append((v, drawn[v], dec))
        else:
            dec = "no stop"
            no_stop.append(v)
        cells = [f"{tab[v][c]} ({htab[v][c]})" if tab[v][c] else "" for c in colours]
        lines.append(f"| {v} | {name(v, classes)} | {cat} | " + " | ".join(cells) + f" | `{drawn[v]}` | `{dec}` |")
    unseen = [v for v in classes if v not in tab]
    lines += ["", f"Classes in the sheet with no pure point: {', '.join(f'{v} {name(v, classes)}' for v in unseen) or 'none'}.", ""]
    lines += [
        "## Per colour",
        "",
        "Agreement = share of the points drawn in the colour whose raw class is one of the classes it stands for.",
        "",
        "| colour | classes it stands for | homogeneous | pure | all points (majority class) |",
        "|---|---|---|---|---|",
    ]
    def agree(rows, c, g):
        n = [r for r in rows if r["rgba"] == c]
        ok = sum(r["raw_class"] in g for r in n)
        return f"{ok}/{len(n)} = {ok / len(n):.1%}" if n else "0/0"
    for c in colours:
        g = set(groups.get(c, []))
        lines.append(
            f"| `{c}` | {', '.join(f'{v} {name(v, classes)}' for v in sorted(g)) or '(no class is drawn in it)'} | "
            f"{agree(homo, c, g)} | {agree(pure, c, g)} | {agree(pts, c, g)} |"
        )
    lines += ["", "## Per class", "", "| value | class | pure points in its colour | homogeneous points in its colour |", "|---|---|---|---|"]
    for v in sorted(tab):
        tot, htot = sum(tab[v].values()), sum(htab[v].values())
        h = f"{htab[v][drawn[v]]}/{htot} = {htab[v][drawn[v]] / htot:.1%}" if htot else "0/0"
        lines.append(f"| {v} | {name(v, classes)} | {tab[v][drawn[v]]}/{tot} = {tab[v][drawn[v]] / tot:.1%} | {h} |")
    lines += [
        "",
        "## Second route: GFW's declared colormap",
        "",
        f"`{ASSET_OPTIONS}`: "
        + ("every sampled class with a stop is drawn in the colour the colormap declares" if not disagree else f"DISAGREES for {disagree}")
        + (f"; no stop for {', '.join(f'{v} {name(v, classes)}' for v in no_stop)} (drawn as observed above)." if no_stop else "."),
        "",
    ]
    (OUT_DIR / "natlands_legend_crosstab.md").write_text("\n".join(lines))
    print("\n".join(lines))
    return 1 if disagree else 0


if __name__ == "__main__":
    sys.exit(main())
