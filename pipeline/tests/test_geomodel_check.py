"""Controls for the geomodel harness (docs/superpowers/specs/2026-09-29-geomodel-harness-design.md).

Every control here calls the harness's own estimator and decision rule on planted data, and asserts the
planted SIZE comes back, not only that something was detected.
"""

import numpy as np
import pytest
from shapely.geometry import box

from pipeline import geomodel_check as gc

WORLD = (-60.0, -40.0, 60.0, 40.0)  # lon/lat box the synthetic data lives in
RANGE = box(0.0, -10.0, 20.0, 10.0)  # the synthetic "modeled range"


def _points_with_share_inside(rng, n, share_inside):
    """n points in WORLD, exactly round(n * share_inside) of them inside RANGE."""
    k = round(n * share_inside)
    inside = np.column_stack([rng.uniform(0, 20, k), rng.uniform(-10, 10, k)])
    out = []
    while len(out) < n - k:
        p = (rng.uniform(WORLD[0], WORLD[2]), rng.uniform(WORLD[1], WORLD[3]))
        if not (0 <= p[0] <= 20 and -10 <= p[1] <= 10):
            out.append(p)
    return np.vstack([inside, np.array(out).reshape(-1, 2)])


@pytest.mark.parametrize("true_tss", [0.0, 0.2, 0.4, 0.6, 0.8])
def test_planted_tss_comes_back(true_tss):
    rng = np.random.default_rng(int(true_tss * 10))
    background = _points_with_share_inside(rng, 4000, 0.15)
    presences = _points_with_share_inside(rng, 400, 0.15 + true_tss)
    assert gc.tss(RANGE, presences, background) == pytest.approx(true_tss, abs=0.05)


def test_shuffle_null_and_real_signal_separate():
    rng = np.random.default_rng(7)
    background = _points_with_share_inside(rng, 4000, 0.15)
    presences = _points_with_share_inside(rng, 400, 0.75)
    real = gc.tss(RANGE, presences, background)
    shuffled = gc.shuffle_null_tss(RANGE, presences, background, rng)
    assert real == pytest.approx(0.6, abs=0.05)
    assert abs(shuffled) < 0.05


def test_equal_area_baseline_matches_the_range_area():
    rng = np.random.default_rng(3)
    training = np.column_stack([rng.uniform(-50, 50, 60), rng.uniform(-30, 30, 60)])
    target = gc.area_km2(RANGE)
    baseline = gc.equal_area_baseline(training, target)
    assert gc.area_km2(baseline) == pytest.approx(target, rel=0.02)
    # every training point is inside its own buffer; a point far from all of them is not
    assert gc.inside(baseline, training).all()
    assert not gc.inside(baseline, np.array([[179.0, 89.0]])).any()


def test_sign_test():
    assert gc.sign_test_p(wins=20, losses=5) < 0.05
    assert gc.sign_test_p(wins=13, losses=12) > 0.4
    assert gc.sign_test_p(wins=0, losses=0) == 1.0


def _species(model, baseline, n=30):
    return [
        gc.SpeciesResult(
            taxon_id=i,
            name=f"s{i}",
            n_presences=100,
            model_tss=model,
            baseline_tss=baseline,
        )
        for i in range(n)
    ]


def test_group_verdict_flips_between_the_ladder_rungs():
    # the decision rule itself: TSS 0.2 everywhere fails, 0.6 passes, both beating the baseline
    assert gc.group_verdict(_species(0.2, 0.1), skipped={})["verdict"] == "fail"
    assert gc.group_verdict(_species(0.6, 0.1), skipped={})["verdict"] == "pass"
    # a high TSS that does not beat circles around the training records fails
    assert gc.group_verdict(_species(0.6, 0.7), skipped={})["verdict"] == "fail"
    # fewer than 10 scored species is insufficient, not pass, however good they look
    few = gc.group_verdict(_species(0.9, 0.1, n=9), skipped={"too few presences": 21})
    assert few["verdict"] == "insufficient"
    assert few["skipped"] == {"too few presences": 21}


def test_planted_fake_scores_as_effort():
    # a species whose presences are drawn from the background: pure effort, TSS ~ 0 whatever the range
    rng = np.random.default_rng(11)
    background = _points_with_share_inside(rng, 4000, 0.3)
    fake = gc.planted_fake_presences(background, 400, rng)
    assert gc.tss(RANGE, fake, background) < gc.FAKE_TSS_MAX
    # positive control in the same test: real presences concentrated in the range score high
    real = _points_with_share_inside(rng, 400, 0.95)
    assert gc.tss(RANGE, real, background) >= gc.POSITIVE_TSS_MIN
