"""A outcome counts: what enters the county-weeks that decide A's included radar-falls."""

import datetime as dt

import pytest

from analysis import a_aphis_counts as a

TODAY = dt.date(2026, 11, 9)
RADARS = [{"id": "KNEAR", "lat": 40.0, "lon": -75.0}]
PLACES = {
    ("pennsylvania", "near"): (40.1, -75.0),  # ~11 km
    ("pennsylvania", "near2"): (40.5, -75.0),  # ~56 km
    ("maine", "far"): (45.0, -68.0),  # ~800 km
}


def row(
    county="near",
    state="pennsylvania",
    day=dt.date(2025, 10, 1),
    method="morbidity/mortality",
    captive=False,
):
    return {
        "state": state,
        "county": county,
        "collected": day,
        "method": method,
        "captive": captive,
    }


def test_county_weeks_count_distinct_counties_not_birds():
    rows = [
        row(),
        row(),
        row(),
        row(county="near2"),
    ]  # 3 birds in one county, 1 in another, same week
    out, why = a.count(rows, PLACES, RADARS, TODAY)
    w = (dt.date(2025, 10, 1) - dt.date(2025, 8, 1)).days // 7
    assert out["KNEAR"][2025]["mm"][w] == 4
    assert out["KNEAR"][2025]["mm_cw"][w] == 2
    assert why["kept"] == 4


def test_drops_are_counted_by_reason_and_kept_rows_still_count():
    rows = [
        row(captive=True),
        row(day=None),
        row(day=dt.date(2025, 7, 31)),
        row(county="nowhere"),
        row(county="far", state="maine"),
        row(),  # positive control: the legitimate row is kept
    ]
    out, why = a.count(rows, PLACES, RADARS, TODAY)
    assert dict(why) == {
        "captive": 1,
        "no_collection_date": 1,
        "outside_falls": 1,
        "unplaced_county": 1,
        "no_radar_within_150km": 1,
        "kept": 1,
    }
    assert sum(out["KNEAR"][2025]["mm"].values()) == 1


def test_an_unknown_sampling_method_raises_and_known_ones_are_split():
    out, _ = a.count([row(method="hunter harvest"), row()], PLACES, RADARS, TODAY)
    assert sum(out["KNEAR"][2025]["hunter"].values()) == 1
    assert sum(out["KNEAR"][2025]["mm"].values()) == 1
    with pytest.raises(ValueError, match="sampling method"):
        a.count([row(method="environmental sample")], PLACES, RADARS, TODAY)


def test_fall_bins_run_aug_1_to_dec_31():
    assert a.fall_week(dt.date(2025, 8, 1)) == (2025, 0)
    assert a.fall_week(dt.date(2025, 8, 7)) == (2025, 0)
    assert a.fall_week(dt.date(2025, 8, 8)) == (2025, 1)
    assert a.fall_week(dt.date(2025, 12, 31)) == (2025, 21)
    assert a.fall_week(dt.date(2025, 7, 31)) is None
    assert a.fall_week(dt.date(2026, 1, 1)) is None


def test_a_row_collected_after_the_run_date_is_dropped_and_counted():
    rows = [
        row(day=dt.date(2026, 11, 17)),
        row(day=TODAY),
    ]  # APHIS had a 2026-11-17 row on 2026-11-09
    out, why = a.count(rows, PLACES, RADARS, TODAY)
    assert why["collected_after_run_date"] == 1
    assert why["kept"] == 1  # positive control: a row collected on the run date is kept
    assert sum(out["KNEAR"][2026]["mm"].values()) == 1
