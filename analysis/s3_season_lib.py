"""S3 season rerun library (docs/analysis/s3_season_prereg.md).

The unit is the pure level-7 LST pixel. Its land-cover (level 8) and EVI (level 9) children nest exactly by
global pixel index, so no coordinate ever crosses a pixel edge. The gap statistics are the pilot's
(analysis/s3_lib.py), unchanged.
"""

from __future__ import annotations

import datetime as dt
import math

import numpy as np

from analysis import s3_lib as s

CITY, CROP = "Urban and Built-up Lands", "Croplands"
MIN_EVI_CHILDREN = 8


def evi_dates(year: int) -> list[str]:
    """The year's 16-day EVI composite start dates (GIBS: Jan 1 + 16k, within the year)."""
    d, out = dt.date(year, 1, 1), []
    while d.year == year:
        out.append(d.isoformat())
        d += dt.timedelta(days=16)
    return out


def lst_pair(evi_date: str) -> tuple[str, str]:
    """The two 8-day LST composites inside the 16-day EVI window starting on evi_date."""
    d = dt.date.fromisoformat(evi_date)
    return d.isoformat(), (d + dt.timedelta(days=8)).isoformat()


def children(gx: int, gy: int, k: int) -> list[tuple[int, int]]:
    """Global pixel indices, k levels finer, of the pixels inside global pixel (gx, gy); row-major."""
    n = 2**k
    return [(gx * n + i, gy * n + j) for j in range(n) for i in range(n)]


def lst_pixels_in_box(lat0: float, lon0: float, z: int = 7):
    """Global (gx, gy) of every level-z pixel whose centre lies in the 1° box around (lat0, lon0)."""
    la, lb, oa, ob = lat0 - 0.5, lat0 + 0.5, lon0 - 0.5, lon0 + 0.5
    x0, y0, px0, py0 = s.tile_pixel(lb, oa, z)
    x1, y1, px1, py1 = s.tile_pixel(la, ob, z)
    for gy in range(y0 * s.TILE + py0, y1 * s.TILE + py1 + 1):
        for gx in range(x0 * s.TILE + px0, x1 * s.TILE + px1 + 1):
            lat, lon = s.pixel_centre(
                z, gx // s.TILE, gy // s.TILE, gx % s.TILE, gy % s.TILE
            )
            if la <= lat < lb and oa <= lon < ob:
                yield gx, gy


def pixel_class(labels: list[str]):
    """'city' / 'cropland' only when every land-cover child is that class; else None."""
    if labels and all(l == CITY for l in labels):
        return "city"
    if labels and all(l == CROP for l in labels):
        return "cropland"
    return None


def _usable(v, dec) -> bool:
    return v[0] == "value" and not dec.is_wide(v[1], v[2])


def pixel_evi(values, dec):
    """Mean midpoint of the valid, non-wide EVI children; None with fewer than 8."""
    mids = [(v[1] + v[2]) / 2 for v in values if _usable(v, dec)]
    return float(np.mean(mids)) if len(mids) >= MIN_EVI_CHILDREN else None


def pixel_lst(values, dec):
    """Mean midpoint (°C) of the cloud-free, non-wide LST composites; None when neither is usable."""
    mids = [(v[1] + v[2]) / 2 - 273.15 for v in values if _usable(v, dec)]
    return float(np.mean(mids)) if mids else None


def peak_date(cropland_evi_by_date):
    """The date with the highest median cropland-pixel EVI (ties: earliest). EVI only, by construction."""
    best, best_m = None, -math.inf
    for d in sorted(cropland_evi_by_date):
        v = cropland_evi_by_date[d]
        if len(v) and float(np.median(v)) > best_m:
            best, best_m = d, float(np.median(v))
    return best


def engaged(peak_median, sep_median) -> bool:
    return (
        peak_median is not None and sep_median is not None and peak_median > sep_median
    )


def _pos(r) -> bool:
    return bool(r["testable"] and r["gap"] > 0 and r["ci_lo"] > 0)


def _neg(r) -> bool:
    return bool(r["testable"] and r["gap"] < 0 and r["ci_hi"] < 0)


def reading(peak: dict, sep: dict, is_engaged: bool) -> str:
    """The pre-registered reading for a region that failed in the pilot."""
    if _pos(sep):
        return "year or counting, not season"
    if not is_engaged:
        return "unresolved"
    if _pos(peak) and _neg(sep):
        return "harvest idea supported"
    if _neg(peak):
        return "harvest idea refuted"
    return "unresolved"
