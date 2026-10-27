"""Does the drawn 10 m land cover say what the source says? For seeded random points in 2017, 2021 and 2025, the class
decoded from the level-14 exportImage tile the layer draws (tile and URL computed here, apart from src/data/esriLulc.js;
only its palette is read from it, and that palette is checked against the service's live legend), against
(a) the service's getSamples at the point, and (b) for 2017 and 2021, Impact Observatory's CC BY 4.0 files on Microsoft
Planetary Computer (STAC collection io-lulc-annual-v02, which stops at 2023), read at the point with rasterio.
getSamples answers 400 for a point with no data and for a bad request alike, so a 400 counts as sea only where the drawn
tile is transparent. The layer asks for the service's default rendering (a JSON renderingRule cannot pass through
Cesium), so each tile is also fetched with the Cartographic Renderer the legend describes, and the two must be identical,
here and at zooms 1, 5, 9 and 14 over the named places. Writes docs/analysis/esri_lulc_drawn_vs_source.md and docs/analysis/esri_lulc_samples.tsv,
which scripts/qa-esri-lulc.mjs reads.
Run: python3 -B -m analysis.esri_lulc_drawn_vs_source
"""

import base64
import datetime
import io
import json
import math
import random
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import rasterio
from PIL import Image
from pyproj import Transformer

from pipeline.net import urlopen

signal.signal(
    signal.SIGALRM,
    lambda *_: (sys.stderr.write("aborting: walltime guard\n"), sys.exit(2)),
)
signal.alarm(2400)
ROOT = Path(__file__).resolve().parents[1]
SERVICE = "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer"
RENDERER = "Cartographic Renderer for Visualization and Analysis"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SAS = "https://planetarycomputer.microsoft.com/api/sas/v1/token/io-lulc-annual-v02"
SEED = 20261026
YEARS = (2017, 2021, 2025)
PC_YEARS = (2017, 2021)
LAND_PER_YEAR = 50
SEA_PER_YEAR = 10
Z = 14
R = 6378137.0
HALF = math.pi * R
NAMED = [
    ("Des Moines, Iowa (city)", 41.6, -93.6),
    ("Manaus, Brazil (city)", -3.1, -60.0),
    ("Amazon forest north of Manaus", -2.6, -60.2),
    ("Greenland ice sheet", 72.6, -38.5),
]

src = (ROOT / "src/data/esriLulc.js").read_text()
PALETTE = {
    tuple(int(v) for v in m.group(3).split(",")): (int(m.group(1)), m.group(2))
    for m in re.finditer(
        r'\{ value: (\d+), label: "([^"]+)", rgb: \[([\d, ]+)\] \}', src
    )
}
assert len(PALETTE) == 9, PALETTE
LABEL = {v: lab for v, lab in PALETTE.values()}


def get(url, timeout=90, tries=3):
    """The body of a GET (or of a Request); a network-level failure is retried, loudly, up to tries times in all.
    Two of four runs on 2026-10-26 died on "[Errno 101] Network is unreachable" from planetarycomputer.microsoft.com
    alone (it resolves over IPv4 and IPv6; the IPv4-only Esri host never failed). An HTTP error is not retried."""
    for attempt in range(1, tries + 1):
        try:
            with urlopen(url, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == tries:
                raise
            sys.stderr.write(
                f"retry {attempt}/{tries - 1} after {e!r}: {getattr(url, 'full_url', url)[:120]}\n"
            )
            time.sleep(5 * attempt)


def mid_year_ms(year):
    return int(datetime.datetime(year, 7, 1, tzinfo=datetime.UTC).timestamp() * 1000)


def legend_matches_palette():
    """The service's live legend for the renderer, colour per label, against the palette the layer decodes with."""
    rule = urllib.parse.quote(json.dumps({"rasterFunction": RENDERER}))
    d = json.loads(get(f"{SERVICE}/legend?renderingRule={rule}&f=json"))
    live = {}
    for e in d["layers"][0]["legend"]:
        im = Image.open(io.BytesIO(base64.b64decode(e["imageData"]))).convert("RGBA")
        live[e["label"]] = im.getpixel((im.width // 2, im.height // 2))[:3]
    ours = {lab: rgb for rgb, (_, lab) in PALETTE.items()}
    pairs = {
        "Water": "Water",
        "Trees": "Trees",
        "Flooded Vegetation": "Flooded vegetation",
        "Crops": "Crops",
        "Built Area": "Built area",
        "Bare Ground": "Bare ground",
        "Snow/Ice": "Snow or ice",
        "Clouds": "Clouds (no clear view that year)",
        "Rangeland": "Rangeland",
    }
    return {k: (live.get(k), ours.get(v)) for k, v in pairs.items()}, sorted(
        set(live) - set(pairs)
    )


def tile_and_pixel(lat, lon, z=Z):
    """Web-mercator tile and pixel at level z, by the mercator formulas (not gibsReadout.js)."""
    x = lon / 180 * HALF
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    size = 2 * HALF / 2**z
    tx, ty = int((x + HALF) // size), int((HALF - y) // size)
    w, n = -HALF + tx * size, HALF - ty * size
    px, py = int((x - w) / size * 256), int((n - y) / size * 256)
    return (w, n - size, w + size, n), px, py


def tile(box, year, renderer):
    """One 256-px exportImage of a web-mercator box: the service default (as the layer draws) or the named renderer."""
    rule = (
        "&renderingRule=" + urllib.parse.quote(json.dumps({"rasterFunction": RENDERER}))
        if renderer
        else ""
    )
    url = (
        f"{SERVICE}/exportImage?bbox={','.join(repr(v) for v in box)}&bboxSR=3857&imageSR=3857&size=256,256"
        f"&format=png32&time={mid_year_ms(year)}{rule}&f=image"
    )
    return Image.open(io.BytesIO(get(url))).convert("RGBA")


def drawn_class(lat, lon, year):
    """The class at the point in the default tile, and whether the renderer's tile is identical to it."""
    box, px, py = tile_and_pixel(lat, lon)
    im = tile(box, year, renderer=False)
    same = im.tobytes() == tile(box, year, renderer=True).tobytes()
    r, g, b, a = im.getpixel((px, py))
    if a == 0:
        return "none", same
    if a != 255 or (r, g, b) not in PALETTE:
        return f"unknown {r},{g},{b},{a}", same
    return PALETTE[(r, g, b)][0], same


def default_is_renderer(lat, lon, z, year):
    box, _, _ = tile_and_pixel(lat, lon, z)
    a, b = tile(box, year, False), tile(box, year, True)
    return a.tobytes() == b.tobytes(), len(set(a.getdata()))


def service_class(lat, lon, year):
    t = mid_year_ms(year)
    geom = urllib.parse.quote(
        json.dumps({"x": lon, "y": lat, "spatialReference": {"wkid": 4326}})
    )
    url = f"{SERVICE}/getSamples?geometry={geom}&geometryType=esriGeometryPoint&time={t}&returnFirstValueOnly=true&outFields=Year&f=json"
    d = json.loads(get(url))
    if "error" in d:
        return f"http {d['error'].get('code')}"
    s = d["samples"][0]
    if int(s["attributes"]["Year"]) != year:
        return f"year {s['attributes']['Year']}"
    return int(s["value"])


_token = None


def pc_class(lat, lon, year):
    global _token
    if _token is None:
        _token = json.loads(get(SAS))["token"]
    body = json.dumps(
        {
            "collections": ["io-lulc-annual-v02"],
            "intersects": {"type": "Point", "coordinates": [lon, lat]},
            "datetime": f"{year}-01-01T00:00:00Z/{year}-12-31T23:59:59Z",
            "limit": 5,
        }
    ).encode()
    req = urllib.request.Request(
        STAC, data=body, headers={"Content-Type": "application/json"}
    )
    feats = json.loads(get(req))["features"]
    if not feats:
        return "no file"
    # Files are cut by UTM zone and their footprints overlap at zone edges, where one zone's file is nodata over the
    # next zone's land: read every file that holds the point (Manaus, at 60°W, read nodata from the first alone).
    for f in feats:
        with rasterio.open(f["assets"]["data"]["href"] + "?" + _token) as ds:
            x, y = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True).transform(
                lon, lat
            )
            b = ds.bounds
            if not (b.left <= x < b.right and b.bottom < y <= b.top):
                continue
            v = int(next(ds.sample([(x, y)]))[0])
        if v:
            return v
    return "nodata"


def one(item):
    kind, lat, lon, year = item
    row = {"kind": kind, "lat": round(lat, 5), "lon": round(lon, 5), "year": year}
    row["drawn"], row["renderer_same"] = drawn_class(lat, lon, year)
    row["service"] = service_class(lat, lon, year)
    row["pc"] = pc_class(lat, lon, year) if year in PC_YEARS else "NA"
    return row


def main():
    legend, extra = legend_matches_palette()
    rng = random.Random(SEED)
    rows = []
    with ThreadPoolExecutor(4) as ex:
        for year in YEARS:
            land = sea = 0
            while land < LAND_PER_YEAR or sea < SEA_PER_YEAR:
                batch = [
                    (
                        "random",
                        math.degrees(
                            math.asin(
                                rng.uniform(
                                    math.sin(math.radians(-56)),
                                    math.sin(math.radians(75)),
                                )
                            )
                        ),
                        rng.uniform(-180, 180),
                        year,
                    )
                    for _ in range(16)
                ]
                for r in ex.map(one, batch):
                    is_land = isinstance(r["service"], int)
                    if is_land and land < LAND_PER_YEAR:
                        rows.append(r)
                        land += 1
                    elif not is_land and sea < SEA_PER_YEAR:
                        rows.append(r)
                        sea += 1
        named = list(
            ex.map(
                one, [("named", lat, lon, y) for _, lat, lon in NAMED for y in YEARS]
            )
        )
        zooms = [
            (name, z, y)
            for name, lat, lon in NAMED
            for z in (1, 5, 9, 14)
            for y in (2017, 2025)
        ]
        renderer = list(
            ex.map(
                lambda k: default_is_renderer(
                    *next((la, lo) for n, la, lo in NAMED if n == k[0]), k[1], k[2]
                ),
                zooms,
            )
        )
    for r, (name, *_rest) in zip(named, [n for n in NAMED for _ in YEARS]):
        r["name"] = name

    out = ROOT / "docs" / "analysis"
    cols = ["kind", "lat", "lon", "year", "drawn", "service", "pc", "renderer_same"]
    with open(out / "esri_lulc_samples.tsv", "w") as fh:
        fh.write("\t".join(cols) + "\n")
        for r in rows + named:
            fh.write("\t".join(str(r[c]) for c in cols) + "\n")

    land = [r for r in rows if isinstance(r["service"], int)]
    sea = [r for r in rows if not isinstance(r["service"], int)]
    agree = Counter((r["year"], r["drawn"] == r["service"]) for r in land)
    pc = [r for r in land if isinstance(r["pc"], int)]
    pc_agree = Counter((r["year"], r["drawn"] == r["pc"]) for r in pc)
    sea_ok = sum(r["drawn"] == "none" and r["service"] == "http 400" for r in sea)
    lab = lambda v: LABEL.get(v, v)
    disagree = [
        f"| {r['year']} | {r['lat']} | {r['lon']} | {lab(r['drawn'])} | {lab(r['service'])} | {lab(r['pc'])} |"
        for r in land
        if r["drawn"] != r["service"]
        or (isinstance(r["pc"], int) and r["drawn"] != r["pc"])
    ]
    lines = [
        "# 10 m land cover: drawn tile against the source",
        "",
        "Palette in src/data/esriLulc.js against the service's live legend (renderer \""
        + RENDERER
        + '"):',
        "",
        "| legend label | service colour | layer colour |",
        "|---|---|---|",
        *[f"| {k} | {a} | {b} |" for k, (a, b) in legend.items()],
        f"\nLegend entries not drawn as a class: {', '.join(extra) or 'none'}.",
        "",
        f"Seeded random points (seed {SEED}), uniform on the sphere between 56°S and 75°N, at level-{Z} tiles:",
        "",
        "| year | land points | drawn = getSamples | drawn = Planetary Computer file |",
        "|---|---|---|---|",
        *[
            f"| {y} | {sum(1 for r in land if r['year'] == y)} | {agree[(y, True)]} of {agree[(y, True)] + agree[(y, False)]} | "
            + (
                f"{pc_agree[(y, True)]} of {pc_agree[(y, True)] + pc_agree[(y, False)]}"
                if y in PC_YEARS
                else "not on Planetary Computer"
            )
            + " |"
            for y in YEARS
        ],
        "",
        f"Points getSamples answers with an error: {len(sea)}; of them drawn transparent with HTTP 400 (sea or no data): {sea_ok}.",
        "",
        (
            f"Sampled level-{Z} tiles where the default rendering (what the layer draws) is identical to the Cartographic"
            f" Renderer: {sum(r['renderer_same'] for r in rows + named)} of {len(rows + named)}. Over the named places:"
        ),
        "",
        "| place | zoom | year | identical | colours in the tile |",
        "|---|---|---|---|---|",
        *[
            f"| {n} | {z} | {y} | {'yes' if same else 'NO'} | {k} |"
            for (n, z, y), (same, k) in zip(zooms, renderer)
        ],
        "",
        "Disagreements (drawn vs getSamples or the file):",
        "",
        "| year | lat | lon | drawn | getSamples | file |",
        "|---|---|---|---|---|---|",
        *(disagree or ["| none | | | | | |"]),
        "",
        "Named places:",
        "",
        "| place | year | drawn | getSamples | file |",
        "|---|---|---|---|---|",
        *[
            f"| {r['name']} | {r['year']} | {lab(r['drawn'])} | {lab(r['service'])} | {lab(r['pc'])} |"
            for r in named
        ],
        "",
    ]
    (out / "esri_lulc_drawn_vs_source.md").write_text("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
