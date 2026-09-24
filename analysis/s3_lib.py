"""S3 pilot library (docs/analysis/s3-heat-greenness-prereg.md).

The same web-mercator tile math and exact palette decode as the site (src/data/gibsReadout.js): GIBS tiles
are palette PNGs, so a pixel is one colour-map entry or an error, never a nearest match. And the
pre-registered statistics: EVI-matched city − cropland LST gap, bootstrap CI, label-shuffle null.
"""

from __future__ import annotations

import math

import numpy as np

MERCATOR_LIMIT = 85.0511287798
TILE = 256
WIDE = 10  # a bin wider than 10x the table's median carries no usable value (site: shown as a bound)
EVI_BIN = 0.02
MIN_MATCHED = 30
N_BOOT = 1000
N_SHUFFLE = 1000


class UnknownColour(ValueError):
    pass


def tile_pixel(lat: float, lon: float, z: int):
    """(x, y, px, py) of the 256-px tile under a point; None beyond the mercator limit."""
    if not abs(lat) <= MERCATOR_LIMIT:
        return None
    n = 2**z
    lon = ((lon + 180) % 360 + 360) % 360 - 180
    fx = (lon + 180) / 360 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    x, y = math.floor(fx), math.floor(fy)
    return x, y, math.floor((fx - x) * TILE), math.floor((fy - y) * TILE)


def pixel_centre(z: int, x: int, y: int, px: int, py: int) -> tuple[float, float]:
    """(lat, lon) at the centre of a tile pixel."""
    n = 2**z
    fx = x + (px + 0.5) / TILE
    fy = y + (py + 0.5) / TILE
    lon = fx / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy / n))))
    return lat, lon


class Decoder:
    """RGBA → ('class', label) | ('value', lo, hi) | ('nodata',); raises UnknownColour otherwise."""

    def __init__(self, entry: dict):
        self.classes = {tuple(c["rgb"]): c["label"] for c in entry.get("classes", [])}
        self.values = {tuple(e[:3]): (e[3], e[4]) for e in entry.get("decode", [])}
        widths = sorted(
            e[4] - e[3]
            for e in entry.get("decode", [])
            if e[3] is not None and e[4] is not None
        )
        self.median = widths[len(widths) // 2] if widths else 1.0

    def __call__(self, rgba):
        r, g, b, a = (int(v) for v in rgba)
        if a == 0:
            return ("nodata",)
        key = (r, g, b)
        if key in self.classes:
            return ("class", self.classes[key])
        if key in self.values:
            return ("value", *self.values[key])
        raise UnknownColour(f"unknown colour {r},{g},{b}")

    def is_wide(self, lo, hi) -> bool:
        return lo is None or hi is None or hi - lo > WIDE * self.median


def _bins(evi: np.ndarray) -> np.ndarray:
    return np.floor(evi / EVI_BIN).astype(int)


def matched_gap(evi, lst, city):
    """Σ_b n_city(b)·(mean city(b) − mean crop(b)) / Σ_b n_city(b) over bins holding both groups.
    Returns (gap, n_city_matched, n_crop_matched); gap is nan with no shared bin."""
    b = _bins(evi)
    num = den = n_crop = 0.0
    for k in np.intersect1d(b[city], b[~city]):
        c, k_ = city & (b == k), ~city & (b == k)
        nc = c.sum()
        num += nc * (lst[c].mean() - lst[k_].mean())
        den += nc
        n_crop += k_.sum()
    return (num / den if den else float("nan")), int(den), int(n_crop)


def region_stats(evi, lst, city, rng=None) -> dict:
    """The pre-registered per-region numbers (gap, 95% bootstrap CI, shuffle p, testable)."""
    rng = rng or np.random.default_rng(0)
    evi, lst, city = (
        np.asarray(evi, float),
        np.asarray(lst, float),
        np.asarray(city, bool),
    )
    gap, n_city, n_crop = matched_gap(evi, lst, city)
    out = {
        "n_city": int(city.sum()),
        "n_crop": int((~city).sum()),
        "n_city_matched": n_city,
        "n_crop_matched": n_crop,
        "unmatched_gap": float(lst[city].mean() - lst[~city].mean())
        if city.any() and (~city).any()
        else float("nan"),
        "gap": float(gap),
        "testable": n_city >= MIN_MATCHED and n_crop >= MIN_MATCHED,
    }
    if not out["testable"]:
        return {**out, "ci_lo": float("nan"), "ci_hi": float("nan"), "p": float("nan")}
    ic, ik = np.flatnonzero(city), np.flatnonzero(~city)
    boots = []
    for _ in range(N_BOOT):
        idx = np.concatenate([rng.choice(ic, ic.size), rng.choice(ik, ik.size)])
        boots.append(matched_gap(evi[idx], lst[idx], city[idx])[0])
    null = [matched_gap(evi, lst, rng.permutation(city))[0] for _ in range(N_SHUFFLE)]
    lo, hi = np.nanpercentile(boots, [2.5, 97.5])
    return {
        **out,
        "ci_lo": float(lo),
        "ci_hi": float(hi),
        "p": float(np.mean(np.asarray(null) >= gap)),
    }


def region_passes(r: dict) -> bool:
    return bool(r["testable"] and r["gap"] > 0 and r["ci_lo"] > 0 and r["p"] < 0.05)


def verdict(regions: list[dict]) -> str:
    testable = [r for r in regions if r["testable"]]
    if len(testable) < 4:
        return "NOT TESTABLE"
    return (
        "PASS"
        if sum(region_passes(r) for r in testable) >= 0.75 * len(testable)
        else "FAIL"
    )
