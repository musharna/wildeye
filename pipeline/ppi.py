"""Rain-masked biology reflectivity image for one radar volume (Py-ART)."""
from __future__ import annotations
from pathlib import Path
import numpy as np
import pyart
from PIL import Image

GRID_RES_DEG = 0.01
HALF_SPAN_DEG = 1.6
RHOHV_MAX = 0.95
DBZ_MIN, DBZ_MAX = -10.0, 35.0
RANGE_MIN_M, RANGE_MAX_M = 5_000.0, 150_000.0

def bio_grid(radar) -> tuple[np.ndarray, dict]:
    """Lowest sweep -> (uint8 grid rows=north->south, bounds)."""
    s = radar.extract_sweeps([0])
    z = np.ma.filled(s.fields["reflectivity"]["data"].astype("float32"), np.nan)
    rh = np.ma.filled(s.fields["cross_correlation_ratio"]["data"].astype("float32"), np.nan)
    rng = np.broadcast_to(s.range["data"][None, :], z.shape)
    ok = (np.isfinite(z) & np.isfinite(rh) & (rh < RHOHV_MAX)
          & (z >= DBZ_MIN) & (z < DBZ_MAX) & (rng >= RANGE_MIN_M) & (rng <= RANGE_MAX_M))
    lat0 = float(radar.latitude["data"][0]); lon0 = float(radar.longitude["data"][0])
    west, east = lon0 - HALF_SPAN_DEG, lon0 + HALF_SPAN_DEG
    south, north = lat0 - HALF_SPAN_DEG, lat0 + HALF_SPAN_DEG
    n = int(round(2 * HALF_SPAN_DEG / GRID_RES_DEG))
    grid = np.zeros((n, n), dtype=np.uint8)
    if ok.any():
        glon = s.gate_longitude["data"][ok]; glat = s.gate_latitude["data"][ok]
        col = ((glon - west) / GRID_RES_DEG).astype(int)
        row = ((north - glat) / GRID_RES_DEG).astype(int)
        inside = (col >= 0) & (col < n) & (row >= 0) & (row < n)
        val = np.clip((z[ok] - DBZ_MIN) / (DBZ_MAX - DBZ_MIN) * 255.0, 0, 255).astype(np.uint8)
        np.maximum.at(grid, (row[inside], col[inside]), val[inside])
    bounds = {"west": round(west, 4), "south": round(south, 4),
              "east": round(east, 4), "north": round(north, 4)}
    return grid, bounds

# viridis-like 5-stop ramp; alpha 0 where empty
_STOPS = np.array([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]], dtype=float)

def colorize(grid: np.ndarray) -> np.ndarray:
    t = grid.astype(float) / 255.0 * (len(_STOPS) - 1)
    i = np.clip(t.astype(int), 0, len(_STOPS) - 2); f = (t - i)[..., None]
    rgb = (_STOPS[i] * (1 - f) + _STOPS[i + 1] * f).astype(np.uint8)
    alpha = np.where(grid > 0, np.clip(60 + grid.astype(int), 0, 255), 0).astype(np.uint8)
    return np.dstack([rgb, alpha])

def write_ppi_png(grid: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.png")
    Image.fromarray(colorize(grid), "RGBA").save(tmp, optimize=True)
    tmp.replace(path)

def ppi_for_volume(volume: Path, out_png: Path) -> tuple[np.ndarray, dict]:
    radar = pyart.io.read_nexrad_archive(str(volume))
    grid, bounds = bio_grid(radar)
    write_ppi_png(grid, out_png)
    return grid, bounds
