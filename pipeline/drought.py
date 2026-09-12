"""U.S. Drought Monitor weekly drought categories D0–D4 (polygon contract) →
public/data/drought.geojson.

The USDM (National Drought Mitigation Center, USDA, NOAA, NASA) publishes one map per week,
valid on a Tuesday and released the following Thursday. The GIS page
(https://droughtmonitor.unl.edu/DmData/GISData.aspx) builds its download table from
`GISData.aspx/ReturnDMWeeks` (a JSON list of YYYYMMDD map dates, newest first — read live
2026-09-12) and links the weekly GeoJSON as `/data/json/usdm_<YYYYMMDD>.json` (plus
`usdm_current.json` for the newest). Each weekly file has five MultiPolygon features
(`DM` 0–4, ~250k vertices, ~27 MB), so this keeps the newest `--weeks` releases, simplifies
each to ~0.02° and drops slivers so five weeks stay well under 6 MB, and writes one feature
per (week, category). The client selects the release whose Thursday is ≤ the observed time.
Credit line is quoted verbatim from https://droughtmonitor.unl.edu/About/Permission.aspx.
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import logging
import math
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("drought")
SITE = "https://droughtmonitor.unl.edu"
WEEKS_API = f"{SITE}/DmData/GISData.aspx/ReturnDMWeeks"
JSON_URL = f"{SITE}/data/json/usdm_{{ymd}}.json"
UA = "wildeye (github.com/musharna/wildeye)"
DEFAULT_WEEKS = 5
TOLERANCE_DEG = 0.02
MIN_AREA_DEG2 = 0.002
SEED_TOLERANCE_DEG = 0.2
SEED_MIN_AREA_DEG2 = 0.08
RELEASE_LAG_DAYS = 2  # map valid Tuesday, released Thursday
LICENCE = ("No licence stated; permission page (read 2026-09-12): \"If you reproduce the U.S. Drought Monitor map, please use this wording:\" + the credit line (droughtmonitor.unl.edu/About/Permission.aspx)")
CREDIT = (
    "The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of "
    "Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric "
    "Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC."
)
CATEGORIES = {
    0: "Abnormally dry",
    1: "Moderate drought",
    2: "Severe drought",
    3: "Extreme drought",
    4: "Exceptional drought",
}
EARTH_R_KM = 6371.0088


def _get(url: str, timeout: int = 300, tries: int = 4) -> bytes:
    """GET with UA; retries 5xx / connection errors with backoff, never swallows a 4xx."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    for k in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or k == tries - 1:
                raise
            log.warning("%s → HTTP %s, retry %d", url, e.code, k + 1)
        except (urllib.error.URLError, TimeoutError) as e:
            if k == tries - 1:
                raise
            log.warning("%s → %s, retry %d", url, e, k + 1)
        time.sleep(2 ** (k + 1))
    raise AssertionError("unreachable")


def list_weeks(n: int, fetch=_get) -> list[str]:
    """Newest `n` map dates (YYYYMMDD, newest first) from the GIS page's own week list."""
    d = json.loads(fetch(WEEKS_API))
    ymds = [str(x) for x in d.get("d") or []]
    if not ymds:
        raise RuntimeError("ReturnDMWeeks returned no weeks")
    ymds.sort(reverse=True)
    return ymds[:n]


def ymd_to_date(ymd: str) -> dt.date:
    return dt.date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8]))


def fetch_week(ymd: str, cache: Path, fetch=_get, sleep: float = 2.0) -> dict:
    """Weekly FeatureCollection, cached on disk (files are immutable once released)."""
    p = cache / f"usdm_{ymd}.json"
    if not p.exists():
        cache.mkdir(parents=True, exist_ok=True)
        data = fetch(JSON_URL.format(ymd=ymd))
        gj = json.loads(
            data
        )  # validate before caching so a 200 with an error page is not kept
        if gj.get("type") != "FeatureCollection":
            raise RuntimeError(f"usdm_{ymd}.json is not a FeatureCollection")
        p.write_bytes(data)
        time.sleep(sleep)
        return gj
    return json.loads(p.read_text())


# --- geometry --------------------------------------------------------------------------------


def ring_area_km2(ring: list) -> float:
    if len(ring) < 3:
        return 0.0
    tot = 0.0
    for i in range(len(ring)):
        lon1, lat1 = map(math.radians, ring[i][:2])
        lon2, lat2 = map(math.radians, ring[(i + 1) % len(ring)][:2])
        tot += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
    return abs(tot) * EARTH_R_KM**2 / 2


def multipolygon_area_km2(coords: list) -> float:
    return sum(
        ring_area_km2(p[0]) - sum(ring_area_km2(h) for h in p[1:]) for p in coords
    )


def _ring_area_deg2(ring: list) -> float:
    return (
        abs(
            sum(
                ring[i][0] * ring[(i + 1) % len(ring)][1]
                - ring[(i + 1) % len(ring)][0] * ring[i][1]
                for i in range(len(ring))
            )
        )
        / 2
    )


def _dp(pts: list, tol: float) -> list:
    """Douglas–Peucker on an open polyline (pure python, iterative)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, bi = d, i
        if best > tol and bi > 0:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def _simplify_ring_py(ring: list, tol: float) -> list | None:
    pts = [list(p[:2]) for p in ring]
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    out = _dp(pts[:-1], tol)
    out.append(out[0])
    return out if len(out) >= 4 else None


def simplify_multipolygon(coords: list, tol: float, min_area: float) -> list:
    """Simplified MultiPolygon coordinates; parts with outer-ring area < min_area deg² dropped.
    shapely (topology-preserving) when importable, else pure-python Douglas–Peucker per ring."""
    try:
        import shapely
        from shapely.geometry import MultiPolygon, Polygon, mapping
    except ImportError:  # exercised by the test that blocks the shapely import
        return _simplify_pure(coords, tol, min_area)
    g = MultiPolygon([(p[0], p[1:]) for p in coords]).buffer(0)
    s = shapely.simplify(g, tol, preserve_topology=True)
    parts = list(s.geoms) if isinstance(s, MultiPolygon) else [s]
    out = [
        mapping(p)["coordinates"]
        for p in parts
        if isinstance(p, Polygon) and p.area >= min_area
    ]
    return [[[list(c) for c in r] for r in p] for p in out]


def _simplify_pure(coords: list, tol: float, min_area: float) -> list:
    """Pure-python fallback: Douglas–Peucker per ring, parts below min_area deg² dropped."""
    out = []
    for poly in coords:
        rings = [r for r in (_simplify_ring_py(ring, tol) for ring in poly) if r]
        if rings and _ring_area_deg2(rings[0]) >= min_area:
            out.append(rings)
    return out


def _rnd(c, nd=3):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [_rnd(x, nd) for x in c]


# --- assembly ---------------------------------------------------------------------------------


def week_features(
    ymd: str,
    gj: dict,
    tol: float = TOLERANCE_DEG,
    min_area: float = MIN_AREA_DEG2,
    nd: int = 3,
) -> list[dict]:
    """One feature per DM category present in a weekly file (`DM` 0–4, from the real file's properties)."""
    w = ymd_to_date(ymd)
    released = w + dt.timedelta(days=RELEASE_LAG_DAYS)
    feats = []
    for f in sorted(gj.get("features") or [], key=lambda f: f["properties"]["DM"]):
        dm = int(f["properties"]["DM"])
        if dm not in CATEGORIES:
            raise RuntimeError(f"usdm_{ymd}: unexpected DM={dm}")
        g = f["geometry"]
        coords = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        area = round(multipolygon_area_km2(coords))
        simp = simplify_multipolygon(coords, tol, min_area)
        if not simp:
            log.warning(
                "usdm_%s D%d vanished after simplification (area %d km²)", ymd, dm, area
            )
            continue
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": _rnd(simp, nd)},
                "properties": {
                    "w": w.isoformat(),
                    "released": released.isoformat(),
                    "dm": dm,
                    "label": f"D{dm} {CATEGORIES[dm]}",
                    "area_km2": area,
                    "parts": len(simp),
                },
            }
        )
    if not feats:
        raise RuntimeError(f"usdm_{ymd}: no categories")
    return feats


def collection(
    weeks: list[str],
    per_week: dict[str, list[dict]],
    today: dt.date,
    note_extra: str = "",
) -> dict:
    ws = [
        {
            "w": ymd_to_date(y).isoformat(),
            "released": (
                ymd_to_date(y) + dt.timedelta(days=RELEASE_LAG_DAYS)
            ).isoformat(),
        }
        for y in weeks
    ]
    feats = [f for y in weeks for f in per_week[y]]
    return {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "id": "drought",
            "name": "U.S. Drought Monitor",
            "url": f"{SITE}/",
            "api": JSON_URL.format(ymd="<YYYYMMDD>"),
            "licence": LICENCE,
            "credit": CREDIT,
            "note": (
                "Weekly map valid on the Tuesday (w), released the Thursday (released). Categories D0–D4 per the official "
                "USDM classification; geometry simplified to ~0.02° with slivers removed, so boundaries are approximate. "
                + note_extra
            ).strip(),
        },
        "today": today.isoformat(),
        "newest": ws[0]["w"],
        "weeks": ws,
        "counts": {
            "weeks": len(weeks),
            "features": len(feats),
            "parts": sum(f["properties"]["parts"] for f in feats),
        },
        "features": feats,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/drought.geojson"))
    ap.add_argument(
        "--seed-out",
        type=Path,
        default=None,
        help="also write the newest week, simplified harder, as the seed",
    )
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "usdm",
    )
    ap.add_argument("--today", default=None)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    weeks = list_weeks(a.weeks)
    per_week = {}
    for y in weeks:
        per_week[y] = week_features(y, fetch_week(y, a.cache))
        log.info(
            "usdm_%s: %s",
            y,
            [
                (f["properties"]["label"][:2], f["properties"]["parts"])
                for f in per_week[y]
            ],
        )
    for old in a.cache.glob("usdm_*.json"):  # keep the cache to the weeks in use
        if old.stem[5:] not in weeks:
            old.unlink()
    gj = collection(weeks, per_week, today)
    write_atomic(a.out, gj)
    log.info(
        "wrote %s: %s newest=%s %d bytes (%.0f s)",
        a.out,
        gj["counts"],
        gj["newest"],
        a.out.stat().st_size,
        time.time() - t0,
    )
    if a.seed_out:
        y = weeks[0]
        seed = collection(
            [y],
            {
                y: week_features(
                    y,
                    fetch_week(y, a.cache),
                    SEED_TOLERANCE_DEG,
                    SEED_MIN_AREA_DEG2,
                    nd=2,
                )
            },
            today,
            note_extra=f"SEED: newest week only, simplified to {SEED_TOLERANCE_DEG}° with parts under {SEED_MIN_AREA_DEG2} deg² removed.",
        )
        write_atomic(a.seed_out, seed)
        log.info("wrote seed %s: %d bytes", a.seed_out, a.seed_out.stat().st_size)


if __name__ == "__main__":
    main()
