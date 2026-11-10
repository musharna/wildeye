"""A feasibility counts: APHIS HPAI wild-bird detections near the 20 wildeye radars, by fall season and week.

What it does: fetches the APHIS wild-bird detection CSV (pipeline/hpai.fetch_csv) and the Census 2021 county
gazetteer into --cache, matches each detection's (state, county) to a county as pipeline/hpai.py does, places the
county at its gazetteer internal point, and counts free-living (not captive) detections whose county lies within
150 km of each radar in pipeline/sites.json, by collection date, per fall (Aug 1 - Dec 31) and per 7-day bin from
Aug 1, split by sampling method.
When to reach for it: to re-check the outcome counts in docs/analysis/a-hpai-radar.md against newer data.
Output: tables on stdout. No radar data is read, so it says nothing about migration.
Check: every row is accounted for (kept + each drop reason = CSV rows), or it raises; an unknown sampling method
raises rather than falling into no class.
"""

import argparse
import collections
import datetime as dt
import io
import json
import math
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline.hpai import _norm, fetch_csv, parse_rows

GAZ_NAME = "2021_Gaz_counties_national.txt"
R_KM = 150
YEARS = range(2021, 2027)
OUTCOME_YEARS = range(
    2022, 2026
)  # the primary test's outcome falls (docs/analysis/a-hpai-radar.md)
MIN_WEEKS = 3
METHODS = {
    "morbidity/mortality": "mm",
    "hunter harvest": "hunter",
    "live bird": "live",
    "agency harvest": "agency",
}
SITES = json.loads(
    (Path(__file__).resolve().parent.parent / "pipeline" / "sites.json").read_text()
)
STATES = {  # gazetteer USPS code -> state name as APHIS writes it
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "DC": "District of Columbia",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
    "PR": "Puerto Rico",
}


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    (la1, lo1), (la2, lo2) = [(math.radians(x), math.radians(y)) for x, y in (a, b)]
    h = (
        math.sin((la2 - la1) / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def fall_week(day: dt.date) -> tuple[int, int] | None:
    """(year, 7-day bin from Aug 1) for a day in Aug 1 - Dec 31, else None. Bin 21 is Dec 26-31 (6 days)."""
    start = dt.date(day.year, 8, 1)
    if not start <= day <= dt.date(day.year, 12, 31):
        return None
    return day.year, (day - start).days // 7


def gazetteer(zip_path: Path) -> dict[tuple[str, str], tuple[float, float]]:
    """(normalised state name, normalised county name) -> internal point, the key pipeline/hpai.py matches on."""
    with zipfile.ZipFile(zip_path) as z, z.open(GAZ_NAME) as f:
        lines = io.TextIOWrapper(f, encoding="latin-1").read().splitlines()
    head = [h.strip() for h in lines[0].split("\t")]
    out = {}
    for line in lines[1:]:
        r = dict(zip(head, [x.strip() for x in line.split("\t")]))
        st = STATES.get(r["USPS"])
        if st is None:
            continue
        out[(_norm(st), _norm(r["NAME"]))] = (
            float(r["INTPTLAT"]),
            float(r["INTPTLONG"]),
        )
    return out


def count(
    rows: list[dict], places: dict, radars: list[dict], today: dt.date
) -> tuple[dict, collections.Counter]:
    """{radar: {year: {method: Counter(week)}}} and the drop reasons. A row collected after `today` (the run date)
    is a data error and is dropped. A detection counts for every radar within
    R_KM of its county."""
    out: dict = {
        r["id"]: {y: collections.defaultdict(collections.Counter) for y in YEARS}
        for r in radars
    }
    why = collections.Counter()
    cw: dict[tuple, set] = {}
    for r in rows:
        if r["captive"]:
            why["captive"] += 1
            continue
        if r["method"] not in METHODS:
            raise ValueError(
                f"sampling method {r['method']!r} is not one of {sorted(METHODS)}"
            )
        if r["collected"] is None:
            why["no_collection_date"] += 1
            continue
        if r["collected"] > today:
            why["collected_after_run_date"] += 1
            continue
        fw = fall_week(r["collected"])
        if fw is None or fw[0] not in YEARS:
            why["outside_falls"] += 1
            continue
        p = places.get((_norm(r["state"]), _norm(r["county"])))
        if p is None:
            why["unplaced_county"] += 1
            continue
        near = [s["id"] for s in radars if km(p, (s["lat"], s["lon"])) <= R_KM]
        if not near:
            why["no_radar_within_150km"] += 1
            continue
        why["kept"] += 1
        county = (_norm(r["state"]), _norm(r["county"]))
        for sid in near:
            out[sid][fw[0]][METHODS[r["method"]]][fw[1]] += 1
            cw.setdefault((sid, fw[0], METHODS[r["method"]]), set()).add(
                (county, fw[1])
            )
    for (sid, y, m), pairs in cw.items():  # county-weeks: distinct counties per week
        out[sid][y][m + "_cw"] = collections.Counter(w for _, w in pairs)
    return out, why


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument(
        "--gaz",
        type=Path,
        required=True,
        help="2021 county gazetteer zip (B's cache has one)",
    )
    ap.add_argument("--refresh", action="store_true", help="fetch the APHIS CSV again")
    ap.add_argument("--today", type=dt.date.fromisoformat, default=dt.date.today())
    a = ap.parse_args(argv)
    a.cache.mkdir(parents=True, exist_ok=True)
    csv_path = a.cache / "hpai-wild-birds.csv"
    if a.refresh or not csv_path.exists():
        csv_path.write_text(fetch_csv(), encoding="utf-8")
    fetched = dt.datetime.fromtimestamp(csv_path.stat().st_mtime)
    print(
        f"APHIS CSV fetched {fetched:%Y-%m-%d %H:%M} local ({csv_path}; --refresh to fetch again)"
    )
    rows, pc = parse_rows(csv_path.read_text(encoding="utf-8"))
    out, why = count(rows, gazetteer(a.gaz), SITES, a.today)
    accounted = sum(why.values()) + pc.get("no_date", 0)
    if accounted != pc["rows"]:
        raise RuntimeError(
            f"{accounted} rows accounted for of {pc['rows']} in {csv_path}: {dict(why)} {pc}"
        )
    newest = max((r["collected"] for r in rows if r["collected"]), default=None)
    print(
        f"csv rows {pc['rows']}, no detection date {pc.get('no_date', 0)}, newest collection {newest}"
    )
    print("drops:", dict(why))
    for m in ("mm", "mm_cw", "hunter"):
        print(f"\n{m}: detections (weeks with >=1) per radar x fall")
        print("radar " + " ".join(f"{y:>10}" for y in YEARS))
        for sid in out:
            cells = []
            for y in YEARS:
                c = out[sid][y][m]
                cells.append(f"{sum(c.values()):>5} ({len(c):>2})")
            print(f"{sid}  " + " ".join(cells))
        tot = [sum(sum(out[s][y][m].values()) for s in out) for y in YEARS]
        print("sum   " + " ".join(f"{t:>10}" for t in tot))
    inc = {
        y: [s for s in out if len(out[s][y]["mm"]) >= MIN_WEEKS] for y in OUTCOME_YEARS
    }
    print(f"\nincluded radar-seasons (>= {MIN_WEEKS} weeks with an M/M detection):")
    for y, ids in inc.items():
        print(f"  {y}: {len(ids)} {' '.join(ids)}")
    print(f"  total {sum(len(v) for v in inc.values())}")
    print(
        "  radars in no included season:",
        [s for s in out if not any(s in v for v in inc.values())],
    )
    weekly = collections.Counter()
    for s in out:
        for y in OUTCOME_YEARS:
            weekly.update(out[s][y]["mm_cw"])
    print(
        "pooled M/M county-weeks by bin (radar-assignments):",
        [weekly[w] for w in range(22)],
    )


if __name__ == "__main__":
    main()
