"""Known answers for qa-ifl.mjs, read straight from the pinned IFL GeoPackages with sqlite3 and shapely, not with
pipeline/ifl.py: each edition's patch count and stated area, and points whose class follows from the unsimplified
polygons. Usage: python3 scripts/qa_ifl_truth.py CACHE_DIR > truth.json

A class-k point (last intact in edition k) is the centre of the widest circle inside one edition-k patch minus every
later edition, from the patches that lost the most area to the next edition, one per region where it can be; class 5
points sit in 2025 patches of about 1,000 km². A never point is checked against every edition.
"""

import hashlib
import json
import signal
import sqlite3
import sys
from pathlib import Path

import shapely

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(1800)

YEARS = [2000, 2013, 2016, 2020, 2025]
SHA256 = {  # the files served 2026-10-04
    2000: "1f2252b94a17a716362d9dd9d6f24e44c0896a5ac18be68c8c61be2e2c38e03b",
    2013: "da4659b20a8aaf355f246ac18cc5d2ad70e68ea6dfc11d238888d0bb7f2f1e46",
    2016: "5d626e9907a472cb7ea6cd0b49c7b13c3c05b4c8f14842f9a1bc73c096b2f632",
    2020: "c455014f273cab737977758e842957e15613d3461bf44d77fe8b52c3d5ff8ace",
    2025: "0e043943d322558fd36150139fd918a9dae144439e51880037014876decec581",
}
NEVER = {
    "paris": (48.85, 2.35),
    "sahara": (23.5, 12.0),
    "mid-atlantic": (0.0, -30.0),
    "iowa": (42.0, -93.5),
}
PER_CLASS = 3
MIN_RADIUS = 0.01  # degrees: clears a level-7 pixel's half-diagonal (0.0039°) plus the 0.001° simplification


def blob_geometry(blob):
    """GeoPackage standard binary: magic GP, version, flags (bit 0 byte order, bits 1-3 envelope code), srs, envelope."""
    assert blob[:2] == b"GP", blob[:4]
    size = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(blob[3] >> 1) & 7]
    return shapely.from_wkb(bytes(blob[8 + size :]))


class Edition:
    def __init__(self, cache, year):
        path = Path(cache) / f"IFL_{year}.gpkg"
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        assert h.hexdigest() == SHA256[year], f"{path} is not the pinned file"
        self.year, self.con = year, sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.areas = dict(
            self.con.execute(f'select IFL_ID, "Area{year}" from "IFL_{year}"')  # nosec B608 - the year is one of the five in YEARS, whose files' sha256 were just checked; local read-only file
        )

    def patch(self, ifl_id):
        (blob,) = self.con.execute(
            f'select geom from "IFL_{self.year}" where IFL_ID = ?', (ifl_id,)  # nosec B608 - the year is one of the five in YEARS, whose files' sha256 were just checked; local read-only file
        ).fetchone()
        return blob_geometry(blob)

    def near(self, west, south, east, north):
        """Every patch whose index box meets the box."""
        y = self.year
        sql = (
            f'select t.geom from "IFL_{y}" t join "rtree_IFL_{y}_geom" r on r.id = t.fid '  # nosec B608 - the year is one of the five in YEARS, whose files' sha256 were just checked; local read-only file
            "where r.maxx >= ? and r.minx <= ? and r.maxy >= ? and r.miny <= ?"
        )
        return [
            blob_geometry(b)
            for (b,) in self.con.execute(sql, (west, east, south, north))
        ]

    def covers(self, lat, lon):
        p = shapely.Point(lon, lat)
        return any(g.covers(p) for g in self.near(lon, lat, lon, lat))


def point_in(region):
    # a difference can leave slivers of lower dimension beside the polygons: keep the polygons
    polys = [g for g in shapely.get_parts(region) if g.geom_type == "Polygon"]
    c = shapely.maximum_inscribed_circle(shapely.MultiPolygon(polys), 1e-4)
    x, y = c.coords[0]
    return round(y, 5), round(x, 5), round(c.length, 4)


def main(cache):
    eds = [Edition(cache, y) for y in YEARS]
    out = {"editions": [], "points": [], "never": []}
    for e in eds:
        out["editions"].append(
            {
                "year": e.year,
                "patches": len(e.areas),
                "areaHa": round(sum(e.areas.values())),
            }
        )
    for k, e in enumerate(eds, start=1):
        later = eds[k:]
        if later:
            nxt = later[0].areas
            ranked = sorted(e.areas, key=lambda i: -(e.areas[i] - nxt.get(i, 0)))
        else:
            ranked = sorted(e.areas, key=lambda i: abs(e.areas[i] - 100_000))
        found, regions = [], set()
        for ifl_id in ranked[:60]:
            if len(found) == PER_CLASS:
                break
            if ifl_id[:3] in regions:
                continue
            region = e.patch(ifl_id)
            for le in later:
                region = shapely.difference(
                    region, shapely.union_all(le.near(*region.bounds))
                )
            if region.is_empty:
                continue
            lat, lon, radius = point_in(region)
            if radius < MIN_RADIUS:
                continue
            # the point's class from every edition directly, not from the subtraction above
            last = max(
                (j for j, ed in enumerate(eds, start=1) if ed.covers(lat, lon)),
                default=0,
            )
            assert last == k, (ifl_id, k, last, lat, lon)
            found.append(
                {"class": k, "lat": lat, "lon": lon, "radius": radius, "id": ifl_id}
            )
            regions.add(ifl_id[:3])
        assert len(found) == PER_CLASS, (k, found)
        out["points"] += found
    for name, (lat, lon) in NEVER.items():
        assert not any(e.covers(lat, lon) for e in eds), name
        out["never"].append({"name": name, "lat": lat, "lon": lon})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])
