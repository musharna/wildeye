"""The S3 season rerun's pre-registered test (docs/analysis/s3_season_prereg.md).

Reads analysis/out_season/{pixels.csv,check_points.json,site_check.json}; writes
docs/analysis/s3_season_{regions,curve}.csv. Exit 0 PASS, 1 FAIL or NOT TESTABLE, 2 void (harness control or
site agreement failed or missing).

Run: python3 -m analysis.s3_season_stats
"""

from __future__ import annotations

import collections
import csv
import json
import sys
from pathlib import Path

import numpy as np

from analysis import s3_lib as s
from analysis import s3_season_lib as ss

SEP = "2024-09-13"
PILOT_FAILED = {"Paris", "Chicago", "Córdoba"}
STAT = [
    "n_city",
    "n_crop",
    "n_city_matched",
    "n_crop_matched",
    "unmatched_gap",
    "gap",
    "ci_lo",
    "ci_hi",
    "p",
    "testable",
]


def harness_control(cp: dict) -> bool:
    c = cp["control"]
    sa, fo = c["sahara"], c["forest"]
    return bool(
        sa["lc"] == ["class", "Barren"]
        and fo["lc"] == ["class", "Evergreen Broadleaf Forests"]
        and sa["lst"][0] == "value"
        and fo["lst"][0] == "value"
        and sa["lst"][1] + sa["lst"][2] > fo["lst"][1] + fo["lst"][2]
    )


def load(path: Path):
    """{(region, date): (evi, lst, city) arrays} over pixels with both values; and city EVI medians."""
    rows = collections.defaultdict(list)
    city_evi = collections.defaultdict(list)
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["evi"] == "":
                continue
            if r["cls"] == "city":
                city_evi[(r["region"], r["date"])].append(float(r["evi"]))
            if r["lst"] != "":
                rows[(r["region"], r["date"])].append(
                    (float(r["evi"]), float(r["lst"]), r["cls"] == "city")
                )
    data = {k: tuple(np.array(c) for c in zip(*v)) for k, v in rows.items()}
    return data, {k: float(np.median(v)) for k, v in city_evi.items()}


def empty() -> dict:
    return {
        "n_city": 0,
        "n_crop": 0,
        "n_city_matched": 0,
        "n_crop_matched": 0,
        "unmatched_gap": float("nan"),
        "gap": float("nan"),
        "ci_lo": float("nan"),
        "ci_hi": float("nan"),
        "p": float("nan"),
        "testable": False,
    }


def main(argv=None) -> int:
    out, docs = Path("analysis/out_season"), Path("docs/analysis")
    cp = json.loads((out / "check_points.json").read_text())
    if not harness_control(cp):
        print(f"VOID: harness control failed: {cp['control']}")
        return 2
    check = out / "site_check.json"
    site = (
        json.loads(check.read_text())
        if check.exists()
        else {"agree": False, "error": "missing"}
    )
    if not site.get("agree") or site.get("date") != cp["date"]:
        print(f"VOID: site agreement failed: {json.dumps(site)[:2000]}")
        return 2

    data, city_med = load(out / "pixels.csv")
    crop_med = cp["cropland_median_evi"]
    regions = sorted(cp["peaks"])
    dates = ss.evi_dates(2024)
    stats = {}
    for i, reg in enumerate(regions):
        for j, d in enumerate(dates):
            if (reg, d) in data:
                evi, lst, city = data[(reg, d)]
                stats[(reg, d)] = s.region_stats(
                    evi, lst, city, np.random.default_rng(1000 * i + j)
                )
            else:
                stats[(reg, d)] = empty()

    rows = []
    for reg in regions:
        peak = cp["peaks"][reg]
        pk = stats[(reg, peak)] if peak else empty()
        sp = stats[(reg, SEP)]
        eng = ss.engaged(
            crop_med[reg].get(peak) if peak else None, crop_med[reg].get(SEP)
        )
        rows.append(
            {
                "region": reg,
                "peak_date": peak,
                "eng": eng,
                "peak": pk,
                "sep": sp,
                "passes": s.region_passes(pk),
                "reading": ss.reading(pk, sp, eng) if reg in PILOT_FAILED else "",
            }
        )
    v = s.verdict([r["peak"] for r in rows])

    fmt = lambda x: round(x, 4) if isinstance(x, float) else x  # noqa: E731
    with open(docs / "s3_season_regions.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(
            [
                "region",
                "peak_date",
                "crop_median_evi_peak",
                "crop_median_evi_sep",
                "engaged",
            ]
            + [f"peak_{k}" for k in STAT]
            + ["peak_passes"]
            + [f"sep_{k}" for k in STAT]
            + ["reading", "verdict"]
        )
        for r in rows:
            reg, peak = r["region"], r["peak_date"]
            w.writerow(
                [
                    reg,
                    peak,
                    fmt(crop_med[reg].get(peak)) if peak else "",
                    fmt(crop_med[reg].get(SEP)),
                    r["eng"],
                ]
                + [fmt(r["peak"][k]) for k in STAT]
                + [r["passes"]]
                + [fmt(r["sep"][k]) for k in STAT]
                + [r["reading"], v]
            )
    with open(docs / "s3_season_curve.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(
            ["region", "date", "is_peak", "is_sep"]
            + STAT
            + ["crop_median_evi", "city_median_evi"]
        )
        for reg in regions:
            for d in dates:
                st = stats[(reg, d)]
                w.writerow(
                    [reg, d, d == cp["peaks"][reg], d == SEP]
                    + [fmt(st[k]) for k in STAT]
                    + [fmt(crop_med[reg].get(d)), fmt(city_med.get((reg, d)))]
                )

    with open(docs / "s3_season_bins.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["region", "date", "evi_bin_lo", "group", "n", "mean_lst_c"])
        for r in rows:
            if not r["peak_date"] or (r["region"], r["peak_date"]) not in data:
                continue
            evi, lst, city = data[(r["region"], r["peak_date"])]
            b = np.floor(evi / s.EVI_BIN).astype(int)
            for k in np.unique(b):
                for g, sel in (("city", city), ("cropland", ~city)):
                    m = (b == k) & sel
                    if m.any():
                        w.writerow([r["region"], r["peak_date"], round(k * s.EVI_BIN, 2), g, int(m.sum()), round(float(lst[m].mean()), 3)])

    for r in rows:
        pk, sp = r["peak"], r["sep"]
        print(
            f"{r['region']:8s} peak {r['peak_date']} engaged={r['eng']!s:5s} "
            f"peak {pk['gap']:+6.2f} [{pk['ci_lo']:+6.2f},{pk['ci_hi']:+6.2f}] p={pk['p']:.3f} n={pk['n_city_matched']}/{pk['n_crop_matched']} "
            f"{'PASS' if r['passes'] else ('not testable' if not pk['testable'] else 'fail')} | "
            f"sep {sp['gap']:+6.2f} [{sp['ci_lo']:+6.2f},{sp['ci_hi']:+6.2f}] {r['reading']}"
        )
    print(f"VERDICT: {v}")
    return 0 if v == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
