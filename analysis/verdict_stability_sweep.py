"""SPRT parameter sensitivity + replay on the real Sep->Oct history. Same worlds as verdict_stability.py.

Usage (repo root): python -B -m analysis.verdict_stability_sweep SEPT_VERDICTS.json OCT_VERDICTS.json
The pick (H1 0.60, cap 3) is pipeline/geomodel_check.py EVIDENCE_*; spec ruling 2026-10-02.
Output of the 2026-10-02 run: verdict_stability_sweep_2026-10-02.txt
"""
import json, signal, sys
from collections import namedtuple
import numpy as np
signal.signal(signal.SIGALRM, lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)))
signal.alarm(1200)
from pipeline.geomodel_check import group_verdict  # noqa: E402

R = namedtuple("R", "model_tss baseline_tss")
def rows(p):
    return {g: [R(s["model_tss"], s["baseline_tss"]) for s in v.get("species", [])] for g, v in json.load(open(p))["groups"].items()}
sep = rows(sys.argv[1])
octo = rows(sys.argv[2])
groups = sorted(sep)
rng = np.random.default_rng(7)
UP, DOWN = np.log(0.9 / 0.05), np.log(0.1 / 0.95)
def wl(rs): return sum(r.model_tss > r.baseline_tss for r in rs), sum(r.model_tss < r.baseline_tss for r in rs)
def med_ok(rs): return group_verdict(rs, {}).get("median_tss", 0) >= 0.40
def step(llr, listed, m, h1, cap):
    w, l = wl(m)
    llr = min(llr + w * np.log(h1 / .5) + l * np.log((1 - h1) / .5), UP + cap)
    if not listed and llr >= UP and med_ok(m): listed = True
    elif listed and llr <= DOWN: listed, llr = False, 0.0
    if not listed: llr = max(llr, DOWN)
    return llr, listed
def draw(pool, null):
    out = [pool[i] for i in rng.integers(0, len(pool), 30)]
    if null: out = [R(r.baseline_tss, r.model_tss) if f else r for r, f in zip(out, rng.random(30) < .5)]
    return out
def year(pool, null, h1, cap, start_listed):
    llr, listed, st = (UP + cap if start_listed else 0.0), start_listed, []
    for _ in range(12):
        llr, listed = step(llr, listed, draw(pool, null), h1, cap); st.append(listed)
    return st
Y = 1000
for h1 in (0.60, 0.65, 0.70):
    for cap in (3.0, 6.0):
        worst_f, line = 0, []
        for g in groups:
            pool = sep[g] + octo[g]
            f = np.mean([any(year(pool, True, h1, cap, False)) for _ in range(Y)])
            c = np.mean([not all(year(pool, False, h1, cap, True)) for _ in range(Y)])
            worst_f = max(worst_f, f)
            w, l = wl(pool)
            if w / (w + l) >= 0.58: line.append(f"{g[:8]} c{c:.0%}")
        print(f"H1 {h1} cap {cap}: worst false {worst_f:.1%} | churn of edge>=58% groups: " + ", ".join(line), flush=True)
print("\nReplay, LLR from 0 in Sep, H1 0.65 cap 3 (Arachnida treated like the rest):")
for g in groups:
    llr, listed = 0.0, False
    llr, listed = step(llr, listed, sep[g], .65, 3.0); s1 = (round(llr, 2), listed)
    llr, listed = step(llr, listed, octo[g], .65, 3.0)
    print(f"{g:16s} after Sep {s1}  after Oct {(round(llr, 2), listed)}")
