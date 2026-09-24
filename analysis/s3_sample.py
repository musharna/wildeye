"""Sample the S3 pilot's points (docs/analysis/s3-heat-greenness-prereg.md).

Every land-cover pixel centre (level 8) in each pre-named 1°x1° box, with the EVI (level 9) and LST
(level 7) pixels containing it, decoded exactly with the live site's own tables (its data/gibs.json).
Tiles are fetched once into analysis/.cache/, politely (1 s between network fetches), and every tile's
GIBS layer-time-actual header must equal the requested date or the run stops.

Run: python3 -m analysis.s3_sample [--site https://musharna.github.io/wildeye/] [--out analysis/out]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import re
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

from analysis import s3_lib as s

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
UA = "wildeye-s3-pilot (github.com/musharna/wildeye)"
REGIONS = {  # pre-registered 2026-09-24 (prereg doc), 1° boxes centred here
    "Chicago": (41.88, -87.63),
    "Delhi": (28.61, 77.21),
    "Cairo": (30.05, 31.24),
    "Manaus": (-3.10, -60.02),
    "Paris": (48.86, 2.35),
    "Beijing": (39.90, 116.40),
    "Kano": (12.00, 8.52),
    "Córdoba": (-31.42, -64.18),
}
# harness control points (qa-readout known points): Sahara barren must read hotter than Amazon forest
CONTROL = {"sahara": (23.0, 12.0), "forest": (-5.0, -65.0)}
LAYERS = {"lc": "gibs-landcover", "evi": "gibs-evi", "lst": "gibs-lst"}


def latest_date(times: list[str]) -> str:
    """The latest date GIBS serves, by the site's rule (src/data/gibsTime.js latestDate): the last step
    from each interval's start that is still <= its end, latest across intervals."""
    best = None
    for interval in times:
        start, end, period = interval.split("/")
        m = re.fullmatch(r"P(\d+)([DY])", period)
        if not m:
            raise ValueError(f"unsupported GIBS period {period!r} in {interval!r}")
        n, unit = int(m.group(1)), m.group(2)
        d, stop = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
        last = d
        while d <= stop:
            last = d
            d = d + dt.timedelta(days=n) if unit == "D" else d.replace(year=d.year + n)
        best = last if best is None or last > best else best
    return best.isoformat()


def get(url: str, tries: int = 4) -> tuple[bytes, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for k in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read(), {h.lower(): v for h, v in r.headers.items()}
        except Exception as e:  # noqa: BLE001 — retried, then re-raised with the URL
            if k == tries - 1:
                raise RuntimeError(f"GET {url} failed after {tries} tries: {e}") from e
            time.sleep(2 ** (k + 1))
    raise AssertionError("unreachable")


class Tiles:
    """Raw GIBS tiles for one layer and date, cached on disk; header date checked on every fetch."""

    def __init__(self, entry: dict, date: str, cache: Path):
        self.entry, self.date = entry, date
        self.dir = cache / entry["gibsId"] / date
        self.mem: dict[tuple, Image.Image] = {}

    def pixel(self, lat: float, lon: float):
        z = self.entry["maximumLevel"]
        t = s.tile_pixel(lat, lon, z)
        if t is None:
            return None
        x, y, px, py = t
        img = self.mem.get((x, y)) or self._load(z, x, y)
        self.mem[(x, y)] = img
        return img.getpixel((px, py))

    def _load(self, z: int, x: int, y: int) -> Image.Image:
        path = self.dir / f"{z}/{y}/{x}.png"
        if not path.exists():
            url = f"{GIBS}/{self.entry['gibsId']}/default/{self.date}/{self.entry['tileMatrixSet']}/{z}/{y}/{x}.{self.entry['format']}"
            body, headers = get(url)
            actual = headers.get("layer-time-actual", "")[:10]
            if actual != self.date:
                raise RuntimeError(
                    f"{url}: layer-time-actual {actual!r} is not the requested {self.date}"
                )
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            time.sleep(1.0)
        return Image.open(io.BytesIO(path.read_bytes())).convert("RGBA")


def lc_pixels_in_box(lat0: float, lon0: float, z: int):
    """Centres of every level-z pixel whose centre lies in the 1° box around (lat0, lon0)."""
    la, lb, oa, ob = lat0 - 0.5, lat0 + 0.5, lon0 - 0.5, lon0 + 0.5
    x0, y0 = s.tile_pixel(lb, oa, z)[:2]
    x1, y1 = s.tile_pixel(la, ob, z)[:2]
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            for py in range(s.TILE):
                for px in range(s.TILE):
                    lat, lon = s.pixel_centre(z, x, y, px, py)
                    if la <= lat < lb and oa <= lon < ob:
                        yield lat, lon


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://musharna.github.io/wildeye/")
    ap.add_argument("--out", type=Path, default=Path("analysis/out"))
    ap.add_argument("--cache", type=Path, default=Path("analysis/.cache"))
    a = ap.parse_args(argv)
    manifest = json.loads(
        get(f"{a.site.rstrip('/')}/data/gibs.json?t={int(time.time())}")[0]
    )["layers"]
    entries = {k: manifest[v] for k, v in LAYERS.items()}
    dates = {k: latest_date(e["times"]) for k, e in entries.items()}
    dec = {k: s.Decoder(e) for k, e in entries.items()}
    tiles = {k: Tiles(e, dates[k], a.cache) for k, e in entries.items()}
    print(json.dumps({"dates": dates}), flush=True)

    def read(k, lat, lon):
        v = dec[k](tiles[k].pixel(lat, lon))
        return v

    control = {}
    for name, (lat, lon) in CONTROL.items():
        control[name] = {"lc": read("lc", lat, lon), "lst": read("lst", lat, lon)}
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "meta.json").write_text(
        json.dumps({"site": a.site, "dates": dates, "control": control}, indent=1)
    )

    counts = {}
    with open(a.out / "points.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "region",
                "lat",
                "lon",
                "lc",
                "evi_lo",
                "evi_hi",
                "evi_wide",
                "lst_lo",
                "lst_hi",
                "lst_wide",
                "lst_nodata",
            ]
        )
        for region, (lat0, lon0) in REGIONS.items():
            n = 0
            for lat, lon in lc_pixels_in_box(lat0, lon0, entries["lc"]["maximumLevel"]):
                lc = read("lc", lat, lon)
                if lc[0] != "class":
                    continue
                evi = read("evi", lat, lon)
                lst = read("lst", lat, lon)
                e_lo, e_hi = (evi[1], evi[2]) if evi[0] == "value" else (None, None)
                t_lo, t_hi = (lst[1], lst[2]) if lst[0] == "value" else (None, None)
                w.writerow(
                    [
                        region,
                        f"{lat:.5f}",
                        f"{lon:.5f}",
                        lc[1],
                        e_lo,
                        e_hi,
                        int(evi[0] == "value" and dec["evi"].is_wide(e_lo, e_hi)),
                        t_lo,
                        t_hi,
                        int(lst[0] == "value" and dec["lst"].is_wide(t_lo, t_hi)),
                        int(lst[0] == "nodata"),
                    ]
                )
                n += 1
            counts[region] = n
            print(json.dumps({"region": region, "points": n}), flush=True)
    (a.out / "meta.json").write_text(
        json.dumps(
            {"site": a.site, "dates": dates, "control": control, "points": counts},
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
