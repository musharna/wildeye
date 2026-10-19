"""Are coastal radars low because part of their ring is sea? The land-sector probe (rules fixed in the radar-depth
ledger, 2026-10-17 23:00 EDT, before any sector run).

Per coastal radar: the median over nights of land-sector density / full-ring density (pair_check.old_product; the
density arm, since a narrow sector degrades vol2bird's wind fit and so mt). Under sea dilution with no birds over
the sea, the factor is 1 / (1 - sea share). Supported if >= 4 of 5 radars rise by at least half that; falsified
if >= 4 of 5 stay below 1.1; otherwise mixed."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import statistics
from pathlib import Path
from .pair_check import fmt, site_nights

SECTOR_RADARS = ("KOKX", "KMHX", "KMLB", "KLTX", "KTBW")
FALSIFIED_BELOW = 1.1

def radar_factor(land: dict[str, dict], full: dict[str, dict]) -> dict:
    out = {}
    for arm in ("old", "new"):
        r = [land[n][arm] / full[n][arm] for n in land if n in full and land[n][arm] is not None
             and full[n][arm] is not None and full[n][arm] > 0]
        out[arm] = statistics.median(r) if r else None
        if arm == "old":
            out["nights"] = len(r)
    return out

def verdict(factors: dict[str, dict], sea: dict[str, float]) -> dict:
    radars = {}
    for site, f in factors.items():
        predicted = 1 / (1 - sea[site])
        radars[site] = {"factor": f["old"], "predicted": predicted, "needed": 1 + (predicted - 1) / 2}
    up = sum(1 for r in radars.values() if r["factor"] is not None and r["factor"] >= r["needed"])
    flat = sum(1 for r in radars.values() if r["factor"] is not None and r["factor"] < FALSIFIED_BELOW)
    need = len(radars) - 1
    return {"radars": radars, "verdict": "supported" if up >= need else "falsified" if flat >= need else "mixed"}

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--full-vp", type=Path, required=True)
    ap.add_argument("--sector-vp", type=Path, required=True)
    ap.add_argument("--sectors", type=Path, required=True, help="radar_sectors.py output")
    ap.add_argument("--first-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--last-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    sites = {s["id"]: s for s in json.loads((Path(__file__).parent / "sites.json").read_text())}
    geo = json.loads(a.sectors.read_text())
    nights = [a.first_night + dt.timedelta(days=d) for d in range((a.last_night - a.first_night).days + 1)]
    factors, per_night = {}, {}
    for sid in SECTOR_RADARS:
        land, full = site_nights(a.sector_vp, sites[sid], nights), site_nights(a.full_vp, sites[sid], nights)
        factors[sid] = radar_factor(land, full)
        per_night[sid] = {"land": land, "full": full}
    v = verdict(factors, {sid: geo[sid]["sea_share"] for sid in SECTOR_RADARS})
    a.out.write_text(json.dumps({"verdict": v, "factors": factors, "per_night": per_night}, indent=1) + "\n")
    for sid, r in v["radars"].items():      # a radar with no usable night pair has factor None: printed as '-'
        print(f"{sid} sea {geo[sid]['sea_share']:.2f} sector {geo[sid]['sector']} factor {fmt(r['factor'])} "
              f"(mt {fmt(factors[sid]['new'])}) predicted {r['predicted']:.2f} needed {r['needed']:.2f} nights {factors[sid]['nights']}")
    print("verdict:", v["verdict"])

if __name__ == "__main__":
    main()
