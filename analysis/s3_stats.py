"""The S3 pilot's pre-registered test (docs/analysis/s3-heat-greenness-prereg.md) on the sampled points.

Reads analysis/out/{points.csv,meta.json,site_check.json}; writes the committed outputs
docs/analysis/s3_heat_greenness_{regions,bins}.csv. Exit 0 PASS, 1 FAIL or NOT TESTABLE, 2 void
(harness control or site agreement failed or missing).

Run: python3 -m analysis.s3_stats
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np

from analysis import s3_lib as s

CITY, CROP = "Urban and Built-up Lands", "Croplands"
FOREST = {
    "Evergreen Needleleaf Forests",
    "Evergreen Broadleaf Forests",
    "Deciduous Needleleaf Forests",
    "Deciduous Broadleaf Forests",
    "Mixed Forests",
}  # IGBP 1-5, context only
GROUP = {CITY: "city", CROP: "cropland", **{f: "forest" for f in FOREST}}


def load(path: Path):
    """Per region: {'evi','lst','group'} arrays of usable points, and counts of what was dropped."""
    rows, dropped = {}, {}
    for r in csv.DictReader(open(path, encoding="utf-8")):
        g = GROUP.get(r["lc"])
        if g is None:
            continue
        d = dropped.setdefault(
            r["region"], {"lst_nodata": 0, "evi_nodata": 0, "wide": 0}
        )
        if r["lst_nodata"] == "1":
            d["lst_nodata"] += 1
            continue
        if r["evi_lo"] == "":
            d["evi_nodata"] += 1
            continue
        if r["evi_wide"] == "1" or r["lst_wide"] == "1":
            d["wide"] += 1
            continue
        evi = (float(r["evi_lo"]) + float(r["evi_hi"])) / 2
        lst = (float(r["lst_lo"]) + float(r["lst_hi"])) / 2 - 273.15
        rows.setdefault(r["region"], []).append((evi, lst, g))
    return {
        k: {
            "evi": np.array([v[0] for v in pts]),
            "lst": np.array([v[1] for v in pts]),
            "group": np.array([v[2] for v in pts]),
        }
        for k, pts in rows.items()
    }, dropped


def harness_control(meta: dict) -> bool:
    """Sahara barren must decode hotter than Amazon forest, by the same code."""
    c = meta["control"]
    ok = c["sahara"]["lc"] == ["class", "Barren"] and c["forest"]["lc"][1] in FOREST
    sa, fo = c["sahara"]["lst"], c["forest"]["lst"]
    return bool(
        ok
        and sa[0] == "value"
        and fo[0] == "value"
        and (sa[1] + sa[2]) > (fo[1] + fo[2])
    )


def main(argv=None) -> int:
    out, docs = Path("analysis/out"), Path("docs/analysis")
    meta = json.loads((out / "meta.json").read_text())
    if not harness_control(meta):
        print(f"VOID: harness control failed: {meta['control']}")
        return 2
    check = out / "site_check.json"
    site = (
        json.loads(check.read_text())
        if check.exists()
        else {"agree": False, "error": "missing"}
    )
    if not site.get("agree"):
        print(f"VOID: site agreement failed: {json.dumps(site)[:2000]}")
        return 2

    data, dropped = load(out / "points.csv")
    regions = []
    for i, (name, d) in enumerate(sorted(data.items())):
        m = (d["group"] == "city") | (d["group"] == "cropland")
        r = s.region_stats(
            d["evi"][m], d["lst"][m], d["group"][m] == "city", np.random.default_rng(i)
        )
        regions.append(
            {"region": name, **r, "passes": s.region_passes(r), **dropped[name]}
        )
    v = s.verdict(regions)

    fields = [
        "region",
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
        "passes",
        "lst_nodata",
        "evi_nodata",
        "wide",
    ]
    with open(
        docs / "s3_heat_greenness_regions.csv", "w", newline="", encoding="utf-8"
    ) as f:
        w = csv.writer(f)
        w.writerow(fields + ["lc_date", "evi_date", "lst_date", "verdict"])
        for r in regions:
            w.writerow(
                [round(r[k], 4) if isinstance(r[k], float) else r[k] for k in fields]
                + [meta["dates"]["lc"], meta["dates"]["evi"], meta["dates"]["lst"], v]
            )
    with open(
        docs / "s3_heat_greenness_bins.csv", "w", newline="", encoding="utf-8"
    ) as f:
        w = csv.writer(f)
        w.writerow(["region", "evi_bin_lo", "group", "n", "mean_lst_c"])
        for name, d in sorted(data.items()):
            b = np.floor(d["evi"] / s.EVI_BIN).astype(int)
            for k in np.unique(b):
                for g in ("city", "cropland", "forest"):
                    sel = (b == k) & (d["group"] == g)
                    if sel.any():
                        w.writerow(
                            [
                                name,
                                round(k * s.EVI_BIN, 2),
                                g,
                                int(sel.sum()),
                                round(float(d["lst"][sel].mean()), 3),
                            ]
                        )

    for r in regions:
        print(
            f"{r['region']:8s} city {r['n_city']:6d} crop {r['n_crop']:6d} matched {r['n_city_matched']:5d}/{r['n_crop_matched']:5d} "
            f"unmatched {r['unmatched_gap']:+6.2f}  matched {r['gap']:+6.2f} [{r['ci_lo']:+6.2f},{r['ci_hi']:+6.2f}] p={r['p']:.3f} "
            f"{'testable' if r['testable'] else 'not testable'} {'PASS' if r['passes'] else ''}"
        )
    print(f"VERDICT: {v}")
    return 0 if v == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
