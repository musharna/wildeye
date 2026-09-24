"""Sample the S3 season rerun's pure LST pixels (docs/analysis/s3_season_prereg.md).

For each region: every level-7 LST pixel whose centre is in the box, classed by its 4 level-8 land-cover
children (2024); for each pure city/cropland pixel and each of the 23 EVI composites of 2024, the mean of its
16 level-9 EVI children and the mean of its two cloud-free 8-day LST composites. Children are addressed by
exact global pixel index, never by coordinate. Tiles as in the pilot: the live site's decode tables, a disk
cache, 1 s between network fetches, header date enforced on every tile.

Writes analysis/out_season/pixels.csv (region, gx, gy, cls, date, evi, lst) and meta.json.
Run: python3 -m analysis.s3_season_sample
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

from analysis import s3_lib as s
from analysis import s3_season_lib as ss
from analysis.s3_sample import REGIONS, Tiles, get

LEVELS = {"gibs-landcover": 8, "gibs-evi": 9, "gibs-lst": 7}
LC_DATE = "2024-01-01"


def read(tiles: Tiles, gx: int, gy: int):
    """RGBA of global pixel (gx, gy) at the layer's maximum level."""
    z = tiles.entry["maximumLevel"]
    x, y = gx // s.TILE, gy // s.TILE
    img = tiles.mem.get((x, y)) or tiles._load(z, x, y)
    tiles.mem[(x, y)] = img
    return img.getpixel((gx % s.TILE, gy % s.TILE))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://musharna.github.io/wildeye/")
    ap.add_argument("--out", type=Path, default=Path("analysis/out_season"))
    ap.add_argument("--cache", type=Path, default=Path("analysis/.cache"))
    a = ap.parse_args(argv)
    manifest = json.loads(
        get(f"{a.site.rstrip('/')}/data/gibs.json?t={int(time.time())}")[0]
    )["layers"]
    for k, z in LEVELS.items():
        if manifest[k]["maximumLevel"] != z:
            raise RuntimeError(
                f"{k} maximumLevel {manifest[k]['maximumLevel']} is not the pre-registered {z}"
            )
    lc_e, evi_e, lst_e = (manifest[k] for k in LEVELS)
    dec_lc, dec_evi, dec_lst = s.Decoder(lc_e), s.Decoder(evi_e), s.Decoder(lst_e)
    lc_t = Tiles(lc_e, LC_DATE, a.cache)
    dates = ss.evi_dates(2024)
    a.out.mkdir(parents=True, exist_ok=True)

    counts = {}
    with open(a.out / "pixels.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["region", "gx", "gy", "cls", "date", "evi", "lst"])
        pure = {}
        for region, (lat0, lon0) in REGIONS.items():
            px = []
            for gx, gy in ss.lst_pixels_in_box(lat0, lon0):
                labels = []
                for cx, cy in ss.children(gx, gy, 1):
                    v = dec_lc(read(lc_t, cx, cy))
                    labels.append(v[1] if v[0] == "class" else None)
                cls = ss.pixel_class(labels)
                if cls:
                    px.append((gx, gy, cls))
            pure[region] = px
            counts[region] = {
                "city": sum(p[2] == "city" for p in px),
                "cropland": sum(p[2] == "cropland" for p in px),
            }
            print(json.dumps({"region": region, **counts[region]}), flush=True)
        for date in dates:
            evi_t = Tiles(evi_e, date, a.cache)
            lst_ts = [Tiles(lst_e, d, a.cache) for d in ss.lst_pair(date)]
            for region, px in pure.items():
                for gx, gy, cls in px:
                    evi = ss.pixel_evi(
                        [
                            dec_evi(read(evi_t, cx, cy))
                            for cx, cy in ss.children(gx, gy, 2)
                        ],
                        dec_evi,
                    )
                    lst = ss.pixel_lst(
                        [dec_lst(read(t, gx, gy)) for t in lst_ts], dec_lst
                    )
                    w.writerow(
                        [
                            region,
                            gx,
                            gy,
                            cls,
                            date,
                            "" if evi is None else repr(evi),
                            "" if lst is None else repr(lst),
                        ]
                    )
            print(json.dumps({"date": date, "done": True}), flush=True)
    (a.out / "meta.json").write_text(
        json.dumps(
            {"site": a.site, "lc_date": LC_DATE, "dates": dates, "pure_pixels": counts},
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
