"""Own effort-corrected range surfaces: a probe (docs/superpowers/specs/2026-10-02-own-surface-probe-design.md).

For each species the geomodel harness scored (run 4950), build a range from openly licensed records divided by
the group's recording effort, cross-validated on held-out 5-degree blocks, and score it against equal-area circles
around the same training records with the harness's own decision rule. Nothing on the site reads the output.
"""

from __future__ import annotations

import logging
import math

import numpy as np

from .geomodel_check import (
    BACKGROUND_POINTS,
    MEDIAN_TSS_MIN,
    MIN_PRESENCES,
    MIN_SCORED,
    PLACEMENT_ERROR_MAX,
    PRESENCES_WANTED,
    SIGN_P_MAX,
    ControlFailure,
    SpeciesResult,
    equal_area_baseline,
    group_verdict,
    inside,
)
from .geomodel_sources import GRID, sample_background

log = logging.getLogger("own_surface")

SPEC = "docs/superpowers/specs/2026-10-02-own-surface-probe-design.md"
EARTH_KM = 6371.0088
LAT_MAX = math.degrees(
    math.atan(math.sinh(math.pi))
)  # the Web-Mercator grid's edge, 85.0511 degrees

SIGMAS = (
    1,
    2,
    4,
    8,
    16,
)  # Gaussian sigma in grid cells, chosen per fold by the inner cross-validation
KEEP = 0.90  # the range keeps this share of its training records (10th-percentile training threshold)
BLOCK_DEG = 5
FOLDS = 5
INNER_FOLDS = 4
MIN_TRAIN = 10

FAKE_TSS_MAX = 0.10
POSITIVE_TSS_MIN = 0.60
SHUFFLE_TSS_MAX = 0.05
SHUFFLES = 5  # the shuffle null is the mean of this many shuffles (one shuffle's noise is ~0.023 TSS)
POSITIVE_LAYOUTS = 5  # the positive control is the mean over this many fold layouts (one layout ranged 0.37-0.83)
POSITIVE_BOX_DEG = 20
POSITIVE_BOX_MAX_SHARE = 0.10
POSITIVE_RECORDS = 300

_LON_BLOCKS = 360 // BLOCK_DEG
_LAT_BLOCKS = 180 // BLOCK_DEG


# ---- the grid ---------------------------------------------------------------------------------------


def lonlat_to_cell(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Row (0 = north) and column of each lon/lat point on the 512 x 512 Web-Mercator effort grid."""
    p = np.asarray(points, dtype=float).reshape(-1, 2)
    lat = np.radians(np.clip(p[:, 1], -LAT_MAX, LAT_MAX))
    gx = (p[:, 0] + 180.0) / 360.0
    gy = (1.0 - np.arcsinh(np.tan(lat)) / math.pi) / 2.0
    col = np.clip(np.floor(gx * GRID).astype(int), 0, GRID - 1)
    row = np.clip(np.floor(gy * GRID).astype(int), 0, GRID - 1)
    return row, col


def _row_edges_lat() -> np.ndarray:
    gy = np.arange(GRID + 1) / GRID
    return np.arctan(
        np.sinh(math.pi * (1.0 - 2.0 * gy))
    )  # radians, north edge of each row, then the south edge


_ROW_AREA_KM2 = EARTH_KM**2 * (2 * math.pi / GRID) * -np.diff(np.sin(_row_edges_lat()))


def mask_area_km2(mask: np.ndarray) -> float:
    return float((mask.sum(axis=1) * _ROW_AREA_KM2).sum())


def count_grid(points: np.ndarray) -> np.ndarray:
    row, col = lonlat_to_cell(points)
    return (
        np.bincount(row * GRID + col, minlength=GRID * GRID)
        .reshape(GRID, GRID)
        .astype(float)
    )


def mask_inside(mask: np.ndarray, points: np.ndarray) -> np.ndarray:
    if not len(points):
        return np.zeros(0, dtype=bool)
    row, col = lonlat_to_cell(points)
    return mask[row, col]


_POLE_PAD = int(
    math.ceil(3 * max(SIGMAS))
)  # zero rows beyond each pole: the widest kernel never wraps pole to pole
_KERNELS: dict[float, np.ndarray] = {}


def _kernel_fft(sigma: float) -> np.ndarray:
    """The separable Gaussian's transform on the pole-padded grid, cached per sigma."""
    if sigma not in _KERNELS:
        r = int(math.ceil(3 * sigma))
        if r > _POLE_PAD:
            raise ValueError(
                f"sigma {sigma} reaches {r} rows, more than the {_POLE_PAD} rows of pole padding"
            )
        k = np.arange(-r, r + 1)
        w = np.exp(-0.5 * (k / sigma) ** 2)
        w /= w.sum()
        kernel = np.zeros((GRID + 2 * _POLE_PAD, GRID))
        kernel[np.ix_(k % kernel.shape[0], k % GRID)] = np.outer(w, w)
        _KERNELS[sigma] = np.fft.rfft2(kernel)
    return _KERNELS[sigma]


def smooth(grid: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian, wrapping east-west (the grid is the whole world) and zero beyond the poles."""
    padded = np.pad(np.asarray(grid, dtype=float), ((_POLE_PAD, _POLE_PAD), (0, 0)))
    out = np.fft.irfft2(np.fft.rfft2(padded) * _kernel_fft(sigma), s=padded.shape)
    return out[_POLE_PAD : _POLE_PAD + GRID]


def smoothed_effort(effort: np.ndarray) -> dict[int, np.ndarray]:
    """The effort grid smoothed at every candidate sigma, computed once per group."""
    return {s: smooth(effort, s) for s in SIGMAS}


def rate(species: np.ndarray, effort: np.ndarray, sigma: float) -> np.ndarray:
    """Records of the species per record of its group, both smoothed alike: what circles around dots cannot do."""
    return smooth(species, sigma) / (smooth(effort, sigma) + 1.0)


def range_mask(
    training: np.ndarray, effort: np.ndarray, sigma: int, smoothed: dict | None = None
) -> np.ndarray:
    """Cells whose rate is at least the rate at the training records' 10th percentile."""
    e = smoothed[sigma] if smoothed is not None else smooth(effort, sigma)
    r = smooth(count_grid(training), sigma) / (e + 1.0)
    row, col = lonlat_to_cell(training)
    return r >= np.quantile(r[row, col], 1.0 - KEEP)


# ---- cross-validation -------------------------------------------------------------------------------


def block_index(points: np.ndarray) -> np.ndarray:
    p = np.asarray(points, dtype=float).reshape(-1, 2)
    lon_b = np.clip(
        np.floor((p[:, 0] + 180.0) / BLOCK_DEG).astype(int), 0, _LON_BLOCKS - 1
    )
    lat_b = np.clip(
        np.floor((p[:, 1] + 90.0) / BLOCK_DEG).astype(int), 0, _LAT_BLOCKS - 1
    )
    return lat_b * _LON_BLOCKS + lon_b


def block_folds(seed: int, k: int = FOLDS) -> np.ndarray:
    """The fold of every 5-degree block, from a seeded permutation."""
    return np.random.default_rng(seed).permutation(_LON_BLOCKS * _LAT_BLOCKS) % k


def _tss(t) -> float:
    return t[0] / t[1] - (t[2] / t[3] if t[3] else 0.0)


def choose_sigma(train, bg_train, effort, smoothed, seed: int) -> int:
    """The sigma with the best pooled TSS over inner folds of the training blocks; ties to the smaller."""
    inner = block_folds(seed + 1, INNER_FOLDS)
    rf, bf = inner[block_index(train)], inner[block_index(bg_train)]
    best, best_tss = SIGMAS[0], -math.inf
    for sigma in SIGMAS:
        t = [0, 0, 0, 0]
        for i in range(INNER_FOLDS):
            test, fit = train[rf == i], train[rf != i]
            if not len(test) or len(fit) < MIN_TRAIN:
                continue
            mask = range_mask(fit, effort, sigma, smoothed)
            bg = bg_train[bf == i]
            t = [
                t[0] + mask_inside(mask, test).sum(),
                t[1] + len(test),
                t[2] + mask_inside(mask, bg).sum(),
                t[3] + len(bg),
            ]
        if t[1] and _tss(t) > best_tss:
            best, best_tss = sigma, _tss(t)
    return best


def cross_validated(
    records, background, effort, smoothed, *, seed: int, circles: bool = True
):
    """(scored test records, our surface's pooled TSS, the circles' pooled TSS or None) over held-out blocks."""
    folds = block_folds(seed)
    rf, bf = folds[block_index(records)], folds[block_index(background)]
    surf, circ, n = [0, 0, 0, 0], [0, 0, 0, 0], 0
    for f in range(FOLDS):
        test, train = records[rf == f], records[rf != f]
        if not len(test) or len(train) < MIN_TRAIN:
            continue
        bg_test, bg_train = background[bf == f], background[bf != f]
        sigma = choose_sigma(train, bg_train, effort, smoothed, seed)
        mask = range_mask(train, effort, sigma, smoothed)
        surf = [
            surf[0] + mask_inside(mask, test).sum(),
            surf[1] + len(test),
            surf[2] + mask_inside(mask, bg_test).sum(),
            surf[3] + len(bg_test),
        ]
        if circles:
            geom = equal_area_baseline(train, mask_area_km2(mask))
            circ = [
                circ[0] + inside(geom, test).sum(),
                circ[1] + len(test),
                circ[2] + inside(geom, bg_test).sum(),
                circ[3] + len(bg_test),
            ]
        n += len(test)
    if not n:
        return 0, math.nan, None
    return n, float(_tss(surf)), (float(_tss(circ)) if circles else None)


# ---- controls and the run ---------------------------------------------------------------------------


def positive_box(background: np.ndarray) -> tuple[int, int]:
    """South-west corner of the 20-degree box holding the most background among those holding at most a tenth."""
    best, best_share = None, -1.0
    for lat0 in range(-80, 80 - POSITIVE_BOX_DEG + 1, POSITIVE_BOX_DEG):
        for lon0 in range(-180, 180, POSITIVE_BOX_DEG):
            inbox = (
                (background[:, 0] >= lon0)
                & (background[:, 0] < lon0 + POSITIVE_BOX_DEG)
                & (background[:, 1] >= lat0)
                & (background[:, 1] < lat0 + POSITIVE_BOX_DEG)
            )
            share = inbox.mean()
            if share <= POSITIVE_BOX_MAX_SHARE and share > best_share:
                best, best_share = (lon0, lat0), share
    if best is None:
        raise ControlFailure(
            "no 20-degree box holds at most a tenth of the background: no positive control"
        )
    return best


def _cell_centres() -> np.ndarray:
    gx = (np.arange(GRID) + 0.5) / GRID
    gy = (np.arange(GRID) + 0.5) / GRID
    lon = gx * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * gy))))
    return np.meshgrid(lon, lat)  # (lon[row, col], lat[row, col])


def group_controls(first, background, effort, smoothed, *, seed: int, rng) -> dict:
    n = len(first)
    fake = sample_background(effort, n, rng)
    lon0, lat0 = positive_box(background)
    lon, lat = _cell_centres()
    boxed = effort * (
        (lon >= lon0)
        & (lon < lon0 + POSITIVE_BOX_DEG)
        & (lat >= lat0)
        & (lat < lat0 + POSITIVE_BOX_DEG)
    )
    positive = sample_background(boxed, POSITIVE_RECORDS, rng)
    shuffles = []
    for _ in range(SHUFFLES):
        pooled = np.vstack([first, background])[rng.permutation(n + len(background))]
        shuffles.append(
            cross_validated(
                pooled[:n], pooled[n:], effort, smoothed, seed=seed, circles=False
            )[1]
        )
    return {
        "fake_tss": round(
            cross_validated(
                fake, background, effort, smoothed, seed=seed, circles=False
            )[1],
            4,
        ),
        "positive_box": [lon0, lat0],
        # a layout that holds out half the box in one fold leaves nothing to fill it from, whatever the surface
        "positive_tss": round(
            float(
                np.mean(
                    [
                        cross_validated(
                            positive,
                            background,
                            effort,
                            smoothed,
                            seed=seed + k,
                            circles=False,
                        )[1]
                        for k in range(POSITIVE_LAYOUTS)
                    ]
                )
            ),
            4,
        ),
        "shuffle_tss": round(float(np.mean(shuffles)), 4),
    }


def check_controls(group: str, c: dict) -> list[str]:
    if not c:
        return []
    failures = []
    if not c["fake_tss"] < FAKE_TSS_MAX:
        failures.append(
            f"{group}: planted fake scored {c['fake_tss']} (must be < {FAKE_TSS_MAX})"
        )
    if not c["positive_tss"] >= POSITIVE_TSS_MIN:
        failures.append(
            f"{group}: positive control scored {c['positive_tss']} (must be >= {POSITIVE_TSS_MIN})"
        )
    if not abs(c["shuffle_tss"]) < SHUFFLE_TSS_MAX:
        failures.append(
            f"{group}: label shuffle scored {c['shuffle_tss']} (|mean| must be < {SHUFFLE_TSS_MAX})"
        )
    return failures


def _skip(skipped: dict, why: str) -> None:
    skipped[why] = skipped.get(why, 0) + 1


def run(sources, verdicts: dict, groups: list[str], *, seed: int, rng) -> dict:
    """Score every group's harness species; ControlFailure (nothing written) if any control fails."""
    sources.verify()
    placement = round(sources.placement_error(), 3)
    log.info("effort placement error %s (max %s)", placement, PLACEMENT_ERROR_MAX)
    if placement > PLACEMENT_ERROR_MAX:
        raise ControlFailure(
            f"GBIF count tiles misplace records: L1 error {placement} against occurrence search (must be <= {PLACEMENT_ERROR_MAX})"
        )
    out_groups, out_controls = {}, {}
    for group in groups:
        effort = sources.effort(group)
        smoothed = smoothed_effort(effort)
        background = sample_background(effort, BACKGROUND_POINTS, rng)
        results, skipped, first = [], {}, None
        for sp in verdicts["groups"][group]["species"]:
            key = sources.match(sp["name"])
            if key is None:
                _skip(skipped, "no exact GBIF species match")
                continue
            recs = sources.records(key, rng)
            if len(recs) < MIN_PRESENCES:
                _skip(skipped, "fewer than 30 non-iNaturalist presences")
                continue
            n, surface, circles = cross_validated(
                recs, background, effort, smoothed, seed=seed
            )
            if n < MIN_PRESENCES:
                _skip(skipped, "fewer than 30 cross-validated records")
                continue
            results.append(
                SpeciesResult(
                    sp["taxon_id"], sp["name"], n, round(surface, 4), round(circles, 4)
                )
            )
            log.info(
                "%s: %s TSS %.4f, circles %.4f (%d held-out records)",
                group,
                sp["name"],
                surface,
                circles,
                n,
            )
            if first is None:
                first = recs
        controls = (
            {}
            if first is None
            else group_controls(first, background, effort, smoothed, seed=seed, rng=rng)
        )
        failures = check_controls(group, controls)
        if failures:  # stop now, not after hours more of the other groups
            raise ControlFailure("; ".join(failures))
        out_controls[group] = controls
        out_groups[group] = {
            **group_verdict(results, skipped),
            "species": [r.__dict__ for r in results],
        }
        log.info(
            "%s: %s (%s scored, median TSS %s)",
            group,
            out_groups[group]["verdict"],
            len(results),
            out_groups[group].get("median_tss"),
        )
    return {
        "spec": SPEC,
        "seed": seed,
        "thresholds": {
            "median_tss_min": MEDIAN_TSS_MIN,
            "sign_p_max": SIGN_P_MAX,
            "min_scored": MIN_SCORED,
            "min_presences": MIN_PRESENCES,
            "keep": KEEP,
            "sigmas_cells": list(SIGMAS),
            "block_deg": BLOCK_DEG,
            "folds": FOLDS,
        },
        "groups": out_groups,
        "controls": out_controls,
        "effort_placement_error": placement,
    }


class LiveSources:
    """GBIF only: effort tiles, name matching and openly licensed non-iNaturalist records."""

    def __init__(self):
        from . import geomodel_sources as gs

        self.gs = gs

    def verify(self):
        self.gs.verify_group_keys()

    def placement_error(self) -> float:
        return self.gs.placement_error(*self.gs.PLACEMENT_BLOCK)

    def effort(self, group: str) -> np.ndarray:
        return self.gs.effort_grid(group)

    def match(self, name: str):
        return self.gs.match_species(name)

    def records(self, key: int, rng):
        return self.gs.occurrence_points(
            key, inat=False, want=PRESENCES_WANTED, rng=rng
        )


def main(argv=None, *, sources=None) -> int:
    import argparse
    import datetime as dt
    import json
    from pathlib import Path

    from .atomic import write_atomic

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--verdicts", type=Path, default=Path("public/data/geomodel_verdicts.json")
    )
    ap.add_argument(
        "--out", type=Path, default=Path("analysis/own_surface_verdicts.json")
    )
    ap.add_argument(
        "--groups", help="comma-separated; default every group in the verdicts"
    )
    ap.add_argument("--seed", type=int, default=20261002)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    verdicts = json.loads(a.verdicts.read_text())
    groups = a.groups.split(",") if a.groups else list(verdicts["groups"])
    try:
        out = run(
            sources or LiveSources(),
            verdicts,
            groups,
            seed=a.seed,
            rng=np.random.default_rng(a.seed),
        )
    except ControlFailure as e:
        log.error("controls failed, no verdicts written: %s", e)
        return 2
    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source_verdicts": str(a.verdicts),
        **out,
    }
    write_atomic(a.out, out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
