"""Composite per-site biology grids into one domain grid for particle seeding."""
from __future__ import annotations
import math
from pathlib import Path
import numpy as np
from PIL import Image

def composite(items: list[tuple[np.ndarray, dict]], res: float = 0.02) -> tuple[np.ndarray, dict]:
    west = min(b["west"] for _, b in items); east = max(b["east"] for _, b in items)
    south = min(b["south"] for _, b in items); north = max(b["north"] for _, b in items)
    W = int(math.ceil(round((east - west) / res, 6))); H = int(math.ceil(round((north - south) / res, 6)))
    out = np.zeros((H, W), np.uint8)
    for g, b in items:
        h, w = g.shape
        cell_lon = (b["east"] - b["west"]) / w; cell_lat = (b["north"] - b["south"]) / h
        rows, cols = np.nonzero(g)
        if not len(rows):
            continue
        lon = b["west"] + (cols + 0.5) * cell_lon; lat = b["north"] - (rows + 0.5) * cell_lat
        c = np.clip(((lon - west) / res).astype(int), 0, W - 1)
        r = np.clip(((north - lat) / res).astype(int), 0, H - 1)
        np.maximum.at(out, (r, c), g[rows, cols])
    return out, {"west": round(west, 4), "south": round(south, 4), "east": round(east, 4), "north": round(north, 4)}

def write_field_png(grid: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rgba = np.dstack([grid, grid, grid, np.where(grid > 0, 255, 0).astype(np.uint8)])
    tmp = path.with_suffix(".tmp.png")
    Image.fromarray(rgba, "RGBA").save(tmp, optimize=True)
    tmp.replace(path)
