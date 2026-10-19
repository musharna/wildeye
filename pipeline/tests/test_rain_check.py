import datetime as dt
from pathlib import Path
import pytest
from pipeline.rain_check import (km, nearest_gauge, parse_reports, label, balanced_accuracy, choose_threshold,
                                 decision, per_site, MAX_GAUGE_KM)

FIX = Path(__file__).parent / "fixtures" / "asos_JFK_20261016.csv"   # IEM asos.py as served, JFK 16-17 Oct 2026
U = dt.UTC

def test_parse_reports_reads_iem_csv_with_trace_and_missing():
    r = parse_reports(FIX.read_text())
    assert len(r) == 48 and r[0] == (dt.datetime(2026, 10, 16, 0, 51, tzinfo=U), 0.0)
    assert dict(r)[dt.datetime(2026, 10, 16, 9, 51, tzinfo=U)] == "T"
    assert dict(r)[dt.datetime(2026, 10, 17, 8, 51, tzinfo=U)] == 0.04
    m = parse_reports("station,valid,p01i\nX,2026-10-16 00:51,M\nX,2026-10-16 01:51,\n")
    assert [v for _, v in m] == [None, None]

def test_nearest_gauge_takes_the_closest_within_the_limit_only():
    st = [{"id": "FAR", "lonlat": [-73.0, 41.0]}, {"id": "NEAR", "lonlat": [-72.9, 40.9]}]
    g = nearest_gauge(st, -72.86, 40.87)
    assert g[0] == "NEAR" and g[1] == pytest.approx(km(-72.86, 40.87, -72.9, 40.9))
    assert nearest_gauge(st, -70.0, 40.0) is None and nearest_gauge([], 0, 0) is None
    assert km(0, 0, 0, 1) == pytest.approx(111.2, abs=0.1) and MAX_GAUGE_KM == 40.0

def test_label_rain_within_an_hour_dry_only_on_a_fully_reported_dry_night():
    rep = parse_reports(FIX.read_text())
    sunset, sunrise = dt.datetime(2026, 10, 16, 22, 10, tzinfo=U), dt.datetime(2026, 10, 17, 11, 10, tzinfo=U)
    assert label(dt.datetime(2026, 10, 17, 6, 0, tzinfo=U), rep, sunset, sunrise) == "rain"     # 06:51 0.02, 51 min
    assert label(dt.datetime(2026, 10, 17, 4, 50, tzinfo=U), rep, sunset, sunrise) is None      # 06:51 is 121 min on; traces only
    assert label(dt.datetime(2026, 10, 17, 5, 51, tzinfo=U), rep, sunset, sunrise) == "rain"    # exactly 60 min
    assert label(dt.datetime(2026, 10, 17, 5, 50, tzinfo=U), rep, sunset, sunrise) is None      # 61 min
    assert label(dt.datetime(2026, 10, 16, 14, 30, tzinfo=U), rep, sunset, sunrise) == "rain"   # only 13:51, exactly 0.01
    # a dry night: hourly zeros 18:51-10:51 cover sunset-2h .. sunrise+2h (15 hours)
    lo = dt.datetime(2026, 10, 1, 18, 51, tzinfo=U)
    dry = [(lo + dt.timedelta(hours=h), 0.0) for h in range(17)]
    ss, sr = dt.datetime(2026, 10, 1, 21, 0, tzinfo=U), dt.datetime(2026, 10, 2, 8, 0, tzinfo=U)
    scan = dt.datetime(2026, 10, 2, 1, 0, tzinfo=U)
    assert label(scan, dry, ss, sr) == "dry"
    assert label(scan, [(t, "T" if i == 3 else v) for i, (t, v) in enumerate(dry)], ss, sr) is None   # a trace
    assert label(scan, [(t, None if i == 8 else v) for i, (t, v) in enumerate(dry)], ss, sr) is None  # a missing hour
    assert label(scan, dry[:8] + dry[9:], ss, sr) is None                                             # an absent hour

def test_balanced_accuracy_and_the_threshold_choice():
    scans = [(0.01, "rain"), (0.2, "rain"), (0.6, "rain"), (0.7, "dry"), (0.8, "dry"), (0.15, "dry")]
    assert balanced_accuracy(scans, 0.5) == pytest.approx((2 / 3 + 2 / 3) / 2)   # 0.6 rain missed, 0.15 dry flagged
    assert balanced_accuracy(scans, 0.65) == pytest.approx((1 + 2 / 3) / 2)
    assert choose_threshold(scans) == 0.65                                        # 0.65 and 0.7 tie: the lower
    assert balanced_accuracy([(0.1, "rain")], 0.5) is None
    with pytest.raises(ValueError, match="both labels"):
        choose_threshold([(0.1, "rain")])

def test_decision_ships_only_at_the_bar_with_enough_held_out_scans_of_each_label():
    fit = [(0.1, "rain"), (0.9, "dry")]
    good = [(0.1, "rain")] * 30 + [(0.9, "dry")] * 30
    d = decision(fit, good)
    assert d["threshold"] == 0.15 and d["held_out_balanced_accuracy"] == 1.0 and d["ships"] is True
    assert d["held_out_counts"] == {"rain": 30, "dry": 30}
    assert decision(fit, good[1:])["ships"] is False                                  # 29 rain scans
    # half the rain missed at 0.15 -> (0.5 + 1) / 2 = 0.75: exactly the bar ships, a hair under does not
    edge = [(0.1, "rain")] * 15 + [(0.5, "rain")] * 15 + [(0.9, "dry")] * 30
    assert decision(fit, edge)["held_out_balanced_accuracy"] == 0.75 and decision(fit, edge)["ships"] is True
    under = [(0.1, "rain")] * 15 + [(0.5, "rain")] * 16 + [(0.9, "dry")] * 30
    assert decision(fit, under)["ships"] is False

def test_per_site_counts_each_label_and_the_share_flagged():
    rows = [{"site": "A", "share": 0.1, "label": "rain"}, {"site": "A", "share": 0.6, "label": "rain"},
            {"site": "A", "share": 0.9, "label": "dry"}, {"site": "B", "share": 0.2, "label": "dry"}]
    assert per_site(rows, 0.55) == {"A": {"rain": {"scans": 2, "flagged": 0.5}, "dry": {"scans": 1, "flagged": 0.0}},
                                    "B": {"rain": {"scans": 0, "flagged": None}, "dry": {"scans": 1, "flagged": 1.0}}}
