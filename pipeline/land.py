"""Land, for the tracks pipeline: does a marine animal's straight step between two at-sea fixes cross land?

Natural Earth 10 m land 5.1.1 (public domain), downloaded once into the cache and refused unless it is the pinned
file. Spec: docs/superpowers/specs/2026-10-01-tracks-glide-design.md. A step with a fix on land (a seal hauled out)
is not a crossing: only at sea to at sea.
"""

from __future__ import annotations
import hashlib
import logging
import urllib.request
import zipfile
from pathlib import Path
from .net import urlopen

log = logging.getLogger("land")
LAND_ZIP_URL = "https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip"
# 3,269,070 bytes, ne_10m_land.VERSION.txt 5.1.1, Last-Modified 2022-05-13 (fetched 2026-10-01)
LAND_ZIP_SHA256 = "e547d749445eaa0964aba76738090ec88f5e63c4585122170f98c67a7ea922dc"
UA = "wildeye/0.1 (tracks land mask)"


def _download(url: str) -> bytes:
    with urlopen(
        urllib.request.Request(url, headers={"User-Agent": UA}), timeout=300
    ) as r:
        return r.read()


def fetch_land_zip(
    zip_path: Path, fetch_bytes=_download, sha256: str = LAND_ZIP_SHA256
) -> Path:
    """The pinned land zip at `zip_path`, downloaded once. A file whose hash differs, cached or fetched, is refused."""
    if zip_path.exists():
        got = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        if got != sha256:
            raise ValueError(
                f"{zip_path}: sha256 {got} is not the pinned {sha256}; delete it to fetch again"
            )
        return zip_path
    log.info("downloading %s", LAND_ZIP_URL)
    data = fetch_bytes(LAND_ZIP_URL)
    got = hashlib.sha256(data).hexdigest()
    if got != sha256:
        raise ValueError(
            f"{LAND_ZIP_URL}: sha256 {got} ({len(data)} bytes) is not the pinned {sha256}"
        )
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    zip_path.write_bytes(data)
    return zip_path


class Land:
    """Land polygons (lon/lat) with a spatial index."""

    def __init__(self, polygons):
        from shapely import STRtree

        self._polys = list(polygons)
        self._tree = STRtree(self._polys)

    def _hits(self, geom) -> bool:
        return any(self._polys[i].intersects(geom) for i in self._tree.query(geom))

    def crosses(self, a: dict, b: dict) -> bool:
        """True when fixes `a` and `b` ({lon, lat}) are both at sea and the straight step between them crosses land."""
        from shapely.geometry import LineString, Point

        if not self._polys:
            return False
        pa, pb = Point(a["lon"], a["lat"]), Point(b["lon"], b["lat"])
        if self._hits(pa) or self._hits(pb):
            return False
        return self._hits(LineString([pa, pb]))


def load_land(cache: Path) -> Land:
    """Natural Earth 10 m land from the cache (fetched once), one polygon per part."""
    import geopandas as gpd

    zip_path = fetch_land_zip(cache / "ne_10m_land.zip")
    with zipfile.ZipFile(zip_path) as z:
        if "ne_10m_land.shp" not in z.namelist():
            raise ValueError(f"{zip_path}: no ne_10m_land.shp in {z.namelist()}")
    geoms = gpd.read_file(f"zip://{zip_path}!ne_10m_land.shp").geometry.explode(
        index_parts=False
    )
    polys = [g for g in geoms if g is not None and not g.is_empty]
    if not polys:
        raise ValueError(f"{zip_path}: no land polygons")
    log.info("land: %d polygons from %s", len(polys), zip_path.name)
    return Land(polys)
