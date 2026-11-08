"""E0: do wildlife die-offs follow drought, cause by cause? Rules: docs/analysis/e0-dieoffs-drought.md (commit
cb4c76ad3, written before any event was joined to drought).

Time-stratified case-crossover: a WHISPers die-off (one county, confirmed major diagnosis) is a case; its exposure is
the county's U.S. Drought Monitor DSCI on the map on or before the start date; its referents are the same county's
DSCI on the same ISO week in the years within +-4 of the event year. z = (case - mean referents) / SD referents; the
statistic per WHISPers diagnosis type is the mean z, with a county-bootstrap CI at the Bonferroni level. Controls:
planted truth (synthetic cases on the real DSCI), a +26-week placebo, and Trauma as the negative-control cause.

Commands: `fetch` caches WHISPers events and each case county's DSCI series; `run` computes everything from the
caches and writes the verdict JSON."""

from __future__ import annotations

import argparse
import bisect
import datetime as dt
import json
import random
import statistics
import time
import urllib.request
from pathlib import Path

from . import whispers
from .net import urlopen

FIRST, LAST = dt.date(2001, 1, 1), dt.date(2025, 12, 31)
YEARS_AROUND = 4
MIN_CASES = 50
DRAWS, SEED, ALPHA = 2000, 20261107, 0.05
PLACEBO_WEEKS = 26
MAP_MAX_AGE_DAYS = 7
NEGATIVE_CONTROL = "Trauma"
US_COUNTRY = 30  # WHISPers /api/countries/: 30 United States, 7 Canada, 19 Mexico (read 2026-11-07)
USDM = "https://usdmdataservices.unl.edu/api/CountyStatistics/GetDSCI"


# --- cases -------------------------------------------------------------------------------------------------


def major_diagnosis(e: dict) -> dict | None:
    """The event's major diagnosis (`major` true), else its priority-1 diagnosis; None if it has neither."""
    ds = e.get("eventdiagnoses") or []
    return next((d for d in ds if d.get("major")), None) or next(
        (d for d in ds if d.get("priority") == 1), None
    )


def to_case(e: dict) -> tuple[dict | None, str | None]:
    """(case, None) or (None, why it is not one). A case: {id, fips, start, cls, suspect}."""
    if e.get("event_type_string") != "Mortality/Morbidity":
        return None, "not_mortality"
    if not e.get("start_date"):
        return None, "no_start"
    start = dt.date.fromisoformat(e["start_date"])
    if not FIRST <= start <= LAST:
        return None, "outside_years"
    # US counties only (WHISPers country 30). Canadian census divisions sit in the same field as 4-digit codes
    # ("1005 " = a Newfoundland division, 2026-11-07): padded, they would read as US counties (01005 Barbour, AL).
    levels = e.get("administrativelevelones") or []
    if not levels or any(lv.get("country") != US_COUNTRY for lv in levels):
        return None, "not_us"
    fips = sorted(
        {
            str(a["fips_code"]).strip().zfill(5)
            for a in e.get("administrativeleveltwos") or []
            if str(a.get("fips_code") or "").strip()
        }
    )
    if not fips:
        return None, "no_county"
    if len(fips) > 1:
        return None, "multi_county"
    if not (len(fips[0]) == 5 and fips[0].isdigit()):
        return None, "bad_fips"
    d = major_diagnosis(e)
    if d is None or not d.get("diagnosis_type_string"):
        return None, "no_diagnosis"
    return {
        "id": e["id"],
        "fips": fips[0],
        "start": start,
        "cls": d["diagnosis_type_string"],
        "suspect": bool(d.get("suspect")),
    }, None


# --- drought ---------------------------------------------------------------------------------------------


class Dsci:
    """One county's weekly DSCI maps; value(d) = the map on or before d, if it is at most a week old."""

    def __init__(self, rows: list[dict]):
        pts = sorted(
            (dt.date.fromisoformat(r["mapDate"][:10]), float(r["dsci"]))
            for r in rows
            if r.get("dsci") is not None
        )
        self.days = [d for d, _ in pts]
        self.vals = [v for _, v in pts]

    def value(self, d: dt.date) -> float | None:
        i = bisect.bisect_right(self.days, d) - 1
        if i < 0 or (d - self.days[i]).days > MAP_MAX_AGE_DAYS:
            return None
        return self.vals[i]


def same_week(d: dt.date, year: int) -> dt.date | None:
    y, w, wd = d.isocalendar()
    try:
        return dt.date.fromisocalendar(year, w, wd)
    except ValueError:  # week 53 in a year that has 52
        return None


def case_z(day: dt.date, series: Dsci) -> tuple[float | None, str | None]:
    """z of `day` against the same ISO week in the years within +-YEARS_AROUND (not its own)."""
    x = series.value(day)
    if x is None:
        return None, "no_map"
    refs = []
    for y in range(day.year - YEARS_AROUND, day.year + YEARS_AROUND + 1):
        if y == day.year:
            continue
        r = same_week(day, y)
        v = series.value(r) if r else None
        if v is not None:
            refs.append(v)
    if len(refs) < 2:
        return None, "few_referents"
    sd = statistics.pstdev(refs)
    if sd == 0:
        return None, "referents_flat"
    return (x - statistics.fmean(refs)) / sd, None


def class_stats(
    cases: list[dict],
    dsci: dict[str, Dsci],
    shift_weeks: int = 0,
    k: int = 1,
    draws: int = DRAWS,
    seed: int = SEED,
) -> dict:
    """Mean z per class with a county-bootstrap CI at level 1 - ALPHA / k. shift_weeks moves every case (placebo)."""
    by_cls: dict[str, dict[str, list[float]]] = {}
    dropped: dict[str, int] = {}
    for c in cases:
        s = dsci.get(c["fips"])
        if s is None:
            dropped["no_series"] = dropped.get("no_series", 0) + 1
            continue
        z, why = case_z(c["start"] + dt.timedelta(weeks=shift_weeks), s)
        if z is None:
            dropped[why] = dropped.get(why, 0) + 1
            continue
        by_cls.setdefault(c["cls"], {}).setdefault(c["fips"], []).append(z)
    rng = random.Random(seed)
    lo_q, hi_q = ALPHA / k / 2, 1 - ALPHA / k / 2
    out = {}
    for cls, counties in sorted(by_cls.items()):
        allz = [z for zs in counties.values() for z in zs]
        keys = sorted(counties)
        boots = []
        for _ in range(draws):
            pick = [counties[keys[rng.randrange(len(keys))]] for _ in keys]
            flat = [z for zs in pick for z in zs]
            boots.append(statistics.fmean(flat))
        boots.sort()
        out[cls] = {
            "cases": len(allz),
            "counties": len(keys),
            "mean_z": statistics.fmean(allz),
            "ci": [boots[int(lo_q * (draws - 1))], boots[int(hi_q * (draws - 1))]],
        }
    return {"classes": out, "dropped": dropped, "level": 1 - ALPHA / k}


def excludes_zero(ci: list[float]) -> bool:
    return ci[0] > 0 or ci[1] < 0


# --- planted truth -----------------------------------------------------------------------------------------


def planted_cases(
    cases: list[dict], dsci: dict[str, Dsci], beta: float, seed: int = SEED
) -> list[dict]:
    """For each real case, a synthetic one in the same county and ISO week whose year (within +-YEARS_AROUND) is drawn
    with probability proportional to exp(beta * DSCI / 100). beta = 0 draws the year independently of drought."""
    import math

    rng = random.Random(seed + 1)
    out = []
    for c in cases:
        s = dsci.get(c["fips"])
        if s is None:
            continue
        opts = []
        for y in range(
            c["start"].year - YEARS_AROUND, c["start"].year + YEARS_AROUND + 1
        ):
            d = same_week(c["start"], y)
            v = s.value(d) if d else None
            if v is not None and FIRST <= d <= LAST:
                opts.append((d, math.exp(beta * v / 100)))
        if not opts:
            continue
        tot = sum(w for _, w in opts)
        u, run = rng.random() * tot, 0.0
        for d, w in opts:
            run += w
            if u <= run:
                out.append(c | {"start": d, "cls": f"planted_beta_{beta:g}"})
                break
    return out


# --- verdict ------------------------------------------------------------------------------------------------


def verdict(real: dict, placebo: dict, planted_on: dict, planted_off: dict) -> dict:
    tested = {c: r for c, r in real["classes"].items() if r["cases"] >= MIN_CASES}
    on = next(iter(planted_on["classes"].values()))
    off = next(iter(planted_off["classes"].values()))
    planted_ok = on["ci"][0] > 0 and not excludes_zero(off["ci"])
    trauma = tested.get(NEGATIVE_CONTROL)
    trauma_ok = trauma is not None and not excludes_zero(trauma["ci"])
    per = {}
    for c, r in tested.items():
        p = placebo["classes"].get(c)
        per[c] = {
            "real": r,
            "placebo": p,
            "finding": c != NEGATIVE_CONTROL
            and excludes_zero(r["ci"])
            and p is not None
            and not excludes_zero(p["ci"])
            and planted_ok
            and trauma_ok,
        }
    status = "CLOSED" if planted_ok and trauma_ok else "VOID"
    return {
        "status": status,
        "planted_ok": planted_ok,
        "trauma_ok": trauma_ok,
        "tested": sorted(tested),
        "findings": sorted(c for c, v in per.items() if v["finding"]),
        "per_class": per,
    }


# --- io --------------------------------------------------------------------------------------------------------


def _read_json(req):
    with urlopen(req, timeout=120) as r:
        return json.load(r)


def _with_retries(call, what: str, tries: int = 6, wait: float = 5.0, sleep=time.sleep):
    """call() with up to `tries` attempts on a network error (this laptop's route drops for seconds at a time:
    'Network is unreachable', 2026-11-07), waits doubling from `wait`; the last error is raised with `what`.
    An HTTP error status is an answer, not a dropped route, and is raised at once."""
    import urllib.error

    for k in range(tries):
        try:
            return call()
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if k == tries - 1:
                raise RuntimeError(f"{what}: {tries} tries failed, last: {e!r}") from e
            sleep(wait * 2**k)


def fetch_dsci(fips: str, cache: Path, sleep: float = 1.0) -> list[dict]:
    f = cache / f"dsci_{fips}.json"
    if not f.exists():
        url = f"{USDM}?aoi={fips}&startdate=1/1/2000&enddate=6/30/2026&statisticsType=1"
        req = urllib.request.Request(
            url, headers={"User-Agent": whispers.UA, "Accept": "application/json"}
        )
        body = _with_retries(lambda: _read_json(req), what=f"USDM {fips}")
        if not isinstance(body, list):
            raise ValueError(f"USDM gave no DSCI list for {fips}: {str(body)[:200]}")
        # [] is a real answer: a FIPS USDM never mapped (e.g. 02261 Valdez-Cordova, split in 2019). It is cached
        # as such; the run counts its cases under dropped.no_series and lists the county, never substitutes one.
        f.write_text(json.dumps(body))
        time.sleep(sleep)
    return json.loads(f.read_text())


def load_cases(events: list[dict]) -> tuple[list[dict], dict]:
    cases, why = [], {}
    for e in events:
        c, w = to_case(e)
        if c is None:
            why[w] = why.get(w, 0) + 1
        else:
            cases.append(c)
    return cases, why


def cmd_fetch(a):
    from . import dns_memo

    dns_memo.install()  # ~1,900 requests to two hosts; this host's resolver drops out (dns_memo docstring)
    a.cache.mkdir(parents=True, exist_ok=True)
    ev = a.cache / "whispers_events.json"
    if not ev.exists():
        events = whispers.fetch_events(FIRST, max_pages=80)
        ev.write_text(json.dumps(events))
    events = json.loads(ev.read_text())
    cases, why = load_cases(events)
    counties = sorted({c["fips"] for c in cases})
    print(
        f"{len(events)} events, {len(cases)} cases in {len(counties)} counties; not cases: {why}",
        flush=True,
    )
    for i, f in enumerate(counties):
        fetch_dsci(f, a.cache)
        if i % 100 == 0:
            print(f"dsci {i + 1}/{len(counties)}", flush=True)


def cmd_run(a):
    events = json.loads((a.cache / "whispers_events.json").read_text())
    cases, why = load_cases(events)
    confirmed = [c for c in cases if not c["suspect"]]
    suspect = [c for c in cases if c["suspect"]]
    raw = {
        p.stem.split("_")[1]: json.loads(p.read_text())
        for p in a.cache.glob("dsci_*.json")
    }
    unmapped = sorted(f for f, rows in raw.items() if not rows)
    dsci = {f: Dsci(rows) for f, rows in raw.items() if rows}
    missing = sorted({c["fips"] for c in cases} - set(raw))
    if missing:
        raise ValueError(
            f"{len(missing)} case counties were never fetched (run fetch first): {missing[:10]}"
        )
    counts = {}
    for c in confirmed:
        counts[c["cls"]] = counts.get(c["cls"], 0) + 1
    k = sum(1 for n in counts.values() if n >= MIN_CASES)
    real = class_stats(confirmed, dsci, k=k)
    placebo = class_stats(confirmed, dsci, shift_weeks=PLACEBO_WEEKS, k=k)
    on = class_stats(planted_cases(confirmed, dsci, beta=1.0), dsci)
    off = class_stats(planted_cases(confirmed, dsci, beta=0.0), dsci)
    doc = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "rules": "docs/analysis/e0-dieoffs-drought.md",
        "events": len(events),
        "not_cases": why,
        "cases_confirmed": len(confirmed),
        "cases_suspect": len(suspect),
        "class_counts": counts,
        "counties_usdm_never_mapped": unmapped,
        "k": k,
        "real": real,
        "placebo": placebo,
        "planted_beta_1": on,
        "planted_beta_0": off,
        "suspect_arm": class_stats(suspect, dsci, k=k),
        "verdict": verdict(real, placebo, on, off),
    }
    a.out.write_text(json.dumps(doc, indent=1, default=str) + "\n")
    v = doc["verdict"]
    print(
        json.dumps(
            {
                "status": v["status"],
                "planted_ok": v["planted_ok"],
                "trauma_ok": v["trauma_ok"],
                "findings": v["findings"],
                "tested": v["tested"],
                "k": k,
            },
            indent=1,
        )
    )


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("fetch", "run"))
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    (cmd_fetch if a.cmd == "fetch" else cmd_run)(a)


if __name__ == "__main__":
    main()
