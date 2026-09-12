"""NEON small-mammal trapping (site-series contract) → public/data/neon.geojson.

Wave 3 site-series reference source (docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md).
NEON data are CC BY 4.0 since 2026-06-30 (previously CC0); the API needs an account token
(`NEON_TOKEN`, sourced from ~/.config/wildeye/env by the runner, never in the browser). Product
DP1.10072.001 "Small mammal box trapping", table `mam_pertrapnight`: one row per trap per night
with `trapStatus` (1 not set … 5 capture, 6 set and empty) and the captured animal's taxon and
tag. Per site and calendar month: trap-nights actually set (status 2–6), captures (status 5),
captures per 100 trap-nights, distinct tagged individuals and a species breakdown. One Point per
NEON site with a monthly series over the last `--months` months. PROVISIONAL rows are used as
NEON publishes them (monthly) and are labelled as such.
"""

from __future__ import annotations
import argparse
import collections
import csv
import datetime as dt
import io
import json
import logging
import os
import time
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("neon")
API = "https://data.neonscience.org/api/v0"
PRODUCT = "DP1.10072.001"
TABLE = "mam_pertrapnight"
UA = "wildeye/0.1 (neon sync)"
LICENCE = "CC BY 4.0 (NEON data licence from 2026-06-30)"
SET_STATUSES = ("2", "3", "4", "5", "6")  # trap was set; "1" = not set


def _token() -> str:
    t = os.environ.get("NEON_TOKEN")
    if not t:
        raise RuntimeError("NEON_TOKEN not set (source ~/.config/wildeye/env)")
    return t


def _get(url: str, timeout: int = 120, token: str | None = None) -> bytes:
    h = {"User-Agent": UA}
    if token:
        h["X-API-Token"] = token
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        return r.read()


def fetch_sites(fetch=None, token: str | None = None) -> list[dict]:
    """Sites carrying PRODUCT with the months it is available: [{code, name, lat, lon, months}]."""
    data = json.loads((fetch or _get)(f"{API}/sites", token=token))["data"]
    out = []
    for s in data:
        for p in s.get("dataProducts", []):
            if p["dataProductCode"] == PRODUCT and p.get("availableMonths"):
                out.append({"code": s["siteCode"], "name": s["siteName"], "lat": s["siteLatitude"], "lon": s["siteLongitude"],
                            "type": s.get("siteType"), "months": sorted(p["availableMonths"])})
    return out


def fetch_month_csv(site: str, month: str, fetch=None, token: str | None = None) -> tuple[str, str] | None:
    """(csv text, release) for the basic mam_pertrapnight file of one site-month, or None when absent."""
    d = json.loads((fetch or _get)(f"{API}/data/{PRODUCT}/{site}/{month}", token=token))["data"]
    files = [f for f in d.get("files", []) if TABLE in f["name"] and ".basic." in f["name"] and f["name"].endswith(".csv")]
    if not files:
        return None
    return (fetch or _get)(files[0]["url"]).decode("utf-8", "replace"), d.get("release", "?")


def month_summary(csv_text: str) -> dict:
    """Trap-nights set, captures, per-100, distinct individuals, species counts (captures only)."""
    set_n = cap = 0
    tags: set[str] = set()
    species: collections.Counter = collections.Counter()
    for r in csv.DictReader(io.StringIO(csv_text)):
        st = (r.get("trapStatus") or "").strip()[:1]
        if st in SET_STATUSES:
            set_n += 1
        if st == "5":
            cap += 1
            sp = (r.get("scientificName") or r.get("taxonID") or "unidentified").strip()
            species[sp] += 1
            if r.get("tagID"):
                tags.add(r["tagID"])
    return {"trapnights": set_n, "captures": cap, "per100": round(100.0 * cap / set_n, 2) if set_n else None,
            "individuals": len(tags), "species": dict(species.most_common(10))}


def recent_months(today: dt.date, n: int) -> list[str]:
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


def build(sites: list[dict], months: list[str], fetch_month=fetch_month_csv, sleep: float = 0.3) -> tuple[list[dict], dict]:
    feats, counts = [], {"sites": 0, "site_months": 0, "captures": 0, "trapnights": 0, "provisional": 0, "empty": 0}
    for s in sites:
        series = []
        for m in months:
            if m not in s["months"]:
                continue
            got = fetch_month(s["code"], m)
            time.sleep(sleep)
            if not got:
                counts["empty"] += 1
                continue
            text, release = got
            summ = month_summary(text)
            if summ["trapnights"] == 0:
                counts["empty"] += 1
                continue
            counts["site_months"] += 1
            counts["captures"] += summ["captures"]
            counts["trapnights"] += summ["trapnights"]
            counts["provisional"] += release == "PROVISIONAL"
            series.append({"m": m, "release": release, **summ})
        if not series:
            continue
        counts["sites"] += 1
        total_sp: collections.Counter = collections.Counter()
        for b in series:
            total_sp.update(b["species"])
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(s["lon"], 5), round(s["lat"], 5)]},
                      "properties": {"site": s["code"], "name": s["name"], "site_type": s["type"],
                                     "species": dict(total_sp.most_common(10)), "months": series}})
    return feats, counts


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/neon.geojson"))
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--today", default=None)
    ap.add_argument("--limit", type=int, default=None, help="max sites (smoke)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    t0 = time.time()
    token = _token()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    months = recent_months(today, a.months)
    sites = fetch_sites(token=token)
    if a.limit:
        sites = sites[: a.limit]
    log.info("%d sites carry %s; months %s..%s", len(sites), PRODUCT, months[-1], months[0])
    feats, counts = build(sites, months, lambda s, m: fetch_month_csv(s, m, token=token))
    if not feats:
        raise SystemExit("no NEON site-months with trapping data")
    write_atomic(a.out, {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"id": "neon", "name": "NSF NEON small mammal box trapping", "product": PRODUCT, "table": TABLE, "licence": LICENCE,
                   "url": f"https://data.neonscience.org/data-products/{PRODUCT}",
                   "citation": f"NEON (National Ecological Observatory Network). Small mammal box trapping ({PRODUCT}), provisional and released data. Dataset accessed from https://data.neonscience.org on {today.isoformat()}.",
                   "note": "Captures per 100 trap-nights within one site over time; sites differ in habitat and effort and are not ranked against each other. PROVISIONAL months may be revised by NEON."},
        "today": today.isoformat(), "months": months, "counts": counts, "features": feats})
    log.info("wrote %s: %s (%.0f s)", a.out, counts, time.time() - t0)


if __name__ == "__main__":
    main()
