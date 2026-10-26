"""Does the soil-moisture drape say what the Copernicus Global Drought Observatory says? One dekad's drape, drawn by
pipeline.nc_series from JRC's yearly smang file exactly as rasters.json asks (every 5th 0.05-degree cell), checked two
ways. (1) Against the file itself: each drape cell's colour against the smang value at that cell, classed by GDO's
legend edges with explicit comparisons (not np.digitize, which the pipeline uses). (2) Against GDO's own map: its WMS
drawn at the native 0.05 degrees over three 20-degree boxes, its colours read back as classes. GDO's map server cannot
give the numbers (GetFeatureInfo answers with a PNG) and its drawn map resamples, so (2) is a sanity check on the
classes and the georeferencing, not an exact match. Writes docs/analysis/soil_moisture_vs_gdo_wms.md.
Run: python3 -m analysis.soil_moisture_vs_gdo_wms [path/to/smang_m_gdo_*.nc]  (downloads the ~600 MB file when absent)
"""

import collections
import io
import json
import signal
import sys
import urllib.request
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image

from pipeline import nc_series
from pipeline.net import urlopen

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(1500)
ROOT = Path(__file__).resolve().parents[1]
UA = {
    "User-Agent": "wildeye/0.1 (soil moisture legend check; +https://github.com/musharna)"
}
EDGES = [-2, -1.5, -1, 1, 1.5, 2]
# GDO's smang legend colours as its WMS draws them (read from its legend and map PNGs, 2026-10-25), driest first
WMS_RGB = [
    (179, 88, 6),
    (241, 163, 64),
    (254, 224, 182),
    (255, 255, 255),
    (209, 229, 240),
    (103, 169, 207),
    (33, 102, 172),
]
BOXES = [  # (name, south, west): 20-degree boxes, 400 x 400 cells at 0.05 degrees
    ("South America", -30, -70),
    ("Central Africa", 0, 10),
    ("Siberia", 40, 90),
]
WMS = (
    "https://drought.emergency.copernicus.eu/gis/mswms.png?map=gdo_w_mf&LAYERS=smang"
    "&ind_version=ca91ceac52de203d9b60be0704d3a9bd&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png"
    "&TRANSPARENT=true&STYLES=&CRS=EPSG:4326&BBOX={s},{w},{n},{e}&WIDTH=400&HEIGHT=400"
    "&TIME={date}&SELECTED_YEAR={y}&SELECTED_MONTH={m}&SELECTED_TENDAYS={d}"
)


def get(url, timeout=120):
    for attempt in range(3):
        try:
            with urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except OSError as e:
            if attempt == 2:
                raise
            sys.stderr.write(f"retrying {url}: {e}\n")


def classify(v):
    """GDO's legend class of each value, by explicit comparisons: code k for EDGES[k-1] <= v < EDGES[k]; -1 for NaN."""
    out = np.full(v.shape, -1, dtype=int)
    fin = np.isfinite(v)
    out[fin & (v < -2)] = 0
    out[fin & (v >= -2) & (v < -1.5)] = 1
    out[fin & (v >= -1.5) & (v < -1)] = 2
    out[fin & (v >= -1) & (v < 1)] = 3
    out[fin & (v >= 1) & (v < 1.5)] = 4
    out[fin & (v >= 1.5) & (v < 2)] = 5
    out[fin & (v >= 2)] = 6
    return out


def colour_class(rgb, alpha, palette, clear_rgb=None):
    """Class of each pixel by exact colour; -1 for clear (alpha 0 and not a hidden class colour), -2 for any other."""
    out = np.full(rgb.shape[:2], -2, dtype=int)
    for k, c in enumerate(palette):
        out[np.all(rgb == np.array(c), axis=-1)] = k
    if clear_rgb is None:
        out[alpha == 0] = -1
    else:
        out[(alpha == 0) & ~np.all(rgb == np.array(clear_rgb), axis=-1)] = -1
    return out


def edge_distance(v):
    return np.min(np.abs(v[..., None] - np.asarray(EDGES, dtype=float)), axis=-1)


product = next(
    p
    for p in json.loads((ROOT / "pipeline/rasters.json").read_text())
    if p["id"] == "soil-moisture"
)
path = Path(sys.argv[1]) if len(sys.argv) > 1 else nc_series.source_file(product)
c = product["nc_series"]
rgba, when, extras = nc_series.fetch_nc_series(product, file=path)
day = when[:10]
k_time = None
with xr.open_dataset(path) as ds:
    times = [nc_series._when(t) for t in ds["time"].values]
    k_time = times.index(when)
    field = ds[c["variable"]].isel(time=k_time).values  # (3000, 7200), north first

# (1) the drape against the file
palette = [tuple(cl["rgb"]) for cl in product["classes"]]
hidden = [tuple(cl["rgb"]) for cl in product["classes"] if cl.get("hidden")]
drape = colour_class(
    rgba[..., :3], rgba[..., 3], palette, clear_rgb=hidden[0] if hidden else None
)
o, s = int(c["offset"]), int(c["stride"])
want = classify(field[o::s, o::s])
assert want.shape == drape.shape, (want.shape, drape.shape)
agree1 = int((want == drape).sum())
n1 = want.size
odd = collections.Counter(
    (int(a), int(b)) for a, b in zip(want[want != drape], drape[want != drape])
)
drawn = collections.Counter(int(x) for x in want.ravel())

# (2) the drape's classes against GDO's own map, native cells
rows = []
for name, south, west in BOXES:
    png = get(
        WMS.format(
            s=south,
            w=west,
            n=south + 20,
            e=west + 20,
            date=day,
            y=day[:4],
            m=day[5:7],
            d=day[8:10],
        )
    )
    im = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))
    wms = colour_class(im[..., :3], im[..., 3], WMS_RGB)
    r0, c0 = round((90 - (south + 20)) / 0.05), round((west + 180) / 0.05)
    best = None
    for shift in (
        0,
        -1,
        1,
    ):  # a one-column shift between GDO's drawing and the file's cells, either way
        sub = field[r0 : r0 + 400, c0 + shift : c0 + shift + 400]
        ours = classify(sub)
        both = (ours >= 0) & (wms >= 0)
        agree = int((ours[both] == wms[both]).sum())
        row = {
            "box": name,
            "shift": shift,
            "both": int(both.sum()),
            "agree": agree,
            "off_by_one": int((np.abs(ours[both] - wms[both]) == 1).sum()),
            "drier": int((wms[both] < ours[both]).sum()),
            "wetter": int((wms[both] > ours[both]).sum()),
            "edge_mis": float(
                np.median(edge_distance(sub[both][ours[both] != wms[both]]))
            )
            if agree < both.sum()
            else 0.0,
            "edge_all": float(np.median(edge_distance(sub[both]))),
            "wms_other": int((wms == -2).sum()),
            "only_ours": int(((ours >= 0) & (wms == -1)).sum()),
            "only_wms": int(((ours == -1) & (wms >= 0)).sum()),
        }
        if shift == 0:
            rows.append(row)
        if best is None or row["agree"] / max(row["both"], 1) > best["agree"] / max(
            best["both"], 1
        ):
            best = row
    if best["shift"] != 0:
        rows.append(best)

labels = [cl["label"] for cl in product["classes"]]
# the reading below is printed only when the table bears it out: every box's mismatches nearer the legend edges than
# its cells are overall, and split between drier and wetter within a factor of 1.6
resampling = all(
    r["edge_mis"] < r["edge_all"]
    and max(r["drier"], r["wetter"]) <= 1.6 * max(min(r["drier"], r["wetter"]), 1)
    for r in rows
)
shifts = sorted({r["shift"] for r in rows if r["shift"] != 0})
reading = (
    [
        "Reading: the drape is the file, classed (section 1). GDO's drawn map is not a cell-for-cell copy of the file:",
        "in every box its mismatches sit nearer the legend edges than the cells do overall and fall drier and wetter",
        "about equally, which is what resampling looks like, not a wrong class, scale or sign."
        + (
            f" Its map lines up best against the file shifted {' and '.join(f'{x:+d}' for x in shifts)} column (0.05°, about 5 km, a fifth of a drape cell)."
            if shifts
            else ""
        ),
        "The agreement is reported as measured; it is not claimed to be exact.",
    ]
    if resampling
    else [
        "Reading: the mismatches do not look like resampling alone (see the edge-distance and drier/wetter columns);",
        "do not ship on this run.",
    ]
)
pct = lambda a, b: f"{100 * a / b:.1f}%" if b else "n/a"
lines = [
    "# Soil moisture drape vs the Copernicus Global Drought Observatory",
    "",
    f"Generated by `python3 -m analysis.soil_moisture_vs_gdo_wms` from `{path.name}`, dekad starting {day}.",
    "",
    "## 1. The drape against the file",
    "",
    f"Each of the {n1:,} drape cells (every {s}th 0.05° cell, from index {o}) read back from its colour, against the",
    "smang value at that cell classed by GDO's legend edges with explicit comparisons.",
    "",
    f"**{agree1:,} / {n1:,} agree ({pct(agree1, n1)}).**"
    + (f" Disagreements (file class, drape class): {dict(odd)}." if odd else ""),
    "",
    "| class | cells |",
    "|---|---:|",
    *[
        f"| {labels[k] if k >= 0 else 'no data'} | {drawn[k]:,} |"
        for k in sorted(drawn)
    ],
    "",
    "## 2. GDO's own map, native 0.05° cells",
    "",
    "GDO's WMS drawn at 400 × 400 pixels over each 20° box (one pixel per file cell), its colours read back as classes,",
    "against the file's cells classed as above. Shift is the file's column offset tried (0 = as georeferenced).",
    "Edge distance is the median |value − nearest legend edge| in σ: for the mismatched cells, and for all cells.",
    "",
    "| box | shift | cells in both | agree | ±1 class | GDO drier | GDO wetter | edge dist. mismatched | edge dist. all | other colours | only ours | only GDO |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    *[
        f"| {r['box']} | {r['shift']} | {r['both']:,} | {r['agree']:,} ({pct(r['agree'], r['both'])}) | "
        f"{r['off_by_one']:,} | {r['drier']:,} | {r['wetter']:,} | {r['edge_mis']:.3f} | {r['edge_all']:.3f} | "
        f"{r['wms_other']:,} | {r['only_ours']:,} | {r['only_wms']:,} |"
        for r in rows
    ],
    "",
    *reading,
    "",
]
out = ROOT / "docs/analysis/soil_moisture_vs_gdo_wms.md"
out.write_text("\n".join(lines))
print("\n".join(lines))
if agree1 != n1 or not resampling:
    sys.exit(1)
