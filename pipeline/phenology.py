"""USA-NPN phenophase status by site (site-series contract) → public/data/phenology.geojson.

Phenophase STATUS, not occurrences (pipeline/occurrences.py already turns status-1 rows for a
few taxa into sightings; this layer is about what observers report across all species). The
USA National Phenology Network status/intensity endpoint
(`observations/getObservations.json`) returns one row per observer visit per individual per
phenophase with `phenophase_status` 1 (phenophase observed, "yes"), 0 (looked, not seen) or
-1 (uncertain). Data are CC BY 4.0 (USA-NPN Data Use Policy, read 2026-09-12); the API asks
for a `request_src` and the attribution policy asks for the acknowledgement in NOTE.

One species-list request plus five observation requests per run (three plant categories;
Activity serves insects and birds, split by the species list's `functional_type`; Development
adds insect emergence — caterpillars, pupae, recently emerged adults — minus "Dead …"
phenophases), each covering the whole `--weeks` window, ≥2 s apart. The category filter is
honoured server-side (probed 2026-09-12: an Activity request returned only Activity ids). One Point per NPN site with weekly bins per class: `yes`
(status 1), `obs` (status 0 or 1, i.e. the phenophase was checked) and the species reported
"yes". Sites with only "no" reports are kept so the client can show "checked, none reported".
"""

from __future__ import annotations
import argparse
import collections
import datetime as dt
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from .atomic import write_atomic
from .wastewater import week_ends

log = logging.getLogger("phenology")
API = "https://services.usanpn.org/npn_portal"
UA = "wildeye (github.com/musharna/wildeye)"
REQUEST_SRC = "wildeye"
LICENCE = "CC BY 4.0 (USA-NPN Data Use Policy)"
NOTE = (
    "Data were provided by the USA National Phenology Network and the many participants who contribute to its "
    "Nature's Notebook program. Status reports are observer visits, not a census: a site with no dot for a class was "
    "not checked for it, and effort differs between sites and weeks."
)
DOI = "https://doi.org/10.5066/F78S4N1V"
DEFAULT_WEEKS = 8
SLEEP = 2.0
RETRIES = 3
MISSING = -9999  # the API's sentinel for absent numbers (elevation, intensity)

# class key → phenophase_category values requested; the Activity request is shared by insects and
# birds and split on the species list's functional_type.
CLASSES = {
    "leaves": {"label": "Leaves", "categories": ("Leaves", "Needles")},
    "flowers": {"label": "Flowers", "categories": ("Flowers", "Pollen cones")},
    "fruits": {"label": "Fruits", "categories": ("Fruits", "Seed cones")},
    "insects": {
        "label": "Insect activity/emergence",
        "categories": ("Activity", "Development"),
        "functional": ("Insect",),
    },
    "birds": {
        # NPN has no "arrival" phenophase; a bird "yes" (Live individuals, Calls or song, …) is presence,
        # so arrival reads as the first week with a yes. Development (nestlings, fledged young) is breeding,
        # not arrival, so birds come from the Activity request only.
        "label": "Birds present/active",
        "categories": ("Activity",),
        "functional": ("Bird",),
    },
}
REQUESTS = (
    ("plants:leaves", ("Leaves", "Needles"), ("leaves",)),
    ("plants:flowers", ("Flowers", "Pollen cones"), ("flowers",)),
    ("plants:fruits", ("Fruits", "Seed cones"), ("fruits",)),
    ("animals:activity", ("Activity",), ("insects", "birds")),
    # insect emergence: Caterpillars, Larvae, Nymphs, Pupae, Recently emerged adults, … (probed 2026-09-12)
    ("animals:development", ("Development",), ("insects",)),
)
# Development phenophases that report mortality ("Dead adults", "Dead caterpillars", …) are not emergence.
DEAD_PREFIX = "Dead "


def _get_json(url: str, timeout: int = 600, retries: int = RETRIES, sleep=time.sleep):
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


def observations_url(
    categories: tuple[str, ...], since: dt.date, until: dt.date
) -> str:
    q = [
        ("request_src", REQUEST_SRC),
        ("start_date", since.isoformat()),
        ("end_date", until.isoformat()),
    ]
    q += [(f"phenophase_category[{i}]", c) for i, c in enumerate(categories)]
    return f"{API}/observations/getObservations.json?{urllib.parse.urlencode(q)}"


def fetch_observations(
    categories: tuple[str, ...], since: dt.date, until: dt.date, fetch=_get_json
) -> list[dict]:
    rows = fetch(observations_url(categories, since, until))
    if not isinstance(rows, list):
        raise RuntimeError(
            f"getObservations for {categories}: expected a list, got {str(rows)[:200]}"
        )
    return rows


def fetch_functional_types(fetch=_get_json) -> dict[int, str]:
    """species_id → functional_type ('Bird', 'Insect', 'Forb', …) from species/getSpecies."""
    rows = fetch(
        f"{API}/species/getSpecies.json?{urllib.parse.urlencode({'request_src': REQUEST_SRC})}"
    )
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("getSpecies returned no species list")
    return {
        int(r["species_id"]): (r.get("functional_type") or "")
        for r in rows
        if r.get("species_id") is not None
    }


def classify(
    row: dict, classes: tuple[str, ...], functional: dict[int, str]
) -> str | None:
    """Class key for a row of a request that serves `classes`; None when the species' functional
    type belongs to none of them (e.g. mammals in the Activity request), or when the phenophase
    reports dead individuals (Development's "Dead adults" is mortality, not emergence)."""
    if str(row.get("phenophase_description") or "").startswith(DEAD_PREFIX):
        return None
    if len(classes) == 1 and "functional" not in CLASSES[classes[0]]:
        return classes[0]
    ft = functional.get(int(row.get("species_id") or 0), "")
    for c in classes:
        if ft in CLASSES[c].get("functional", ()):
            return c
    return None


def aggregate(
    rows_by_class: dict[str, list[dict]], today: dt.date, weeks: int
) -> tuple[list[dict], dict]:
    """rows_by_class = {class key: raw API rows} → (features, counts). Bin k covers the 7 days ending
    today-7k. Status -1 (uncertain) is dropped; status 0 counts as checked; 1 as checked and yes."""
    ends = week_ends(today, weeks)
    sites: dict[int, dict] = {}
    counts = collections.Counter()
    for cls, rows in rows_by_class.items():
        for r in rows:
            st = r.get("phenophase_status")
            if st not in (0, 1):
                counts["uncertain"] += 1
                continue
            try:
                day = dt.date.fromisoformat(str(r.get("observation_date"))[:10])
            except ValueError:
                counts["undated"] += 1
                continue
            k = (today - day).days // 7
            if k < 0 or k >= weeks:
                counts["outside_window"] += 1
                continue
            lat, lon = r.get("latitude"), r.get("longitude")
            if lat in (None, MISSING) or lon in (None, MISSING):
                counts["no_coords"] += 1
                continue
            counts["in_window"] += 1
            s = sites.setdefault(
                int(r["site_id"]),
                {
                    "lat": round(float(lat), 5),
                    "lon": round(float(lon), 5),
                    "st": r.get("state") or None,
                    "yes": [collections.Counter() for _ in range(weeks)],
                    "obs": [collections.Counter() for _ in range(weeks)],
                    "sp": [
                        collections.defaultdict(collections.Counter)
                        for _ in range(weeks)
                    ],
                },
            )
            s["obs"][k][cls] += 1
            if st == 1:
                s["yes"][k][cls] += 1
                s["sp"][k][cls][
                    (
                        r.get("common_name") or f"{r.get('genus')} {r.get('species')}"
                    ).strip()
                ] += 1
    feats = []
    for sid in sorted(sites):
        s = sites[sid]
        wk = []
        for k in range(weeks):
            if not s["obs"][k]:
                continue
            wk.append(
                {
                    "w": ends[k].isoformat(),
                    "yes": dict(s["yes"][k]),
                    "obs": dict(s["obs"][k]),
                    "sp": {c: dict(sp.most_common(5)) for c, sp in s["sp"][k].items()},
                }
            )
        total = collections.Counter()
        for c in s["yes"]:
            total.update(c)
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
                "properties": {
                    "site": sid,
                    "st": s["st"],
                    "n": sum(total.values()),
                    "classes": dict(total),
                    "weeks": wk,
                },
            }
        )
    counts["sites"] = len(feats)
    counts["sites_with_yes"] = sum(1 for f in feats if f["properties"]["n"] > 0)
    for c in CLASSES:
        counts[f"yes_{c}"] = sum(f["properties"]["classes"].get(c, 0) for f in feats)
    return feats, dict(counts)


def collect(
    since: dt.date, until: dt.date, fetch=_get_json, sleep: float = SLEEP
) -> tuple[dict[str, list[dict]], dict]:
    """One species-list call plus one observations call per REQUESTS entry, `sleep` seconds apart."""
    functional = fetch_functional_types(fetch)
    rows_by_class: dict[str, list[dict]] = {c: [] for c in CLASSES}
    raw = {}
    for name, categories, classes in REQUESTS:
        time.sleep(sleep)
        rows = fetch_observations(categories, since, until, fetch)
        raw[name] = len(rows)
        dropped = 0
        for r in rows:
            c = classify(r, classes, functional)
            if c is None:
                dropped += 1
                continue
            rows_by_class[c].append(r)
        log.info("%s: %d rows (%d not in a served class)", name, len(rows), dropped)
        raw[f"{name}:unclassed"] = dropped
    return rows_by_class, raw


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/phenology.geojson"))
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument("--today", default=None)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    since = today - dt.timedelta(days=7 * a.weeks - 1)
    rows_by_class, raw = collect(since, today)
    feats, counts = aggregate(rows_by_class, today, a.weeks)
    if not feats:
        raise SystemExit("no NPN sites with status reports in the window")
    newest = max(
        (
            str(r.get("observation_date"))[:10]
            for rows in rows_by_class.values()
            for r in rows
        ),
        default=None,
    )
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {
                "id": "phenology",
                "name": "USA National Phenology Network, Nature's Notebook status reports",
                "url": "https://www.usanpn.org/data/observational",
                "api": f"{API}/observations/getObservations.json",
                "doi": DOI,
                "licence": LICENCE,
                "note": NOTE,
                "citation": f"USA National Phenology Network. {today.year}. Plant and Animal Phenology Data. Data type: Status and Intensity. "
                f"{since.isoformat()} to {today.isoformat()}. USA-NPN, Tucson, Arizona, USA. Data set accessed {today.isoformat()} at {DOI}",
            },
            "today": today.isoformat(),
            "since": since.isoformat(),
            "newest": newest,
            "weeks": [w.isoformat() for w in week_ends(today, a.weeks)],
            "classes": {k: v["label"] for k, v in CLASSES.items()},
            "counts": {**counts, "raw": raw},
            "features": feats,
        },
    )
    log.info(
        "wrote %s: %d sites, counts=%s, newest=%s (%.0f s)",
        a.out,
        len(feats),
        counts,
        newest,
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
