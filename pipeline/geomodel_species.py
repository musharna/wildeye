"""List every species of a collection that passed the geomodel check, with the IoU between iNaturalist's tiles and the tested range.

Spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md. Reads the verdicts file the check wrote and writes
public/data/geomodel_species.json, which the species card reads to decide whether to offer the modeled range.
At one tile a second the list is slow (Arachnida: 20,861 z3 tiles, about 8 h), so it names every species from its first write
(iou null until checked), rewrites itself every CHECKPOINT_EVERY species, and a later run of the same model version checks only
what is still null.
Exit 2 = nothing written (the ranges are not the model that was checked, or a name is listed twice); exit 3 =
written, but some species' tiles could not be fetched (listed with iou null, never shown).
"""

from __future__ import annotations

import json
import logging
from contextlib import nullcontext
from pathlib import Path

from .geomodel_check import LiveSources, run_workdir, tile_agreement
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


def previous_ious(path: Path, version: str) -> dict[str, tuple[int, float]]:
    """{name: (taxon id, iou)} already checked in the list at `path`, if it is of the same model version."""
    try:
        doc = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    if doc.get("geomodel_version") != version:
        return {}
    return {
        n: (s["id"], s["iou"])
        for n, s in doc["species"].items()
        if s["iou"] is not None
    }


def check_tiles(sources, todo, known, write) -> int:
    """Fill each species' IoU (reusing `known`), calling write(species) from the start and every CHECKPOINT_EVERY checks; returns unchecked."""
    species = {}
    for group, taxon_id, name in todo:
        prev = known.get(name)
        species[name] = {
            "id": taxon_id,
            "group": group,
            "iou": prev[1] if prev and prev[0] == taxon_id else None,
        }
    missing = [(g, t, n) for g, t, n in todo if species[n]["iou"] is None]
    log.info(
        "tile agreement for %s of %s species in passing collections (%s reused)",
        len(missing),
        len(todo),
        len(todo) - len(missing),
    )
    write(species)
    failed = 0
    for i, (group, taxon_id, name) in enumerate(missing, 1):
        try:
            geom = sources.range_geom(group, taxon_id)
            species[name]["iou"] = round(
                tile_agreement(geom, taxon_id, sources.tile_mask), 4
            )
        except SourceError as e:
            log.error(
                "tiles for %s (%s, taxon %s) failed: %s", name, group, taxon_id, e
            )
            failed += 1
        if i % CHECKPOINT_EVERY == 0:
            write(species)
        if i % 100 == 0 or i == len(missing):
            log.info("%s/%s species checked, %s failed", i, len(missing), failed)
    write(species)
    return sum(1 for s in species.values() if s["iou"] is None)


def main(argv=None, *, sources=None) -> int:
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
    args = ap.parse_args(argv)
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

    def write(species: dict) -> None:
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
        unchecked = check_tiles(
            sources, todo, previous_ious(args.out, verdicts["geomodel_version"]), write
        )
    log.info("wrote %s (%s species, %s unchecked)", args.out, len(todo), unchecked)
    return 3 if unchecked else 0


if __name__ == "__main__":
    raise SystemExit(main())
