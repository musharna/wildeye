"""USDA APHIS HPAI detections in wild birds (polygon contract) → public/data/hpai.geojson.

Wave 3 polygon item of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md. APHIS
publishes the wild-bird detection table as a CSV behind its page (`data-csv-url`,
found 2026-09-11 — the ledger's "no official download" was wrong): one row per detection
with state, county, collection/detection dates, strain, species, WOAH class (wild vs
captive wild bird) and sampling method. U.S. Government work, public domain. Counties are
matched by (state name, county name) to the Census 2021 boundary file shared with
pipeline/wastewater.py; unmatched names are counted and logged, never guessed. Output:
one polygon per county with ≥1 detection in the last `--weeks` weeks, weekly bins of
detection counts (by species and WOAH class), plus an all-time total for the info box.
"""

from __future__ import annotations
import argparse
import collections
import csv
import datetime as dt
import io
import logging
import os
import re
import time
import urllib.request
from pathlib import Path
from .atomic import write_atomic
from .wastewater import load_county_shapes, week_ends

log = logging.getLogger("hpai")
CSV_URL = "https://www.aphis.usda.gov/sites/default/files/hpai-wild-birds.csv"
PAGE_URL = "https://www.aphis.usda.gov/livestock-poultry-disease/avian/avian-influenza/hpai-detections/wild-birds"
UA = "wildeye/0.1 (hpai sync)"
DEFAULT_WEEKS = 26
LICENCE = "Public Domain U.S. Government (USDA APHIS)"


def fetch_csv(url: str = CSV_URL, timeout: int = 600) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8-sig")


def _date(s: str) -> dt.date | None:
    try:
        return dt.datetime.strptime((s or "").strip(), "%m/%d/%Y").date()
    except ValueError:
        return None


def parse_rows(text: str) -> tuple[list[dict], dict]:
    """Normalised detections: {state, county, detected, collected, strain, species, captive, method}.
    Rows without a parseable detection date are dropped and counted."""
    out, counts = [], collections.Counter()
    for r in csv.DictReader(io.StringIO(text)):
        counts["rows"] += 1
        d = _date(r.get("Date Detected", ""))
        if d is None:
            counts["no_date"] += 1
            continue
        cls = (r.get("WOAH Classification") or "").strip().lower()
        out.append({
            "state": (r.get("State") or "").strip(),
            "county": (r.get("County") or "").strip(),
            "detected": d,
            "collected": _date(r.get("Collection Date", "")),
            "strain": (r.get("HPAI Strain") or "").strip(),
            "species": (r.get("Bird Species") or "").strip() or "unknown",
            "captive": cls.startswith("captive"),
            "method": (r.get("Sampling Method") or "").strip().lower(),
        })
    return out, dict(counts)


def _norm(name: str) -> str:
    n = name.lower().strip()
    n = re.sub(r"\b(county|parish|borough|census area|municipality|municipio|city and borough)\b", "", n)
    n = n.replace("st.", "saint").replace("ste.", "sainte")
    return re.sub(r"[^a-z0-9]+", "", n)


def county_lookup(shapes: dict[str, dict]) -> dict[tuple[str, str], str]:
    """(state_name, county name) normalised → fips, from the loaded shapes."""
    return {(_norm(v["state_name"]), _norm(v["name"])): fips for fips, v in shapes.items()}


def county_index(rows: list[dict], lookup: dict, today: dt.date, weeks: int) -> tuple[dict, dict]:
    """fips → {n, n_all, species, weeks:[{w, n, captive, sp}]} over `weeks` 7-day bins ending
    today (bin k covers (today-7k-6 … today-7k]). Returns (index, counts)."""
    ends = week_ends(today, weeks)
    counts = collections.Counter()
    unmatched = collections.Counter()
    idx: dict[str, dict] = {}
    for r in rows:
        key = (_norm(r["state"]), _norm(r["county"]))
        fips = lookup.get(key)
        if fips is None:
            counts["unmatched"] += 1
            unmatched[(r["state"], r["county"])] += 1
            continue
        c = idx.setdefault(fips, {"n_all": 0, "bins": [collections.Counter() for _ in range(weeks)],
                                   "captive": [0] * weeks, "species_all": collections.Counter()})
        c["n_all"] += 1
        c["species_all"][r["species"]] += 1
        k = (today - r["detected"]).days // 7
        if k < 0 or k >= weeks:
            counts["outside_window"] += 1
            continue
        counts["in_window"] += 1
        c["bins"][k][r["species"]] += 1
        if r["captive"]:
            c["captive"][k] += 1
    out = {}
    for fips, c in idx.items():
        wk = [{"w": ends[k].isoformat(), "n": sum(c["bins"][k].values()), "captive": c["captive"][k],
               "sp": dict(c["bins"][k].most_common(8))} for k in range(weeks) if c["bins"][k]]
        if not wk:
            continue
        out[fips] = {"n": sum(w["n"] for w in wk), "n_all": c["n_all"],
                     "species": dict(c["species_all"].most_common(8)), "weeks": wk}
    if unmatched:
        log.warning("%d unmatched county names, e.g. %s", sum(unmatched.values()), unmatched.most_common(8))
    counts["counties"] = len(out)
    counts["unmatched_names"] = len(unmatched)
    return out, dict(counts)


def to_features(counties: dict, shapes: dict) -> list[dict]:
    feats = []
    for fips in sorted(counties):
        sh = shapes[fips]
        c = counties[fips]
        feats.append({"type": "Feature", "geometry": sh["geometry"],
                      "properties": {"fips": fips, "name": sh["name"], "st": sh["st"], **c}})
    return feats


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/hpai.geojson"))
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument("--cache", type=Path,
                    default=Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")))
    ap.add_argument("--today", default=None, help="ISO date override (tests)")
    ap.add_argument("--csv", type=Path, default=None, help="local CSV instead of fetching (tests)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    t0 = time.time()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    text = a.csv.read_text(encoding="utf-8-sig") if a.csv else fetch_csv()
    rows, pc = parse_rows(text)
    shapes = load_county_shapes(a.cache / "cb_2021_us_county_20m.zip", None)
    counties, cc = county_index(rows, county_lookup(shapes), today, a.weeks)
    feats = to_features(counties, shapes)
    newest = max((r["detected"] for r in rows), default=None)
    gj = {"type": "FeatureCollection",
          "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
          "source": {"id": "aphis-hpai", "name": "USDA APHIS HPAI detections in wild birds", "url": PAGE_URL,
                     "csv": CSV_URL, "licence": LICENCE,
                     "note": "One row per laboratory-confirmed detection; counts reflect sampling effort as much as virus presence. Captive wild birds (zoos, rehab) are counted separately."},
          "today": today.isoformat(), "newest": newest.isoformat() if newest else None,
          "weeks": [w.isoformat() for w in week_ends(today, a.weeks)],
          "counts": {**pc, **cc}, "features": feats}
    write_atomic(a.out, gj)
    log.info("wrote %s: %d counties, counts=%s, newest=%s (%.0f s)", a.out, len(feats), gj["counts"], newest, time.time() - t0)


if __name__ == "__main__":
    main()
