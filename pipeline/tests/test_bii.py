"""Biodiversity Intactness Index pipeline: the pinned release, the 5' grid, nearest resampling, bins, the tile pyramid, the
budget (spec 2026-10-03-bii-design.md)."""

import hashlib
import json
import os
import zipfile
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import Affine, from_origin, rowcol

from pipeline import bii

GLOBAL_5MIN = from_origin(-180, 90, 1 / 12, 1 / 12)
REAL_ZIP = (
    Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))
    / "bii"
    / bii.ZIP_NAME
)


def write_tif(path, data, transform=GLOBAL_5MIN):
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=data.shape[1],
        height=data.shape[0],
        count=1,
        dtype="float64",
        crs="EPSG:4326",
        transform=transform,
        nodata=np.nan,
    ) as dst:
        dst.write(data, 1)
    return path


# Cell centres, never boundaries: on a multiple of 1/12° the release's float-noise transform and plain index arithmetic
# pick different cells (a boundary point at -10, -63 read three different cells three ways, 2026-10-03).
POINTS = {
    "amazon": (-3.5417, -62.4583),
    "siberia": (61.9583, 105.0417),
    "iowa": (41.9583, -93.4583),
    "paris": (48.875, 2.375),
    "rondonia": (-10.0417, -63.0417),
    "pacific": (0.0417, -149.9583),
}
RONDONIA_BOX = (-13.7, -7.9, -66.8, -59.8)  # S, N, W, E


def global_grid(fill=np.nan, cells=()):
    """The 4320 × 2160 5' grid: `fill` everywhere, then (lat, lon, value) set in the cell that holds the point."""
    a = np.full((2160, 4320), fill, np.float64)
    for lat, lon, value in cells:
        a[int((90 - lat) * 12), int((lon + 180) * 12)] = value
    return a


def make_zip(tmp_path, years_values):
    z = tmp_path / bii.ZIP_NAME
    with zipfile.ZipFile(z, "w") as zf:
        for year, cells in years_values.items():
            tif = write_tif(tmp_path / f"{year}.tif", global_grid(cells=cells))
            zf.write(tif, bii.TIF.format(year=year))
    return z, hashlib.sha256(z.read_bytes()).hexdigest()


def test_palette_is_100_distinct_colours_pale_to_dark_and_bins_are_floor_with_99_closed():
    pal = bii.palette()
    assert len(pal) == 100 and len(set(pal)) == 100
    assert pal[0] == (255, 255, 229) and pal[-1] == (0, 69, 41)
    a = np.array([[0.0, 0.42, 1.0, 64.9], [98.999, 99.0, 100.0, np.nan]])
    assert bii.quantise(a).tolist() == [[0, 0, 1, 64], [98, 99, 99, bii.NODATA]]
    for bad in (100.01, -0.01):
        with pytest.raises(ValueError, match="outside 0–100"):
            bii.quantise(np.array([[bad]]))


def test_the_grid_check_takes_the_release_transform_and_refuses_any_other():
    # the release's own transform, float noise included (read from bii-2000_v2-1-1.tif)
    real = Affine(
        0.08333333333333869, 0.0, -180.0, 0.0, -0.08333333333333869, 90.00000000001157
    )
    bii.check_grid(real, 4320, 2160)
    for t, w, h in [
        (real, 4319, 2160),
        (from_origin(-180, 90, 0.1, 0.1), 3600, 1800),
        (from_origin(-179.5, 90, 1 / 12, 1 / 12), 4320, 2160),
    ]:
        with pytest.raises(ValueError, match="not global 5 arc-minutes"):
            bii.check_grid(t, w, h)


def test_nearest_puts_each_source_cell_where_its_lon_lat_is_and_a_pixel_takes_one_value():
    src = global_grid(cells=[(45.3, 10.2, 64.5), (*POINTS["rondonia"], 40.7)])
    out = bii.nearest(
        src, 1024
    )  # 0.3515625° a pixel: coarser than the source here, still one cell per pixel
    assert out.shape == (512, 1024)
    vals = set(np.unique(out[~np.isnan(out)]).tolist())
    assert vals <= {64.5, 40.7}, "never a blend of cells"
    fine = bii.nearest(src, 8192)
    for lat, lon, v in [(45.3, 10.2, 64.5), (*POINTS["rondonia"], 40.7)]:
        r, c = int((90 - lat) / 180 * 4096), int((lon + 180) / 360 * 8192)
        assert fine[r, c] == pytest.approx(v)
    # a 1/12° cell is 1.9 pixels wide at 8192: 1 or 2 pixels a side, so each cell paints 1-4 pixels
    assert 2 <= int((~np.isnan(fine)).sum()) <= 8
    assert np.isnan(fine[2048, 0]), "the open Pacific has no data"


def test_each_coarser_level_is_the_average_of_the_finer_one_not_a_sample_of_it():
    field = np.full((512, 1024), 10.0, np.float32)
    field[:, 1::2] = 30.0
    field[:, :2] = np.nan
    levels = dict(bii.pyramid(field, 1))
    assert sorted(levels) == [0, 1]
    assert levels[1].shape == (512, 1024) and levels[0].shape == (256, 512)
    assert set(np.unique(levels[1]).tolist()) == {10, 30, bii.NODATA}
    assert (levels[0][:, 1:] == 20).all(), (
        "a 2 × 2 mean of 10s and 30s, not one of them"
    )
    assert (levels[0][:, 0] == bii.NODATA).all(), "an all-empty block stays empty"


def test_the_release_zip_is_read_only_when_it_is_the_pinned_file(tmp_path):
    with pytest.raises(SystemExit, match="Cloudflare challenge"):
        bii.checked_zip(tmp_path)
    p = tmp_path / bii.ZIP_NAME
    p.write_bytes(b"zip bytes")
    good = hashlib.sha256(b"zip bytes").hexdigest()
    assert bii.checked_zip(tmp_path, good) == p
    with pytest.raises(ValueError, match="not the pinned release"):
        bii.checked_zip(tmp_path, "0" * 64)


def test_main_writes_every_tile_of_every_year_then_the_manifest_and_nothing_over_budget(
    tmp_path,
):
    z, sha = make_zip(
        tmp_path,
        {2000: [(*POINTS["rondonia"], 40.7)], 2020: [(*POINTS["rondonia"], 39.8)]},
    )
    cache, out = z.parent, tmp_path / "out"
    years = (2000, 2020)
    bii.main(
        ["--cache", str(cache), "--out-dir", str(out)],
        want_sha256=sha,
        years=years,
    )
    m = json.loads((out / "bii.json").read_text())
    assert m["years"] == [2000, 2020] and m["maxLevel"] == 4
    assert m["tile"] == "data/bii/{year}/{z}/{x}/{y}.png"
    assert m["palette"] == [list(c) for c in bii.palette()]
    assert (
        m["source"]["doi"] == "10.5519/k33reyb6"
        and "CC BY-NC-SA 4.0" in m["source"]["licence"]
    )
    for year, want in ((2000, 40), (2020, 39)):
        files = sorted(
            p.relative_to(out / "bii" / str(year)).as_posix()
            for p in (out / "bii" / str(year)).rglob("*.png")
        )
        assert files == sorted(
            f"{z}/{x}/{y}.png"
            for z in range(5)
            for x in range(2 ** (z + 1))
            for y in range(2**z)
        ), "every tile of levels 0-4, empty ones too"
        lat, lon = POINTS["rondonia"]
        col, row = int((lon + 180) / 360 * 8192), int((90 - lat) / 180 * 4096)
        im = Image.open(
            out / "bii" / str(year) / "4" / str(col // 256) / f"{row // 256}.png"
        )
        assert im.mode == "P" and im.getpixel((col % 256, row % 256)) == want
        rgba = im.convert("RGBA")
        assert rgba.getpixel((col % 256, row % 256)) == (*bii.palette()[want], 255)
        assert rgba.getpixel((0, 0))[3] == 0, "no data is transparent"
    assert not (out / ".bii.tmp").exists()

    # over budget: nothing published, the earlier release untouched
    before = (out / "bii.json").read_bytes()
    with pytest.raises(SystemExit, match="over the 10 B budget"):
        bii.main(
            [
                "--cache",
                str(cache),
                "--out-dir",
                str(out),
                "--budget",
                "10",
            ],
            want_sha256=sha,
            years=years,
        )
    assert (out / "bii.json").read_bytes() == before
    assert (out / "bii" / "2000" / "4" / "31" / "15.png").exists()
    assert not (out / ".bii.tmp").exists()

    # coarser than the source, nearest neighbour would skip cells: refused before anything is read
    with pytest.raises(SystemExit, match="coarser than the 5' source"):
        bii.main(
            [
                "--cache",
                str(cache),
                "--out-dir",
                str(tmp_path / "coarse"),
                "--max-level",
                "3",
            ],
            want_sha256=sha,
            years=years,
        )
    assert not (tmp_path / "coarse").exists()


@pytest.mark.skipif(
    not REAL_ZIP.exists(),
    reason=f"{REAL_ZIP} absent: the release needs a browser download",
)
def test_real_release_every_level_4_pixel_is_the_bin_of_the_source_cell_under_its_centre():
    zip_path = bii.checked_zip(REAL_ZIP.parent)
    w = 8192
    lons = -180 + (np.arange(w) + 0.5) * 360 / w
    lats = 90 - (np.arange(w // 2) + 0.5) * 180 / (w // 2)
    for year in bii.YEARS:
        src = bii.read_year(zip_path, year)
        with rasterio.open(
            f"/vsizip/{zip_path.resolve()}/{bii.TIF.format(year=year)}"
        ) as r:
            # rasterio's own transform, not the pipeline's index arithmetic
            rows = np.array(rowcol(r.transform, np.zeros_like(lats), lats)[0])
            cols = np.array(rowcol(r.transform, lons, np.zeros_like(lons))[1])
        expect = bii.quantise(src[np.ix_(rows, cols)])
        got = bii.quantise(bii.nearest(src, w))
        assert (got == expect).all(), (
            f"{year}: {int((got != expect).sum())} pixels differ"
        )
    # the grill's pre-registered contrasts, on the source, at cell centres
    v, box = {}, {}
    s_, n_, w_, e_ = RONDONIA_BOX
    for year in bii.YEARS:
        src = bii.read_year(zip_path, year)
        v[year] = {
            k: src[int((90 - lat) * 12), int((lon + 180) * 12)]
            for k, (lat, lon) in POINTS.items()
        }
        box[year] = float(
            np.nanmean(
                src[
                    int((90 - n_) * 12) : int((90 - s_) * 12),
                    int((w_ + 180) * 12) : int((e_ + 180) * 12),
                ]
            )
        )
    for year in bii.YEARS:
        s = v[year]
        assert min(s["amazon"], s["siberia"]) > s["iowa"] > s["paris"], (year, s)
        assert np.isnan(s["pacific"]), (year, s)
    # the frontier: Rondônia's mean intactness falls at every snapshot (80.8 → 74.6 in v2.1.1); one cell is too
    # noisy to carry this (a neighbour of the QA cell rises 29.7 → 32.7)
    falls = [box[a] > box[b] for a, b in zip(bii.YEARS, bii.YEARS[1:])]
    assert all(falls), box
    assert v[2020]["rondonia"] < v[2000]["rondonia"], "the QA cell, 40.72 → 39.82"
