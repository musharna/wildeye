"""Aloft / BALTRAD vertical profiles (CC0) → latest profile per European radar.

Source: https://aloftdata.s3-eu-west-1.amazonaws.com/baltrad/daily/<radar>/<year>/<radar>_vpts_<YYYYMMDD>.csv
Daily files, 5-min profiles, published within ~48 h. Same reducer as NEXRAD.
"""
from __future__ import annotations
import argparse, csv, datetime as dt, io, json, logging, re, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import urllib.request
from .vol2bird import reduce_profile
from .build_birds import write_atomic

log = logging.getLogger("aloft")
BUCKET = "https://aloftdata.s3-eu-west-1.amazonaws.com"
PREFIX = "baltrad/daily/"
_KEY = re.compile(r"<Key>([^<]+)</Key>")
_PFX = re.compile(r"<Prefix>([^<]+)</Prefix>")

def _get(url: str, timeout: int = 60) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode("utf-8")

def list_radars() -> list[str]:
    xml = _get(f"{BUCKET}/?list-type=2&prefix={PREFIX}&delimiter=/")
    return sorted(p.split("/")[2] for p in _PFX.findall(xml) if p.count("/") == 3)

def latest_daily_key(radar: str, now: dt.datetime | None = None) -> str | None:
    now = now or dt.datetime.now(dt.UTC)
    for year in (now.year, now.year - 1):
        xml = _get(f"{BUCKET}/?list-type=2&prefix={PREFIX}{radar}/{year}/")
        keys = [k for k in _KEY.findall(xml) if k.endswith(".csv")]
        if keys:
            return max(keys)
    return None

def _f(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x else None

def parse_vpts(text: str) -> dict:
    """Group rows by (datetime, source_file). Returns {radar, lat, lon, times: {(t, src): [bins]}}."""
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise ValueError("empty VPTS csv")
    r0 = rows[0]
    prof = {"radar": r0["radar"], "lat": float(r0["radar_latitude"]), "lon": float(r0["radar_longitude"]), "times": {}}
    for r in rows:
        key = (r["datetime"], r.get("source_file", ""))
        prof["times"].setdefault(key, []).append({
            "height_m": _f(r["height"]), "u": _f(r["u"]), "v": _f(r["v"]), "ff": _f(r["ff"]),
            "dd": _f(r["dd"]), "dens": _f(r["dens"]), "dbz": _f(r["dbz"]), "eta": _f(r["eta"]),
        })
    return prof

def latest_profile(prof: dict) -> tuple[str, list[dict]]:
    """Latest (datetime, source_file) whose bins carry any density; bins sorted by height."""
    for key in sorted(prof["times"], reverse=True):
        bins = prof["times"][key]
        if any(b["dens"] is not None for b in bins):
            return key[0], sorted(bins, key=lambda b: b["height_m"] if b["height_m"] is not None else 1e9)
    raise ValueError(f"{prof['radar']}: no profile with data")

def radar_feature(prof: dict) -> dict:
    t, bins = latest_profile(prof)
    rec = reduce_profile(bins)
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [prof["lon"], prof["lat"]]},
            "properties": {"site": prof["radar"], "name": prof["radar"].upper(), "scan_time": t,
                           "stale": False, "source": "aloft-baltrad", **rec}}

def process_radar(radar: str) -> dict:
    key = latest_daily_key(radar)
    if not key:
        raise RuntimeError(f"{radar}: no daily csv")
    return radar_feature(parse_vpts(_get(f"{BUCKET}/{key}", timeout=120)))

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/aloft.geojson"))
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--radars", type=int, default=None, help="limit to first N radars")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    radars = list_radars()
    radars = radars[: a.radars] if a.radars else radars
    t0 = time.time(); feats, failures = {}, {}
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process_radar, r): r for r in radars}
        for fut in as_completed(futs):
            r = futs[fut]
            try:
                feats[r] = fut.result()
            except Exception as e:
                failures[r] = repr(e); log.error("%s FAILED: %r", r, e)
    fc = {"type": "FeatureCollection", "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
          "source": "Aloft / BALTRAD_VPTS (CC0)", "site_count": len(radars), "fresh_count": len(feats),
          "failures": failures, "features": [feats[k] for k in sorted(feats)]}
    write_atomic(a.out, fc)
    log.info("wrote %s fresh=%d/%d wall=%.0fs", a.out, len(feats), len(radars), time.time() - t0)
    if not feats:
        raise SystemExit("every radar failed")

if __name__ == "__main__":
    main()
