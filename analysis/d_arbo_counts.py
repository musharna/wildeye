"""D feasibility counts: human West Nile (WNV) and EEE cases near the 20 wildeye radars, by year.

What it does: fetches CDC ArboNET county x year and month-of-onset files (Internet Archive captures of
www.cdc.gov/wcms/vizdata/live/ncezid_dvbd/, each pinned by sha256: www.cdc.gov answered 403 to this network on
2026-11-19), the Census 2021 and 2024 county gazetteers, and a listing of BirdCast's daily file names into --dir;
keeps counties whose internal point is within 150 km of a radar in pipeline/sites.json; and prints cases per radar and
year, the share of the year-to-year variance all radars share, month of onset, and the share of days the radar
archive has a file for.
When to reach for it: to re-check docs/analysis/d-arbo-feasibility.md, or before a D design is written.
Output: tables on stdout. No radar profile is opened and nothing is compared with migration, so a later D design
stays blind.
Check: a downloaded file whose sha256 is not the pinned one raises; so do a county-year listed twice, a month
missing from an onset table, and three counties whose placement is known (Suffolk NY near KOKX, Cook IL near KLOT,
Los Angeles CA near none).

    python3 -m analysis.d_arbo_counts --dir <cache dir>
"""

from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import http.client
import io
import json
import math
import re
import statistics
import time
import urllib.error
import urllib.parse
import zipfile
from pathlib import Path

from pipeline.net import urlopen

R_KM = 150
MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
]
ALL_YEARS = range(1999, 2026)
ESTABLISHED = range(2003, 2026)  # WNV had reached every radar's area by 2003
STORE = range(2021, 2026)  # the passage falls stored for A
EEE_YEARS = range(2003, 2025)

IA = "https://web.archive.org/web/{stamp}id_/https://www.cdc.gov/wcms/vizdata/live/ncezid_dvbd/{path}"
GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_counties_national.zip"
# file in --dir: (URL, sha256 of the file as stored, member to take from a zip or None)
INPUTS = {
    "wnv_county_year.csv": (
        IA.format(stamp="20260726125041", path="WNV/wnv_hist_hum_nonhum_yearly.csv"),
        "7e3d91961f8e010cfd992b61459a4beda6d8f998748c18dfae6bb4e8c849cb5f",
        None,
    ),
    # Connecticut 2022 is published apart: its counties gave way to planning regions that year
    "wnv_county_year_2022_ct.csv": (
        IA.format(stamp="20260321212416", path="WNV/wnv_hist_hum_nonhum_2022_CT.csv"),
        "1e2f46bfec16f64d12874ca9af891bea6f62dd7b7dec1564845258b8c0935335",
        None,
    ),
    "wnv_year_month.csv": (
        IA.format(
            stamp="20260726125042", path="WNV/wnv_hum_historic_Year%20and%20Month.csv"
        ),
        "679a80b604ac9619f56b56501e7ad059e679c7f94ed53d7af797b42a9b53535b",
        None,
    ),
    "eee_county_year.csv": (
        IA.format(stamp="20260320140752", path="EEE/eee_hist_hum_nonhum.csv"),
        "9e8045a3916bbf93cbc97eaa3a6f65581c4615e3b72916c8f54174e68fc1f29c",
        None,
    ),
    "eee_year_month.csv": (
        IA.format(
            stamp="20260320140753", path="EEE/eee_hum_historic_Year%20and%20Month.csv"
        ),
        "569ea5b5f94b57b91975f70414f29282142acb74518e59d5d56a5afe838213b6",
        None,
    ),
    "2021_Gaz_counties_national.txt": (
        GAZ.format(y=2021),
        "ba46eb14a97e3ca062cb5c2bd40b8a44d1486b512bda4fd8187223030746eba7",
        "2021_Gaz_counties_national.txt",
    ),
    "2024_Gaz_counties_national.txt": (
        GAZ.format(y=2024),
        "0a121d136b434e3ae749d053db19dfbacbb56eebf30335cfa5031388803b4451",
        "2024_Gaz_counties_national.txt",
    ),
}
BUCKET = "https://birdcastdata.s3.amazonaws.com/"
LISTING = "birdcast_listing.json"


def get(url: str, tries: int = 4) -> bytes:
    """GET, retrying a failed connection or a 429/5xx; the last failure is raised as it came."""
    for attempt in range(tries):
        try:
            with urlopen(url, timeout=120) as r:
                return r.read()
        except (
            urllib.error.URLError,
            TimeoutError,
            http.client.HTTPException,
            ConnectionError,
        ) as e:
            code = getattr(e, "code", None)
            if attempt == tries - 1 or (
                code is not None and code != 429 and code < 500
            ):
                raise
            time.sleep(5 * 2**attempt)
    raise AssertionError("unreachable")


def fetch_inputs(d: Path, get=get, pause: float = 3.0) -> list[str]:
    """Download the INPUTS that --dir lacks and check every one against its pinned sha256. Returns the names fetched."""
    d.mkdir(parents=True, exist_ok=True)
    fetched = []
    for name, (url, sha, member) in INPUTS.items():
        dest = d / name
        if not dest.exists():
            if fetched:
                time.sleep(pause)
            data = get(url)
            if member is not None:
                with zipfile.ZipFile(io.BytesIO(data)) as zf:
                    data = zf.read(member)
            got = hashlib.sha256(data).hexdigest()
            if got != sha:
                raise RuntimeError(
                    f"{name}: sha256 {got} from {url}, expected {sha}; nothing written"
                )
            dest.write_bytes(data)
            fetched.append(name)
        got = hashlib.sha256(dest.read_bytes()).hexdigest()
        if got != sha:
            raise RuntimeError(
                f"{dest}: sha256 {got}, expected {sha}; delete it and rerun"
            )
    return fetched


def list_archive(radars: list[str], get=get, pause: float = 0.15) -> dict:
    """{radar: {"YYYY-MM": daily files}} from the bucket listing of BirdCast's daily profiles. Names only."""
    out = {}
    for r in radars:
        n, token = collections.Counter(), None
        key = re.compile(
            rf"<Key>nexrad/daily/{r}/\d{{4}}/{r}_vpts_(\d{{4}})(\d{{2}})\d{{2}}\.csv</Key>"
        )
        while True:
            q = {"list-type": "2", "prefix": f"nexrad/daily/{r}/", "max-keys": "1000"}
            if token:
                q["continuation-token"] = token
            page = get(BUCKET + "?" + urllib.parse.urlencode(q)).decode()
            for y, m in key.findall(page):
                n[f"{y}-{m}"] += 1
            if "<IsTruncated>true</IsTruncated>" not in page:
                break
            nxt = re.search(
                r"<NextContinuationToken>([^<]+)</NextContinuationToken>", page
            )
            if not nxt:
                raise RuntimeError(f"{r}: a truncated listing page without a token")
            token = nxt.group(1)
            time.sleep(pause)
        if not n:
            raise RuntimeError(f"{r}: the listing holds no daily file")
        out[r] = dict(sorted(n.items()))
    return out


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = (
        math.sin((la2 - la1) / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _gaz(path: Path) -> dict[str, tuple[float, float]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    head = [h.strip() for h in lines[0].split("\t")]
    cent = {}
    for line in lines[1:]:
        p = dict(zip(head, (v.strip() for v in line.split("\t")), strict=True))
        cent[p["GEOID"]] = (float(p["INTPTLAT"]), float(p["INTPTLONG"]))
    return cent


def centroids(d: Path) -> dict[str, tuple[float, float]]:
    """Census 2021 internal points (as A and B), plus Connecticut's nine planning regions from the 2024 gazetteer:
    CDC reports Connecticut by planning region from 2023 (2022 is in its own file, by the old counties)."""
    cent = _gaz(d / "2021_Gaz_counties_national.txt")
    ct = {
        f: c
        for f, c in _gaz(d / "2024_Gaz_counties_national.txt").items()
        if f.startswith("091")
    }
    if len(ct) != 9 or set(ct) & set(cent):
        raise RuntimeError(
            f"expected 9 new Connecticut planning regions, got {sorted(ct)}"
        )
    return cent | ct


def near(radars, cent) -> dict[str, set[str]]:
    """{radar: counties within R_KM}; a county near two radars is in both sets."""
    return {
        r["id"]: {f for f, c in cent.items() if km((r["lat"], r["lon"]), c) <= R_KM}
        for r in radars
    }


def county_years(
    paths: list[Path], case_col: str
) -> tuple[dict[tuple[str, int], int], int]:
    """{(fips, year): human cases} for single-year rows; rows of a pooled span ('2003-2024') are skipped and counted."""
    out, pooled = {}, 0
    for path in paths:
        with path.open(encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                if not r["Year"].isdigit():
                    pooled += 1
                    continue
                key = (r["County"].strip(), int(r["Year"]))
                if key in out:
                    raise RuntimeError(f"{path.name}: county-year {key} appears twice")
                out[key] = int(r[case_col].strip() or 0)
    return out, pooled


def radar_year(cases, counties, years) -> dict[str, dict[int, int]]:
    return {
        r: {y: sum(cases.get((f, y), 0) for f in fs) for y in years}
        for r, fs in counties.items()
    }


def two_way(table: dict[str, dict[int, int]]) -> dict[str, float]:
    """Shares of the variance of log(cases + 0.5) taken by radar means, year means, and what is left."""
    rs, ys = list(table), list(next(iter(table.values())))
    z = {(r, y): math.log(table[r][y] + 0.5) for r in rs for y in ys}
    g = statistics.fmean(z.values())
    rm = {r: statistics.fmean(z[r, y] for y in ys) for r in rs}
    ym = {y: statistics.fmean(z[r, y] for r in rs) for y in ys}
    ss_r = len(ys) * sum((rm[r] - g) ** 2 for r in rs)
    ss_y = len(rs) * sum((ym[y] - g) ** 2 for y in ys)
    ss_e = sum((z[r, y] - rm[r] - ym[y] + g) ** 2 for r in rs for y in ys)
    tot = ss_r + ss_y + ss_e
    return {
        "radar": ss_r / tot,
        "year": ss_y / tot,
        "left": ss_e / tot,
        "year_of_within_radar": ss_y / (ss_y + ss_e),
    }


def by_month(path: Path, span: str, kind: str = "All disease cases") -> list[int]:
    """Cases by month of onset, January first, for the pooled span `span`."""
    with path.open(encoding="utf-8-sig") as f:
        got = {
            r["Month"]: int(r["Reported Cases"])
            for r in csv.DictReader(f)
            if r["Year"] == span and r["Type"] == kind
        }
    if sorted(got) != sorted(MONTHS):
        raise RuntimeError(f"{path.name}: span {span!r} has months {sorted(got)}")
    return [got[m] for m in MONTHS]


def coverage(
    listing: dict, radars, years, months: tuple[int, ...], days: int
) -> dict[tuple[str, int], float]:
    """{(radar, year): share of the months' calendar days with a daily file}."""
    return {
        (r, y): sum(listing[r].get(f"{y}-{m:02d}", 0) for m in months) / days
        for r in radars
        for y in years
    }


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", type=Path, required=True)
    ap.add_argument("--sites", type=Path, default=Path("pipeline/sites.json"))
    a = ap.parse_args(argv)
    fetched = fetch_inputs(a.dir)
    radars = json.loads(a.sites.read_text())
    ids = [r["id"] for r in radars]
    if not (a.dir / LISTING).exists():
        (a.dir / LISTING).write_text(json.dumps(list_archive(ids)))
        fetched.append(LISTING)
    print(f"fetched now: {fetched or 'nothing (all inputs were in --dir)'}")
    cent = centroids(a.dir)
    counties = near(radars, cent)
    # geometry controls: a county that must be near a radar, and one that must be near none
    if (
        "36103" not in counties["KOKX"]
        or "17031" not in counties["KLOT"]
        or any("06037" in v for v in counties.values())
    ):
        raise RuntimeError(
            "county placement is off: Suffolk NY / Cook IL / Los Angeles CA control failed"
        )
    wnv_files = [
        a.dir / "wnv_county_year.csv",
        a.dir / "wnv_county_year_2022_ct.csv",
    ]
    wnv, _ = county_years(wnv_files, "Reported human cases")
    neuro, _ = county_years(wnv_files, "Neuroinvasive disease cases")
    eee, eee_pooled = county_years(
        [a.dir / "eee_county_year.csv"], "Total human disease cases"
    )
    unplaced = {f for f, _ in wnv} - set(cent)
    print(
        f"radars {len(ids)}; counties within {R_KM} km: {sorted(len(v) for v in counties.values())}"
    )
    print(
        f"WNV county-years {len(wnv)}; county codes the gazetteer lacks: {len(unplaced)} {sorted(unplaced)[:8]}"
    )

    t = radar_year(wnv, counties, ALL_YEARS)
    print(
        "\nWNV human cases near each radar (a county near two radars counts for both)"
    )
    print(
        "radar  counties  1999-2025  "
        + "  ".join(str(y) for y in STORE)
        + "  zero years 2003-25  median/yr 2003-25"
    )
    for r in ids:
        est = [t[r][y] for y in ESTABLISHED]
        print(
            f"{r}  {len(counties[r]):8d}  {sum(t[r].values()):9d}  "
            + "  ".join(f"{t[r][y]:4d}" for y in STORE)
            + f"  {sum(1 for v in est if v == 0):18d}  {statistics.median(est):17.1f}"
        )
    us = collections.Counter()
    for (_, y), n in wnv.items():
        us[y] += n
    print("sum over radars by year:", {y: sum(t[r][y] for r in ids) for y in ALL_YEARS})
    print("US total by year:      ", {y: us[y] for y in ALL_YEARS})
    month_total = sum(by_month(a.dir / "wnv_year_month.csv", "1999-2025"))
    print(
        f"cross-check: county file sums to {sum(us.values())} cases 1999-2025, CDC's month-of-onset file to {month_total}"
    )
    tn = radar_year(neuro, counties, ALL_YEARS)
    print(
        "neuroinvasive cases near each radar, median/yr 2003-25 and zero years:",
        {
            r: (
                statistics.median([tn[r][y] for y in ESTABLISHED]),
                sum(1 for y in ESTABLISHED if tn[r][y] == 0),
            )
            for r in ids
        },
    )
    for cut in (5, 10):
        keep = [
            r for r in ids if statistics.median([t[r][y] for y in ESTABLISHED]) >= cut
        ]
        print(
            f"radars with a median of >= {cut} cases a year 2003-25: {len(keep)} {keep}"
        )
    for label, years in (("2003-2025", ESTABLISHED), ("2021-2025", STORE)):
        sub = {r: {y: t[r][y] for y in years} for r in ids}
        v = two_way(sub)
        cells = [sub[r][y] for r in ids for y in years]
        print(
            f"{label}: {len(cells)} radar-years, {sum(1 for c in cells if c == 0)} with 0 cases, "
            f"{sum(1 for c in cells if c < 5)} with <5; variance of log(cases+0.5): radar {v['radar']:.2f}, "
            f"year {v['year']:.2f}, left {v['left']:.2f}; year share of within-radar variance {v['year_of_within_radar']:.2f}"
        )

    print("\nMonth of onset, US")
    for name, f, span in (
        ("WNV", "wnv_year_month.csv", "1999-2025"),
        ("EEE", "eee_year_month.csv", "2003-2024"),
    ):
        m = by_month(a.dir / f, span)
        n = sum(m)
        cum = [sum(m[: i + 1]) / n for i in range(12)]
        print(f"{name} {span}: {n} cases; by month {dict(zip(MONTHS, m, strict=True))}")
        print(
            f"   onset by end of Jul {cum[6]:.3f}, Aug {cum[7]:.3f}, Sep {cum[8]:.3f}, Oct {cum[9]:.3f}"
        )

    te = radar_year(eee, counties, EEE_YEARS)
    cells = [te[r][y] for r in ids for y in EEE_YEARS]
    us_e = collections.Counter()
    for (_, y), n in eee.items():
        us_e[y] += n
    print(
        f"\nEEE 2003-2024 ({eee_pooled} pooled-span rows skipped): US human cases {sum(us_e.values())}, "
        f"by year {dict(sorted(us_e.items()))}"
    )
    print(
        f"near radars: {sum(cells)} case-counts in {len(cells)} radar-years, {sum(1 for c in cells if c > 0)} "
        f"radar-years with any, per radar { {r: sum(te[r].values()) for r in ids} }"
    )

    listing = json.loads((a.dir / LISTING).read_text())
    print(
        "\nBirdCast daily files (names only), share of days with a file per radar-year, 2003-2025"
    )
    for label, months, days in (
        ("spring Apr-May", (4, 5), 61),
        ("fall Aug-Oct", (8, 9, 10), 92),
        ("late fall Oct-Nov", (10, 11), 61),
    ):
        c = coverage(listing, ids, ESTABLISHED, months, days)
        low = min(c, key=c.get)
        print(
            f"{label}: {len(c)} radar-years; >=0.90 of days: {sum(1 for x in c.values() if x >= 0.9)}; "
            f"<0.50: {sum(1 for x in c.values() if x < 0.5)}; lowest {c[low]:.2f} ({low[0]} {low[1]})"
        )


if __name__ == "__main__":
    main()
