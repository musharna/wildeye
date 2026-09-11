import numpy as np
import pyart
from pipeline.ppi import bio_grid, GRID_RES_DEG, HALF_SPAN_DEG

def synthetic_radar():
    r = pyart.testing.make_empty_ppi_radar(ngates=600, rays_per_sweep=360, nsweeps=1)
    r.range["data"] = (np.arange(600) * 250.0 + 125.0).astype("float32")
    r.latitude["data"] = np.array([40.0]); r.longitude["data"] = np.array([-80.0])
    r.azimuth["data"] = np.arange(360, dtype="float32")
    r.elevation["data"] = np.full(360, 0.5, dtype="float32")
    z = np.ma.masked_array(np.full((360, 600), 20.0, dtype="float32"))
    rh = np.full((360, 600), 0.90, dtype="float32")
    rh[:90, :] = 0.99  # azimuth 0-90 = rain
    r.add_field("reflectivity", {"data": z}, replace_existing=True)
    r.add_field("cross_correlation_ratio", {"data": np.ma.masked_array(rh)}, replace_existing=True)
    return r

def test_bio_grid_masks_rain_quadrant_and_keeps_birds():
    grid, bounds = bio_grid(synthetic_radar())
    n = int(round(2 * HALF_SPAN_DEG / GRID_RES_DEG))
    assert grid.shape == (n, n) and grid.dtype == np.uint8
    assert bounds == {"west": -81.6, "south": 38.4, "east": -78.4, "north": 41.6}
    h, w = grid.shape
    ne = grid[: h // 2 - 5, w // 2 + 5 :]      # north-east = azimuth 0-90 = rain → 0
    sw = grid[h // 2 + 5 :, : w // 2 - 5]      # south-west = birds → >0 within 150 km
    assert ne.max() == 0
    assert (sw > 0).sum() > 1000
    # 20 dBZ → byte (20+10)/45*255 = 170
    assert int(sw.max()) == 170
    # inside 5 km of the radar is masked (clutter)
    assert grid[h // 2, w // 2] == 0
