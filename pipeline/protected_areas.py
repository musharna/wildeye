"""Protected areas mapped in OpenStreetMap, via Overture Maps → a geographic tile pyramid and per-cell lookup shards.

Spec: docs/superpowers/specs/2026-10-03-protected-areas-design.md. Overture's base theme publishes OSM's protected areas
as assembled polygons (`land_use`, subtype `protected`), ODbL 1.0. DuckDB copies the rows once per release into a local
staging parquet (geometry as WKB: geoparquet conversion off, no spatial extension). Each class is read into a group by
hand (CLASSES); an unknown class, or a row not from OpenStreetMap under ODbL-1.0, stops the run before anything is
written. Geometry is repaired and simplified with shapely, painted into 256-px palette tiles on Cesium's geographic
tiling scheme (level z: 2^(z+1) × 2^z tiles), the most protective group winning a shared pixel, coarser levels the 2 × 2
maximum of the finer; only painted tiles are written and listed. The lookup shards (one JSON per 5° cell, every area
clipped to it) answer what is at a point. protected_areas.json, written last, is what the layer reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import logging
import math
import os
import re
import shutil
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("protected_areas")
BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
S3 = "s3://overturemaps-us-west-2"
UA = {"User-Agent": "wildeye/0.1 (protected areas)"}
TILE = 256
MAX_LEVEL = (
    7  # 256 × 128 tiles at the finest level: 0.0055°, about 610 m at the equator
)
SIMPLIFY_DEG = 0.001  # a fifth of a level-7 pixel
SHARD_DEG = 1  # a click downloads one 1° cell (5° cells reached 7.8 MB in the north-eastern US)
COORD_SCALE = 10_000  # coordinates as integers of 1e-4 degrees, about 11 m

STRICT, NATIONAL_PARK, OTHER = (
    3,
    2,
    1,
)  # palette index; a higher one wins a shared pixel
OUT = None
# Overture's protected classes (all 12 in release 2026-09-23.1), each read and grouped by hand: (group, readout label)
CLASSES = {
    "strict_nature_reserve": (STRICT, "strict nature reserve"),
    "wilderness_area": (STRICT, "wilderness area"),
    "national_park": (NATIONAL_PARK, "national park"),
    "natural_monument": (OTHER, "natural monument"),
    "species_management_area": (OTHER, "habitat or species management area"),
    "protected_landscape_seascape": (OTHER, "protected landscape or seascape"),
    "nature_reserve": (OTHER, "nature reserve"),
    "environmental": (OTHER, "environmental protection area"),
    "protected": (OTHER, "protected area"),
    "forest": (OTHER, "protected forest"),
    "state_park": (OTHER, "state park"),
    # land tenure, not nature protection
    "aboriginal_land": (OUT, "aboriginal land"),
}
GROUPS = [
    {
        "index": STRICT,
        "key": "strict",
        "label": "Strict reserve or wilderness (IUCN Ia/Ib)",
    },
    {
        "index": NATIONAL_PARK,
        "key": "national_park",
        "label": "National park (IUCN II)",
    },
    {
        "index": OTHER,
        "key": "other",
        "label": "Other protection: monuments, habitat areas, landscapes, reserves",
    },
]
# palette index → RGB; 0 is transparent. ColorBrewer Greens, three steps apart so each reads on the dark globe.
PALETTE = [(0, 0, 0), (161, 217, 155), (65, 171, 93), (0, 90, 50)]
SOURCE = {
    "name": "OpenStreetMap protected areas, via Overture Maps (base theme, land_use, subtype protected)",
    "credit": "© OpenStreetMap contributors. Available under the Open Database License.",
    "licence": "ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)",
    "data": "https://docs.overturemaps.org/guides/base/",
}


class ProtectedAreasError(RuntimeError):
    """The source holds something not yet read (a class, a source, a licence): nothing is written."""


def _get(url: str, timeout: int = 120) -> bytes:
    with urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def latest_release(get=_get) -> str:
    """The newest Overture release name (YYYY-MM-DD.N) in the bucket's release/ listing."""
    xml = get(f"{BUCKET}/?list-type=2&prefix=release/&delimiter=/").decode()
    names = re.findall(r"<Prefix>release/(\d{4}-\d{2}-\d{2}\.\d{1,3})/</Prefix>", xml)
    if not names:
        raise ProtectedAreasError(
            f"no release in the Overture listing ({len(xml)} bytes)"
        )
    return max(names, key=lambda n: (n.split(".")[0], int(n.split(".")[1])))


def source_glob(release: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d{1,3}", release):
        raise ValueError(f"not an Overture release name: {release!r}")
    return f"{S3}/release/{release}/theme=base/type=land_use/*"


def connect():
    import duckdb

    con = duckdb.connect()
    con.execute("SET enable_progress_bar = false")
    con.execute("INSTALL httpfs")
    con.execute("LOAD httpfs")
    con.execute("SET s3_region = 'us-west-2'")
    con.execute("SET http_retries = 8")
    con.execute("SET http_retry_wait_ms = 2000")
    con.execute(
        "SET enable_geoparquet_conversion = false"
    )  # geometry as WKB, read by shapely
    return con


EXTRACT_SQL = """
SELECT
    id,
    names."primary" AS name,
    class,
    map_extract_value(source_tags, 'protection_title') AS title,
    map_extract_value(source_tags, 'operator') AS operator,
    regexp_replace(sources[1].record_id, '@[0-9]+$', '') AS osm,
    sources[1].dataset AS dataset,
    sources[1].license AS license,
    len(sources) AS n_sources,
    wikidata,
    geometry
FROM read_parquet($src, hive_partitioning = 1)
WHERE subtype = 'protected'
  AND bbox.xmax >= $w AND bbox.xmin <= $e AND bbox.ymax >= $s AND bbox.ymin <= $n
"""


def _sql_path(p: Path) -> str:
    """A local path quoted for COPY ... TO, which takes no parameter there."""
    text = str(p)
    if "'" in text:
        raise ValueError(f"path with a quote cannot be quoted for DuckDB: {text}")
    return f"'{text}'"


def extract(con, source: str, out: Path, bbox=(-180.0, -90.0, 180.0, 90.0)) -> int:
    """The protected rows of `source` (a parquet glob or path) inside bbox (w, s, e, n) → `out`; returns rows written."""
    tmp = out.with_suffix(".part")
    out.parent.mkdir(parents=True, exist_ok=True)
    w, s, e, n = bbox
    con.execute(
        f"COPY ({EXTRACT_SQL}) TO {_sql_path(tmp)} (FORMAT parquet)",  # nosec B608 - EXTRACT_SQL is a constant; the path is <staging>/protected-<release>.parquet, the release regex-checked in source_glob, quote-refused by _sql_path; source and bbox are parameters
        {"src": source, "w": w, "s": s, "e": e, "n": n},
    )
    os.replace(tmp, out)
    (rows,) = con.execute("SELECT count(*) FROM read_parquet($p)", {"p": str(out)}).fetchone()
    return int(rows)


@dataclass
class Area:
    name: str | None
    cls: str
    group: int
    title: str | None
    operator: str | None
    osm: str
    wikidata: str | None
    geom: object  # shapely Polygon or MultiPolygon, simplified
    km2: float


def check_rows(rows) -> None:
    """Refuse a class not in CLASSES and a row not from OpenStreetMap under ODbL-1.0, naming the first of each."""
    for r in rows:
        if r["class"] not in CLASSES:
            raise ProtectedAreasError(
                f"class {r['class']!r} (area {r['id']}) is not in CLASSES: read it and group it"
            )
        if (
            r["dataset"] != "OpenStreetMap"
            or r["license"] != "ODbL-1.0"
            or r["n_sources"] != 1
        ):
            raise ProtectedAreasError(
                f"area {r['id']} comes from {r['n_sources']} source(s), first {r['dataset']!r} under {r['license']!r}: "
                "only OpenStreetMap under ODbL-1.0 has been read"
            )


def _polygonal(g):
    """The polygon parts of a repaired geometry (make_valid can return a collection with lines or points)."""
    import shapely
    from shapely.geometry import MultiPolygon, Polygon

    if not g.is_valid:
        g = shapely.make_valid(g)
    if isinstance(g, (Polygon, MultiPolygon)):
        return g
    parts = [
        p for p in getattr(g, "geoms", []) if isinstance(p, (Polygon, MultiPolygon))
    ]
    polys = [
        q for p in parts for q in (p.geoms if isinstance(p, MultiPolygon) else [p])
    ]
    return MultiPolygon(polys) if polys else None


def km2(g) -> float:
    """Approximate area: square degrees scaled by the cosine of the centroid's latitude (ordering, not measurement)."""
    if g.is_empty:
        return 0.0
    return g.area * 111.32**2 * math.cos(math.radians(g.centroid.y))


def load(staged: Path) -> tuple[list[Area], dict]:
    """The staged rows as Areas, simplified, OUT classes left out; with counts of what was left out and why."""
    import duckdb
    import shapely

    con = duckdb.connect()
    cur = con.execute("SELECT * FROM read_parquet($p)", {"p": str(staged)})
    cols = [c[0] for c in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    con.close()
    check_rows(rows)
    areas, counts = (
        [],
        {"rows": len(rows), "left_out_class": 0, "no_polygon": 0, "unnamed": 0},
    )
    for r in rows:
        group, _ = CLASSES[r["class"]]
        if group is OUT:
            counts["left_out_class"] += 1
            continue
        g = _polygonal(shapely.from_wkb(bytes(r["geometry"])))
        if g is not None:
            g = _polygonal(shapely.simplify(g, SIMPLIFY_DEG, preserve_topology=True))
        if g is None or g.is_empty:
            counts["no_polygon"] += 1
            continue
        if not r["name"]:
            counts["unnamed"] += 1
        areas.append(
            Area(
                r["name"] or None,
                r["class"],
                group,
                r["title"] or None,
                r["operator"] or None,
                r["osm"],
                r["wikidata"] or None,
                g,
                km2(g),
            )
        )
    return areas, counts


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a geographic-scheme tile, y from the north."""
    d = 180 / 2**z
    return (-180 + x * d, 90 - (y + 1) * d, -180 + (x + 1) * d, 90 - y * d)


def finest_tiles(
    areas: list[Area], max_level: int = MAX_LEVEL
) -> dict[tuple[int, int], np.ndarray]:
    """{(x, y): 256 × 256 group array} for every finest-level tile with a painted pixel; lower groups painted first."""
    import shapely
    from rasterio.features import rasterize
    from rasterio.transform import from_bounds

    order = sorted(range(len(areas)), key=lambda i: areas[i].group)
    geoms = [areas[i].geom for i in order]
    groups = [areas[i].group for i in order]
    tree = shapely.STRtree(geoms)
    d = 180 / 2**max_level
    touched: set[tuple[int, int]] = set()
    for g in geoms:
        w, s, e, n = g.bounds
        for x in range(
            max(0, int((w + 180) // d)),
            min(2 ** (max_level + 1), int((e + 180) // d) + 1),
        ):
            for y in range(
                max(0, int((90 - n) // d)), min(2**max_level, int((90 - s) // d) + 1)
            ):
                touched.add((x, y))
    out = {}
    for x, y in sorted(touched):
        b = tile_bounds(max_level, x, y)
        hits = sorted(
            tree.query(shapely.box(*b))
        )  # STRtree indices are positions in `geoms`, already group-ordered
        if not hits:
            continue
        arr = rasterize(
            [(geoms[i], groups[i]) for i in hits],
            out_shape=(TILE, TILE),
            transform=from_bounds(*b, TILE, TILE),
            fill=0,
            dtype="uint8",
        )
        if arr.any():
            out[(x, y)] = arr
    return out


def coarser(
    tiles: dict[tuple[int, int], np.ndarray],
) -> dict[tuple[int, int], np.ndarray]:
    """The next coarser level: each tile the 2 × 2 maximum of its four children (absent children are empty)."""
    parents: dict[tuple[int, int], np.ndarray] = {}
    for (x, y), arr in tiles.items():
        px, py = x // 2, y // 2
        big = parents.setdefault((px, py), np.zeros((2 * TILE, 2 * TILE), np.uint8))
        oy, ox = (y % 2) * TILE, (x % 2) * TILE
        big[oy : oy + TILE, ox : ox + TILE] = arr
    return {k: v.reshape(TILE, 2, TILE, 2).max(axis=(1, 3)) for k, v in parents.items()}


def pyramid(finest: dict, max_level: int = MAX_LEVEL):
    """(z, tiles) from max_level down to 0."""
    tiles = finest
    for z in range(max_level, -1, -1):
        yield z, tiles
        if z:
            tiles = coarser(tiles)


def png(arr: np.ndarray) -> bytes:
    im = Image.fromarray(np.ascontiguousarray(arr), "P")
    im.putpalette(bytes(c for rgb in PALETTE for c in rgb))
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True, transparency=bytes([0, 255, 255, 255]))
    return buf.getvalue()


def shard_key(lat: float, lon: float) -> tuple[int, int]:
    """The 5° cell's south-west corner, 90°N and 180°E folded into the last cell."""
    return (
        min(math.floor(lat / SHARD_DEG) * SHARD_DEG, 90 - SHARD_DEG),
        min(math.floor(lon / SHARD_DEG) * SHARD_DEG, 180 - SHARD_DEG),
    )


def _rings(poly) -> list[list[int]]:
    """A polygon's rings (exterior first), closing point dropped, as flat integer lists in 1/COORD_SCALE degrees: the
    first lon, lat absolute, every later pair the difference from the one before (a third of the bytes of decimals)."""
    out = []
    for ring in [poly.exterior, *poly.interiors]:
        ints = [round(v * COORD_SCALE) for xy in list(ring.coords)[:-1] for v in xy]
        out.append(ints[:2] + [ints[i] - ints[i - 2] for i in range(2, len(ints))])
    return out


def shards(areas: list[Area]) -> dict[tuple[int, int], list[dict]]:
    """{cell: [area record]} for every 5° cell an area reaches, each area clipped to the cell."""
    import shapely
    from shapely.geometry import MultiPolygon, Polygon

    out: dict[tuple[int, int], list[dict]] = {}
    for a in areas:
        w, s, e, n = a.geom.bounds
        lat0, lon0 = shard_key(s, w)
        lat1, lon1 = shard_key(n, e)
        for lat in range(lat0, lat1 + SHARD_DEG, SHARD_DEG):
            for lon in range(lon0, lon1 + SHARD_DEG, SHARD_DEG):
                part = shapely.clip_by_rect(
                    a.geom, lon, lat, lon + SHARD_DEG, lat + SHARD_DEG
                )
                polys = [
                    p
                    for p in (part.geoms if isinstance(part, MultiPolygon) else [part])
                    if isinstance(p, Polygon) and not p.is_empty
                ]
                if not polys:
                    continue
                out.setdefault((lat, lon), []).append(
                    {
                        "name": a.name,
                        "class": a.cls,
                        "title": a.title,
                        "operator": a.operator,
                        "osm": a.osm,
                        "wikidata": a.wikidata,
                        "km2": round(a.km2, 2),
                        "polygons": [_rings(p) for p in polys],
                    }
                )
    return out


def _replace_dir(tmp: Path, final: Path) -> None:
    old = final.with_name(f".{final.name}.old")
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(tmp, final)
    shutil.rmtree(old, ignore_errors=True)


def write(
    areas: list[Area],
    counts: dict,
    release: str,
    out_dir: Path,
    *,
    max_level: int = MAX_LEVEL,
    now=None,
) -> dict:
    """Tiles and shards into out_dir/protected (replaced whole), then out_dir/protected_areas.json; returns the manifest."""
    root = out_dir / "protected"
    tmp = out_dir / ".protected.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    finest = finest_tiles(areas, max_level)
    listed: dict[str, list[list[int]]] = {}
    tile_bytes = 0
    for z, tiles in pyramid(finest, max_level):
        listed[str(z)] = sorted([x, y] for x, y in tiles)
        for (x, y), arr in tiles.items():
            p = tmp / "tiles" / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = png(arr)
            p.write_bytes(data)
            tile_bytes += len(data)
    painted = _painted_count(areas, finest, max_level)
    shard_bytes = 0
    cells = shards(areas)
    for (lat, lon), recs in cells.items():
        p = tmp / "shards" / f"{lat}_{lon}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps(
            {"cell": [lat, lon], "areas": recs},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
        p.write_bytes(data)
        shard_bytes += len(data)
    if not cells and not finest:
        tmp.mkdir(parents=True, exist_ok=True)
    _replace_dir(tmp, root)
    when = (now or (lambda: dt.datetime.now(dt.UTC)))()
    by_group = {
        g["key"]: sum(1 for a in areas if a.group == g["index"]) for g in GROUPS
    }
    manifest = {
        "release": release,
        "generated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxLevel": max_level,
        "tile": "data/protected/tiles/{z}/{x}/{y}.png",
        "tiles": listed,
        "palette": [list(c) for c in PALETTE],
        "groups": GROUPS,
        "classes": {
            k: {"group": g, "label": label} for k, (g, label) in CLASSES.items()
        },
        "shard_degrees": SHARD_DEG,
        "coord_scale": COORD_SCALE,
        "shard": "data/protected/shards/{lat}_{lon}.json",
        "shards": sorted([lat, lon] for lat, lon in cells),
        "counts": {
            **counts,
            "areas": len(areas),
            "by_group": by_group,
            "unpainted_at_max_level": len(areas) - painted,
            "tile_bytes": tile_bytes,
            "shard_bytes": shard_bytes,
        },
        "source": SOURCE,
    }
    write_atomic(
        out_dir / "protected_areas.json", manifest
    )  # last: the layer reads this one
    return manifest


def _painted_count(areas: list[Area], finest: dict, max_level: int) -> int:
    """Areas with a finest-level pixel of their own group or higher inside their bounds. An upper bound on what shows:
    a pixel another area painted inside those bounds counts too."""
    d = 180 / 2**max_level
    px = d / TILE
    n = 0
    for a in areas:
        w, s, e, nn = a.geom.bounds
        x0, x1 = (
            max(0, int((w + 180) // d)),
            min(2 ** (max_level + 1) - 1, int((e + 180) // d)),
        )
        y0, y1 = max(0, int((90 - nn) // d)), min(2**max_level - 1, int((90 - s) // d))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                arr = finest.get((x, y))
                if arr is None:
                    continue
                bw, bs, be, bn = tile_bounds(max_level, x, y)
                c0, c1 = int((max(w, bw) - bw) // px), math.ceil((min(e, be) - bw) / px)
                r0, r1 = int((bn - min(nn, bn)) // px), math.ceil((bn - max(s, bs)) / px)
                if (arr[r0:r1, c0:c1] >= a.group).any():
                    n += 1
                    break
            else:
                continue
            break
    return n


def main(argv=None, *, get=_get, now=None, con=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--staging",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "protected_areas",
    )
    ap.add_argument(
        "--release",
        default=None,
        help="Overture release (default: the newest in the bucket)",
    )
    ap.add_argument(
        "--source",
        default=None,
        help="parquet glob or path to read instead of the release (checks)",
    )
    ap.add_argument(
        "--bbox",
        default=None,
        help="w,s,e,n: only areas whose bounds touch it (checks, not publishing)",
    )
    ap.add_argument("--max-level", type=int, default=MAX_LEVEL)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    release = a.release or latest_release(get)
    source = a.source or source_glob(release)
    bbox = (
        tuple(float(v) for v in a.bbox.split(","))
        if a.bbox
        else (-180.0, -90.0, 180.0, 90.0)
    )
    if len(bbox) != 4:
        raise ValueError(f"--bbox needs w,s,e,n, got {a.bbox!r}")
    suffix = "" if a.bbox is None else "-bbox-" + "_".join(f"{v:g}" for v in bbox)
    staged = a.staging / f"protected-{release}{suffix}.parquet"
    if staged.exists() and a.source is None:
        log.info("staged %s already (release %s)", staged, release)
    else:
        rows = extract(con or connect(), source, staged, bbox)
        log.info(
            "staged %d protected rows from %s (%.0f s)", rows, source, time.time() - t0
        )
    areas, counts = load(staged)
    log.info("%d areas to draw (%s) (%.0f s)", len(areas), counts, time.time() - t0)
    m = write(areas, counts, release, a.out_dir, max_level=a.max_level, now=now)
    c = m["counts"]
    log.info(
        "wrote %d tiles (%.1f MB) and %d shards (%.1f MB); %d areas paint no level-%d pixel (%.0f s)",
        sum(len(v) for v in m["tiles"].values()),
        c["tile_bytes"] / 1e6,
        len(m["shards"]),
        c["shard_bytes"] / 1e6,
        c["unpainted_at_max_level"],
        a.max_level,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
