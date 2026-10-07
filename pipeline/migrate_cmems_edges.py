"""One-off: redraw archived Copernicus 0.25° drape frames with cell-edge bounds (edge_align, 2026-10-07).

Frames archived before the fix were drawn with the grid's centre range as image edges (1440×681). archive_frame never
rewrites an archived frame, and the time bar draws every frame with the product's current bounds, so old frames must
be redrawn the same way the pipeline now draws new ones. A frame already redrawn (2880×680) is left alone; any other
size stops the run.

Usage: python -m pipeline.migrate_cmems_edges <data dir holding rasters/>   (then rerun pipeline.raster for these ids)
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

from .raster import edge_align

IDS = ("cmems-o2", "cmems-ph", "cmems-zooc")
# The grid all three products share (copernicusmarine 2.4.1, 2026-10-07): centres lat -80..90, lon -180..179.75.
LAT_NORTH_FIRST = np.arange(90.0, -80.0 - 1e-9, -0.25)
LON = np.arange(-180.0, 180.0 - 1e-9, 0.25)
OLD_SHAPE = (len(LAT_NORTH_FIRST), len(LON))  # 681, 1440
NEW_SHAPE = (680, 2880)


def migrate_png(path: Path) -> bool:
    """Redraw one frame in place; True if it changed, False if it was already redrawn."""
    with Image.open(path) as im:
        rgba = np.asarray(im.convert("RGBA"))
    if rgba.shape[:2] == NEW_SHAPE:
        return False
    if rgba.shape[:2] != OLD_SHAPE:
        raise ValueError(
            f"{path}: {rgba.shape[1]}×{rgba.shape[0]} is neither the old nor the new Copernicus frame"
        )
    out, _ = edge_align(rgba, LAT_NORTH_FIRST, LON)
    tmp = path.with_suffix(".tmp.png")
    Image.fromarray(np.ascontiguousarray(out), "RGBA").save(tmp, optimize=True)
    tmp.replace(path)
    return True


def main(data_dir: Path) -> None:
    changed = kept = 0
    for pid in IDS:
        frames = sorted((data_dir / "rasters" / pid).glob("*.png")) + [
            data_dir / "rasters" / f"{pid}.png"
        ]
        for f in frames:
            if f.exists():
                if migrate_png(f):
                    changed += 1
                else:
                    kept += 1
    print(f"redrawn {changed}, already redrawn {kept}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
