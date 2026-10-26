"""Score the AEF change pilot tables and apply the frozen held-out gate (grill_wildeye_aef_change_2026-10-26).

Score zn: nov3_k = distance from year k to the closest of years k-3..k-1 (a state seen recently, such as the other
crop of a rotation, scores low); zn = (nov3_2025 - median nov3_2020..2024) / max(1.4826 * MAD, FLOOR).
The threshold is the strict-stable 99.9th percentile on the PILOT tiles only, then applied unchanged to the held-out tiles.

Run:  python3 -B -m analysis.aef_change_stats --pilot pilot/cells.tsv --holdout holdout/cells.tsv --out docs/analysis
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import rankdata

FLOOR = 0.003
FROZEN_THRESHOLD = 6.5  # written in the grill ledger before the held-out run; recomputed below as a check
FRESH = 0.10  # a cell counts as fresh 2025 loss when ≥10% of it was lost in 2025 and none in 2017–24


def pair(t, i, j):
    i, j = min(i, j), max(i, j)
    return t[
        f"d{i % 100}{j % 100}" if j == i + 1 else f"p{i % 100}{j % 100}"
    ].to_numpy()


def nov3(t, k):
    return np.nanmin(np.stack([pair(t, k, j) for j in range(k - 3, k)]), 0)


def zn(t, target, history):
    n = {k: nov3(t, k) for k in [*history, target]}
    h = np.stack([n[k] for k in history])
    med = np.nanmedian(h, 0)
    mad = 1.4826 * np.nanmedian(np.abs(h - med), 0)
    return (n[target] - med) / np.maximum(mad, FLOOR)


def auroc(pos, neg):
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    r = rankdata(np.concatenate([pos, neg]))
    return float(
        (r[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))
    )


def scored(path):
    t = pd.read_csv(path, sep="\t", na_values="NA")
    t["zn25"] = zn(t, 2025, range(2020, 2025))
    t["zn24"] = zn(
        t, 2024, range(2020, 2024)
    )  # the same score one year earlier: the null arm
    t["fresh25"] = (t.loss25 >= FRESH) & (t.loss1724 == 0)
    t["strict"] = t.ifl & (t.lossany == 0)
    return t


def region_rows(t, thr):
    rows = []
    for name, g in t.groupby("region", sort=False):
        fresh, zero = g.fresh25.to_numpy(), (g.lossany == 0).to_numpy()
        rows.append(
            {
                "region": name,
                "kind": g.kind.iloc[0],
                "cells": int(g.zn25.notna().sum()),
                "flagged_2025": round(float(np.mean(g.zn25 > thr)), 4),
                "flagged_2024": round(float(np.mean(g.zn24 > thr)), 4),
                "fresh25_cells": int(fresh.sum()),
                "fresh25_caught": round(float(np.mean(g.zn25[fresh] > thr)), 3)
                if fresh.sum()
                else None,
                "auroc_within": round(
                    auroc(g.zn25[fresh].to_numpy(), g.zn25[zero].to_numpy()), 3
                )
                if fresh.sum() >= 20
                else None,
            }
        )
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pilot", required=True)
    ap.add_argument("--holdout", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    pilot, hold = scored(a.pilot), scored(a.holdout)
    thr = float(np.nanpercentile(pilot.zn25[pilot.strict], 99.9))
    if abs(thr - FROZEN_THRESHOLD) > 0.05:
        raise SystemExit(
            f"pilot threshold {thr:.3f} is not the frozen {FROZEN_THRESHOLD}: the pilot table changed"
        )
    hr = region_rows(hold, FROZEN_THRESHOLD)
    top = hold[hold.zn25 > FROZEN_THRESHOLD]
    gate = {
        "strict_stable_flagged": round(
            float(np.mean(hold.zn25[hold.strict] > FROZEN_THRESHOLD)), 4
        ),
        "strict_stable_cells": int(hold.strict.sum()),
        "change_auroc_within": {
            r["region"]: r["auroc_within"]
            for r in hr
            if r["kind"] == "change" and r["auroc_within"] is not None
        },
        "farm_flagged": {
            r["region"]: r["flagged_2025"] for r in hr if r["kind"] == "farm"
        },
        "edge_share_top": round(float(top.edge.mean()), 3),
        "edge_share_base": round(float(hold.edge.mean()), 3),
    }
    checks = {
        "strict stable flagged <= 0.5%": gate["strict_stable_flagged"] <= 0.005,
        "change tiles AUROC >= 0.85": bool(gate["change_auroc_within"])
        and all(v >= 0.85 for v in gate["change_auroc_within"].values()),
        "farm tiles flagged <= 15%": all(
            v <= 0.15 for v in gate["farm_flagged"].values()
        ),
        "top cells not edge-piled": gate["edge_share_top"]
        <= 1.5 * gate["edge_share_base"],
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    doc = {
        "threshold": FROZEN_THRESHOLD,
        "floor": FLOOR,
        "pilot": region_rows(pilot, FROZEN_THRESHOLD),
        "holdout": hr,
        "gate": gate,
        "checks": checks,
    }
    (out / "aef_change_pilot.json").write_text(json.dumps(doc, indent=1) + "\n")
    for r in hr:
        print(r)
    print(json.dumps(gate, indent=1))
    for k, v in checks.items():
        print(("PASS " if v else "FAIL ") + k)


if __name__ == "__main__":
    main()
