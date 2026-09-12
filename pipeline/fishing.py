"""Global Fishing Watch apparent fishing effort on a 1° grid (polygon contract) →
public/data/fishing.geojson.

Gap layer (docs/superpowers/plans/2026-09-12-gap-layer-builder-brief.md). The 4Wings report
endpoint of the Global Fishing Watch API v3 (POST /v3/4wings/report) returns AIS-derived
apparent fishing hours per ~0.1° cell (`spatial-resolution=LOW`, "Coarse resolution (~10th
degree)" in the official gfw-api-python-client) with `spatial-aggregation=false`, grouped by
GEARTYPE with `temporal-resolution=ENTIRE`. One report per (week, tile) — 8 tiles of 90° × 90°
cover the globe — so a run is `8 × --weeks` requests (32 for 4 weeks, against a documented
50,000/day), strictly sequential, ≥ 2 s apart, with backoff on 429/5xx. The body is
{"geojson": <Polygon geometry object>} (client model `FourWingsReportBody.geojson:
FourWingsGeometry{type, coordinates}`). 0.1° rows are summed into 1° cells; each cell keeps
weekly bins of hours per gear type.

Dataset version: pinned to the concrete `public-global-fishing-effort:v3.0` (the version the
API documentation's own report response names, read 2026-09-12), never the `latest` alias.
Every response's entry key is checked against it and a mismatch fails loud, so a version bump
surfaces as an error, not as silently different data.

Licence (docs/license-rate-limits, read live 2026-09-12): "The Services are available for
noncommercial use only in accordance with the CC BY-NC 4.0 license, including complying with
the attribution requirements set forth in Section 3 below." Attribution A.1: “Powered by
Global Fishing Watch.” linked to https://globalfishingwatch.org.

Token: `GFW_FISHING_TOKEN`, a personal Global Fishing Watch API access token ("sent as a Bearer
token in the Authorization header", docs/authentication) created at
https://globalfishingwatch.org/our-apis/tokens after agreeing to the terms of use. It is NOT
`GFW_API_KEY`: that is the Global FOREST Watch Data API key used by pipeline/gfw.py (forest
query 403 without it, 200 with it) and the fishing gateway answers it with 401
{"error":"invalid token"} both as a Bearer header and as a query parameter (probed 2026-09-12).
The Bearer header is sent verbatim by urllib (the query-string workaround in gfw.py exists only
for the forest gateway's case-sensitive `x-api-key` header).
"""

from __future__ import annotations
import argparse
import collections
import datetime as dt
import io
import json
import logging
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("fishing")
API = "https://gateway.api.globalfishingwatch.org/v3/4wings/report"
DATASET = "public-global-fishing-effort:v3.0"
UA = "wildeye (github.com/musharna/wildeye)"
TOKEN_ENV = "GFW_FISHING_TOKEN"
TOKEN_URL = "https://globalfishingwatch.org/our-apis/tokens"
LICENCE = "CC BY-NC 4.0 (Global Fishing Watch API terms of use, noncommercial use only)"
ATTRIBUTION = "Powered by Global Fishing Watch"
SOURCE_URL = "https://globalfishingwatch.org"
DEFAULT_WEEKS = 4
MIN_HOURS = 1.0  # drop 1° cells with less than this over the whole window (keeps the file small)
SLEEP = 2.0
# 8 tiles: 4 lon quarters × 2 lat halves; latitudes clamped to ±89.9 to keep the rings off the poles
TILES = [(lon0, lat0) for lon0 in (-180, -90, 0, 90) for lat0 in (-90, 0)]
TILE_DEG = 90
NOTE = (
    "Apparent fishing effort: hours in which a neural net classified AIS vessel movement as fishing. Vessels "
    "without AIS (or with it switched off) are invisible, and gear types are inferred from vessel registries "
    "and movement, so absence of colour is not absence of fishing."
)


def token() -> str:
    t = os.environ.get(TOKEN_ENV)
    if not t:
        raise SystemExit(
            f"{TOKEN_ENV} not set: create a Global Fishing Watch API access token at {TOKEN_URL} "
            f"(GFW_API_KEY is the Global Forest Watch key and is rejected) and store it with "
            f"printf '{TOKEN_ENV}=%s\\n' '<paste>' >> ~/.config/wildeye/env"
        )
    return t


def week_ends(today: dt.date, weeks: int) -> list[dt.date]:
    return [today - dt.timedelta(days=7 * i) for i in range(weeks)]


def tile_geometry(lon0: float, lat0: float, size: float = TILE_DEG) -> dict:
    """One 90° tile as a GeoJSON Polygon geometry object (the report body's `geojson`)."""
    lat1 = min(lat0 + size, 89.9)
    lat0 = max(lat0, -89.9)
    ring = [
        [lon0, lat0],
        [lon0 + size, lat0],
        [lon0 + size, lat1],
        [lon0, lat1],
        [lon0, lat0],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


def report_url(start: dt.date, end: dt.date) -> str:
    q = [
        ("spatial-resolution", "LOW"),
        ("temporal-resolution", "ENTIRE"),
        ("spatial-aggregation", "false"),
        ("group-by", "GEARTYPE"),
        ("datasets[0]", DATASET),
        ("date-range", f"{start.isoformat()},{end.isoformat()}"),
        ("format", "JSON"),
    ]
    return f"{API}?{urllib.parse.urlencode(q)}"


def parse_report(body: bytes, content_type: str) -> dict:
    """JSON body, or a zip holding the JSON (handled defensively; fail loud if it has no .json)."""
    if "zip" in content_type or body[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".json")]
            if not names:
                raise RuntimeError(f"report zip has no .json member: {z.namelist()}")
            return json.loads(z.read(names[0]))
    return json.loads(body)


def _post(
    url: str, geometry: dict, tok: str, timeout: int = 300, tries: int = 4
) -> dict:
    """POST one tile geometry; retry 429 and 5xx/524 with growing backoff, fail loud otherwise."""
    data = json.dumps({"geojson": geometry}).encode()
    for i in range(tries):
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "User-Agent": UA,
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return parse_report(r.read(), r.headers.get("Content-Type", ""))
        except urllib.error.HTTPError as e:
            msg = e.read(400).decode(errors="replace")
            if e.code in (401, 403):
                raise RuntimeError(
                    f"GFW report {e.code}: {msg} (token from {TOKEN_ENV} rejected)"
                ) from e
            if e.code in (429, 500, 502, 503, 504, 524) and i < tries - 1:
                wait = 15 * 2**i
                log.warning(
                    "GFW report %s (%s); retry %d in %ds",
                    e.code,
                    msg[:160],
                    i + 1,
                    wait,
                )
                time.sleep(wait)
                continue
            raise RuntimeError(f"GFW report {e.code} for {url}: {msg}") from e
    raise RuntimeError("unreachable")


def rows_of(report: dict) -> tuple[str | None, list[dict]]:
    """(dataset version, rows) from the documented shape {"entries": [{"<dataset:version>": [row…]}]}."""
    if not isinstance(report, dict) or "entries" not in report:
        raise RuntimeError(f"GFW report without `entries`: {str(report)[:300]}")
    version, rows = None, []
    for entry in report.get("entries") or []:
        for k, v in entry.items():
            if not isinstance(v, list):
                continue
            version = version or k
            rows.extend(v)
    return version, rows


def aggregate(weekly: list[tuple[dt.date, list[dict]]]) -> dict[tuple[int, int], dict]:
    """(ilon, ilat) → {w: {gear: hours}} summing 0.1° rows into 1° cells (floor of lon/lat)."""
    cells: dict[tuple[int, int], dict] = {}
    for end, rows in weekly:
        w = end.isoformat()
        for r in rows:
            lat, lon, h = r.get("lat"), r.get("lon"), r.get("hours")
            if lat is None or lon is None or not h:
                continue
            key = (int(math.floor(float(lon))), int(math.floor(float(lat))))
            if key[0] < -180 or key[0] >= 180 or key[1] < -90 or key[1] >= 90:
                continue
            g = (r.get("geartype") or "unknown").lower()
            cells.setdefault(key, {}).setdefault(w, collections.Counter())[g] += float(
                h
            )
    return cells


def cell_feature(key: tuple[int, int], weeks: dict, ends: list[dt.date]) -> dict:
    ilon, ilat = key
    bins = []
    total = collections.Counter()
    for end in ends:  # newest first, only weeks with effort
        w = end.isoformat()
        if w not in weeks:
            continue
        gear = {g: round(h, 1) for g, h in weeks[w].most_common() if round(h, 1) > 0}
        if not gear:
            continue
        bins.append({"w": w, "hours": round(sum(weeks[w].values()), 1), "gear": gear})
        total.update(weeks[w])
    return {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [ilon, ilat],
                    [ilon + 1, ilat],
                    [ilon + 1, ilat + 1],
                    [ilon, ilat + 1],
                    [ilon, ilat],
                ]
            ],
        },
        "properties": {
            "lon": ilon,
            "lat": ilat,
            "hours": round(sum(total.values()), 1),
            "top": total.most_common(1)[0][0] if total else None,
            "gear": {g: round(h, 1) for g, h in total.most_common()},
            "weeks": bins,
        },
    }


def build(
    weekly: list[tuple[dt.date, list[dict]]],
    ends: list[dt.date],
    min_hours: float = MIN_HOURS,
) -> tuple[list[dict], dict]:
    feats = []
    gears = collections.Counter()
    cells = aggregate(weekly)
    for key in sorted(cells):
        f = cell_feature(key, cells[key], ends)
        if f["properties"]["hours"] < min_hours or not f["properties"]["weeks"]:
            continue
        feats.append(f)
        gears.update(f["properties"]["gear"])
    counts = {
        "cells": len(feats),
        "rows": sum(len(r) for _, r in weekly),
        "hours": round(sum(gears.values()), 1),
        "gears": {g: round(h, 1) for g, h in gears.most_common()},
    }
    return feats, counts


def top_cells(feats: list[dict], max_bytes: int = 95_000) -> list[dict]:
    """Seed subsample: the busiest cells that fit the byte budget (weeks kept intact)."""
    out, size = [], 0
    for f in sorted(feats, key=lambda f: -f["properties"]["hours"]):
        n = len(json.dumps(f, separators=(",", ":"))) + 1
        if size + n > max_bytes:
            break
        out.append(f)
        size += n
    return out


def fetch_all(
    ends: list[dt.date], tok: str, post=_post, sleep: float = SLEEP
) -> tuple[str, list[tuple[dt.date, list[dict]]]]:
    weekly = []
    for end in ends:
        start = end - dt.timedelta(days=6)
        rows = []
        for lon0, lat0 in TILES:
            rep = post(report_url(start, end), tile_geometry(lon0, lat0), tok)
            v, r = rows_of(rep)
            if v is not None and v != DATASET:
                raise RuntimeError(
                    f"requested {DATASET} but the API answered with {v}: update DATASET after reading the release notes"
                )
            rows.extend(r)
            log.info(
                "week %s tile %+d/%+d: %d rows (total %s)",
                end,
                lon0,
                lat0,
                len(r),
                rep.get("total"),
            )
            time.sleep(sleep)
        weekly.append((end, rows))
    return DATASET, weekly


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/fishing.geojson"))
    ap.add_argument(
        "--seed-out",
        type=Path,
        default=None,
        help="also write a < 100 KB top-cells seed here",
    )
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument("--today", default=None)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    tok = token()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    ends = week_ends(today, a.weeks)
    version, weekly = fetch_all(ends, tok)
    feats, counts = build(weekly, ends)
    if not feats:
        raise SystemExit(
            f"no cells with ≥ {MIN_HOURS} h of apparent fishing in {a.weeks} weeks — API returned {counts['rows']} rows"
        )
    doc = {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "id": "fishing",
            "name": "Global Fishing Watch apparent fishing effort",
            "dataset": DATASET,
            "version": version,
            "licence": LICENCE,
            "attribution": ATTRIBUTION,
            "url": SOURCE_URL,
            "api": "https://globalfishingwatch.org/our-apis/documentation#apparent-fishing-effort",
            "note": NOTE,
        },
        "today": today.isoformat(),
        "weeks": [e.isoformat() for e in ends],
        "gears": list(counts["gears"]),
        "counts": counts,
        "features": feats,
    }
    write_atomic(a.out, doc)
    if a.seed_out:
        seed = top_cells(feats)
        write_atomic(
            a.seed_out,
            {
                **doc,
                "source": {
                    **doc["source"],
                    "subsample": f"top {len(seed)} of {len(feats)} 1° cells by hours (seed < 100 KB)",
                },
                "counts": {**counts, "seed_cells": len(seed)},
                "features": seed,
            },
        )
    log.info(
        "wrote %s: %s version=%s (%.0f s)",
        a.out,
        {k: v for k, v in counts.items() if k != "gears"},
        version,
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
