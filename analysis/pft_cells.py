"""Independent route for the cmems-pft drape: the dominant group of chosen 0.25° cells, read from the raw 4 km data with
xarray label selection (not pipeline/cmems_pft.py), against the class colour the pipeline drew in the PNG.

For each cell: select the 4 km pixels whose centres fall inside the cell by latitude/longitude, keep the pixels where
all five groups are present, average each group, take the largest (a tie goes to the first listed). The PNG pixel
is located from the cell's corner (row = (90 - north) / 0.25, column = (west + 180) / 0.25) and its colour is mapped
back to a class through pipeline/rasters.json. Output: docs/analysis/pft_cells.md; exit 1 when any cell disagrees.

Run: set -a; . ~/.config/wildeye/env; set +a; python3 -m analysis.pft_cells --png public/data/rasters/cmems-pft.png
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATASET = "cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M"
# (name, south-west corner lat, lon). Regions chosen before looking at the drape; the last two (haptophytes, green
# algae) were picked from the drawn map so every drawn group is checked at least once.
CELLS = [
    ("Southern Ocean, south of Africa", -45.0, 20.0),
    ("South Pacific subtropical gyre", -25.0, -120.0),
    ("North Atlantic subtropical gyre", 25.0, -50.0),
    ("Benguela upwelling, Namibia", -23.0, 14.0),
    ("Peru upwelling", -15.0, -76.0),
    ("Arabian Sea", 15.0, 62.0),
    ("Norwegian Sea (high-latitude summer)", 68.0, 5.0),
    ("Bering Sea shelf", 58.0, -170.0),
    ("Weddell Sea (sea ice, polar night)", -72.0, -40.0),
    ("Alps (land)", 46.0, 10.0),
]
EXTRA = ["HAPTO", "GREEN"]


def main(argv=None) -> int:
    signal.signal(
        signal.SIGALRM,
        lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
    )
    signal.alarm(900)
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--png", type=Path, default=ROOT / "public/data/rasters/cmems-pft.png"
    )
    ap.add_argument("--out", type=Path, default=ROOT / "docs/analysis/pft_cells.md")
    ap.add_argument(
        "--json",
        type=Path,
        default=None,
        help="also write the rows as JSON (for the browser QA)",
    )
    args = ap.parse_args(argv)

    product = next(
        p
        for p in json.loads((ROOT / "pipeline/rasters.json").read_text())
        if p["id"] == "cmems-pft"
    )
    groups = [c["variable"] for c in product["classes"]]
    label = {c["variable"]: c["label"] for c in product["classes"]}
    by_rgb = {tuple(c["rgb"]): c["variable"] for c in product["classes"]}
    img = np.asarray(Image.open(args.png).convert("RGBA"))

    import copernicusmarine as cm
    import xarray as xr

    ds = cm.open_dataset(
        dataset_id=DATASET,
        username=os.environ["CMEMS_USER"],
        password=os.environ["CMEMS_PASS"],
        variables=groups,
    )
    ds = ds.isel(time=-1)
    month = str(ds["time"].values)[:7]

    def drawn(lat, lon):
        r, c = int(round((90 - (lat + 0.25)) / 0.25)), int(round((lon + 180) / 0.25))
        px = img[r, c]
        return (
            "clear"
            if px[3] == 0
            else by_rgb.get(tuple(int(v) for v in px[:3]), f"unknown {tuple(px)}")
        )

    def raw(lat, lon):
        sub = ds.sel(
            latitude=slice(lat, lat + 0.25), longitude=slice(lon, lon + 0.25)
        ).load()
        arr = xr.concat([sub[g] for g in groups], dim="group")
        full = arr.notnull().all("group")
        n = int(full.sum())
        if n == 0:
            return "clear", 0, {}
        means = {g: float(sub[g].where(full).mean()) for g in groups}
        return max(groups, key=lambda g: (means[g], -groups.index(g))), n, means

    cells = list(CELLS)
    for want in EXTRA:  # one drawn cell of each extra group, from a fixed scan order (north to south, west to east)
        hit = np.argwhere(
            np.all(
                img[..., :3]
                == next(c["rgb"] for c in product["classes"] if c["variable"] == want),
                axis=-1,
            )
            & (img[..., 3] == 255)
        )
        r, c = hit[len(hit) // 2]
        cells.append(
            (
                f"drawn {label[want]} (picked from the map)",
                90 - (r + 1) * 0.25,
                c * 0.25 - 180,
            )
        )

    rows, bad = [], 0
    for name, lat, lon in cells:
        g, n, means = raw(lat, lon)
        d = drawn(lat, lon)
        ok = g == d
        bad += not ok
        rows.append(
            {
                "name": name,
                "lat": lat + 0.125,
                "lon": lon + 0.125,
                "raw": g,
                "png": d,
                "pixels": n,
                "means": means,
                "ok": ok,
            }
        )
    lines = [
        f"# cmems-pft: raw 4 km vs drawn class ({month})",
        "",
        "| cell | centre | 4 km pixels | raw group | drawn | agree |",
        "|---|---|---:|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['name']} | {r['lat']:.3f}, {r['lon']:.3f} | {r['pixels']} | {r['raw']} | {r['png']} | {'yes' if r['ok'] else 'NO'} |"
        )
    lines += ["", f"{len(rows) - bad} of {len(rows)} agree."]
    args.out.write_text("\n".join(lines) + "\n")
    if args.json:
        args.json.write_text(json.dumps({"month": month, "rows": rows}, indent=1))
    print("\n".join(lines))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
