"""Global Forest Watch integrated deforestation alerts by country (polygon contract) →
public/data/gfw.geojson.

Wave 4 (credentialed) of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md. The GFW
Data API key (`GFW_API_KEY`, minted 2026-09-12, sourced from ~/.config/wildeye/env by the
runner) queries the precomputed table `gadm__integrated_alerts__iso_daily_alerts` (CC BY 4.0
per the dataset's metadata licence, read 2026-09-12): one aggregate per country per week
for the last `--weeks` weeks, medium/high confidence only. Country polygons are Natural Earth
110m admin-0 (public domain), matched on ISO3 (`ADM0_A3`, which is set where `ISO_A3` is
-99). Fill is alert area per 10,000 km² of the country so large countries do not dominate.
Never use the `latest` version alias: it answers with a 307 that drops the key header —
resolve the newest version from the dataset's metadata first.
"""

from __future__ import annotations
import argparse
import collections
import datetime as dt
import json
import logging
import math
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("gfw")
API = "https://data-api.globalforestwatch.org"
DATASET = "gadm__integrated_alerts__iso_daily_alerts"
NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
UA = "wildeye/0.1 (gfw sync)"
LICENCE = "CC BY 4.0 (GFW integrated deforestation alerts; dataset metadata licence)"
DEFAULT_WEEKS = 12
EARTH_R_KM = 6371.0088


def _key() -> str:
    k = os.environ.get("GFW_API_KEY")
    if not k:
        raise RuntimeError("GFW_API_KEY not set (source ~/.config/wildeye/env)")
    return k


def with_key(url: str, key: str | None) -> str:
    """The GFW gateway matches the `x-api-key` HEADER case-sensitively and urllib capitalises
    header names (`X-api-key` → 403 "missing valid API key", 2026-09-12), so the key goes in
    the query string, which the API also accepts."""
    if not key:
        return url
    return f"{url}{'&' if '?' in url else '?'}{urllib.parse.urlencode({'x-api-key': key})}"


def _get_json(url: str, key: str | None = None, timeout: int = 300) -> dict:
    req = urllib.request.Request(with_key(url, key), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def latest_version(fetch=_get_json, key: str | None = None) -> str:
    d = fetch(f"{API}/dataset/{DATASET}", key)["data"]
    versions = [v for v in d.get("versions", []) if v.startswith("v")]
    if not versions:
        raise RuntimeError(f"{DATASET}: no versions listed")
    return sorted(versions)[-1]


def week_ends(today: dt.date, weeks: int) -> list[dt.date]:
    return [today - dt.timedelta(days=7 * i) for i in range(weeks)]


def query_week(version: str, end: dt.date, key: str, fetch=_get_json) -> dict[str, dict]:
    """iso → {n, ha} for the 7 days ending on `end` (inclusive), confidence != low."""
    start = end - dt.timedelta(days=6)
    sql = (f"SELECT iso, SUM(alert__count) AS n, SUM(alert_area__ha) AS ha FROM data "
           f"WHERE gfw_integrated_alerts__date >= '{start.isoformat()}' AND gfw_integrated_alerts__date <= '{end.isoformat()}' "
           f"AND gfw_integrated_alerts__confidence != 'low' GROUP BY iso")
    d = fetch(f"{API}/dataset/{DATASET}/{version}/query/json?{urllib.parse.urlencode({'sql': sql})}", key)
    if d.get("status") != "success":
        raise RuntimeError(f"GFW query failed for week ending {end}: {d.get('message')}")
    return {r["iso"]: {"n": int(r.get("n") or 0), "ha": round(float(r.get("ha") or 0), 2)} for r in d.get("data", []) if r.get("iso")}


def ring_area_km2(ring: list) -> float:
    """Spherical polygon area (km²) of one lon/lat ring; sign-free."""
    if len(ring) < 3:
        return 0.0
    tot = 0.0
    for i in range(len(ring)):
        lon1, lat1 = map(math.radians, ring[i][:2])
        lon2, lat2 = map(math.radians, ring[(i + 1) % len(ring)][:2])
        tot += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
    return abs(tot) * EARTH_R_KM ** 2 / 2


def geometry_area_km2(geom: dict) -> float:
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return sum(ring_area_km2(p[0]) - sum(ring_area_km2(h) for h in p[1:]) for p in polys)


def _rnd(c, nd=2):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [_rnd(x, nd) for x in c]


def load_countries(path: Path, fetch_bytes=None) -> dict[str, dict]:
    """ISO3 → {name, area_km2, geometry} from the Natural Earth 110m admin-0 file (cached)."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        data = fetch_bytes(NE_URL) if fetch_bytes else urllib.request.urlopen(urllib.request.Request(NE_URL, headers={"User-Agent": UA}), timeout=120).read()
        path.write_bytes(data)
    out = {}
    for f in json.loads(path.read_text())["features"]:
        p = f["properties"]
        iso = p.get("ISO_A3") if p.get("ISO_A3") not in (None, "-99") else p.get("ADM0_A3")
        if not iso or iso == "-99":
            continue
        out[iso] = {"name": p.get("ADMIN") or p.get("NAME"), "area_km2": round(geometry_area_km2(f["geometry"])),
                    "geometry": {"type": f["geometry"]["type"], "coordinates": _rnd(f["geometry"]["coordinates"])}}
    return out


def build(weekly: list[tuple[dt.date, dict]], countries: dict) -> tuple[list[dict], dict]:
    """weekly = [(week_end, iso→{n,ha})] newest first → features for countries with ≥1 alert."""
    per: dict[str, list] = collections.defaultdict(list)
    for end, rows in weekly:
        for iso, v in rows.items():
            if v["n"] > 0:
                per[iso].append({"w": end.isoformat(), **v})
    feats, missing = [], []
    for iso in sorted(per):
        c = countries.get(iso)
        if not c:
            missing.append(iso)
            continue
        n = sum(w["n"] for w in per[iso])
        ha = round(sum(w["ha"] for w in per[iso]), 1)
        feats.append({"type": "Feature", "geometry": c["geometry"],
                      "properties": {"iso": iso, "name": c["name"], "area_km2": c["area_km2"], "n": n, "ha": ha,
                                     "ha_per_1e4km2": round(ha / (c["area_km2"] / 1e4), 2) if c["area_km2"] else None,
                                     "weeks": per[iso]}})
    if missing:
        log.warning("%d ISO codes without a Natural Earth shape: %s", len(missing), missing[:12])
    return feats, {"countries": len(feats), "missing_shape": len(missing), "alerts": sum(f["properties"]["n"] for f in feats)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/gfw.geojson"))
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument("--cache", type=Path, default=Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")))
    ap.add_argument("--today", default=None)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    t0 = time.time()
    key = _key()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    version = latest_version(key=key)
    ends = week_ends(today, a.weeks)
    weekly = []
    for end in ends:
        weekly.append((end, query_week(version, end, key)))
        time.sleep(0.5)
    countries = load_countries(a.cache / "ne_110m_admin_0_countries.geojson")
    feats, counts = build(weekly, countries)
    if not feats:
        raise SystemExit("no countries with alerts")
    write_atomic(a.out, {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"id": "gfw", "name": "Global Forest Watch integrated deforestation alerts", "dataset": DATASET, "version": version, "licence": LICENCE,
                   "url": "https://www.globalforestwatch.org/map/?layers=integrated-alerts", "shapes": "Natural Earth 110m admin-0 (public domain)",
                   "note": "Weekly sums of GLAD-L, GLAD-S2 and RADD alerts (medium + high confidence) per country; density = alert area per 10,000 km² of the country. Alerts flag likely tree-cover disturbance, not confirmed deforestation."},
        "today": today.isoformat(), "weeks": [e.isoformat() for e in ends], "counts": counts, "features": feats})
    log.info("wrote %s: %s version=%s (%.0f s)", a.out, counts, version, time.time() - t0)


if __name__ == "__main__":
    main()
