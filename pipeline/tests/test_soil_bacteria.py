"""Soil bacterial richness pipeline: the pinned Zenodo zip, placement by the grid's own axes (never the stale
GeoTransform), whole-number rounding, the value-tile encoding the layer decodes, the display bins, the checks that stop
the run, and the real release at pre-registered cells (spec 2026-10-07-soil-bacteria-design.md)."""

import hashlib
import json
import os
import warnings
import zipfile
from pathlib import Path

import netCDF4
import numpy as np
import pytest
from PIL import Image

from pipeline import soil_bacteria as sb

CACHE = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))
LAT = 89.95 - 0.1 * np.arange(1800)
LON = -179.95 + 0.1 * np.arange(3600)
STALE = "-180.0 0.0099999984 0.0 83.999167206 0.0 -0.0099999984"  # what the release's spatial_ref carries


def write_nc(
    path: Path,
    grid: np.ndarray,
    *,
    lat=LAT,
    lon=LON,
    geotransform=STALE,
    name="richness",
    dims=("lat", "lon"),
):
    """A netCDF-4 file shaped like the release's: richness(lat, lon) float64, NaN fill, a spatial_ref with a
    GeoTransform attribute."""
    with netCDF4.Dataset(path, "w", format="NETCDF4") as ds:
        ds.createDimension("lat", len(lat))
        ds.createDimension("lon", len(lon))
        for k, v in (("lat", lat), ("lon", lon)):
            ds.createVariable(k, "f8", (k,), fill_value=np.nan)[:] = v
        ref = ds.createVariable("spatial_ref", "i4")
        ref.grid_mapping_name = "latitude_longitude"
        if geotransform is not None:
            ref.GeoTransform = geotransform
        var = ds.createVariable(
            name, "f8", dims, fill_value=np.nan, zlib=True, complevel=1
        )
        var.coordinates = "spatial_ref"
        var[:] = grid
    return path


def read_nc(tmp_path, grid, **kw):
    p = write_nc(tmp_path / "g.nc", grid, **kw)
    with netCDF4.Dataset(p) as ds:
        return sb.read_grid(ds)


def marked(cells: dict, base=np.nan) -> np.ndarray:
    g = np.full((1800, 3600), base, np.float64)
    for (r, c), v in cells.items():
        g[r, c] = v
    return g


# one marked cell near each edge of the grid, both sides of 180° and of the equator / prime meridian
EDGE = {
    (0, 0): (201.0, 11.0),  # 89.95 N, 179.95 W
    (0, 3599): (302.0, 22.0),  # 89.95 N, 179.95 E
    (1799, 0): (403.0, 33.0),  # 89.95 S, 179.95 W
    (1799, 3599): (504.0, 44.0),  # 89.95 S, 179.95 E
    (899, 1799): (605.0, 255.0),  # 0.05 N, 0.05 W
    (900, 1800): (706.0, 256.0),  # 0.05 S, 0.05 E
    (329, 1625): (807.0, 269.0),  # 57.05 N, 17.45 W
}


def pair(cells=EDGE):
    return marked({k: m for k, (m, _) in cells.items()}), marked(
        {k: s for k, (_, s) in cells.items()}
    )


def centre(row, col):
    return 89.95 - 0.1 * row, -179.95 + 0.1 * col


def pixel(lat, lon, z=sb.MAX_LEVEL):
    """(tile x, tile y, px, py) under a point, by the arithmetic of the layer's geoTilePixel."""
    n = sb.TILE * 2 ** (z + 1)
    gx = int(np.floor((lon + 180) / 360 * n))
    gy = min(int(np.floor((90 - lat) / 180 * (n // 2))), n // 2 - 1)
    return gx // sb.TILE, gy // sb.TILE, gx % sb.TILE, gy % sb.TILE


def decode(rgba):
    """The spec's decoding, written here from the spec, not from the pipeline: (mean, SD) or None for no data."""
    r, g, b, a = (int(v) for v in rgba)
    if a == 0:
        assert (r, g, b) == (0, 0, 0)
        return None
    assert a == 255
    return r + 256 * (b % 16), g + 256 * (b // 16)


def read_value(out: Path, lat, lon):
    x, y, px, py = pixel(lat, lon)
    return decode(
        Image.open(out / "value" / str(x) / f"{y}.png")
        .convert("RGBA")
        .getpixel((px, py))
    )


# ── fetch ────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_the_zip_is_used_only_when_its_md5_is_zenodos(tmp_path):
    src = tmp_path / "src.zip"
    src.write_bytes(b"PK not really a zip, only bytes to hash")
    want = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(src.read_bytes())

    cache = tmp_path / "cache"
    p = sb.fetch(cache, fetch_to=fetch_to, md5=want)
    assert p == cache / "ensemble.zip" and p.read_bytes() == src.read_bytes()
    assert calls == [
        "https://zenodo.org/api/records/21133869/files/ensemble.zip/content"
    ]
    assert sb.fetch(cache, fetch_to=fetch_to, md5=want) == p and len(calls) == 1, (
        "cached"
    )
    with pytest.raises(
        ValueError, match="ensemble.zip: md5 .* is not Zenodo's 0{32}; delete it"
    ):
        sb.fetch(cache, fetch_to=fetch_to, md5="0" * 32)
    p.unlink()
    with pytest.raises(ValueError, match="ensemble.zip: md5 .* is not Zenodo's 0{32}$"):
        sb.fetch(cache, fetch_to=fetch_to, md5="0" * 32)
    assert not p.exists() and not list(cache.glob("*.part")), (
        "a refused download leaves nothing"
    )
    assert sb.ZIP_MD5 == "822beb1e913521d4831b4d12320f4278"


# ── the grid ─────────────────────────────────────────────────────────────────────────────────────────────────────


def test_placement_comes_from_the_axes_and_the_stale_geotransform_is_never_read(
    tmp_path,
):
    mean, _ = pair()
    # the release's stale 0.01° transform topped at 84° N, one agreeing with the axes, nonsense, and none: the same grid
    for gt in (STALE, "-180.0 0.1 0.0 90.0 0.0 -0.1", "0 1 0 0 0 1", None):
        p = write_nc(tmp_path / "g.nc", mean, geotransform=gt)
        with netCDF4.Dataset(p) as ds:
            assert getattr(ds["spatial_ref"], "GeoTransform", None) == gt, (
                "the fixture carries it"
            )
            got = sb.read_grid(ds)
        assert np.array_equal(got, mean, equal_nan=True), gt


@pytest.mark.parametrize("axis", ["lat", "lon"])
def test_a_grid_off_the_global_tenth_degree_axes_is_refused_on_either_axis(
    tmp_path, axis
):
    mean, _ = pair()
    assert read_nc(tmp_path, mean).shape == (
        1800,
        3600,
    )  # positive control: the release's axes
    good = {"lat": LAT, "lon": LON}[axis]
    shifted = good + 0.1  # every centre one cell over
    flipped = good[::-1]  # south first / east first
    one_off = good.copy()
    one_off[700] += 0.01  # a single centre off the grid
    for bad, why in (
        (shifted, "shifted"),
        (flipped, "flipped"),
        (one_off, "one centre off"),
    ):
        with pytest.raises(
            ValueError, match=f"{axis} axis .* is not {len(good)} centres from"
        ):
            read_nc(tmp_path, mean, **{axis: bad})
    # a cropped or coarser axis (the grid cut to match)
    for n, step in ((len(good) - 1, 0.1), (len(good) // 2, 0.2)):
        ax = good[0] + np.sign(good[1] - good[0]) * step * np.arange(n)
        g = mean[: n if axis == "lat" else 1800, : n if axis == "lon" else 3600]
        with pytest.raises(ValueError, match=f"{axis} axis .* \\({n}\\) is not"):
            read_nc(tmp_path, g, **{axis: ax})


def test_the_variable_and_its_dimension_order_are_checked(tmp_path):
    mean, _ = pair()
    with pytest.raises(ValueError, match="no `richness` variable"):
        read_nc(tmp_path, mean, name="diversity")
    with pytest.raises(
        ValueError, match=r"richness dims \('lon', 'lat'\) are not \(lat, lon\)"
    ):
        read_nc(tmp_path, mean.T.copy(), dims=("lon", "lat"))
    assert np.array_equal(read_nc(tmp_path, mean), mean, equal_nan=True)


# ── values ───────────────────────────────────────────────────────────────────────────────────────────────────────


def test_whole_numbers_round_half_up_not_to_even_and_not_down():
    cells = {
        (10, 10): (182.5, 268.5),
        (10, 11): (183.5, 63.49),
        (10, 12): (183.7, 63.7),
        (10, 13): (895.17, 0.0),
    }
    m, s, ok = sb.check_pair(*pair(cells))
    got = [(int(m[r, c]), int(s[r, c])) for r, c in cells]
    # banker's rounding gives 182 and 268 for the first; truncation 183, 63 for the third
    assert got == [(183, 269), (184, 63), (184, 64), (895, 0)]
    assert m.dtype == np.uint16 and int(ok.sum()) == 4 and m[0, 0] == 0 and s[0, 0] == 0


def test_values_the_tiles_cannot_carry_or_blank_cells_that_differ_stop_the_run():
    mean, sd = pair()
    m, s, ok = sb.check_pair(mean, sd)  # positive control: every edge cell kept
    assert int(ok.sum()) == len(EDGE) and int(s[329, 1625]) == 269

    def bad(cell_mean=None, cell_sd=None, at=(5, 5)):
        mm, ss = mean.copy(), sd.copy()
        mm[at], ss[at] = (
            (300.0 if cell_mean is None else cell_mean),
            (100.0 if cell_sd is None else cell_sd),
        )
        return mm, ss

    cases = [
        (bad(cell_sd=np.nan), "blank in different cells \\(1 differ\\)"),
        (bad(cell_mean=np.nan), "blank in different cells"),
        (bad(cell_mean=np.inf), "1 mean cells are infinite"),
        (bad(cell_sd=-np.inf), "1 SD cells are infinite"),
        (bad(cell_mean=0.0), "a mean ≤ 0"),
        (bad(cell_sd=-0.5), "an SD < 0"),
        (bad(cell_sd=4095.5), "SD 4096 is over the 4095"),
        (bad(cell_mean=149.4), "means 149–807 reach outside the display range 150–900"),
        (bad(cell_mean=900.5), "means 201–901 reach outside"),
        ((marked({}), marked({})), "every cell is blank"),
    ]
    for (mm, ss), why in cases:
        with pytest.raises(ValueError, match=why):
            sb.check_pair(mm, ss)
    for mm, ss in (
        bad(cell_mean=149.5),
        bad(cell_mean=900.4),
        bad(cell_sd=4095.4),
        bad(cell_sd=0.0),
    ):
        sb.check_pair(mm, ss)  # the edges themselves are carried


def test_the_encoding_carries_every_whole_mean_and_sd_exactly():
    vals = np.array(
        [0, 1, 15, 16, 183, 255, 256, 269, 511, 512, 895, 1024, 4095], np.uint16
    )
    m, s = np.meshgrid(vals, vals, indexing="ij")
    ok = np.ones(m.shape, bool)
    ok[0, 0] = False
    rgba = sb.encode(m, s, ok)
    assert rgba.dtype == np.uint8 and rgba.shape == m.shape + (4,)
    for i in range(len(vals)):
        for j in range(len(vals)):
            want = None if (i, j) == (0, 0) else (int(vals[i]), int(vals[j]))
            assert decode(rgba[i, j]) == want, (vals[i], vals[j], rgba[i, j])
    # the bytes themselves, as the spec states them
    k = list(vals).index
    assert rgba[k(895), k(269)].tolist() == [895 % 256, 269 % 256, 3 + 16 * 1, 255]
    assert rgba[k(183), k(15)].tolist() == [183, 15, 0, 255]
    assert rgba[0, 0].tolist() == [0, 0, 0, 0], "no data: all zero"
    # blank means all zero whatever values the blank cell holds, not only a transparent alpha
    blank = sb.encode(
        np.array([[895, 895]], np.uint16),
        np.array([[269, 269]], np.uint16),
        np.array([[False, True]]),
    )
    assert blank.tolist() == [[[0, 0, 0, 0], [127, 13, 19, 255]]]
    with pytest.raises(ValueError, match="a value over 4095 cannot be encoded"):
        sb.encode(
            np.array([[4096]], np.uint16),
            np.array([[1]], np.uint16),
            np.ones((1, 1), bool),
        )
    with pytest.raises(ValueError, match="a value over 4095"):
        sb.encode(
            np.array([[1]], np.uint16),
            np.array([[4096]], np.uint16),
            np.ones((1, 1), bool),
        )


# ── tiles ────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_each_marked_cell_lands_in_its_own_pixels_and_its_neighbours_stay_blank(
    tmp_path,
):
    m, s, ok = sb.check_pair(*pair())
    sizes = sb.write_tiles(m, s, ok, tmp_path)
    assert sizes["display"] > 0 and sizes["value"] > 0
    for (r, c), (mv, sv) in EDGE.items():
        lat, lon = centre(r, c)
        want = (int(np.floor(mv + 0.5)), int(np.floor(sv + 0.5)))
        # the pixel under the cell's centre (the one the layer reads; off the centre a pixel may hold the next cell)
        assert read_value(tmp_path, lat, lon) == want, (r, c)
        # one cell over on each side: blank (where the globe goes on)
        for dr, dc in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            rr, cc = r + dr, (c + dc) % 3600
            if 0 <= rr < 1800 and (rr, cc) not in EDGE:
                assert read_value(tmp_path, *centre(rr, cc)) is None, (rr, cc)
        x, y, px, py = pixel(lat, lon)
        idx = Image.open(tmp_path / "3" / str(x) / f"{y}.png")
        assert (
            idx.mode == "P" and idx.getpixel((px, py)) == 1 + (want[0] - 150) // 10
        ), (r, c)


def test_every_level_3_pixel_holds_the_cell_its_centre_lies_in(tmp_path):
    # unique per column (SD = column) and per row (mean = 150 + row mod 750): any shift or flip of either axis shows
    rows, cols = np.mgrid[0:1800, 0:3600]
    mean = (150 + rows % 750).astype(np.float64)
    sd = cols.astype(np.float64)
    m, s, ok = sb.check_pair(mean, sd)
    sb.write_tiles(m, s, ok, tmp_path, max_level=3)
    full = np.zeros((2048, 4096, 4), np.uint8)
    for x in range(16):
        for y in range(8):
            full[y * 256 : (y + 1) * 256, x * 256 : (x + 1) * 256] = np.asarray(
                Image.open(tmp_path / "value" / str(x) / f"{y}.png").convert("RGBA")
            )
    r, g, b = (full[..., k].astype(int) for k in range(3))
    got_mean = r + 256 * (b % 16)
    got_sd = g + 256 * (b // 16)
    # the cell each pixel centre lies in, from the axes' cell edges (centre ± 0.05°), not from the resampling indices
    plon = -180 + (np.arange(4096) + 0.5) * 360 / 4096
    plat = 90 - (np.arange(2048) + 0.5) * 180 / 2048
    col_of = np.searchsorted(LON + 0.05, plon, side="right")
    row_of = np.searchsorted(-(LAT - 0.05), -plat, side="right")
    assert (np.abs(LON[col_of] - plon) <= 0.05).all() and (
        np.abs(LAT[row_of] - plat) <= 0.05
    ).all()
    assert np.array_equal(got_sd, np.broadcast_to(col_of[None, :], got_sd.shape))
    assert np.array_equal(
        got_mean, np.broadcast_to((150 + row_of % 750)[:, None], got_mean.shape)
    )
    assert (full[..., 3] == 255).all()


def test_display_bins_of_ten_from_150_and_coarser_levels_average_the_pixels_with_data():
    f = np.array([np.nan, 150, 159, 159.99, 160, 899, 900])
    # blank by the NaN mask, not by a NaN cast to uint8 (undefined; 0 on x86 only by chance, with a RuntimeWarning)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert sb.bins(f).tolist() == [0, 1, 1, 1, 2, 75, 75]
    assert sb.BINS == 75
    m = np.zeros((1800, 3600), np.uint16)
    ok = np.zeros((1800, 3600), bool)
    m[::2, ::2], ok[::2, ::2] = (
        300,
        True,
    )  # a quarter of the cells hold 300, the rest are blank
    lv = dict(sb.levels(m, ok))
    assert lv[3].shape == (2048, 4096) and lv[0].shape == (256, 512)
    assert (lv[0] == 1 + (300 - 150) // 10).all(), (
        "the mean over pixels with data, not over all pixels"
    )
    # alternate columns 200 and 400: a block's mean is neither its max nor its min
    m2 = np.full((1800, 3600), 200, np.uint16)
    m2[:, 1::2] = 400
    lv2 = dict(sb.levels(m2, np.ones((1800, 3600), bool)))
    assert (lv2[3] != 0).all() and set(np.unique(lv2[3]).tolist()) == {6, 26}
    # level 0 from first principles: the cell under each level-3 pixel centre (by the axes' cell edges), averaged over
    # the 8 × 8 level-3 pixels each level-0 pixel covers, then binned
    plon = -180 + (np.arange(4096) + 0.5) * 360 / 4096
    col_of = np.searchsorted(LON + 0.05, plon, side="right")
    level3 = np.where(col_of % 2, 400.0, 200.0)
    want0 = 1 + np.floor((level3.reshape(512, 8).mean(1) - 150) / 10)
    assert np.array_equal(lv2[0], np.broadcast_to(want0, (256, 512)))
    assert not np.isin(lv2[0], [6, 26]).any()


def test_palette_one_distinct_colour_per_bin_rising_in_luminance(monkeypatch):
    def luminance(c):
        lin = [
            x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
            for x in (v / 255 for v in c)
        ]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

    pal = sb.palette()
    assert len(pal) == 76 and len(set(pal[1:])) == 75
    assert pal[1] == sb.RAMP[0] == (204, 76, 2) and pal[75] == sb.RAMP[-1] == (
        255,
        255,
        229,
    )
    light = [luminance(c) for c in pal[1:]]
    assert light == sorted(light), "more richness reads lighter on the dark globe"
    monkeypatch.setattr(sb, "RAMP", [(10, 10, 10), (12, 12, 12)])
    with pytest.raises(ValueError, match="fewer than 75 distinct colours"):
        sb.palette()


def test_every_tile_is_written_in_the_form_the_site_decodes(tmp_path):
    m, s, ok = sb.check_pair(*pair())
    sb.write_tiles(m, s, ok, tmp_path)
    for z in range(4):
        tiles = sorted((tmp_path / str(z)).rglob("*.png"))
        assert len(tiles) == 2 ** (z + 1) * 2**z, z
        for p in tiles:
            head = p.read_bytes()[:26]
            # src/data/pngDecode.js reads 8-bit only: bit depth 8, palette (3)
            assert head[12:16] == b"IHDR" and (head[24], head[25]) == (8, 3), p
    values = sorted((tmp_path / "value").rglob("*.png"))
    assert len(values) == 128
    for p in values:
        head = p.read_bytes()[:26]
        assert head[12:16] == b"IHDR" and (head[24], head[25]) == (8, 6), p  # RGBA
    t = Image.open(tmp_path / "3" / "0" / "0.png")
    assert t.getpalette()[:6] == [0, 0, 0, 204, 76, 2]
    alpha = t.convert("RGBA").getchannel("A")
    # the NW corner cell (row 0, column 0) is under pixel 0, 0; the rest of the tile is blank
    assert (alpha.getpixel((0, 0)), alpha.getpixel((100, 100))) == (255, 0), (
        "a bin is opaque, blank is transparent"
    )
    # Pillow packs a short palette into fewer bits unless told not to (the IFL tiles, 2026-10-04): a 3-colour palette
    # still writes bit depth 8
    small = sb.png_palette(np.array([[0, 1], [2, 1]], np.uint8), sb.palette()[:3])
    assert small[12:16] == b"IHDR" and (small[24], small[25]) == (8, 3)


# ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────────


def write_zip(d: Path, mean: np.ndarray, sd: np.ndarray, **kw) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    z = d / "ensemble.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, g in (
            (sb.MEAN, mean),
            (sb.SD, sd),
            ("fungi_mean.nc", mean * 0 + 999),
        ):
            zf.write(write_nc(d / name, g, **kw), name)
    return z


def test_main_publishes_tiles_and_manifest_and_nothing_over_budget(tmp_path):
    src = write_zip(tmp_path / "src", *pair())
    want = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()

    def fetch_to(url, path):
        path.write_bytes(src.read_bytes())

    out = tmp_path / "out"
    args = ["--cache", str(tmp_path / "cache"), "--out-dir", str(out)]
    assert sb.main(args, fetch_to=fetch_to, md5=want) == 0
    man = json.loads((out / "soil_bacteria.json").read_text())
    assert (man["maxLevel"], man["mean"], man["sd"]) == (3, [201, 807], [11, 269])
    assert man["tile"] == "data/soil_bacteria/{z}/{x}/{y}.png"
    assert man["valueTile"] == "data/soil_bacteria/value/{x}/{y}.png"
    assert man["palette"] == [list(c) for c in sb.palette()]
    assert man["display"] == {"min": 150, "max": 900, "step": 10}
    assert man["model"] == {
        "r2": 0.41,
        "r2Sd": 0.09,
        "r2Max": 0.62,
        "locations": 320,
        "reads": 7500,
    }
    assert (
        man["source"]["licence"].startswith("CC BY 4.0")
        and "10.1093/ismeco/ycag266" in man["source"]["citation"]
    )
    assert read_value(out / "soil_bacteria", *centre(329, 1625)) == (807, 269)
    assert not (tmp_path / "cache" / "soil_richness" / sb.MEAN).exists(), (
        "read from the zip, not extracted"
    )
    before = (out / "soil_bacteria.json").read_bytes()
    total = sum(man["bytes"].values())
    with pytest.raises(
        SystemExit,
        match=f"{total:,} B of tiles is over the {total - 1:,} B budget: nothing published",
    ):
        sb.main([*args, "--budget", str(total - 1)], fetch_to=fetch_to, md5=want)
    assert (out / "soil_bacteria.json").read_bytes() == before and (
        out / "soil_bacteria" / "3"
    ).is_dir()
    assert not (out / ".soil_bacteria.tmp").exists()
    assert sb.main([*args, "--budget", str(total)], fetch_to=fetch_to, md5=want) == 0, (
        "exactly at the budget"
    )
    assert sb.BUDGET_BYTES == 5_000_000


# Pre-registered 2026-10-07 from the raw files with xarray (.sel(method="nearest") at the cell centre), before the
# pipeline ran on the release: cell centre → (mean, SD) rounded half up, or None where the model is blank. Coastal
# cells were found by walking in from the sea; the antimeridian pairs sit either side of 180°.
CELLS = {
    "Senegal, west coast": ((14.75, -17.45), (734, 190)),
    "Somalia, east coast": ((2.05, 45.25), (758, 203)),
    "Libya, north coast": ((32.35, 15.05), (774, 210)),
    "South Africa, south coast": ((-34.75, 20.05), (727, 192)),
    "Chile, west coast": ((-33.45, -71.65), (733, 194)),
    "Australia, north coast": ((-11.25, 132.05), (781, 209)),
    "Australia, south coast": ((-33.65, 135.05), (752, 205)),
    "Chukotka, 179.95 E": ((67.05, 179.95), (537, 139)),
    "Chukotka, 179.95 W": ((67.05, -179.95), (467, 128)),
    "Fiji, 179.95 E": ((-16.85, 179.95), (551, 150)),
    "Fiji, 179.95 W": ((-16.85, -179.95), (632, 172)),
    "central Amazon": ((-3.05, -60.05), (509, 135)),
    "Sahara": ((23.05, 10.05), (266, 94)),
    "Antarctica": ((-80.05, 0.05), None),
    "mid Pacific": ((0.05, -149.95), None),
    "South Atlantic": ((-30.05, -15.05), None),
}


# Not skipped when the cache is empty: main downloads the release through the pinned fetcher (Zenodo md5), so a fresh
# CI runner checks the published tiles against the real source too.
def test_real_release_cells_read_the_values_of_the_raw_files(tmp_path):
    assert sb.main(["--cache", str(CACHE), "--out-dir", str(tmp_path)]) == 0
    man = json.loads((tmp_path / "soil_bacteria.json").read_text())
    assert (man["mean"], man["sd"]) == ([183, 895], [63, 269])
    assert sum(man["bytes"].values()) <= sb.BUDGET_BYTES
    for name, ((lat, lon), want) in CELLS.items():
        assert read_value(tmp_path / "soil_bacteria", lat, lon) == want, name
