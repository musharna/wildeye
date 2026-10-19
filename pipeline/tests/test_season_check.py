import math
from pipeline.pair_check import PAIRS
from pipeline.season_check import MAX_DISAGREE, MIN_PAIRS, decide, disagreement, year_on_year

def rec(mt):
    return {"mt_birds_km": mt, "bio_gate_share": 0.8, "coverage": 0.9}

def test_year_on_year_uses_only_the_nights_both_falls_have():
    this = {"2026-09-01": rec(300.0), "2026-09-02": rec(100.0), "2026-09-03": rec(None), "2026-09-04": rec(50.0)}
    last = {"2025-09-01": rec(100.0), "2025-09-02": rec(100.0), "2025-09-03": rec(999.0), "2025-09-05": rec(7.0)}
    y = year_on_year(this, last, 2026)
    # 09-03: no total this fall; 09-04: none last fall; 09-05: not this fall -> 2 matched nights
    assert y == {"nights": 2, "first": "2026-09-01", "last": "2026-09-02", "this": 400.0, "last_fall": 200.0, "ratio": 2.0}
    assert year_on_year(this, {}, 2026) is None
    assert year_on_year({"2026-09-01": rec(5.0)}, {"2025-09-01": rec(0.0)}, 2026) is None   # no ratio from a zero
    assert year_on_year({"2026-09-01": rec(math.nan)}, {"2025-09-01": rec(1.0)}, 2026) is None

def test_decide_ships_on_the_median_pair_with_enough_pairs():
    assert disagreement(2.0, 1.0) == disagreement(1.0, 2.0) == 2.0
    radars = {s: {"ratio": 1.0} for p in PAIRS for s in p}
    v = decide(radars)
    assert len(v["pairs"]) == len(PAIRS) and v["median_disagreement"] == 1.0 and v["ships"] is True
    # radars that changed differently: every pair touching them disagrees by 2x
    worse = dict(radars, **{s: {"ratio": 2.0} for s in ("KDIX", "KLTX", "KPBZ", "KTBW", "KBOX", "KLWX")})
    v = decide(worse)
    assert [round(p["disagreement"], 6) for p in v["pairs"]].count(2.0) == 7   # of 11
    assert v["median_disagreement"] == 2.0 and v["ships"] is False
    assert MAX_DISAGREE == 1.5, "fixed in the ledger before the data existed"
    edge = {s: {"ratio": 1.0} for p in PAIRS for s in p}
    for s in ("KDIX", "KLTX", "KPBZ", "KMHX", "KTBW", "KBOX", "KAKQ"):
        edge[s] = {"ratio": 1.5}
    assert decide(edge)["median_disagreement"] == 1.5 and decide(edge)["ships"] is True   # the bar itself ships
    for s in ("KDIX", "KLTX", "KPBZ", "KMHX", "KTBW", "KBOX", "KAKQ"):
        edge[s] = {"ratio": 1.51}
    assert decide(edge)["ships"] is False
    few = {s: radars[s] for s in ("KOKX", "KDIX", "KMHX", "KLTX", "KCLE", "KPBZ")}
    assert len(decide(few)["pairs"]) == 3 < MIN_PAIRS and decide(few)["ships"] is False
    assert decide({})["ships"] is False and decide({})["median_disagreement"] is None
