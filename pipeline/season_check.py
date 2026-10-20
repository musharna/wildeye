"""Can a radar's fall be compared with its last fall? Rules fixed in the grill_wildeye_bird_season ledger
(2026-10-19) before either season existed in the archive.

Per radar: r = this fall's total / last fall's total over the nights (by date) both falls have a total for, up to
the last night of this fall in the archive. Birds move regionally, so neighbouring radars should see a similar
change; a radar whose own change between years was hardware, scan strategy or siting would stand out. Per adjacent
pair (pair_check.PAIRS): disagreement = max(rA / rB, rB / rA). The popup's "last fall" line ships if the median
disagreement is <= MAX_DISAGREE over >= MIN_PAIRS pairs."""
from __future__ import annotations
import argparse
import json
import math
import statistics
from pathlib import Path
from .pair_check import PAIRS

MAX_DISAGREE, MIN_PAIRS = 1.5, 6

def year_on_year(this: dict, last: dict, year: int) -> dict | None:
    """Totals over the nights both seasons have (matched by month-day); None without a positive last total."""
    def ok(rec):
        return rec is not None and isinstance(rec.get("mt_birds_km"), (int, float)) and math.isfinite(rec["mt_birds_km"])
    nights = [n for n in sorted(this) if ok(this[n]) and ok(last.get(f"{year - 1}{n[4:]}"))]
    if not nights:
        return None
    a = sum(this[n]["mt_birds_km"] for n in nights)
    b = sum(last[f"{year - 1}{n[4:]}"]["mt_birds_km"] for n in nights)
    if b <= 0:
        return None
    return {"nights": len(nights), "first": nights[0], "last": nights[-1], "this": a, "last_fall": b, "ratio": a / b}

def disagreement(ra: float, rb: float) -> float:
    return max(ra / rb, rb / ra)

def decide(radars: dict) -> dict:
    pairs = []
    for a, b in PAIRS:
        ya, yb = radars.get(a), radars.get(b)
        if ya and yb and ya["ratio"] > 0 and yb["ratio"] > 0:
            pairs.append({"pair": [a, b], "ratio_a": ya["ratio"], "ratio_b": yb["ratio"],
                          "disagreement": disagreement(ya["ratio"], yb["ratio"])})
    med = statistics.median(p["disagreement"] for p in pairs) if pairs else None
    return {"pairs": pairs, "median_disagreement": med, "ships": med is not None and len(pairs) >= MIN_PAIRS
            and med <= MAX_DISAGREE}

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", type=Path, default=Path("public/data/birds_seasons.json"))
    ap.add_argument("--season", default="fall-2026")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    doc = json.loads(a.seasons.read_text())["seasons"]
    name, year = a.season.rsplit("-", 1)
    this, last = doc.get(a.season, {}), doc.get(f"{name}-{int(year) - 1}", {})
    radars = {s: year_on_year(this[s], last.get(s, {}), int(year)) for s in sorted(this)}
    out = {"season": a.season, "max_disagreement": MAX_DISAGREE, "min_pairs": MIN_PAIRS, **decide(radars),
           "radars": radars}
    a.out.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: out[k] for k in ("median_disagreement", "ships")} | {"pairs": len(out["pairs"])}, indent=1))

if __name__ == "__main__":
    main()
