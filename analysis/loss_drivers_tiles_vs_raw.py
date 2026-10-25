"""Do GFW's drawn drivers tiles say what the raw v1.13 category GeoTIFFs say? For random points in four 10-degree
source tiles, the raw class at the point (read over HTTPS from the data API's signed download, GFW_API_KEY from the
environment, never printed) against the class decoded from the drawn tile pixel at levels 8 and 12, through the colour
table in src/data/lossDrivers.js. Writes docs/analysis/loss_drivers_tiles_vs_raw.md. Run: python analysis/loss_drivers_tiles_vs_raw.py
"""

import io
import math
import os
import random
import re
import signal
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(1500)
ROOT = Path(__file__).resolve().parents[1]
src = (ROOT / "src/data/lossDrivers.js").read_text()
TABLE = {
    tuple(int(v) for v in m.group(2).split(",")): int(m.group(1))
    for m in re.finditer(r"code: (\d), rgb: Object\.freeze\(\[([\d, ]+)\]\)", src)
}
assert len(TABLE) == 7, TABLE
TILE = "https://tiles.globalforestwatch.org/wri_google_tree_cover_loss_drivers/v1.13/dynamic/{z}/{x}/{y}.png?implementation=default&tree_cover_density_threshold=30"
RAW = "https://data-api.globalforestwatch.org/dataset/wri_google_tree_cover_loss_drivers/v1.13/download/geotiff?grid=10/40000&tile_id={t}&pixel_meaning=category"
UA = {
    "User-Agent": "wildeye/0.1 (loss drivers legend check; +https://github.com/musharna)"
}
KEY = os.environ["GFW_API_KEY"]
SOURCES = {
    "10N_060W": "Amazon",
    "00N_110E": "Borneo",
    "60N_120W": "Canada",
    "40N_010W": "Iberia",
}
PER = 40  # points with a raw driver per source tile, plus every no-driver point met on the way


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def signed(tile_id):
    # the key as a query parameter: the gateway rejects urllib's capitalised X-Api-Key header
    req = urllib.request.Request(
        RAW.format(t=tile_id) + "&x-api-key=" + KEY, headers=UA
    )
    try:
        urllib.request.build_opener(NoRedirect).open(req, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code == 307:
            return e.headers["Location"]
        raise
    raise RuntimeError(f"{tile_id}: expected a 307 to a signed URL")


_tiles = {}


def tile_rgba(z, x, y):
    if (z, x, y) not in _tiles:
        with urllib.request.urlopen(
            urllib.request.Request(TILE.format(z=z, x=x, y=y), headers=UA), timeout=90
        ) as r:
            _tiles[(z, x, y)] = np.asarray(
                Image.open(io.BytesIO(r.read())).convert("RGBA")
            )
        time.sleep(0.3)
    return _tiles[(z, x, y)]


def drawn(lat, lon, z):
    n = 2**z
    fx = (lon + 180) / 360 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    gx, gy = min(int(fx * 512), n * 512 - 1), min(int(fy * 512), n * 512 - 1)
    r, g, b, a = tile_rgba(z, gx // 512, gy // 512)[gy % 512, gx % 512].tolist()
    if (r, g, b) == (0, 0, 0):
        return 0
    return TABLE.get((r, g, b), f"?{r},{g},{b}")


random.seed(20261025)
rows = []
for tid, region in SOURCES.items():
    with rasterio.open(signed(tid)) as ds:
        arr = ds.read(1)
        tr = ds.transform
        found = 0
        tries = 0
        while found < PER and tries < 20000:
            tries += 1
            r, c = random.randrange(ds.height), random.randrange(ds.width)
            v = int(arr[r, c])
            if v not in range(1, 8) and random.random() > 0.05:
                continue  # keep ~5% of the no-driver cells as the negative arm
            # the cell's centre, so a point is never on a cell edge
            lon, lat = rasterio.transform.xy(tr, r, c)
            rows.append(
                {
                    "region": region,
                    "lat": round(lat, 5),
                    "lon": round(lon, 5),
                    "raw": v,
                    "z8": drawn(lat, lon, 8),
                    "z12": drawn(lat, lon, 12),
                }
            )
            found += v in range(1, 8)
    print(
        tid,
        region,
        "points",
        sum(1 for x in rows if x["region"] == region),
        file=sys.stderr,
    )

norm = lambda v: v if v in range(1, 8) else 0  # 0 and 255 (no data) both draw black


def score(level):
    ok = sum(1 for x in rows if x[level] == norm(x["raw"]))
    return ok, len(rows)


drivers = sorted({x["raw"] for x in rows if x["raw"] in range(1, 8)})
out = [
    "# Loss drivers: drawn tiles vs the raw v1.13 category GeoTIFFs",
    "",
    f"Written by `analysis/loss_drivers_tiles_vs_raw.py` on {time.strftime('%Y-%m-%d')}: {len(rows)} cell centres in "
    f"{', '.join(f'{t} ({r})' for t, r in SOURCES.items())}; raw classes seen: {drivers}.",
    "",
]
for level in ("z12", "z8"):
    ok, n = score(level)
    out.append(
        f"- level {level[1:]}: the drawn colour names the raw class at {ok} of {n} points"
    )
out += [
    "",
    "Every point is in `docs/analysis/loss_drivers_samples.tsv`; the table lists those where a level disagreed.",
    "",
    "| region | lat | lon | raw | level 12 | level 8 |",
    "|---|---|---|---|---|---|",
]
out += [
    f"| {x['region']} | {x['lat']} | {x['lon']} | {x['raw']} | {x['z12']} | {x['z8']} |"
    for x in rows
    if x["z12"] != norm(x["raw"]) or x["z8"] != norm(x["raw"])
]
(ROOT / "docs/analysis").mkdir(parents=True, exist_ok=True)
(ROOT / "docs/analysis/loss_drivers_tiles_vs_raw.md").write_text("\n".join(out) + "\n")
keys = ["region", "lat", "lon", "raw", "z12", "z8"]
(ROOT / "docs/analysis/loss_drivers_samples.tsv").write_text(
    "\n".join(["\t".join(keys)] + ["\t".join(str(x[k]) for k in keys) for x in rows])
    + "\n"
)
print("\n".join(out[:8]))
