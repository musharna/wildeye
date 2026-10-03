"""Marine biogeographic realms (Costello et al. 2017) → public/data/marine_realms.geojson (polygon contract, static).

Spec: docs/superpowers/specs/2026-10-03-marine-realms-design.md. Costello, Tsai, Wong, Cheung, Basher & Chaudhary 2017
(Nature Communications 8:1057) cluster the distributions of 65,000 marine species (OBIS) into 30 realms covering the
whole ocean, coast and open water. The shapefile (figshare 10.17608/k6.auckland.5596840 v1, CC BY 4.0) holds only the
realm number; names, the 8 top-level groups, species counts and the share of species unique to a realm are tabled
below from the paper's Fig. 1. The zip is downloaded once and refused unless its md5 is figshare's. The source shapes cut
out the continents but not islands (Borneo, Madagascar, Britain and Japan lie inside realms), so Natural Earth 10 m land
(pipeline/land.py's pinned file) is subtracted from every realm; shapes are then repaired,
simplified and snapped with pipeline/ecoregions.py's simplify_geometry, areas come from the unsimplified shapes, and each
realm gets one colour; parts wider than 90° of longitude are cut into strips Cesium can draw. Anything but exactly the 30 realms of the table, or an output over the budget, stops the run.
"""

from __future__ import annotations

import argparse
import colorsys
import datetime as dt
import io
import json
import logging
import os
import time
import zipfile
from pathlib import Path

from .atomic import write_atomic
from .ecoregions import DEFAULT_MIN_AREA, DEFAULT_TOL, simplify_geometry
from .gfw import geometry_area_km2
from .hfp import _fetch_to, _md5
from .land import fetch_land_zip

log = logging.getLogger("marine_realms")
FILE_URL = "https://ndownloader.figshare.com/files/9737926"
ZIP_NAME = "MarineRealmsShapeFile.zip"
# figshare's md5 of the zip (article 5596840 v1, read from the API 2026-10-03)
ZIP_MD5 = "61402e9aa9c58d0c1a4afcc4146bb094"
BUDGET_BYTES = 5_000_000
# Cesium cannot tessellate a polygon that wraps the globe (the Southern Ocean's ring runs from -180° to 180°, its two
# antimeridian edges coincide): display parts wider than this are cut into strips at multiples of it from -180°.
MAX_PART_WIDTH = 90.0
SOURCE = {
    "id": "marine-realms",
    "name": "Marine biogeographic realms (Costello et al. 2017)",
    "url": "https://doi.org/10.17608/k6.auckland.5596840",
    "data": FILE_URL,
    "licence": "CC BY 4.0 (figshare 10.17608/k6.auckland.5596840 v1)",
    "citation": "Costello M.J., Tsai P., Wong P.S., Cheung A.K.L., Basher Z., Chaudhary C. (2017) Marine "
    "biogeographic realms and species endemicity. Nature Communications 8:1057. doi:10.1038/s41467-017-01121-2",
    "note": "Land (Natural Earth 10 m, public domain) removed: the source shapes include islands. Boundaries "
    "simplified for display; areas are of the sea in each realm, before simplification. Names, groups, species "
    "counts and the share of species unique to each realm are from Fig. 1 of the paper.",
}

# Fig. 1 of the paper, column 1 (realms of pelagic-only species at 1 % similarity): the 8 top-level groups.
GROUPS = {
    1: "Inner Baltic Sea",
    2: "Black Sea",
    3: "NE and NW Atlantic and Mediterranean, Arctic and North Pacific",
    4: "Mid-tropical North Pacific Ocean",
    5: "South-east Pacific",
    6: "Mid-Atlantic, Pacific and Indian Oceans, coastal tropics and warm-temperate areas",
    7: "North West Pacific",
    8: "Southern Ocean",
}
# realm → (name, group, % of species unique to the realm, number of species), Fig. 1 read 2026-10-03
REALMS = {
    1: ("Inner Baltic Sea", 1, 63, 458),
    2: ("Black Sea", 2, 84, 192),
    3: ("NE Atlantic", 3, 27, 7117),
    4: ("Arctic Europe", 3, 43, 1345),
    5: ("Mediterranean", 3, 45, 3096),
    6: ("Arctic", 3, 19, 1907),
    7: ("North Pacific", 3, 27, 5535),
    8: ("N Atlantic boreal & sub-Arctic, Canada to Greenland Sea", 3, 31, 1492),
    9: ("Mid-tropical North Pacific Ocean", 4, 47, 2859),
    10: ("South-east Pacific", 5, 59, 1618),
    11: ("Tropical W Atlantic", 6, 30, 13281),
    12: ("Tropical E Pacific", 6, 30, 3279),
    13: ("Tropical Indo-Pacific (East Indies) & coastal Indian Ocean", 6, 31, 16508),
    14: ("Red Sea", 6, 74, 997),
    15: ("Tasman Sea to SW Pacific", 6, 57, 1468),
    16: ("Tropical Australia & Coral Sea", 6, 33, 10349),
    17: ("Mid South Tropical Pacific", 6, 44, 2818),
    18: ("Offshore & NW North Atlantic", 6, 26, 7591),
    19: ("Offshore Indian Ocean", 6, 43, 3486),
    20: ("Offshore W Pacific", 6, 40, 4678),
    21: ("Offshore S Atlantic", 6, 33, 5512),
    22: ("Offshore mid-E Pacific", 6, 36, 1217),
    23: ("Tropical E Atlantic", 6, 57, 992),
    24: ("Argentina", 6, 45, 1651),
    25: ("Chile", 6, 68, 584),
    26: ("S Australia", 6, 40, 2158),
    27: ("S Africa", 6, 45, 6700),
    28: ("New Zealand", 6, 33, 3126),
    29: ("North West Pacific", 7, 47, 2551),
    30: ("Southern Ocean", 8, 17, 4256),
}


def colour(realm: int) -> str:
    """One colour per realm: hues a golden angle apart, so consecutively numbered (often neighbouring) realms differ;
    two lightness steps so the 30 stay apart on a dark globe."""
    h = (realm * 137.508) % 360 / 360
    lightness = 0.55 if realm % 2 else 0.68
    r, g, b = colorsys.hls_to_rgb(h, lightness, 0.62)
    return "#{:02x}{:02x}{:02x}".format(*(round(v * 255) for v in (r, g, b)))


def fetch(cache: Path, *, fetch_to=_fetch_to, want: str = ZIP_MD5) -> Path:
    """The pinned zip, downloaded once; refused (and not kept) unless its md5 is figshare's."""
    path = cache / ZIP_NAME
    if path.exists():
        got = _md5(path)
        if got != want:
            raise ValueError(
                f"{path}: md5 {got} is not figshare's {want}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".zip.part")
    log.info("downloading %s → %s", FILE_URL, path)
    try:
        fetch_to(FILE_URL, part)
        got = _md5(part)
        if got != want:
            raise ValueError(f"{FILE_URL}: md5 {got} is not figshare's {want}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def read_rows(zip_path: Path):
    """Yield (realm number, geo_interface geometry) per shapefile row."""
    import shapefile  # pyshp, as pipeline/ecoregions.py

    z = zipfile.ZipFile(zip_path)
    rd = shapefile.Reader(
        shp=io.BytesIO(z.read("MarineRealms.shp")),
        dbf=io.BytesIO(z.read("MarineRealms.dbf")),
        shx=io.BytesIO(z.read("MarineRealms.shx")),
    )
    for sr in rd.iterShapeRecords():
        yield int(sr.record["Realm"]), sr.shape.__geo_interface__


def properties(realm: int) -> dict:
    if realm not in REALMS:
        raise ValueError(f"realm {realm} is not one of the paper's 30")
    name, group, unique, species = REALMS[realm]
    return {
        "realm": realm,
        "name": name,
        "group": group,
        "group_name": GROUPS[group],
        "pct_unique": unique,
        "species": species,
        "color": colour(realm),
    }


def read_land(zip_path: Path) -> list:
    """Natural Earth 10 m land polygons (lon/lat), one per part, read with pyshp."""
    import shapefile
    from shapely import make_valid
    from shapely.geometry import shape

    z = zipfile.ZipFile(zip_path)
    rd = shapefile.Reader(
        shp=io.BytesIO(z.read("ne_10m_land.shp")),
        dbf=io.BytesIO(z.read("ne_10m_land.dbf")),
        shx=io.BytesIO(z.read("ne_10m_land.shx")),
    )
    out = []
    for sr in rd.iterShapeRecords():
        g = shape(sr.shape.__geo_interface__)
        g = g if g.is_valid else make_valid(g)
        out.extend(p for p in getattr(g, "geoms", [g]) if p.geom_type == "Polygon")
    if not out:
        raise ValueError(f"{zip_path}: no land polygons")
    return out


def sea_only(g, land: list, tree):
    """`g` minus the land polygons that touch it."""
    from shapely import unary_union

    hits = [land[i] for i in tree.query(g) if land[i].intersects(g)]
    return g.difference(unary_union(hits)) if hits else g


def split_wide(g, max_width: float = MAX_PART_WIDTH):
    """`g` with every polygon part wider than `max_width`° of longitude cut into strips `max_width`° wide, the cuts at
    -180° + k·max_width; narrower parts are kept whole. Strips share edges, so the union is unchanged."""
    import math

    from shapely.geometry import MultiPolygon, box

    out = []
    for part in getattr(g, "geoms", [g]):
        x0, _, x1, _ = part.bounds
        if x1 - x0 <= max_width:
            out.append(part)
            continue
        k0 = math.floor((x0 + 180) / max_width)
        k1 = math.ceil((x1 + 180) / max_width)
        for k in range(k0, k1):
            left = -180 + k * max_width
            piece = part.intersection(box(left, -90, left + max_width, 90))
            out.extend(
                q
                for q in getattr(piece, "geoms", [piece])
                if q.geom_type == "Polygon" and not q.is_empty
            )
    return out[0] if len(out) == 1 else MultiPolygon(out)


def build(rows, tol: float = DEFAULT_TOL, min_area: float = DEFAULT_MIN_AREA, land=()):
    """rows of (realm, geometry) → (features sorted by realm, counts). Each realm appears exactly once; `land`
    polygons are subtracted first."""
    from shapely import STRtree, make_valid
    from shapely.geometry import mapping, shape

    land = list(land)
    tree = STRtree(land) if land else None

    feats, seen = [], set()
    counts = {"vertices_in": 0, "vertices_out": 0, "invalid_in": 0}
    for realm, geom in rows:
        p = properties(realm)
        if realm in seen:
            raise ValueError(f"realm {realm} appears twice in the shapefile")
        seen.add(realm)
        g = shape(geom)
        counts["invalid_in"] += not g.is_valid
        counts["vertices_in"] += sum(len(r) for poly in _polys(geom) for r in poly)
        if not g.is_valid:
            g = make_valid(g)
        if tree is not None:
            g = sea_only(g, land, tree)
        p["area_km2"] = round(
            sum(
                geometry_area_km2(mapping(part))
                for part in getattr(g, "geoms", [g])
                if part.geom_type == "Polygon"
            )
        )
        simple = shape(simplify_geometry(g, tol, min_area))
        if not simple.is_valid:
            raise ValueError(f"realm {realm}: simplified geometry is invalid")
        # strips share edges, so the cut MultiPolygon is not OGC-valid as a whole; each strip must be
        cut = split_wide(simple)
        if not all(q.is_valid for q in getattr(cut, "geoms", [cut])):
            raise ValueError(f"realm {realm}: a cut strip is invalid")
        sg = mapping(cut)
        counts["vertices_out"] += sum(len(r) for poly in _polys(sg) for r in poly)
        feats.append({"type": "Feature", "geometry": sg, "properties": p})
    missing = sorted(set(REALMS) - seen)
    if missing:
        raise ValueError(f"realms missing from the shapefile: {missing}")
    feats.sort(key=lambda f: f["properties"]["realm"])
    counts["realms"] = len(feats)
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
        "groups": {str(k): v for k, v in GROUPS.items()},
        "counts": counts,
        "features": feats,
    }


def main(argv=None, *, fetch_to=_fetch_to, want: str = ZIP_MD5, land=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--out", type=Path, default=Path("public/data/marine_realms.geojson")
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
    feats, counts = build(
        read_rows(fetch(a.cache / "realms", fetch_to=fetch_to, want=want)),
        a.tol,
        a.min_area,
        land=read_land(fetch_land_zip(a.cache / "ne_10m_land.zip"))
        if land is None
        else land,
    )
    counts.update({"tol_deg": a.tol, "min_area_deg2": a.min_area})
    doc = collection(feats, counts)
    # the bytes write_atomic writes (json.dump, compact separators)
    size = len(json.dumps(doc, separators=(",", ":")))
    if size > a.budget:
        raise SystemExit(
            f"{size:,} B is over the {a.budget:,} B budget: nothing written"
        )
    write_atomic(a.out, doc)
    log.info(
        "wrote %s: %d realms, %s, %.1f MB (%.0f s)",
        a.out,
        len(feats),
        counts,
        a.out.stat().st_size / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
