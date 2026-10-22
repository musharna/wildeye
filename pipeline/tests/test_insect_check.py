import datetime as dt
import math

import numpy as np
import pyproj
import pytest

from pipeline import insect_check as ic

HEADER = "# date   time HGHT    u      v       w     ff    dd  sd_vvp gap dbz     eta   dens   DBZH   n   n_dbz n_all n_dbz_all"

def profile(rows):
    """vol2bird text with (height, u, v, dens) rows."""
    out = ["# vol2bird Vertical Profile of Birds (VPB)", HEADER]
    for h, u, v, d in rows:
        out.append(f"20261016 0400 {h} {u} {v} 0 {math.hypot(u, v):.2f} 0 3 F 10 100 {d} 10 1 1 1 1")
    return "\n".join(out)

COL = {"hgt": [100.0, 1500.0, 3000.0], "u": [10.0, 10.0, 10.0], "v": [0.0, 0.0, 0.0], "levels": [1000, 850, 700]}
T = dt.datetime(2026, 10, 16, 4, 10, tzinfo=dt.UTC)
HOUR = dt.datetime(2026, 10, 16, 4, tzinfo=dt.UTC)

def test_idx_ranges_takes_hgt_and_the_shared_uv_message_and_raises_on_a_missing_level():
    idx = "\n".join([
        "1:0:d=2026101700:HGT:850 mb:anl:", "2:100:d=2026101700:TMP:850 mb:anl:",
        "3.1:250:d=2026101700:UGRD:850 mb:anl:", "3.2:250:d=2026101700:VGRD:850 mb:anl:",
        "4:400:d=2026101700:HGT:825 mb:anl:", "5.1:500:d=2026101700:UGRD:825 mb:anl:",
        "5.2:500:d=2026101700:VGRD:825 mb:anl:"])
    assert ic.idx_ranges(idx, levels=(850, 825)) == [(0, 99), (250, 399), (400, 499), (500, None)]
    with pytest.raises(ValueError, match="lacks"):
        ic.idx_ranges(idx, levels=(850, 800))

def test_to_earth_turns_by_the_cone_angle_and_back():
    assert ic.to_earth(3.0, 4.0, 265.0, 265.0, 25.0) == pytest.approx((3.0, 4.0))
    u, v = ic.to_earth(1.0, 0.0, -75.0, 265.0, 25.0)      # 20 deg east of LoV: the grid x axis dips south
    assert math.degrees(math.atan2(v, u)) == pytest.approx(-math.sin(math.radians(25)) * 20, abs=1e-9)
    assert ic.to_earth(u, v, -75.0, 265.0, -25.0) == pytest.approx((1.0, 0.0))

def lambert_grid(lon0=265.0, lat0=25.0):
    """A small RAP-like tangent Lambert grid (13 km) drawn by pyproj: lat/lon arrays [j, i]."""
    lcc = pyproj.Proj(proj="lcc", lat_1=lat0, lat_2=lat0, lat_0=lat0, lon_0=lon0, R=6371229)
    x0, y0 = lcc(-84.6, 33.4)
    xs, ys = np.meshgrid(x0 + 13545.0 * np.arange(-5, 6), y0 + 13545.0 * np.arange(-5, 6))
    lon, lat = lcc(xs, ys, inverse=True)
    return lat, lon

def test_turn_error_is_tiny_on_a_real_lambert_grid_and_large_when_the_turn_is_wrong():
    lat, lon = lambert_grid()
    assert ic.turn_error_deg(lat, lon, (5, 5), (265.0, 25.0)) < 0.05
    assert ic.turn_error_deg(lat, lon, (5, 10), (265.0, 25.0)) < 0.05   # last column: steps back along x
    assert ic.turn_error_deg(lat, lon, (5, 5), (265.0, -25.0)) > ic.TURN_MAX_DEG   # turned the wrong way
    assert ic.turn_error_deg(lat, lon, (5, 5), (265.0, 0.0)) > ic.TURN_MAX_DEG     # not turned at all

def test_wind_at_is_linear_in_height_and_none_outside_the_column():
    col = {"hgt": [1000.0, 100.0], "u": [5.0, 1.0], "v": [-2.0, 0.0]}
    assert ic.wind_at(550.0, col) == pytest.approx((3.0, -1.0))
    assert ic.wind_at(100.0, col) == pytest.approx((1.0, 0.0))
    assert ic.wind_at(99.0, col) is None and ic.wind_at(1001.0, col) is None

def test_birds_flying_through_the_wind_read_birds_and_drifters_read_insects():
    birds = profile([(200, 10.0, -10.0, 30.0), (400, 10.0, -9.0, 20.0)])      # 9-10 m/s south through a 10 m/s west wind
    drift = profile([(200, 11.0, 0.5, 30.0), (400, 10.5, -1.0, 20.0)])        # ~1 m/s through the air
    b = ic.night_airspeed([(T, birds)], {HOUR: COL}, 5.0)
    d = ic.night_airspeed([(T, drift)], {HOUR: COL}, 5.0)
    assert b["verdict"] == "birds" and b["airspeed_ms"] == pytest.approx((30 * 10 + 20 * 9) / 50)
    assert b["insect_share"] == 0.0 and b["profiles_used"] == 1
    assert d["verdict"] == "insects" and d["insect_share"] == 1.0 and d["airspeed_ms"] < 2
    assert d["wind_effect_ms"] > 5            # ground speed ~10.5, airspeed ~1: the wind changed the answer

def test_the_night_verdict_weighs_bins_by_density():
    mixed = profile([(200, 11.0, 0.0, 49.0), (400, 10.0, -10.0, 51.0)])
    r = ic.night_airspeed([(T, mixed)], {HOUR: COL}, 5.0)
    assert r["insect_share"] == pytest.approx(0.49) and r["verdict"] == "birds"
    r = ic.night_airspeed([(T, profile([(200, 11.0, 0.0, 51.0), (400, 10.0, -10.0, 49.0)]))], {HOUR: COL}, 5.0)
    assert r["verdict"] == "insects"
    assert r["insect_share_at"]["7.0"] == pytest.approx(0.51)

def test_no_wind_or_a_wind_that_changes_nothing_is_void_not_birds():
    birds = profile([(200, 0.0, -10.0, 30.0)])
    calm = {"hgt": [100.0, 3000.0], "u": [0.0, 0.0], "v": [0.0, 0.0]}
    assert ic.night_airspeed([(T, birds)], {HOUR: calm}, 5.0)["verdict"] == "void"     # airspeed == ground speed
    r = ic.night_airspeed([(T, birds)], {}, 5.0)
    assert r["verdict"] == "void" and r["profiles_without_wind"] == 1
    assert ic.night_airspeed([], {HOUR: COL}, 5.0)["verdict"] is None
    assert ic.night_airspeed([(T, birds)], {HOUR: COL}, 5.0)["verdict"] == "birds"     # same bins, real wind

def test_bins_above_the_wind_column_are_counted_not_guessed():
    p = profile([(200, 10.0, -10.0, 30.0), (3200, 10.0, -10.0, 10.0)])
    r = ic.night_airspeed([(T, p)], {HOUR: COL}, 5.0)
    assert r["dens_share_outside_wind"] == pytest.approx(0.25) and r["verdict"] == "birds"

def test_profiles_take_the_nearest_analysis_hour():
    assert ic.nearest_hour(dt.datetime(2026, 10, 16, 4, 29, tzinfo=dt.UTC)) == HOUR
    assert ic.nearest_hour(dt.datetime(2026, 10, 16, 3, 30, tzinfo=dt.UTC)) == HOUR
    assert ic.nearest_hour(dt.datetime(2026, 10, 16, 23, 45, tzinfo=dt.UTC)) == dt.datetime(2026, 10, 17, tzinfo=dt.UTC)

def test_raob_uv_reads_direction_from_and_knots():
    prof = [{"pres": 850.0, "drct": 270.0, "sknt": 10.0}, {"pres": 700.0, "drct": None, "sknt": 5.0}]
    assert ic.raob_uv(prof, 850.0) == pytest.approx((5.14444, 0.0), abs=1e-4)      # from the west: blows east
    assert ic.raob_uv(prof, 700.0) is None and ic.raob_uv(prof, 925.0) is None

def nights_with(**over):
    """Every asked night and control reading birds, one insect night at KMLB, then {'SITE_YYYY-MM-DD': verdict}."""
    out = {}
    for sid, n in ic.ASKED + ic.BIRD_CONTROLS:
        out.setdefault(sid, {})[n] = {"verdict": "birds", "airspeed_ms": 9.04, "insect_share": 0.123}
    out.setdefault("KMLB", {})["2026-09-28"] = {"verdict": "insects", "airspeed_ms": 3.2, "insect_share": 0.8}
    for k, v in over.items():
        sid, n = k.split("_")
        out.setdefault(sid, {})[n] = {"verdict": v, "airspeed_ms": 4.0, "insect_share": 0.6}
    return out

def verdicts(table):
    return {v["verdict"] for v in table.values()}

def test_popup_says_birds_only_with_the_controls_engaged_and_lists_every_insect_night():
    controls, table = ic.popup_table(nights_with(), raob_passes=True)
    assert controls["bird_controls_pass"] and controls["insect_nights"] == ["KMLB 2026-09-28"]
    assert table["KFFC 2026-10-16"] == {"verdict": "birds", "airspeed_ms": 9.0, "insect_share": 0.12}
    assert table["KMLB 2026-09-28"]["verdict"] == "insects" and len(table) == len(ic.ASKED) + 1
    # a bird control that reads insects, or a wind the radiosondes reject, leaves nothing the check can vouch for
    assert verdicts(ic.popup_table(nights_with(**{"KBUF_2026-10-16": "insects"}), True)[1]) == {"unclear"}
    assert verdicts(ic.popup_table(nights_with(), raob_passes=False)[1]) == {"unclear"}

def test_popup_birds_turn_unclear_when_no_night_ever_read_insects():
    n = nights_with()
    del n["KMLB"]
    controls, table = ic.popup_table(n, raob_passes=True)
    assert controls["insect_nights"] == [] and verdicts(table) == {"unclear"}
    n["KFFC"]["2026-10-12"] = {"verdict": "insects", "airspeed_ms": 3.0, "insect_share": 0.7}
    _, table = ic.popup_table(n, raob_passes=True)
    assert table["KFFC 2026-10-12"]["verdict"] == "insects" and table["KFFC 2026-10-16"]["verdict"] == "birds"

def test_a_void_or_missing_night_is_unclear():
    n = nights_with(**{"KFFC_2026-10-11": "void"})
    del n["KOHX"]["2026-10-16"]
    _, table = ic.popup_table(n, raob_passes=True)
    assert table["KFFC 2026-10-11"]["verdict"] == "unclear"
    assert table["KOHX 2026-10-16"] == {"verdict": "unclear", "airspeed_ms": None, "insect_share": None}
