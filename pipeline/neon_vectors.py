"""NEON ticks (DP1.10093.001) + mosquitoes (DP1.10043.001) — site-series contract → public/data/neon-vectors.geojson.

Clone of pipeline/neon.py for two vector products. NEON data are CC BY 4.0 since 2026-06-30 (previously CC0;
NEON blog "Logins Required and Data Licensing Updated", read live 2026-09-12). The API needs an account token
(`NEON_TOKEN`, sourced from ~/.config/wildeye/env by the runner, never in the browser).

Ticks — table `tck_fielddata`: one row per drag-cloth sampling of one plot with `totalSampledArea` (m²) and
`samplingImpractical` ("OK" when the drag happened). The field-count columns (adultCount/nymphCount/larvaCount)
are EMPTY in current data — ticks are counted in the lab, so counts come from `tck_taxonomyProcessed`
(`individualCount` per `sexOrAge` Nymph/Larva/Female/Male and `genus`). That table lags the field table by
months: a month with drags but no lab table yet is emitted as `pending` (effort known, count unknown).
Rate: ticks per 1000 m² dragged.

Mosquitoes — table `mos_trapping`: one row per CO2 trap deployment with `trapHours` and `samplingImpractical`
("OK" when the trap ran; failed deployments carry 0.0 h). `mos_sorting` gives `proportionIdentified` per
subsample; `mos_expertTaxonomistIDProcessed` gives `individualCount` + `genus` per identified subsample. Estimated
catch = identified / proportionIdentified. Rate: mosquitoes per trap-night, where one trap-night = 24 trap-hours
(effort = trap hours; NEON traps run ~12 h day + ~12 h night in one deployment).

One Point per NEON site with, for each product, a monthly series over the newest `--months` months that carry
data anywhere in the network (NEON releases lag a few months). PROVISIONAL rows are used as published and
labelled as such.
"""

from __future__ import annotations
import argparse
import collections
import concurrent.futures
import csv
import datetime as dt
import io
import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("neon_vectors")
API = "https://data.neonscience.org/api/v0"
UA = "wildeye (github.com/musharna/wildeye)"
LICENCE = "CC BY 4.0 (NEON data licence from 2026-06-30)"
PRODUCTS = {
    "ticks": {
        "code": "DP1.10093.001",
        "tables": ("tck_fielddata", "tck_taxonomyProcessed"),
    },
    "mosquitoes": {
        "code": "DP1.10043.001",
        "tables": ("mos_trapping", "mos_sorting", "mos_expertTaxonomistIDProcessed"),
    },
}
TRAPNIGHT_HOURS = 24.0
STAGES = {
    "Nymph": "nymph",
    "Larva": "larva",
    "Female": "adult",
    "Male": "adult",
    "Adult": "adult",
}
RETRIES = 4


def _token() -> str:
    t = os.environ.get("NEON_TOKEN")
    if not t:
        raise RuntimeError("NEON_TOKEN not set (source ~/.config/wildeye/env)")
    return t


def _get(
    url: str, timeout: int = 120, token: str | None = None, sleep=time.sleep
) -> bytes:
    """GET with the repo UA; 5xx and transport errors (a transient 'Network is unreachable' mid-run on
    2026-09-12 killed the first live run) retried with backoff (otn.py pattern), 4xx raised at once."""
    h = {"User-Agent": UA}
    if token:
        h["X-API-Token"] = token
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=h), timeout=timeout
            ) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == RETRIES - 1:
                raise
            log.warning(
                "HTTP %d from %s, retry %d/%d",
                e.code,
                url[:120],
                attempt + 1,
                RETRIES - 1,
            )
            sleep(5 * 2**attempt)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == RETRIES - 1:
                raise
            log.warning(
                "%s from %s, retry %d/%d", e, url[:120], attempt + 1, RETRIES - 1
            )
            sleep(5 * 2**attempt)
    raise AssertionError("unreachable")


def fetch_sites(fetch=None, token: str | None = None) -> list[dict]:
    """Sites carrying either product: [{code, name, lat, lon, type, months: {ticks: [...], mosquitoes: [...]}}]."""
    data = json.loads((fetch or _get)(f"{API}/sites", token=token))["data"]
    codes = {v["code"]: k for k, v in PRODUCTS.items()}
    out = []
    for s in data:
        months = {}
        for p in s.get("dataProducts", []):
            k = codes.get(p["dataProductCode"])
            if k and p.get("availableMonths"):
                months[k] = sorted(p["availableMonths"])
        if months:
            out.append(
                {
                    "code": s["siteCode"],
                    "name": s["siteName"],
                    "lat": s["siteLatitude"],
                    "lon": s["siteLongitude"],
                    "type": s.get("siteType"),
                    "months": months,
                }
            )
    return out


def fetch_month_tables(
    kind: str, site: str, month: str, fetch=None, token: str | None = None
) -> tuple[dict[str, str], str]:
    """({table: csv text} for the basic files present, release) of one product/site/month. Absent tables are absent keys."""
    prod = PRODUCTS[kind]
    d = json.loads(
        (fetch or _get)(f"{API}/data/{prod['code']}/{site}/{month}", token=token)
    )["data"]
    tables: dict[str, str] = {}
    for tbl in prod["tables"]:
        files = [
            f
            for f in d.get("files", [])
            if f".{tbl}." in f["name"]
            and ".basic." in f["name"]
            and f["name"].endswith(".csv")
        ]
        if files:
            tables[tbl] = (fetch or _get)(files[0]["url"]).decode("utf-8", "replace")
    return tables, d.get("release", "?")


def _rows(text: str | None) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text))) if text else []


def _num(v) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except ValueError:
        return 0.0


def tick_summary(tables: dict[str, str]) -> dict | None:
    """Drags with sampled area, total ticks per 1000 m², life stages and genera. None when no drag happened.
    Without the lab table the month is `pending` (count None)."""
    drags = area = 0.0
    for r in _rows(tables.get("tck_fielddata")):
        if (r.get("samplingImpractical") or "").strip() != "OK":
            continue
        a = _num(r.get("totalSampledArea"))
        if a <= 0:
            continue
        drags += 1
        area += a
    if not drags:
        return None
    out = {
        "drags": int(drags),
        "area_m2": round(area),
        "count": None,
        "per1000": None,
        "stages": {},
        "genera": {},
        "pending": True,
    }
    if "tck_taxonomyProcessed" not in tables:
        return out
    stages: collections.Counter = collections.Counter()
    genera: collections.Counter = collections.Counter()
    total = 0
    for r in _rows(tables["tck_taxonomyProcessed"]):
        n = int(_num(r.get("individualCount")))
        if n <= 0:
            continue
        total += n
        stages[STAGES.get((r.get("sexOrAge") or "").strip(), "unknown")] += n
        genera[(r.get("genus") or "").strip() or "unidentified"] += n
    out.update(
        {
            "count": total,
            "per1000": round(1000.0 * total / area, 2),
            "stages": dict(stages.most_common()),
            "genera": dict(genera.most_common(8)),
            "pending": False,
        }
    )
    return out


def mosquito_summary(tables: dict[str, str]) -> dict | None:
    """Trap deployments that ran (hours), estimated catch (identified / proportionIdentified) per trap-night of
    24 trap-hours, genera. None when no trap ran. Without the taxonomist table the month is `pending`."""
    nights = hours = 0.0
    for r in _rows(tables.get("mos_trapping")):
        h = _num(r.get("trapHours"))
        if (r.get("samplingImpractical") or "").strip() != "OK" or h <= 0:
            continue
        nights += 1
        hours += h
    if not nights:
        return None
    out = {
        "traps": int(nights),
        "trap_hours": round(hours, 1),
        "count": None,
        "per_trapnight": None,
        "genera": {},
        "pending": True,
    }
    if "mos_expertTaxonomistIDProcessed" not in tables:
        return out
    sorting = _rows(tables.get("mos_sorting"))
    prop = {
        r["subsampleID"]: _num(r.get("proportionIdentified")) or 1.0
        for r in sorting
        if r.get("subsampleID")
    }
    # Each subsample is scaled by its own proportionIdentified. That is right only while every field
    # sample has ONE sorted subsample (true for all 688 samples across 46 sites, checked 2026-09-12);
    # split samples would each be scaled up to the whole sample and over-count, so say so loudly.
    per_sample = collections.Counter(r.get("sampleID") for r in sorting if r.get("sampleID"))
    split = sorted(k for k, v in per_sample.items() if v > 1)
    if split:
        log.warning(
            "%d mosquito samples have more than one sorted subsample (per-subsample scaling may over-count): %s",
            len(split),
            split[:5],
        )
    genera: collections.Counter = collections.Counter()
    total = 0.0
    for r in _rows(tables["mos_expertTaxonomistIDProcessed"]):
        n = _num(r.get("individualCount"))
        if n <= 0:
            continue
        est = n / prop.get(r.get("subsampleID"), 1.0)
        total += est
        genera[(r.get("genus") or "").strip() or "unidentified"] += est
    out.update(
        {
            "count": round(total),
            "per_trapnight": round(total / (hours / TRAPNIGHT_HOURS), 2),
            "genera": {k: round(v) for k, v in genera.most_common(8)},
            "pending": False,
        }
    )
    return out


SUMMARY = {"ticks": tick_summary, "mosquitoes": mosquito_summary}


def data_months(sites: list[dict], kind: str, today: dt.date, n: int) -> list[str]:
    """Newest `n` months (≤ today's month) that any site lists for `kind`, newest first."""
    cap = today.strftime("%Y-%m")
    allm = {m for s in sites for m in s["months"].get(kind, []) if m <= cap}
    return sorted(allm, reverse=True)[:n]


def build(
    sites: list[dict],
    months: dict[str, list[str]],
    fetch_month=fetch_month_tables,
    sleep: float = 0.2,
    workers: int = 4,
) -> tuple[list[dict], dict]:
    counts = {
        "sites": 0,
        "site_months": 0,
        "pending": 0,
        "provisional": 0,
        "empty": 0,
        "ticks": 0,
        "mosquitoes": 0,
    }
    jobs = [
        (s, k, m)
        for s in sites
        for k in PRODUCTS
        for m in months[k]
        if m in s["months"].get(k, [])
    ]

    def one(job):
        s, k, m = job
        tables, release = fetch_month(k, s["code"], m)
        time.sleep(sleep)
        return job, SUMMARY[k](tables), release

    per_site: dict[str, dict[str, list]] = collections.defaultdict(
        lambda: {k: [] for k in PRODUCTS}
    )
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for (s, k, m), summ, release in ex.map(one, jobs):
            if summ is None:
                counts["empty"] += 1
                continue
            counts["site_months"] += 1
            counts["pending"] += summ["pending"]
            counts["provisional"] += release == "PROVISIONAL"
            counts[k] += summ["count"] or 0
            per_site[s["code"]][k].append({"m": m, "release": release, **summ})
    feats = []
    for s in sites:
        series = per_site.get(s["code"])
        if not series or not any(series.values()):
            continue
        counts["sites"] += 1
        for k in series:
            series[k].sort(key=lambda b: b["m"], reverse=True)
        stages: collections.Counter = collections.Counter()
        genera = {k: collections.Counter() for k in PRODUCTS}
        for b in series["ticks"]:
            stages.update(b["stages"])
            genera["ticks"].update(b["genera"])
        for b in series["mosquitoes"]:
            genera["mosquitoes"].update(b["genera"])
        feats.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(s["lon"], 5), round(s["lat"], 5)],
                },
                "properties": {
                    "site": s["code"],
                    "name": s["name"],
                    "site_type": s["type"],
                    "stages": dict(stages.most_common()),
                    "genera": {k: dict(v.most_common(8)) for k, v in genera.items()},
                    "ticks": series["ticks"],
                    "mosquitoes": series["mosquitoes"],
                },
            }
        )
    return feats, counts


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--out", type=Path, default=Path("public/data/neon-vectors.geojson")
    )
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--today", default=None)
    ap.add_argument("--limit", type=int, default=None, help="max sites (smoke)")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    token = _token()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    sites = fetch_sites(token=token)
    if a.limit:
        sites = sites[: a.limit]
    months = {k: data_months(sites, k, today, a.months) for k in PRODUCTS}
    for k, ms in months.items():
        log.info(
            "%s: %d sites, months %s..%s",
            k,
            sum(k in s["months"] for s in sites),
            ms[-1] if ms else "-",
            ms[0] if ms else "-",
        )
    feats, counts = build(
        sites,
        months,
        lambda k, s, m: fetch_month_tables(k, s, m, token=token),
        workers=a.workers,
    )
    if not feats:
        raise SystemExit("no NEON site-months with tick or mosquito sampling")
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {
                "id": "neon-vectors",
                "name": "NSF NEON ticks and mosquitoes",
                "licence": LICENCE,
                "products": {k: v["code"] for k, v in PRODUCTS.items()},
                "url": "https://data.neonscience.org/data-products/DP1.10093.001",
                "url_mosquitoes": "https://data.neonscience.org/data-products/DP1.10043.001",
                "citation": f"NEON (National Ecological Observatory Network). Ticks sampled using drag cloths (DP1.10093.001) and Mosquitoes sampled from CO2 traps (DP1.10043.001), provisional and released data. Dataset accessed from https://data.neonscience.org on {today.isoformat()}.",
                "note": "Ticks per 1000 m² dragged (lab-identified counts; months awaiting identification are pending) and mosquitoes per trap-night of 24 trap-hours (identified count scaled by the sorted proportion), each within one site over time; sites differ in habitat and effort and are not ranked against each other. PROVISIONAL months may be revised by NEON.",
            },
            "today": today.isoformat(),
            "months": months,
            "counts": counts,
            "features": feats,
        },
    )
    log.info("wrote %s: %s (%.0f s)", a.out, counts, time.time() - t0)


if __name__ == "__main__":
    main()
