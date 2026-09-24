"""S3 pilot library: the same tile math and exact decode as the site, and statistics that pass their
pre-registered positive controls (docs/analysis/s3-heat-greenness-prereg.md) before touching real data."""

import json
from pathlib import Path

import numpy as np
import pytest

from analysis import s3_lib as s

FIX = json.loads((Path(__file__).parents[2] / "src/data/fixtures/gibs-readout.json").read_text())["layers"]


def test_tile_math_matches_the_site():
    # src/data/gibsReadout.test.mjs pins Chicago z8 to tile 65/95, pixel 175,37 (from the Python probe)
    assert s.tile_pixel(41.88, -87.63, 8) == (65, 95, 175, 37)
    assert s.tile_pixel(0, 180, 2) == s.tile_pixel(0, -180, 2)
    assert s.tile_pixel(86, 0, 5) is None
    assert s.pixel_centre(8, 65, 95, 175, 37) == pytest.approx((41.88, -87.63), abs=0.01)


def test_exact_decode_class_value_nodata_and_unknown():
    lc, evi = s.Decoder(FIX["gibs-landcover"]), s.Decoder(FIX["gibs-evi"])
    assert lc((49, 204, 49, 255)) == ("class", "Evergreen Broadleaf Forests")
    rgb = next(e for e in FIX["gibs-evi"]["decode"] if e[3] == 0.4251)[:3]
    assert evi((*rgb, 255)) == ("value", 0.4251, 0.4326)
    assert evi((0, 26, 105, 0)) == ("nodata",)
    with pytest.raises(s.UnknownColour, match=r"unknown colour 1,2,3"):
        evi((1, 2, 3, 255))


def test_wide_bins_are_flagged_so_a_point_is_never_given_a_made_up_value():
    lst = s.Decoder(FIX["gibs-lst"])
    top = FIX["gibs-lst"]["decode"][-1]  # [350.02, 652) K
    assert lst.is_wide(top[3], top[4]) and not lst.is_wide(298.4, 299.0)


def _synthetic(rng, heat, green_shift, n_city=300, n_crop=3000):
    # cropland EVI ~ U(0.15, 0.6); cities greener-shifted down by green_shift; LST falls 20 °C per unit EVI
    evi_crop = rng.uniform(0.15, 0.6, n_crop)
    evi_city = np.clip(rng.uniform(0.15, 0.6, n_city) - green_shift, 0.1, None)
    lst = lambda e: 40 - 20 * e + rng.normal(0, 1.5, e.size)
    evi = np.concatenate([evi_city, evi_crop])
    t = np.concatenate([lst(evi_city) + heat, lst(evi_crop)])
    city = np.concatenate([np.ones(n_city, bool), np.zeros(n_crop, bool)])
    return evi, t, city


def test_positive_control_a_planted_two_degree_effect_is_recovered():
    rng = np.random.default_rng(1)
    r = s.region_stats(*_synthetic(rng, heat=2.0, green_shift=0.0), rng=rng)
    assert r["testable"]
    assert r["ci_lo"] < 2.0 < r["ci_hi"] and r["ci_lo"] > 0
    assert r["p"] < 0.05 and s.region_passes(r)


def test_a_planted_zero_effect_is_not_a_pass():
    rng = np.random.default_rng(2)
    r = s.region_stats(*_synthetic(rng, heat=0.0, green_shift=0.0), rng=rng)
    assert r["testable"] and not s.region_passes(r)


def test_a_pure_greenness_effect_shows_unmatched_but_not_matched():
    rng = np.random.default_rng(3)
    r = s.region_stats(*_synthetic(rng, heat=0.0, green_shift=0.2), rng=rng)
    assert r["unmatched_gap"] > 2.0  # cities 0.2 EVI browner → ~4 °C hotter, unmatched
    assert r["ci_lo"] <= 0 <= r["ci_hi"] and not s.region_passes(r)


def test_too_few_matched_pairs_is_not_testable_and_not_a_pass():
    rng = np.random.default_rng(4)
    r = s.region_stats(*_synthetic(rng, heat=5.0, green_shift=0.0, n_city=20), rng=rng)
    assert not r["testable"] and not s.region_passes(r)


def test_overall_verdict_needs_four_testable_and_three_quarters_passing():
    ok = {"testable": True, "gap": 1, "ci_lo": 0.5, "ci_hi": 1.5, "p": 0.01}
    no = {**ok, "ci_lo": -0.1}
    untestable = {**ok, "testable": False}
    assert s.verdict([ok, ok, ok, no]) == "PASS"
    assert s.verdict([ok, ok, no, no]) == "FAIL"
    assert s.verdict([ok, ok, ok, untestable, untestable]) == "NOT TESTABLE"


def test_latest_date_is_the_sites_last_step_not_the_interval_end():
    from analysis.s3_sample import latest_date
    assert latest_date(["2025-01-01/2025-12-19/P16D", "2026-01-01/2026-08-29/P16D"]) == "2026-08-29"
    assert latest_date(["2001-01-01/2024-01-01/P1Y"]) == "2024-01-01"
    # an end that is not on a step: the site (src/data/gibsTime.js latestDate) keeps the last step before it
    assert latest_date(["2026-01-01/2026-01-20/P8D"]) == "2026-01-17"
    assert latest_date(["2019-04-18/2019-04-18/P1429D"]) == "2019-04-18"
