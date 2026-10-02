"""Controls for the own-surface probe (docs/superpowers/specs/2026-10-02-own-surface-probe-design.md).

Synthetic effort and species are planted on the real 512 x 512 grid; each test asserts the planted size
comes back, and the cross-validation tests assert what the surface is NOT allowed to see.
"""

import json
import math

import numpy as np
import pytest

from pipeline import geomodel_check as gc
from pipeline import geomodel_sources as gs
from pipeline import own_surface as osf


def _effort(rng):
    """An effort grid with a few hot spots over a low floor, like recording effort."""
    grid = rng.poisson(2.0, (gs.GRID, gs.GRID)).astype(np.int64)
    for lon, lat, w in [(10, 50, 400), (-80, 40, 300), (140, -30, 150), (20, -5, 60)]:
        r, c = osf.lonlat_to_cell(np.array([[lon, lat]]))
        grid[max(r[0] - 20, 0) : r[0] + 20, max(c[0] - 20, 0) : c[0] + 20] += w
    return grid


def _in_box(points, lon0, lat0, lon1, lat1):
    return (
        (points[:, 0] >= lon0)
        & (points[:, 0] < lon1)
        & (points[:, 1] >= lat0)
        & (points[:, 1] < lat1)
    )


def test_cells_and_areas_follow_the_mercator_grid():
    r, c = osf.lonlat_to_cell(
        np.array([[0.0, 0.0], [-179.99, 85.02], [179.99, -85.02]])
    )
    assert (r[0], c[0]) == (256, 256)
    assert (r[1], c[1]) == (0, 0) and (r[2], c[2]) == (511, 511)
    total = osf.mask_area_km2(np.ones((gs.GRID, gs.GRID), dtype=bool))
    lat_max = math.degrees(math.atan(math.sinh(math.pi)))
    assert total == pytest.approx(
        4 * math.pi * osf.EARTH_KM**2 * math.sin(math.radians(lat_max)) / 2 * 2,
        rel=1e-6,
    )
    one = np.zeros((gs.GRID, gs.GRID), dtype=bool)
    one[256, 256] = True  # the cell just south-east of (0, 0): ~78 km square
    assert osf.mask_area_km2(one) == pytest.approx(
        (2 * math.pi * osf.EARTH_KM / gs.GRID) ** 2, rel=0.01
    )


def _direct_smooth(grid, sigma):
    """The definition: separable Gaussian taps to 3 sigma, wrapping east-west, zero beyond the poles."""
    r = int(math.ceil(3 * sigma))
    k = np.arange(-r, r + 1)
    w = np.exp(-0.5 * (k / sigma) ** 2)
    w /= w.sum()
    across = sum(wi * np.roll(grid, int(ki), axis=1) for ki, wi in zip(k, w))
    padded = np.pad(across, ((r, r), (0, 0)))
    return sum(wi * padded[r + ki : r + ki + gs.GRID] for ki, wi in zip(k, w))


@pytest.mark.parametrize("sigma", osf.SIGMAS)
def test_smoothing_is_the_separable_gaussian(sigma):
    g = np.random.default_rng(13).poisson(3, (gs.GRID, gs.GRID)).astype(float)
    g[0, :] = 50.0  # mass on the north edge must not reach the south edge
    g[-1, 5] = 80.0
    g[200, -1] = 90.0  # and across the date line it must
    assert np.allclose(osf.smooth(g, sigma), _direct_smooth(g, sigma), atol=1e-9)


def test_smoothing_keeps_mass_and_wraps_east_west():
    grid = np.zeros((gs.GRID, gs.GRID))
    grid[256, 0] = 100.0
    out = osf.smooth(grid, 4)
    assert out.sum() == pytest.approx(100.0, rel=1e-6)
    assert (
        out[256, gs.GRID - 1] == pytest.approx(out[256, 1], rel=1e-9)
        and out[256, gs.GRID - 1] > 0
    )
    assert osf.smooth(grid, 1)[256, 0] > out[256, 0], (
        "a wider kernel spreads the same mass thinner"
    )


def test_the_rate_divides_by_effort():
    rng = np.random.default_rng(1)
    effort = _effort(rng) * 50
    flat = osf.rate(2 * effort, effort, 2)
    busy = effort > 0
    # a species recorded in proportion to effort has the same rate everywhere effort is
    assert np.nanstd(flat[busy]) / np.nanmean(flat[busy]) < 0.05
    counted = osf.rate(effort, np.zeros_like(effort), 2)
    assert np.nanstd(counted[busy]) / np.nanmean(counted[busy]) > 0.5, (
        "without the division it follows effort"
    )


def test_the_range_keeps_ninety_percent_of_its_training_records():
    rng = np.random.default_rng(2)
    effort = _effort(rng)
    background = gs.sample_background(effort, 5000, rng)
    training = background[_in_box(background, 0, 40, 20, 60)][:300]
    mask = osf.range_mask(training, effort, 2)
    share = osf.mask_inside(mask, training).mean()
    assert 0.88 <= share <= 0.97


@pytest.mark.parametrize("seed", [3, 4])
def test_a_clustered_species_is_recovered_and_a_pure_effort_species_is_not(seed):
    rng = np.random.default_rng(seed)
    effort = _effort(rng)
    background = gs.sample_background(effort, 5000, rng)
    # the cluster sits where the run's positive control puts it: the busiest 20-degree box holding at most a
    # tenth of the effort (a box over the main hot spot caps TSS near 0.68 even for a perfect range)
    lon0, lat0 = osf.positive_box(background)
    lon, lat = osf._cell_centres()
    inbox = (lon >= lon0) & (lon < lon0 + 20) & (lat >= lat0) & (lat < lat0 + 20)
    clustered = gs.sample_background(effort * inbox, 400, rng)
    fake = gs.sample_background(effort, 400, rng)
    smoothed = osf.smoothed_effort(effort)
    n, real, circles = osf.cross_validated(
        clustered, background, effort, smoothed, seed=seed, circles=False
    )
    assert n >= 300 and real >= 0.60
    n_fake, effort_only, _ = osf.cross_validated(
        fake, background, effort, smoothed, seed=seed, circles=False
    )
    assert n_fake >= 300 and abs(effort_only) < 0.10


def test_cross_validation_never_trains_on_the_blocks_it_tests():
    """Records in two blocks far apart, one per fold: trained on the other block, each fold must miss."""
    rng = np.random.default_rng(5)
    effort = _effort(rng)
    background = gs.sample_background(effort, 5000, rng)
    folds = osf.block_folds(seed=11)
    a, b = None, None
    for lon in range(
        -175, 180, 5
    ):  # two 5-degree blocks in different folds, 100 degrees of longitude apart
        fa = folds[osf.block_index(np.array([[lon, 47.5]]))[0]]
        fb = folds[
            osf.block_index(np.array([[(lon + 100 + 180) % 360 - 180, 47.5]]))[0]
        ]
        if fa != fb:
            a, b = lon, (lon + 100 + 180) % 360 - 180
            break
    recs = np.vstack(
        [
            np.column_stack([rng.uniform(a, a + 5, 60), rng.uniform(45, 50, 60)]),
            np.column_stack([rng.uniform(b, b + 5, 60), rng.uniform(45, 50, 60)]),
        ]
    )
    n, score, _ = osf.cross_validated(
        recs, background, effort, osf.smoothed_effort(effort), seed=11, circles=False
    )
    assert n == 120
    assert score < 0.2, "a fold that saw its own test block would score near 1"


def test_sigma_and_circles_use_only_the_training_records(monkeypatch):
    rng = np.random.default_rng(6)
    effort = _effort(rng)
    background = gs.sample_background(effort, 3000, rng)
    pool = gs.sample_background(effort, 20000, rng)
    recs = pool[_in_box(pool, -100, 20, -60, 60)][:200]
    seen = {"sigma": [], "circles": []}
    real_choose, real_circles = osf.choose_sigma, osf.equal_area_baseline

    def spy_choose(train, *a, **k):
        seen["sigma"].append(train.copy())
        return real_choose(train, *a, **k)

    def spy_circles(train, target_km2):
        seen["circles"].append((train.copy(), target_km2))
        return real_circles(train, target_km2)

    monkeypatch.setattr(osf, "choose_sigma", spy_choose)
    monkeypatch.setattr(osf, "equal_area_baseline", spy_circles)
    n, surface, circles = osf.cross_validated(
        recs, background, effort, osf.smoothed_effort(effort), seed=2
    )
    assert n > 0 and seen["sigma"] and len(seen["sigma"]) == len(seen["circles"])
    fold_map = osf.block_folds(seed=2)
    folds = fold_map[osf.block_index(recs)]
    for train, (circle_train, target) in zip(seen["sigma"], seen["circles"]):
        held_out = set(np.unique(folds)) - set(
            np.unique(fold_map[osf.block_index(train)])
        )
        assert len(held_out) == 1, "each call trains on every fold but the one it tests"
        assert len(train) == (folds != held_out.pop()).sum()
        assert np.array_equal(train, circle_train)
        assert target > 0
    assert -1.0 <= circles <= 1.0 and -1.0 <= surface <= 1.0


def test_positive_box_is_the_busiest_box_holding_at_most_a_tenth_of_the_effort():
    rng = np.random.default_rng(8)
    effort = _effort(rng)
    background = gs.sample_background(effort, 5000, rng)
    lon0, lat0 = osf.positive_box(background)
    share = _in_box(background, lon0, lat0, lon0 + 20, lat0 + 20).mean()
    assert share <= 0.10 and share > 0.02
    assert lon0 % 20 == 0 and lat0 % 20 == 0


# ---- the run ----------------------------------------------------------------------------------------


class FakeSources:
    def __init__(self, rng, placement=0.2, unmatched=("Nomen nudum",)):
        self.rng, self.placement, self.unmatched = rng, placement, set(unmatched)
        self.eff = _effort(rng)
        self.calls = []

    def verify(self):
        self.calls.append("verify")

    def placement_error(self):
        self.calls.append("placement")
        return self.placement

    def effort(self, group):
        self.calls.append(f"effort {group}")
        return self.eff

    def match(self, name):
        return None if name in self.unmatched else abs(hash(name)) % 10_000

    def records(self, key, rng):
        if key % 7 == 0:
            return np.zeros((0, 2))
        pool = gs.sample_background(self.eff, 20000, rng)
        lon0 = -170 + (key % 15) * 20
        return pool[_in_box(pool, lon0, -40, lon0 + 40, 60)][:300]


def _verdicts(groups, per=12):
    return {
        "groups": {
            g: {
                "species": [
                    {"taxon_id": i, "name": f"{g} species {i}"} for i in range(per)
                ]
                + [{"taxon_id": 999, "name": "Nomen nudum"}]
            }
            for g in groups
        }
    }


def test_run_scores_the_harness_species_and_counts_what_it_skips():
    rng = np.random.default_rng(9)
    src = FakeSources(rng)
    out = osf.run(src, _verdicts(["Aves"]), ["Aves"], seed=9, rng=rng)
    v = out["groups"]["Aves"]
    assert src.calls[:2] == ["verify", "placement"], (
        "effort placement is checked before any scoring"
    )
    names = {s["name"] for s in v["species"]}
    assert names <= {f"Aves species {i}" for i in range(12)}
    assert v["skipped"].get("no exact GBIF species match") == 1
    assert sum(v["skipped"].values()) + v["n_scored"] == 13
    assert v["verdict"] in ("pass", "fail", "insufficient")
    c = out["controls"]["Aves"]
    assert (
        c["fake_tss"] < osf.FAKE_TSS_MAX and c["positive_tss"] >= osf.POSITIVE_TSS_MIN
    )
    assert abs(c["shuffle_tss"]) < osf.SHUFFLE_TSS_MAX
    assert out["spec"].endswith("2026-10-02-own-surface-probe-design.md")


def test_misplaced_effort_stops_the_run_before_any_scoring():
    rng = np.random.default_rng(10)
    src = FakeSources(rng, placement=2.5)
    with pytest.raises(gc.ControlFailure, match="misplace"):
        osf.run(src, _verdicts(["Aves"]), ["Aves"], seed=10, rng=rng)
    assert not any(c.startswith("effort") for c in src.calls)


def test_a_failed_control_writes_nothing_and_exits_nonzero(tmp_path, monkeypatch):
    rng = np.random.default_rng(12)
    vpath = tmp_path / "verdicts.json"
    vpath.write_text(json.dumps(_verdicts(["Aves"])))
    out = tmp_path / "own.json"
    monkeypatch.setattr(
        osf, "POSITIVE_TSS_MIN", 1.01
    )  # a positive control nothing can reach
    code = osf.main(
        ["--verdicts", str(vpath), "--out", str(out), "--groups", "Aves"],
        sources=FakeSources(rng),
    )
    assert code != 0 and not out.exists()
    monkeypatch.setattr(osf, "POSITIVE_TSS_MIN", 0.60)
    code = osf.main(
        ["--verdicts", str(vpath), "--out", str(out), "--groups", "Aves"],
        sources=FakeSources(rng),
    )
    assert code == 0 and json.loads(out.read_text())["groups"]["Aves"]["n_scored"] > 0
