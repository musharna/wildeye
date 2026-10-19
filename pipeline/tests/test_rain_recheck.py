from pipeline.rain_recheck import recheck

def test_recheck_keeps_only_when_both_legs_clear_the_bar_with_enough_of_each_label():
    scans = [(0.1, "rain")] * 30 + [(0.9, "dry")] * 30
    nights = [(0.1, "rain")] * 15 + [(0.9, "dry")] * 15
    v = recheck(scans, nights, 0.55)
    assert v["keep"] is True and v["enough"] is True
    assert v["scan_balanced_accuracy"] == 1.0 and v["night_balanced_accuracy"] == 1.0
    assert v["scan_counts"] == {"rain": 30, "dry": 30} and v["night_counts"] == {"rain": 15, "dry": 15}
    assert recheck(scans[1:], nights, 0.55)["keep"] is False                       # 29 rain scans
    assert recheck(scans, nights[1:], 0.55)["keep"] is False                       # 14 rain nights
    half = [(0.1, "rain")] * 15 + [(0.6, "rain")] * 15 + [(0.9, "dry")] * 30       # (0.5 + 1) / 2 = 0.75: kept
    assert recheck(half, nights, 0.55)["scan_balanced_accuracy"] == 0.75 and recheck(half, nights, 0.55)["keep"] is True
    under = [(0.1, "rain")] * 14 + [(0.6, "rain")] * 16 + [(0.9, "dry")] * 30
    assert recheck(under, nights, 0.55)["keep"] is False                           # scan leg fails
    assert recheck(scans, [(0.1, "rain")] * 7 + [(0.6, "rain")] * 9 + [(0.9, "dry")] * 15, 0.55)["keep"] is False
    assert recheck(scans, nights, 0.05)["keep"] is False                           # same data, a threshold that flags nothing
    v = recheck([], [], 0.55)
    assert v["keep"] is False and v["scan_balanced_accuracy"] is None
