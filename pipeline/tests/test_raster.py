import numpy as np
import pytest
from pipeline.raster import color_to_alpha, PaletteChanged


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
