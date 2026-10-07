"""Premise check for the cmems-pft drape: is the dominant phytoplankton group just chlorophyll re-coloured?

Reads the latest month of Copernicus-GlobColour PFTs (OCEANCOLOUR_GLO_BGC_L4_NRT_009_102, dataset
cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M) at 4 km and reports, written to
docs/analysis/pft_premise.md:

1. nesting at 4 km: how often PROCHLO <= PROKAR and PROCHLO <= GREEN, and how the sum of the five groups
   compares with CHL (ratio percentiles);
2. the dominant group per 0.25 degree cell: each group block-meaned over the 6x6 4 km pixels where all five
   groups are present, then the argmax over DIATO, DINO, HAPTO, GREEN, PROKAR (Prochlorococcus is a
   prokaryote and only splits that class, Xi et al. 2020 sections 2.1.3 and 2.3, so it is not a competitor); group shares of cells, by count and by area;
3. the null arm: how well CHL ALONE (block-meaned over the same pixels) predicts that group:
   a. a decision tree on log10 CHL with max_leaf_nodes = 5 (greedy);
   b. the best classifier with at most 5 CHL intervals, each labelled with one group (exact dynamic
      programme over 2000 CHL quantile bins; cuts at bin edges);
   c. the ceiling for ANY function of CHL at that binning: every bin labelled with its majority group.
   All in-sample, which flatters the null; that is the conservative direction for this check.

The STOP rule (ledger decision 4): if the best of (a)/(b) reaches 95 % of ocean cells, the layer is
chlorophyll re-coloured. (c) is reported as a ceiling, not used for the rule.

Run: set -a; . ~/.config/wildeye/env; set +a; python3 -m analysis.pft_premise
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
from pathlib import Path

import numpy as np

GROUPS = ["DIATO", "DINO", "HAPTO", "GREEN", "PROKAR"]
DATASET = "cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M"
BLOCK = 6  # 8640 / 1440 = 4320 / 720 = 6: 4 km pixels per 0.25 degree cell
OUT = Path(__file__).resolve().parent.parent / "docs" / "analysis" / "pft_premise.md"


def block_sum(a: np.ndarray, b: int) -> np.ndarray:
    h, w = a.shape
    return a.reshape(h // b, b, w // b, b).sum(axis=(1, 3))


def best_k_intervals(
    counts: np.ndarray, k: int
) -> tuple[int, list[tuple[int, int, int]]]:
    """counts: (bins, classes), bins in CHL order. Max agreement with at most k contiguous intervals, each one
    class. Returns (agreement, [(start_bin, end_bin_exclusive, class), ...])."""
    nb, nc = counts.shape
    pref = np.vstack([np.zeros((1, nc), np.int64), np.cumsum(counts, axis=0)])
    # gain[i, j] = best single-class agreement over bins i..j-1
    gain = np.full((nb + 1, nb + 1), -1, np.int64)
    arg = np.zeros((nb + 1, nb + 1), np.int64)
    for i in range(nb):
        seg = pref[i + 1 :] - pref[i]
        gain[i, i + 1 :] = seg.max(axis=1)
        arg[i, i + 1 :] = seg.argmax(axis=1)
    neg = np.iinfo(np.int64).min // 4
    dp = np.full((k + 1, nb + 1), neg, np.int64)
    back = np.zeros((k + 1, nb + 1), np.int64)
    dp[0, 0] = 0
    for kk in range(1, k + 1):
        for j in range(1, nb + 1):
            cand = dp[kk - 1, :j] + gain[:j, j]
            i = int(np.argmax(cand))
            dp[kk, j], back[kk, j] = cand[i], i
    kk = int(np.argmax(dp[:, nb]))
    best = int(dp[kk, nb])
    segs, j = [], nb
    while kk > 0:
        i = int(back[kk, j])
        segs.append((i, j, int(arg[i, j])))
        j, kk = i, kk - 1
    return best, segs[::-1]


def main(argv=None) -> int:
    signal.signal(
        signal.SIGALRM,
        lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
    )
    signal.alarm(1800)
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)

    import copernicusmarine as cm
    from sklearn.tree import DecisionTreeClassifier

    ds = cm.open_dataset(
        dataset_id=DATASET,
        username=os.environ["CMEMS_USER"],
        password=os.environ["CMEMS_PASS"],
        variables=GROUPS + ["PROCHLO", "CHL", "flags"],
    )
    k = ds.sizes["time"] - 1
    when = str(np.datetime_as_string(ds["time"].values[k], unit="D"))
    lat = ds["latitude"].values
    get = lambda v: np.asarray(ds[v].isel(time=k).values, dtype=np.float32)  # noqa: E731
    land = np.asarray(ds["flags"].isel(time=k).values) & 1
    lines = [
        f"# cmems-pft premise check ({when})",
        "",
        f"Dataset `{DATASET}`, time step {when}, grid {land.shape[1]}x{land.shape[0]}.",
        "",
    ]

    g = {v: get(v) for v in GROUPS}
    pro = get("PROCHLO")
    chl = get("CHL")
    allok = np.logical_and.reduce([np.isfinite(g[v]) for v in GROUPS])
    sea = land == 0
    n_sea, n_ok = int(sea.sum()), int((allok & sea).sum())
    lines += [
        "## Nesting at 4 km",
        "",
        f"Ocean 4 km pixels (flags LAND = 0): {n_sea:,}; with all five groups present: {n_ok:,} ({100 * n_ok / n_sea:.1f} %).",
        "",
    ]
    m = allok & np.isfinite(pro)
    for name, other in [("PROKAR", g["PROKAR"]), ("GREEN", g["GREEN"])]:
        le = int((pro[m] <= other[m] * (1 + 1e-5)).sum())
        lines.append(
            f"- PROCHLO <= {name}: {le:,} of {int(m.sum()):,} pixels ({100 * le / m.sum():.3f} %)"
        )
    rp = np.percentile(pro[m] / g["PROKAR"][m], [5, 25, 50, 75, 95])
    lines.append(
        "- PROCHLO / PROKAR percentiles 5/25/50/75/95: "
        + " / ".join(f"{x:.3f}" for x in rp)
    )
    s5 = sum(g[v] for v in GROUPS)
    mc = allok & np.isfinite(chl) & (chl > 0)
    r = s5[mc] / chl[mc]
    q = np.percentile(r, [1, 5, 25, 50, 75, 95, 99])
    lines.append(
        "- (DIATO+DINO+HAPTO+GREEN+PROKAR) / CHL percentiles 1/5/25/50/75/95/99: "
        + " / ".join(f"{x:.3f}" for x in q)
    )
    r6 = (s5[mc] + np.nan_to_num(pro[mc])) / chl[mc]
    lines.append(f"- same sum plus PROCHLO, median ratio: {np.median(r6):.3f}")
    lines.append("")
    del s5, r, r6, pro

    # 0.25 degree cells: mean over the 4 km pixels where all five groups are present
    cnt = block_sum(allok.astype(np.int32), BLOCK)
    means = []
    for v in GROUPS:
        means.append(block_sum(np.where(allok, g[v], 0).astype(np.float64), BLOCK))
    chl_b = block_sum(
        np.where(allok & np.isfinite(chl), chl, 0).astype(np.float64), BLOCK
    )
    chl_n = block_sum((allok & np.isfinite(chl)).astype(np.int32), BLOCK)
    del g, chl
    ok = (cnt > 0) & (chl_n == cnt)
    stack = np.stack(means)[:, ok] / cnt[ok]
    dom = np.argmax(stack, axis=0)
    dino_frac = stack[GROUPS.index("DINO")] / stack.max(axis=0)
    c = chl_b[ok] / chl_n[ok]
    lat_c = lat.reshape(-1, BLOCK).mean(axis=1)
    w = np.cos(np.deg2rad(np.broadcast_to(lat_c[:, None], ok.shape)[ok]))
    n = int(ok.sum())
    sea_cells = int((block_sum(sea.astype(np.int32), BLOCK) > 0).sum())
    lines += [
        "## Dominant group per 0.25 degree cell",
        "",
        f"Cells with data: {n:,} of {sea_cells:,} cells holding any ocean pixel ({100 * n / sea_cells:.1f} %).",
        "",
        "| group | cells | share of cells | share of area |",
        "|---|---:|---:|---:|",
    ]
    for i, v in enumerate(GROUPS):
        sel = dom == i
        lines.append(
            f"| {v} | {int(sel.sum()):,} | {100 * sel.mean():.2f} % | {100 * w[sel].sum() / w.sum():.2f} % |"
        )
    lines.append(
        "\nDINO as a share of the winning group's chlorophyll, percentiles 50/99/max: "
        + " / ".join(f"{x:.3f}" for x in np.percentile(dino_frac, [50, 99, 100]))
    )
    lines.append("")

    # null arm
    x = np.log10(np.maximum(c, 1e-6))
    tree = DecisionTreeClassifier(max_leaf_nodes=len(GROUPS), random_state=0).fit(
        x[:, None], dom
    )
    acc_tree = float((tree.predict(x[:, None]) == dom).mean())
    acc_tree_w = float(((tree.predict(x[:, None]) == dom) * w).sum() / w.sum())
    nb = 2000
    edges = np.unique(np.quantile(x, np.linspace(0, 1, nb + 1)))
    b = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, len(edges) - 2)
    counts = np.zeros((len(edges) - 1, len(GROUPS)), np.int64)
    np.add.at(counts, (b, dom), 1)
    best, segs = best_k_intervals(counts, len(GROUPS))
    acc_dp = best / n
    ceiling = counts.max(axis=1).sum() / n
    lines += [
        "## Null arm: CHL alone",
        "",
        f"- decision tree on log10 CHL, max_leaf_nodes = 5: {100 * acc_tree:.2f} % of cells ({100 * acc_tree_w:.2f} % of area)",
        f"- best <= 5 CHL intervals (exact DP over {len(edges) - 1} quantile bins): {100 * acc_dp:.2f} % of cells",
        "  - intervals: "
        + "; ".join(
            f"CHL {10 ** edges[i]:.3g}-{10 ** edges[j]:.3g} -> {GROUPS[cl]}"
            for i, j, cl in segs
        ),
        f"- ceiling, any function of CHL at that binning (bin majority): {100 * ceiling:.2f} % of cells",
        "",
    ]
    best_null = max(acc_tree, acc_dp)
    verdict = (
        "STOP: chlorophyll re-coloured"
        if best_null >= 0.95
        else "premise holds: the dominant group is not chlorophyll re-coloured"
    )
    lines += [
        f"**Verdict**: best CHL-only classifier {100 * best_null:.2f} % vs the 95 % stop line: {verdict}.",
        "",
    ]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines))
    print("\n".join(lines))
    return 0 if best_null < 0.95 else 3


if __name__ == "__main__":
    sys.exit(main())
