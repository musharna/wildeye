"""S3 season rerun (docs/analysis/s3_season_prereg.md): pixel unit, peak rule, gate, readings, controls."""

import inspect
import json

import numpy as np

from analysis import s3_lib as s
from analysis import s3_season_lib as ss

EVI_ENTRY = {
    "decode": [
        [i, 0, 0, round(0.02 * i, 2), round(0.02 * i + 0.02, 2)] for i in range(50)
    ]
}


def test_2024_dates_and_the_two_lst_composites_inside_each_evi_window():
    d = ss.evi_dates(2024)
    assert len(d) == 23 and d[0] == "2024-01-01" and d[-1] == "2024-12-18"
    assert "2024-09-13" in d
    assert ss.lst_pair("2024-09-13") == ("2024-09-13", "2024-09-21")
    assert ss.lst_pair("2024-12-18") == ("2024-12-18", "2024-12-26")


def test_children_nest_exactly_by_index():
    # level-7 global pixel (gx, gy) holds level-8 pixels 2g+{0,1} and level-9 pixels 4g+{0..3} per axis
    assert ss.children(10, 20, 1) == [(20, 40), (21, 40), (20, 41), (21, 41)]
    kids = ss.children(10, 20, 2)
    assert len(kids) == 16 and min(kids) == (40, 80) and max(kids) == (43, 83)
    # and the geometry agrees: each level-8 child's centre lies inside the parent level-7 pixel
    for cx, cy in ss.children(10, 20, 1):
        lat, lon = s.pixel_centre(8, cx // 256, cy // 256, cx % 256, cy % 256)
        x, y, px, py = s.tile_pixel(lat, lon, 7)
        assert (x * 256 + px, y * 256 + py) == (10, 20)


def test_lst_pixels_in_box_are_those_whose_centres_lie_inside():
    got = list(ss.lst_pixels_in_box(41.88, -87.63))
    assert got, "a 1 degree box holds level-7 pixels"
    for gx, gy in got:
        lat, lon = s.pixel_centre(7, gx // 256, gy // 256, gx % 256, gy % 256)
        assert 41.38 <= lat < 42.38 and -88.13 <= lon < -87.13
    # positive control: a pixel just outside the box is not included
    gx, gy = max(got)
    assert (gx + 1, gy) not in got


def test_only_pure_pixels_get_a_class():
    C, K = "Urban and Built-up Lands", "Croplands"
    assert ss.pixel_class([C] * 4) == "city"
    assert ss.pixel_class([K] * 4) == "cropland"
    assert ss.pixel_class([C, C, C, K]) is None
    assert ss.pixel_class(["Grasslands"] * 4) is None


def test_pixel_evi_is_the_mean_of_valid_children_and_needs_eight():
    dec = s.Decoder(EVI_ENTRY)
    val = ("value", 0.2, 0.22)
    assert abs(ss.pixel_evi([val] * 16, dec) - 0.21) < 1e-12
    assert abs(ss.pixel_evi([val] * 8 + [("nodata",)] * 8, dec) - 0.21) < 1e-12
    assert ss.pixel_evi([val] * 7 + [("nodata",)] * 9, dec) is None
    wide = ("value", 0.0, 1.0)  # 50x the median bin width
    assert abs(ss.pixel_evi([val] * 8 + [wide] * 8, dec) - 0.21) < 1e-12
    assert ss.pixel_evi([val] * 7 + [wide] * 9, dec) is None


def test_pixel_lst_is_the_mean_of_the_cloud_free_composites():
    dec = s.Decoder(
        {
            "decode": [
                [1, 0, 0, 300.0, 300.6],
                [2, 0, 0, 310.0, 310.6],
                [3, 0, 0, 0.02, 200.0],
            ]
        }
    )
    a, b = ("value", 300.0, 300.6), ("value", 310.0, 310.6)
    assert abs(ss.pixel_lst([a, b], dec) - (305.3 - 273.15)) < 1e-9
    assert abs(ss.pixel_lst([a, ("nodata",)], dec) - (300.3 - 273.15)) < 1e-9
    assert ss.pixel_lst([("nodata",), ("nodata",)], dec) is None
    assert (
        ss.pixel_lst([("value", 0.02, 200.0), ("nodata",)], dec) is None
    )  # wide fill bin only


def test_peak_date_is_the_highest_cropland_median_and_never_sees_lst():
    by_date = {
        "2024-01-01": [0.1, 0.2, 0.3],
        "2024-07-11": [0.5, 0.6, 0.4],
        "2024-07-27": [0.6, 0.5, 0.4],
    }
    assert ss.peak_date(by_date) == "2024-07-11"  # tie on median 0.5 -> earliest
    assert ss.peak_date({"2024-01-01": []}) is None
    assert ss.peak_date({}) is None
    assert list(inspect.signature(ss.peak_date).parameters) == ["cropland_evi_by_date"]


def test_engagement_gate():
    assert ss.engaged(0.6, 0.3) is True
    assert ss.engaged(0.3, 0.3) is False
    assert ss.engaged(None, 0.3) is False


def _row(gap, lo, hi, testable=True):
    return {"gap": gap, "ci_lo": lo, "ci_hi": hi, "testable": testable}


def test_readings_follow_the_preregistered_rules():
    up, down, flat = _row(1.0, 0.5, 1.5), _row(-1.0, -1.5, -0.5), _row(0.1, -0.3, 0.5)
    assert ss.reading(up, down, True) == "harvest idea supported"
    assert ss.reading(down, down, True) == "harvest idea refuted"
    assert ss.reading(up, up, True) == "year or counting, not season"
    assert ss.reading(up, down, False) == "unresolved"
    assert ss.reading(flat, down, True) == "unresolved"
    assert ss.reading(_row(1.0, 0.5, 1.5, testable=False), down, True) == "unresolved"


def _clustered(rng, n_city, n_crop, effect, pixel_sd=1.5):
    """Pixels with one LST each (shared by its 4 points); EVI varies per point around the pixel's."""
    n = n_city + n_crop
    city = np.arange(n) < n_city
    evi = rng.uniform(0.1, 0.6, n)
    lst = 25 - 8 * evi + effect * city + rng.normal(0, pixel_sd, n)
    return evi, lst, city


def test_pseudo_replication_control():
    # 0 true effect, one LST per pixel shared by its 4 points. Counting points as units shrinks the
    # shuffle null (the pilot's flaw) so it over-rejects; the pixel as the unit does not. Each arm's
    # observed gaps are compared with the 95th percentile of that arm's pooled shuffle null.
    rng = np.random.default_rng(7)
    obs = {"pixels": [], "points": []}
    null = {"pixels": [], "points": []}
    for _ in range(400):
        evi, lst, city = _clustered(rng, 60, 300, 0.0)
        pe = np.repeat(evi, 4) + rng.normal(0, 0.005, evi.size * 4)
        arms = {"pixels": (evi, lst, city), "points": (pe, np.repeat(lst, 4), np.repeat(city, 4))}
        for k, (e, l, c) in arms.items():
            obs[k].append(s.matched_gap(e, l, c)[0])
            null[k].append(s.matched_gap(e, l, rng.permutation(c))[0])
    rate = {k: float(np.mean(np.array(obs[k]) > np.percentile(null[k], 95))) for k in obs}
    assert rate["points"] >= 0.12, rate  # the pilot's flaw, shown
    assert rate["pixels"] <= 0.10, rate


def test_planted_effects_at_kano_sized_pixel_counts():
    rng = np.random.default_rng(3)
    r = s.region_stats(*_clustered(rng, 139, 7800, 2.0), rng)
    assert (
        r["ci_lo"] <= 2.0 <= r["ci_hi"]
        and r["ci_lo"] > 0
        and r["p"] < 0.05
        and s.region_passes(r)
    )
    r0 = s.region_stats(*_clustered(rng, 139, 7800, 0.0), rng)
    assert not (r0["ci_lo"] > 0 and r0["p"] < 0.05)


def test_check_date_is_the_most_common_peak_earliest_on_ties():
    from analysis.s3_season_checkpoints import check_date

    assert check_date({"a": "2024-07-11", "b": "2024-07-11", "c": "2024-03-05", "d": None}) == "2024-07-11"
    assert check_date({"a": "2024-07-27", "b": "2024-03-05"}) == "2024-03-05"


def test_peaks_come_from_cropland_evi_only(tmp_path):
    from analysis.s3_season_checkpoints import peaks_from

    rows = [
        ("R", 1, 1, "cropland", "2024-01-01", "0.2", "40.0"),
        ("R", 2, 1, "cropland", "2024-01-01", "0.4", "40.0"),
        ("R", 1, 1, "cropland", "2024-07-11", "0.5", "10.0"),
        ("R", 2, 1, "cropland", "2024-07-11", "0.6", "10.0"),
        ("R", 3, 1, "city", "2024-01-01", "0.9", "0.0"),  # a city pixel never decides the peak
    ]
    p = tmp_path / "pixels.csv"
    p.write_text("region,gx,gy,cls,date,evi,lst\n" + "".join(",".join(map(str, r)) + "\n" for r in rows))
    peaks, med, pix = peaks_from(p)
    assert peaks == {"R": "2024-07-11"}
    assert abs(med["R"]["2024-01-01"] - 0.3) < 1e-12  # np.median, the same rule as peak_date
    assert pix["R"] == [(1, 1), (2, 1), (3, 1)]


def test_harness_control_needs_the_right_classes_and_a_hotter_sahara():
    from analysis.s3_season_stats import harness_control

    ok = {"control": {"sahara": {"lc": ["class", "Barren"], "lst": ["value", 320.0, 320.6]},
                      "forest": {"lc": ["class", "Evergreen Broadleaf Forests"], "lst": ["value", 300.0, 300.6]}}}
    assert harness_control(ok)
    swapped = json.loads(json.dumps(ok))
    swapped["control"]["sahara"]["lst"], swapped["control"]["forest"]["lst"] = ok["control"]["forest"]["lst"], ok["control"]["sahara"]["lst"]
    assert not harness_control(swapped)
    wrong = json.loads(json.dumps(ok))
    wrong["control"]["forest"]["lc"] = ["class", "Croplands"]
    assert not harness_control(wrong)
    cloud = json.loads(json.dumps(ok))
    cloud["control"]["forest"]["lst"] = ["nodata"]
    assert not harness_control(cloud)
