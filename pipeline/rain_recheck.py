"""Do the rain flag and the night marker work at radars the gauge checks never saw? Both at the EXISTING
threshold, no fitting (rules fixed in the radar-depth ledger, 2026-10-18 23:55 EDT, before the data existed).

Scans are labelled as in rain_check, nights as in rain_nights, on the 10-minute subsample of a full-resolution
store. The markers stay at these radars if scan balanced accuracy and night balanced accuracy are each >= 0.75,
with >= 30 scans and >= 15 nights of each label; otherwise the report and popup name the radars."""
from __future__ import annotations
import argparse
import datetime as dt
import json
from pathlib import Path
from . import rain_check, rain_nights
from .bird_nights import night_window, stored_profiles
from .pair_check import site_nights
from .rain_check import balanced_accuracy, label, nearest_gauge, reports_for, stations_for
from .rain_nights import night_label
from .vol2bird import bio_gate_share, parse_profile

KEEP_AT = 0.75

def counts(rows: list[tuple[float, str]]) -> dict:
    return {lab: sum(1 for _, x in rows if x == lab) for lab in ("rain", "dry")}

def recheck(scans: list[tuple[float, str]], nights: list[tuple[float, str]], t: float) -> dict:
    s, n = balanced_accuracy(scans, t), balanced_accuracy(nights, t)
    sc, nc = counts(scans), counts(nights)
    enough = min(sc.values()) >= rain_check.MIN_EACH and min(nc.values()) >= rain_nights.MIN_EACH
    return {"threshold": t, "scan_balanced_accuracy": s, "scan_counts": sc, "night_balanced_accuracy": n,
            "night_counts": nc, "enough": enough,
            "keep": enough and s >= KEEP_AT and n >= KEEP_AT}   # enough means both labels, so neither is None

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp-dir", type=Path, required=True, help="the 10-minute subsample store")
    ap.add_argument("--first-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--last-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--states", required=True)
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--threshold-from", type=Path, required=True, help="rain_check output (bird_rain.json)")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    sites = {s["id"]: s for s in json.loads((Path(__file__).parent / "sites.json").read_text())}
    t = json.loads(a.threshold_from.read_text())["threshold"]
    stations = stations_for(a.states.split(","), a.cache)
    days = [a.first_night + dt.timedelta(days=d) for d in range((a.last_night - a.first_night).days + 1)]
    scans, nights, gauges = [], [], {}
    for sid in sorted(p.name for p in a.vp_dir.iterdir() if p.is_dir()):
        s = sites[sid]
        g = gauges[sid] = nearest_gauge(stations, s["lon"], s["lat"])
        if g is None:
            continue
        reports = reports_for(g[0], a.first_night, a.last_night, a.cache)
        per_night = site_nights(a.vp_dir, s, days)
        for night in days:
            sunset, sunrise = night_window(night, s["lon"], s["lat"])
            for when, text in stored_profiles(a.vp_dir, sid, sunset, sunrise):
                share, lab = bio_gate_share(parse_profile(text)), label(when, reports, sunset, sunrise)
                if share is not None and lab is not None:
                    scans.append({"site": sid, "share": share, "label": lab})
            share, lab = per_night[night.isoformat()]["bio_gate_share"], night_label(reports, sunset, sunrise)
            if share is not None and lab is not None:
                nights.append({"site": sid, "night": night.isoformat(), "share": share, "label": lab})
    pairs = lambda rows: [(r["share"], r["label"]) for r in rows]  # noqa: E731
    doc = {**recheck(pairs(scans), pairs(nights), t), "gauges": gauges,
           "per_site": {sid: recheck(pairs([r for r in scans if r["site"] == sid]),
                                     pairs([r for r in nights if r["site"] == sid]), t) for sid in gauges},
           "nights": nights}
    a.out.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: v for k, v in doc.items() if k not in ("nights", "per_site")}, indent=1))

if __name__ == "__main__":
    main()
