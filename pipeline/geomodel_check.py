"""Monthly check of iNaturalist's geomodel ranges, per taxon group → public/data/geomodel_verdicts.json.

Step 1 of the bio-interpolation wave (grill_wildeye_bio_interpolation_2026-09-29). The design, the
decision rule and every threshold below are fixed in
docs/superpowers/specs/2026-09-29-geomodel-harness-design.md; change them only in a commit that says why.

A modeled range is scored against presences iNaturalist did not train on (non-iNaturalist GBIF records)
and against background points drawn where the whole taxon group is recorded (the effort control), with
the true skill statistic TSS = share of presences inside − share of background inside. It must also beat
circles drawn around the model's own iNaturalist records at the same total area.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import box
from shapely.ops import transform, unary_union

# Decision rule (spec, "Per group verdict"). Fixed before the first run.
SPECIES_PER_GROUP = 30
MIN_PRESENCES = 30
MIN_SCORED = 10
MEDIAN_TSS_MIN = 0.40
SIGN_P_MAX = 0.05
# Run controls (spec, "Controls").
FAKE_TSS_MAX = 0.10
POSITIVE_TSS_MIN = 0.60
TILE_IOU_MIN = 0.85

_TO_EA = Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True).transform
_FROM_EA = Transformer.from_crs("EPSG:6933", "EPSG:4326", always_xy=True).transform
# EPSG:6933 (equal-area cylindrical) world bounds, metres; buffers are clipped to it before going back to lon/lat.
_EA_WORLD = box(-17367530.45, -7314540.83, 17367530.45, 7314540.83)


@dataclass(frozen=True)
class SpeciesResult:
    taxon_id: int
    name: str
    n_presences: int
    model_tss: float
    baseline_tss: float


@dataclass
class GroupRun:
    results: list[SpeciesResult] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)


def inside(geom, points: np.ndarray) -> np.ndarray:
    """Which lon/lat points fall in (or on the edge of) geom."""
    points = np.asarray(points, dtype=float).reshape(-1, 2)
    if not len(points):
        return np.zeros(0, dtype=bool)
    shapely.prepare(geom)
    return shapely.intersects_xy(geom, points[:, 0], points[:, 1])


def tss(geom, presences: np.ndarray, background: np.ndarray) -> float:
    """True skill statistic of a binary range: share of presences inside minus share of background inside."""
    if not len(presences) or not len(background):
        raise ValueError("tss needs presences and background")
    return float(inside(geom, presences).mean() - inside(geom, background).mean())


def shuffle_null_tss(
    geom, presences: np.ndarray, background: np.ndarray, rng: np.random.Generator
) -> float:
    """TSS after swapping presence and background labels at random; the exchangeable unit is the point."""
    pooled = np.vstack([presences, background])
    order = rng.permutation(len(pooled))
    return tss(geom, pooled[order[: len(presences)]], pooled[order[len(presences) :]])


def area_km2(geom) -> float:
    return transform(_TO_EA, geom).area / 1e6


def _buffers(points_ea: list, radius_m: float):
    return unary_union(
        [p.buffer(radius_m, quad_segs=8) for p in points_ea]
    ).intersection(_EA_WORLD)


def equal_area_baseline(training: np.ndarray, target_km2: float):
    """Circles of one radius around each training record, the radius chosen so their union has the target area."""
    pts = [
        shapely.Point(_TO_EA(x, y))
        for x, y in np.asarray(training, dtype=float).reshape(-1, 2)
    ]
    if not pts:
        raise ValueError("equal_area_baseline needs training records")
    lo, hi = 1.0, 2.0e7
    for _ in range(60):
        mid = (lo + hi) / 2
        if _buffers(pts, mid).area / 1e6 < target_km2:
            lo = mid
        else:
            hi = mid
        if hi - lo < 100:
            break
    return transform(_FROM_EA, _buffers(pts, (lo + hi) / 2))


def sign_test_p(wins: int, losses: int) -> float:
    """One-sided sign test: P(at least `wins` successes in wins+losses fair coin flips)."""
    n = wins + losses
    if n == 0:
        return 1.0
    return sum(math.comb(n, k) for k in range(wins, n + 1)) / 2**n


def group_verdict(results: list[SpeciesResult], skipped: dict[str, int]) -> dict:
    """The spec's decision rule for one taxon group (controls are checked per run, not here)."""
    out = {"n_scored": len(results), "skipped": dict(skipped)}
    if len(results) < MIN_SCORED:
        return {**out, "verdict": "insufficient"}
    model = [r.model_tss for r in results]
    wins = sum(r.model_tss > r.baseline_tss for r in results)
    losses = sum(r.model_tss < r.baseline_tss for r in results)
    p = sign_test_p(wins, losses)
    median = statistics.median(model)
    passed = median >= MEDIAN_TSS_MIN and wins > losses and p < SIGN_P_MAX
    return {
        **out,
        "verdict": "pass" if passed else "fail",
        "median_tss": round(median, 3),
        "median_baseline_tss": round(
            statistics.median(r.baseline_tss for r in results), 3
        ),
        "beats_baseline": {"wins": wins, "losses": losses, "p": round(p, 4)},
    }


def planted_fake_presences(
    background: np.ndarray, n: int, rng: np.random.Generator
) -> np.ndarray:
    """A species that is pure effort: its presences are drawn from the background itself."""
    return background[rng.integers(0, len(background), n)]
