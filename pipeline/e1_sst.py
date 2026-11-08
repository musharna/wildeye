"""E1: do coastal die-offs start in weeks of unusually warm water? (docs/analysis/e1-dieoffs-sea-warmth.md).

E0b's design with sea-surface temperature in place of drought: each WHISPers case in a coastal county is scored by the
mid-rank of its ISO week's mean SST (NOAA OISST v2.1, 0.25 deg daily, ocean cells within RADIUS_KM of the county
centroid) among the same ISO week of the years in its stratum (case year +-4). Score, stratum, bootstrap, placebo and
verdict rule are E0b's (pipeline/e0b_rank.py), unchanged. Known positive: the 2015-16 common murre die-off, which
Piatt et al. 2020 (PLoS ONE 15:e0226087) tie to the 2014-16 northeast Pacific heatwave.

Fetch (resumable; one ERDDAP request per region-year, reduced at once to per-county daily means, raw file deleted):
  uv run --python 3.13 --with netCDF4 --with numpy python -m pipeline.e1_sst fetch --e0-cache ~/.cache/wildeye/e0 \
      --cache ~/.cache/wildeye/e1
Run: python -m pipeline.e1_sst run --e0-cache ~/.cache/wildeye/e0 --cache ~/.cache/wildeye/e1 \
      --out docs/analysis/e1_dieoffs_sst.json [--planted-only]
"""

import argparse
import datetime as dt
import json
import math
import os
import statistics
import tempfile
import time
import urllib.parse
from pathlib import Path

from . import e0_dieoffs as e0
from . import e0b_rank as rb

OISST = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/ncdcOisst21Agg_LonPM180.nc"
UA = "wildeye-analysis (https://github.com/musharna/wildeye)"
RADIUS_KM = 100.0
FIRST_YEAR, LAST_DAY = (
    1997,
    dt.date(2026, 10, 23),
)  # OISST's last day when fetched (2026-11-08)
MIN_DAYS = 5  # of the 7 in an ISO week
# Boxes (lat0, lat1, lon0, lon1) for US waters. A county is fetched from the first box that holds its whole disc.
REGIONS = {
    "pacific": (30.0, 50.0, -130.0, -115.0),
    "east": (
        23.0,
        50.0,
        -100.0,
        -64.0,
    ),  # -100: South Texas discs (Jim Wells, Hidalgo) reach -99.1
    "alaska": (50.0, 72.0, -179.875, -128.0),
    "hawaii": (17.0, 24.0, -162.0, -153.0),
    "caribbean": (16.5, 20.0, -68.5, -64.0),
}
# Plants: weight exp(beta * SST in deg C); rb.expected_cases weighs exp(b * v / 100), so b = 100 * beta.
BETA_PER_C = 1.0
# Known positive: murre die-off cases Piatt et al. 2020 cover (washed ashore summer 2015 to spring 2016).
MURRE_NAME, MURRE_FROM, MURRE_TO = (
    "Common Murre",
    dt.date(2015, 6, 1),
    dt.date(2016, 5, 31),
)
BASELINE = (1997, 2012)  # before the 2014-16 heatwave
MURRE_MIN_Z = 1.0


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(
        math.radians(lon2 - lon1)
    )
    return 6371.0 * math.acos(max(-1.0, min(1.0, c)))


def region_of(lat: float, lon: float, radius: float = RADIUS_KM) -> str | None:
    """The first box that holds the county's whole disc (centroid +- radius), else None."""
    dlat = radius / 111.0
    dlon = radius / (111.0 * max(math.cos(math.radians(lat)), 0.05))
    for name, (a, b, c, d) in REGIONS.items():
        if a <= lat - dlat and lat + dlat <= b and c <= lon - dlon and lon + dlon <= d:
            return name
    return None


def disc_cells(
    lat: float, lon: float, lats, lons, radius: float = RADIUS_KM
) -> list[tuple[int, int]]:
    """(i, j) of grid cells whose centres lie within `radius` km of (lat, lon)."""
    out = []
    for i, la in enumerate(lats):
        if abs(la - lat) * 111.0 > radius:
            continue
        for j, lo in enumerate(lons):
            if km(lat, lon, la, lo) <= radius:
                out.append((i, j))
    return out


def reduce_days(sst, cells: list[tuple[int, int]]) -> list[float | None]:
    """Per-day mean over `cells` of sst[day][i][j], NaN (land, no data) skipped; None for a day with no ocean cell."""
    out = []
    for day in sst:
        vals = [float(day[i][j]) for i, j in cells if not math.isnan(float(day[i][j]))]
        out.append(round(statistics.fmean(vals), 4) if vals else None)
    return out


class Sst:
    """One county's daily SST; value(d) = the mean over d's ISO week, if at least MIN_DAYS of its days have data."""

    def __init__(self, daily: dict[dt.date, float]):
        self.daily = daily

    def value(self, d: dt.date) -> float | None:
        if d is None:
            return None
        monday = d - dt.timedelta(days=d.weekday())
        vals = [self.daily.get(monday + dt.timedelta(days=k)) for k in range(7)]
        vals = [v for v in vals if v is not None]
        return statistics.fmean(vals) if len(vals) >= MIN_DAYS else None


# --- fetch ------------------------------------------------------------------------------------------------------


def centroids(events: list[dict]) -> dict[str, tuple[float, float]]:
    out = {}
    for e in events:
        for a in e.get("administrativeleveltwos") or []:
            f = str(a.get("fips_code") or "").strip().zfill(5)
            if (
                a.get("centroid_latitude") is not None
                and a.get("centroid_longitude") is not None
            ):
                out[f] = (float(a["centroid_latitude"]), float(a["centroid_longitude"]))
    return out


def download(url: str, dest: str, run=None) -> None:
    """curl, not urllib: the same ERDDAP request took 293 s through urllib and 9 s through curl (Pacific 2015) and
    115 s against 12 s (Hawaii 2015), 2026-11-08. curl retries transient answers (5xx, 429, dropped routes; ERDDAP
    answered 503 to a request that went through seconds later) and --fail makes any other HTTP error exit non-zero."""
    import subprocess

    run = run or subprocess.run
    cmd = [
        "curl",
        "-sS",
        "--fail",
        "-L",
        "-A",
        UA,
        "--retry",
        "6",
        "--retry-delay",
        "10",
        "--retry-all-errors",
        "--max-time",
        "900",
        "-o",
        dest,
        url,
    ]
    r = run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(
            f"curl exit {r.returncode} for {url}: {r.stderr.strip()[:500]}"
        )


def region_year_url(region: str, year: int) -> str:
    a, b, c, d = REGIONS[region]
    t0 = dt.date(year, 1, 1)
    t1 = min(dt.date(year, 12, 31), LAST_DAY)
    q = f"sst[({t0}T12:00:00Z):({t1}T12:00:00Z)][(0.0)][({a}):({b})][({c}):({d})]"
    return OISST + "?" + urllib.parse.quote(q, safe="():,")


def fetch_region_year(region: str, year: int, counties: dict, cache: Path) -> Path:
    """Download one region-year, reduce it to {fips: [daily mean]} for `counties` (fips -> (lat, lon)) in that region,
    write sst_<region>_<year>.json and delete the raw file. Skipped if the reduced file exists."""
    import netCDF4
    import numpy as np

    out = cache / f"sst_{region}_{year}.json"
    if out.exists():
        return out
    fd, raw = tempfile.mkstemp(suffix=".nc", dir=cache)
    os.close(fd)
    try:
        download(region_year_url(region, year), raw)
        with netCDF4.Dataset(raw) as ds:
            lats = [float(x) for x in ds["latitude"][:]]
            lons = [float(x) for x in ds["longitude"][:]]
            times = [
                dt.date(1970, 1, 1) + dt.timedelta(seconds=float(t))
                for t in ds["time"][:]
            ]
            sst = np.ma.filled(ds["sst"][:, 0, :, :].astype("float64"), np.nan)
    finally:
        Path(raw).unlink(missing_ok=True)
    days = {}
    for f, (la, lo) in counties.items():
        cells = disc_cells(la, lo, lats, lons)
        if not cells:
            continue
        ii, jj = np.array([c[0] for c in cells]), np.array([c[1] for c in cells])
        sub = sst[:, ii, jj]
        ok = ~np.isnan(sub)
        n = ok.sum(axis=1)
        if not n.any():
            continue
        mean = np.where(
            n > 0, np.nansum(np.where(ok, sub, 0.0), axis=1) / np.maximum(n, 1), np.nan
        )
        days[f] = [None if math.isnan(v) else round(float(v), 4) for v in mean]
    out.write_text(
        json.dumps({"dates": [t.isoformat() for t in times], "counties": days})
    )
    return out


def cmd_fetch(a) -> None:
    events = json.loads((a.e0_cache / "whispers_events.json").read_text())
    cases, _ = e0.load_cases(events)
    cent = centroids(events)
    fips = sorted({c["fips"] for c in cases if c["fips"] in cent})
    by_region: dict[str, dict] = {}
    for f in fips:
        r = region_of(*cent[f])
        if r:
            by_region.setdefault(r, {})[f] = cent[f]
    a.cache.mkdir(parents=True, exist_ok=True)
    (a.cache / "regions.json").write_text(
        json.dumps({r: sorted(v) for r, v in by_region.items()})
    )
    for r, counties in by_region.items():
        for y in range(FIRST_YEAR, LAST_DAY.year + 1):
            t = time.monotonic()
            p = fetch_region_year(r, y, counties, a.cache)
            print(f"{r} {y} {p.name} {time.monotonic() - t:.1f}s", flush=True)


# --- run --------------------------------------------------------------------------------------------------------


def load_sst(cache: Path) -> dict[str, Sst]:
    daily: dict[str, dict[dt.date, float]] = {}
    for p in sorted(cache.glob("sst_*_*.json")):
        doc = json.loads(p.read_text())
        dates = [dt.date.fromisoformat(d) for d in doc["dates"]]
        for f, vals in doc["counties"].items():
            daily.setdefault(f, {}).update(
                {d: v for d, v in zip(dates, vals) if v is not None}
            )
    return {f: Sst(d) for f, d in daily.items() if d}


def murre_ids(events: list[dict]) -> set:
    return {
        e["id"]
        for e in events
        if any(s.get("name") == MURRE_NAME for s in e.get("species") or [])
        and e.get("start_date")
        and MURRE_FROM <= dt.date.fromisoformat(e["start_date"]) <= MURRE_TO
    }


def murre_check(cases: list[dict], sst: dict[str, Sst]) -> dict:
    """Mechanism fired: at the murre cases' county-weeks, SST in SDs above the same ISO week in BASELINE years."""
    zs = []
    for c in cases:
        s = sst.get(c["fips"])
        if s is None:
            continue
        x = s.value(c["start"])
        base = [
            s.value(e0.same_week(c["start"], y))
            for y in range(BASELINE[0], BASELINE[1] + 1)
        ]
        base = [v for v in base if v is not None]
        if x is None or len(base) < 8:
            continue
        sd = statistics.stdev(base)
        if sd > 0:
            zs.append((x - statistics.fmean(base)) / sd)
    mean_z = statistics.fmean(zs) if zs else None
    return {
        "cases": len(cases),
        "scored": len(zs),
        "z": zs,
        "mean_z": mean_z,
        "fired": mean_z is not None and mean_z >= MURRE_MIN_Z,
    }


def relabel(stats: dict, label: str) -> dict:
    return stats | {"classes": {label: next(iter(stats["classes"].values()))}}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    r = sub.add_parser("run")
    for p in (f, r):
        p.add_argument("--e0-cache", type=Path, required=True)
        p.add_argument("--cache", type=Path, required=True)
    r.add_argument("--out", type=Path, required=True)
    r.add_argument(
        "--planted-only",
        action="store_true",
        help="plants and the murre check only: no class is scored",
    )
    a = ap.parse_args(argv)
    if a.cmd == "fetch":
        return cmd_fetch(a)
    confirmed, suspect, _dsci, _unmapped, _n_events, _why = rb.load(a.e0_cache)
    events = json.loads((a.e0_cache / "whispers_events.json").read_text())
    sst = load_sst(a.cache)
    coastal = [c for c in confirmed if c["fips"] in sst]
    coastal_suspect = [c for c in suspect if c["fips"] in sst]
    murres = murre_ids(events)
    b = 100 * BETA_PER_C
    on = relabel(
        rb.class_stats(rb.expected_cases(coastal, sst, beta=b), sst), "expected_beta_1"
    )
    off = relabel(
        rb.class_stats(rb.expected_cases(coastal, sst, beta=0.0), sst),
        "expected_beta_0",
    )
    murre_cases = [c for c in coastal if c["id"] in murres]
    doc = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "rules": "docs/analysis/e1-dieoffs-sea-warmth.md",
        "cases_confirmed": len(confirmed),
        "cases_coastal": len(coastal),
        "coastal_counties": len({c["fips"] for c in coastal}),
        "expected_beta_1": on,
        "expected_beta_0": off,
        "murre_check": murre_check(murre_cases, sst),
    }
    if not a.planted_only:
        counts: dict[str, int] = {}
        for c in coastal:
            counts[c["cls"]] = counts.get(c["cls"], 0) + 1
        k = sum(1 for n in counts.values() if n >= e0.MIN_CASES)
        real = rb.class_stats(coastal, sst, k=k)
        placebo = rb.class_stats(coastal, sst, shift_weeks=e0.PLACEBO_WEEKS, k=k)
        no_murre = [
            c for c in coastal if c["id"] not in murres and c["cls"] == "Nut/Met/Dev"
        ]
        doc |= {
            "class_counts": counts,
            "k": k,
            "real": real,
            "placebo": placebo,
            "nut_met_dev_without_murres": rb.class_stats(no_murre, sst, k=k),
            "suspect_arm": rb.class_stats(coastal_suspect, sst, k=k),
            "verdict": e0.verdict(real, placebo, on, off)
            | {"murre_fired": doc["murre_check"]["fired"]},
        }
        if not doc["murre_check"]["fired"]:
            doc["verdict"]["status"] = "VOID"
    a.out.write_text(json.dumps(doc, indent=1, default=str) + "\n")
    show = {k: doc[k] for k in ("cases_coastal", "coastal_counties")}
    show["murre"] = {
        k: doc["murre_check"][k] for k in ("cases", "scored", "mean_z", "fired")
    }
    show["plants"] = {
        k: doc[k]["classes"] for k in ("expected_beta_0", "expected_beta_1")
    }
    if "verdict" in doc:
        show["verdict"] = {
            k: doc["verdict"][k]
            for k in ("status", "planted_ok", "trauma_ok", "murre_fired", "findings")
        }
    print(json.dumps(show, indent=1, default=str))


if __name__ == "__main__":
    main()
