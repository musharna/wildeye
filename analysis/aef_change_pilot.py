"""Pilot: does AlphaEarth (AEF) year-to-year embedding distance at the 1.28 km overview find known change?

Grill: grill_wildeye_aef_change_2026-10-26 (Q1–Q3). For a handful of AEF files (one 81.9 km UTM tile each)
it reads the 64×64 overview of every year 2017–2025 and scores each cell two ways:
  A  raw cosine distance 2024→2025;
  B  that distance as a robust z-score against the cell's own 2017→18 … 2023→24 distances.
Labels come from Hansen GFC v1.13 lossyear averaged onto the same cells, plus IFL 2025 for strict stable ground.
Gate (Q2): AUROC (change vs strict stable) ≥ 0.75, the 2023→2024 null arm near 0.5 on fresh-2025 cells,
GERD + Navi Mumbai flagged, and the top cells not piled on tile edges.

Run on msi:  python3 -B -m analysis.aef_change_pilot --index ~/.cache/wildeye/aef/aef_index.parquet \
               --ifl ~/.cache/wildeye/ifl/IFL_2025.gpkg --out ~/.cache/wildeye/aef/pilot
"""

import argparse
import json
import signal
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
import geopandas as gpd
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.merge import merge
from rasterio.warp import reproject, transform_bounds
from scipy.stats import rankdata

YEARS = list(range(2017, 2026))
CELL = 64  # 8192 px at 10 m → 64 px at 1280 m
HANSEN = "https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/Hansen_GFC-2025-v1.13_lossyear_{t}.tif"
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tiff,.tif",
    "GDAL_HTTP_MAX_RETRY": "4",
}

# (name, kind, lat, lon). kind: change = Hansen-loss region, stable = intact-forest interior, readout = named non-forest place
REGIONS = [
    ("para_xingu", "change", -6.6, -52.0),
    ("rondonia_labrea", "change", -8.0, -64.5),
    ("bolivia_santacruz", "change", -16.5, -62.0),
    ("canada_flinflon", "change", 54.8, -101.9),
    ("papua_merauke", "change", -7.9, 140.4),
    ("paraguay_chaco", "change", -21.5, -60.5),
    ("amazon_interior", "stable", -3.0, -67.0),
    ("congo_interior", "stable", 0.5, 21.5),
    ("gerd", "readout", 11.21, 35.09),
    ("navi_mumbai", "readout", 18.99, 73.07),
    ("iowa_crops", "readout", 42.0, -93.5),
    ("sahara_dunes", "readout", 24.0, 10.0),
]
# Held out: chosen after the score and threshold were frozen on REGIONS (grill ledger, "FROZEN before held-out run")
HOLDOUT = [
    ("matopiba_cerrado", "change", -8.5, -46.0),
    ("kalimantan_east", "change", -1.0, 116.7),
    ("ivory_coast", "change", 6.5, -6.0),
    ("la_palisades", "change", 34.07, -118.55),
    ("manitoba_fires", "change", 56.8, -101.0),
    ("gabon_interior", "stable", -0.5, 12.5),
    ("peru_interior", "stable", -4.5, -74.5),
    ("ukraine_farm", "farm", 49.0, 33.0),
    ("punjab_farm", "farm", 30.5, 75.5),
    ("matogrosso_soy", "farm", -13.0, -56.0),
    ("kansas_wheat", "farm", 38.5, -98.5),
    ("wheatbelt_au", "farm", -31.5, 117.5),
    ("greenland_margin", "snow", 67.0, -50.0),
    ("tibet_plateau", "snow", 33.0, 90.0),
]


def dequant(a):
    v = a.astype(np.float32)
    d = (v / 127.5) ** 2 * np.sign(v)
    d[:, (a == -128).all(0)] = np.nan
    return d


def cosdist(x, y):
    return 1.0 - (x * y).sum(0) / (
        np.linalg.norm(x, axis=0) * np.linalg.norm(y, axis=0)
    )


def read_overview(path):
    url = "/vsicurl/" + path.replace("gs://", "https://storage.googleapis.com/")
    with rasterio.Env(**GDAL_ENV):
        with rasterio.open(url) as ds:
            level = ds.overviews(1).index(8192 // CELL)
        with rasterio.open(url, overview_level=level) as ds:
            a = ds.read()
            tf = ds.transform
    if a.shape != (64, CELL, CELL):
        raise ValueError(f"{path}: overview shape {a.shape}")
    if tf.b != 0 or tf.d != 0:
        raise ValueError(f"{path}: rotated transform {tf}")
    if (
        tf.e > 0
    ):  # AEF COGs are stored south-up (origin at utm_south, +pixel height): flip to north-up
        a = a[:, ::-1, :]
        tf = rasterio.Affine(tf.a, 0, tf.c, 0, -tf.e, tf.f + tf.e * CELL)
    return a, tf


def hansen_tiles(w, s, e, n):
    names = []
    for top in range(int(np.ceil(n / 10) * 10), int(np.ceil(s / 10) * 10) - 1, -10):
        if top - 10 >= n or top <= s:
            continue
        for left in range(
            int(np.floor(w / 10) * 10), int(np.floor(e / 10) * 10) + 1, 10
        ):
            lat = f"{abs(top):02d}{'N' if top >= 0 else 'S'}"
            lon = f"{abs(left):03d}{'E' if left >= 0 else 'W'}"
            names.append(f"{lat}_{lon}")
    return names


def hansen_fractions(crs, transform, wgs):
    """Fraction of each 1.28 km cell with loss in 2025, 2024, 2023, any of 2017–24, any of 2001–25."""
    w, s, e, n = (wgs[0] - 0.02, wgs[1] - 0.02, wgs[2] + 0.02, wgs[3] + 0.02)
    srcs, absent = [], []
    with rasterio.Env(**GDAL_ENV):
        for t in hansen_tiles(w, s, e, n):
            url = HANSEN.format(t=t)
            try:
                srcs.append(rasterio.open("/vsicurl/" + url))
            except rasterio.errors.RasterioIOError as err:
                if "404" not in str(err):
                    raise RuntimeError(f"cannot open Hansen tile {url}") from err
                absent.append(
                    t
                )  # Hansen publishes no tile here (open ocean, ice sheet): those cells get no label
        if absent:
            print(
                f"  Hansen tiles not published: {absent}; their cells are unlabelled (NA)",
                flush=True,
            )
        if not srcs:
            return {
                k: np.full((CELL, CELL), np.nan, np.float32)
                for k in ("loss25", "loss24", "loss23", "loss1724", "lossany")
            }
        try:
            arr, src_tf = merge(srcs, bounds=(w, s, e, n), nodata=255)
        finally:
            for d in srcs:
                d.close()
    ly = arr[0]
    out = {}
    tests = {
        "loss25": ly == 25,
        "loss24": ly == 24,
        "loss23": ly == 23,
        "loss1724": (ly >= 17) & (ly <= 24),
        "lossany": (ly >= 1) & (ly <= 25),
    }
    valid = ly != 255
    for key, m in tests.items():
        src = np.where(valid, m.astype(np.float32), np.nan)
        dst = np.full((CELL, CELL), np.nan, np.float32)
        reproject(
            src,
            dst,
            src_transform=src_tf,
            src_crs="EPSG:4326",
            dst_transform=transform,
            dst_crs=crs,
            src_nodata=np.nan,
            dst_nodata=np.nan,
            resampling=Resampling.average,
        )
        out[key] = dst
    return out


def auroc(pos, neg):
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan"), len(pos), len(neg)
    r = rankdata(np.concatenate([pos, neg]))
    u = r[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2
    return float(u / (len(pos) * len(neg))), len(pos), len(neg)


def region_cells(con, ifl, name, kind, lat, lon):
    rows = con.execute(
        "select year, path, crs, utm_west, utm_north from idx where year between 2017 and 2025 "
        "and wgs84_west <= ? and wgs84_east >= ? and wgs84_south <= ? and wgs84_north >= ? order by year",
        [lon, lon, lat, lat],
    ).fetchall()
    by_year = {}
    for year, path, crs, west, north in rows:
        by_year.setdefault(
            year, (path, crs, west, north)
        )  # first file if a point sits on an overlap
    missing = [y for y in YEARS if y not in by_year]
    if missing:
        raise ValueError(f"{name}: no AEF file for years {missing}")
    grids = {(c, wst, nth) for _, c, wst, nth in by_year.values()}
    if len(grids) != 1:
        raise ValueError(f"{name}: the file grid differs between years {grids}")
    crs, west, north = grids.pop()
    with ThreadPoolExecutor(6) as ex:
        reads = dict(
            zip(
                YEARS,
                ex.map(lambda y: read_overview(by_year[y][0]), YEARS),
                strict=True,
            )
        )
    transforms = {tf for _, tf in reads.values()}
    if len(transforms) != 1:
        raise ValueError(
            f"{name}: overview transforms differ between years {transforms}"
        )
    transform = transforms.pop()
    if (round(transform.c), round(transform.f)) != (round(west), round(north)):
        raise ValueError(
            f"{name}: overview origin {transform} is not the index's west/north {west}, {north}"
        )
    emb = {y: dequant(a) for y, (a, _) in reads.items()}
    d = {y: cosdist(emb[y], emb[y + 1]) for y in YEARS[:-1]}
    # novelty: distance from a year to the CLOSEST earlier year, so a state seen before (crop rotation, regrowth) scores low
    nov25 = np.nanmin(
        np.stack([cosdist(emb[2025], emb[y]) for y in range(2017, 2025)]), 0
    )
    nov24 = np.nanmin(
        np.stack([cosdist(emb[2024], emb[y]) for y in range(2017, 2024)]), 0
    )  # null arm: one year earlier
    hist = np.stack([d[y] for y in range(2017, 2024)])  # 17→18 … 23→24
    med = np.nanmedian(hist, 0)
    mad = np.nanmedian(np.abs(hist - med), 0) * 1.4826
    z = (d[2024] - med) / np.maximum(mad, 1e-4)
    wgs = transform_bounds(crs, "EPSG:4326", west, north - 81920, west + 81920, north)
    hf = hansen_fractions(crs, transform, wgs)
    # reproject only polygons near the tile: the whole global layer in one UTM zone breaks far-away rings
    near = ifl.cx[wgs[0] - 0.5 : wgs[2] + 0.5, wgs[1] - 0.5 : wgs[3] + 0.5]
    inside = near.to_crs(crs).make_valid() if len(near) else near
    ifl_mask = (
        rasterize(
            ((g, 1) for g in inside.geometry),
            out_shape=(CELL, CELL),
            transform=transform,
            all_touched=False,
        )
        if len(inside)
        else np.zeros((CELL, CELL), np.uint8)
    )
    rr, cc = np.mgrid[0:CELL, 0:CELL]
    xs, ys = rasterio.transform.xy(transform, rr.ravel(), cc.ravel())
    from pyproj import Transformer

    lons, lats = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform(
        xs, ys
    )
    cells = {
        "region": np.full(CELL * CELL, name),
        "kind": np.full(CELL * CELL, kind),
        "row": rr.ravel(),
        "col": cc.ravel(),
        "lat": np.round(lats, 4),
        "lon": np.round(lons, 4),
        "edge": ((rr == 0) | (rr == CELL - 1) | (cc == 0) | (cc == CELL - 1)).ravel(),
        "ifl": ifl_mask.ravel().astype(bool),
        "d1725": cosdist(emb[2017], emb[2025]).ravel(),
        "z": z.ravel(),
        "med_hist": med.ravel(),
        "nov25": nov25.ravel(),
        "nov24": nov24.ravel(),
    }
    for y in YEARS[:-1]:
        cells[f"d{y % 100}{(y + 1) % 100}"] = d[y].ravel()
    for i, yi in enumerate(
        YEARS
    ):  # every year pair, so per-cell baselines can be tried offline (p{i}{j}, i<j)
        for yj in YEARS[i + 2 :]:
            cells[f"p{yi % 100}{yj % 100}"] = cosdist(emb[yi], emb[yj]).ravel()
    for k, v in hf.items():
        cells[k] = v.ravel()
    return cells, {
        "name": name,
        "kind": kind,
        "crs": crs,
        "west": west,
        "north": north,
        "files": {y: by_year[y][0] for y in YEARS},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True)
    ap.add_argument("--ifl", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--walltime", type=int, default=1500)
    ap.add_argument("--set", choices=("pilot", "holdout"), default="pilot")
    a = ap.parse_args()
    signal.signal(
        signal.SIGALRM,
        lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
    )
    signal.alarm(a.walltime)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(
        "create table idx as select year, path, crs, utm_west, utm_north, wgs84_west, wgs84_east, wgs84_south, "
        "wgs84_north from read_parquet(?)",
        [a.index],
    )
    ifl = gpd.read_file(a.ifl)
    parts, meta = [], []
    for name, kind, lat, lon in REGIONS if a.set == "pilot" else HOLDOUT:
        cells, m = region_cells(con, ifl, name, kind, lat, lon)
        parts.append(cells)
        meta.append(m)
        print(
            f"{name}: d2425 median {np.nanmedian(cells['d2425']):.4f}, loss25 cells≥10% {(cells['loss25'] >= 0.1).sum()}, ifl {cells['ifl'].sum()}",
            flush=True,
        )
    keys = list(parts[0])
    table = {k: np.concatenate([p[k] for p in parts]) for k in keys}
    with open(out / "cells.tsv", "w") as f:
        f.write("\t".join(keys) + "\n")
        for i in range(len(table["row"])):
            vals = []
            for k in keys:
                v = table[k][i]
                vals.append(
                    "NA"
                    if isinstance(v, float | np.floating) and not np.isfinite(v)
                    else f"{v:.5g}"
                    if isinstance(v, float | np.floating)
                    else str(v)
                )
            f.write("\t".join(vals) + "\n")
    (out / "regions.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(f"wrote {len(table['row'])} cells to {out / 'cells.tsv'}")


if __name__ == "__main__":
    main()
