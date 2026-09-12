"""OTN acoustic detections (site-series contract) → public/data/otn.geojson.

Wave 2 item 3 of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md. The Ocean
Tracking Network ERDDAP publishes unrestricted detections under CC BY 4.0 (OTN Data
Policy 2024 §4a; users must attribute the data providers and notify OTN of data
products). Detections are events at fixed receivers, never positions between them, so
this pipeline emits one Point per receiver station with a weekly series of detection
counts per species — not tracks. Species comes from the tag-release table joined on
the transmitter name; detections whose transmitter has no public release row are
dropped (counted in `counts.unjoined`) because their species cannot be published.

Public detections lag by the collaborators' embargo (~1 year in 2026), so the layer
carries `data_end` and the client labels the window rather than pretending it is live.
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

log = logging.getLogger("otn")
BASE = "https://erddap.oceantrack.org/erddap/tabledap"
DETECTIONS = "view_otn_aat_detections_stations_projects"
RELEASES = "view_otn_aat_animal_tag_releases"
DET_COLS = (
    "time",
    "latitude",
    "longitude",
    "detection_transmittername",
    "platform_name",
    "project_reference",
)
REL_COLS = ("transmittername", "vernacularname", "scientificname", "project_reference")
PROJ_COLS = (
    "project_reference",
    "project_name",
    "project_citation",
    "project_pi_organization",
    "project_infourl",
)
UA = {"User-Agent": "wildeye/0.1 (otn sync)"}
LICENCE = "CC BY 4.0 (OTN Data Policy 2024 §4a)"
DAY = 86400.0
WEEK_D = 7


RETRIES = 4  # the OTN gateway answers 503/504 intermittently (2026-09-11); back off 30/60/120 s


def _get_json(url: str, timeout: int = 600, retries: int = RETRIES, sleep=time.sleep) -> dict:
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == retries - 1:
                raise
            log.warning("HTTP %d from %s, retry %d/%d", e.code, url[:120], attempt + 1, retries - 1)
            sleep(30 * 2**attempt)
    raise AssertionError("unreachable")


def _rows(table: dict, cols: tuple[str, ...]) -> list[dict]:
    t = table["table"]
    idx = [t["columnNames"].index(c) for c in cols]
    return [dict(zip(cols, (r[i] for i in idx))) for r in t["rows"]]


def fetch_detections(since: str, fetch=_get_json) -> list[dict]:
    """All public detections at/after `since` (ISO date). ERDDAP answers 404 for an empty result."""
    q = ",".join(DET_COLS) + f"&time>={since}T00:00:00Z"
    try:
        return _rows(
            fetch(f"{BASE}/{DETECTIONS}.json?{urllib.parse.quote(q, safe=',&>=:')}"),
            DET_COLS,
        )
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise


def fetch_releases(fetch=_get_json) -> list[dict]:
    q = ",".join(REL_COLS)
    return _rows(fetch(f"{BASE}/{RELEASES}.json?{q}"), REL_COLS)


def fetch_projects(
    detections: list[dict], fetch=_get_json, sleep: float = 1.0
) -> dict[str, dict]:
    """Project metadata for every project seen in `detections`, one narrow query each
    (project filter + the project's newest day). A `distinct()` over the whole view
    504s at the gateway (2026-09-11), so no aggregate query is ever issued."""
    newest: dict[str, str] = {}
    for d in detections:
        pr = d["project_reference"]
        if d["time"] > newest.get(pr, ""):
            newest[pr] = d["time"]
    out: dict[str, dict] = {}
    for pr, t in sorted(newest.items()):
        q = ",".join(PROJ_COLS) + f'&project_reference="{pr}"&time>={t[:10]}T00:00:00Z'
        rows = _rows(
            fetch(f"{BASE}/{DETECTIONS}.json?{urllib.parse.quote(q, safe=',&>=:')}"),
            PROJ_COLS,
        )
        if rows:
            out[pr] = rows[0]
        time.sleep(sleep)
    return out


def species_index(releases: list[dict]) -> dict[str, tuple[str, str]]:
    """transmitter name → (vernacular, scientific). A transmitter reused across releases keeps the first non-empty name."""
    out: dict[str, tuple[str, str]] = {}
    for r in releases:
        tx = (r.get("transmittername") or "").strip()
        if not tx or tx in out:
            continue
        v = (r.get("vernacularname") or "").strip().lower()
        s = (r.get("scientificname") or "").strip()
        if v or s:
            out[tx] = (v or s, s)
    return out


def _parse_time(s: str) -> float:
    return (
        dt.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
        .replace(tzinfo=dt.UTC)
        .timestamp()
    )


def week_ends(data_end: dt.date, weeks: int) -> list[dt.date]:
    """`weeks` 7-day bins ending on `data_end`, newest first (bin k covers (end-7k-6 … end-7k])."""
    return [data_end - dt.timedelta(days=WEEK_D * k) for k in range(weeks)]


def _week_index(day: dt.date, data_end: dt.date) -> int:
    return (data_end - day).days // WEEK_D


def aggregate(
    detections: list[dict],
    species: dict[str, tuple[str, str]],
    weeks: int,
    data_end: dt.date | None = None,
) -> tuple[list[dict], dict]:
    """Station features with weekly per-species counts over the last `weeks` bins.

    Station key = (project, platform_name, lat, lon at 4 dp). `data_end` defaults to the
    newest detection date. Returns (features, counts)."""
    counts = {"rows": len(detections), "joined": 0, "unjoined": 0, "outside_window": 0}
    if not detections:
        return [], counts | {
            "stations": 0,
            "projects": 0,
            "species": 0,
            "data_end": None,
        }
    if data_end is None:
        data_end = dt.datetime.fromtimestamp(
            max(_parse_time(d["time"]) for d in detections), dt.UTC
        ).date()
    stations: dict[tuple, dict] = {}
    for d in detections:
        sp = species.get((d.get("detection_transmittername") or "").strip())
        if sp is None:
            counts["unjoined"] += 1
            continue
        counts["joined"] += 1
        day = dt.datetime.fromtimestamp(_parse_time(d["time"]), dt.UTC).date()
        k = _week_index(day, data_end)
        if k < 0 or k >= weeks:
            counts["outside_window"] += 1
            continue
        lat, lon = round(float(d["latitude"]), 4), round(float(d["longitude"]), 4)
        key = (d["project_reference"], d.get("platform_name") or "", lat, lon)
        st = stations.setdefault(
            key,
            {
                "weeks": [collections.Counter() for _ in range(weeks)],
                "animals": [set() for _ in range(weeks)],
                "sci": {},
            },
        )
        st["weeks"][k][sp[0]] += 1
        st["animals"][k].add(d["detection_transmittername"])
        st["sci"][sp[0]] = sp[1]
    features = []
    ends = week_ends(data_end, weeks)
    for (proj, name, lat, lon), st in sorted(stations.items()):
        total = collections.Counter()
        for c in st["weeks"]:
            total.update(c)
        animals_all = set().union(*st["animals"])
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "station": name,
                    "project": proj,
                    "species": dict(sorted(total.items(), key=lambda kv: -kv[1])),
                    "sci": st["sci"],
                    "animals": len(animals_all),
                    "n": sum(total.values()),
                    "weeks": [
                        {
                            "w": ends[k].isoformat(),
                            "n": dict(st["weeks"][k]),
                            "a": len(st["animals"][k]),
                        }
                        for k in range(weeks)
                        if st["weeks"][k]
                    ],
                },
            }
        )
    all_species = sorted({s for f in features for s in f["properties"]["species"]})
    counts |= {
        "stations": len(features),
        "projects": len({f["properties"]["project"] for f in features}),
        "species": len(all_species),
        "data_end": data_end.isoformat(),
    }
    return features, counts


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/otn.geojson"))
    ap.add_argument(
        "--weeks",
        type=int,
        default=52,
        help="weekly bins kept, ending at the newest public detection",
    )
    ap.add_argument(
        "--lookback-days",
        type=int,
        default=730,
        help="how far back to ask ERDDAP (embargo makes the public tail ~1 y old)",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    since = (
        (dt.datetime.now(dt.UTC) - dt.timedelta(days=a.lookback_days))
        .date()
        .isoformat()
    )
    releases = fetch_releases()
    species = species_index(releases)
    log.info(
        "releases: %d rows, %d transmitters with a species", len(releases), len(species)
    )
    detections = fetch_detections(since)
    log.info(
        "detections since %s: %d rows (%.0f s)",
        since,
        len(detections),
        time.time() - t0,
    )
    if not detections:
        raise SystemExit(f"no public detections since {since}")
    projects = fetch_projects(detections)
    features, counts = aggregate(detections, species, a.weeks)
    used = sorted({f["properties"]["project"] for f in features})
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {
                "id": "otn",
                "name": "Ocean Tracking Network",
                "dataset": DETECTIONS,
                "licence": LICENCE,
                "url": "https://members.oceantrack.org/data/policies",
                "note": "Detections are events at fixed receivers, not positions between them. Public data lag the collaborators' embargo; species from the public tag-release table only.",
            },
            "data_end": counts["data_end"],
            "weeks": a.weeks,
            "since": since,
            "species": sorted(
                {s for f in features for s in f["properties"]["species"]}
            ),
            "projects": {
                p: {k: (projects.get(p) or {}).get(k) for k in PROJ_COLS[1:]}
                for p in used
            },
            "counts": counts,
            "features": features,
        },
    )
    log.info("wrote %s: %s (%.0f s)", a.out, counts, time.time() - t0)


if __name__ == "__main__":
    main()
