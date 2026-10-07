"""pipeline/migrate_cmems_edges.py redraws old Copernicus frames exactly as the pipeline now draws new ones."""

import numpy as np
import pytest
from PIL import Image


def test_an_old_frame_is_redrawn_like_a_new_one_once_and_an_unknown_size_stops_the_run(tmp_path):
    from pipeline.migrate_cmems_edges import LAT_NORTH_FIRST, LON, NEW_SHAPE, main, migrate_png
    from pipeline.raster import edge_align

    rng = np.random.default_rng(1)
    old = rng.integers(0, 256, (681, 1440, 4), dtype=np.uint8)
    d = tmp_path / "rasters" / "cmems-o2"
    d.mkdir(parents=True)
    Image.fromarray(old, "RGBA").save(d / "20261006T000000Z.png")
    Image.fromarray(old, "RGBA").save(tmp_path / "rasters" / "cmems-o2.png")
    main(tmp_path)
    want, _ = edge_align(old, LAT_NORTH_FIRST, LON)
    for f in (d / "20261006T000000Z.png", tmp_path / "rasters" / "cmems-o2.png"):
        got = np.asarray(Image.open(f).convert("RGBA"))
        assert got.shape[:2] == NEW_SHAPE and np.array_equal(got, want)
    assert migrate_png(d / "20261006T000000Z.png") is False, "an already redrawn frame is left alone"
    assert np.array_equal(np.asarray(Image.open(d / "20261006T000000Z.png").convert("RGBA")), want)

    Image.fromarray(old[:100], "RGBA").save(d / "20261007T000000Z.png")
    with pytest.raises(ValueError, match="neither the old nor the new"):
        main(tmp_path)
