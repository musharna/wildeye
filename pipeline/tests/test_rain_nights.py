import datetime as dt
from pathlib import Path
from pipeline.rain_check import parse_reports
from pipeline.rain_nights import night_label, verdict

FIX = Path(__file__).parent / "fixtures" / "asos_JFK_20261016.csv"   # IEM asos.py as served, JFK 16-17 Oct 2026
U = dt.UTC

def test_night_label_rain_between_sunset_and_sunrise_dry_by_the_scan_rule():
    rep = parse_reports(FIX.read_text())
    ss, sr = dt.datetime(2026, 10, 16, 22, 10, tzinfo=U), dt.datetime(2026, 10, 17, 11, 10, tzinfo=U)
    assert night_label(rep, ss, sr) == "rain"                                    # 06:51 0.02 etc.
    assert night_label(rep, ss, dt.datetime(2026, 10, 17, 6, 0, tzinfo=U)) is None   # to 06:00: traces only, so not dry
    # the 16th's first wet report is 11:51 (0.01): a sunrise a minute before it leaves traces only, at it, rain
    assert night_label(rep, dt.datetime(2026, 10, 15, 22, 0, tzinfo=U), dt.datetime(2026, 10, 16, 11, 50, tzinfo=U)) is None
    assert night_label(rep, dt.datetime(2026, 10, 15, 22, 0, tzinfo=U), dt.datetime(2026, 10, 16, 11, 51, tzinfo=U)) == "rain"
    lo = dt.datetime(2026, 10, 1, 18, 51, tzinfo=U)
    dry = [(lo + dt.timedelta(hours=h), 0.0) for h in range(17)]
    assert night_label(dry, dt.datetime(2026, 10, 1, 21, 0, tzinfo=U), dt.datetime(2026, 10, 2, 8, 0, tzinfo=U)) == "dry"
    assert night_label(dry[:8] + dry[9:], dt.datetime(2026, 10, 1, 21, 0, tzinfo=U), dt.datetime(2026, 10, 2, 8, 0, tzinfo=U)) is None

def test_verdict_keeps_the_marker_only_at_the_bar_with_enough_nights_of_each_label():
    good = [(0.1, "rain")] * 15 + [(0.9, "dry")] * 15
    v = verdict(good, 0.55)
    assert v["keep_marker"] is True and v["balanced_accuracy"] == 1.0 and v["counts"] == {"rain": 15, "dry": 15}
    assert v["flagged"] == {"rain": 1.0, "dry": 0.0}
    assert verdict(good[1:], 0.55)["keep_marker"] is False                       # 14 rain nights
    edge = [(0.1, "rain")] * 8 + [(0.6, "rain")] * 8 + [(0.9, "dry")] * 16        # (0.5 + 1) / 2 = 0.75: kept
    assert verdict(edge, 0.55)["balanced_accuracy"] == 0.75 and verdict(edge, 0.55)["keep_marker"] is True
    under = [(0.1, "rain")] * 8 + [(0.6, "rain")] * 9 + [(0.9, "dry")] * 16
    assert verdict(under, 0.55)["keep_marker"] is False
    assert verdict([(0.1, "rain")] * 20, 0.55)["keep_marker"] is False            # no dry nights: no verdict
