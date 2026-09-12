"""CDC NNDSS weekly arboviral disease cases by state (polygon contract) →
public/data/arbonet.geojson.

Gap layer "arbonet" (docs/superpowers/plans/2026-09-12-gap-layer-builder-brief.md). ArboNET
is the CDC/state arboviral surveillance system; its county-level "Disease Maps" app
(wwwn.cdc.gov/arbonet/maps/ADB_Diseases_Map/) answered 404 on 2026-09-12 and the CDC West
Nile pages carry no CSV, so the scriptable, weekly, public source is the NNDSS Weekly Data
dataset on data.cdc.gov (`x9gk-5huc`, "NNDSS Weekly Data", Office of Public Health Data,
Surveillance, and Technology, CDC), which republishes ArboNET-fed case counts per reporting
area and MMWR week for West Nile, Eastern equine encephalitis, La Crosse, St. Louis
encephalitis, Powassan, Jamestown Canyon and dengue. State level only (county is not public).

The weekly bin is NOT the dataset's "current week" column: arboviral cases are back-filled
into the cumulative year-to-date column (`m3`) weeks after the report they first appear in
(Texas WNV 2026 week 33: m1 = 5 while m3 rose 31→45). So each bin is the change in the
cumulative YTD count between consecutive weekly reports — "cases added to the year's tally in
that week's report" — with the "-" flag (no reported cases) read as 0 and the U/N/NN/NP flags
(unavailable / not reportable / not published) read as no data. Downward revisions are kept
at 0 and counted in `counts.revised_down`. New York City reports separately from New York
State and is merged into it. State polygons are the Census 2021 cartographic boundary file
(1:20m, U.S. Government work) read with pyshp, like the county file in wastewater.py.
"""

from __future__ import annotations
import argparse
import collections
import datetime as dt
import io
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("arbonet")
SOCRATA = "https://data.cdc.gov/resource/x9gk-5huc.json"
DATASET_URL = "https://data.cdc.gov/NNDSS/NNDSS-Weekly-Data/x9gk-5huc"
CENSUS_STATE_ZIP = (
    "https://www2.census.gov/geo/tiger/GENZ2021/shp/cb_2021_us_state_20m.zip"
)
UA = "wildeye (github.com/musharna/wildeye)"
PAGE = 50000
DEFAULT_WEEKS = 26
SLEEP = 2.0
LICENCE = "Public Domain U.S. Government (CDC; no licence field on x9gk-5huc, CDC Use of Agency Materials)"
NOTE = (
    "Provisional counts as published each week; cases are back-filled into the year-to-date column, so a "
    "week's bin is the change in that column between reports, not onset dates. Reference to CDC data does "
    "not imply endorsement by CDC, HHS or the U.S. Government."
)
# NNDSS label (whitespace-normalised) → chip key, short name, vector
DISEASES = {
    "Arboviral diseases, West Nile virus disease": ("wnv", "West Nile", "mosquito"),
    "Arboviral diseases, Eastern equine encephalitis virus disease": (
        "eee",
        "Eastern equine encephalitis",
        "mosquito",
    ),
    "Arboviral diseases, La Crosse virus disease": ("lac", "La Crosse", "mosquito"),
    "Arboviral diseases, St. Louis encephalitis virus disease": (
        "sle",
        "St. Louis encephalitis",
        "mosquito",
    ),
    "Arboviral diseases, Jamestown Canyon virus disease": (
        "jcv",
        "Jamestown Canyon",
        "mosquito",
    ),
    "Arboviral diseases, Powassan virus disease": ("pow", "Powassan", "tick"),
    "Dengue virus infections, Dengue": ("den", "Dengue", "mosquito"),
    # NNDSS tallies severe dengue on its own row; the chip counts both
    "Dengue virus infections, Severe dengue": ("den", "Dengue", "mosquito"),
}
# Server-side filter is by label PREFIX: the live labels for La Crosse and Jamestown Canyon carry a
# double space ("La Crosse  virus disease"), so an exact `label in (...)` list silently returns 0
# rows for them (probed 2026-09-12). Rows are matched to DISEASES after whitespace normalisation;
# the other arboviral rows (chikungunya, WEE) are counted as `unknown_label` and dropped.
LABEL_PREFIXES = ("Arboviral diseases,", "Dengue virus infections,")
NO_DATA_FLAGS = {"U", "N", "NN", "NP", "NC"}
AGGREGATES = {
    "U.S. Residents",
    "Non-U.S. Residents",
    "Total",
    "U.S. Territories",
    "New England",
    "Middle Atlantic",
    "East North Central",
    "West North Central",
    "South Atlantic",
    "East South Central",
    "West South Central",
    "Mountain",
    "Pacific",
}
MERGE = {"New York City": "New York"}
RETRIES = 4


def norm_label(s: str) -> str:
    return " ".join((s or "").split())


def _get_json(
    url: str, timeout: int = 300, retries: int = RETRIES, sleep=time.sleep
) -> list:
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/json"}
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == retries - 1:
                raise
            log.warning(
                "HTTP %d from %s, retry %d/%d",
                e.code,
                url[:120],
                attempt + 1,
                retries - 1,
            )
            sleep(15 * 2**attempt)
    raise AssertionError("unreachable")


def mmwr_week_end(year: int, week: int) -> dt.date:
    """Saturday ending MMWR week `week` of `year` (week 1 contains 4 January)."""
    jan4 = dt.date(year, 1, 4)
    w1 = jan4 + dt.timedelta(days=(5 - jan4.weekday()) % 7)
    return w1 + dt.timedelta(days=7 * (week - 1))


def mmwr_year_week(d: dt.date) -> tuple[int, int]:
    """(year, week) of the MMWR week containing `d`."""
    for y in (d.year + 1, d.year, d.year - 1):
        end1 = mmwr_week_end(y, 1)
        if d >= end1 - dt.timedelta(days=6):
            return y, (d - (end1 - dt.timedelta(days=6))).days // 7 + 1
    raise AssertionError("unreachable")


def diseases_meta() -> dict:
    """chip key → {name, vector, labels[]} (one key may gather several NNDSS rows)."""
    out: dict = {}
    for lbl, (k, n, v) in DISEASES.items():
        out.setdefault(k, {"name": n, "vector": v, "labels": []})["labels"].append(lbl)
    return out


def fetch_rows(
    year: int, min_week: int, fetch=_get_json, sleep: float = SLEEP
) -> list[dict]:
    """Every row for the tracked diseases in `year` with week >= min_week (Socrata paging)."""
    prefixes = " OR ".join(
        "starts_with(label, '" + k.replace("'", "''") + "')" for k in LABEL_PREFIXES
    )
    where = f"year='{year}' AND week::number >= {min_week} AND ({prefixes})"
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode(
            {"$where": where, "$limit": PAGE, "$offset": offset, "$order": "sort_order"}
        )
        rows = fetch(f"{SOCRATA}?{q}")
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        offset += PAGE
        time.sleep(sleep)


def _count(v, flag) -> int | None:
    if flag in NO_DATA_FLAGS:
        return None
    if v in (None, ""):
        return 0  # "-" flag or unset: no reported cases
    return int(float(v))


def weekly_new(rows: list[dict]) -> tuple[dict, dict]:
    """(state → disease → {(year, week): {'new', 'ytd', 'prev'}}, counts). `new` is the change in
    the cumulative YTD count between consecutive reports; NYC merged into New York."""
    cum: dict = collections.defaultdict(lambda: collections.defaultdict(dict))
    counts = collections.Counter()
    for r in rows:
        key = DISEASES.get(norm_label(r.get("label")))
        if not key:
            counts["unknown_label"] += 1
            continue
        state = r.get("states")
        if state in AGGREGATES:
            counts["aggregate_rows"] += 1
            continue
        state = MERGE.get(state, state)
        yw = (int(r["year"]), int(r["week"]))
        c = _count(r.get("m3"), r.get("m3_flag"))
        p = _count(r.get("m4"), r.get("m4_flag"))
        cell = cum[state][key[0]].setdefault(yw, {"ytd": None, "prev": None})
        if c is not None:
            cell["ytd"] = (cell["ytd"] or 0) + c
        if p is not None:
            cell["prev"] = (cell["prev"] or 0) + p
        counts["rows"] += 1
    out: dict = {}
    for state, dis in cum.items():
        for d, series in dis.items():
            last_year, last_cum = None, 0
            for yw in sorted(series):
                cell = series[yw]
                if cell["ytd"] is None:
                    counts["no_data_cells"] += 1
                    continue
                base = last_cum if last_year == yw[0] else 0
                new = cell["ytd"] - base
                if new < 0:
                    counts["revised_down"] += 1
                    new = 0
                out.setdefault(state, {}).setdefault(d, {})[yw] = {
                    "new": new,
                    "ytd": cell["ytd"],
                    "prev": cell["prev"],
                }
                last_year, last_cum = yw[0], cell["ytd"]
    counts["states"] = len(out)
    return out, dict(counts)


def state_index(weekly: dict, today: dt.date, weeks: int) -> tuple[dict, list[str]]:
    """state → {n, by, ytd, prev_ytd, weeks:[{w, n:{dis: k}}]} over the `weeks` MMWR weeks ending
    at or before today; only weeks with ≥1 new case are listed. Returns (index, week ends)."""
    y, w = mmwr_year_week(today)
    ends = []
    for i in range(weeks):
        ends.append(mmwr_week_end(y, w))
        y, w = (
            (y, w - 1) if w > 1 else (y - 1, mmwr_year_week(dt.date(y - 1, 12, 28))[1])
        )
    wanted = {e: i for i, e in enumerate(ends)}
    out = {}
    for state, dis in weekly.items():
        bins: dict[dt.date, dict] = {}
        by, ytd, prev = collections.Counter(), {}, {}
        latest_yw = None
        for d, series in dis.items():
            for yw, cell in series.items():
                e = mmwr_week_end(*yw)
                if e not in wanted:
                    continue
                if cell["new"]:
                    bins.setdefault(e, {})[d] = cell["new"]
                    by[d] += cell["new"]
                if latest_yw is None or yw > latest_yw:
                    latest_yw = yw
        for d, series in dis.items():
            # each disease's own newest report at or before the window's newest week
            own = [yw for yw in series if latest_yw and yw <= latest_yw]
            cell = series[max(own)] if own else None
            if cell:
                ytd[d] = cell["ytd"]
                if cell["prev"] is not None:
                    prev[d] = cell["prev"]
        if not by:
            continue
        out[state] = {
            "n": sum(by.values()),
            "by": dict(by),
            "ytd": ytd,
            "prev_ytd": prev,
            "asof": mmwr_week_end(*latest_yw).isoformat(),
            "weeks": [
                {"w": e.isoformat(), "n": bins[e]} for e in sorted(bins, reverse=True)
            ],
        }
    return out, [e.isoformat() for e in ends]


def load_state_shapes(zip_path: Path, fetch_bytes=None) -> dict[str, dict]:
    """state NAME → {fips, st, geometry} from the Census 1:20m state boundary zip (cached)."""
    import shapefile  # pyshp

    if not zip_path.exists():
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        data = (
            fetch_bytes(CENSUS_STATE_ZIP)
            if fetch_bytes
            else urllib.request.urlopen(
                urllib.request.Request(CENSUS_STATE_ZIP, headers={"User-Agent": UA}),
                timeout=120,
            ).read()
        )
        zip_path.write_bytes(data)
    z = zipfile.ZipFile(zip_path)
    base = next(n for n in z.namelist() if n.endswith(".shp"))[:-4]
    rd = shapefile.Reader(
        shp=io.BytesIO(z.read(base + ".shp")),
        dbf=io.BytesIO(z.read(base + ".dbf")),
        shx=io.BytesIO(z.read(base + ".shx")),
    )

    def rnd(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], 3), round(c[1], 3)]
        return [rnd(x) for x in c]

    out = {}
    for sr in rd.iterShapeRecords():
        rec = sr.record.as_dict()
        g = sr.shape.__geo_interface__
        out[rec["NAME"]] = {
            "fips": rec["GEOID"],
            "st": rec["STUSPS"],
            "geometry": {"type": g["type"], "coordinates": rnd(g["coordinates"])},
        }
    return out


EMPTY_STATE = {"n": 0, "by": {}, "ytd": {}, "prev_ytd": {}, "asof": None, "weeks": []}


def to_features(states: dict, shapes: dict) -> tuple[list[dict], list[str]]:
    """One feature per state SHAPE: a state with no cases in the window is drawn grey ("no cases"),
    not left as bare imagery (AK, MT, VT, WV vanished that way on 2026-09-12). `missing` lists
    indexed states that have no shape."""
    feats = []
    missing = sorted(n for n in states if n not in shapes)
    for name in sorted(shapes):
        sh = shapes[name]
        feats.append(
            {
                "type": "Feature",
                "geometry": sh["geometry"],
                "properties": {
                    "fips": sh["fips"],
                    "name": name,
                    "st": sh["st"],
                    **(states.get(name) or EMPTY_STATE),
                },
            }
        )
    return feats, missing


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/arbonet.geojson"))
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        ),
    )
    ap.add_argument("--today", default=None)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    y, w = mmwr_year_week(today)
    first = today - dt.timedelta(days=7 * a.weeks)
    fy, fw = mmwr_year_week(first)
    rows = []
    for year in range(fy, y + 1):
        rows.extend(
            fetch_rows(year, fw - 1 if year == fy else 1)
        )  # one week earlier: the diff base
        time.sleep(SLEEP)
    weekly, counts = weekly_new(rows)
    states, ends = state_index(weekly, today, a.weeks)
    log.info(
        "%d rows → %d states with cases in the window, counts=%s",
        len(rows),
        len(states),
        counts,
    )
    shapes = load_state_shapes(a.cache / "cb_2021_us_state_20m.zip")
    feats, missing = to_features(states, shapes)
    if missing:
        log.warning(
            "%d reporting areas without a Census state shape: %s", len(missing), missing
        )
    # every shape is a feature now, so the empty-run guard must look at the index, not the features
    if not states:
        raise SystemExit("no states with cases")
    newest = max((f["properties"]["asof"] for f in feats if f["properties"]["asof"]), default=None)
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {
                "id": "arbonet",
                "name": "CDC NNDSS weekly arboviral disease cases (ArboNET)",
                "url": DATASET_URL,
                "dataset": "data.cdc.gov x9gk-5huc",
                "api": SOCRATA,
                "licence": LICENCE,
                "note": NOTE,
                "shapes": "Census 2021 cartographic boundary states 1:20m (U.S. Government work)",
            },
            "diseases": diseases_meta(),
            "today": today.isoformat(),
            "newest": newest,
            "weeks": ends,
            "counts": {
                **counts,
                "raw": len(rows),
                "features": len(feats),
                "missing_shape": len(missing),
                "cases": sum(f["properties"]["n"] for f in feats),
            },
            "features": feats,
        },
    )
    log.info(
        "wrote %s: %d states, newest report week %s (%.0f s)",
        a.out,
        len(feats),
        newest,
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
