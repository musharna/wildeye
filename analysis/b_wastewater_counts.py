"""B feasibility counts: CDC H5 wastewater samples and detections near the 20 wildeye radars, by fall season.

What it does: fetches CDC NWSS H5 wastewater (data.cdc.gov mtpu-urpp, every row) and the Census 2021 county
gazetteer into --cache, places each sewershed at the internal points of the counties it serves, keeps sites with any
served county within 150 km of a radar in pipeline/sites.json, and prints samples, detections and detecting sites per
fall (Aug 1 - Dec 31), for the sources the license policy allows (CDC_Verily, State_Territory) and for all sources.
When to reach for it: to re-check docs/analysis/b-wastewater-feasibility.md against newer data.
Output: tables on stdout. No radar data is read, so it says nothing about migration.
Check: the row total printed must equal the dataset's count(*) (128,361 on 2026-11-08).
"""

import argparse
import collections
import datetime as dt
import json
import math
import subprocess  # nosec B404 - curl with fixed arguments
import zipfile
from pathlib import Path

H5 = "https://data.cdc.gov/resource/mtpu-urpp.json"
GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2021_Gazetteer/2021_Gaz_counties_national.zip"
FIELDS = "site,source,county_fips,sample_collect_date,pcr_target,pcr_target_detect"
PAGE = 50000
R_KM = 150
EXCLUDED = (
    "WastewaterSCAN"  # CC BY-NC (DATA_SOURCES.md); fails the site's license policy
)


def curl(url: str, dest: Path, params: dict | None = None) -> None:
    args = [
        "curl",
        "-s",
        "--fail",
        "--retry",
        "4",
        "--max-time",
        "300",
        "-o",
        str(dest),
    ]
    if params:
        args += ["-G", url] + [
            x for k, v in params.items() for x in ("--data-urlencode", f"{k}={v}")
        ]
    else:
        args.append(url)
    subprocess.run(args, check=True)  # nosec B603 - list argv, no shell; URLs are this file's constants


def fetch(cache: Path) -> tuple[list[dict], dict[str, tuple[float, float]]]:
    cache.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    offset = 0
    while True:
        p = cache / f"h5_{offset}.json"
        if not p.exists():
            q = {
                "$select": FIELDS,
                "$limit": PAGE,
                "$offset": offset,
                "$order": "record_id",
            }
            curl(H5, p, q)
        page = json.loads(p.read_text())
        rows += page
        if len(page) < PAGE:
            break
        offset += PAGE
    z = cache / "gaz.zip"
    if not z.exists():
        curl(GAZ, z)
    cent = {}
    with zipfile.ZipFile(z) as zf:
        lines = zf.read("2021_Gaz_counties_national.txt").decode("utf-8").splitlines()
    head = [h.strip() for h in lines[0].split("\t")]
    for line in lines[1:]:
        p = dict(zip(head, (v.strip() for v in line.split("\t")), strict=True))
        cent[p["GEOID"]] = (float(p["INTPTLAT"]), float(p["INTPTLONG"]))
    return rows, cent


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = (
        math.sin((la2 - la1) / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def fall(day: str) -> int | None:
    return int(day[:4]) if int(day[5:7]) >= 8 else None


def near_radars(rows, cent, radars) -> tuple[dict[str, set[str]], int]:
    # A site's served counties change between rows (sewershed boundaries revised); use every county it ever lists,
    # so the answer does not depend on which row comes last.
    counties: dict[str, set[str]] = collections.defaultdict(set)
    for r in rows:
        counties[r["site"]] |= {
            f.strip().zfill(5)
            for f in str(r.get("county_fips") or "").split(",")
            if f.strip()
        }
    near: dict[str, set[str]] = {}
    unplaced = 0
    for site, fips in counties.items():
        pts = [cent[f] for f in fips if f in cent]
        if not pts:
            unplaced += 1
            continue
        for rad in radars:
            if min(km(p, (rad["lat"], rad["lon"])) for p in pts) <= R_KM:
                near.setdefault(site, set()).add(rad["id"])
    return near, unplaced


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument(
        "--sites",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "pipeline" / "sites.json",
    )
    a = ap.parse_args()
    rows, cent = fetch(a.cache)
    radars = json.loads(a.sites.read_text())
    near, unplaced = near_radars(rows, cent, radars)
    det_all = sum(r["pcr_target_detect"] == "yes" for r in rows)
    print(
        f"rows {len(rows)}, detections {det_all}, sites {len({r['site'] for r in rows})}, "
        f"unplaceable {unplaced}, within {R_KM} km of a radar {len(near)}"
    )
    for label, keep in (
        ("allowed sources", lambda r: r["source"] != EXCLUDED),
        ("all sources", lambda r: True),
    ):
        print(f"\n== {label}: unique sites near any radar, by fall")
        hit_radars = set()
        for y in sorted({fall(r["sample_collect_date"]) for r in rows} - {None}):
            rs = [
                r
                for r in rows
                if keep(r) and r["site"] in near and fall(r["sample_collect_date"]) == y
            ]
            det = [r for r in rs if r["pcr_target_detect"] == "yes"]
            for r in det:
                hit_radars |= near[r["site"]]
            by = collections.Counter(r["site"] for r in det)
            weeks = {
                dt.date.fromisoformat(r["sample_collect_date"][:10]).isocalendar()[:2]
                for r in det
            }
            print(
                f"fall {y}: sites {len({r['site'] for r in rs})}, samples {len(rs)}, detections {len(det)}, "
                f"detecting sites {len(by)}, detection weeks {len(weeks)}, top site {by.most_common(1)}"
            )
        print(
            f"radars with >=1 detection in any fall: {len(hit_radars)}/{len(radars)} {sorted(hit_radars)}"
        )
        print("national detections in falls, by state FIPS prefix:")
        for y in (2024, 2025, 2026):
            st = collections.Counter(
                str(r.get("county_fips") or "")[:2]
                for r in rows
                if keep(r)
                and r["pcr_target_detect"] == "yes"
                and fall(r["sample_collect_date"]) == y
            )
            print(f"  fall {y}: {sum(st.values())} {st.most_common(4)}")


if __name__ == "__main__":
    main()
