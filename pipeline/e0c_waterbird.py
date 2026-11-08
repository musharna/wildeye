"""E0c: is E0b's Bacteria finding a detection effect? (docs/analysis/e0c-waterbird-detection.md).

E0b found bacterial die-offs start in weeks that rank drier than the same week in neighbouring years (s = +0.044). The
open objection: in dry weeks waterbirds crowd onto fewer wetlands, so any die-off there is easier to find and report.
That predicts the same lean for a waterbird die-off cause drought does not make more likely. Here: Trauma confined to
events whose every species is a waterbird, scored with E0b's frozen rank score, and the two halves of Bacteria
(waterbird events, other-bird events) reported beside it.

Run: python -m pipeline.e0c_waterbird --cache ~/.cache/wildeye/e0 --out docs/analysis/e0c_waterbird.json [--width-only]
"""

import argparse
import datetime as dt
import json
import statistics
from pathlib import Path

from . import e0_dieoffs as e0
from . import e0b_rank as rb

# Birds of wetlands and open water (Aves orders, ITIS names as WHISPers spells them). Pelagic orders (Procellariiformes,
# Sphenisciformes) are left out: inland drought cannot crowd them.
WATERBIRD_ORDERS = frozenset(
    {
        "Anseriformes",
        "Charadriiformes",
        "Ciconiiformes",
        "Gaviiformes",
        "Gruiformes",
        "Pelecaniformes",
        "Phoenicopteriformes",
        "Podicipediformes",
        "Suliformes",
    }
)
# E0b's Bacteria mean s on real dates (docs/analysis/e0b_dieoffs.json, run 2026-11-08 01:40 EST)
FINDING = 0.044004922644163155
GATE = "waterbird_trauma"
ARMS = {  # arm -> (E0 class, bird group)
    GATE: ("Trauma", "waterbird"),
    "waterbird_bacteria": ("Bacteria", "waterbird"),
    "other_bird_bacteria": ("Bacteria", "other_bird"),
}
# The gate is the one pre-registered test: 95%. The two Bacteria halves are descriptive, corrected for each other.
# (Was k = 3 for all arms; the width check at 98.3% put the no-effect upper bound below FINDING in 15 of 40 seeds, so
# the gate could rarely conclude. Changed before any real date was scored.)
GATE_K, SIDE_K = 1, 2
WIDTH_SEEDS = 40


def bird_group(e: dict) -> str:
    """'waterbird' if every listed species is a bird in WATERBIRD_ORDERS, 'other_bird' if every one is a bird and none
    is in them, else 'excluded' (no species, a non-bird, or waterbirds mixed with other birds)."""
    sp = e.get("species") or []
    if not sp or any(s.get("class_name") != "Aves" for s in sp):
        return "excluded"
    water = [s.get("order_name") in WATERBIRD_ORDERS for s in sp]
    if all(water):
        return "waterbird"
    if not any(water):
        return "other_bird"
    return "excluded"


def arms(cases: list[dict], groups: dict) -> list[dict]:
    """The cases of each arm, relabelled with the arm's name as their class."""
    out = []
    for c in cases:
        for name, (cls, grp) in ARMS.items():
            if c["cls"] == cls and groups.get(c["id"]) == grp:
                out.append(c | {"cls": name})
    return out


def width_check(gate_cases: list[dict], dsci: dict, seeds: int = WIDTH_SEEDS) -> dict:
    """The CI the gate arm can reach with no effect: the random-draw beta = 0 plant (each case's year redrawn
    uniformly from its stratum, so no real date is used) over `seeds` seeds, at the run's level. Its upper bound
    against FINDING says, before the run, whether the gate can rule out an effect the finding's size."""
    his, means = [], []
    for k in range(seeds):
        p = rb.planted_cases(gate_cases, dsci, beta=0.0, seed=e0.SEED + 100 * k)
        r = next(iter(rb.class_stats(p, dsci, k=GATE_K)["classes"].values()))
        his.append(r["ci"][1])
        means.append(r["mean_s"])
    return {
        "seeds": seeds,
        "upper_median": statistics.median(his),
        "upper_below_finding": sum(h < FINDING for h in his),
        "mean_of_means": statistics.fmean(means),
    }


def verdict(real: dict, placebo: dict, planted_on: dict, planted_off: dict) -> dict:
    on = next(iter(planted_on["classes"].values()))
    off = next(iter(planted_off["classes"].values()))
    planted_ok = on["ci"][0] > 0 and not e0.excludes_zero(off["ci"])
    g = real["classes"].get(GATE)
    if not planted_ok or g is None or g["cases"] < e0.MIN_CASES:
        status, reading = "VOID", None
    elif g["ci"][0] > 0:
        status, reading = "CLOSED", "detection_supported"
    elif g["ci"][1] < FINDING:
        status, reading = "CLOSED", "detection_of_finding_size_ruled_out"
    else:
        status, reading = "CLOSED", "inconclusive"
    return {
        "status": status,
        "planted_ok": planted_ok,
        "gate": GATE,
        "reading": reading,
        "finding_tested_against": FINDING,
        "per_arm": {
            a: {"real": real["classes"].get(a), "placebo": placebo["classes"].get(a)}
            for a in ARMS
        },
    }


def load(cache: Path):
    confirmed, suspect, dsci, unmapped, n_events, why = rb.load(cache)
    events = json.loads((cache / "whispers_events.json").read_text())
    groups = {e["id"]: bird_group(e) for e in events}
    return confirmed, dsci, groups


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument(
        "--width-only",
        action="store_true",
        help="the planted arms and width check on the gate arm only: no real date is scored",
    )
    a = ap.parse_args(argv)
    confirmed, dsci, groups = load(a.cache)
    picked = arms(confirmed, groups)
    gate = [c for c in picked if c["cls"] == GATE]
    side = [c for c in picked if c["cls"] != GATE]
    on = rb.class_stats(rb.expected_cases(gate, dsci, beta=1.0), dsci, k=GATE_K)
    off = rb.class_stats(rb.expected_cases(gate, dsci, beta=0.0), dsci, k=GATE_K)
    counts = {n: sum(c["cls"] == n for c in picked) for n in ARMS}
    doc = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "rules": "docs/analysis/e0c-waterbird-detection.md",
        "arm_counts": counts,
        "group_counts": {
            g: sum(v == g for v in groups.values())
            for g in ("waterbird", "other_bird", "excluded")
        },
        "expected_beta_1": on,
        "expected_beta_0": off,
        "width_check": width_check(gate, dsci),
    }
    if not a.width_only:
        real, placebo = {"classes": {}, "dropped": {}}, {"classes": {}, "dropped": {}}
        for cs, k in ((gate, GATE_K), (side, SIDE_K)):
            for out, shift in ((real, 0), (placebo, e0.PLACEBO_WEEKS)):
                r = rb.class_stats(cs, dsci, shift_weeks=shift, k=k)
                for cls, row in r["classes"].items():
                    out["classes"][cls] = row | {"level": r["level"]}
                for why, n in r["dropped"].items():
                    out["dropped"][why] = out["dropped"].get(why, 0) + n
        doc |= {
            "levels": {"gate": 1 - e0.ALPHA / GATE_K, "side": 1 - e0.ALPHA / SIDE_K},
            "real": real,
            "placebo": placebo,
            "verdict": verdict(real, placebo, on, off),
        }
    a.out.write_text(json.dumps(doc, indent=1, default=str) + "\n")
    show = {k: doc[k] for k in ("arm_counts", "width_check")}
    show["plants"] = {
        k: doc[k]["classes"] for k in ("expected_beta_0", "expected_beta_1")
    }
    if "verdict" in doc:
        show["verdict"] = {
            k: doc["verdict"][k] for k in ("status", "planted_ok", "reading")
        }
        show["arms"] = {
            n: {"real": real["classes"].get(n), "placebo": placebo["classes"].get(n)}
            for n in ARMS
        }
    print(json.dumps(show, indent=1))


if __name__ == "__main__":
    main()
