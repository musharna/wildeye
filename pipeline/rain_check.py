"""Does vol2bird's bio_gate_share tell rain at the radar? The rain-flag check (rules fixed in the radar-depth
ledger, 2026-10-18 21:30 EDT, before any gauge was fetched).

Per stored scan: RAIN if the nearest ASOS gauge (<= 40 km) has an hourly report with p01i >= 0.01 in within
60 min of the scan; DRY if that gauge reported no precipitation at all, not even a trace, in every hour from
sunset - 2 h to sunrise + 2 h; otherwise excluded. Flag rain when bio_gate_share < t (None, no echo, is never
flagged). t is the grid value with the best balanced accuracy on the first ten nights, scored once on the last
ten; the flag ships if held-out balanced accuracy >= 0.75 with >= 30 scans of each label."""
from __future__ import annotations
import argparse
import collections
import csv
import datetime as dt
import io
import json
import math
import time
import urllib.request
from pathlib import Path
from .bird_nights import night_window, stored_profiles
from .vol2bird import bio_gate_share, parse_profile

IEM = "https://mesonet.agron.iastate.edu"
MAX_GAUGE_KM = 40.0
WINDOW = dt.timedelta(minutes=60)
NIGHT_PAD = dt.timedelta(hours=2)
GRID = [round(0.05 * i, 2) for i in range(1, 20)]
SHIP_AT, MIN_EACH = 0.75, 30

def km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))

def nearest_gauge(stations: list[dict], lon: float, lat: float) -> tuple[str, float] | None:
    """(station id, km) of the nearest station within MAX_GAUGE_KM; None if there is none."""
    best = min(((km(lon, lat, *s["lonlat"]), s["id"]) for s in stations), default=None)
    return (best[1], best[0]) if best and best[0] <= MAX_GAUGE_KM else None

def parse_reports(text: str) -> list[tuple[dt.datetime, float | str | None]]:
    """IEM asos.py CSV (station,valid,p01i; UTC) -> (time, inches | 'T' trace | None missing)."""
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        v = row["p01i"].strip()
        val = "T" if v == "T" else None if v in ("M", "") else float(v)
        out.append((dt.datetime.strptime(row["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=dt.UTC), val))
    return sorted(out, key=lambda r: r[0])

def label(scan: dt.datetime, reports: list[tuple[dt.datetime, float | str | None]],
          sunset: dt.datetime, sunrise: dt.datetime) -> str | None:
    if any(isinstance(v, float) and v >= 0.01 and abs(t - scan) <= WINDOW for t, v in reports):
        return "rain"
    lo, hi = sunset - NIGHT_PAD, sunrise + NIGHT_PAD
    night = [(t, v) for t, v in reports if lo <= t <= hi]
    hours = {t.replace(minute=0) for t, v in night if v is not None}
    if hourly_slots(reports, lo, hi) <= hours and all(v == 0.0 for _, v in night if v is not None):
        return "dry"
    return None

def hourly_slots(reports: list[tuple[dt.datetime, float | str | None]], lo: dt.datetime, hi: dt.datetime) -> set:
    """The clock hours whose routine report falls in [lo, hi]. The station reports once an hour at its own minute
    (the commonest minute among its reports), so an off-the-hour window can hold one slot more than its length."""
    if not reports:
        return {lo.replace(minute=0, second=0, microsecond=0)}        # nothing reported: never fully reported
    minute = collections.Counter(t.minute for t, _ in reports).most_common(1)[0][0]
    out, h = set(), lo.replace(minute=0, second=0, microsecond=0)
    while h <= hi:
        if lo <= h + dt.timedelta(minutes=minute) <= hi:
            out.add(h)
        h += dt.timedelta(hours=1)
    return out

def balanced_accuracy(scans: list[tuple[float, str]], t: float) -> float | None:
    rain = [s for s, lab in scans if lab == "rain"]
    dry = [s for s, lab in scans if lab == "dry"]
    if not rain or not dry:
        return None
    return (sum(s < t for s in rain) / len(rain) + sum(s >= t for s in dry) / len(dry)) / 2

def choose_threshold(scans: list[tuple[float, str]]) -> float:
    """The grid value with the best balanced accuracy; the lowest on a tie (flag as little as possible)."""
    scored = [(balanced_accuracy(scans, t), -t) for t in GRID]
    if any(b is None for b, _ in scored):
        raise ValueError("need scans of both labels to choose a threshold")
    return -max(scored)[1]

def decision(fit: list[tuple[float, str]], test: list[tuple[float, str]]) -> dict:
    """Threshold from the fit scans, scored once on the held-out ones, and whether the flag ships."""
    t = choose_threshold(fit)
    n = {lab: sum(1 for _, x in test if x == lab) for lab in ("rain", "dry")}
    held = balanced_accuracy(test, t)
    return {"threshold": t, "fit_balanced_accuracy": balanced_accuracy(fit, t), "held_out_balanced_accuracy": held,
            "held_out_counts": n, "ships": held is not None and held >= SHIP_AT and min(n.values()) >= MIN_EACH}

def per_site(rows: list[dict], t: float) -> dict:
    """Per radar, all nights: labelled scans and the share of each label the flag at t marks as rain."""
    out = {}
    for sid in sorted({r["site"] for r in rows}):
        out[sid] = {}
        for lab in ("rain", "dry"):
            x = [r["share"] for r in rows if r["site"] == sid and r["label"] == lab]
            out[sid][lab] = {"scans": len(x), "flagged": sum(s < t for s in x) / len(x) if x else None}
    return out

def _get(url: str, cache: Path) -> str:
    if cache.exists():
        return cache.read_text()
    with urllib.request.urlopen(url, timeout=120) as r:     # nosec B310 - the URL is always the https IEM constant plus fixed query fields
        text = r.read().decode()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(text)
    time.sleep(3)                                          # polite to IEM
    return text

def stations_for(states: list[str], cache: Path) -> list[dict]:
    out = []
    for st in states:
        doc = json.loads(_get(f"{IEM}/geojson/network/{st}_ASOS.geojson", cache / f"{st}_ASOS.geojson"))
        out += [{"id": f["id"], "lonlat": f["geometry"]["coordinates"]} for f in doc["features"]]
    return out

def reports_for(station: str, first: dt.date, last: dt.date, cache: Path) -> list:
    a, b = first - dt.timedelta(days=1), last + dt.timedelta(days=2)
    url = (f"{IEM}/cgi-bin/request/asos.py?station={station}&data=p01i&year1={a.year}&month1={a.month}&day1={a.day}"
           f"&year2={b.year}&month2={b.month}&day2={b.day}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M"
           f"&trace=T&direct=no&report_type=3")
    return parse_reports(_get(url, cache / f"{station}_{a:%Y%m%d}_{b:%Y%m%d}.csv"))

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp-dir", type=Path, required=True)
    ap.add_argument("--first-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--last-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--states", required=True, help="comma-separated state codes whose ASOS networks to search")
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--scans-csv", type=Path, help="every labelled scan (large; keep out of git)")
    a = ap.parse_args(argv)
    sites = {s["id"]: s for s in json.loads((Path(__file__).parent / "sites.json").read_text())}
    stations = stations_for(a.states.split(","), a.cache)
    nights = [a.first_night + dt.timedelta(days=d) for d in range((a.last_night - a.first_night).days + 1)]
    split = nights[len(nights) // 2]
    rows, gauges = [], {}
    for sid in sorted(p.name for p in a.vp_dir.iterdir() if p.is_dir()):
        s = sites[sid]
        g = nearest_gauge(stations, s["lon"], s["lat"])
        gauges[sid] = g
        if g is None:
            continue
        reports = reports_for(g[0], a.first_night, a.last_night, a.cache)
        for night in nights:
            sunset, sunrise = night_window(night, s["lon"], s["lat"])
            for t, text in stored_profiles(a.vp_dir, sid, sunset, sunrise):
                share = bio_gate_share(parse_profile(text))
                lab = label(t, reports, sunset, sunrise)
                if share is not None and lab is not None:
                    rows.append({"site": sid, "night": night.isoformat(), "time": t.isoformat(), "share": share,
                                 "label": lab, "held_out": night >= split})
    fit = [(r["share"], r["label"]) for r in rows if not r["held_out"]]
    test = [(r["share"], r["label"]) for r in rows if r["held_out"]]
    doc = {**decision(fit, test), "gauges": gauges, "split_night": split.isoformat(),
           "curve": {str(x): {"fit": balanced_accuracy(fit, x), "held_out": balanced_accuracy(test, x)} for x in GRID}}
    doc["per_site"] = per_site(rows, doc["threshold"])
    a.out.write_text(json.dumps(doc, indent=1) + "\n")
    if a.scans_csv:
        with a.scans_csv.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    print(json.dumps({k: doc[k] for k in ("threshold", "fit_balanced_accuracy", "held_out_balanced_accuracy",
                                          "held_out_counts", "ships", "gauges")}, indent=1))

if __name__ == "__main__":
    main()
