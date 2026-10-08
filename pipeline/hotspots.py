"""Biodiversity hotspots (Conservation International, version 2016.1) → public/data/hotspots.geojson (polygon, static).

Spec: docs/superpowers/specs/2026-10-07-hotspots-design.md. The 36 hotspots are regions with at least 1,500 endemic
vascular plant species that have lost at least 70% of their primary native vegetation (Myers et al. 2000, Nature
403:853-858; the 2011 set in Mittermeier et al. 2011, in Biodiversity Hotspots, Springer, pp. 3-22). Zenodo record
3261807 holds the 2016.1 boundaries under CC BY-SA 4.0; the zip is downloaded once and refused unless its md5 is
Zenodo's. 36 rows are hotspot areas (land); 17 are outer limits, which the source metadata defines as the line that
groups a hotspot's islands and patches into one unit for display, not part of the hotspot.

Before anything is written, a premise gate: hotspot areas must lie on land. The share of their area on Natural Earth
10 m land (pipeline/land.py's pinned file) must be at least 95% and at least 5 points above the same shapes shifted
1° E and 1° N. Shapes are then repaired, simplified and snapped with pipeline/ecoregions.py's simplify_geometry,
areas come from the unsimplified shapes, hotspot parts wider than 90° of longitude are cut into strips Cesium can fill
(outer limits are drawn as lines, so they are not cut), and each hotspot gets one colour, shared by its outer limit.
Anything but exactly the 36 named hotspot areas once each, or an output over the budget, stops the run. The output is
shared under the source's CC BY-SA 4.0.
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
from .ecoregions import _polygons, simplify_geometry
from .gfw import geometry_area_km2
from .hfp import _fetch_to, _md5
from .land import fetch_land_zip
from .marine_realms import MAX_PART_WIDTH, read_land, split_wide

log = logging.getLogger("hotspots")
RECORD_URL = "https://doi.org/10.5281/zenodo.3261807"
FILE_URL = "https://zenodo.org/api/records/3261807/files/hotspots_2016_1.zip/content"
ZIP_NAME = "hotspots_2016_1.zip"
# Zenodo's md5 of the zip (record 3261807, read from the API 2026-10-07)
ZIP_MD5 = "c47d115deb7a139174af3c32ed5edf68"
MEMBER = "hotspots_2016_1"
BUDGET_BYTES = 3_000_000
# 0.02° keeps every hotspot's drawn edge within ~2 km of the source; parts under 0.0005 deg² (~6 km² at the equator)
# are dropped from the drawing (1.6 MB with them dropped; 3.7 MB at 0.01° keeping all 9,767 parts, measured 2026-10-07)
DEFAULT_TOL = 0.02
MIN_AREA = 0.0005
# premise gate: share of hotspot area on land at no shift, and the margin over the shifted control
LAND_FLOOR = 0.95
LAND_MARGIN = 0.05
SHIFT = (1.0, 1.0)
AREA, OUTER = "hotspot area", "outer limit"
SOURCE = {
    "id": "hotspots",
    "name": "Biodiversity Hotspots (version 2016.1), Conservation International",
    "url": RECORD_URL,
    "data": FILE_URL,
    "licence": "CC BY-SA 4.0 (Zenodo 10.5281/zenodo.3261807; README in the zip)",
    "citation": "Hoffman M., Koenig K., Bunting G., Costanza J., Williams K.J. (2016) Biodiversity Hotspots "
    "(version 2016.1). Zenodo. doi:10.5281/zenodo.3261807. Criteria: Myers N. et al. (2000) Biodiversity hotspots "
    "for conservation priorities. Nature 403:853-858. doi:10.1038/35002501",
    "note": "Derived from the source by simplifying boundaries for display (islets under about 6 km² not drawn); "
    "areas are of the land in each hotspot, before simplification. An outer limit groups a hotspot's islands and "
    "patches into one unit for display and is not part of the hotspot. This file is shared under CC BY-SA 4.0, "
    "the licence of the source.",
}
# the 36 hotspot names as the source spells them (NAME field, version 2016.1)
NAMES = (
    "Atlantic Forest",
    "California Floristic Province",
    "Cape Floristic Region",
    "Caribbean Islands",
    "Caucasus",
    "Cerrado",
    "Chilean Winter Rainfall and Valdivian Forests",
    "Coastal Forests of Eastern Africa",
    "East Melanesian Islands",
    "Eastern Afromontane",
    "Forests of East Australia",
    "Guinean Forests of West Africa",
    "Himalaya",
    "Horn of Africa",
    "Indo-Burma",
    "Irano-Anatolian",
    "Japan",
    "Madagascar and the Indian Ocean Islands",
    "Madrean Pine-Oak Woodlands",
    "Maputaland-Pondoland-Albany",
    "Mediterranean Basin",
    "Mesoamerica",
    "Mountains of Central Asia",
    "Mountains of Southwest China",
    "New Caledonia",
    "New Zealand",
    "North American Coastal Plain",
    "Philippines",
    "Polynesia-Micronesia",
    "Southwest Australia",
    "Succulent Karoo",
    "Sundaland",
    "Tropical Andes",
    "Tumbes-Choco-Magdalena",
    "Wallacea",
    "Western Ghats and Sri Lanka",
)


def colour(name: str) -> str:
    """One colour per hotspot: hues a golden angle apart in name order, two lightness steps."""
    if name not in NAMES:
        raise ValueError(f"{name!r} is not one of the 36 hotspots")
    i = NAMES.index(name)
    h = (i * 137.508) % 360 / 360
    lightness = 0.55 if i % 2 else 0.68
    r, g, b = colorsys.hls_to_rgb(h, lightness, 0.62)
    return "#{:02x}{:02x}{:02x}".format(*(round(v * 255) for v in (r, g, b)))


def fetch(cache: Path, *, fetch_to=_fetch_to, want: str = ZIP_MD5) -> Path:
    """The pinned zip, downloaded once; refused (and not kept) unless its md5 is Zenodo's."""
    path = cache / ZIP_NAME
    if path.exists():
        got = _md5(path)
        if got != want:
            raise ValueError(
                f"{path}: md5 {got} is not Zenodo's {want}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".zip.part")
    log.info("downloading %s → %s", FILE_URL, path)
    try:
        fetch_to(FILE_URL, part)
        got = _md5(part)
        if got != want:
            raise ValueError(f"{FILE_URL}: md5 {got} is not Zenodo's {want}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def read_rows(zip_path: Path):
    """Yield (NAME, Type, geo_interface geometry) per shapefile row."""
    import shapefile  # pyshp, as pipeline/ecoregions.py

    z = zipfile.ZipFile(zip_path)
    rd = shapefile.Reader(
        shp=io.BytesIO(z.read(f"{MEMBER}.shp")),
        dbf=io.BytesIO(z.read(f"{MEMBER}.dbf")),
        shx=io.BytesIO(z.read(f"{MEMBER}.shx")),
    )
    for sr in rd.iterShapeRecords():
        yield sr.record["NAME"], sr.record["Type"], sr.shape.__geo_interface__


def _km2(g) -> float:
    from shapely.geometry import mapping

    return sum(geometry_area_km2(mapping(p)) for p in _polygons(g))


def land_share(geoms, land, dx: float = 0.0, dy: float = 0.0) -> float:
    """Share of the summed area of `geoms`, moved `dx`° east and `dy`° north, that lies on the `land` polygons."""
    from shapely import STRtree, unary_union
    from shapely.affinity import translate

    land = list(land)
    tree = STRtree(land)
    total = on = 0.0
    for g in geoms:
        g = translate(g, dx, dy)
        total += _km2(g)
        hits = [land[i] for i in tree.query(g)]
        if hits:
            on += _km2(g.intersection(unary_union(hits)))
    return on / total


def premise(geoms, land) -> dict:
    """The land premise gate: hotspot areas on land at no shift, clearly better than shifted by SHIFT."""
    geoms, land = list(geoms), list(land)
    here = land_share(geoms, land)
    there = land_share(geoms, land, *SHIFT)
    if here < LAND_FLOOR:
        raise ValueError(
            f"only {here:.1%} of hotspot area is on land at no shift (floor {LAND_FLOOR:.0%})"
        )
    if here - there < LAND_MARGIN:
        raise ValueError(
            f"land share at no shift ({here:.1%}) is not clearly better than shifted {SHIFT[0]:g}° E, "
            f"{SHIFT[1]:g}° N ({there:.1%})"
        )
    return {"land_share": here, "land_share_shifted": there, "shift_deg": list(SHIFT)}


def valid_rows(rows):
    """(name, type, geometry as given, geometry repaired); refuses an unknown type (colour() refuses an unknown name)."""
    from shapely import make_valid
    from shapely.geometry import shape

    for name, kind, geom in rows:
        if kind not in (AREA, OUTER):
            raise ValueError(
                f"{name!r}: type {kind!r} is neither {AREA!r} nor {OUTER!r}"
            )
        g = shape(geom)
        yield name, kind, g, (g if g.is_valid else make_valid(g))


def build(rows, tol: float = DEFAULT_TOL, min_area: float = MIN_AREA):
    """rows of (name, type, geometry) → (features: the 36 areas by name, then the outer limits by name; counts)."""
    from shapely.geometry import mapping, shape

    feats = {AREA: {}, OUTER: {}}
    counts = {"vertices_in": 0, "vertices_out": 0, "invalid_in": 0}
    for name, kind, raw, g in valid_rows(rows):
        if name in feats[kind]:
            raise ValueError(f"{name!r} {kind} appears twice")
        counts["invalid_in"] += not raw.is_valid
        counts["vertices_in"] += _vertices(mapping(raw))
        p = {
            "kind": "area" if kind == AREA else "outer",
            "name": name,
            "color": colour(name),
        }
        simple = shape(simplify_geometry(g, tol, min_area))
        if not simple.is_valid:
            raise ValueError(f"{name!r} {kind}: simplified geometry is invalid")
        if kind == AREA:
            p["area_km2"] = round(_km2(g))
            # strips share edges, so the cut MultiPolygon is not OGC-valid as a whole; each strip must be
            simple = split_wide(simple, MAX_PART_WIDTH)
            if not all(q.is_valid for q in getattr(simple, "geoms", [simple])):
                raise ValueError(f"{name!r} {kind}: a cut strip is invalid")
        else:
            # drawn as lines and not cut: a ring crossing ±180° unsplit would draw one line the long way round the
            # globe. The source splits New Zealand's and Polynesia-Micronesia's at the meridian (the layer leaves
            # those edges out); a release that did not would stop here.
            jump = _max_lon_step(simple)
            if jump > 180:
                raise ValueError(
                    f"{name!r} {kind}: an edge spans {jump:.0f}° of longitude (crosses ±180° unsplit)"
                )
        sg = mapping(simple)
        counts["vertices_out"] += _vertices(sg)
        feats[kind][name] = {"type": "Feature", "geometry": sg, "properties": p}
    missing = sorted(set(NAMES) - set(feats[AREA]))
    if missing:
        raise ValueError(f"hotspot areas missing: {missing}")
    counts["areas"] = len(feats[AREA])
    counts["outer_limits"] = len(feats[OUTER])
    out = [feats[AREA][n] for n in sorted(feats[AREA])] + [
        feats[OUTER][n] for n in sorted(feats[OUTER])
    ]
    return out, counts


def _max_lon_step(g) -> float:
    """The largest longitude difference between consecutive vertices of any exterior ring of `g`."""
    steps = [
        abs(b[0] - a[0])
        for q in _polygons(g)
        for a, b in zip(q.exterior.coords, list(q.exterior.coords)[1:])
    ]
    return max(steps, default=0.0)


def _vertices(geom: dict) -> int:
    polys = (
        geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    )
    return sum(len(r) for poly in polys for r in poly)


def collection(feats: list[dict], counts: dict) -> dict:
    return {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE,
        "counts": counts,
        "features": feats,
    }


def main(argv=None, *, fetch_to=_fetch_to, want: str = ZIP_MD5, land=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=Path("public/data/hotspots.geojson"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        ),
    )
    ap.add_argument("--tol", type=float, default=DEFAULT_TOL)
    ap.add_argument("--min-area", type=float, default=MIN_AREA)
    ap.add_argument("--budget", type=int, default=BUDGET_BYTES)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    rows = list(read_rows(fetch(a.cache / "hotspots", fetch_to=fetch_to, want=want)))
    if land is None:
        land = read_land(fetch_land_zip(a.cache / "ne_10m_land.zip"))
    gate = premise((g for _, kind, _, g in valid_rows(rows) if kind == AREA), land)
    log.info("land premise: %s", gate)
    feats, counts = build(rows, a.tol, a.min_area)
    counts.update(gate)
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
        "wrote %s: %d features, %s, %.2f MB (%.0f s)",
        a.out,
        len(feats),
        counts,
        a.out.stat().st_size / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
