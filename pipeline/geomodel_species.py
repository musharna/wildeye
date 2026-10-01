"""List every species of a collection that passed the geomodel check, with the IoU between iNaturalist's tiles and the tested range.

Spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md. Reads the verdicts file the check wrote and writes
public/data/geomodel_species.json, which the species card reads to decide whether to offer the modeled range.
iNaturalist asks for under 10,000 requests a day, and a full check of Arachnida is 20,861 z3 tiles, so the list is built in
two passes (spec: "Skim first"): `--mode skim` checks one tile per species, the z3 tile holding most of its range, which catches
a served map that is mostly a different shape; `--mode full` (the default) then checks every tile, a day's budget at a time
(`--max-tiles`), replacing skim scores as it goes. Each entry says which check its `iou` comes from (`check`: skim or full).
The list names every species from its first write (iou null until checked), rewrites itself every CHECKPOINT_EVERY species,
and a later run of the same model version picks up what is left.
Exit 2 = nothing written (the ranges are not the model that was checked, or a name is listed twice); exit 3 =
written, but some species are still unchecked (iou null, never shown): tiles failed, or the budget ran out.
"""

from __future__ import annotations

import json
import logging
from contextlib import nullcontext
from pathlib import Path

from .geomodel_check import (
    TILE_ZOOM,
    LiveSources,
    _tile_range,
    range_tile_mask,
    run_workdir,
    tile_agreement,
)
from .geomodel_sources import GROUPS, SourceError

SPECIES_IOU_MIN = 0.70  # spec ruling 1, fixed before the first per-species run
CHECKPOINT_EVERY = 200
log = logging.getLogger("geomodel")


class ListingError(RuntimeError):
    pass


def passing_species(sources, verdicts: dict) -> list[tuple[str, int, str]]:
    """(group, taxon id, name) of every species in a passing collection; ListingError on a model or name conflict."""
    sources.verify()
    if sources.version() != verdicts["geomodel_version"]:
        raise ListingError(
            f"ranges are geomodel {sources.version()}, the verdicts checked {verdicts['geomodel_version']}"
        )
    todo, seen = [], {}
    for group, v in verdicts["groups"].items():
        if v["verdict"] != "pass":
            continue
        for taxon_id, name in sources.species(group):
            # the browser keys by name: two taxa under one name cannot both be placed
            if name in seen:
                raise ListingError(
                    f"{name} is listed twice (taxa {seen[name]} and {taxon_id})"
                )
            seen[name] = taxon_id
            todo.append((group, taxon_id, name))
    return todo


def previous_entries(path: Path, version: str) -> dict[str, dict]:
    """{name: entry} from the list at `path`, if it is of the same model version. Entries written before check kinds
    existed came from the full check only, so a scored one without `check` is a full check."""
    try:
        doc = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    if doc.get("geomodel_version") != version:
        return {}
    entries = {}
    for name, s in doc["species"].items():
        entry = dict(s)
        if entry["iou"] is not None and "check" not in entry:
            entry["check"] = "full"
        entries[name] = entry
    return entries


def previous_tile_log(path: Path) -> list[dict]:
    """The tile_log of the list at `path` (any model version: requests count against iNaturalist's day all the same)."""
    try:
        return json.loads(path.read_text()).get("tile_log", [])
    except FileNotFoundError:
        return []


def skim_tile(geom, z: int = TILE_ZOOM) -> tuple[int, int]:
    """The tile (x, y) at zoom z holding the most of the range; the first in row order on a tie."""
    xs, ys = _tile_range(*geom.bounds, z)
    best = None
    for x in xs:
        for y in ys:
            n = int(range_tile_mask(geom, z, x, y, 64).sum())
            if best is None or n > best[0]:
                best = (n, x, y)
    return best[1], best[2]


def skim_agreement(geom, taxon_id: int, tile_mask, z: int = TILE_ZOOM) -> float:
    """Intersection over union on the one tile holding most of the range (one request)."""
    x, y = skim_tile(geom, z)
    theirs = tile_mask(taxon_id, z, x, y)
    ours = range_tile_mask(geom, z, x, y, theirs.shape[0])
    union = int((ours | theirs).sum())
    return int((ours & theirs).sum()) / union if union else 0.0


def full_tiles(geom, z: int = TILE_ZOOM) -> int:
    """How many tile requests tile_agreement() makes for this range."""
    xs, ys = _tile_range(*geom.bounds, z)
    return len(xs) * len(ys)


def check_tiles(
    sources,
    todo,
    known,
    write,
    *,
    mode: str = "full",
    include_full: bool = False,
    max_tiles: int | None = None,
    only: set[str] | None = None,
) -> int:
    """Score each species in `mode`, reusing `known`; write(species) from the start and every CHECKPOINT_EVERY checks.
    A skim scores species with no check yet (with include_full, every species without a skim score, recording it beside a
    full check without changing that check); a full check scores every species not yet fully checked. Stops before a
    species would take the tiles asked past max_tiles. Returns how many species are unchecked."""
    species = {}
    for group, taxon_id, name in todo:
        prev = known.get(name)
        if prev and prev["id"] == taxon_id:
            species[name] = {
                "id": taxon_id,
                "group": group,
                **{k: v for k, v in prev.items() if k in ("iou", "check", "iou_skim")},
            }
        else:
            species[name] = {"id": taxon_id, "group": group, "iou": None}

    def wanted(s):
        if mode == "full":
            return s.get("check") != "full"
        return "iou_skim" not in s if include_full else "check" not in s

    missing = [
        (g, t, n, sources.range_geom(g, t))
        for g, t, n in todo
        if wanted(species[n]) and (only is None or n in only)
    ]
    if mode == "full":
        # cheapest first: under a day's tile budget this fully checks the most species (compact ranges are ~4 tiles,
        # globe-spanning ones up to 64); sorted() is stable, so equal costs keep the list's order
        missing = sorted(missing, key=lambda m: full_tiles(m[3]))
    log.info(
        "%s check for %s of %s species in passing collections",
        mode,
        len(missing),
        len(todo),
    )
    failed = asked = 0
    write(species, asked)
    for i, (group, taxon_id, name, geom) in enumerate(missing, 1):
        s = species[name]
        cost = 1 if mode == "skim" else full_tiles(geom)
        if max_tiles is not None and asked + cost > max_tiles:
            log.info(
                "tile budget %s reached after %s tiles: %s species left for the next run",
                max_tiles,
                asked,
                len(missing) - i + 1,
            )
            break
        asked += cost
        try:
            if mode == "skim":
                s["iou_skim"] = round(
                    skim_agreement(geom, taxon_id, sources.tile_mask), 4
                )
                if s.get("check") != "full":
                    s["iou"], s["check"] = s["iou_skim"], "skim"
            else:
                s["iou"] = round(tile_agreement(geom, taxon_id, sources.tile_mask), 4)
                s["check"] = "full"
        except SourceError as e:
            log.error(
                "tiles for %s (%s, taxon %s) failed: %s", name, group, taxon_id, e
            )
            failed += 1
        if i % CHECKPOINT_EVERY == 0:
            write(species, asked)
        if i % 100 == 0 or i == len(missing):
            log.info(
                "%s/%s species checked, %s failed, %s tiles",
                i,
                len(missing),
                failed,
                asked,
            )
    write(species, asked)
    return sum(1 for s in species.values() if s["iou"] is None)


def main(argv=None, *, sources=None, now=None) -> int:
    import argparse
    import datetime as dt

    from .atomic import write_atomic
    from .geomodel_check import default_work

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--verdicts", type=Path, default=Path("public/data/geomodel_verdicts.json")
    )
    ap.add_argument(
        "--out", type=Path, default=Path("public/data/geomodel_species.json")
    )
    ap.add_argument("--work", type=Path, default=default_work())
    ap.add_argument(
        "--keep-ranges", action="store_true", help="keep the downloaded GeoPackages"
    )
    ap.add_argument("--mode", choices=("skim", "full"), default="full")
    ap.add_argument(
        "--only", type=Path, default=None, help="check only the species named in this file, one per line"
    )
    ap.add_argument(
        "--include-full",
        action="store_true",
        help="skim fully checked species too, recording the skim score only (calibration)",
    )
    ap.add_argument(
        "--max-tiles",
        type=int,
        default=None,
        help="stop before asking more tiles than this",
    )
    ap.add_argument(
        "--max-tiles-per-day",
        type=int,
        default=None,
        help="stop before the tiles asked in the last 24 h (this file's tile_log, all runs) pass this",
    )
    args = ap.parse_args(argv)
    if args.include_full and args.mode != "skim":
        ap.error("--include-full is for --mode skim")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    verdicts = json.loads(args.verdicts.read_text())
    groups = {
        g: {
            "verdict": v["verdict"],
            "include": sorted(GROUPS[g]["include"]),
            "exclude": sorted(GROUPS[g].get("exclude", {})),
        }
        for g, v in verdicts["groups"].items()
    }

    # iNaturalist asks for under 10,000 requests a day: every run logs what it asked, and a daily budget is what the
    # last 24 h of runs left, whatever model version they checked
    started = (now or (lambda: dt.datetime.now(dt.timezone.utc)))()
    prior_log = previous_tile_log(args.out)
    max_tiles = args.max_tiles
    if args.max_tiles_per_day is not None:
        day = dt.timedelta(hours=24)
        used = sum(e["tiles"] for e in prior_log if started - dt.datetime.fromisoformat(e["at"]) < day)
        left = max(0, args.max_tiles_per_day - used)
        log.info("daily tile budget %s: %s asked in the last 24 h, %s left", args.max_tiles_per_day, used, left)
        max_tiles = left if max_tiles is None else min(max_tiles, left)
    kept_log = [e for e in prior_log if started - dt.datetime.fromisoformat(e["at"]) < dt.timedelta(hours=48)]

    def write(species: dict, asked: int) -> None:
        unchecked = sum(1 for s in species.values() if s["iou"] is None)
        write_atomic(
            args.out,
            {
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(
                    timespec="seconds"
                ),
                "geomodel_version": verdicts["geomodel_version"],
                "verdicts_generated_at": verdicts["generated_at"],
                "spec": "docs/superpowers/specs/2026-09-30-modeled-range-design.md",
                "species_iou_min": SPECIES_IOU_MIN,
                "unchecked": unchecked,
                "groups": groups,
                "tile_log": kept_log + [{"at": started.isoformat(timespec="seconds"), "tiles": asked}],
                "species": species,
            },
        )

    live = sources is None
    with (
        run_workdir(args.work, keep=args.keep_ranges) if live else nullcontext() as work
    ):
        sources = sources or LiveSources(work)
        try:
            todo = passing_species(sources, verdicts)
        except ListingError as e:
            log.error("no species list written: %s", e)
            return 2
        only = None
        if args.only is not None:
            only = {line.strip() for line in args.only.read_text().splitlines() if line.strip()}
            unknown = sorted(only - {n for _, _, n in todo})
            if unknown:
                ap.error(f"--only names species not in a passing collection: {unknown[:5]}")
        unchecked = check_tiles(
            sources,
            todo,
            previous_entries(args.out, verdicts["geomodel_version"]),
            write,
            mode=args.mode,
            include_full=args.include_full,
            max_tiles=max_tiles,
            only=only,
        )
    log.info("wrote %s (%s species, %s unchecked)", args.out, len(todo), unchecked)
    return 3 if unchecked else 0


if __name__ == "__main__":
    raise SystemExit(main())
