"""B feasibility counts: a sewershed is near a radar if any county it has ever served is, whatever the row order."""

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
