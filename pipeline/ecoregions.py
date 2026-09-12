"""RESOLVE Ecoregions 2017 terrestrial ecoregions and biomes (polygon contract, static) →
public/data/ecoregions.geojson.

Dinerstein et al. 2017 (BioScience 67:534–545) delineate 846 ecoregions in 14 biomes and 8
realms; RESOLVE publishes the shapefile under CC BY 4.0 (https://ecoregions.appspot.com/
"Licensed under CC-BY 4.0", and every DBF row carries LICENSE = "CC-BY 4.0", read
2026-09-12). The 149 MB zip (243 MB shapefile; 13.97 M vertices in the 846 ecoregions) is
downloaded once into the cache and simplified here: invalid shapes repaired (make_valid; 69
source shapes are invalid), shapely `simplify` at `--tol` degrees (topology-preserving),
coordinates snapped to a 0.001° grid with set_precision (keeps output valid), polygon parts
and holes under `--min-area` square degrees dropped (an ecoregion always keeps its largest
part). Every output geometry is checked valid. Nothing is time-varying; the runner is
monthly only so a re-published shapefile is picked up. The "Rock and Ice" row (ECO_ID 0,
realm N/A) is not an ecoregion and is dropped, leaving 846.

`--seed-out` additionally writes the 14 biomes dissolved at a coarse tolerance for
public/data/seed/ecoregions.geojson (< 100 KB): same property schema, one feature per biome.
pyshp and shapely are imported inside the functions that need them so importing this module
needs only the stdlib (pipeline/tests/test_stdlib_pipelines.py pattern).
"""

from __future__ import annotations
import argparse
import datetime as dt
import io
import logging
import time
import urllib.request
import zipfile
from pathlib import Path
from .atomic import write_atomic
from .gfw import geometry_area_km2

log = logging.getLogger("ecoregions")
ZIP_URL = "https://storage.googleapis.com/teow2016/Ecoregions2017.zip"
SITE = "https://ecoregions.appspot.com/"
UA = "wildeye (github.com/musharna/wildeye)"
LICENCE = "CC BY 4.0 (RESOLVE Ecoregions 2017; Dinerstein et al. 2017)"
CITATION = (
    "Dinerstein E. et al. (2017) An Ecoregion-Based Approach to Protecting Half the Terrestrial Realm. "
    "BioScience 67(6):534-545. doi:10.1093/biosci/bix014"
)
NOTE = (
    "Boundaries simplified for display (Douglas-Peucker, topology preserving) and small polygon parts dropped; "
    "areas are computed from the unsimplified shapes. Nature Needs Half (NNH) categories are RESOLVE's 2017 "
    "assessment of how much of each ecoregion is protected or intact."
)
DEFAULT_TOL = 0.05
DEFAULT_MIN_AREA = 0.02  # square degrees
SEED_TOL = (
    0.75  # with SEED_GRID: 14 biomes in ~85 KB (0.5° on the 0.001° grid was 134 KB)
)
SEED_MIN_AREA = 2.0
SEED_GRID = 0.01
EXPECTED_ECOREGIONS = (
    846  # Dinerstein et al. 2017; a different count means RESOLVE re-published
)

# RESOLVE's own biome palette (shapefile COLOR_BIO), keyed by BIOME_NUM. Mirrored in src/data/ecoregions.js.
BIOMES = {
    1: ("Tropical & Subtropical Moist Broadleaf Forests", "#38A700"),
    2: ("Tropical & Subtropical Dry Broadleaf Forests", "#CCCD65"),
    3: ("Tropical & Subtropical Coniferous Forests", "#88CE66"),
    4: ("Temperate Broadleaf & Mixed Forests", "#00734C"),
    5: ("Temperate Conifer Forests", "#458970"),
    6: ("Boreal Forests/Taiga", "#7AB6F5"),
    7: ("Tropical & Subtropical Grasslands, Savannas & Shrublands", "#FEAA01"),
    8: ("Temperate Grasslands, Savannas & Shrublands", "#FEFF73"),
    9: ("Flooded Grasslands & Savannas", "#BEE7FF"),
    10: ("Montane Grasslands & Shrublands", "#D6C39D"),
    11: ("Tundra", "#9ED7C2"),
    12: ("Mediterranean Forests, Woodlands & Scrub", "#FE0000"),
    13: ("Deserts & Xeric Shrublands", "#CC6767"),
    14: ("Mangroves", "#FE01C4"),
}
NNH = {
    1: "Half Protected",
    2: "Nature Could Reach Half Protected",
    3: "Nature Could Recover",
    4: "Nature Imperiled",
}


def fetch_zip(zip_path: Path, fetch_bytes=None) -> Path:
    """Download the RESOLVE zip once into the cache (149 MB)."""
    if zip_path.exists() and zip_path.stat().st_size > 0:
        return zip_path
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    log.info("downloading %s", ZIP_URL)
    if fetch_bytes:
        data = fetch_bytes(ZIP_URL)
    else:
        with urllib.request.urlopen(
            urllib.request.Request(ZIP_URL, headers={"User-Agent": UA}), timeout=600
        ) as r:
            data = r.read()
    if not data.startswith(b"PK"):
        raise RuntimeError(f"{ZIP_URL}: not a zip ({len(data)} bytes)")
    zip_path.write_bytes(data)
    return zip_path


def read_rows(zip_path: Path):
    """Yield (record dict, geo_interface geometry) per shapefile row. The DBF is latin-1
    ("Alto Paraná Atlantic forests" fails as utf-8)."""
    import shapefile  # pyshp, already used by pipeline/wastewater.py

    z = zipfile.ZipFile(zip_path)
    base = next(n for n in z.namelist() if n.endswith(".shp"))[:-4]
    rd = shapefile.Reader(
        shp=io.BytesIO(z.read(base + ".shp")),
        dbf=io.BytesIO(z.read(base + ".dbf")),
        shx=io.BytesIO(z.read(base + ".shx")),
        encoding="latin-1",
    )
    for sr in rd.iterShapeRecords():
        yield sr.record.as_dict(), sr.shape.__geo_interface__


def properties(rec: dict) -> dict | None:
    """Shapefile record → layer properties; None for the non-ecoregion "Rock and Ice" row (ECO_ID 0)."""
    eco_id = int(rec["ECO_ID"])
    if eco_id == 0:
        return None
    biome = int(rec["BIOME_NUM"])
    if biome not in BIOMES:
        raise ValueError(
            f"ecoregion {eco_id} {rec['ECO_NAME']!r}: unknown BIOME_NUM {biome}"
        )
    if rec["COLOR_BIO"].upper() != BIOMES[biome][1]:
        raise ValueError(
            f"ecoregion {eco_id}: COLOR_BIO {rec['COLOR_BIO']} != palette {BIOMES[biome][1]} — palette drifted"
        )
    nnh = int(rec["NNH"])
    return {
        "eco_id": eco_id,
        "name": rec["ECO_NAME"].strip(),
        "biome": biome,
        "biome_name": BIOMES[biome][0],
        "realm": rec["REALM"].strip(),
        "nnh": nnh,
        "nnh_name": NNH.get(nnh, "not categorised"),
    }


GRID = 0.001  # output coordinate grid, degrees (~110 m)


def _rnd(c):
    """Strip float noise from coordinates already snapped to GRID (idempotent on the grid)."""
    if isinstance(c[0], (int, float)):
        return [round(c[0], 3), round(c[1], 3)]
    return [_rnd(x) for x in c]


def _polygons(g) -> list:
    """Polygonal parts of any geometry (make_valid can return a GeometryCollection with lines)."""
    if g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if g.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [p for part in g.geoms for p in _polygons(part)]
    return []


def simplify_geometry(geom, tol: float, min_area: float, grid: float = GRID) -> dict:
    """Repair, simplify, snap, then drop parts and holes under `min_area` square degrees; the
    largest part is always kept so an ecoregion never vanishes. Returns valid GeoJSON.

    69 of the 847 source shapes are invalid (self-intersections), `simplify` leaves 10 invalid
    and naive 3-decimal rounding afterwards makes it 26 (measured 2026-09-12), which broke the
    biome dissolve (GEOS TopologyException). So: make_valid first, and snap with
    set_precision, which keeps the output valid, instead of rounding coordinates."""
    from shapely import make_valid, set_precision, simplify
    from shapely.geometry import Polygon, shape

    g = shape(geom) if isinstance(geom, dict) else geom
    if not g.is_valid:
        g = make_valid(g)
    s = simplify(g, tol, preserve_topology=True)
    if not s.is_valid:  # preserve_topology does not guarantee validity; set_precision rejects invalid input
        s = make_valid(s)
    s = set_precision(s, grid)
    polys = _polygons(s)
    if not polys:
        raise ValueError("geometry simplified to nothing")
    keep = [p for p in polys if p.area >= min_area] or [
        max(polys, key=lambda p: p.area)
    ]
    rings = [
        [list(p.exterior.coords)]
        + [list(h.coords) for h in p.interiors if Polygon(h).area >= min_area]
        for p in keep
    ]
    if len(rings) == 1:
        return {"type": "Polygon", "coordinates": _rnd(rings[0])}
    return {"type": "MultiPolygon", "coordinates": _rnd(rings)}


def build(
    rows, tol: float = DEFAULT_TOL, min_area: float = DEFAULT_MIN_AREA
) -> tuple[list[dict], dict, list]:
    """rows of (record, geometry) → (features sorted by eco_id, counts, simplified shapely geoms per biome for the seed)."""
    from shapely.geometry import shape

    feats, counts, per_biome = (
        [],
        {
            "rows": 0,
            "dropped_rows": 0,
            "invalid_in": 0,
            "vertices_in": 0,
            "vertices_out": 0,
        },
        {},
    )
    for rec, geom in rows:
        counts["rows"] += 1
        p = properties(rec)
        if p is None:
            counts["dropped_rows"] += 1
            continue
        p["area_km2"] = round(geometry_area_km2(geom))
        g = shape(geom)
        counts["invalid_in"] += not g.is_valid
        counts["vertices_in"] += sum(
            len(r.coords)
            for poly in (g.geoms if g.geom_type == "MultiPolygon" else [g])
            for r in [poly.exterior, *poly.interiors]
        )
        sg = simplify_geometry(g, tol, min_area)
        if not shape(sg).is_valid:
            raise ValueError(
                f"ecoregion {p['eco_id']} {p['name']!r}: simplified geometry is invalid"
            )
        counts["vertices_out"] += sum(
            len(r)
            for poly in (
                sg["coordinates"]
                if sg["type"] == "MultiPolygon"
                else [sg["coordinates"]]
            )
            for r in poly
        )
        per_biome.setdefault(p["biome"], []).append(shape(sg))
        feats.append({"type": "Feature", "geometry": sg, "properties": p})
    feats.sort(key=lambda f: f["properties"]["eco_id"])
    counts["ecoregions"] = len(feats)
    counts["biomes"] = len(per_biome)
    return feats, counts, per_biome


def dissolve_biomes(
    per_biome: dict,
    feats: list[dict],
    tol: float = SEED_TOL,
    min_area: float = SEED_MIN_AREA,
) -> list[dict]:
    """Seed: one feature per biome (union of its ecoregions, coarsely simplified), same property schema."""
    from shapely import unary_union

    out = []
    for b in sorted(per_biome):
        u = unary_union(per_biome[b]).buffer(0)
        area = sum(
            f["properties"]["area_km2"] for f in feats if f["properties"]["biome"] == b
        )
        n = sum(1 for f in feats if f["properties"]["biome"] == b)
        out.append(
            {
                "type": "Feature",
                "geometry": simplify_geometry(u, tol, min_area, SEED_GRID),
                "properties": {
                    "eco_id": f"biome-{b}",
                    "name": f"{BIOMES[b][0]} ({n} ecoregions, dissolved)",
                    "biome": b,
                    "biome_name": BIOMES[b][0],
                    "realm": "all realms",
                    "nnh": 0,
                    "nnh_name": "not categorised",
                    "area_km2": area,
                },
            }
        )
    return out


def collection(feats: list[dict], counts: dict, note_extra: str = "") -> dict:
    return {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "id": "ecoregions",
            "name": "RESOLVE Ecoregions 2017",
            "url": SITE,
            "data": ZIP_URL,
            "licence": LICENCE,
            "citation": CITATION,
            "note": (NOTE + " " + note_extra).strip(),
        },
        "biomes": {str(k): {"name": v[0], "color": v[1]} for k, v in BIOMES.items()},
        "nnh": {str(k): v for k, v in NNH.items()},
        "counts": counts,
        "features": feats,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/ecoregions.geojson"))
    ap.add_argument(
        "--seed-out",
        type=Path,
        default=None,
        help="also write the dissolved-biome seed here",
    )
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "wildeye")
    ap.add_argument("--tol", type=float, default=DEFAULT_TOL)
    ap.add_argument("--min-area", type=float, default=DEFAULT_MIN_AREA)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    zp = fetch_zip(a.cache / "Ecoregions2017.zip")
    feats, counts, per_biome = build(read_rows(zp), a.tol, a.min_area)
    if len(feats) != EXPECTED_ECOREGIONS:
        raise SystemExit(
            f"expected {EXPECTED_ECOREGIONS} ecoregions, built {len(feats)} (counts={counts})"
        )
    counts.update({"tol_deg": a.tol, "min_area_deg2": a.min_area})
    write_atomic(a.out, collection(feats, counts))
    log.info(
        "wrote %s: %d ecoregions, %s (%.0f s)",
        a.out,
        len(feats),
        counts,
        time.time() - t0,
    )
    if a.seed_out:
        seed = dissolve_biomes(per_biome, feats)
        write_atomic(
            a.seed_out,
            collection(
                seed,
                {
                    **counts,
                    "seed": True,
                    "features": len(seed),
                    "seed_tol_deg": SEED_TOL,
                    "seed_min_area_deg2": SEED_MIN_AREA,
                    "seed_grid_deg": SEED_GRID,
                },
                f"SEED (subsampled to stay under 100 KB): the {len(seed)} biomes dissolved from their ecoregions, "
                f"simplified at {SEED_TOL} deg, snapped to a {SEED_GRID} deg grid, parts and holes under {SEED_MIN_AREA} square "
                "degrees dropped (removes small islands and every Antarctic ecoregion); "
                "run pipeline/run_ecoregions.sh for the 846 ecoregions.",
            ),
        )
        log.info(
            "wrote seed %s: %d biomes, %d bytes",
            a.seed_out,
            len(seed),
            a.seed_out.stat().st_size,
        )


if __name__ == "__main__":
    main()
