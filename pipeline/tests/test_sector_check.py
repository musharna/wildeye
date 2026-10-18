import pytest
from pipeline.sector_check import radar_factor, verdict

def test_radar_factor_is_the_median_night_ratio_over_nights_both_have():
    land = {"n1": {"old": 20.0, "new": 4.0}, "n2": {"old": 30.0, "new": 6.0}, "n3": {"old": None, "new": 1.0}, "n4": {"old": 9.0, "new": 2.0}}
    full = {"n1": {"old": 10.0, "new": 2.0}, "n2": {"old": 10.0, "new": 3.0}, "n3": {"old": 5.0, "new": 1.0}, "n4": {"old": 0.0, "new": 1.0}}
    f = radar_factor(land, full)
    assert f["nights"] == 2 and f["old"] == pytest.approx(2.5)        # n3 no land value, n4 full is 0
    assert f["new"] == pytest.approx(2.0)                             # mt: 2, 2, 1, 2 -> median 2 over its own nights

def test_verdict_follows_the_rule_fixed_before_the_run():
    sea = {"A": 0.5, "B": 0.5, "C": 0.5, "D": 0.5, "E": 0.5}          # predicted 2.0, half-way 1.5
    def run(factors):
        return verdict({k: {"old": v} for k, v in zip(sea, factors)}, sea)["verdict"]
    assert run([1.5, 1.6, 2.0, 1.5, 1.0]) == "supported"               # 4 of 5 reach half the predicted rise
    assert run([1.49, 1.6, 2.0, 1.5, 1.0]) == "mixed"
    assert run([1.0, 1.05, 1.09, 0.9, 1.6]) == "falsified"             # 4 of 5 below 1.1
    assert run([1.1, 1.05, 1.09, 0.9, 1.6]) == "mixed"                 # 1.1 is not below 1.1
    v = verdict({"A": {"old": 1.5}}, {"A": 0.5})
    assert v["radars"]["A"]["predicted"] == pytest.approx(2.0) and v["radars"]["A"]["needed"] == pytest.approx(1.5)
