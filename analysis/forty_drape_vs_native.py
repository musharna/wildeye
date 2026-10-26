"""Does the drawn ForTy drape name the type the native 10 m probabilities make most likely? For seeded random level-7
pixels of the built pyramid (a fixed number per drawn type, plus clear pixels), the type decoded from the drawn tile
through the colours in forty.json, against the type recomputed from the full-resolution COGs: every native 10 m pixel
whose centre falls inside the level-7 pixel's footprint, its six probabilities (other = 250 minus the five bands) summed
over the pixels with data, then the largest. The pipeline instead reads each COG's 16x cubic overview and
average-reprojects it, so the two routes share only the source files. Writes docs/analysis/forty_drape_vs_native.md and
docs/analysis/forty_samples.tsv.
Run: python3 -m analysis.forty_drape_vs_native [--data public/data] [--cache DIR]
"""

import argparse
import json
import os
import random
import signal
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from pipeline.forty import NODATA, STAC_CLASSES, fetch_stac, read_items

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(3000)
ROOT = Path(__file__).resolve().parents[1]
SEED = 20261026
PER_TYPE = 40  # drawn pixels sampled per type (fewer if the map has fewer)
CLEAR = 60  # clear pixels in drawn tiles
TILES_SCANNED = 600  # random listed level-7 tiles the samples are drawn from
ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MULTIPLEX": "YES",
}


def drawn_types(path, colours):
    """Per-pixel type index (0 clear) of one drawn tile, through the manifest colours; an unknown colour is fatal."""
    rgba = np.asarray(Image.open(path).convert("RGBA"))
    out = np.zeros(rgba.shape[:2], np.uint8)
    seen = np.zeros(rgba.shape[:2], bool)
    for rgb, idx in colours.items():
        m = (rgba[..., 3] == 255) & np.all(rgba[..., :3] == rgb, axis=-1)
        out[m] = idx
        seen |= m
    odd = ~seen & (rgba[..., 3] != 0)
    if odd.any():
        y, x = np.argwhere(odd)[0]
        raise ValueError(f"{path}: unrecognised pixel {rgba[y, x].tolist()}")
    return out


def native_type(footprint, items):
    """(type 0-5 as the pipeline numbers them + 1, 0 for other or no data; native pixels used; top-two margin)."""
    import rasterio
    from rasterio.warp import transform, transform_bounds
    from rasterio.windows import Window

    west, south, east, north = footprint
    sums = np.zeros(6)
    used = 0
    for it in items:
        with rasterio.Env(**ENV), rasterio.open(f"/vsicurl/{it['href']}") as src:
            l, b, r, t = transform_bounds(
                "EPSG:4326", src.crs, west, south, east, north, densify_pts=21
            )
            # through the inverse transform: these COGs run bottom-up (e > 0), which from_bounds refuses
            inv = ~src.transform
            cs, rs = zip(*(inv * (x, y) for x in (l, r) for y in (b, t)))
            c0, c1 = (
                max(0, int(np.floor(min(cs))) - 1),
                min(src.width, int(np.ceil(max(cs))) + 1),
            )
            r0, r1 = (
                max(0, int(np.floor(min(rs))) - 1),
                min(src.height, int(np.ceil(max(rs))) + 1),
            )
            if c0 >= c1 or r0 >= r1:
                continue
            win = Window(c0, r0, c1 - c0, r1 - r0)
            a = src.read(window=win)
            tf = src.window_transform(win)
            rows, cols = np.mgrid[0 : a.shape[1], 0 : a.shape[2]]
            xs, ys = tf * (cols.ravel() + 0.5, rows.ravel() + 0.5)
            lon, lat = transform(src.crs, "EPSG:4326", xs, ys)
        lon, lat = (
            np.asarray(lon).reshape(rows.shape),
            np.asarray(lat).reshape(rows.shape),
        )
        inside = (
            (lon >= west)
            & (lon < east)
            & (lat >= south)
            & (lat < north)
            & (a[0] != NODATA)
        )
        if not inside.any():
            continue
        p = np.minimum(a[:, inside].astype(float), 250)
        other = np.clip(250 - p.sum(0), 0, None)
        sums += np.concatenate([p, other[None]]).sum(1)
        used += int(inside.sum())
    if not used:
        return 0, 0, None
    share = sums / sums.sum()
    order = np.argsort(share)[::-1]
    best = int(order[0])
    return (best + 1 if best < 5 else 0), used, float(share[order[0]] - share[order[1]])


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=ROOT / "public/data")
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "forty",
    )
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args(argv)
    m = json.loads((a.data / "forty.json").read_text())
    z = m["maxLevel"]
    colours = {tuple(c["rgb"]): c["index"] for c in m["classes"]}
    labels = {0: "clear"} | {c["index"]: c["label"] for c in m["classes"]}
    rng = random.Random(SEED)
    tiles = rng.sample(m["tiles"][str(z)], min(TILES_SCANNED, len(m["tiles"][str(z)])))
    by_type = {k: [] for k in labels}
    for x, y in tiles:
        t = drawn_types(a.data / "forty" / str(z) / str(x) / f"{y}.png", colours)
        for k in labels:
            ys, xs = np.nonzero(t == k)
            if len(ys):
                j = rng.randrange(len(ys))
                by_type[k].append((x, y, int(xs[j]), int(ys[j])))
    picks = []
    for k, cands in by_type.items():
        picks += [
            (k, c)
            for c in rng.sample(cands, min(CLEAR if k == 0 else PER_TYPE, len(cands)))
        ]
    print(
        f"{len(picks)} pixels from {len(tiles)} tiles: "
        + ", ".join(
            f"{labels[k]} {sum(1 for kk, _ in picks if kk == k)}" for k in labels
        ),
        flush=True,
    )

    items = read_items(fetch_stac(a.cache))
    box = np.array([[i["west"], i["south"], i["east"], i["north"]] for i in items])
    d = 180 / 2**z / 256

    def one(pick):
        k, (x, y, px, py) = pick
        west, north = -180 + (x * 256 + px) * d, 90 - (y * 256 + py) * d
        fp = (west, north - d, west + d, north)
        hit = np.nonzero(
            (box[:, 0] < fp[2])
            & (box[:, 2] > fp[0])
            & (box[:, 1] < fp[3])
            & (box[:, 3] > fp[1])
        )[0]
        nat, used, margin = native_type(fp, [items[i] for i in hit])
        return {
            "lat": north - d / 2,
            "lon": west + d / 2,
            "drawn": k,
            "native": nat,
            "native_px": used,
            "items": len(hit),
            "margin": margin,
        }

    with ThreadPoolExecutor(a.workers) as ex:
        rows = list(ex.map(one, picks))

    out = ROOT / "docs/analysis"
    with open(out / "forty_samples.tsv", "w") as fh:
        fh.write("lat\tlon\tdrawn\tnative\tnative_px\titems\tmargin\n")
        for r in rows:
            mg = "" if r["margin"] is None else f"{r['margin']:.3f}"
            fh.write(
                f"{r['lat']:.5f}\t{r['lon']:.5f}\t{labels[r['drawn']]}\t{labels[r['native']]}\t{r['native_px']}\t{r['items']}\t{mg}\n"
            )

    agree = sum(r["drawn"] == r["native"] for r in rows)
    lines = [
        "# ForTy drape against the native 10 m probabilities",
        "",
        (
            f"`python3 -m analysis.forty_drape_vs_native` on the build of {m['generated_at']} (seed {SEED}). "
            f"{len(rows)} level-7 pixels (~610 m) drawn from {len(tiles)} random painted tiles: up to {PER_TYPE} per drawn type and {CLEAR} clear. "
            "For each, the type the drape draws is compared with the type recomputed from every native 10 m pixel whose centre "
            "lies in the pixel's footprint (probabilities summed over pixels with data; other land = 250 minus the five bands). "
            "The pipeline reads the 16x cubic overview and average-reprojects it; the two routes share only the source files."
        ),
        "",
        f"**Agreement: {agree} of {len(rows)} ({100 * agree / len(rows):.1f}%).**",
        "",
        "| drawn type | n | native agrees | native says instead |",
        "|---|---|---|---|",
    ]
    for k in labels:
        rs = [r for r in rows if r["drawn"] == k]
        if not rs:
            lines.append(f"| {labels[k]} | 0 | | |")
            continue
        ok = sum(r["native"] == k for r in rs)
        other = Counter(labels[r["native"]] for r in rs if r["native"] != k)
        lines.append(
            f"| {labels[k]} | {len(rs)} | {ok} ({100 * ok / len(rs):.0f}%) | {', '.join(f'{v} {n}' for v, n in other.most_common()) or '—'} |"
        )
    dis = [r for r in rows if r["drawn"] != r["native"] and r["margin"] is not None]
    agr = [r for r in rows if r["drawn"] == r["native"] and r["margin"] is not None]
    if dis:
        lines += [
            "",
            (
                f"Native top-two margin (share of summed probability between the most and second most likely type): median "
                f"{np.median([r['margin'] for r in dis]):.3f} where the two disagree ({len(dis)}), "
                f"{np.median([r['margin'] for r in agr]):.3f} where they agree ({len(agr)}). "
                f"Disagreements with a margin above 0.10: {sum(r['margin'] > 0.10 for r in dis)}."
            ),
        ]
    nodata = sum(r["native_px"] == 0 for r in rows)
    lines += [
        "",
        f"Pixels with no native data inside the footprint: {nodata} (drawn: "
        + ", ".join(
            f"{labels[k]} {n}"
            for k, n in Counter(
                r["drawn"] for r in rows if r["native_px"] == 0
            ).most_common()
        )
        + "). Median native pixels per footprint: "
        + f"{int(np.median([r['native_px'] for r in rows if r['native_px']]))}.",
        "",
        "Samples: `docs/analysis/forty_samples.tsv`.",
        "",
    ]
    (out / "forty_drape_vs_native.md").write_text("\n".join(lines))
    print("\n".join(lines))
    return rows


if __name__ == "__main__":
    assert len(STAC_CLASSES) == 6
    main()
