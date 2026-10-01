"""Human Footprint pipeline: pinned downloads, reprojection, bins, the geographic tile pyramid (spec 2026-10-01-human-footprint-design.md)."""

import hashlib
import json
import zipfile

import numpy as np
import pytest
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.transform import from_origin

from pipeline import hfp

MOLL = "ESRI:54009"
TO_MOLL = Transformer.from_crs("EPSG:4326", MOLL, always_xy=True)


def write_moll_tif(path, patches, cell=50_000.0, base=np.nan):
    """A small global Mollweide float32 GeoTIFF: `base` everywhere on land-ish rows, `patches` = [(lon, lat, half_km, value)]."""
    left, top = -18_040_094.1, 9_018_957.05
    w, h = int(36_081_000 / cell), int(16_382_000 / cell)
    data = np.full((h, w), base, np.float32)
    xs = left + (np.arange(w) + 0.5) * cell
    ys = top - (np.arange(h) + 0.5) * cell
    for lon, lat, half_km, value in patches:
        x, y = TO_MOLL.transform(lon, lat)
        cols = np.abs(xs - x) <= half_km * 1000
        rows = np.abs(ys - y) <= half_km * 1000
        data[np.ix_(rows, cols)] = value
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=w,
        height=h,
        count=1,
        dtype="float32",
        crs=MOLL,
        transform=from_origin(left, top, cell, cell),
        nodata=np.nan,
    ) as dst:
        dst.write(data, 1)
    return path


def zip_tif(tif, zip_path, inner):
    with zipfile.ZipFile(zip_path, "w") as z:
        z.write(tif, inner)
    return zip_path


def md5(path):
    return hashlib.md5(path.read_bytes(), usedforsecurity=False).hexdigest()


def test_epochs_are_the_five_snapshots_with_figshare_md5s():
    assert sorted(hfp.EPOCHS) == [2000, 2006, 2012, 2018, 2024]
    assert hfp.EPOCHS[2024] == (59321030, "0d5b9c10bc4a3947a7eb1eaf22db6975")
    assert all(len(m) == 32 for _, m in hfp.EPOCHS.values())


def test_palette_is_50_distinct_colours_pale_to_dark_and_bins_are_floor_with_49_closed():
    pal = hfp.palette()
    assert len(pal) == 50 and len(set(pal)) == 50
    assert pal[0] == (255, 255, 204) and pal[-1] == (128, 0, 38)
    a = np.array([[0.0, 0.99, 1.0, 12.7], [48.999, 49.0, 50.0, np.nan]], np.float32)
    assert hfp.quantise(a).tolist() == [[0, 0, 1, 12], [48, 49, 49, hfp.NODATA]]
    assert hfp.NODATA == 50
    with pytest.raises(ValueError, match="outside 0–50"):
        hfp.quantise(np.array([[50.5]], np.float32))
    with pytest.raises(ValueError, match="outside 0–50"):
        hfp.quantise(np.array([[-0.1]], np.float32))


def test_block_mean_ignores_no_data_and_an_all_empty_block_stays_empty():
    a = np.array([[1, 3, np.nan, np.nan], [np.nan, 5, np.nan, np.nan]], np.float32)
    out = hfp.block_mean(a, 2)
    assert out.shape == (1, 2)
    assert out[0, 0] == pytest.approx(3.0)
    assert np.isnan(out[0, 1])


def test_tiles_cut_the_geographic_pyramid_and_place_a_pixel_where_its_lon_lat_is():
    z = 1  # 4 × 2 tiles of 256 → 1024 × 512, 0.3515625° a pixel
    idx = np.full((512, 1024), hfp.NODATA, np.uint8)
    lon, lat = 10.2, 45.3
    col, row = int((lon + 180) / 360 * 1024), int((90 - lat) / 180 * 512)
    idx[row, col] = 7
    tiles = dict(hfp.tiles_for_level(idx, z))
    assert sorted(tiles) == [(x, y) for x in range(4) for y in range(2)]
    (x, y), px, py = (col // 256, row // 256), col % 256, row % 256
    assert (x, y) == (2, 0)
    assert tiles[(x, y)][py, px] == 7
    assert int((tiles[(x, y)] != hfp.NODATA).sum()) == 1
    with pytest.raises(ValueError, match="1024 × 512"):
        dict(hfp.tiles_for_level(idx[:, :1000], z))


def test_render_reprojects_mollweide_by_area_average(tmp_path):
    tif = write_moll_tif(tmp_path / "h.tif", [(10, 45, 600, 30.0), (-60, -5, 600, 0.0)])
    eq = hfp.render_equirect(str(tif), 512)
    assert eq.shape == (256, 512)
    px = lambda lon, lat: eq[int((90 - lat) / 180 * 256), int((lon + 180) / 360 * 512)]  # noqa: E731
    assert px(10, 45) == pytest.approx(30.0)
    assert px(-60, -5) == pytest.approx(0.0)
    assert np.isnan(px(-150, 0)), "the open Pacific has no data"


def test_fetch_refuses_a_wrong_md5_cached_or_fetched_and_writes_only_a_checked_file(
    tmp_path,
):
    body = b"zip bytes"
    good = hashlib.md5(body, usedforsecurity=False).hexdigest()
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(body)

    epochs = {2000: (123, good)}
    p = hfp.fetch_epoch(tmp_path, 2000, fetch_to=fetch_to, epochs=epochs)
    assert p.read_bytes() == body and calls == [
        "https://ndownloader.figshare.com/files/123"
    ]
    assert (
        hfp.fetch_epoch(tmp_path, 2000, fetch_to=fetch_to, epochs=epochs) == p
        and len(calls) == 1
    ), "cached"
    with pytest.raises(ValueError, match="md5"):
        hfp.fetch_epoch(
            tmp_path, 2000, fetch_to=fetch_to, epochs={2000: (123, "0" * 32)}
        )
    p.unlink()
    with pytest.raises(ValueError, match="md5"):
        hfp.fetch_epoch(
            tmp_path, 2000, fetch_to=fetch_to, epochs={2000: (123, "0" * 32)}
        )
    assert not p.exists() and not list(tmp_path.glob("*.part")), (
        "a refused download leaves nothing behind"
    )


def test_main_writes_every_tile_of_every_epoch_and_a_manifest_the_layer_reads(tmp_path):
    epochs = {}
    for year, value in ((2000, 12.5), (2006, 20.0)):
        tif = write_moll_tif(tmp_path / f"hfp{year}.tif", [(10, 45, 600, value)])
        z = zip_tif(tif, tmp_path / f"src{year}.zip", f"hfp{year}.tif")
        epochs[year] = (year, md5(z))
    cache, out = tmp_path / "cache", tmp_path / "out"

    def fetch_to(url, path):
        path.write_bytes((tmp_path / f"src{url.rsplit('/', 1)[1]}.zip").read_bytes())

    hfp.main(
        ["--cache", str(cache), "--out-dir", str(out), "--max-level", "1"],
        fetch_to=fetch_to,
        epochs=epochs,
    )
    m = json.loads((out / "hfp.json").read_text())
    assert m["years"] == [2000, 2006]
    assert m["maxLevel"] == 1 and m["tile"] == "data/hfp/{year}/{z}/{x}/{y}.png"
    assert m["palette"] == [list(c) for c in hfp.palette()]
    assert (
        m["source"]["doi"] == "10.1038/s41597-022-01284-8"
        and "CC BY 4.0" in m["source"]["licence"]
    )
    for year, value in ((2000, 12.5), (2006, 20.0)):
        files = sorted(
            p.relative_to(out / "hfp" / str(year)).as_posix()
            for p in (out / "hfp" / str(year)).rglob("*.png")
        )
        assert files == ["0/0/0.png", "0/1/0.png"] + [
            f"1/{x}/{y}.png" for x in range(4) for y in range(2)
        ]
        im = Image.open(out / "hfp" / str(year) / "1" / "2" / "0.png")
        assert im.mode == "P"
        col, row = int((10 + 180) / 360 * 1024) % 256, int((90 - 45) / 180 * 512) % 256
        k = im.getpixel((col, row))
        assert (
            k == int(value)
            and tuple(im.getpalette()[3 * k : 3 * k + 3]) == hfp.palette()[k]
        )
        rgba = im.convert("RGBA")
        assert im.getpixel((0, 255)) == hfp.NODATA and rgba.getpixel((0, 255))[3] == 0
        assert rgba.getpixel((col, row)) == (*hfp.palette()[k], 255)


def test_render_averages_the_source_cells_under_a_pixel_not_one_of_them(tmp_path):
    tif = write_moll_tif(tmp_path / "s.tif", [], base=10.0)
    with rasterio.open(tif, "r+") as r:
        d = r.read(1)
        d[:, 1::2] = 30.0  # 50 km stripes, far finer than a 5.6° pixel
        r.write(d, 1)
    eq = hfp.render_equirect(str(tif), 64)
    assert 15 < eq[16, 32] < 25, f"{eq[16, 32]}: an area average of 10s and 30s, not one cell (nearest reads 10 or 30)"


def test_each_coarser_level_is_the_average_of_the_finer_one_not_a_sample_of_it():
    field = np.full((512, 1024), 10.0, np.float32)
    field[:, 1::2] = 30.0
    field[:, :2] = np.nan
    levels = dict(hfp.pyramid(field, 1))
    assert sorted(levels) == [0, 1]
    assert levels[1].shape == (512, 1024) and levels[0].shape == (256, 512)
    assert set(np.unique(levels[1])) == {10, 30, hfp.NODATA}
    assert (levels[0][:, 1:] == 20).all() and (levels[0][:, 0] == hfp.NODATA).all()
