"""Known answers for scripts/qa-hotspots.mjs, read from the pinned Zenodo zip without pipeline/hotspots.py.

Usage: python3 -B scripts/qa_hotspots_truth.py <path to hotspots_2016_1.zip>  → JSON on stdout.

A different route from the pipeline's: the shapefile is read by GDAL (pyogrio) rather than pyshp, rings are closed and
repaired by shapely's WKB reader (`on_invalid="fix"`, one Polynesia-Micronesia ring is 9e-8° short of closed) and
make_valid, and areas are geodesic on the WGS 84 ellipsoid (pyproj.Geod) rather than on a sphere.

Points (spec 2026-10-07-hotspots-design.md, Acceptance):
- named places, fixed before any answer was read (two then moved off a coastline they sat within 0.002° of, where
  no simplified map can be held to the raw answer: Chatham Islands dropped, the Sibuyan Sea point moved): hotspot interiors, sea between the islands of hotspots that have an
  outer limit, places in no hotspot, and both sides of the antimeridian;
- 40 points near hotspot edges, 20 just inside and 20 just outside, drawn with a fixed seed from the edges of every
  hotspot-area part of 0.05 deg² or more, each 0.04–0.10° from its nearest raw boundary of any kind. That is at least
  twice the display simplification (0.02° plus the 0.001° grid), so the published shapes must agree with the raw ones
  there; a point closer than that is not a known answer for a simplified map.
- 6 more such edge points with |longitude| > 175°.
For each point: the hotspot areas and the outer limits that contain it on the raw shapes.
"""

import json
import random
import sys

import pyogrio
import pyproj
import shapely

MEMBER = "hotspots_2016_1.shp"
NAMED = {
    # hotspot interiors
    "borneo": (0.5, 114.0),
    "madagascar": (-19.0, 46.7),
    "cusco": (-13.5, -72.0),
    "sierra-nevada-ca": (37.5, -120.0),
    "nepal": (28.0, 85.0),
    "honshu": (36.5, 138.5),
    "south-island-nz": (-43.5, 171.0),
    "viti-levu": (-17.8, 178.0),
    "cape-peninsula": (-34.0, 18.5),
    "serra-do-mar": (-22.5, -44.0),
    # sea between a hotspot's islands
    "banda-sea": (-5.5, 127.0),
    "caribbean-sea": (15.0, -75.0),
    "sibuyan-sea": (12.8, 122.8),
    "ionian-sea": (35.0, 18.0),
    "koro-sea": (-17.5, 179.5),
    "fiji-east-of-180": (-17.0, -179.5),
    # in no hotspot
    "kansas": (38.0, -98.0),
    "sahara": (23.0, 13.0),
    "amazon": (-3.0, -60.0),
    "siberia": (60.0, 100.0),
    "central-australia": (-25.0, 135.0),
    "mid-atlantic": (30.0, -40.0),
}
SEED = 20261007
GAP = (0.04, 0.10)
MIN_PART = 0.05  # deg²


def load(zip_path):
    df = pyogrio.read_dataframe(f"/vsizip/{zip_path}/{MEMBER}", on_invalid="fix")
    rows = []
    for name, kind, g in zip(df["NAME"], df["Type"], df.geometry.values):
        rows.append((name, kind, shapely.make_valid(g)))
    return rows


def main(zip_path):
    rows = load(zip_path)
    areas = {n: g for n, k, g in rows if k == "hotspot area"}
    outers = {n: g for n, k, g in rows if k == "outer limit"}
    assert len(areas) == 36 and len(outers) == 17, (len(areas), len(outers))
    geod = pyproj.Geod(ellps="WGS84")
    area_km2 = {
        n: abs(geod.geometry_area_perimeter(g)[0]) / 1e6 for n, g in areas.items()
    }
    edges = shapely.union_all([g.boundary for g in (*areas.values(), *outers.values())])
    shapely.prepare(edges)
    for g in (*areas.values(), *outers.values()):
        shapely.prepare(g)

    def answer(name, kind, lat, lon):
        p = shapely.Point(lon, lat)
        return {
            "name": name,
            "kind": kind,
            "lat": lat,
            "lon": lon,
            "areas": sorted(n for n, g in areas.items() if g.covers(p)),
            "outer": sorted(n for n, g in outers.items() if g.covers(p)),
            "edge_distance_deg": round(edges.distance(p), 4),
        }

    points = [answer(k, "named", lat, lon) for k, (lat, lon) in NAMED.items()]

    rng = random.Random(SEED)
    parts = [
        (n, p)
        for n, g in sorted(areas.items())
        for p in getattr(g, "geoms", [g])
        if p.geom_type == "Polygon" and p.area >= MIN_PART
    ]

    def edge_point(part, want_inside, lon_band=None):
        for _ in range(20000):
            n, poly = rng.choice(part)
            b = poly.exterior.interpolate(rng.random(), normalized=True)
            d = rng.uniform(*GAP)
            dx, dy = rng.uniform(-1, 1), rng.uniform(-1, 1)
            norm = (dx * dx + dy * dy) ** 0.5 or 1
            lon, lat = b.x + d * dx / norm, b.y + d * dy / norm
            if not -180 <= lon < 180 or (lon_band and abs(lon) <= lon_band):
                continue
            p = shapely.Point(lon, lat)
            gap = edges.distance(p)
            if not GAP[0] <= gap <= GAP[1]:
                continue
            inside = any(g.covers(p) for g in areas.values())
            if inside == want_inside:
                return round(lat, 4), round(lon, 4)
        raise SystemExit("no edge point found")

    for i in range(20):
        lat, lon = edge_point(parts, True)
        points.append(answer(f"edge-in-{i}", "edge", lat, lon))
        lat, lon = edge_point(parts, False)
        points.append(answer(f"edge-out-{i}", "edge", lat, lon))
    far = [(n, p) for n, p in parts if p.bounds[0] < -175 or p.bounds[2] > 175]
    for i in range(3):
        lat, lon = edge_point(far, True, lon_band=175)
        points.append(answer(f"antimeridian-in-{i}", "edge", lat, lon))
        lat, lon = edge_point(far, False, lon_band=175)
        points.append(answer(f"antimeridian-out-{i}", "edge", lat, lon))
    for pt in points:
        # recomputed after rounding: the stored point is the one checked
        pt.update(answer(pt["name"], pt["kind"], pt["lat"], pt["lon"]))
        # every point, named or not, is far enough from a raw edge to be a known answer for the simplified map
        assert GAP[0] - 0.001 <= pt["edge_distance_deg"], pt
    json.dump(
        {
            "source": "zenodo 3261807 hotspots_2016_1.zip",
            "area_km2": {n: round(v) for n, v in sorted(area_km2.items())},
            "points": points,
        },
        sys.stdout,
        indent=1,
    )


if __name__ == "__main__":
    main(sys.argv[1])
