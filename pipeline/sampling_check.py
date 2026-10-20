"""How far is a night's migration traffic from the live 10-minute cadence off the total from every scan? The error
bar check (rules fixed in the radar-depth ledger, 2026-10-18 23:55 EDT, before the full-resolution data existed).

Per radar-night, from one full-resolution store: truth = mt over every stored scan; estimate = mt over the first
scan of each 10-minute slot from sunset (backfill_night's every_min rule, by the file's scan time). r = (estimate -
truth) / truth on nights with truth > 0. q = the 90th percentile (nearest rank) of |r| on the first ten nights; the
error bar ships if at least 85 % of held-out nights (the last ten, >= 40 of them) have |r| <= q."""
from __future__ import annotations
import argparse
import datetime as dt
import gzip
import json
import math
import re
import shutil
from pathlib import Path
from .bird_nights import night_total, night_window
from .vol2bird import profile_time

EVERY_MIN = 10
SHIP_AT, MIN_NIGHTS, PCT = 0.85, 40, 0.9
_SCAN = re.compile(r"(\d{8}_\d{6})")

def scan_time(name: str) -> dt.datetime:
    m = _SCAN.search(name)
    if not m:
        raise ValueError(f"no scan time in {name}")
    return dt.datetime.strptime(m.group(1), "%Y%m%d_%H%M%S").replace(tzinfo=dt.UTC)

def night_files(root: Path, site: str, sunset: dt.datetime, sunrise: dt.datetime) -> list[tuple[dt.datetime, Path]]:
    """Stored scans of the night by file scan time (the key time backfill selects on), oldest first."""
    out, day = [], sunset.date()
    while day <= sunrise.date():
        out += [(scan_time(f.name), f) for f in (root / site / f"{day:%Y%m%d}").glob("*.txt.gz")]
        day += dt.timedelta(days=1)
    return sorted((t, f) for t, f in out if sunset <= t <= sunrise)

def slot_subset(files: list[tuple[dt.datetime, Path]], sunset: dt.datetime, every_min: float = EVERY_MIN) -> list:
    slots = {}
    for t, f in sorted(files):
        slots.setdefault(int((t - sunset).total_seconds() // (every_min * 60)), (t, f))
    return [slots[k] for k in sorted(slots)]

def mt(files: list[tuple[dt.datetime, Path]], sunset: dt.datetime, sunrise: dt.datetime) -> float | None:
    texts = [gzip.decompress(f.read_bytes()).decode() for _, f in files]
    return night_total(sorted(((profile_time(x), x) for x in texts), key=lambda p: p[0]), sunset, sunrise)["mt_birds_km"]

def relative_error(est: float | None, truth: float | None) -> float | None:
    return (est - truth) / truth if est is not None and truth is not None and truth > 0 else None

def nearest_rank(values: list[float], pct: float) -> float:
    if not values:
        raise ValueError("no values")
    v = sorted(values)
    return v[math.ceil(pct * len(v)) - 1]

def decide(rows: list[dict], split: str) -> dict:
    fit = [abs(r["r"]) for r in rows if r["r"] is not None and r["night"] < split]
    test = [abs(r["r"]) for r in rows if r["r"] is not None and r["night"] >= split]
    q = nearest_rank(fit, PCT)
    inside = sum(x <= q for x in test) / len(test) if test else None
    return {"q": q, "fit_nights": len(fit), "held_out_nights": len(test), "held_out_inside": inside,
            "ships": inside is not None and inside >= SHIP_AT and len(test) >= MIN_NIGHTS}

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--full-vp", type=Path, required=True)
    ap.add_argument("--site", action="append", required=True)
    ap.add_argument("--first-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--last-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--subset-out", type=Path, help="copy the 10-minute scans here (same layout)")
    a = ap.parse_args(argv)
    sites = {s["id"]: s for s in json.loads((Path(__file__).parent / "sites.json").read_text())}
    nights = [a.first_night + dt.timedelta(days=d) for d in range((a.last_night - a.first_night).days + 1)]
    split = nights[len(nights) // 2].isoformat()
    rows = []
    for sid in a.site:
        s = sites[sid]
        for night in nights:
            sunset, sunrise = night_window(night, s["lon"], s["lat"])
            files = night_files(a.full_vp, sid, sunset, sunrise)
            sub = slot_subset(files, sunset)
            if a.subset_out:
                for _, f in sub:
                    dest = a.subset_out / sid / f.parent.name / f.name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, dest)
            truth, est = (mt(files, sunset, sunrise), mt(sub, sunset, sunrise)) if files else (None, None)
            rows.append({"site": sid, "night": night.isoformat(), "scans": len(files), "scans_10min": len(sub),
                         "mt_every_scan": truth, "mt_10min": est, "r": relative_error(est, truth)})
    doc = {**decide(rows, split), "split_night": split, "nights": rows}
    a.out.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: v for k, v in doc.items() if k != "nights"}, indent=1))

if __name__ == "__main__":
    main()
