"""Tidal marshes 2020: the pinned zip, its GeoTIFFs' profile, exact marsh shares per cell across a seam, the output.

The fixture is the release's own layout (Final_Rasters/ + four GeoTIFFs) holding verbatim windows of the real v2.6
rasters: The Wash, either side of the 0° meridian where the 10W_50N and 0E_50N tiles meet and overlap by one pixel
column; and Adak Island in the Aleutians, either side of the antimeridian, where 180W_50N is georeferenced at 180-190°E
(its first column's centre just west of 180°) and 170E_50N ends at 180°. Expected counts are made here pixel by pixel
with np.add.at, not with the pipeline's reduceat path, from longitudes taken modulo 360.
"""

import hashlib
import io
import json
import math
from fractions import Fraction
import shutil
import zipfile
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from pipeline import tidal_marsh as tm

FIX = Path(__file__).parent / "fixtures" / "tidal_marsh" / "tidal_marsh_v2_6.zip"
SHA = hashlib.sha256(FIX.read_bytes()).hexdigest()
NAMES = [
    "Final_Rasters/tidal_marsh_0E_50N_v2_6.tif",
    "Final_Rasters/tidal_marsh_10W_50N_v2_6.tif",
    "Final_Rasters/tidal_marsh_170E_50N_v2_6.tif",
    "Final_Rasters/tidal_marsh_180W_50N_v2_6.tif",
]
ADAK = 645  # marsh pixels in the 180W_50N window


def rasters():
    out = []
    for name in NAMES:
        with rasterio.open(f"/vsizip/{FIX}/{name}") as src:
            out.append((src.read(1), src.transform))
    return out


def brute(z):
    """(marsh, total) per global level-z pixel, one source pixel at a time."""
    marsh, total = {}, {}
    for a, t in rasters():
        h, w = a.shape
        lon = t.c + (np.arange(w) + 0.5) * t.a
        lat = t.f + (np.arange(h) + 0.5) * t.e
        gx = np.floor((lon + 180) % 360 / 360 * 2 ** (z + 1) * 256).astype(int)
        gy = np.floor((90 - lat) / 180 * 2**z * 256).astype(int)
        GX, GY = np.meshgrid(gx, gy)
        for d, vals in ((marsh, a), (total, np.ones_like(a))):
            keys, inv = np.unique(
                np.stack([GX.ravel(), GY.ravel()]), axis=1, return_inverse=True
            )
            sums = np.zeros(keys.shape[1], np.int64)
            np.add.at(sums, inv.ravel(), vals.ravel().astype(np.int64))
            for (x, y), s in zip(keys.T, sums):
                d[(int(x), int(y))] = d.get((int(x), int(y)), 0) + int(s)
    return marsh, total


def run(z):
    marsh, grids, km2 = {}, [], 0.0
    for name in NAMES:
        with rasterio.open(f"/vsizip/{FIX}/{name}") as src:
            tm.check_profile(src, name)
            grids.append(tm.Grid(src.transform, src.width, src.height, z))
            km2 += tm.accumulate(src, z, marsh, band_rows=500)
    return marsh, grids, km2


def flat(tiles):
    return {
        (tx * 256 + int(c), ty * 256 + int(r)): int(arr[r, c])
        for (tx, ty), arr in tiles.items()
        for r, c in zip(*np.nonzero(arr))
    }


def test_marsh_and_all_pixels_are_counted_exactly_per_cell_across_the_seam():
    want_marsh, want_total = brute(9)
    marsh, grids, _ = run(9)
    got = flat(marsh)
    assert got == {k: v for k, v in want_marsh.items() if v}
    assert (
        sum(got.values()) == 1136 + 374795 + ADAK
    )  # every marsh pixel of every window, the overlap column in both
    tot = flat(tm.totals(marsh, grids, 9, 9))
    assert {k: tot[k] for k in got} == {k: want_total[k] for k in got}
    # a cell the seam runs through takes pixels from both GeoTIFFs: the two grids meet inside it
    xs = [g.gx for g in grids]
    (sx,) = set(xs[0].tolist()) & set(xs[1].tolist())
    gy = int(grids[0].gy[1000])
    key, rc = (sx // 256, gy // 256), (gy % 256, sx % 256)
    both = int(tm.totals([key], grids, 9, 9)[key][rc])
    one, other = (int(tm.totals([key], [g], 9, 9)[key][rc]) for g in grids[:2])
    assert both == want_total[(sx, gy)] == one + other and one > 0 and other > 0
    assert all(type(x) is int for k in marsh for x in k)  # the keys go into JSON
    # coarser levels: the children's marsh summed, the totals from the grids, both as counted from the pixels
    for z in (8, 6, 3):
        parent = marsh
        for _ in range(9 - z):
            parent = tm.coarser(parent)
        want_marsh_z, want_total_z = brute(z)
        got_z = flat(parent)
        assert got_z == {k: v for k, v in want_marsh_z.items() if v}, z
        tot_z = flat(tm.totals(parent, grids, z, 9))
        assert {k: tot_z[k] for k in got_z} == {k: want_total_z[k] for k in got_z}, z


def test_the_antimeridian_wraps_west_of_180_and_its_seam_cell_takes_both_sides():
    marsh, grids, _ = run(9)
    width = 2**10 * 256
    for z in range(9, -1, -1):
        assert all(0 <= x < 2 ** (z + 1) and 0 <= y < 2**z for x, y in marsh), z
        if z:
            marsh = tm.coarser(marsh)
    marsh, grids, _ = run(9)
    adak = {k: v for k, v in flat(marsh).items() if k[0] < width // 36}  # west of 170°W
    assert sum(adak.values()) == ADAK
    lons = [(gx + 0.5) / width * 360 - 180 for gx, _ in adak]
    assert -178.0 < min(lons) and max(lons) < -176.6  # Adak Island, 177°W: not 182°E
    # 180W_50N's first column (centre 179.99996°E) and 170E_50N's last share the easternmost column of cells
    east, west = grids[2], grids[3]
    assert int(east.gx[-1]) == int(west.gx[0]) == width - 1 and int(west.gx[1]) == 0
    gy = int(west.gy[50])
    key, rc = ((width - 1) // 256, gy // 256), (gy % 256, (width - 1) % 256)
    _, want_total = brute(9)
    both = int(tm.totals([key], grids, 9, 9)[key][rc])
    one, other = (int(tm.totals([key], [g], 9, 9)[key][rc]) for g in (east, west))
    assert both == want_total[(width - 1, gy)] == one + other and one > 0 and other > 0


def test_marsh_area_is_each_pixel_on_the_sphere():
    _, _, km2 = run(9)
    want = 0.0
    for a, t in rasters():
        top = np.radians(t.f + np.arange(a.shape[0]) * t.e)
        bottom = np.radians(t.f + (np.arange(a.shape[0]) + 1) * t.e)
        row_km2 = tm.EARTH_KM**2 * math.radians(t.a) * (np.sin(top) - np.sin(bottom))
        want += float(a.sum(axis=1) @ row_km2)
    assert km2 == pytest.approx(want, rel=1e-9)
    # ~6.2 x 10.0 m at 52.9°N: 375,931 pixels are about 23 km²
    assert 22 < km2 < 24


def test_shares_are_whole_percent_with_any_marsh_at_least_one():
    marsh = np.array([[0, 1, 2, 3, 50, 99, 100]], np.uint64)
    total = np.array([[100, 100, 200, 200, 100, 100, 100]], np.uint64)
    assert tm.shares(marsh, total).tolist() == [[0, 1, 1, 2, 50, 99, 100]]
    assert tm.shares(np.array([[1]]), np.array([[300]])).tolist() == [[1]]  # 0.3%: still drawn
    # exact halves round up: 57.5% (a real cell at The Wash), 1.5% and 3.5%
    assert tm.shares(np.array([[138, 3, 7]]), np.array([[240, 200, 200]])).tolist() == [[58, 2, 4]]
    with pytest.raises(tm.MarshChanged, match="no source pixel"):
        tm.shares(np.array([[1]]), np.array([[0]]))


def test_palette_runs_light_to_dark_through_the_stated_stops():
    p = tm.palette()
    assert len(p) == 101 and p[0] == [0, 0, 0]
    assert p[1] == [199, 233, 180] and p[50] == [29, 145, 192] and p[100] == [8, 29, 88]
    assert len({tuple(c) for c in p[1:]}) == 100
    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in p[1:]]
    assert all(a > b for a, b in zip(lum, lum[1:]))


def test_the_zip_is_fetched_once_and_refused_unless_pinned(tmp_path):
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        shutil.copy(FIX, path)

    with pytest.raises(tm.MarshChanged, match="is not the pinned"):
        tm.fetch(tmp_path, sha256="0" * 64, fetch_to=fetch_to)
    assert not list(tmp_path.iterdir())  # the refused download is not kept
    got = tm.fetch(tmp_path, sha256=SHA, fetch_to=fetch_to)  # positive control
    assert tm.fetch(tmp_path, sha256=SHA, fetch_to=fetch_to) == got
    assert calls == [tm.ZIP_URL] * 2  # the kept file is not fetched again
    got.write_bytes(b"changed")
    with pytest.raises(tm.MarshChanged, match="delete it to fetch again"):
        tm.fetch(tmp_path, sha256=SHA, fetch_to=fetch_to)


def test_only_the_release_layout_is_read(tmp_path):
    assert tm.members(FIX) == NAMES  # positive control

    def zipped(extra):
        p = tmp_path / "z.zip"
        shutil.copy(FIX, p)
        with zipfile.ZipFile(p, "a") as z:
            z.writestr(extra, b"x")
        return p

    for extra in [
        "Final_Rasters/readme.txt",
        "tidal_marsh_0E_0N_v2_6.tif",
        "Final_Rasters/tidal_marsh_0E_0N_v2_7.tif",
    ]:
        with pytest.raises(tm.MarshChanged, match="unexpected members"):
            tm.members(zipped(extra))

    with rasterio.open(f"/vsizip/{FIX}/{NAMES[0]}") as src:
        prof, a = src.profile, src.read(1)

    def tif(**change):
        p = tmp_path / "t.tif"
        data = change.pop("data", a)
        with rasterio.open(p, "w", **(prof | change)) as dst:
            for b in range(1, dst.count + 1):
                dst.write(data.astype(dst.dtypes[0]), b)
        return rasterio.open(p)

    with tif() as ok:
        tm.check_profile(ok, "same")  # positive control: the profile rewritten as is
    t = prof["transform"]
    for change, why in [
        ({"count": 2}, "2 bands"),
        ({"dtype": "uint16"}, "dtype uint16"),
        ({"crs": "EPSG:3857"}, "crs"),
        ({"transform": rasterio.Affine(t.a * 2, 0, t.c, 0, t.e * 2, t.f)}, "pixel"),
        ({"transform": rasterio.Affine(t.a, 0, t.c, 0, t.e, 61.0)}, "bounds"),
    ]:
        with tif(**change) as bad, pytest.raises(tm.MarshChanged, match=why):
            tm.check_profile(bad, "changed")
    two = a.copy()
    two[0, 0] = 2
    with tif(data=two) as bad, pytest.raises(tm.MarshChanged, match="values above 1"):
        tm.accumulate(bad, 9, {})


def test_main_writes_listed_8_bit_tiles_whose_pixels_are_the_shares(tmp_path):
    out = tmp_path / "out"
    m = tm.main(
        ["--out-dir", str(out), "--cache", str(tmp_path / "cache")],
        fetch_to=lambda url, path: shutil.copy(FIX, path),
        sha256=SHA,
    )
    assert json.loads((out / "tidal_marsh.json").read_text()) == m
    listed = {f"{z}/{x}/{y}.png" for z, xs in m["tiles"].items() for x, y in xs}
    written = {
        str(p.relative_to(out / "tidal_marsh"))
        for p in (out / "tidal_marsh").rglob("*.png")
    }
    assert listed == written and len(m["tiles"]) == tm.MAX_LEVEL + 1
    assert (
        m["members"] == 4
        and 22 < m["marshKm2"] < 24
        and m["source"]["licence"] == "CC BY 4.0"
    )
    # the readout decodes tiles with src/data/pngDecode.js, which reads 8-bit images only: IHDR bit depth 8, palette
    for p in (out / "tidal_marsh").rglob("*.png"):
        head = p.read_bytes()[:26]
        assert head[12:16] == b"IHDR" and (head[24], head[25]) == (8, 3), p
    # every painted level-9 pixel, decoded to RGBA as a browser does, is the palette colour of its counted share
    want_marsh, want_total = brute(9)
    colour = {tuple(c + [255]): i for i, c in enumerate(m["palette"]) if i}
    seen = 0
    for x, y in m["tiles"]["9"]:
        im = np.asarray(
            Image.open(
                io.BytesIO(
                    (out / "tidal_marsh" / "9" / str(x) / f"{y}.png").read_bytes()
                )
            ).convert("RGBA")
        )
        for r in range(256):
            for c in range(256):
                k = (x * 256 + c, y * 256 + r)
                px = tuple(int(v) for v in im[r, c])
                if want_marsh.get(k, 0):
                    pct = math.floor(Fraction(100 * want_marsh[k], want_total[k]) + Fraction(1, 2))
                    assert colour[px] == max(1, min(100, pct)), (k, px)
                    seen += 1
                else:
                    assert px[3] == 0, (k, px)
    assert seen == sum(1 for v in want_marsh.values() if v)
