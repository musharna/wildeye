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

import logging
import math
import shutil
import statistics
import tempfile
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import box
from shapely.ops import transform, unary_union

log = logging.getLogger("geomodel")

# Decision rule (spec, "Per group verdict"). Fixed before the first run.
SPECIES_PER_GROUP = 30
MIN_PRESENCES = 30
MIN_SCORED = 10
MEDIAN_TSS_MIN = 0.40
SIGN_P_MAX = 0.05
# Run controls (spec, "Controls").
FAKE_TSS_MAX = 0.10
POSITIVE_TSS_MIN = 0.60
TILE_IOU_MIN = 0.85  # median over TILE_AGREEMENT_SPECIES (ruling 2026-09-30, spec)

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


# Across months (spec, ruling 2026-10-02): one month's sign test flipped four collections Sept→Oct on sampling noise
# alone, and re-tested every month it lists a collection with no edge in up to ~48% of years. Evidence carries
# instead: a sequential probability ratio test on species wins and losses, H0 "beats the baseline on half the
# species" against H1 "on 60%", alpha 0.05, beta 0.10. Simulated on the two runs' 60 species per collection,
# a no-edge collection lists in <= 3.5% of years and none of the 8 with an edge drops (analysis/verdict_stability).
EVIDENCE_EDGE = 0.60
EVIDENCE_ALPHA, EVIDENCE_BETA = 0.05, 0.10
LIST_AT = math.log((1 - EVIDENCE_BETA) / EVIDENCE_ALPHA)  # 2.89
DROP_AT = math.log(EVIDENCE_BETA / (1 - EVIDENCE_ALPHA))  # -2.25, also the floor while not listed
EVIDENCE_CAP = LIST_AT + 3.0  # a listed collection that stops beating the baseline drops within months, not years


class EvidenceError(ValueError):
    """The prior verdicts file cannot carry evidence into this run."""


def carry_evidence(month: dict, prior: dict | None) -> dict:
    """A group's published verdict: `month` (group_verdict of this run) on top of its entry in the last verdicts file.

    `verdict` is pass while the group is listed; `month_verdict` is this run's own sign test."""
    llr, listed, months = 0.0, False, 0
    if prior is not None:
        llr, months = prior["evidence"]["llr"], prior["evidence"]["months"]
        listed = prior["verdict"] == "pass"
    if month["verdict"] == "insufficient":  # too few species scored: no evidence either way
        verdict = "pass" if listed else "insufficient"
        return {**month, "month_verdict": "insufficient", "verdict": verdict, "evidence": {"llr": llr, "months": months}}
    b = month["beats_baseline"]
    step = b["wins"] * math.log(EVIDENCE_EDGE / 0.5) + b["losses"] * math.log((1 - EVIDENCE_EDGE) / 0.5)
    llr = min(llr + step, EVIDENCE_CAP)
    if listed and llr <= DROP_AT:
        listed, llr = False, 0.0
    elif not listed and llr >= LIST_AT and month["median_tss"] >= MEDIAN_TSS_MIN:
        listed = True
    if not listed:  # months of losses must not bank doubt a collection that improves can never repay
        llr = max(llr, DROP_AT)
    return {
        **month,
        "month_verdict": month["verdict"],
        "verdict": "pass" if listed else "fail",
        "evidence": {"llr": round(llr, 4), "months": months + 1},
    }


def prior_evidence(prior_doc: dict | None, version: str, generated_at: str) -> dict:
    """Each group's entry in the last verdicts file, to carry into a run of geomodel `version` made at `generated_at`.

    Empty when there is no file or it checked another geomodel version. A file from before the evidence rule counts
    as one month: its own species rows are judged again."""
    import datetime as dt

    if prior_doc is None:
        return {}
    if prior_doc["geomodel_version"] != version:
        log.info("last verdicts checked geomodel %s, this run %s: evidence starts over", prior_doc["geomodel_version"], version)
        return {}
    if dt.datetime.fromisoformat(prior_doc["generated_at"]) >= dt.datetime.fromisoformat(generated_at):
        raise EvidenceError(
            f"the last verdicts ({prior_doc['generated_at']}) are not earlier than this run ({generated_at}): "
            "one run would be counted twice"
        )
    out = {}
    for group, v in prior_doc["groups"].items():
        if "evidence" in v:
            out[group] = v
        else:
            rows = [SpeciesResult(**r) for r in v.get("species", [])]
            out[group] = carry_evidence(group_verdict(rows, v.get("skipped", {})), None)
    return out


def judge(doc: dict, prior_doc: dict | None) -> dict:
    """The verdicts document with every group's verdict carried from `prior_doc` (spec, ruling 2026-10-02)."""
    prior = prior_evidence(prior_doc, doc["geomodel_version"], doc["generated_at"])
    groups = {}
    for group, v in doc["groups"].items():
        rows = [SpeciesResult(**r) for r in v["species"]]
        judged = carry_evidence(group_verdict(rows, v["skipped"]), prior.get(group))
        groups[group] = {**judged, "species": v["species"]}
        log.info(
            "%s: %s (evidence %s over %s months; this month %s)",
            group,
            judged["verdict"],
            judged["evidence"]["llr"],
            judged["evidence"]["months"],
            judged["month_verdict"],
        )
    thresholds = {
        **doc["thresholds"],
        "evidence": {
            "edge": EVIDENCE_EDGE,
            "alpha": EVIDENCE_ALPHA,
            "beta": EVIDENCE_BETA,
            "list_at": round(LIST_AT, 4),
            "drop_at": round(DROP_AT, 4),
            "cap": round(EVIDENCE_CAP, 4),
        },
    }
    return {**doc, "thresholds": thresholds, "groups": groups}


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
# two in each of the 13 collections (ruling 2026-10-02, spec)
TILE_AGREEMENT_SPECIES = 26
TILE_ZOOM = 3
# GBIF's count tiles against its own occurrence search, in a 6x6-cell block (geomodel_sources.placement_error):
# 0.22 live at the z4 tiles the effort grid uses, 2.57 at the z3 tiles it first used (2026-09-29)
PLACEMENT_ERROR_MAX = 0.4
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


def score_group(
    group: str, sources, rng: np.random.Generator, species_per_group: int
) -> tuple[GroupRun, dict]:
    """Score up to species_per_group sampled species; return the scores and this group's control values."""
    run = GroupRun()
    background = sources.background(group, BACKGROUND_POINTS, rng)
    candidates = sources.species(group)
    log.info(
        "%s: effort background drawn, %d species in the collection",
        group,
        len(candidates),
    )
    order = rng.permutation(len(candidates))[: species_per_group * MAX_CANDIDATES]
    controls: dict = {}
    for i in order:
        if len(run.results) >= species_per_group:
            break
        taxon_id, name = candidates[i]
        key = sources.match(name)
        if key is None:
            run.skipped["no exact GBIF species match"] = (
                run.skipped.get("no exact GBIF species match", 0) + 1
            )
            log.info("%s: skipped %s: no exact GBIF species match", group, name)
            continue
        presences = sources.presences(key, rng)
        if len(presences) < MIN_PRESENCES:
            run.skipped["fewer than 30 non-iNaturalist presences"] = (
                run.skipped.get("fewer than 30 non-iNaturalist presences", 0) + 1
            )
            log.info(
                "%s: skipped %s: fewer than 30 non-iNaturalist presences", group, name
            )
            continue
        training = sources.training(key, rng)
        if not len(training):
            run.skipped["no iNaturalist records on GBIF"] = (
                run.skipped.get("no iNaturalist records on GBIF", 0) + 1
            )
            log.info("%s: skipped %s: no iNaturalist records on GBIF", group, name)
            continue
        geom = sources.range_geom(group, taxon_id)
        baseline = equal_area_baseline(training, area_km2(geom))
        result = SpeciesResult(
            taxon_id,
            name,
            len(presences),
            round(tss(geom, presences, background), 4),
            round(tss(baseline, presences, background), 4),
        )
        run.results.append(result)
        log.info(
            "%s: %s TSS %s, baseline %s (%d presences)",
            group,
            name,
            result.model_tss,
            result.baseline_tss,
            len(presences),
        )
        if not controls:  # the run's controls, on this group's first scored species
            positive = transform(
                _FROM_EA,
                unary_union(
                    [
                        shapely.Point(_TO_EA(*p)).buffer(POSITIVE_BUFFER_KM * 1000)
                        for p in presences
                    ]
                ),
            )
            controls = {
                "species": name,
                "fake_tss": round(
                    tss(
                        geom,
                        planted_fake_presences(background, len(presences), rng),
                        background,
                    ),
                    4,
                ),
                "positive_tss": round(tss(positive, presences, background), 4),
                "shuffle_tss": round(
                    shuffle_null_tss(geom, presences, background, rng), 4
                ),
                "real_tss": result.model_tss,
                "taxon_id": taxon_id,
            }
    return run, controls


def check_controls(group: str, controls: dict) -> list[str]:
    if not controls:
        return []  # no species scored: the group is insufficient, there is nothing to control
    failures = []
    if controls["fake_tss"] >= FAKE_TSS_MAX:
        failures.append(
            f"{group}: planted fake scored {controls['fake_tss']} (must be < {FAKE_TSS_MAX})"
        )
    if controls["positive_tss"] < POSITIVE_TSS_MIN:
        failures.append(
            f"{group}: positive control scored {controls['positive_tss']} (must be >= {POSITIVE_TSS_MIN})"
        )
    if abs(controls["shuffle_tss"]) >= SHUFFLE_TSS_MAX:
        failures.append(
            f"{group}: label shuffle scored {controls['shuffle_tss']} (|TSS| must be < {SHUFFLE_TSS_MAX})"
        )
    return failures


def check_tile_agreement(
    sources, groups: list[str], rng: np.random.Generator
) -> list[dict]:
    """IoU between GeoPackage ranges and iNaturalist's thresholded tiles for up to TILE_AGREEMENT_SPECIES
    species; ControlFailure unless the median reaches TILE_IOU_MIN (spec, "Tile agreement")."""
    # iNaturalist's API is the run's only call to iNaturalist: check it before hours of GBIF work, so its
    # downtime (503 "downtime", 2026-09-30 00:05 EDT) costs seconds rather than the run
    # Species are drawn round-robin across the groups, each at most once, until TILE_AGREEMENT_SPECIES are
    # checked or the groups run out. The groups are walked in a fresh random order each run, so a run with
    # fewer species than two per group does not always leave out the same groups.
    # Every IoU is recorded; step 2 checks each species before display.
    order = [groups[i] for i in rng.permutation(len(groups))]
    pools = {g: list(sources.species(g)) for g in order}
    need = min(TILE_AGREEMENT_SPECIES, sum(len(p) for p in pools.values()))
    agreement = []
    while len(agreement) < need:
        for group in order:
            pool = pools[group]
            if not pool or len(agreement) >= need:
                continue
            taxon_id, name = pool.pop(int(rng.integers(len(pool))))
            iou = round(
                tile_agreement(
                    sources.range_geom(group, taxon_id), taxon_id, sources.tile_mask
                ),
                4,
            )
            agreement.append({"group": group, "species": name, "iou": iou})
            log.info("tile agreement %s (%s): IoU %s", name, group, iou)
    median_iou = statistics.median(a["iou"] for a in agreement) if agreement else 0.0
    log.info(
        "tile agreement median IoU %s over %s species (min %s)",
        median_iou,
        len(agreement),
        TILE_IOU_MIN,
    )
    if not agreement or median_iou < TILE_IOU_MIN:
        raise ControlFailure(
            "iNaturalist's thresholded tiles do not show the GeoPackage ranges tested: "
            f"median IoU {median_iou} over {len(agreement)} species (must be >= {TILE_IOU_MIN} "
            f"over up to {TILE_AGREEMENT_SPECIES}); "
            + ", ".join(f"{a['species']} {a['iou']}" for a in agreement)
        )
    return agreement


def run(
    sources,
    groups: list[str],
    rng: np.random.Generator,
    species_per_group: int = SPECIES_PER_GROUP,
) -> dict:
    """Score every group, run the controls, and return the verdicts document; ControlFailure if any control fails."""
    sources.verify()
    # before hours of scoring: a background built from tiles that misplace records is not effort
    placement = round(sources.placement_error(), 3)
    log.info("effort placement error %s (max %s)", placement, PLACEMENT_ERROR_MAX)
    if placement > PLACEMENT_ERROR_MAX:
        raise ControlFailure(
            f"GBIF count tiles misplace records: L1 error {placement} against occurrence search (must be <= {PLACEMENT_ERROR_MAX})"
        )
    agreement = check_tile_agreement(sources, groups, rng)
    out_groups, out_controls = {}, {}
    for group in groups:
        scored, controls = score_group(group, sources, rng, species_per_group)
        failures = check_controls(group, controls)
        if failures:  # the run will write nothing: stop now, not after hours more of the other groups
            raise ControlFailure("; ".join(failures))
        out_controls[group] = controls
        out_groups[group] = {
            **group_verdict(scored.results, scored.skipped),
            "species": [r.__dict__ for r in scored.results],
        }
        v = out_groups[group]
        log.info(
            "%s: %s (%s scored, median TSS %s)",
            group,
            v["verdict"],
            v["n_scored"],
            v.get("median_tss"),
        )
    return {
        "geomodel_version": sources.version(),
        "spec": "docs/superpowers/specs/2026-09-29-geomodel-harness-design.md",
        "thresholds": {
            "median_tss_min": MEDIAN_TSS_MIN,
            "sign_p_max": SIGN_P_MAX,
            "min_scored": MIN_SCORED,
            "min_presences": MIN_PRESENCES,
            "species_per_group": species_per_group,
        },
        "groups": out_groups,
        "controls": {
            "per_group": out_controls,
            "tile_agreement": agreement,
            "effort_placement_error": placement,
        },
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

    def placement_error(self) -> float:
        return self.gs.placement_error(*self.gs.PLACEMENT_BLOCK)

    def species(self, group: str) -> list[tuple[int, str]]:
        out, where = [], {}
        for fname in self.gs.collection_files(group, self.meta):
            path = self.gs.download(
                self.gs.RANGES + fname, self.work / self.version() / fname
            )
            for taxon_id, name, version in self.gs.species_index(path):
                if version != self.version():
                    raise self.gs.SourceError(
                        f"{fname} has geomodel {version}, metadata says {self.version()}"
                    )
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
        return self.gs.occurrence_points(
            key, inat=False, want=PRESENCES_WANTED, rng=rng
        )

    def training(self, key: int, rng):
        return self.gs.occurrence_points(key, inat=True, want=PRESENCES_WANTED, rng=rng)

    def tile_mask(self, taxon_id: int, z: int, x: int, y: int):
        return self.gs.thresholded_tile_mask(taxon_id, z, x, y)


def default_work() -> Path:
    """Where GeoPackages are cached during a run: $WILDEYE_WORK, else the user cache dir."""
    import os

    return Path(
        os.environ.get("WILDEYE_WORK")
        or Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
        / "wildeye"
        / "geomodel"
    )


@contextmanager
def run_workdir(root: Path, keep: bool = False):
    """A fresh directory under `root` for one run's GeoPackages, removed on exit unless `keep`. The monthly check and the
    species listing (or a rerun) can overlap, so a run removes only its own directory, never the shared root."""
    root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="run-", dir=root))
    try:
        yield work
    finally:
        if not keep:
            shutil.rmtree(work, ignore_errors=True)


def main(argv=None, *, sources=None, now=None) -> int:
    import argparse
    import datetime as dt
    import json
    import logging
    import os

    from .atomic import write_atomic
    from .geomodel_sources import GROUPS

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--out", type=Path, default=Path("public/data/geomodel_verdicts.json")
    )
    ap.add_argument("--work", type=Path, default=default_work())
    ap.add_argument(
        "--groups",
        default=",".join(GROUPS),
        help="comma-separated collections (default: all 13)",
    )
    ap.add_argument("--species-per-group", type=int, default=SPECIES_PER_GROUP)
    ap.add_argument(
        "--seed",
        type=int,
        default=None,
        help="default: a fresh seed, recorded in the output",
    )
    ap.add_argument(
        "--keep-ranges", action="store_true", help="keep the downloaded GeoPackages"
    )
    ap.add_argument(
        "--prior",
        type=Path,
        default=None,
        help="the last verdicts file, whose evidence carries into this run (default: --out, if it exists)",
    )
    ap.add_argument(
        "--rejudge",
        type=Path,
        default=None,
        help="judge a saved run's species rows again, against --prior, instead of running (no network)",
    )
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log = logging.getLogger("geomodel")

    seed = (
        args.seed if args.seed is not None else int.from_bytes(os.urandom(4), "little")
    )
    groups = [g for g in args.groups.split(",") if g]
    unknown = sorted(set(groups) - set(GROUPS))
    if unknown:
        ap.error(f"unknown collections: {unknown}")
    # read before hours of GBIF work: an unreadable prior must stop the run, not lose its evidence after it
    prior_path = args.prior or args.out
    prior = json.loads(prior_path.read_text()) if prior_path.exists() else None
    if args.rejudge:
        doc = json.loads(args.rejudge.read_text())
        log.info("judging %s (%s) again against %s", args.rejudge, doc["generated_at"], prior_path)
    else:
        live = sources is None
        with (
            run_workdir(args.work, keep=args.keep_ranges) if live else nullcontext() as work
        ):
            sources = sources or LiveSources(work)
            try:
                doc = run(
                    sources, groups, np.random.default_rng(seed), args.species_per_group
                )
            except ControlFailure as e:
                log.error("controls failed, no verdicts written: %s", e)
                return 2
        doc = {
            "generated_at": (now or (lambda: dt.datetime.now(dt.timezone.utc)))().isoformat(timespec="seconds"),
            "seed": seed,
            **doc,
        }
    doc = judge(doc, prior)
    write_atomic(args.out, doc)
    log.info("wrote %s", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
