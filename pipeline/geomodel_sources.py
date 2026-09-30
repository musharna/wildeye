"""Network and file inputs for the geomodel harness (pipeline/geomodel_check.py).

- iNaturalist Open Range Maps: one GeoPackage per collection on AWS Open Data (CC BY 4.0).
- GBIF: species matching, occurrence search (presences and the model's own iNaturalist records) and
  binned count tiles (the effort background), all CC0 or CC BY except the iNaturalist training records,
  which are read for their locations only and never written out.
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely

from . import mvt
from .net import urlopen

log = logging.getLogger("geomodel")
UA = "wildeye/0.1 (geomodel check; https://github.com/musharna/wildeye)"
RANGES = "https://inaturalist-open-data.s3.us-east-1.amazonaws.com/geomodel/geopackages/latest/"
GBIF = "https://api.gbif.org/v1/"
TILES = "https://api.gbif.org/v2/map/occurrence/adhoc/{z}/{x}/{y}.mvt"
INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"  # iNaturalist Research-grade Observations on GBIF
OPEN_LICENCES = ("CC0_1_0", "CC_BY_4_0")
# GBIF's adhoc tiles at z3 misplace records by more than a cell (6x6-cell blocks against occurrence search:
# L1 error 1.6-2.6x the block's records, 2026-09-29); from z4 the error is 0.08-0.22 and does not shrink at z5.
TILE_ZOOM = 4
SQUARE = 128  # squareSize on GBIF's 4096 extent: 32 x 32 cells per tile, 512 across the world at z4

# iNaturalist geomodel collection → GBIF backbone taxa whose records are its effort background. Checked by
# name and occurrence count at the start of every run (verify_group_keys): the backbone moved Reptilia (358)
# to a pro parte synonym, so reptiles are the three classes GBIF now uses. Tuatara (no clean class) is left out.
# GBIF files no record under class Actinopterygii (204, 0 occurrences on 2026-09-30): its ray-finned fishes
# are the 46 accepted orders directly under Chordata with no class (sharks, lampreys, hagfishes, chimaeras,
# coelacanths and lungfishes all have classes). 35 are iNaturalist Actinopterygii orders by name; the other 11
# (pikes, flatfishes, scorpionfishes, sticklebacks...) are fish orders iNaturalist has since split or merged.
FISH_ORDERS: dict[int, str] = {
    1103: "Acipenseriformes",
    1104: "Albuliformes",
    494: "Amiiformes",
    495: "Anguilliformes",
    1105: "Ateleopodiformes",
    496: "Atheriniformes",
    497: "Aulopiformes",
    1106: "Batrachoidiformes",
    498: "Beloniformes",
    499: "Beryciformes",
    1107: "Cetomimiformes",
    537: "Characiformes",
    538: "Clupeiformes",
    1153: "Cypriniformes",
    547: "Cyprinodontiformes",
    1162: "Elopiformes",
    548: "Esociformes",
    549: "Gadiformes",
    550: "Gasterosteiformes",
    1163: "Gobiesociformes",
    1164: "Gonorynchiformes",
    1165: "Gymnotiformes",
    1166: "Lampriformes",
    1167: "Lepisosteiformes",
    1305: "Lophiiformes",
    1067: "Mugiliformes",
    1306: "Myctophiformes",
    1307: "Notacanthiformes",
    1308: "Ophidiiformes",
    1068: "Osmeriformes",
    1069: "Osteoglossiformes",
    587: "Perciformes",
    1310: "Percopsiformes",
    588: "Pleuronectiformes",
    589: "Polymixiiformes",
    1311: "Polypteriformes",
    1312: "Saccopharyngiformes",
    1313: "Salmoniformes",
    590: "Scorpaeniformes",
    708: "Siluriformes",
    890: "Stephanoberyciformes",
    774: "Stomiiformes",
    889: "Synbranchiformes",
    773: "Syngnathiformes",
    772: "Tetraodontiformes",
    888: "Zeiformes",
}

GROUPS: dict[str, dict] = {
    "Aves": {"include": {212: "Aves"}},
    "Mammalia": {"include": {359: "Mammalia"}},
    "Amphibia": {"include": {131: "Amphibia"}},
    "Reptilia": {
        "include": {
            11592253: "Squamata",
            11418114: "Testudines",
            11493978: "Crocodylia",
        }
    },
    "Actinopterygii": {"include": dict(FISH_ORDERS)},
    "Insecta": {"include": {216: "Insecta"}},
    "Arachnida": {"include": {367: "Arachnida"}},
    "Mollusca": {"include": {52: "Mollusca"}},
    "Plantae": {"include": {6: "Plantae"}},
    "Fungi": {"include": {5: "Fungi"}},
    "Protozoa": {"include": {7: "Protozoa"}},
    "Chromista": {"include": {4: "Chromista"}},
    "OtherAnimalia": {
        "include": {1: "Animalia"},
        "exclude": {
            212: "Aves",
            359: "Mammalia",
            131: "Amphibia",
            11592253: "Squamata",
            11418114: "Testudines",
            11493978: "Crocodylia",
            **FISH_ORDERS,
            216: "Insecta",
            367: "Arachnida",
            52: "Mollusca",
        },
    },
}


class SourceError(RuntimeError):
    def __init__(self, message: str, code: int | None = None, body: str | None = None):
        super().__init__(message)
        self.code, self.body = code, body


def fetch(url: str, *, attempts: int = 6, pause: float = 0.0) -> bytes:
    """GET with retries on 429 and 5xx; anything else, or the last failure, raises with the URL.

    429 means the server is loaded (GBIF's limit follows its load): wait its Retry-After, else a minute
    doubling each time, about half an hour in all before giving up."""
    last = None
    for attempt in range(attempts):
        if pause:
            time.sleep(pause)
        wait = 2**attempt * 5
        try:
            with urlopen(
                urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120
            ) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code != 429 and e.code < 500:
                body = e.read().decode("utf-8", "replace").strip()
                raise SourceError(
                    f"{e.code} for {url}: {body[:200]}", e.code, body
                ) from e
            if e.code == 429:
                after = (e.headers or {}).get("Retry-After", "")
                wait = int(after) if after.isdigit() else 60 * 2**attempt
                log.info("429 from %s, waiting %d s", url.split("?")[0], wait)
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        if attempt < attempts - 1:
            time.sleep(wait)
    raise SourceError(f"gave up on {url}: {last}")


def fetch_json(url: str) -> dict:
    return json.loads(fetch(url))


# GBIF's adhoc tiles answer 204 for an empty tile, except where the unfiltered tile has records and the
# filter leaves none: then 400 with this body (2026-09-29: Amphibia 3/1/7, 0 records in the box by
# occurrence search, while Aves 3/1/7 is 200). Only this exact answer means "no records"; any other 400
# still stops the run.
EMPTY_TILE_BODY = "Tile is missing the expected layer: occurrence"


def fetch_tile(url: str) -> bytes:
    try:
        return fetch(url)
    except SourceError as e:
        if e.code == 400 and e.body == EMPTY_TILE_BODY:
            return b""
        raise


def verify_group_keys(get_json: Callable[[str], dict] = fetch_json) -> None:
    """Every GBIF key in GROUPS still names the taxon it was chosen for and has records filed under it,
    or the run stops."""
    wrong = []
    keys = {k: n for spec in GROUPS.values() for k, n in {**spec["include"], **spec.get("exclude", {})}.items()}
    for key, name in keys.items():
        got = get_json(f"{GBIF}species/{key}").get("canonicalName")
        if got != name:
            wrong.append(f"GBIF {key} is {got!r}, expected {name!r}")
        elif not get_json(f"{GBIF}occurrence/search?taxonKey={key}&limit=0")["count"]:
            wrong.append(f"GBIF {key} {name} has no occurrences filed under it")
    if wrong:
        raise SourceError("GBIF backbone keys moved: " + "; ".join(sorted(set(wrong))))


# ---- effort background ----------------------------------------------------------------------------


def _tile_url(z: int, x: int, y: int, keys, dataset: str | None) -> str:
    q = [("srs", "EPSG:3857"), ("bin", "square"), ("squareSize", str(SQUARE))]
    q += [("license", lic) for lic in OPEN_LICENCES] + [
        ("taxonKey", str(k)) for k in sorted(keys)
    ]
    if dataset:
        q.append(("datasetKey", dataset))
    return TILES.format(z=z, x=x, y=y) + "?" + urllib.parse.urlencode(q)


def effort_grid(
    group: str, get_tile: Callable[[str], bytes] = fetch_tile
) -> np.ndarray:
    """Non-iNaturalist CC0/CC BY record counts on a 512 x 512 web-mercator grid (row 0 = north)."""
    spec = GROUPS[group]
    n = 2**TILE_ZOOM
    per = 4096 // SQUARE
    grid = np.zeros((n * per, n * per), dtype=np.int64)
    terms = [(spec["include"], None, 1), (spec["include"], INAT_DATASET, -1)]
    if spec.get("exclude"):
        terms += [(spec["exclude"], None, -1), (spec["exclude"], INAT_DATASET, 1)]
    jobs = [
        (x, y, keys, dataset, sign)
        for x in range(n)
        for y in range(n)
        for keys, dataset, sign in terms
    ]
    with ThreadPoolExecutor(TILE_WORKERS) as pool:
        tiles = pool.map(
            lambda j: get_tile(_tile_url(TILE_ZOOM, j[0], j[1], j[2], j[3])), jobs
        )
        for (x, y, _keys, _dataset, sign), tile in zip(jobs, tiles):
            for c in mvt.cells(tile):
                grid[y * per + c.y0 // SQUARE, x * per + c.x0 // SQUARE] += (
                    sign * c.total
                )
    # tiles fetched a moment apart can disagree by a few records; a negative count is not effort
    return np.clip(grid, 0, None)


def _mercator_to_lonlat(gx: np.ndarray, gy: np.ndarray) -> np.ndarray:
    """gx, gy in [0, 1) across the web-mercator world (gy = 0 at the north edge) → lon/lat degrees."""
    lon = gx * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * gy))))
    return np.column_stack([lon, lat])


def sample_background(grid: np.ndarray, n: int, rng: np.random.Generator) -> np.ndarray:
    """n lon/lat points, cells drawn in proportion to their counts, uniform within the cell."""
    total = grid.sum()
    if total <= 0:
        raise SourceError("effort grid is empty")
    flat = rng.choice(grid.size, size=n, p=(grid.ravel() / total))
    rows, cols = np.divmod(flat, grid.shape[1])
    gx = (cols + rng.random(n)) / grid.shape[1]
    gy = (rows + rng.random(n)) / grid.shape[0]
    return _mercator_to_lonlat(gx, gy)


GRID = 2**TILE_ZOOM * (4096 // SQUARE)  # effort-grid cells across the world
PLACEMENT_BLOCK = (
    7.0,
    47.5,
    212,
)  # lon, lat, taxon: birds around Switzerland, dense and mid-latitude


def _lonlat_to_cell(lon: float, lat: float) -> tuple[int, int]:
    gx = (lon + 180.0) / 360.0
    gy = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0
    return int(gy * GRID), int(gx * GRID)


def placement_error(
    lon: float,
    lat: float,
    taxon: int,
    *,
    size: int = 6,
    get_tile: Callable[[str], bytes] = fetch_tile,
    get_json: Callable[[str], dict] = fetch_json,
) -> float:
    """How far the count tiles the effort grid is built from misplace records: the L1 distance between a
    size x size block of grid cells at (lon, lat) and GBIF occurrence search over the same cells, as a share
    of the records search finds there. 0 = every record in its cell; 2 = none are."""
    r0, c0 = _lonlat_to_cell(lon, lat)
    per = 4096 // SQUARE
    tiles = {
        (c // per, r // per) for r in range(r0, r0 + size) for c in range(c0, c0 + size)
    }
    ours = np.zeros((size, size), dtype=np.int64)
    for x, y in tiles:
        for c in mvt.cells(get_tile(_tile_url(TILE_ZOOM, x, y, {taxon}, None))):
            r, cc = y * per + c.y0 // SQUARE - r0, x * per + c.x0 // SQUARE - c0
            if 0 <= r < size and 0 <= cc < size:
                ours[r, cc] += c.total
    truth = np.zeros_like(ours)
    for i in range(size):
        for j in range(size):
            (lo0, la1), (lo1, la0) = _mercator_to_lonlat(
                np.array([(c0 + j) / GRID, (c0 + j + 1) / GRID]),
                np.array([(r0 + i) / GRID, (r0 + i + 1) / GRID]),
            )
            q = [("limit", "0"), ("taxonKey", str(taxon)), ("hasCoordinate", "true")]
            q += [("license", lic) for lic in OPEN_LICENCES]
            q += [
                ("decimalLatitude", f"{la0},{la1}"),
                ("decimalLongitude", f"{lo0},{lo1}"),
            ]
            truth[i, j] = get_json(
                GBIF + "occurrence/search?" + urllib.parse.urlencode(q)
            )["count"]
    if truth.sum() == 0:
        raise SourceError(
            f"occurrence search finds no records of {taxon} around {lon}, {lat}"
        )
    return float(np.abs(ours - truth).sum() / truth.sum())


# ---- species records -------------------------------------------------------------------------------


def match_species(
    name: str, get_json: Callable[[str], dict] = fetch_json
) -> int | None:
    """GBIF backbone key for an exact species-rank match (a synonym resolves to its accepted name)."""
    d = get_json(
        f"{GBIF}species/match?"
        + urllib.parse.urlencode({"name": name, "strict": "true"})
    )
    if d.get("matchType") != "EXACT" or d.get("rank") != "SPECIES":
        return None
    return d.get("acceptedUsageKey") or d.get("usageKey")


def _search(params: list[tuple[str, str]], get_json) -> dict:
    return get_json(f"{GBIF}occurrence/search?" + urllib.parse.urlencode(params))


WINDOW = 10_000  # GBIF answers pages below this offset in ~2 s and deeper ones in minutes (2026-09-29)
READ_ALL = (
    3_000  # a species with at most this many records is read whole, then subsampled
)
DRAWS = 25  # leaf boxes visited per sample of a commoner species
MIN_BOX_DEG = 1.0  # stop splitting here; the within-box index order is then at most this far from random
# GBIF's map tiles are cached and take 4 at a time; its occurrence search answered 4 at a time with 429
# after 25 minutes (2026-09-30), and its limit follows server load, so search goes one at a time
TILE_WORKERS = 4
SEARCH_WORKERS = 1


def _box(lon0: float, lat0: float, lon1: float, lat1: float) -> list[tuple[str, str]]:
    return [
        ("decimalLongitude", f"{lon0},{lon1}"),
        ("decimalLatitude", f"{lat0},{lat1}"),
    ]


def occurrence_points(
    taxon_key: int,
    *,
    inat: bool,
    want: int,
    rng: np.random.Generator,
    get_json: Callable[[str], dict] = fetch_json,
) -> np.ndarray:
    """Up to `want` distinct lon/lat points for a species, a spatial random sample of its records.

    GBIF's index order groups records by dataset, so the first 10,000 are not a sample of the species
    (house sparrow: 56% of records in the US, none of the first 10,000), and deeper pages are too slow.
    A species with more records than `want` is sampled in DRAWS draws: from the whole world, split the box
    into quadrants and pick one in proportion to its record count (GBIF counts, cached), until the box holds
    at most WINDOW records or is MIN_BOX_DEG across; then take a page at a random offset in it. A species
    with at most READ_ALL records is read whole and subsampled.

    inat=False: CC0/CC BY records NOT from iNaturalist (GBIF cannot negate a dataset, so iNaturalist
    records are dropped here). inat=True: the species' iNaturalist records, any licence, locations only.
    """
    base = [
        ("taxonKey", str(taxon_key)),
        ("hasCoordinate", "true"),
        ("hasGeospatialIssue", "false"),
    ]
    if inat:
        base.append(("datasetKey", INAT_DATASET))
    else:
        base += [("license", lic) for lic in OPEN_LICENCES]
    counts: dict[tuple, int] = {}

    def count(box: tuple) -> int:
        return _search(base + _box(*box) + [("limit", "0")], get_json)["count"]

    def page(job: tuple) -> list[dict]:
        box, offset, limit = job
        return _search(
            base + _box(*box) + [("limit", str(limit)), ("offset", str(offset))],
            get_json,
        ).get("results", [])

    world = (-180.0, -90.0, 180.0, 90.0)
    total = count(world)
    with ThreadPoolExecutor(SEARCH_WORKERS) as pool:
        if total <= READ_ALL:
            jobs = [(world, offset, 300) for offset in range(0, total, 300)]
        else:
            counts[world] = total
            per_draw = -(-want // DRAWS)
            jobs = []
            for _ in range(DRAWS):
                box, n = world, total
                while n > WINDOW and box[2] - box[0] > MIN_BOX_DEG:
                    lon0, lat0, lon1, lat1 = box
                    lonm, latm = (lon0 + lon1) / 2, (lat0 + lat1) / 2
                    kids = [
                        (lon0, lat0, lonm, latm),
                        (lonm, lat0, lon1, latm),
                        (lon0, latm, lonm, lat1),
                        (lonm, latm, lon1, lat1),
                    ]
                    new = [k for k in kids if k not in counts]
                    counts.update(zip(new, pool.map(count, new)))
                    n_kids = np.array([counts[k] for k in kids], dtype=float)
                    if n_kids.sum() == 0:
                        break
                    i = int(rng.choice(4, p=n_kids / n_kids.sum()))
                    box, n = kids[i], int(n_kids[i])
                span = min(n, WINDOW) - per_draw
                jobs.append(
                    (box, int(rng.integers(0, span + 1)) if span > 0 else 0, per_draw)
                )
        pages = list(pool.map(page, jobs))
    seen: dict[int, tuple[float, float]] = {}
    for results in pages:
        for rec in results:
            if not inat and rec.get("datasetKey") == INAT_DATASET:
                continue
            if "decimalLongitude" in rec and "decimalLatitude" in rec:
                seen[rec["key"]] = (rec["decimalLongitude"], rec["decimalLatitude"])
    pts = np.array(list(seen.values()), dtype=float).reshape(-1, 2)
    if len(pts) > want:
        pts = pts[rng.choice(len(pts), want, replace=False)]
    return pts


# ---- iNaturalist ranges ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Range:
    taxon_id: int
    name: str
    version: str
    geom: object


def geometry_from_gpkg(blob: bytes):
    """A GeoPackage geometry blob (GP header + optional envelope + WKB) → shapely geometry in lon/lat."""
    if blob[:2] != b"GP":
        raise SourceError("not a GeoPackage geometry")
    flags = blob[3]
    order = "<" if flags & 1 else ">"
    srs = struct.unpack(order + "i", blob[4:8])[0]
    if srs != 4326:
        raise SourceError(f"range in SRS {srs}, expected 4326")
    envelope = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return shapely.from_wkb(blob[8 + envelope :])


def collection_files(collection: str, metadata: dict) -> list[str]:
    archives = metadata["collections"][collection]["archives"]
    if archives == 1:
        return [f"iNaturalist_geomodel_{collection}.gpkg"]
    return [
        f"iNaturalist_geomodel_{collection}_{i}.gpkg" for i in range(1, archives + 1)
    ]


def species_ranges(path: Path) -> Iterator[Range]:
    """Every species-rank range in one downloaded GeoPackage."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        (table,) = con.execute(
            "select table_name from gpkg_contents where data_type = 'features'"
        ).fetchone()
        rows = con.execute(
            f'select taxon_id, name, geomodel_version, geom from "{table}" where rank = ?',
            ("species",),  # nosec B608 - table name read from the file's own gpkg_contents, not from input
        )
        for taxon_id, name, version, geom in rows:
            yield Range(int(taxon_id), name, str(version), geometry_from_gpkg(geom))
    finally:
        con.close()


def _features_table(con: sqlite3.Connection) -> str:
    (table,) = con.execute(
        "select table_name from gpkg_contents where data_type = 'features'"
    ).fetchone()
    return table


def species_index(path: Path) -> list[tuple[int, str, str]]:
    """(taxon_id, name, version) of every species-rank range in a GeoPackage, without loading geometry."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        table = _features_table(con)
        return [
            (int(t), n, str(v))
            for t, n, v in con.execute(
                f'select taxon_id, name, geomodel_version from "{table}" where rank = ?',
                ("species",),  # nosec B608 - table name read from the file's own gpkg_contents, not from input
            )
        ]
    finally:
        con.close()


def range_geometry(path: Path, taxon_id: int):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        table = _features_table(con)
        row = con.execute(
            f'select geom from "{table}" where taxon_id = ?', (taxon_id,)
        ).fetchone()  # nosec B608 - table name read from the file's own gpkg_contents, not from input
    finally:
        con.close()
    if row is None:
        raise SourceError(f"taxon {taxon_id} not in {path.name}")
    return geometry_from_gpkg(row[0])


def download(url: str, dest: Path) -> Path:
    """Stream url to dest (via a .part file); an existing dest is reused."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=600
        ) as r,
        open(part, "wb") as fh,
    ):
        while chunk := r.read(1 << 20):
            fh.write(chunk)
    part.replace(dest)
    return dest


INAT_TILE = (
    "https://api.inaturalist.org/v2/geomodel/{taxon}/{z}/{x}/{y}.png?thresholded=true"
)


def thresholded_tile_mask(
    taxon_id: int, z: int, x: int, y: int, get: Callable[[str], bytes] = fetch
) -> np.ndarray:
    """Pixels of iNaturalist's thresholded geomodel tile that are drawn (alpha > 0). ≤ 1 request/s."""
    import io

    from PIL import Image

    data = get(INAT_TILE.format(taxon=taxon_id, z=z, x=x, y=y))
    time.sleep(1.0)
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    return np.asarray(img)[..., 3] > 0
