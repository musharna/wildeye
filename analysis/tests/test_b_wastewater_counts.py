"""B feasibility counts: a sewershed is near a radar if any county it has ever served is, whatever the row order."""

import json
import zipfile

import pytest

from analysis import b_wastewater_counts as b

RADARS = [{"id": "KNEAR", "lat": 40.0, "lon": -75.0}]
CENT = {
    "10001": (40.1, -75.0),
    "10002": (45.0, -60.0),
}  # ~11 km and ~1,400 km from the radar


def test_a_site_whose_counties_change_is_near_in_either_row_order():
    near_row = {"site": "s1", "county_fips": "10002, 10001"}
    far_row = {"site": "s1", "county_fips": "10002"}
    for rows in ([near_row, far_row], [far_row, near_row]):
        near, unplaced = b.near_radars(rows, CENT, RADARS)
        assert near == {"s1": {"KNEAR"}}
        assert unplaced == 0
    # positive control for the far side: a site serving only the far county is not near
    near, _ = b.near_radars([far_row | {"site": "s2"}], CENT, RADARS)
    assert near == {}


def test_unplaceable_sites_are_counted_not_dropped_silently():
    near, unplaced = b.near_radars(
        [{"site": "s3", "county_fips": "99999"}, {"site": "s4", "county_fips": ""}],
        CENT,
        RADARS,
    )
    assert (near, unplaced) == ({}, 2)


def test_fall_is_august_through_december():
    assert [
        b.fall(d) for d in ("2025-07-31", "2025-08-01", "2025-12-31", "2026-01-01")
    ] == [None, 2025, 2025, None]


def test_a_four_digit_county_code_gets_its_leading_zero():
    near, unplaced = b.near_radars(
        [{"site": "s5", "county_fips": "1001"}], {"01001": (40.1, -75.0)}, RADARS
    )
    assert (near, unplaced) == ({"s5": {"KNEAR"}}, 0)


def test_detect_reads_yes_and_no_in_any_case_and_stops_on_anything_else():
    assert [
        b.detected({"pcr_target_detect": v})
        for v in ("yes", "Yes", " YES ", "no", "No")
    ] == [
        True,
        True,
        True,
        False,
        False,
    ]
    for bad in ("maybe", "", None):
        with pytest.raises(ValueError, match="neither yes nor no"):
            b.detected(
                {
                    "pcr_target_detect": bad,
                    "site": "s6",
                    "sample_collect_date": "2025-09-01",
                }
            )


def test_only_the_h5_assay_is_counted_and_the_rest_are_reported():
    rows = [
        {"pcr_target": "fluav a h5"},
        {"pcr_target": "FLUAV A H5 "},
        {"pcr_target": "sars-cov-2"},
    ]
    kept, dropped = b.h5_only(rows)
    assert (len(kept), dropped) == (2, 1)
    assert all("h5" in r["pcr_target"].lower() for r in kept)


def _cache(tmp_path, n_rows, server_count):
    page = [{"site": f"s{i}", "pcr_target": "fluav a h5"} for i in range(n_rows)]
    (tmp_path / "h5_0.json").write_text(json.dumps(page))
    (tmp_path / "h5_count.json").write_text(json.dumps([{"count": str(server_count)}]))
    with zipfile.ZipFile(tmp_path / "gaz.zip", "w") as zf:
        zf.writestr(
            "2021_Gaz_counties_national.txt",
            "GEOID\tINTPTLAT\tINTPTLONG\n01001\t32.5\t-86.6\n",
        )
    return tmp_path


def test_rows_short_of_the_server_count_stop_the_run(tmp_path):
    (tmp_path / "ok").mkdir()
    rows, cent = b.fetch(_cache(tmp_path / "ok", 2, 2))
    assert (len(rows), cent) == (2, {"01001": (32.5, -86.6)})
    (tmp_path / "short").mkdir()
    with pytest.raises(RuntimeError, match="2 rows .* server count 3"):
        b.fetch(_cache(tmp_path / "short", 2, 3))
