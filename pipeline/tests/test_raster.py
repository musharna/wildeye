import numpy as np
from PIL import Image
from pipeline.raster import mode_color_to_alpha

def test_mode_color_becomes_transparent_and_others_survive():
    rgba = np.zeros((4, 4, 4), np.uint8)
    rgba[..., :3] = (10, 20, 30); rgba[..., 3] = 255          # dominant "no stress" colour
    rgba[0, 0] = (200, 50, 50, 255); rgba[1, 1] = (0, 0, 0, 0)  # one alert pixel, one already-transparent (land)
    out = mode_color_to_alpha(rgba)
    assert out[2, 2, 3] == 0                      # dominant colour hidden
    assert tuple(out[0, 0]) == (200, 50, 50, 255)  # alert kept
    assert out[1, 1, 3] == 0                      # land stays transparent
