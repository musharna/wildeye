"""Why E0 came back VOID: the case z is biased upward under a null built to have no drought effect (post hoc).

Run after the frozen E0 run (docs/analysis/e0-dieoffs-drought.md), from the repo root:
    python -m analysis.e0_null_bias --cache ~/.cache/wildeye/e0 --out docs/analysis/e0_null_bias.json
It recomputes, through pipeline.e0_dieoffs, the case z of the planted beta = 0 cases (each real case moved to a year
drawn uniformly from its +-4 window, so drought carries no signal by construction) and compares four summaries of it:
the mean (the frozen statistic), the median, the mean of z clipped to +-3, and a rank statistic (share of referents
below the case week, ties half; 0.5 under the null). It also repeats the null on 2005-2021 only (full windows) and
prints mid-July mean DSCI by year (a trend check). None of this changes the verdict; it names its cause.
Disclosure: the first run of this script (2026-11-08) also printed the real Trauma and Toxin classes on these
summaries, so a redesign using them is not blind for those two classes. This version computes the null arms only.
"""

import argparse
import datetime as dt
import json
import statistics
from pathlib import Path

from pipeline import e0_dieoffs as e0


def pct(day: dt.date, s: e0.Dsci) -> float | None:
    x = s.value(day)
    refs = []
    for y in range(day.year - e0.YEARS_AROUND, day.year + e0.YEARS_AROUND + 1):
        if y == day.year:
            continue
        r = e0.same_week(day, y)
        v = s.value(r) if r else None
        if v is not None:
            refs.append(v)
    if x is None or len(refs) < 2:
        return None
    return (sum(v < x for v in refs) + 0.5 * sum(v == x for v in refs)) / len(refs)


def summary(cases: list[dict], dsci: dict) -> dict:
    z = [e0.case_z(c["start"], dsci[c["fips"]])[0] for c in cases if c["fips"] in dsci]
    z = [v for v in z if v is not None]
    p = [pct(c["start"], dsci[c["fips"]]) for c in cases if c["fips"] in dsci]
    p = [v for v in p if v is not None]
    return {
        "n": len(z),
        "mean_z": statistics.fmean(z),
        "median_z": statistics.median(z),
        "mean_z_clipped_3": statistics.fmean(max(-3.0, min(3.0, v)) for v in z),
        "share_z_over_5": sum(v > 5 for v in z) / len(z),
        "min_z": min(z),
        "max_z": max(z),
        "rank_n": len(p),
        "rank_mean": statistics.fmean(p),
        "z": sorted(z),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    cases, _ = e0.load_cases(json.loads((a.cache / "whispers_events.json").read_text()))
    cases = [c for c in cases if not c["suspect"]]
    dsci = {
        p.stem.split("_")[1]: e0.Dsci(json.loads(p.read_text()))
        for p in a.cache.glob("dsci_*.json")
    }
    null = e0.planted_cases(cases, dsci, beta=0.0)
    doc = {
        "null_all_years": summary(null, dsci),
        "null_2005_2021": summary(
            [c for c in null if 2005 <= c["start"].year <= 2021], dsci
        ),
        "planted_beta_1": summary(e0.planted_cases(cases, dsci, beta=1.0), dsci),
    }
    years = {}
    for s in dsci.values():
        for y in range(2001, 2026):
            v = s.value(dt.date(y, 7, 15))
            if v is not None:
                years.setdefault(y, []).append(v)
    doc["mid_july_mean_dsci"] = {
        y: round(statistics.fmean(v), 1) for y, v in sorted(years.items())
    }
    a.out.write_text(json.dumps(doc) + "\n")
    for k in ("null_all_years", "null_2005_2021", "planted_beta_1"):
        print(k, {m: round(v, 3) for m, v in doc[k].items() if m != "z"})


if __name__ == "__main__":
    main()
