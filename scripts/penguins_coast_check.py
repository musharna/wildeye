"""Premise check for the penguin colonies layer: do the drawn colonies sit on the coast?

Usage: python3 -B scripts/penguins_coast_check.py [public/data/penguins.json] → a table on stdout; exit 1 if the
premise fails (spec docs/superpowers/specs/2026-10-07-penguins-design.md, "Premise check").

For every drawn point: the distance to the Natural Earth 10 m land boundary (the file pipeline/land.py pins), in
Antarctic polar stereographic metres (EPSG:3031; scale error under 4% between 60 and 78°S), unshifted and shifted 0.5°
in longitude and latitude in each of four diagonal directions. Passes when every non-emperor species with at least
MIN_N points has at least MIN_SHARE of them within KM and at least RATIO times the share of every shifted control.
Emperors breed on sea ice, often away from the mapped coast, so they are reported and not judged.
"""

import json
import os
import signal
import sys
from pathlib import Path

import numpy as np
import pyogrio
import shapely
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline.land import fetch_land_zip  # noqa: E402

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(300)

KM, MIN_SHARE, RATIO, MIN_N = 5.0, 0.6, 3.0, 20
SHIFTS = [(0.0, 0.0), (0.5, 0.5), (-0.5, 0.5), (0.5, -0.5), (-0.5, -0.5)]
EXEMPT = {"EMPE"}


def main(path: Path) -> int:
    points = json.loads(path.read_text())["points"]
    cache = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))
    land = fetch_land_zip(cache / "ne_10m_land.zip")
    _, _, wkb, _ = pyogrio.raw.read(
        f"/vsizip/{land}/ne_10m_land.shp", bbox=(-180, -90, 180, -45)
    )
    to_ps = Transformer.from_crs(4326, 3031, always_xy=True)

    def project(g):
        return shapely.transform(
            g, lambda xy: np.column_stack(to_ps.transform(xy[:, 0], xy[:, 1]))
        )

    rings = []
    for g in shapely.from_wkb(wkb):
        for part in shapely.get_parts(shapely.clip_by_rect(g, -180, -89.99, 180, -45)):
            if not part.is_empty:
                rings.append(project(shapely.boundary(part)))
    tree = shapely.STRtree(rings)
    species = sorted({p["species"] for p in points})
    table = {}
    for dlon, dlat in SHIFTS:
        lon = np.array([((p["lon"] + dlon + 180) % 360) - 180 for p in points])
        lat = np.array([p["lat"] + dlat for p in points])
        pts = shapely.points(*to_ps.transform(lon, lat))
        idx = tree.nearest(pts)
        km = shapely.distance(pts, np.array(rings, dtype=object)[idx]) / 1000
        for sp in species:
            sel = np.array([p["species"] == sp for p in points])
            table[(sp, dlon, dlat)] = (
                float(np.mean(km[sel] <= KM)),
                float(np.median(km[sel])),
                int(sel.sum()),
            )
    ok = True
    print(f"share of points within {KM:g} km of the NE 10 m land boundary (median km)")
    print(
        "species   n  "
        + "  ".join(f"{dlon:+.1f},{dlat:+.1f}".rjust(14) for dlon, dlat in SHIFTS)
        + "  verdict"
    )
    for sp in species:
        base, _, n = table[(sp, 0.0, 0.0)]
        shifted = [table[(sp, a, b)][0] for a, b in SHIFTS[1:]]
        if sp in EXEMPT:
            verdict = "reported (breeds on sea ice)"
        elif n < MIN_N:
            verdict = f"reported (n < {MIN_N})"
        elif base >= MIN_SHARE and all(base >= RATIO * s for s in shifted):
            verdict = "pass"
        else:
            verdict = "FAIL"
            ok = False
        cells = "  ".join(
            f"{table[(sp, a, b)][0]:.3f} ({table[(sp, a, b)][1]:5.1f})".rjust(14)
            for a, b in SHIFTS
        )
        print(f"{sp:6} {n:4}  {cells}  {verdict}")
    print("premise holds" if ok else "PREMISE FAILS")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(
        main(Path(sys.argv[1] if len(sys.argv) > 1 else "public/data/penguins.json"))
    )
