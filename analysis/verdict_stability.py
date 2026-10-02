"""Simulate group-verdict rules for wildeye geomodel from the saved Sep + Oct per-species rows.

Per-month bar = the harness's own group_verdict (imported, not re-implemented).
Worlds per group: alt = bootstrap of the pooled rows (the group's observed edge);
null = same rows with model/baseline swapped at random (no edge, same TSS spread).
"sprt" here is H1 0.65; verdict_stability_sweep.py varies H1 and the cap and replays the real months.

Usage (repo root): python -B -m analysis.verdict_stability SEPT_VERDICTS.json OCT_VERDICTS.json [YEARS]
Output of the 2026-10-02 run (Sept 30 live file, held Oct 2 run 5213, 2000 years): verdict_stability_2026-10-02.txt
"""

import json
import signal
import sys
from collections import namedtuple

import numpy as np

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(1500)
from pipeline.geomodel_check import group_verdict  # noqa: E402

R = namedtuple("R", "model_tss baseline_tss")
SEP, OCT = sys.argv[1], sys.argv[2]
YEARS = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
rng = np.random.default_rng(20261002)


def rows(path):
    return {
        g: [R(s["model_tss"], s["baseline_tss"]) for s in v.get("species", [])]
        for g, v in json.load(open(path))["groups"].items()
    }


sep, octo = rows(SEP), rows(OCT)
groups = sorted(set(sep) | set(octo))


def passes(rs):
    return group_verdict(rs, {})["verdict"] == "pass"


def wl(rs):
    return sum(r.model_tss > r.baseline_tss for r in rs), sum(
        r.model_tss < r.baseline_tss for r in rs
    )


# ---- (b) are Sep and Oct the same population? permutation on win share ----
print("== (b) Sep vs Oct win share, permutation p (two-sided, 4000 splits)")
small_p = 0
for g in groups:
    a, b = sep.get(g, []), octo.get(g, [])
    if not a or not b:
        print(f"{g:16s} missing a month")
        continue

    def share(rs):
        w, l = wl(rs)
        return w / max(w + l, 1)

    obs = abs(share(a) - share(b))
    pool = a + b
    hits = 0
    for _ in range(4000):
        idx = rng.permutation(len(pool))
        hits += (
            abs(
                share([pool[i] for i in idx[: len(a)]])
                - share([pool[i] for i in idx[len(a) :]])
            )
            >= obs - 1e-12
        )
    p = hits / 4000
    small_p += p < 0.05
    print(
        f"{g:16s} Sep {wl(a)} Oct {wl(b)} pooled {wl(pool)} p={p:.3f}  pooled-60 verdict={'pass' if passes(pool) else 'fail'}"
    )
print(
    f"groups with p<0.05: {small_p} of {len(groups)} (chance ~{0.05 * len(groups):.1f})"
)


# ---- rules ----
def draw(pool, n, null):
    idx = rng.integers(0, len(pool), n)
    out = [pool[i] for i in idx]
    if null:
        flip = rng.random(n) < 0.5
        out = [R(r.baseline_tss, r.model_tss) if f else r for r, f in zip(out, flip)]
    return out


SPRT_UP = float(np.log((1 - 0.10) / 0.05))
SPRT_DOWN = float(np.log(0.10 / (1 - 0.05)))
SPRT_CAP = 3.0


def run_year(pool, null, rule, start_listed):
    """Return list of 12 listed-states. Pool rules get 2 burn-in months of data."""
    n = 60 if rule in ("n60", "n60_hyst") else 30
    hist, listed, streak = [], start_listed, 0
    llr_state = [SPRT_UP + SPRT_CAP if start_listed else 0.0]
    for _ in range(2):
        hist.append(draw(pool, n, null))
    states = []
    for _ in range(12):
        hist.append(draw(pool, n, null))
        m = hist[-1]
        if rule in ("now", "n60"):
            listed = passes(m)
        elif rule in ("hyst2", "n60_hyst"):
            p = passes(m)
            if p != listed:
                streak += 1
                if streak >= 2:
                    listed, streak = p, 0
            else:
                streak = 0
        elif rule == "pool3":
            listed = passes(hist[-1] + hist[-2] + hist[-3])
        elif (
            rule == "pool3_rev"
        ):  # enter on a passing 3-month pool, leave only when the pool's evidence reverses
            pooled = hist[-1] + hist[-2] + hist[-3]
            if not listed:
                listed = passes(pooled)
            else:
                w, l = wl(pooled)
                v = group_verdict(pooled, {})
                listed = not (w <= l or v.get("median_tss", 1) < 0.40)
        elif rule == "sprt":
            # Wald SPRT on per-species wins vs losses, H0 p=0.5 vs H1 p=0.65, alpha 0.05, beta 0.10.
            # State carries month to month; listing also needs the month's median model TSS >= 0.40.
            w, l = wl(m)
            llr_state[0] = min(llr_state[0] + w * np.log(0.65 / 0.5) + l * np.log(0.35 / 0.5), SPRT_UP + SPRT_CAP)
            med_ok = group_verdict(m, {}).get("median_tss", 0) >= 0.40
            if not listed and llr_state[0] >= SPRT_UP and med_ok:
                listed = True
            elif listed and llr_state[0] <= SPRT_DOWN:
                listed, llr_state[0] = False, 0.0
            if llr_state[0] <= SPRT_DOWN and not listed:
                llr_state[0] = SPRT_DOWN  # floor: a no-edge history cannot bank unbounded doubt
        states.append(listed)
    return states


RULES = ["now", "n60", "hyst2", "n60_hyst", "pool3", "pool3_rev", "sprt"]
COST = {"now": 1, "n60": 2, "hyst2": 1, "n60_hyst": 2, "pool3": 1, "pool3_rev": 1, "sprt": 1}
print(f"\n== yearly rates, {YEARS} simulated years per cell")
print(
    "false = null group listed in any month (start unlisted); churn = alt group dropped in any month (start listed);"
)
print(
    "reach = alt group listed by month 12 (start unlisted). Budgets: false <= 5%, churn <= 5%."
)
res = {}
for g in groups:
    pool = sep.get(g, []) + octo.get(g, [])
    if len(pool) < 20:
        continue
    for rule in RULES:
        f = np.mean([any(run_year(pool, True, rule, False)) for _ in range(YEARS)])
        c = np.mean([not all(run_year(pool, False, rule, True)) for _ in range(YEARS)])
        r = np.mean([run_year(pool, False, rule, False)[-1] for _ in range(YEARS)])
        res[(g, rule)] = (f, c, r)
    print(g, "pooled", wl(pool))
    for rule in RULES:
        f, c, r = res[(g, rule)]
        print(
            f"   {rule:10s} cost x{COST[rule]}  false {f:6.1%}  churn {c:6.1%}  reach {r:6.1%}"
        )


# ---- (c) does each rule engage on the real Sep -> Oct history? ----
print(
    "\n== (c) real history: Sep verdict -> Oct verdict under each rule (Sep state = Sep's own pass)"
)
for g in groups:
    a, b = sep.get(g, []), octo.get(g, [])
    if not a or not b:
        continue
    pa, pb = passes(a), passes(b)
    hyst = pa if pa != pb else pb  # one opposite month never flips a hysteresis-2 state
    print(
        f"{g:16s} now {pa}->{pb}   hyst2 {pa}->{hyst}   pool(Sep+Oct) {passes(a + b)}"
    )
