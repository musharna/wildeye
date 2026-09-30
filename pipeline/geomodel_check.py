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
from pathlib import Path

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


# ---- the run ---------------------------------------------------------------------------------------

BACKGROUND_POINTS = 5000
PRESENCES_WANTED = 500
POSITIVE_BUFFER_KM = 25.0
SHUFFLE_TSS_MAX = 0.05
TILE_AGREEMENT_SPECIES = 3
TILE_ZOOM = 3
MAX_CANDIDATES = 3  # try up to 3 x SPECIES_PER_GROUP species to score SPECIES_PER_GROUP


class ControlFailure(RuntimeError):
    """A run control failed: the harness cannot be trusted this run, so no verdicts are written."""


def _tile_range(lon0, lat0, lon1, lat1, z):
    n = 2**z

    def tx(lon):
        return min(n - 1, max(0, int((lon + 180.0) / 360.0 * n)))

    def ty(lat):
        lat = max(-85.0511, min(85.0511, lat))
        y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0
        return min(n - 1, max(0, int(y * n)))

    return range(tx(lon0), tx(lon1) + 1), range(ty(lat1), ty(lat0) + 1)


def range_tile_mask(geom, z: int, x: int, y: int, size: int) -> np.ndarray:
    """Which pixel centres of web-mercator tile z/x/y (size x size) fall in geom."""
    n = 2**z
    idx = (np.arange(size) + 0.5) / size
    gx, gy = np.meshgrid((x + idx) / n, (y + idx) / n)
    lon = gx * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * gy))))
    return inside(geom, np.column_stack([lon.ravel(), lat.ravel()])).reshape(size, size)


def tile_agreement(geom, taxon_id: int, tile_mask, z: int = TILE_ZOOM) -> float:
    """Intersection over union between the GeoPackage range and iNaturalist's thresholded tiles."""
    xs, ys = _tile_range(*geom.bounds, z)
    inter = union = 0
    for x in xs:
        for y in ys:
            theirs = tile_mask(taxon_id, z, x, y)
            ours = range_tile_mask(geom, z, x, y, theirs.shape[0])
            inter += int((ours & theirs).sum())
            union += int((ours | theirs).sum())
    return inter / union if union else 0.0


def score_group(group: str, sources, rng: np.random.Generator, species_per_group: int) -> tuple[GroupRun, dict]:
    """Score up to species_per_group sampled species; return the scores and this group's control values."""
    run = GroupRun()
    background = sources.background(group, BACKGROUND_POINTS, rng)
    candidates = sources.species(group)
    order = rng.permutation(len(candidates))[: species_per_group * MAX_CANDIDATES]
    controls: dict = {}
    for i in order:
        if len(run.results) >= species_per_group:
            break
        taxon_id, name = candidates[i]
        key = sources.match(name)
        if key is None:
            run.skipped["no exact GBIF species match"] = run.skipped.get("no exact GBIF species match", 0) + 1
            continue
        presences = sources.presences(key, rng)
        if len(presences) < MIN_PRESENCES:
            run.skipped["fewer than 30 non-iNaturalist presences"] = run.skipped.get("fewer than 30 non-iNaturalist presences", 0) + 1
            continue
        training = sources.training(key, rng)
        if not len(training):
            run.skipped["no iNaturalist records on GBIF"] = run.skipped.get("no iNaturalist records on GBIF", 0) + 1
            continue
        geom = sources.range_geom(group, taxon_id)
        baseline = equal_area_baseline(training, area_km2(geom))
        result = SpeciesResult(taxon_id, name, len(presences), round(tss(geom, presences, background), 4), round(tss(baseline, presences, background), 4))
        run.results.append(result)
        if not controls:  # the run's controls, on this group's first scored species
            positive = transform(_FROM_EA, unary_union([shapely.Point(_TO_EA(*p)).buffer(POSITIVE_BUFFER_KM * 1000) for p in presences]))
            controls = {
                "species": name,
                "fake_tss": round(tss(geom, planted_fake_presences(background, len(presences), rng), background), 4),
                "positive_tss": round(tss(positive, presences, background), 4),
                "shuffle_tss": round(shuffle_null_tss(geom, presences, background, rng), 4),
                "real_tss": result.model_tss,
                "taxon_id": taxon_id,
            }
    return run, controls


def check_controls(group: str, controls: dict) -> list[str]:
    if not controls:
        return []  # no species scored: the group is insufficient, there is nothing to control
    failures = []
    if controls["fake_tss"] >= FAKE_TSS_MAX:
        failures.append(f"{group}: planted fake scored {controls['fake_tss']} (must be < {FAKE_TSS_MAX})")
    if controls["positive_tss"] < POSITIVE_TSS_MIN:
        failures.append(f"{group}: positive control scored {controls['positive_tss']} (must be >= {POSITIVE_TSS_MIN})")
    if abs(controls["shuffle_tss"]) >= SHUFFLE_TSS_MAX:
        failures.append(f"{group}: label shuffle scored {controls['shuffle_tss']} (|TSS| must be < {SHUFFLE_TSS_MAX})")
    return failures


def run(sources, groups: list[str], rng: np.random.Generator, species_per_group: int = SPECIES_PER_GROUP) -> dict:
    """Score every group, run the controls, and return the verdicts document; ControlFailure if any control fails."""
    sources.verify()
    out_groups, out_controls, failures, agreement = {}, {}, [], []
    for group in groups:
        scored, controls = score_group(group, sources, rng, species_per_group)
        failures += check_controls(group, controls)
        out_controls[group] = controls
        out_groups[group] = {
            **group_verdict(scored.results, scored.skipped),
            "species": [r.__dict__ for r in scored.results],
        }
        if controls and len(agreement) < TILE_AGREEMENT_SPECIES:
            geom = sources.range_geom(group, controls["taxon_id"])
            iou = round(tile_agreement(geom, controls["taxon_id"], sources.tile_mask), 4)
            agreement.append({"group": group, "species": controls["species"], "iou": iou})
            if iou < TILE_IOU_MIN:
                failures.append(f"{group}: {controls['species']} range and iNaturalist's thresholded tiles overlap {iou} (must be >= {TILE_IOU_MIN})")
    if len(agreement) < min(TILE_AGREEMENT_SPECIES, sum(bool(c) for c in out_controls.values())):
        failures.append("tile agreement ran on fewer species than required")
    if failures:
        raise ControlFailure("; ".join(failures))
    return {
        "geomodel_version": sources.version(),
        "spec": "docs/superpowers/specs/2026-09-29-geomodel-harness-design.md",
        "thresholds": {
            "median_tss_min": MEDIAN_TSS_MIN, "sign_p_max": SIGN_P_MAX, "min_scored": MIN_SCORED,
            "min_presences": MIN_PRESENCES, "species_per_group": species_per_group,
        },
        "groups": out_groups,
        "controls": {"per_group": out_controls, "tile_agreement": agreement},
    }


class LiveSources:
    """The harness's inputs from AWS Open Data (ranges) and GBIF, with ranges cached under `work`."""

    def __init__(self, work: Path):
        from . import geomodel_sources as gs

        self.gs, self.work, self.meta = gs, work, None
        self.files: dict[str, dict[int, Path]] = {}

    def verify(self):
        self.gs.verify_group_keys()
        self.meta = self.gs.fetch_json(self.gs.RANGES + "metadata.json")

    def version(self) -> str:
        return str(self.meta["version"])

    def species(self, group: str) -> list[tuple[int, str]]:
        out, where = [], {}
        for fname in self.gs.collection_files(group, self.meta):
            path = self.gs.download(self.gs.RANGES + fname, self.work / self.version() / fname)
            for taxon_id, name, version in self.gs.species_index(path):
                if version != self.version():
                    raise self.gs.SourceError(f"{fname} has geomodel {version}, metadata says {self.version()}")
                out.append((taxon_id, name))
                where[taxon_id] = path
        self.files[group] = where
        return out

    def range_geom(self, group: str, taxon_id: int):
        return self.gs.range_geometry(self.files[group][taxon_id], taxon_id)

    def background(self, group: str, n: int, rng):
        return self.gs.sample_background(self.gs.effort_grid(group), n, rng)

    def match(self, name: str):
        return self.gs.match_species(name)

    def presences(self, key: int, rng):
        return self.gs.occurrence_points(key, inat=False, want=PRESENCES_WANTED, rng=rng)

    def training(self, key: int, rng):
        return self.gs.occurrence_points(key, inat=True, want=PRESENCES_WANTED, rng=rng)

    def tile_mask(self, taxon_id: int, z: int, x: int, y: int):
        return self.gs.thresholded_tile_mask(taxon_id, z, x, y)


def main(argv=None, *, sources=None) -> int:
    import argparse
    import datetime as dt
    import logging
    import os
    import shutil

    from .atomic import write_atomic
    from .geomodel_sources import GROUPS

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=Path("public/data/geomodel_verdicts.json"))
    ap.add_argument("--work", type=Path, default=Path(os.environ.get("WILDEYE_WORK", "/tmp/wildeye-geomodel")))
    ap.add_argument("--groups", default=",".join(GROUPS), help="comma-separated collections (default: all 13)")
    ap.add_argument("--species-per-group", type=int, default=SPECIES_PER_GROUP)
    ap.add_argument("--seed", type=int, default=None, help="default: a fresh seed, recorded in the output")
    ap.add_argument("--keep-ranges", action="store_true", help="keep the downloaded GeoPackages")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log = logging.getLogger("geomodel")

    seed = args.seed if args.seed is not None else int.from_bytes(os.urandom(4), "little")
    groups = [g for g in args.groups.split(",") if g]
    unknown = sorted(set(groups) - set(GROUPS))
    if unknown:
        ap.error(f"unknown collections: {unknown}")
    live = sources is None
    sources = sources or LiveSources(args.work)
    try:
        doc = run(sources, groups, np.random.default_rng(seed), args.species_per_group)
    except ControlFailure as e:
        log.error("controls failed, no verdicts written: %s", e)
        return 2
    finally:
        if live and not args.keep_ranges:
            shutil.rmtree(args.work, ignore_errors=True)
    doc = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "seed": seed, **doc}
    write_atomic(args.out, doc)
    for g, v in doc["groups"].items():
        log.info("%s: %s (%s scored, median TSS %s)", g, v["verdict"], v["n_scored"], v.get("median_tss"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
