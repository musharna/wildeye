"""NOAA Coral Reef Watch Four-Month Coral Bleaching Heat Stress Outlook v5 (CFSv2) for the raster drapes.

The newest weekly issue is found in CRW's year directories, and its four-month composite (CRW_BAA_FourMonth, 0.5°)
is read at two probabilities: the stress level reached by at least 60% and by at least 90% of the model runs (CRW's
two headline outlook maps). The 60% composite is drawn; both go into a readout image, one byte each per cell.
Spec: docs/superpowers/specs/2026-10-03-crw-outlook-design.md. Licence (the files' own `license` attribute): "available
for use without restriction, but it is required to credit NOAA Coral Reef Watch program".
"""

from __future__ import annotations
import datetime as dt
import re
import tempfile
from pathlib import Path
import numpy as np
from PIL import Image

LEVELS = ("no stress", "Watch", "Warning", "Alert Level 1", "Alert Level 2")
LAND = 255  # readout image byte for a cell the outlook does not cover (land, missing)
VAR = "CRW_BAA_FourMonth"
FILE_RE = r"cfsv2_outlook-(\d{3})perc_4mon-and-wkly_v5_icwk(\d{8})_for_\d{8}to\d{8}\.nc"


class OutlookChanged(RuntimeError):
    """A file no longer has the shape, values or metadata this module was written against."""


def newest_issue(
    index_url: str, probabilities: list[int], read_text
) -> tuple[str, dict[int, str]]:
    """(icwk, {probability: url}) for the newest issue that has a file at every probability. Year directories are
    searched newest first, so a new year whose directory is still empty falls back to the year before."""
    years = sorted(
        set(re.findall(r'href="(\d{4})/"', read_text(index_url))), reverse=True
    )
    if not years:
        raise OutlookChanged(f"no year directories in {index_url}")
    for year in years[:2]:
        listing = read_text(f"{index_url}{year}/")
        found: dict[str, dict[int, str]] = {}
        for m in re.finditer(FILE_RE, listing):
            found.setdefault(m.group(2), {})[int(m.group(1))] = (
                f"{index_url}{year}/{m.group(0)}"
            )
        complete = sorted(
            k for k, v in found.items() if all(p in v for p in probabilities)
        )
        if complete:
            icwk = complete[-1]
            return icwk, {p: found[icwk][p] for p in probabilities}
        if found:
            raise OutlookChanged(
                f"{year}: no issue has every probability {probabilities}; newest {max(found)} has {sorted(found[max(found)])}"
            )
    raise OutlookChanged(
        f"no outlook files in the newest year directories {years[:2]} of {index_url}"
    )


def _day(stamp: str) -> dt.date:
    return dt.datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").date()


def read_composite(ds) -> tuple[np.ndarray, dict]:
    """(classes, meta) from one opened outlook file. classes: int16, north-up, longitude -180..180, LAND where the
    file has no value. meta: first and last day of the four-month window and the day issued."""
    da = ds[VAR]
    if da.dims != ("time", "lat", "lon") or da.sizes["time"] != 1:
        raise OutlookChanged(f"{VAR} dims {da.dims} {dict(da.sizes)}")
    lon = np.asarray(ds["lon"].values, dtype=float)
    lat = np.asarray(ds["lat"].values, dtype=float)
    if (
        len(lon) != 720
        or not np.allclose(np.diff(lon), 0.5)
        or abs(lon[0] - 0.25) > 1e-6
    ):
        raise OutlookChanged(
            f"longitude grid {lon[:2]}…{lon[-1:]} ({len(lon)}) is not 0.25..359.75 by 0.5"
        )
    if not np.all(np.diff(lat) < 0):
        raise OutlookChanged("latitude is not north-up")
    v = np.asarray(da.values[0], dtype=float)
    water = ~np.isnan(v)
    if not np.isin(v[water], [0, 1, 2, 3, 4]).all():
        raise OutlookChanged(
            f"{VAR} has values outside 0-4: {sorted(set(np.unique(v[water]).tolist()) - {0, 1, 2, 3, 4})[:5]}"
        )
    flag = np.asarray(ds["surface_flag"].values)
    if not np.array_equal(water, flag == 0):
        raise OutlookChanged(
            f"{int((water != (flag == 0)).sum())} cells where a value and surface_flag 'valid-water' disagree"
        )
    classes = np.where(water, v, LAND).astype(np.int16)
    # longitude 0.25..359.75 → -179.75..179.75: column 360 (180.25°E = -179.75°) comes first
    classes = np.roll(classes, -360, axis=1)
    a = ds.attrs
    meta = {
        "start": _day(a["time_coverage_start"]).isoformat(),
        # time_coverage_end is the exclusive end (the Monday after the last week)
        "end": (_day(a["time_coverage_end"]) - dt.timedelta(days=1)).isoformat(),
        "issued": _day(a["date_issued"]).isoformat(),
    }
    return classes, meta


def drape_rgba(classes: np.ndarray, palette: list[dict]) -> np.ndarray:
    """Colour each class by the product's palette; land and classes marked hidden are transparent."""
    out = np.zeros(classes.shape + (4,), dtype=np.uint8)
    for k, c in enumerate(palette):
        hit = classes == k
        out[hit, :3] = c["rgb"]
        out[hit, 3] = 0 if c.get("hidden") else 255
    return out


def readout_rgba(low: np.ndarray, high: np.ndarray) -> np.ndarray:
    """Readout image, opaque everywhere so a canvas returns the bytes unchanged: R = class at the lower probability,
    G = class at the higher one (LAND off the water), B = 0."""
    out = np.zeros(low.shape + (4,), dtype=np.uint8)
    out[..., 0] = low
    out[..., 1] = high
    out[..., 3] = 255
    return out


def fetch_crw_outlook(
    product: dict, out_dir: Path, read_text, read_bytes, open_dataset=None
) -> tuple[np.ndarray, str, dict]:
    """(drape rgba, issued time, manifest extras) for the newest issue; writes the readout image to out_dir."""
    c = product["crw_outlook"]
    low_p, high_p = c["probabilities"]
    if open_dataset is None:
        import xarray as xr

        open_dataset = xr.open_dataset
    icwk, urls = newest_issue(c["index"], [low_p, high_p], read_text)
    read = {}
    with tempfile.TemporaryDirectory() as tmp:
        for p, url in urls.items():
            f = Path(tmp) / f"{p}.nc"
            f.write_bytes(read_bytes(url))
            with open_dataset(f) as ds:
                read[p] = read_composite(ds)
    (low, meta), (high, meta_high) = read[low_p], read[high_p]
    if meta != meta_high:
        raise OutlookChanged(
            f"the {low_p}% and {high_p}% files disagree on dates: {meta} vs {meta_high}"
        )
    if not np.array_equal(low == LAND, high == LAND):
        raise OutlookChanged("the two probabilities cover different cells")
    water = low != LAND
    if (low[water] < high[water]).any():
        # a level reached by 90% of runs is reached by 60% of them: the reverse means the files are not what we think
        raise OutlookChanged(
            f"{int((low[water] < high[water]).sum())} cells where the {high_p}% level exceeds the {low_p}% level"
        )
    data = out_dir / f"{product['id']}.data.png"
    data.parent.mkdir(parents=True, exist_ok=True)
    tmp_png = data.with_suffix(".tmp.png")
    Image.fromarray(readout_rgba(low, high), "RGBA").save(tmp_png, optimize=True)
    tmp_png.replace(data)
    legend = (
        f"Four-month outlook {meta['start']} to {meta['end']}: the stress level reached by at least {low_p}% of "
        f"the CFSv2 model runs (issued {meta['issued']}); computed for all ocean, reefs or not; no-stress and land not drawn"
    )
    extras = {
        "legend": legend,
        "outlook": {
            **meta,
            "icwk": icwk,
            "probabilities": [low_p, high_p],
            "data_png": f"data/rasters/{data.name}",
            "levels": list(LEVELS),
            "sources": [urls[low_p], urls[high_p]],
        },
    }
    return drape_rgba(low, product["classes"]), f"{meta['issued']}T00:00:00Z", extras
