"""A's passage source (docs/analysis/a-hpai-radar.md, Amendment 1): BirdCast's per-scan vol2bird profiles, written into
a profile store laid out like the backfill's (root/SITE/YYYYMMDD/<volume>.txt.gz, vol2bird's own text layout), so
pipeline.bird_nights.night_total and the fast-share code read them unchanged.

When to reach for it: to fill A's passage falls (2021-2025, and 2026 for the replication) for the 19 radars.
Output: the profiles, plus a manifest (per radar-fall nights/profiles, missing day files, each day file's ETag and
Last-Modified). Failure looks like: a day file that is neither present nor 404 raises; a scan whose rows disagree
on time raises; a radar-fall with no profiles is listed, never written as empty.
The answer must pass: night totals agree with the pinned-image store on shared nights (bridge B1/B2 in the rules).

  python -m analysis.a_birdcast --root DIR --falls 2021,2022,2023,2024,2025 [--site KDIX ...] [--workers 12]
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import datetime as dt
import io
import json
import logging
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

from pipeline.bird_nights import night_window
from pipeline.nexrad import key_time
from pipeline.vol2bird import save_profile

log = logging.getLogger("a_birdcast")
URL = "https://birdcastdata.s3.amazonaws.com/nexrad/daily/{r}/{d:%Y}/{r}_vpts_{d:%Y%m%d}.csv"
EVERY_MIN = 10  # the backfill's slot rule (bird_nights.backfill_night --every-min 10)
FALL = ((8, 1), (12, 31))
# vol2bird's columns, in its order; BirdCast's column for each (DBZH is vol2bird's name for dbz_all)
COLUMNS = [
    ("u", "u"),
    ("v", "v"),
    ("w", "w"),
    ("ff", "ff"),
    ("dd", "dd"),
    ("sd_vvp", "sd_vvp"),
    ("gap", "gap"),
    ("dbz", "dbz"),
    ("eta", "eta"),
    ("dens", "dens"),
    ("DBZH", "dbz_all"),
    ("n", "n"),
    ("n_dbz", "n_dbz"),
    ("n_all", "n_all"),
    ("n_dbz_all", "n_dbz_all"),
]
HEADER = "# date   time HGHT " + " ".join(v for v, _ in COLUMNS)
MISSING = {"", "NA", "NaN", "nan"}


def fetch(radar: str, day: dt.date, tries: int = 5) -> tuple[str, dict] | None:
    """The day's CSV text and its ETag/Last-Modified, or None when BirdCast has no file for that day (404)."""
    url = URL.format(r=radar, d=day)
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:  # nosec B310 - always the https URL constant + radar id + date
                meta = {
                    "etag": resp.headers.get("ETag"),
                    "last_modified": resp.headers.get("Last-Modified"),
                }
                return resp.read().decode(), meta
        except urllib.error.HTTPError as e:
            if (
                e.code == 404
            ):  # the bucket allows listing, so a missing key is 404; a 403 is a real fault
                return None
            if k == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if k == tries - 1:
                raise
        time.sleep(5.0 * 2**k)
    raise AssertionError("unreachable")


def scans(text: str, radar: str) -> dict[str, list[dict]]:
    """{source volume name: its rows} from one BirdCast day file; every row of a scan must share one time. Heights
    must be above sea level, the frame integrate_profile and the height quartiles assume (pipeline/vol2bird.py)."""
    out: dict[str, list[dict]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        if row["radar"] != radar:
            raise ValueError(f"{radar} file holds a row for {row['radar']}")
        if row["height_reference"] != "sea":
            raise ValueError(
                f"{row['source_file']}: heights above {row['height_reference']!r}, not sea level"
            )
        out.setdefault(row["source_file"], []).append(row)
    for name, rows in out.items():
        times = {r["datetime"] for r in rows}
        if len(times) != 1:
            raise ValueError(f"{name}: rows at {len(times)} times {sorted(times)[:3]}")
    return out


def _val(column: str, raw: str) -> str:
    if column == "gap":
        return {"true": "T", "false": "F"}[raw.lower()]
    return "nan" if raw in MISSING else raw


def to_vol2bird(rows: list[dict]) -> str:
    """One scan's rows as vol2bird prints a profile: '# ... HGHT ...' header, then 'YYYYMMDD HHMM HGHT values'
    (time to the minute, as vol2bird prints it), lowest bin first."""
    # 2021-2024 files print "...T00:05:37Z", 2025 files "...T00:02:25.000Z" (same Jan 2026 batch, same columns)
    t = dt.datetime.fromisoformat(rows[0]["datetime"])
    if t.utcoffset() != dt.timedelta(0):
        raise ValueError(
            f"{rows[0]['source_file']}: time {rows[0]['datetime']} is not UTC"
        )
    stamp = f"{t:%Y%m%d} {t:%H%M}"
    lines = [
        "# vol2bird Vertical Profile of Birds (VPB)",
        f"# source: BirdCast vpts, {rows[0]['source_file']}",
        HEADER,
    ]
    for r in sorted(rows, key=lambda r: float(r["height"])):
        lines.append(
            f"{stamp} {r['height']} " + " ".join(_val(b, r[b]) for _, b in COLUMNS)
        )
    return "\n".join(lines) + "\n"


def select(
    names: list[str],
    sunset: dt.datetime,
    sunrise: dt.datetime,
    every_min: float = EVERY_MIN,
) -> list[str]:
    """The backfill's rule (bird_nights.backfill_night, kept identical by test_select_matches_backfill_night):
    _V06 volumes with sunset <= scan time <= sunrise, then the first of each every_min slot counted from sunset."""
    night = sorted(
        (k for k in names if k.endswith("_V06") and sunset <= key_time(k) <= sunrise),
        key=key_time,
    )
    slots: dict[int, str] = {}
    for k in night:
        slots.setdefault(
            int((key_time(k) - sunset).total_seconds() // (every_min * 60)), k
        )
    return list(slots.values())


def fall_nights(year: int) -> list[dt.date]:
    first, last = dt.date(year, *FALL[0]), dt.date(year, *FALL[1])
    return [first + dt.timedelta(days=i) for i in range((last - first).days + 1)]


def radar_fall(site: dict, year: int, root: Path, get=fetch) -> dict:
    """Write the selected scans of every night of one radar-fall; counts, missing day files and day-file metadata."""
    days: dict[dt.date, dict[str, list[dict]] | None] = {}
    meta: dict[str, dict] = {}
    out = {
        "nights": 0,
        "nights_with_profiles": 0,
        "profiles": 0,
        "missing_days": [],
        "days": meta,
    }
    for night in fall_nights(year):
        sunset, sunrise = night_window(night, site["lon"], site["lat"])
        names: dict[str, list[dict]] = {}
        d = sunset.date()
        while d <= sunrise.date():
            if d not in days:
                got = get(site["id"], d)
                if got is None:
                    days[d] = None
                    out["missing_days"].append(d.isoformat())
                else:
                    days[d] = scans(got[0], site["id"])
                    meta[d.isoformat()] = got[1]
            names.update(days[d] or {})
            d += dt.timedelta(days=1)
        for old in [k for k in days if k < sunset.date()]:
            del days[old]
        kept = select(list(names), sunset, sunrise)
        for k in kept:
            save_profile(to_vol2bird(names[k]), site["id"], k, root)
        out["nights"] += 1
        out["nights_with_profiles"] += bool(kept)
        out["profiles"] += len(kept)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--falls", required=True, help="comma-separated years")
    ap.add_argument(
        "--site", action="append", help="default: the 19 radars (all but KLTX)"
    )
    ap.add_argument("--workers", type=int, default=12)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    sites = {
        s["id"]: s
        for s in json.loads(
            (Path(__file__).parents[1] / "pipeline/sites.json").read_text()
        )
    }
    ids = a.site or sorted(set(sites) - {"KLTX"})
    unknown = set(ids) - set(sites)
    if unknown:
        raise SystemExit(f"unknown site(s): {sorted(unknown)}")
    years = [int(y) for y in a.falls.split(",")]
    a.root.mkdir(parents=True, exist_ok=True)
    started = dt.datetime.now(ZoneInfo("America/New_York"))
    jobs = [(sid, y) for sid in ids for y in years]
    res = {}
    with cf.ProcessPoolExecutor(a.workers) as ex:
        futs = {
            ex.submit(radar_fall, sites[sid], y, a.root): (sid, y) for sid, y in jobs
        }
        for fut in cf.as_completed(futs):
            sid, y = futs[fut]
            r = res[f"{sid} {y}"] = fut.result()
            log.info(
                "%s %d: %d/%d nights with profiles, %d profiles, %d day files missing",
                sid,
                y,
                r["nights_with_profiles"],
                r["nights"],
                r["profiles"],
                len(r["missing_days"]),
            )
    empty = sorted(k for k, r in res.items() if r["profiles"] == 0)
    doc = {
        "source": URL,
        "every_min": EVERY_MIN,
        "started_est": started.isoformat(timespec="seconds"),
        "finished_est": dt.datetime.now(ZoneInfo("America/New_York")).isoformat(
            timespec="seconds"
        ),
        "radar_falls": dict(sorted(res.items())),
        "empty_radar_falls": empty,
    }
    name = f"manifest_{'-'.join(map(str, years))}_{started:%Y%m%dT%H%M}.json"
    (a.root / name).write_text(json.dumps(doc, indent=1) + "\n")
    print(
        f"{len(res)} radar-falls, {sum(r['profiles'] for r in res.values())} profiles, empty: {empty}; {name}"
    )
    if empty:
        raise SystemExit(f"radar-falls with no profiles: {empty}")


if __name__ == "__main__":
    main()
