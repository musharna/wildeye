"""S3 year-vs-counting diagnostic (docs/analysis/s3_year_vs_counting.md).

Arm A: the pilot's point method on 2024 data (points written by `python3 -m analysis.s3_sample --lc-date
2024-01-01 --evi-date 2024-09-13 --lst-date 2024-09-13 --out <dir>`). Arm A-pure: the same, restricted to
points whose level-7 LST pixel holds points of one class only. Arms P (pilot, 2026) and B (season rerun's
September 2024 arm) are read from their committed CSVs. Writes docs/analysis/s3_year_vs_counting.csv.

Run: python3 -m analysis.s3_year_vs_counting <points_dir>
"""

from __future__ import annotations

import collections
import csv
import sys
from pathlib import Path

import numpy as np

from analysis import s3_lib as s

CITY, CROP = "Urban and Built-up Lands", "Croplands"
DECIDE = ("Paris", "Chicago")


def _pos(r):
    return bool(r["testable"] and r["gap"] > 0 and r["ci_lo"] > 0)


def _neg(r):
    return bool(r["testable"] and r["gap"] < 0 and r["ci_hi"] < 0)


def reading(a: dict, a_pure: dict) -> str:
    """The note's reading for one region, from arm A and arm A-pure."""
    if _neg(a):
        if _pos(a_pure):
            return "counting, not year (mixed pixels drive it)"
        if _neg(a_pure):
            return "counting, not year (the rest of the method drives it)"
        return "counting, not year"
    if _pos(a):
        return "year, not counting"
    return "unresolved"


def load_points(path: Path):
    """Per region: usable city/cropland points as (evi, lst °C, is_city, pure) arrays."""
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    classes = collections.defaultdict(set)
    for r in rows:
        classes[(r["region"], *s.tile_pixel(float(r["lat"]), float(r["lon"]), 7))].add(r["lc"])
    out = collections.defaultdict(list)
    for r in rows:
        if r["lc"] not in (CITY, CROP) or r["lst_nodata"] == "1" or r["evi_lo"] == "":
            continue
        if r["evi_wide"] == "1" or r["lst_wide"] == "1":
            continue
        pure = classes[(r["region"], *s.tile_pixel(float(r["lat"]), float(r["lon"]), 7))] == {r["lc"]}
        out[r["region"]].append(((float(r["evi_lo"]) + float(r["evi_hi"])) / 2,
                                 (float(r["lst_lo"]) + float(r["lst_hi"])) / 2 - 273.15, r["lc"] == CITY, pure))
    return {k: tuple(np.array(c) for c in zip(*v)) for k, v in out.items()}


def recorded(path: Path, prefix: str) -> dict:
    out = {}
    for r in csv.DictReader(open(path, encoding="utf-8")):
        g = lambda k: float(r[prefix + k]) if r[prefix + k] not in ("", "nan") else float("nan")  # noqa: E731
        out[r["region"]] = {"gap": g("gap"), "ci_lo": g("ci_lo"), "ci_hi": g("ci_hi"),
                            "n_city_matched": r[prefix + "n_city_matched"], "testable": r[prefix + "testable"] == "True"}
    return out


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    pts = load_points(Path(argv[0]) / "points.csv")
    docs = Path("docs/analysis")
    P = recorded(docs / "s3_heat_greenness_regions.csv", "")
    B = recorded(docs / "s3_season_regions.csv", "sep_")
    rows = []
    for i, reg in enumerate(sorted(pts)):
        evi, lst, city, pure = pts[reg]
        A = s.region_stats(evi, lst, city, np.random.default_rng(i))
        Ap = s.region_stats(evi[pure], lst[pure], city[pure], np.random.default_rng(100 + i))
        rows.append({"region": reg, "P": P.get(reg), "A": A, "A_pure": Ap, "B": B.get(reg),
                     "reading": reading(A, Ap) if reg in DECIDE else ""})
    arms = ("P", "A", "A_pure", "B")
    with open(docs / "s3_year_vs_counting.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["region"] + [f"{a}_{k}" for a in arms for k in ("gap", "ci_lo", "ci_hi", "n_city_matched", "testable")] + ["reading"])
        for r in rows:
            vals = []
            for a in arms:
                x = r[a] or {}
                vals += [round(x[k], 3) if isinstance(x.get(k), float) else x.get(k, "") for k in ("gap", "ci_lo", "ci_hi", "n_city_matched", "testable")]
            w.writerow([r["region"]] + vals + [r["reading"]])
    for r in rows:
        f = lambda x: "   n/a " if not x or not x["testable"] else f"{x['gap']:+6.2f} [{x['ci_lo']:+5.2f},{x['ci_hi']:+5.2f}]"  # noqa: E731
        print(f"{r['region']:8s} P {f(r['P'])} | A {f(r['A'])} | A-pure {f(r['A_pure'])} | B {f(r['B'])}  {r['reading']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
