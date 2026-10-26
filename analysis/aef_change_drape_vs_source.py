"""Does the drawn land-change drape show the band the source data gives? For seeded random level-6 pixels of the built
pyramid (a fixed number per band, plus clear pixels over land), the band decoded from the drawn tile through the colours
in aef_change.json, against the band recomputed by the pilot's route: the pilot's reader (analysis/aef_change_pilot.py
read_overview) for the nine years of the file whose footprint holds the pixel centre, the cell under the centre found
through the file's own transform, and the robust z of that one cell (floor from analysis/aef_change_stats.py). The pipeline
(pipeline/aef_change.py) has its own reader, score and painting, so the two routes share only the source files and the
frozen constants. The score is v2: each year's novelty less the file's median novelty that year; deserts
(RESOLVE biome 13, read here with geopandas) and land south of 60°S are not drawn. Named places are checked the same way. Writes docs/analysis/aef_change_drape_vs_source.md and
docs/analysis/aef_change_samples.tsv, which scripts/qa-aef-change.mjs reads.
Run on msi: python3 -B -m analysis.aef_change_drape_vs_source --data DIR --index ~/.cache/wildeye/aef/aef_index.parquet
    --ecoregions ~/.cache/wildeye/Ecoregions2017.zip
"""

import argparse
import json
import random
import signal
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
import numpy as np
import geopandas as gpd
from PIL import Image
from pyproj import Transformer
from scipy.ndimage import binary_dilation
from shapely.geometry import Point

from analysis.aef_change_pilot import YEARS, cosdist, dequant, read_overview
from analysis.aef_change_stats import FLOOR

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(3000)
ROOT = Path(__file__).resolve().parents[1]
SEED = 20261026
PER_BAND = 40
CLEAR = 60
TILES_SCANNED = 800
Z = 6
NAMED = [
    ("Palisades fire, Los Angeles", 34.07, -118.55),
    ("Eaton fire, Altadena", 34.19, -118.10),
    ("GERD reservoir (filled 2020-22)", 11.21, 35.09),
    ("Navi Mumbai airport (built 2018-23)", 18.99, 73.07),
]


def pixel_centre(tx, ty, px, py):
    d = 180 / 2**Z / 256
    return 90 - (ty * 256 + py + 0.5) * d, -180 + (tx * 256 + px + 0.5) * d


def source_band(con, lat, lon, edges, deserts):
    """(band, 'clear', 'no score', 'not drawn' or 'no file', score, footprint) by the pilot's route and the published
    rule, written apart from the pipeline: novelty per year from the pilot's reader and cosine distance, less the
    median over the file's cells that have data in every year and no neighbour without; then the pilot's robust z."""
    if lat < -60 or deserts.sindex.query(Point(lon, lat), predicate="within").size > 0:
        return "not drawn", None, "desert or south of 60°S"
    rows = con.execute(
        "select utm_zone, utm_west, utm_south, crs, year, path from idx where wgs84_west <= ? and wgs84_east >= ?"
        " and wgs84_south <= ? and wgs84_north >= ? order by utm_zone, utm_west, utm_south, year",
        [lon, lon, lat, lat],
    ).fetchall()
    feet = {}
    for zone, w, s, crs, year, path in rows:
        feet.setdefault((zone, w, s, crs), {})[year] = path
    for (zone, w, s, crs), paths in feet.items():
        x, y = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform(lon, lat)
        if not (w <= x < w + 81920 and s <= y < s + 81920):
            continue
        where = f"{zone} {w:.0f},{s:.0f}"
        if any(yr not in paths for yr in YEARS):
            return "no score", None, f"{where} (missing a year)"
        reads = {yr: read_overview(paths[yr]) for yr in YEARS}
        tf = reads[YEARS[-1]][1]
        col, row = (int(np.floor(v)) for v in ~tf * (x, y))
        emb = {yr: dequant(a) for yr, (a, _) in reads.items()}
        holes = np.zeros((64, 64), bool)
        for e in emb.values():
            holes |= np.isnan(e).any(0)
        unscored = binary_dilation(holes, structure=np.ones((3, 3), bool))
        where += f" r{row} c{col}"
        if unscored[row, col] or (~unscored).sum() < 64:
            return "no score", None, where
        nov = {}
        for k in range(2020, 2026):
            n = np.nanmin(np.stack([cosdist(emb[k], emb[j]) for j in range(k - 3, k)]), 0)
            nov[k] = n[row, col] - np.median(n[~unscored])
        hist = np.array([nov[k] for k in range(2020, 2025)])
        mad = 1.4826 * np.median(np.abs(hist - np.median(hist)))
        score = float((nov[2025] - np.median(hist)) / max(mad, FLOOR))
        band = int(np.searchsorted(edges, score, side="right"))
        return (band if band else "clear"), score, where
    return "no file", None, ""


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--data",
        type=Path,
        required=True,
        help="the build's out dir (aef_change.json, aef_change/)",
    )
    ap.add_argument("--index", type=Path, required=True)
    ap.add_argument("--ecoregions", type=Path, required=True, help="RESOLVE Ecoregions2017.zip")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "analysis")
    a = ap.parse_args(argv)
    m = json.loads((a.data / "aef_change.json").read_text())
    edges = [c["min"] for c in m["classes"]]
    colour = {tuple(c["rgb"]): c["index"] for c in m["classes"]}
    eco = gpd.read_file(f"zip://{a.ecoregions}")
    deserts = eco[eco.BIOME_NUM == 13].geometry
    deserts.sindex  # build the spatial index once, before the threads share it
    rng = random.Random(SEED)
    tiles = rng.sample(m["tiles"][str(Z)], min(TILES_SCANNED, len(m["tiles"][str(Z)])))
    by_band = {c["index"]: [] for c in m["classes"]}
    clear = []
    for tx, ty in tiles:
        im = np.asarray(
            Image.open(a.data / "aef_change" / str(Z) / str(tx) / f"{ty}.png").convert(
                "RGBA"
            )
        )
        for band in by_band:
            ys, xs = np.nonzero(
                (im[..., 3] == 255)
                & (im[..., :3] == m["classes"][band - 1]["rgb"]).all(-1)
            )
            if len(ys):
                k = rng.randrange(len(ys))
                by_band[band].append((tx, ty, int(xs[k]), int(ys[k])))
        ys, xs = np.nonzero(im[..., 3] == 0)
        if len(ys):
            k = rng.randrange(len(ys))
            clear.append((tx, ty, int(xs[k]), int(ys[k])))
    picks = [
        ("drawn", p)
        for b in by_band.values()
        for p in rng.sample(b, min(PER_BAND, len(b)))
    ]
    picks += [("clear", p) for p in rng.sample(clear, min(3 * CLEAR, len(clear)))]
    con = duckdb.connect()
    con.execute(
        "create table idx as select * from read_parquet(?) where year between 2017 and 2025",
        [str(a.index)],
    )

    def one(pick):
        kind, (tx, ty, px, py) = pick
        lat, lon = pixel_centre(tx, ty, px, py)
        im = Image.open(a.data / "aef_change" / str(Z) / str(tx) / f"{ty}.png").convert(
            "RGBA"
        )
        rgba = im.getpixel((px, py))
        drawn = (
            "clear" if rgba[3] == 0 else colour.get(tuple(rgba[:3]), f"unknown {rgba}")
        )
        src, score, where = source_band(con.cursor(), lat, lon, edges, deserts)
        return {
            "kind": kind,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "drawn": drawn,
            "source": src,
            "score": score,
            "where": where,
        }

    with ThreadPoolExecutor(16) as ex:
        rows = list(ex.map(one, picks))
    # clear samples over land only, up to CLEAR of them: a clear pixel over the sea checks nothing
    land = [r for r in rows if r["kind"] == "clear" and r["source"] != "no file"][
        :CLEAR
    ]
    rows = [r for r in rows if r["kind"] == "drawn"] + land
    named = []
    for name, lat, lon in NAMED:
        d = 180 / 2**Z / 256
        gx, gy = int((lon + 180) / d), int((90 - lat) / d)
        path = a.data / "aef_change" / str(Z) / str(gx // 256) / f"{gy // 256}.png"
        rgba = (
            Image.open(path).convert("RGBA").getpixel((gx % 256, gy % 256))
            if path.exists()
            else (0, 0, 0, 0)
        )
        drawn = (
            "clear" if rgba[3] == 0 else colour.get(tuple(rgba[:3]), f"unknown {rgba}")
        )
        src, score, where = source_band(
            con.cursor(), *pixel_centre(gx // 256, gy // 256, gx % 256, gy % 256), edges, deserts
        )
        named.append(
            {
                "kind": "named",
                "name": name,
                "lat": lat,
                "lon": lon,
                "drawn": drawn,
                "source": src,
                "score": score,
                "where": where,
            }
        )
    a.out.mkdir(parents=True, exist_ok=True)
    fmt = lambda v: "" if v is None else f"{v:.1f}"  # noqa: E731
    cols = ["kind", "lat", "lon", "drawn", "source", "score", "where"]
    with open(a.out / "aef_change_samples.tsv", "w") as fh:
        fh.write("\t".join(cols) + "\n")
        for r in rows + named:
            fh.write(
                "\t".join(
                    "NA"
                    if r[c] is None or r[c] == ""
                    else (f"{r[c]:.3f}" if c == "score" else str(r[c]))
                    for c in cols
                )
                + "\n"
            )
    norm = lambda v: "clear" if v in ("clear", "no score", "no file", "not drawn") else v  # noqa: E731 (clear on the map either way)
    agree = Counter((r["kind"], norm(r["drawn"]) == norm(r["source"])) for r in rows)
    confusion = Counter((str(r["drawn"]), str(r["source"])) for r in rows)
    lines = [
        "# Land change drape against the source, by the pilot's route",
        "",
        f"Build {m['generated_at']}: {m['locationsScored']:,} of {m['locations']:,} footprints scored, "
        f"{sum(len(v) for v in m['tiles'].values()):,} tiles, {m['tileBytes'] / 1e6:.1f} MB; scored {m['scoredKm2']:,} km².",
        "",
        "| band | drawn km² |",
        "|---|---|",
        *[
            f"| {c['label']} (score ≥ {c['min']}) | {c['km2']:,} |"
            for c in m["classes"]
        ],
        "",
        f"Seeded level-6 pixels (seed {SEED}): {sum(v for (k, _), v in agree.items() if k == 'drawn')} drawn, "
        f"{sum(v for (k, _), v in agree.items() if k == 'clear')} clear over land. "
        f"Drawn pixels whose band the source gives: {agree[('drawn', True)]} of {agree[('drawn', True)] + agree[('drawn', False)]}; "
        f"clear pixels the source leaves clear or unscored: {agree[('clear', True)]} of {agree[('clear', True)] + agree[('clear', False)]}.",
        "",
        "| drawn | source | pixels |",
        "|---|---|---|",
        *[f"| {d} | {s} | {n} |" for (d, s), n in sorted(confusion.items())],
        "",
        "Named places:",
        "",
        "| place | drawn | source band | score |",
        "|---|---|---|---|",
        *[
            f"| {r['name']} | {r['drawn']} | {r['source']} | {fmt(r['score'])} |"
            for r in named
        ],
        "",
    ]
    (a.out / "aef_change_drape_vs_source.md").write_text("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
