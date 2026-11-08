"""E0b: WHISPers die-offs x drought with a rank score, after E0 was VOID (docs/analysis/e0b-dieoffs-drought-rank.md).

E0's mean z was pulled up by a 2% tail on zero-inflated DSCI (analysis/e0_null_bias.py). Here each case gets the
mid-rank of its week's DSCI among the same ISO week of the years in its stratum: the case year +-4 (USDM years only),
fixed by the case. u = (stratum years below + half the ties) / (stratum years - 1), centred as s = u - 0.5. If the
case year were any of the stratum's years at random, s would average exactly 0, whatever the DSCI's shape.
Planted cases redraw the year inside the real case's own stratum, so the no-effect plant has that exact null.
Reuses E0's cases, DSCI loader, county bootstrap level and verdict rule unchanged.

Run: python -m pipeline.e0b_rank --cache ~/.cache/wildeye/e0 --out docs/analysis/e0b_dieoffs.json [--planted-only]
"""

import argparse
import datetime as dt
import json
import math
import random
import statistics
from pathlib import Path

from . import e0_dieoffs as e0

MIN_STRATUM = 3  # the case year and at least 2 others


def iso_year(d: dt.date) -> int:
    """The year a stratum is keyed by: ISO, as same_week works in ISO weeks (2019-12-30 is ISO 2020 week 1; keying it
    by its calendar year 2019 scored the week of 2018-12-31 as the case, found 2026-11-08 before the rules froze)."""
    return d.isocalendar().year


def stratum(center: int, day: dt.date, series: e0.Dsci) -> dict[int, float]:
    """DSCI of `day`'s ISO week in each ISO year center-4 .. center+4 that USDM has a map for."""
    out = {}
    for y in range(center - e0.YEARS_AROUND, center + e0.YEARS_AROUND + 1):
        d = e0.same_week(day, y)
        v = series.value(d) if d else None
        if v is not None:
            out[y] = v
    return out


def rank_score(year: int, values: dict[int, float]) -> tuple[float | None, str | None]:
    """s = u - 0.5 for `year` inside its stratum `values`; None with a reason when the stratum says nothing."""
    if year not in values:
        return None, "no_map"
    if len(values) < MIN_STRATUM:
        return None, "few_years"
    x = values[year]
    others = [v for y, v in values.items() if y != year]
    if all(v == x for v in others):
        return None, "stratum_flat"
    u = (sum(v < x for v in others) + 0.5 * sum(v == x for v in others)) / len(others)
    return u - 0.5, None


def case_score(
    c: dict, series: e0.Dsci, shift_weeks: int = 0
) -> tuple[float | None, str | None]:
    """A real case is scored in the stratum centred on its own year; a planted case in its source case's stratum; an
    expected-plant case carries its score already (expected_cases)."""
    if "score" in c and not shift_weeks:
        return c["score"], c.get("score_why")
    day = c["start"] + dt.timedelta(weeks=shift_weeks)
    center = c.get("stratum_year", iso_year(day)) if not shift_weeks else iso_year(day)
    return rank_score(iso_year(day), stratum(center, day, series))


def class_stats(
    cases: list[dict],
    dsci: dict,
    shift_weeks: int = 0,
    k: int = 1,
    draws: int = e0.DRAWS,
    seed: int = e0.SEED,
) -> dict:
    """Mean s per class with a county-bootstrap CI at level 1 - ALPHA / k (E0's resampling, same seed and draws)."""
    by_cls: dict[str, dict[str, list[float]]] = {}
    dropped: dict[str, int] = {}
    for c in cases:
        s = dsci.get(c["fips"])
        if s is None:
            dropped["no_series"] = dropped.get("no_series", 0) + 1
            continue
        v, why = case_score(c, s, shift_weeks)
        if v is None:
            dropped[why] = dropped.get(why, 0) + 1
            continue
        by_cls.setdefault(c["cls"], {}).setdefault(c["fips"], []).append(v)
    rng = random.Random(seed)
    lo_q, hi_q = e0.ALPHA / k / 2, 1 - e0.ALPHA / k / 2
    out = {}
    for cls, counties in sorted(by_cls.items()):
        allv = [v for vs in counties.values() for v in vs]
        keys = sorted(counties)
        boots = []
        for _ in range(draws):
            pick = [counties[keys[rng.randrange(len(keys))]] for _ in keys]
            boots.append(statistics.fmean(v for vs in pick for v in vs))
        boots.sort()
        out[cls] = {
            "cases": len(allv),
            "counties": len(keys),
            "mean_s": statistics.fmean(allv),
            "ci": [boots[int(lo_q * (draws - 1))], boots[int(hi_q * (draws - 1))]],
        }
    return {"classes": out, "dropped": dropped, "level": 1 - e0.ALPHA / k}


def planted_cases(
    cases: list[dict], dsci: dict, beta: float, seed: int = e0.SEED
) -> list[dict]:
    """For each real case, a synthetic one in the same county, ISO week and stratum, its year drawn from the stratum's
    years with probability proportional to exp(beta * DSCI / 100). beta = 0: no effect, s averages 0."""
    rng = random.Random(seed + 1)
    out = []
    for c in cases:
        s = dsci.get(c["fips"])
        if s is None:
            continue
        vals = stratum(iso_year(c["start"]), c["start"], s)
        # every stratum year can be drawn (2000 and 2026 too), so with beta = 0 the drawn year is uniform over the
        # stratum it is scored in, and s averages exactly 0
        opts = [(y, math.exp(beta * v / 100)) for y, v in vals.items()]
        if not opts:
            continue
        u, run = rng.random() * sum(w for _, w in opts), 0.0
        for y, w in opts:
            run += w
            if u <= run:
                d = e0.same_week(c["start"], y)
                out.append(
                    c
                    | {
                        "start": d,
                        "stratum_year": iso_year(c["start"]),
                        "cls": f"planted_beta_{beta:g}",
                    }
                )
                break
    return out


def expected_cases(cases: list[dict], dsci: dict, beta: float) -> list[dict]:
    """The plant without the luck of one draw: each real case scored by the EXPECTED s of a year drawn from its stratum
    with probability proportional to exp(beta * DSCI / 100), i.e. sum(w_y * s_y) / sum(w_y). With beta = 0 this is
    exactly 0 for every case if and only if the scoring is a correct mid-rank (the mean mid-rank over all positions of
    any list is 1/2); one random draw (planted_cases) misses 0 by chance 1 time in 20 at 95%, as it did on the real
    series before the rules were frozen (docs/analysis/e0b-dieoffs-drought-rank.md)."""
    out = []
    for c in cases:
        s = dsci.get(c["fips"])
        if s is None:
            continue
        vals = stratum(iso_year(c["start"]), c["start"], s)
        scored = [(rank_score(y, vals), math.exp(beta * v / 100)) for y, v in vals.items()]
        whys = {why for (sc, why), _ in scored if sc is None}
        if whys or not scored:
            score, why = None, (sorted(whys)[0] if whys else "few_years")
        else:
            # rounded: float residue (1e-17) must not read as an effect when the CI is compared with 0
            score, why = round(sum(sc * w for (sc, _), w in scored) / sum(w for _, w in scored), 12), None
        out.append(c | {"score": score, "score_why": why, "cls": f"expected_beta_{beta:g}"})
    return out


def load(cache: Path) -> tuple[list[dict], list[dict], dict, list[str], int, dict]:
    events = json.loads((cache / "whispers_events.json").read_text())
    cases, why = e0.load_cases(events)
    raw = {
        p.stem.split("_")[1]: json.loads(p.read_text())
        for p in cache.glob("dsci_*.json")
    }
    missing = sorted({c["fips"] for c in cases} - set(raw))
    if missing:
        raise ValueError(
            f"{len(missing)} case counties were never fetched (run e0_dieoffs fetch first): {missing[:10]}"
        )
    dsci = {f: e0.Dsci(rows) for f, rows in raw.items() if rows}
    unmapped = sorted(f for f, rows in raw.items() if not rows)
    confirmed = [c for c in cases if not c["suspect"]]
    suspect = [c for c in cases if c["suspect"]]
    return confirmed, suspect, dsci, unmapped, len(events), why


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument(
        "--planted-only",
        action="store_true",
        help="the two planted arms only: no class is scored",
    )
    a = ap.parse_args(argv)
    confirmed, suspect, dsci, unmapped, n_events, why = load(a.cache)
    on = class_stats(expected_cases(confirmed, dsci, beta=1.0), dsci)
    off = class_stats(expected_cases(confirmed, dsci, beta=0.0), dsci)
    doc = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "rules": "docs/analysis/e0b-dieoffs-drought-rank.md",
        "expected_beta_1": on,
        "expected_beta_0": off,
        # one random draw each, reported beside the gate, never gating
        "planted_draw_beta_1": class_stats(planted_cases(confirmed, dsci, beta=1.0), dsci),
        "planted_draw_beta_0": class_stats(planted_cases(confirmed, dsci, beta=0.0), dsci),
    }
    if not a.planted_only:
        counts = {}
        for c in confirmed:
            counts[c["cls"]] = counts.get(c["cls"], 0) + 1
        k = sum(1 for n in counts.values() if n >= e0.MIN_CASES)
        real = class_stats(confirmed, dsci, k=k)
        placebo = class_stats(confirmed, dsci, shift_weeks=e0.PLACEBO_WEEKS, k=k)
        doc |= {
            "events": n_events,
            "not_cases": why,
            "cases_confirmed": len(confirmed),
            "cases_suspect": len(suspect),
            "class_counts": counts,
            "counties_usdm_never_mapped": unmapped,
            "k": k,
            "real": real,
            "placebo": placebo,
            "suspect_arm": class_stats(suspect, dsci, k=k),
            "verdict": e0.verdict(real, placebo, on, off),
        }
    a.out.write_text(json.dumps(doc, indent=1, default=str) + "\n")
    show = {arm: doc[arm]["classes"] for arm in ("expected_beta_1", "expected_beta_0", "planted_draw_beta_1", "planted_draw_beta_0")}
    if "verdict" in doc:
        show["verdict"] = {
            key: doc["verdict"][key]
            for key in ("status", "planted_ok", "trauma_ok", "findings", "tested")
        }
    print(json.dumps(show, indent=1))


if __name__ == "__main__":
    main()
