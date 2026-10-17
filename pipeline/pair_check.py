"""Do neighbouring radars agree night by night? The adjacent-radar check (G3) of the radar-depth plan.

For each radar and night, from the stored vol2bird profiles: the new measurement (night_total mt_birds_km,
bioRad's rules) and the old product (reduce_profile density_birds_km3, averaged over the night with the same
profile_hours weights). Per pair of neighbours (<= 250 km; none share air, vol2bird measures 5-35 km out):
Spearman over the nights both radars have, and the median of a/b over the nights both are > 0, folded to >= 1.
Pass, fixed on 2026-10-17 before any pair was computed: over the pairs, median Spearman >= 0.8 and median folded
ratio <= 1.5, and the new arm beats the old on both. The same with rain nights dropped is a diagnostic only."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
import statistics
from pathlib import Path
from .bird_nights import night_window, stored_profiles, night_total
from .vol2bird import parse_profile, reduce_profile, profile_hours

PAIRS = [("KOKX", "KDIX"), ("KMHX", "KLTX"), ("KCLE", "KPBZ"), ("KRAX", "KMHX"), ("KMLB", "KTBW"), ("KRAX", "KLTX"),
         ("KOKX", "KBOX"), ("KAKQ", "KRAX"), ("KLWX", "KAKQ"), ("KAKQ", "KMHX"), ("KCLX", "KJAX")]
SPEARMAN_MIN, RATIO_MAX = 0.8, 1.5
RAIN_BIO_SHARE = 0.3     # diagnostic only: a night where either radar kept less of its echo than this is "rain"

def old_product(profiles: list[tuple[dt.datetime, str]]) -> float | None:
    """The old record's density_birds_km3 over the night, each profile weighted by the time it stands for
    (profile_hours); profiles with no density are left out, as the old layer showed them as no signal."""
    if not profiles:
        return None
    hours = profile_hours([t for t, _ in profiles])
    vals = [(h, reduce_profile(parse_profile(text))["density_birds_km3"]) for h, (_, text) in zip(hours, profiles)]
    vals = [(h, v) for h, v in vals if v is not None]
    w = sum(h for h, _ in vals)
    return sum(h * v for h, v in vals) / w if w > 0 else None

def site_nights(root: Path, site: dict, nights: list[dt.date]) -> dict[str, dict]:
    out = {}
    for night in nights:
        sunset, sunrise = night_window(night, site["lon"], site["lat"])
        ps = stored_profiles(root, site["id"], sunset, sunrise)
        t = night_total(ps, sunset, sunrise)
        out[night.isoformat()] = {"new": t["mt_birds_km"], "old": old_product(ps), "profiles": t["profiles"],
                                  "coverage": t["coverage"], "bio_gate_share": t["bio_gate_share"]}
    return out

def _ranks(v: list[float]) -> list[float]:
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(v):
        j = i
        while j + 1 < len(v) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1      # ties share their mean rank, as R's cor(method = "spearman")
        i = j + 1
    return r

def spearman(x: list[float], y: list[float]) -> float | None:
    """Pearson correlation of the ranks; None with fewer than 3 nights or a series with no rank order."""
    if len(x) != len(y):
        raise ValueError(f"{len(x)} values against {len(y)}")
    if len(x) < 3:
        return None
    rx, ry = _ranks(x), _ranks(y)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    sxy = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    sxx, syy = sum((a - mx) ** 2 for a in rx), sum((b - my) ** 2 for b in ry)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None

def pair_stats(a: dict[str, dict], b: dict[str, dict], arm: str, keep=None) -> dict:
    nights = sorted(n for n in a if n in b and a[n][arm] is not None and b[n][arm] is not None
                    and (keep is None or keep(a[n], b[n])))
    x, y = [a[n][arm] for n in nights], [b[n][arm] for n in nights]
    both = [p / q for p, q in zip(x, y) if p > 0 and q > 0]
    ratio = statistics.median(both) if both else None
    return {"nights": len(nights), "spearman": spearman(x, y), "median_ratio": ratio,
            "folded_ratio": max(ratio, 1 / ratio) if ratio else None}

def verdict(pairs: list[dict]) -> dict:
    """pairs: [{"new": pair_stats, "old": pair_stats}, ...] -> medians over the pairs and the fixed pass rule."""
    def med(arm, key):
        vals = [p[arm][key] for p in pairs if p[arm][key] is not None]
        return statistics.median(vals) if vals else None
    s_new, s_old, r_new, r_old = med("new", "spearman"), med("old", "spearman"), med("new", "folded_ratio"), med("old", "folded_ratio")
    checks = {"median Spearman >= 0.8": s_new is not None and s_new >= SPEARMAN_MIN,
              "median folded ratio <= 1.5": r_new is not None and r_new <= RATIO_MAX,
              "beats the old product on Spearman": None not in (s_new, s_old) and s_new > s_old,
              "beats the old product on ratio": None not in (r_new, r_old) and r_new < r_old}
    return {"median_spearman": {"new": s_new, "old": s_old}, "median_folded_ratio": {"new": r_new, "old": r_old},
            "checks": checks, "pass": all(checks.values())}

def rain_free(x: dict, y: dict) -> bool:
    return all(s["bio_gate_share"] is not None and s["bio_gate_share"] >= RAIN_BIO_SHARE for s in (x, y))

def fmt(v: float | None) -> str:
    return "-" if v is None else f"{v:.2f}"

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp-dir", type=Path, required=True)
    ap.add_argument("--first-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--last-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    sites = {s["id"]: s for s in json.loads((Path(__file__).parent / "sites.json").read_text())}
    nights = [a.first_night + dt.timedelta(days=d) for d in range((a.last_night - a.first_night).days + 1)]
    per_site = {sid: site_nights(a.vp_dir, sites[sid], nights) for sid in sorted({s for p in PAIRS for s in p})}
    rows, dry = [], []
    for x, y in PAIRS:
        rows.append({"pair": f"{x}-{y}", **{arm: pair_stats(per_site[x], per_site[y], arm) for arm in ("new", "old")}})
        dry.append({"pair": f"{x}-{y}", **{arm: pair_stats(per_site[x], per_site[y], arm, rain_free) for arm in ("new", "old")}})
    doc = {"nights": [n.isoformat() for n in nights], "pairs": rows, "verdict": verdict(rows),
           "diagnostic_rain_nights_dropped": {"pairs": dry, "verdict": verdict(dry)}, "site_nights": per_site}
    a.out.write_text(json.dumps(doc, indent=1))
    v = doc["verdict"]
    print(f"{'pair':10} {'n':>3} {'rho new':>8} {'rho old':>8} {'ratio new':>9} {'ratio old':>9}")
    for r in rows:
        print(f"{r['pair']:10} {r['new']['nights']:3d} {fmt(r['new']['spearman']):>8} {fmt(r['old']['spearman']):>8} "
              f"{fmt(r['new']['folded_ratio']):>9} {fmt(r['old']['folded_ratio']):>9}")
    print(json.dumps({k: v[k] for k in ("median_spearman", "median_folded_ratio", "checks", "pass")}, indent=1))
    print("rain nights dropped (diagnostic):", json.dumps(doc["diagnostic_rain_nights_dropped"]["verdict"]["median_spearman"]),
          json.dumps(doc["diagnostic_rain_nights_dropped"]["verdict"]["median_folded_ratio"]))

if __name__ == "__main__":
    main()
