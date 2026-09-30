"""List every species of a collection that passed the geomodel check, with the IoU between iNaturalist's tiles and the tested range.

Spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md. Reads the verdicts file the check wrote and writes
public/data/geomodel_species.json, which the species card reads to decide whether to offer the modeled range.
Exit 2 = nothing written (the ranges are not the model that was checked, or a name is listed twice); exit 3 =
written, but some species' tiles could not be fetched (listed with iou null, never shown).
"""

from __future__ import annotations

import logging
from pathlib import Path

from .geomodel_check import LiveSources, tile_agreement
from .geomodel_sources import GROUPS, SourceError

SPECIES_IOU_MIN = 0.70  # spec ruling 1, fixed before the first per-species run
log = logging.getLogger("geomodel")


class ListingError(RuntimeError):
    pass


def species_list(sources, verdicts: dict) -> tuple[dict, int]:
    """{name: {id, group, iou}} for every species in a passing collection, and how many could not be checked."""
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
    log.info("tile agreement for %s species in passing collections", len(todo))
    species, unchecked = {}, 0
    for i, (group, taxon_id, name) in enumerate(todo, 1):
        try:
            iou = round(
                tile_agreement(
                    sources.range_geom(group, taxon_id), taxon_id, sources.tile_mask
                ),
                4,
            )
        except SourceError as e:
            log.error(
                "tiles for %s (%s, taxon %s) failed: %s", name, group, taxon_id, e
            )
            iou, unchecked = None, unchecked + 1
        species[name] = {"id": taxon_id, "group": group, "iou": iou}
        if i % 100 == 0 or i == len(todo):
            log.info("%s/%s species checked, %s unchecked", i, len(todo), unchecked)
    return species, unchecked


def main(argv=None, *, sources=None) -> int:
    import argparse
    import datetime as dt
    import json
    import shutil

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
    live = sources is None
    sources = sources or LiveSources(args.work)
    try:
        species, unchecked = species_list(sources, verdicts)
    except ListingError as e:
        log.error("no species list written: %s", e)
        return 2
    finally:
        if live and not args.keep_ranges:
            shutil.rmtree(args.work, ignore_errors=True)
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
            "groups": {
                g: {
                    "verdict": v["verdict"],
                    "include": sorted(GROUPS[g]["include"]),
                    "exclude": sorted(GROUPS[g].get("exclude", {})),
                }
                for g, v in verdicts["groups"].items()
            },
            "species": species,
        },
    )
    log.info("wrote %s (%s species, %s unchecked)", args.out, len(species), unchecked)
    return 3 if unchecked else 0


if __name__ == "__main__":
    raise SystemExit(main())
