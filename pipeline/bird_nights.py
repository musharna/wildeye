"""Nightly migration totals per radar from the stored vol2bird profiles (vol2bird.save_profile).

Night D = bioRad's sunset on D to its sunrise on D+1 (suntools crepuscule, sun 0.268 deg below the
horizon), integrated with bioRad's rules (vol2bird.integrate_profile, migration_traffic)."""
from __future__ import annotations
import argparse
import datetime as dt
import gzip
import json
import logging
import math
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .atomic import write_atomic
from .vol2bird import (run_vol2bird, parse_profile, integrate_profile, migration_traffic, profile_hours,
                       profile_time, profile_path, save_profile)

log = logging.getLogger("bird_nights")
SUN_ELEV_DEG = -0.268   # bioRad sunrise()/sunset() default
KEEP_NIGHTS = 60

# --- suntools (NOAA) sun events, ported from suntools .crepusculeUTC and helpers -----------------

def _julian_day(d: dt.date) -> float:
    y, m = (d.year - 1, d.month + 12) if d.month <= 2 else (d.year, d.month)
    a = math.floor(y / 100)
    return math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1)) + d.day + (2 - a + math.floor(a / 4)) - 1524.5

def _jc(jd: float) -> float:
    return (jd - 2451545) / 36525

def _obliq_corr(jc):
    s = 21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))
    return 23 + (26 + s / 60) / 60 + 0.00256 * math.cos(math.radians(125.04 - 1934.136 * jc))

def _mean_lon(jc):
    return (280.46646 + jc * (36000.76983 + 0.0003032 * jc)) % 360

def _mean_anom(jc):
    return 357.52911 + jc * (35999.05029 - 0.0001537 * jc)

def _eccentricity(jc):
    return 0.016708634 - jc * (4.2037e-05 + 1.267e-07 * jc)

def _eq_time(jc):
    eps, l0, e, m = _obliq_corr(jc), _mean_lon(jc), _eccentricity(jc), _mean_anom(jc)
    y = math.tan(math.radians(eps) / 2) ** 2
    l0r, mr = math.radians(l0), math.radians(m)
    et = (y * math.sin(2 * l0r) - 2 * e * math.sin(mr) + 4 * e * y * math.sin(mr) * math.cos(2 * l0r)
          - 0.5 * y * y * math.sin(4 * l0r) - 1.25 * e * e * math.sin(2 * mr))
    return math.degrees(et) * 4

def _declination(jc):
    mr = math.radians(_mean_anom(jc))
    center = (math.sin(mr) * (1.914602 - jc * (0.004817 + 1.4e-05 * jc))
              + math.sin(2 * mr) * (0.019993 - 0.000101 * jc) + math.sin(3 * mr) * 0.000289)
    app_lon = _mean_lon(jc) + center - 0.00569 - 0.00478 * math.sin(math.radians(125.04 - 1934.136 * jc))
    return math.degrees(math.asin(math.sin(math.radians(_obliq_corr(jc))) * math.sin(math.radians(app_lon))))

def _hour_angle(lat, dec, zenith_deg, rising):
    lr, dr = math.radians(lat), math.radians(dec)
    arg = math.cos(math.radians(zenith_deg)) / (math.cos(lr) * math.cos(dr)) - math.tan(lr) * math.tan(dr)
    if abs(arg) >= 1:
        raise ValueError(f"no sun {'rise' if rising else 'set'} at lat {lat}")
    return math.acos(arg) if rising else -math.acos(arg)

def sun_event(day: dt.date, lon: float, lat: float, rising: bool, elev_deg: float = SUN_ELEV_DEG) -> dt.datetime:
    """UTC time the sun crosses elev_deg on UTC date `day` (bioRad sunrise/sunset)."""
    jc = _jc(_julian_day(day))
    ha = _hour_angle(lat, _declination(jc), 90.833, rising)        # first guess: standard rise/set
    t = 720 + 4 * (-lon - math.degrees(ha)) - _eq_time(jc)
    jc2 = _jc(jc * 36525 + 2451545 + t / 1440)
    ha = _hour_angle(lat, _declination(jc2), 90 - elev_deg, rising)
    t = 720 + 4 * (-lon - math.degrees(ha)) - _eq_time(jc2)
    return dt.datetime(day.year, day.month, day.day, tzinfo=dt.UTC) + dt.timedelta(minutes=t)

def night_window(night: dt.date, lon: float, lat: float) -> tuple[dt.datetime, dt.datetime]:
    return (sun_event(night, lon, lat, rising=False),
            sun_event(night + dt.timedelta(days=1), lon, lat, rising=True))

# --- totals ---------------------------------------------------------------------------------------

def stored_profiles(root: Path, site: str, start: dt.datetime, end: dt.datetime) -> list[tuple[dt.datetime, str]]:
    """Stored profiles of `site` whose vol2bird time lies in [start, end], oldest first."""
    out = []
    day = start.date()
    while day <= end.date():
        for f in sorted((root / site / f"{day:%Y%m%d}").glob("*.txt.gz")):
            text = gzip.decompress(f.read_bytes()).decode()
            t = profile_time(text)
            if start <= t <= end:
                out.append((t, text))
        day += dt.timedelta(days=1)
    return sorted(out, key=lambda p: p[0])

def night_total(profiles: list[tuple[dt.datetime, str]], sunset: dt.datetime, sunrise: dt.datetime) -> dict:
    """mt over the night as bioRad computes it, peak mtr, how much of the night the profiles stand for,
    and the part of the night's birds (vid-time weighted) that had no speed and so are missing from mt.
    A profile with no density at all (vol2bird removed every gate, usually rain) counts as zero
    traffic for its time, as bioRad's na.rm sums do; measured_coverage leaves those out."""
    recs = [(t, integrate_profile(parse_profile(text))) for t, text in profiles]
    out = {"sunset": _iso(sunset), "sunrise": _iso(sunrise), "profiles": len(recs),
           "profiles_without_density": sum(1 for _, r in recs if r["vid_birds_km2"] is None),
           "coverage": 0.0, "measured_coverage": 0.0, "mt_birds_km": None,
           "peak_mtr_birds_km_h": None, "peak_time": None, "speedless_share": None}
    if not recs:
        return out
    times = [t for t, _ in recs]
    hours = profile_hours(times)
    mt = migration_traffic(times, [r["mtr_birds_km_h"] or 0.0 for _, r in recs])
    night_h = (sunrise - sunset).total_seconds() / 3600
    measured = [(h, r) for h, (_, r) in zip(hours, recs) if r["vid_birds_km2"] is not None]
    seen = sum(h * r["vid_birds_km2"] for h, r in measured)
    unseen = sum(h * r["vid_birds_km2"] * r["speedless_share"] for h, r in measured if r["speedless_share"] is not None)
    out.update(coverage=sum(hours) / night_h, measured_coverage=sum(h for h, _ in measured) / night_h,
               mt_birds_km=mt[-1], speedless_share=unseen / seen if seen > 0 else None)
    if measured:
        t_peak, r_peak = max(((t, r) for t, r in recs if r["mtr_birds_km_h"] is not None),
                             key=lambda p: p[1]["mtr_birds_km_h"])
        out.update(peak_mtr_birds_km_h=r_peak["mtr_birds_km_h"], peak_time=_iso(t_peak))
    return out

def _iso(t: dt.datetime) -> str:
    return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

def build_nights(root: Path, sites: list[dict], out: Path, now: dt.datetime, nights: list[dt.date] | None = None,
                 keep_nights: int = KEEP_NIGHTS) -> dict:
    """Recompute the given nights (default: the UTC dates today-1 and today whose sunset has passed)
    for every site and merge them into `out`; nights older than keep_nights are dropped."""
    prev = json.loads(out.read_text()) if out.exists() else {"sites": {}}
    table = {s: {e["night"]: e for e in rows} for s, rows in prev.get("sites", {}).items()}
    failures = {}
    for site in sites:
        for night in nights or [now.date() - dt.timedelta(days=1), now.date()]:
            sunset, sunrise = night_window(night, site["lon"], site["lat"])
            if sunset > now:
                continue
            try:
                entry = night_total(stored_profiles(root, site["id"], sunset, min(sunrise, now)), sunset, sunrise)
            except Exception as e:  # one bad site-night must not cost the others; logged and listed
                failures[f"{site['id']} {night}"] = repr(e)
                log.error("%s night %s FAILED: %r", site["id"], night, e)
                continue
            entry.update(night=night.isoformat(), complete=now >= sunrise)
            table.setdefault(site["id"], {})[night.isoformat()] = entry
    cutoff = (now.date() - dt.timedelta(days=keep_nights)).isoformat()
    doc = {"generated_at": _iso(now),
           "method": ("bioRad 0.12.0 integrate_profile (0 m to profile top, ASL) over each night's stored "
                      "vol2bird profiles; night = bioRad sunset to sunrise (sun -0.268 deg)"),
           "failures": failures,
           "sites": {s: [rows[k] for k in sorted(rows) if k >= cutoff] for s, rows in sorted(table.items())}}
    write_atomic(out, doc)
    return doc

# --- backfill a past night from the NEXRAD archive -------------------------------------------------

def backfill_night(site: dict, night: dt.date, root: Path, workdir: Path, workers: int = 4) -> list[str]:
    """Run vol2bird on every archived volume of `site` in the night's window and store the profiles.
    Scans already stored are skipped. Returns the keys that failed (logged)."""
    from .nexrad import list_day_keys, key_time, download_volume
    sunset, sunrise = night_window(night, site["lon"], site["lat"])
    keys, day = [], sunset.date()
    while day <= sunrise.date():
        keys += list_day_keys(site["id"], dt.datetime(day.year, day.month, day.day, tzinfo=dt.UTC))
        day += dt.timedelta(days=1)
    todo = sorted(k for k in keys if k.endswith("_V06") and sunset <= key_time(k) <= sunrise
                  and not profile_path(site["id"], k, root).exists())
    log.info("%s night %s: %d volumes to run", site["id"], night, len(todo))

    def one(key):
        vol = download_volume(key, workdir / site["id"])
        try:
            save_profile(run_vol2bird(vol), site["id"], key, root)
        finally:
            vol.unlink(missing_ok=True)

    failed = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(one, k): k for k in todo}
        for fut in as_completed(futs):
            try:
                fut.result()
            except Exception as e:
                failed.append(futs[fut])
                log.error("%s FAILED: %r", futs[fut], e)
    return failed

def main(argv=None):
    from .build_birds import SITES
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "wildeye"
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["backfill", "build"])
    ap.add_argument("--night", action="append", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--site", action="append", help="default: every site")
    ap.add_argument("--vp-dir", type=Path, default=cache / "vp")
    ap.add_argument("--workdir", type=Path, default=cache / "nexrad")
    ap.add_argument("--out", type=Path, default=Path("public/data/birds_nights.json"))
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    unknown = set(a.site or []) - {s["id"] for s in SITES}
    if unknown:
        raise SystemExit(f"unknown site(s): {sorted(unknown)}")
    sites = [s for s in SITES if not a.site or s["id"] in a.site]
    if a.command == "backfill":
        failed = [k for s in sites for n in a.night for k in backfill_night(s, n, a.vp_dir, a.workdir, a.workers)]
        if failed:
            raise SystemExit(f"{len(failed)} volumes failed: {failed[:5]}")
    doc = build_nights(a.vp_dir, sites, a.out, dt.datetime.now(dt.UTC), nights=a.night)
    if doc["failures"]:
        raise SystemExit(f"night failures: {doc['failures']}")

if __name__ == "__main__":
    main()
