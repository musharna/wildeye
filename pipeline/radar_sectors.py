"""How much of each radar's vol2bird ring (5-35 km) lies over the sea, and its widest all-land sector.

Rays every 1 deg of azimuth, sampled every 1 km from 5 to 35 km on the WGS84 ellipsoid, against Natural Earth
10 m land (pipeline/land.py). The sea share weights each sample by its range, as the ring's area does. The land
sector is the widest run of azimuths at least LAND_MIN land that does not cross north: vol2bird 0.5 takes
AZIMMIN <= AZIMMAX only (AZIMMIN 300 / AZIMMAX 60 returns no gates, checked on a KOKX volume 2026-10-17)."""
from __future__ import annotations
import argparse
import json
from pathlib import Path

RANGES_KM = range(5, 36)
LAND_MIN = 0.9

def ray_land(land, lon: float, lat: float) -> list[float]:
    """Range-weighted land share of each 1-deg ray (azimuth a covers a..a+1, sampled at a+0.5)."""
    from pyproj import Geod
    from shapely.geometry import Point
    g = Geod(ellps="WGS84")
    out = []
    for a in range(360):
        hits = wsum = 0.0
        for r in RANGES_KM:
            x, y, _ = g.fwd(lon, lat, a + 0.5, r * 1000)
            hits += r * land._hits(Point(x, y))
            wsum += r
        out.append(hits / wsum)
    return out

def widest_sector(share: list[float], land_min: float = LAND_MIN) -> tuple[int, int] | None:
    """(AZIMMIN, AZIMMAX) of the widest run of rays with share >= land_min, not crossing north; None if none."""
    best, start = None, None
    for a, s in enumerate(share + [-1.0]):
        if s >= land_min and start is None:
            start = a
        elif s < land_min and start is not None:
            if best is None or a - start > best[1] - best[0]:
                best = (start, a)
            start = None
    return best

def main(argv=None):
    from .land import load_land
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "wildeye")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    land = load_land(a.cache)
    rows = {}
    for s in json.loads((Path(__file__).parent / "sites.json").read_text()):
        share = ray_land(land, s["lon"], s["lat"])
        sector = widest_sector(share)
        rows[s["id"]] = {"sea_share": 1 - sum(share) / 360, "sector": sector,
                         "sector_deg": sector[1] - sector[0] if sector else 0}
        print(s["id"], f"sea {rows[s['id']]['sea_share']:.2f}", "sector", sector)
    a.out.write_text(json.dumps(rows, indent=1) + "\n")

if __name__ == "__main__":
    main()
