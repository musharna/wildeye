"""Freshwater fish species per drainage basin → public/data/freshwater_fish.geojson (polygon contract, static).

Spec: docs/superpowers/specs/2026-10-03-freshwater-fish-design.md. Zenodo 10.5281/zenodo.19511163 (CC BY 4.0) updates
Tedesco et al. 2017 (Scientific Data 4:170141) to December 2024: 3,364 basin polygons with a species count, and a
workbook listing each of 18,821 species with its family and basins. The four files are downloaded once and refused
unless their md5 is Zenodo's. The run stops unless every basin's count equals the distinct species the workbook lists
for it; each basin keeps its five largest families (the workbook's Catalogue of Fishes text is never published). Shapes
are simplified with pipeline/ecoregions.py's simplify_geometry, parts wider than 90° are cut (pipeline/marine_realms.py's
split_wide), areas come from the unsimplified shapes, and the fill is one of 8 log-spaced bins. Anything but 3,364
basins with unique ids in the 7 realms, or an output over the budget, stops the run.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import time
from collections import Counter
from pathlib import Path

from .atomic import write_atomic
from .ecoregions import DEFAULT_MIN_AREA, DEFAULT_TOL, simplify_geometry
from .gfw import geometry_area_km2
from .hfp import _fetch_to, _md5
from .marine_realms import MAX_PART_WIDTH, split_wide

log = logging.getLogger("freshwater_fish")
RECORD_API = "https://zenodo.org/api/records/19511163"
CACHE_DIR = "fish_basins"
SHP = "Basin_202412_3364"
XLSX = "cas_freshwater_202412.xlsx"
# Zenodo's md5 of each file (record 19511163, read from the API 2026-10-03)
FILES = {
    f"{SHP}.shp": "524bcf9cdbbba4c886931612a7430313",
    f"{SHP}.dbf": "802aecd5af4b7d7e0f908990bc414ab4",
    f"{SHP}.shx": "03b74759c28322fd716b7f2e4d9e23a2",
    XLSX: "06528f16898494608690c84630b0d579",
}
EXPECTED_BASINS = 3364
REALMS = (
    "Afrotropic",
    "Australasia",
    "Indomalayan",
    "Nearctic",
    "Neotropic",
    "Oceania",
    "Palearctic",
)
BUDGET_BYTES = 6_000_000
TOP_FAMILIES = 5
# Lower edge of each bin (species); the Amazon's 2,815 is the most.
BIN_EDGES = (1, 10, 25, 50, 100, 250, 500, 1000)
# viridis at 8 steps: luminance rises with the count, so more species reads lighter on the dark globe
BIN_COLOURS = (
    "#440154",
    "#46327e",
    "#365c8d",
    "#277f8e",
    "#1fa187",
    "#4ac16d",
    "#a0da39",
    "#fde725",
)
SOURCE = {
    "id": "freshwater-fish",
    "name": "Freshwater fish species per drainage basin (Tedesco et al. 2017, updated to 2024)",
    "url": "https://doi.org/10.5281/zenodo.19511163",
    "data": RECORD_API,
    "licence": "CC BY 4.0 (Zenodo 10.5281/zenodo.19511163)",
    "citation": "Liuyong Ding (2026) A global geospatial dataset of freshwater fish species at the drainage-basin "
    "scale (updated to December 2024). Zenodo. doi:10.5281/zenodo.19511163; Tedesco P.A., Beauchard O., Bigorne R. "
    "et al. (2017) A global database on freshwater fish species occurrence in drainage basins. Scientific Data "
    "4:170141. doi:10.1038/sdata.2017.141",
    "note": "Species counts and families from the record's species table (no native/introduced status). Boundaries "
    "simplified for display; areas before simplification. Some of the source's basins overlap.",
}


def bin_of(n: int) -> int:
    if n < 1:
        raise ValueError(f"{n} species: every basin has at least one")
    return max(i for i, e in enumerate(BIN_EDGES) if n >= e)


def bin_label(i: int) -> str:
    if i == len(BIN_EDGES) - 1:
        return f"{BIN_EDGES[i]:,}+"
    return f"{BIN_EDGES[i]:,}–{BIN_EDGES[i + 1] - 1:,}"


def fetch(cache: Path, *, fetch_to=_fetch_to, want: dict = FILES) -> Path:
    """The record's files in `cache`, each downloaded once; a file is refused (and not kept) unless its md5 is Zenodo's."""
    cache.mkdir(parents=True, exist_ok=True)
    for name, md5 in want.items():
        path = cache / name
        if path.exists():
            got = _md5(path)
            if got != md5:
                raise ValueError(
                    f"{path}: md5 {got} is not Zenodo's {md5}; delete it to fetch again"
                )
            continue
        url = f"{RECORD_API}/files/{name}/content"
        part = cache / f"{name}.part"
        log.info("downloading %s → %s", url, path)
        try:
            fetch_to(url, part)
            got = _md5(part)
            if got != md5:
                raise ValueError(f"{name}: md5 {got} is not Zenodo's {md5}")
            os.replace(part, path)
        finally:
            part.unlink(missing_ok=True)
    return cache


def read_basins(d: Path):
    """Yield (record dict, geo_interface geometry) per basin. The dbf is Latin-1 ("México")."""
    import shapefile  # pyshp, as pipeline/ecoregions.py

    rd = shapefile.Reader(str(d / SHP), encoding="latin-1")
    for sr in rd.iterShapeRecords():
        yield sr.record.as_dict(), sr.shape.__geo_interface__


def read_species(d: Path) -> dict:
    """basin name → {"species": set of valid names, "families": Counter}; rows with no valid name are skipped; a name in
    two rows stops the run."""
    import openpyxl

    wb = openpyxl.load_workbook(d / XLSX, read_only=True)
    rows = wb["CAS"].iter_rows(values_only=True)
    head = next(rows)
    col = {k: head.index(k) for k in ("valid_name", "family", "basin")}
    out: dict = {}
    seen: set = set()
    for row in rows:
        name = row[col["valid_name"]]
        if not name:
            continue
        # one row per species (2024 release: 18,821 rows, 18,821 names); a repeat would make family counts ambiguous
        if name in seen:
            raise ValueError(f"species {name!r} has more than one row in {XLSX}")
        seen.add(name)
        for b in str(row[col["basin"]] or "").split(";"):
            if b:
                e = out.setdefault(b, {"species": set(), "families": Counter()})
                e["species"].add(name)
                e["families"][row[col["family"]]] += 1
    return out


def build(
    basins,
    species: dict,
    tol: float = DEFAULT_TOL,
    min_area: float = DEFAULT_MIN_AREA,
    expect: int = EXPECTED_BASINS,
):
    """basins of (record, geometry) and the species table → (features in source order, counts)."""
    from shapely import make_valid
    from shapely.geometry import mapping, shape

    feats, seen, named = [], set(), set()
    counts = {"vertices_in": 0, "vertices_out": 0, "invalid_in": 0}
    for rec, geom in basins:
        bid, src_name = rec["basin_d"], rec["basin"]
        name = src_name.replace(".", " ")
        if bid in seen:
            raise ValueError(f"basin {bid} appears twice")
        seen.add(bid)
        if rec["bggrph_"] not in REALMS:
            raise ValueError(
                f"basin {bid}: realm {rec['bggrph_']!r} is not one of the 7"
            )
        sp = species.get(src_name, {"species": set(), "families": Counter()})
        if rec["n_specs"] != len(sp["species"]):
            raise ValueError(
                f"basin {bid} ({name}): n_specs {rec['n_specs']} but the species table lists {len(sp['species'])}"
            )
        named |= sp["species"]
        g = shape(geom)
        counts["invalid_in"] += not g.is_valid
        counts["vertices_in"] += sum(len(r) for poly in _polys(geom) for r in poly)
        if not g.is_valid:
            g = make_valid(g)
        simple = shape(simplify_geometry(g, tol, min_area))
        if not simple.is_valid:
            raise ValueError(f"basin {bid}: simplified geometry is invalid")
        # strips share edges, so the cut MultiPolygon is not OGC-valid as a whole; each strip must be
        cut = split_wide(simple)
        if not all(q.is_valid for q in getattr(cut, "geoms", [cut])):
            raise ValueError(f"basin {bid}: a cut strip is invalid")
        sg = mapping(cut)
        counts["vertices_out"] += sum(len(r) for poly in _polys(sg) for r in poly)
        b = bin_of(rec["n_specs"])
        fams = sorted(sp["families"].items(), key=lambda kv: (-kv[1], kv[0]))[
            :TOP_FAMILIES
        ]
        feats.append(
            {
                "type": "Feature",
                "geometry": sg,
                "properties": {
                    "id": bid,
                    "name": name,
                    "realm": rec["bggrph_"],
                    "country": rec["country"],
                    "species": rec["n_specs"],
                    "families": [[f, n] for f, n in fams],
                    "bin": b,
                    "color": BIN_COLOURS[b],
                    "area_km2": round(
                        sum(
                            geometry_area_km2(mapping(p))
                            for p in getattr(g, "geoms", [g])
                            if p.geom_type == "Polygon"
                        )
                    ),
                },
            }
        )
    if len(feats) != expect:
        raise ValueError(f"{len(feats)} basins, not {expect:,}")
    counts.update({"basins": len(feats), "species": len(named)})
    return feats, counts


def _polys(geom: dict) -> list:
    return (
        geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    )


def collection(feats: list[dict], counts: dict) -> dict:
    return {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE,
        "bins": [
            {"min": e, "label": bin_label(i), "color": BIN_COLOURS[i]}
            for i, e in enumerate(BIN_EDGES)
        ],
        "realms": list(REALMS),
        "counts": counts,
        "features": feats,
    }


def main(
    argv=None, *, fetch_to=_fetch_to, want: dict = FILES, expect: int = EXPECTED_BASINS
) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--out", type=Path, default=Path("public/data/freshwater_fish.geojson")
    )
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        ),
    )
    ap.add_argument("--tol", type=float, default=DEFAULT_TOL)
    ap.add_argument("--min-area", type=float, default=DEFAULT_MIN_AREA)
    ap.add_argument("--budget", type=int, default=BUDGET_BYTES)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    d = fetch(a.cache / CACHE_DIR, fetch_to=fetch_to, want=want)
    feats, counts = build(
        read_basins(d), read_species(d), a.tol, a.min_area, expect=expect
    )
    counts.update(
        {
            "tol_deg": a.tol,
            "min_area_deg2": a.min_area,
            "max_part_width_deg": MAX_PART_WIDTH,
        }
    )
    doc = collection(feats, counts)
    # the bytes write_atomic writes (json.dump, compact separators)
    size = len(json.dumps(doc, separators=(",", ":")))
    if size > a.budget:
        raise SystemExit(
            f"{size:,} B is over the {a.budget:,} B budget: nothing written"
        )
    write_atomic(a.out, doc)
    log.info(
        "wrote %s: %s, %.1f MB (%.0f s)",
        a.out,
        counts,
        a.out.stat().st_size / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
