"""
CDC NWSS wastewater → county polygons with a per-site 15-day trend (polygon contract).

Source: data.cdc.gov j9g8-acpt "CDC Wastewater Data for SARS-CoV-2" (Public Domain
U.S. Government, weekly). CDC's footnote: concentrations are NOT comparable across
sampling locations (different methods), so nothing here compares sites. Each site
gets its own trend = log10 of (mean concentration in the 15 days ending at the week
end) over (mean in the 15 days before that); counties get the population-weighted
mean of their sites' trends. Rows whose `source` is WastewaterSCAN are dropped: that
programme's own terms are CC BY-NC (DATA_SOURCES.md), which fails the v1 policy even
though CDC republishes the rows.

Polygons come from the Census 2021 cartographic boundary file (US-gov, 1:20m; 2022+ replaced
Connecticut counties with planning regions that CDC does not use), read with
pyshp (imported lazily so the module stays stdlib-importable); only counties with data
are emitted, so the live file stays a few hundred KB.
"""
from __future__ import annotations
import argparse
import datetime as dt
import io
import json
import logging
import math
import os
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("wastewater")
SOCRATA = "https://data.cdc.gov/resource/j9g8-acpt.json"
CENSUS_ZIP = "https://www2.census.gov/geo/tiger/GENZ2021/shp/cb_2021_us_county_20m.zip"
EXCLUDED_SOURCES = ("WastewaterSCAN",)
FIELDS = ("site", "state_territory", "source", "county_fips", "counties_served", "population_served",
          "sample_collect_date", "pcr_target_avg_conc", "pcr_target_detect", "sample_matrix")
PAGE = 50000
WINDOW_D = 15          # trend compares the last 15 days with the 15 before
MIN_SAMPLES = 2        # per window, per site
DEFAULT_WEEKS = 8
TREND_CLAMP = 2.0      # ±2 log10 (100x) is the display range; beyond it is a data artefact
UA = "wildeye/1.0 (+https://github.com; bio globe; contact via repo)"


def _get_json(url: str, timeout: int = 120):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_rows(since: dt.date, fetch=_get_json) -> list[dict]:
    """All SARS-CoV-2 rows collected on/after `since`, paged; excluded sources filtered server-side."""
    out: list[dict] = []
    offset = 0
    excl = " AND ".join(f"source != '{s}'" for s in EXCLUDED_SOURCES)
    where = f"sample_collect_date >= '{since.isoformat()}' AND pcr_target = 'sars-cov-2' AND {excl}"
    while True:
        q = urllib.parse.urlencode({"$select": ",".join(FIELDS), "$where": where, "$limit": PAGE,
                                    "$offset": offset, "$order": "sample_collect_date"})
        page = fetch(f"{SOCRATA}?{q}")
        out.extend(page)
        if len(page) < PAGE:
            return out
        offset += PAGE


def clean_rows(rows: list[dict]) -> list[dict]:
    """Keep rows with a site, a date, a county and a finite concentration; drop excluded sources
    (belt and braces: the server filter is the primary gate)."""
    kept = []
    for r in rows:
        if r.get("source") in EXCLUDED_SOURCES:
            continue
        try:
            d = dt.date.fromisoformat(str(r.get("sample_collect_date", ""))[:10])
            c = float(r.get("pcr_target_avg_conc"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(c) or c < 0 or not r.get("site") or not r.get("county_fips"):
            continue
        if str(r.get("pcr_target_detect", "")).lower() == "no":
            c = 0.0
        fips = [f.strip() for f in str(r["county_fips"]).split(",") if f.strip()]
        try:
            pop = float(r.get("population_served") or 0)
        except (TypeError, ValueError):
            pop = 0.0
        kept.append({"site": str(r["site"]), "st": str(r.get("state_territory", "")).upper(), "date": d,
                     "conc": c, "fips": fips, "pop": pop, "matrix": r.get("sample_matrix")})
    return kept


def site_trend(samples: list[tuple[dt.date, float]], week_end: dt.date,
               window_d: int = WINDOW_D, min_samples: int = MIN_SAMPLES) -> float | None:
    """log10 ratio of the mean concentration over the `window_d` days ending at `week_end`
    (inclusive) over the `window_d` days before that, computed as the difference of the two
    windows' median log10(c+1) and clamped to ±TREND_CLAMP. None when either window has fewer
    than `min_samples`."""
    recent = [c for d, c in samples if week_end - dt.timedelta(days=window_d - 1) <= d <= week_end]
    prior = [c for d, c in samples
             if week_end - dt.timedelta(days=2 * window_d - 1) <= d < week_end - dt.timedelta(days=window_d - 1)]
    if len(recent) < min_samples or len(prior) < min_samples:
        return None
    return round(max(-TREND_CLAMP, min(TREND_CLAMP, _median_log(recent) - _median_log(prior))), 3)


def _median_log(cs: list[float]) -> float:
    """Median of log10(c + 1): robust to a single unit slip or a non-detect zero, which with a
    mean produced ±6 log trends on the live feed (2026-09-11)."""
    v = sorted(math.log10(c + 1.0) for c in cs)
    n = len(v)
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])


def week_ends(today: dt.date, weeks: int) -> list[dt.date]:
    """Weekly instants, newest first: today, today-7, ... (`weeks` of them)."""
    return [today - dt.timedelta(days=7 * i) for i in range(weeks)]


def county_index(rows: list[dict], today: dt.date, weeks: int = DEFAULT_WEEKS) -> dict:
    """fips → {sites, pop, st, weeks:[{w, t, n}]} with t = population-weighted mean of site trends."""
    by_site: dict[str, dict] = {}
    for r in rows:
        s = by_site.setdefault(r["site"], {"samples": [], "fips": r["fips"], "pop": r["pop"], "st": r["st"]})
        s["samples"].append((r["date"], r["conc"]))
    ends = week_ends(today, weeks)
    trends = {sid: [site_trend(s["samples"], w) for w in ends] for sid, s in by_site.items()}
    counties: dict[str, dict] = {}
    for sid, s in by_site.items():
        for f in s["fips"]:
            c = counties.setdefault(f, {"sites": 0, "pop": 0.0, "st": s["st"], "_acc": [[0.0, 0.0, 0] for _ in ends]})
            c["sites"] += 1
            c["pop"] += s["pop"]
            w = s["pop"] if s["pop"] > 0 else 1.0
            for i, t in enumerate(trends[sid]):
                if t is None:
                    continue
                acc = c["_acc"][i]
                acc[0] += w * t
                acc[1] += w
                acc[2] += 1
    for f, c in counties.items():
        c["weeks"] = [{"w": ends[i].isoformat(), "t": (round(a[0] / a[1], 3) if a[1] > 0 else None), "n": a[2]}
                      for i, a in enumerate(c.pop("_acc"))]
        c["pop"] = int(c["pop"])
    return counties


def load_county_shapes(zip_path: Path, wanted: set[str] | None, fetch_bytes=None) -> dict[str, dict]:
    """fips → {name, st, state_name, geometry} for the wanted counties (None = every county)
    from the Census 1:20m boundary zip (downloaded once into `zip_path`). pyshp is imported
    here so importing this module needs only the stdlib. Shared with pipeline/hpai.py."""
    import shapefile  # pyshp
    if not zip_path.exists():
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        data = fetch_bytes(CENSUS_ZIP) if fetch_bytes else urllib.request.urlopen(
            urllib.request.Request(CENSUS_ZIP, headers={"User-Agent": UA}), timeout=120).read()
        zip_path.write_bytes(data)
    z = zipfile.ZipFile(zip_path)
    base = next(n for n in z.namelist() if n.endswith(".shp"))[:-4]
    rd = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")),
                          shx=io.BytesIO(z.read(base + ".shx")))
    out = {}

    def rnd(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], 3), round(c[1], 3)]
        return [rnd(x) for x in c]

    for sr in rd.iterShapeRecords():
        rec = sr.record.as_dict()
        if wanted is not None and rec["GEOID"] not in wanted:
            continue
        g = sr.shape.__geo_interface__
        out[rec["GEOID"]] = {"name": rec["NAME"], "st": rec["STUSPS"], "state_name": rec["STATE_NAME"],
                             "geometry": {"type": g["type"], "coordinates": rnd(g["coordinates"])}}
    return out


def to_features(counties: dict, shapes: dict) -> tuple[list[dict], list[str]]:
    """One Feature per county that has a shape; returns (features, fips without a shape)."""
    feats, missing = [], []
    for f in sorted(counties):
        sh = shapes.get(f)
        if not sh:
            missing.append(f)
            continue
        c = counties[f]
        latest = next((w["t"] for w in c["weeks"] if w["t"] is not None), None)
        feats.append({"type": "Feature", "geometry": sh["geometry"],
                      "properties": {"fips": f, "name": sh["name"], "st": sh["st"], "sites": c["sites"],
                                     "pop": c["pop"], "trend": latest, "weeks": c["weeks"]}})
    return feats, missing


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/wastewater.geojson"))
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument("--cache", type=Path,
                    default=Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")))
    ap.add_argument("--today", default=None, help="ISO date override (tests)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    since = today - dt.timedelta(days=7 * (a.weeks - 1) + 2 * WINDOW_D)
    raw = fetch_rows(since)
    rows = clean_rows(raw)
    log.info("rows fetched=%d kept=%d sites=%d", len(raw), len(rows), len({r['site'] for r in rows}))
    counties = county_index(rows, today, a.weeks)
    shapes = load_county_shapes(a.cache / "cb_2021_us_county_20m.zip", set(counties))
    feats, missing = to_features(counties, shapes)
    if missing:
        log.warning("%d county fips without a Census shape (dropped): %s", len(missing), missing[:10])
    gj = {"type": "FeatureCollection", "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
          "source": {"id": "cdc-nwss", "name": "CDC National Wastewater Surveillance System",
                     "dataset": "data.cdc.gov j9g8-acpt", "licence": "Public Domain U.S. Government",
                     "url": "https://data.cdc.gov/Public-Health-Surveillance/CDC-Wastewater-Data-for-SARS-CoV-2/j9g8-acpt",
                     "excluded_sources": list(EXCLUDED_SOURCES), "target": "SARS-CoV-2",
                     "note": "per-site 15-day trend, log10 ratio; concentrations are never compared across sites"},
          "today": today.isoformat(), "weeks": [w.isoformat() for w in week_ends(today, a.weeks)],
          "counts": {"rows": len(raw), "kept": len(rows), "sites": len({r['site'] for r in rows}),
                     "counties": len(feats), "missing_shape": len(missing)},
          "features": feats}
    write_atomic(a.out, gj)
    log.info("wrote %s: %d counties", a.out, len(feats))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
