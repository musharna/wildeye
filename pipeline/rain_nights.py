"""Does the night's weighted bio_gate_share tell a rain night? The popup's night marker reuses the per-scan
threshold (rain_check, 0.55) on bird_nights' time-weighted share, a different statistic; this tests that use
(rules fixed in the radar-depth ledger, 2026-10-18 22:55 EDT, before any night label was computed).

RAIN night: the nearest gauge (<= 40 km) has an hourly report with p01i >= 0.01 in between sunset and sunrise.
DRY night: rain_check.dry_night. Otherwise excluded. The marker stays if balanced accuracy at the existing
threshold is >= 0.75 with >= 15 nights of each label."""
from __future__ import annotations
import argparse
import datetime as dt
import json
from pathlib import Path
from .bird_nights import night_window
from .rain_check import balanced_accuracy, dry_night, nearest_gauge, reports_for, stations_for

KEEP_AT, MIN_EACH = 0.75, 15

def night_label(reports: list, sunset: dt.datetime, sunrise: dt.datetime) -> str | None:
    if any(isinstance(v, float) and v >= 0.01 and sunset <= t <= sunrise for t, v in reports):
        return "rain"
    return "dry" if dry_night(reports, sunset, sunrise) else None

def verdict(nights: list[tuple[float, str]], t: float) -> dict:
    n = {lab: sum(1 for _, x in nights if x == lab) for lab in ("rain", "dry")}
    ba = balanced_accuracy(nights, t)
    flagged = {lab: (sum(s < t for s, x in nights if x == lab) / n[lab] if n[lab] else None) for lab in n}
    return {"threshold": t, "balanced_accuracy": ba, "counts": n, "flagged": flagged,
            "keep_marker": ba is not None and ba >= KEEP_AT and min(n.values()) >= MIN_EACH}

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", type=Path, required=True, help="pair_check output (site_nights)")
    ap.add_argument("--threshold-from", type=Path, required=True, help="rain_check output")
    ap.add_argument("--states", required=True)
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    sites = {s["id"]: s for s in json.loads((Path(__file__).parent / "sites.json").read_text())}
    t = json.loads(a.threshold_from.read_text())["threshold"]
    site_nights = json.loads(a.pairs.read_text())["site_nights"]
    stations = stations_for(a.states.split(","), a.cache)
    rows = []
    for sid in sorted(site_nights):
        s = sites[sid]
        g = nearest_gauge(stations, s["lon"], s["lat"])
        if g is None:
            continue
        days = sorted(site_nights[sid])
        reports = reports_for(g[0], dt.date.fromisoformat(days[0]), dt.date.fromisoformat(days[-1]), a.cache)
        for day in days:
            share = site_nights[sid][day]["bio_gate_share"]
            sunset, sunrise = night_window(dt.date.fromisoformat(day), s["lon"], s["lat"])
            lab = night_label(reports, sunset, sunrise)
            if share is not None and lab is not None:
                rows.append({"site": sid, "night": day, "share": share, "label": lab})
    doc = {**verdict([(r["share"], r["label"]) for r in rows], t), "nights": rows}
    a.out.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: v for k, v in doc.items() if k != "nights"}, indent=1))

if __name__ == "__main__":
    main()
