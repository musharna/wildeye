import numpy as np
from pipeline.field import composite

def test_composite_union_bounds_and_max():
    a = np.zeros((10, 10), np.uint8); a[:, :] = 100
    b = np.zeros((10, 10), np.uint8); b[:, :] = 200
    ba = {"west": -80.0, "south": 40.0, "east": -79.9, "north": 40.1}   # 0.01° cells
    bb = {"west": -79.95, "south": 40.05, "east": -79.85, "north": 40.15}
    grid, bounds = composite([(a, ba), (b, bb)], res=0.02)
    assert bounds == {"west": -80.0, "south": 40.0, "east": -79.85, "north": 40.15}
    assert grid.shape == (8, 8)       # 0.15/0.02 rounded up
    assert grid.max() == 200 and grid.min() == 0
    assert grid[-1, 0] == 100         # SW corner only a
    assert grid[0, -1] == 200         # NE corner only b
    assert grid[3, 3] == 200          # overlap → max
