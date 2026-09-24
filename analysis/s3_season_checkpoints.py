"""Pick the S3 season rerun's peak dates (EVI only) and the site-check points (docs/analysis/s3_season_prereg.md).

Peak date per region: the 2024 composite with the highest median EVI over its pure cropland pixels. No LST
value is read to choose it. The site-check date is the peak of the most regions (ties: earliest). At that
date: 50 seeded random level-9 pixel centres inside the sampled pixels (interior at levels 8 and 7, so no
edge ambiguity), decoded offline for land cover, EVI and the site's single LST composite; plus the harness
control points. Writes analysis/out_season/check_points.json.

Run: python3 -m analysis.s3_season_checkpoints
"""

from __future__ import annotations

import collections
import csv
import json
import random
import sys
import time
from pathlib import Path

import numpy as np

from analysis import s3_lib as s
from analysis import s3_season_lib as ss
from analysis.s3_sample import CONTROL, Tiles, get
from analysis.s3_season_sample import LC_DATE, read

N_CHECK = 50
SEED = 20260924


def peaks_from(pixels_csv: Path):
    """{region: peak date}, {region: {date: median cropland EVI}}, {region: [(gx, gy)]} — EVI column only."""
    evi = collections.defaultdict(lambda: collections.defaultdict(list))
    pix = collections.defaultdict(set)
    with open(pixels_csv, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            pix[r["region"]].add((int(r["gx"]), int(r["gy"])))
            if r["cls"] == "cropland" and r["evi"] != "":
                evi[r["region"]][r["date"]].append(float(r["evi"]))
    peaks = {reg: ss.peak_date(evi.get(reg, {})) for reg in pix}
    medians = {
        reg: {
            d: float(np.median(v)) if v else None
            for d, v in evi.get(reg, {}).items()
        }
        for reg in pix
    }
    return peaks, medians, {k: sorted(v) for k, v in pix.items()}


def check_date(peaks: dict) -> str:
    c = collections.Counter(d for d in peaks.values() if d)
    top = max(c.values())
    return min(d for d, n in c.items() if n == top)


def main(argv=None) -> int:
    out, cache = Path("analysis/out_season"), Path("analysis/.cache")
    meta = json.loads((out / "meta.json").read_text())
    manifest = json.loads(
        get(f"{meta['site'].rstrip('/')}/data/gibs.json?t={int(time.time())}")[0]
    )["layers"]
    peaks, medians, pix = peaks_from(out / "pixels.csv")
    date = check_date(peaks)
    lc_e, evi_e, lst_e = (
        manifest["gibs-landcover"],
        manifest["gibs-evi"],
        manifest["gibs-lst"],
    )
    dec = {"lc": s.Decoder(lc_e), "evi": s.Decoder(evi_e), "lst": s.Decoder(lst_e)}
    lst_date = ss.lst_pair(date)[0]
    t = {
        "lc": Tiles(lc_e, LC_DATE, cache),
        "evi": Tiles(evi_e, date, cache),
        "lst": Tiles(lst_e, lst_date, cache),
    }

    rng = random.Random(SEED)
    all_pix = [(reg, gx, gy) for reg in sorted(pix) for gx, gy in pix[reg]]
    points = []
    for _ in range(N_CHECK):
        reg, gx, gy = rng.choice(all_pix)
        cx, cy = rng.choice(ss.children(gx, gy, 2))
        lat, lon = s.pixel_centre(
            9, cx // s.TILE, cy // s.TILE, cx % s.TILE, cy % s.TILE
        )
        points.append(
            {
                "region": reg,
                "lat": lat,
                "lon": lon,
                "lc": list(dec["lc"](read(t["lc"], cx // 2, cy // 2))),
                "evi": list(dec["evi"](read(t["evi"], cx, cy))),
                "lst": list(dec["lst"](read(t["lst"], gx, gy))),
            }
        )
        assert s.tile_pixel(lat, lon, 7)[:2] == (gx // s.TILE, gy // s.TILE), (
            "check point left its pixel"
        )
    control = {
        name: {
            "lc": list(dec["lc"](t["lc"].pixel(lat, lon))),
            "lst": list(dec["lst"](t["lst"].pixel(lat, lon))),
        }
        for name, (lat, lon) in CONTROL.items()
    }
    (out / "check_points.json").write_text(
        json.dumps(
            {
                "date": date,
                "lst_date": lst_date,
                "lc_date": LC_DATE,
                "peaks": peaks,
                "cropland_median_evi": medians,
                "control": control,
                "points": points,
            },
            indent=1,
        )
    )
    print(json.dumps({"check_date": date, "peaks": peaks}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
