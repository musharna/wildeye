import numpy as np
import pytest
from pipeline.raster import color_to_alpha, PaletteChanged, fill_empty_right_edge


def test_pinned_colour_becomes_transparent_others_survive_and_fraction_reported():
    rgba = np.zeros((4, 4, 4), np.uint8)
    rgba[..., :3] = (10, 20, 30); rgba[..., 3] = 255          # pinned "no stress" colour
    rgba[0, 0] = (200, 50, 50, 255); rgba[1, 1] = (0, 0, 0, 0)  # one alert pixel, one land (already transparent)
    out, frac = color_to_alpha(rgba, (10, 20, 30))
    assert out[2, 2, 3] == 0 and tuple(out[0, 0]) == (200, 50, 50, 255) and out[1, 1, 3] == 0
    assert abs(frac - 14 / 15) < 1e-9


def test_mask_is_explicit_not_most_frequent_colour():
    """A day when a real alert class dominates must NOT be hidden (the old mode-colour heuristic did)."""
    rgba = np.zeros((4, 4, 4), np.uint8)
    rgba[..., :3] = (200, 50, 50); rgba[..., 3] = 255   # alert colour dominates today
    rgba[0, 0] = (10, 20, 30, 255)                       # one no-stress pixel
    out, _ = color_to_alpha(rgba, (10, 20, 30))
    assert out[0, 0, 3] == 0 and out[2, 2, 3] == 255


def test_missing_pinned_colour_fails_loud_but_empty_image_is_fine():
    rgba = np.zeros((2, 2, 4), np.uint8); rgba[..., :3] = (1, 2, 3); rgba[..., 3] = 255
    with pytest.raises(PaletteChanged):
        color_to_alpha(rgba, (9, 9, 9))
    empty = np.zeros((2, 2, 4), np.uint8)
    out, frac = color_to_alpha(empty, (9, 9, 9))
    assert frac == 0.0 and out.shape == empty.shape


def test_process_rejects_legacy_mode_color(monkeypatch, tmp_path):
    from pipeline import raster
    monkeypatch.setattr(raster, "fetch_png", lambda url, timeout=180: np.zeros((2, 2, 4), np.uint8))
    with pytest.raises(ValueError, match="transparent must be"):
        raster.process({"id": "x", "url": "u", "transparent": "mode_color", "name": "n", "icon": "i",
                        "bounds": {}, "legend": "", "credit": "", "credit_key": ""}, tmp_path)


def test_only_flag_keeps_unselected_products_in_manifest(tmp_path, monkeypatch):
    """Regression: --only X used to rewrite rasters.json with X alone (dropping the other drapes)."""
    import json
    from pipeline import raster
    out = tmp_path / "data"; out.mkdir()
    (out / "rasters.json").write_text(json.dumps({"generated_at": "t", "failures": {}, "products": [
        {"id": "crw-bleaching", "png": "data/rasters/crw-bleaching.png", "time": "2026-09-09T12:00:00Z"},
        {"id": "oisst", "png": "data/rasters/oisst.png", "time": "2026-08-26T12:00:00Z"}]}))
    monkeypatch.setattr(raster, "process", lambda p, d: {"id": p["id"], "png": f"data/rasters/{p['id']}.png", "time": "new"})
    raster.main(["--out", str(out), "--only", "chlor-a"])
    ids = {p["id"]: p for p in json.loads((out / "rasters.json").read_text())["products"]}
    assert set(ids) == {"crw-bleaching", "oisst", "chlor-a"}
    assert ids["oisst"]["time"] == "2026-08-26T12:00:00Z" and ids["chlor-a"]["time"] == "new"


def test_archive_frame_dedupes_same_acquisition_prunes_old_and_returns_sorted_history(tmp_path):
    import datetime as dt
    from pipeline.raster import archive_frame
    latest = tmp_path / "x.png"; latest.write_bytes(b"png-bytes")
    old = tmp_path / "x" ; old.mkdir()
    stale = (dt.datetime.now(dt.UTC) - dt.timedelta(days=40)).strftime("%Y%m%dT%H%M%SZ")
    (old / f"{stale}.png").write_bytes(b"old")
    (old / "notes.txt").write_text("ignored")
    h1 = archive_frame(latest, "x", "2026-09-10T12:00:00Z", tmp_path, keep_days=30)
    h2 = archive_frame(latest, "x", "2026-09-10T12:00:00Z", tmp_path, keep_days=30)   # same acquisition again
    h3 = archive_frame(latest, "x", "2026-09-11T12:00:00Z", tmp_path, keep_days=30)
    assert h1 == h2 == [{"time": "2026-09-10T12:00:00Z", "png": "data/rasters/x/20260910T120000Z.png"}]
    assert [e["time"] for e in h3] == ["2026-09-10T12:00:00Z", "2026-09-11T12:00:00Z"]
    assert not (old / f"{stale}.png").exists(), "frame older than keep_days pruned"
    assert sorted(p.name for p in old.iterdir()) == ["20260910T120000Z.png", "20260911T120000Z.png", "notes.txt"]


def test_resolve_source_picks_newest_catalog_file_and_dates_it():
    from pipeline.raster import resolve_source
    prod = {"id": "ndvi", "catalog": "c", "url_template": "https://x/wms/{file}?GetMap",
            "file_regex": r"VIIRS-Land_v001_[A-Z0-9]+_NOAA-20_\d{8}_c\d+\.nc", "time_regex": r"_(\d{4})(\d{2})(\d{2})_c"}
    xml = ('<dataset name="VIIRS-Land_v001_JP113C1_NOAA-20_20260905_c20260907143010.nc"/>'
           '<dataset name="VIIRS-Land_v001_JP113C1_NOAA-20_20260906_c20260908143010.nc"/>'
           '<dataset name="VIIRS-Land_v001_JP113C1_NOAA-20_20260904_c20260906143010.nc"/>')
    url, when = resolve_source(prod, xml)
    assert url.endswith("NOAA-20_20260906_c20260908143010.nc?GetMap") and when == "2026-09-06T00:00:00Z"
    assert resolve_source({"id": "s", "url": "u"}) == ("u", None)
    import pytest
    with pytest.raises(RuntimeError, match="no file matching"):
        resolve_source(prod, "<catalog/>")


def test_ramp_rgba_and_fetch_cmems_pick_latest_analysis_day_and_flip_north_up():
    import datetime as dt
    import numpy as np
    from pipeline.raster import ramp_rgba, fetch_cmems

    ramp = {"min": 0, "max": 10, "stops": [[0, 0, 0], [255, 255, 255]]}
    out = ramp_rgba(np.array([[0.0, 5.0, 10.0, np.nan, 20.0]]), ramp)
    assert out[0, 0].tolist() == [0, 0, 0, 255] and out[0, 1].tolist() == [128, 128, 128, 255]
    assert out[0, 2].tolist() == [255, 255, 255, 255] and out[0, 3, 3] == 0, "NaN is transparent"
    assert out[0, 4].tolist() == [255, 255, 255, 255], "above max clamps"

    class DA:
        def __init__(self, arr, dims): self.values, self.dims = arr, dims
        def isel(self, **kw):
            a = self.values
            if "time" in kw: a = a[kw["time"]]
            if "depth" in kw: a = a[kw["depth"]]
            return DA(a, tuple(d for d in self.dims if d not in kw))
    times = np.array(["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"], dtype="datetime64[ns]")
    field = np.zeros((4, 1, 2, 3)); field[2, 0] = [[1, 2, 3], [7, 8, 9]]  # day index 2 = 2026-09-12; row 0 = south
    ds = {"o2": DA(field, ("time", "depth", "latitude", "longitude")), "time": DA(times, ("time",)), "latitude": DA(np.array([-80.0, 90.0]), ("latitude",))}
    seen = {}
    def open_dataset(**kw):
        seen.update(kw); return ds
    product = {"id": "cmems-o2", "cmems": {"dataset_id": "d", "variable": "o2", "max_depth": 1}, "ramp": ramp}
    rgba, when = fetch_cmems(product, today=dt.date(2026, 9, 12), open_dataset=open_dataset)
    assert when == "2026-09-12T00:00:00Z", "the forecast day (13th) is skipped"
    assert seen["dataset_id"] == "d" and seen["variables"] == ["o2"]
    assert rgba.shape == (2, 3, 4) and rgba[0, 0, 0] > rgba[1, 0, 0], "north row first: values 7–9 on top of 1–3"
    try:
        fetch_cmems(product, today=dt.date(2026, 9, 1), open_dataset=open_dataset); assert False
    except RuntimeError as e:
        assert "no time step" in str(e)


def test_fill_empty_right_edge_closes_the_antimeridian_seam_only_when_erddap_left_it_empty():
    """Mutant seen failing: returning the image unchanged (the seam stays). Positive controls: an image
    with data in its last column, and one with nothing beside an empty last column, are untouched."""
    img = np.zeros((3, 4, 4), dtype=np.uint8)
    img[:, :3] = [10, 20, 30, 255]          # data everywhere except the last column (ERDDAP's output)
    fixed = fill_empty_right_edge(img)
    assert (fixed[:, -1] == [10, 20, 30, 255]).all()
    assert (img[:, -1, 3] == 0).all(), "input not modified in place"
    full = np.full((3, 4, 4), 200, dtype=np.uint8)
    assert fill_empty_right_edge(full) is full
    land = np.zeros((3, 4, 4), dtype=np.uint8)
    land[:, :2] = [1, 2, 3, 255]            # last two columns empty (e.g. land/no data) → leave the gap
    assert fill_empty_right_edge(land) is land
