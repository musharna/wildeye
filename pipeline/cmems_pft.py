"""Dominant phytoplankton group per 0.25° ocean cell, monthly, from Copernicus-GlobColour (Copernicus Marine).

Reads the latest month of OCEANCOLOUR_GLO_BGC_L4_NRT_009_102 (dataset in the product's `cmems_dominant` block): the
chlorophyll a of each group named by the product's classes (diatoms, dinoflagellates, haptophytes, green algae and
prochlorophytes, prokaryotes; PROCHLO is a prokaryote and is not read). Each group is averaged over the 4 km pixels of
a 0.25° cell where all of them are present, and the cell is painted in the colour of the largest. Cells with no such
pixel (cloud, sea ice, polar night, land) are clear. Spec: docs/superpowers/specs/2026-10-07-cmems-phytoplankton-types.md.
Licence: Copernicus Marine Service; credit "Generated using E.U. Copernicus Marine Service Information" + the DOI.
"""

from __future__ import annotations

import datetime as dt
import os

import numpy as np


class GridChanged(RuntimeError):
    """The dataset is no longer the whole-globe grid this module was written against."""


def dominant_group(stack: np.ndarray, block: int) -> np.ndarray:
    """stack: (groups, rows, cols). Returns (rows/block, cols/block) int8: the index of the group with the highest
    mean over the pixels of the block where every group is finite (a tie goes to the first), -1 where no pixel is."""
    g, h, w = stack.shape
    if h % block or w % block:
        raise ValueError(f"{h}x{w} grid is not divisible into {block}x{block} blocks")
    ok = np.isfinite(stack).all(axis=0)
    cnt = ok.reshape(h // block, block, w // block, block).sum(axis=(1, 3))
    sums = np.empty((g, h // block, w // block), np.float64)
    for i in range(g):
        # every group shares one denominator per cell (cnt), so the argmax of the sums is the argmax of the means
        sums[i] = (
            np.where(ok, stack[i], 0)
            .reshape(h // block, block, w // block, block)
            .sum(axis=(1, 3), dtype=np.float64)
        )
    out = np.argmax(sums, axis=0).astype(np.int8)
    out[cnt == 0] = -1
    return out


def paint_classes(cls: np.ndarray, rgbs: list) -> np.ndarray:
    """Class grid -> RGBA in the class colours; -1 (no data) clear."""
    out = np.zeros(cls.shape + (4,), np.uint8)
    for i, rgb in enumerate(rgbs):
        m = cls == i
        out[m, :3] = rgb
        out[m, 3] = 255
    return out


def check_grid(lat: np.ndarray, lon: np.ndarray, size: list) -> None:
    """Cell centres of a whole-globe grid of size [width, height]: longitude from -180 west to east, latitude either way."""
    w, h = size
    if len(lon) != w or len(lat) != h:
        raise GridChanged(f"grid is {len(lon)}x{len(lat)}, expected {w}x{h}")
    want_lon = -180 + (np.arange(w) + 0.5) * 360 / w
    want_lat = -90 + (np.arange(h) + 0.5) * 180 / h
    if not np.allclose(lon, want_lon, atol=1e-3):
        raise GridChanged("longitude centres are not the whole globe from -180")
    if not (
        np.allclose(lat, want_lat, atol=1e-3)
        or np.allclose(lat, want_lat[::-1], atol=1e-3)
    ):
        raise GridChanged("latitude centres are not the whole globe")


def fetch_cmems_dominant(
    product: dict, today: dt.date | None = None, open_dataset=None
) -> tuple[np.ndarray, str]:
    """(RGBA north-up, time) for the latest month at or before today. Credentials from CMEMS_USER / CMEMS_PASS."""
    c = product["cmems_dominant"]
    classes = product["classes"]
    variables = [k["variable"] for k in classes]
    if open_dataset is None:
        import copernicusmarine as cm

        user, pw = os.environ.get("CMEMS_USER"), os.environ.get("CMEMS_PASS")
        if not user or not pw:
            raise RuntimeError(
                "CMEMS_USER / CMEMS_PASS not set (source ~/.config/wildeye/env)"
            )
        open_dataset = lambda **kw: cm.open_dataset(username=user, password=pw, **kw)  # noqa: E731
    ds = open_dataset(dataset_id=c["dataset_id"], variables=variables)
    today = today or dt.datetime.now(dt.UTC).date()
    days = np.asarray(ds["time"].values, dtype="datetime64[D]")
    eligible = np.nonzero(days <= np.datetime64(today))[0]
    if not len(eligible):
        raise RuntimeError(f"{product['id']}: no time step at or before {today}")
    k = int(eligible[-1])
    lat = np.asarray(ds["latitude"].values)
    check_grid(lat, np.asarray(ds["longitude"].values), c["grid"])
    stack = np.empty((len(variables), len(lat), c["grid"][0]), np.float32)
    for i, v in enumerate(variables):
        stack[i] = np.asarray(ds[v].isel(time=k).values, dtype=np.float32)
    cls = dominant_group(stack, int(c["block"]))
    del stack
    if not (cls >= 0).any():
        raise RuntimeError(
            f"{product['id']}: no cell has all of {variables} in {days[k]}"
        )
    if lat[0] < lat[-1]:
        cls = cls[::-1]  # north-up
    when = str(np.datetime_as_string(days[k], unit="D")) + "T00:00:00Z"
    return paint_classes(cls, [k["rgb"] for k in classes]), when
