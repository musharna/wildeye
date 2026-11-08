import datetime as dt
import math
import random

from pipeline import e0b_rank as rb
from pipeline import e1_sst as e1


def test_sst_week_is_the_iso_week_mean_and_refuses_a_thin_week():
    mon = dt.date(2015, 6, 1)  # a Monday
    daily = {mon + dt.timedelta(days=k): float(k) for k in range(7)}
    s = e1.Sst(daily)
    assert (
        s.value(dt.date(2015, 6, 4)) == 3.0
    )  # any day of the week reads the week's mean
    thin = e1.Sst({d: v for d, v in daily.items() if v < 4})  # 4 of 7 days
    assert thin.value(dt.date(2015, 6, 4)) is None
    five = e1.Sst({d: v for d, v in daily.items() if v < 5})
    assert five.value(dt.date(2015, 6, 4)) == 2.0
    assert s.value(None) is None


def test_region_of_needs_the_whole_disc_inside_one_box():
    assert e1.region_of(46.0, -123.9) == "pacific"  # Oregon coast
    assert e1.region_of(29.3, -94.8) == "east"  # Galveston
    assert e1.region_of(21.3, -157.8) == "hawaii"
    assert (
        e1.region_of(30.3, -122.0) is None
    )  # disc crosses the pacific box's south edge
    assert e1.region_of(40.0, -105.0) is None  # Colorado: in no box


def test_disc_cells_and_reduce_skip_land_and_say_none_for_an_all_land_day():
    lats, lons = [45.0, 45.25, 45.5, 47.0], [-124.0, -123.75, -123.5]
    cells = e1.disc_cells(45.25, -123.75, lats, lons, radius=40)
    assert (3, 0) not in cells and (1, 1) in cells and len(cells) == 9
    nan = float("nan")
    day1 = [[10.0, nan, 12.0], [nan, 14.0, nan], [nan, nan, nan], [99.0, 99.0, 99.0]]
    day2 = [[nan] * 3, [nan] * 3, [nan] * 3, [99.0] * 3]
    assert e1.reduce_days([day1, day2], cells) == [12.0, None]


def warm_panel(n_counties=60, seed=3):
    """SST-like weekly series: a seasonal cycle plus a county-year anomaly (SD 0.7 C) and daily noise."""
    rng = random.Random(seed)
    out = {}
    for i in range(n_counties):
        anom = {y: rng.gauss(0, 0.7) for y in range(1996, 2030)}
        d, daily = dt.date(1996, 1, 1), {}
        while d <= dt.date(2026, 10, 23):
            daily[d] = (
                12
                + 5 * math.sin(2 * math.pi * d.timetuple().tm_yday / 365)
                + anom[d.year]
                + rng.gauss(0, 0.2)
            )
            d += dt.timedelta(days=1)
        out[f"{i:05d}"] = e1.Sst(daily)
    return out


def test_plants_through_the_e0b_path_read_0_at_beta_0_and_above_0_at_beta_1_per_c():
    sst = warm_panel()
    rng = random.Random(4)
    cases = [
        {
            "id": k,
            "fips": f,
            "start": dt.date(rng.randint(2001, 2025), rng.randint(1, 12), 10),
            "cls": "X",
            "suspect": False,
        }
        for k, f in enumerate(f for f in sst for _ in range(4))
    ]
    off = next(
        iter(
            rb.class_stats(rb.expected_cases(cases, sst, beta=0.0), sst, draws=300)[
                "classes"
            ].values()
        )
    )
    on = next(
        iter(
            rb.class_stats(
                rb.expected_cases(cases, sst, beta=100 * e1.BETA_PER_C), sst, draws=300
            )["classes"].values()
        )
    )
    assert off["mean_s"] == 0.0 and off["ci"] == [0.0, 0.0]
    assert on["ci"][0] > 0.05


def test_murre_check_fires_on_a_planted_heatwave_and_not_without_one():
    sst = warm_panel(n_counties=6)
    day = dt.date(2015, 12, 10)
    cases = [
        {"id": k, "fips": f, "start": day, "cls": "Nut/Met/Dev", "suspect": False}
        for k, f in enumerate(sorted(sst))
    ]
    cold = e1.murre_check(cases, sst)
    hot = {}
    for f, s in sst.items():
        hot[f] = e1.Sst(
            {d: v + (3.0 if d.year == 2015 else 0.0) for d, v in s.daily.items()}
        )
    warm = e1.murre_check(cases, hot)
    assert warm["fired"] and warm["mean_z"] > 2 and warm["scored"] == 6
    assert not cold["fired"]


def test_download_fails_loud_on_a_curl_error_and_passes_a_good_answer():
    import pytest

    class R:
        def __init__(self, code, err=""):
            self.returncode, self.stderr = code, err

    seen = []
    e1.download(
        "https://x/y.nc", "/tmp/never", run=lambda cmd, **kw: seen.append(cmd) or R(0)
    )
    assert (
        "--fail" in seen[0]
        and "--retry-all-errors" in seen[0]
        and seen[0][-1] == "https://x/y.nc"
    )
    with pytest.raises(RuntimeError, match="curl exit 22.*404 Not Found"):
        e1.download(
            "https://x/y.nc",
            "/tmp/never",
            run=lambda cmd, **kw: R(22, "curl: (22) 404 Not Found"),
        )


def test_disc_cells_drops_a_cell_beyond_the_radius_on_the_same_latitude():
    # -122.5 is ~98 km east of -123.75 at 45.25 N: inside the latitude prefilter, outside a 40 km disc
    cells = e1.disc_cells(45.25, -123.75, [45.25], [-123.75, -122.5], radius=40)
    assert cells == [(0, 0)]
    assert e1.disc_cells(45.25, -123.75, [45.25], [-123.75, -122.5], radius=120) == [
        (0, 0),
        (0, 1),
    ]


def week_series(values_by_year: dict[int, float], day: dt.date) -> e1.Sst:
    daily = {}
    for y, v in values_by_year.items():
        d = dt.date.fromisocalendar(y, *day.isocalendar()[1:])
        mon = d - dt.timedelta(days=d.weekday())
        daily.update({mon + dt.timedelta(days=k): v for k in range(7)})
    return e1.Sst(daily)


def test_murre_check_fires_at_one_sd_and_not_at_half_an_sd():
    day = dt.date(2015, 12, 10)
    base = {
        y: (10.0 if y % 2 else 12.0) for y in range(1997, 2013)
    }  # mean 11, SD 1.033
    case = [
        {"id": 1, "fips": "A", "start": day, "cls": "Nut/Met/Dev", "suspect": False}
    ]
    half = e1.murre_check(case, {"A": week_series(base | {2015: 11.5}, day)})
    two = e1.murre_check(case, {"A": week_series(base | {2015: 13.1}, day)})
    assert 0.4 < half["mean_z"] < 0.6 and not half["fired"]
    assert two["mean_z"] > 2 and two["fired"]
