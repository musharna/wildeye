"""Seagrass 2019-2020 and 2023-2024: the pinned zips, their GeoTIFFs' profile, exact seagrass shares per cell across a
tile seam, one pyramid per epoch.

The fixtures are the release's own layout (one zip per epoch: its folder + two GeoTIFFs) holding verbatim windows of the
real rasters at Card Sound, Florida, either side of 25.24°N, where two tiles of the export grid meet without overlap
inside one row of level-9 cells. Expected counts are made here pixel by pixel with np.add.at, and shares with Fraction.
"""

import hashlib
import io
import json
import math
import shutil
import zipfile
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from pipeline import cell_share as cs
from pipeline import seagrass as sg

FIX = Path(__file__).parent / "fixtures" / "seagrass"
EPOCHS = ["2019_2020", "2023_2024"]
PINS = {
    e: hashlib.sha256((FIX / sg.zip_name(e)).read_bytes()).hexdigest() for e in EPOCHS
}
# seagrass pixels in each epoch's two windows (north of the seam, south of it)
PIXELS = {"2019_2020": (241843, 228498), "2023_2024": (272200, 265801)}


def names(epoch):
    return [
        f"GlobalSeagrass{epoch}/GlobalSeagrass{epoch}-0000655360-0001048576.tif",
        f"GlobalSeagrass{epoch}/GlobalSeagrass{epoch}-0000720896-0001048576.tif",
    ]


def rasters(epoch):
    out = []
    for name in names(epoch):
        with rasterio.open(f"/vsizip/{FIX / sg.zip_name(epoch)}/{name}") as src:
            out.append((src.read(1), src.transform))
    return out


def brute(epoch, z):
    """(seagrass, total) per global level-z pixel, one source pixel at a time."""
    grass, total = {}, {}
    for a, t in rasters(epoch):
        h, w = a.shape
        lon = t.c + (np.arange(w) + 0.5) * t.a
        lat = t.f + (np.arange(h) + 0.5) * t.e
        gx = np.floor((lon + 180) % 360 / 360 * 2 ** (z + 1) * 256).astype(int)
        gy = np.floor((90 - lat) / 180 * 2**z * 256).astype(int)
        GX, GY = np.meshgrid(gx, gy)
        for d, vals in ((grass, a), (total, np.ones_like(a))):
            keys, inv = np.unique(
                np.stack([GX.ravel(), GY.ravel()]), axis=1, return_inverse=True
            )
            sums = np.zeros(keys.shape[1], np.int64)
            np.add.at(sums, inv.ravel(), vals.ravel().astype(np.int64))
            for (x, y), s in zip(keys.T, sums):
                d[(int(x), int(y))] = d.get((int(x), int(y)), 0) + int(s)
    return grass, total


def flat(tiles):
    return {
        (tx * 256 + int(c), ty * 256 + int(r)): int(arr[r, c])
        for (tx, ty), arr in tiles.items()
        for r, c in zip(*np.nonzero(arr))
    }


@pytest.mark.parametrize("epoch", EPOCHS)
def test_seagrass_and_all_pixels_are_counted_exactly_per_cell_across_the_seam(epoch):
    counts, grids, km2, n = sg.count_epoch(
        FIX / sg.zip_name(epoch), epoch, 9, band_rows=64
    )
    assert n == 2
    want_grass, want_total = brute(epoch, 9)
    got = flat(counts)
    assert got == {k: v for k, v in want_grass.items() if v}
    assert sum(got.values()) == sum(PIXELS[epoch])
    tot = flat(cs.totals(counts, grids, 9, 9))
    assert {k: tot[k] for k in got} == {k: want_total[k] for k in got}
    # the seam at 25.24°N runs inside a row of cells: that row takes pixels from both GeoTIFFs
    north, south = grids
    (gy,) = set(north.gy.tolist()) & set(south.gy.tolist())
    gx = int(north.gx[1000])
    key, rc = (gx // 256, gy // 256), (gy % 256, gx % 256)
    both = int(cs.totals([key], grids, 9, 9)[key][rc])
    one, other = (int(cs.totals([key], [g], 9, 9)[key][rc]) for g in grids)
    assert both == want_total[(gx, gy)] == one + other and one > 0 and other > 0
    for z in (8, 5):
        parent = counts
        for _ in range(9 - z):
            parent = cs.coarser(parent)
        want_grass_z, want_total_z = brute(epoch, z)
        got_z = flat(parent)
        assert got_z == {k: v for k, v in want_grass_z.items() if v}, z
        tot_z = flat(cs.totals(parent, grids, z, 9))
        assert {k: tot_z[k] for k in got_z} == {k: want_total_z[k] for k in got_z}, z
    # each 10 m pixel's area on the sphere: ~10.0 x 9.06 m at 25.2°N
    want_km2 = 0.0
    for a, t in rasters(epoch):
        top = np.radians(t.f + np.arange(a.shape[0]) * t.e)
        bottom = np.radians(t.f + (np.arange(a.shape[0]) + 1) * t.e)
        want_km2 += float(
            a.sum(axis=1)
            @ (cs.EARTH_KM**2 * math.radians(t.a) * (np.sin(top) - np.sin(bottom)))
        )
    assert km2 == pytest.approx(want_km2, rel=1e-9)
    assert 0.0906 * 0.95 < km2 / (sum(PIXELS[epoch]) * 1e-3) < 0.0906 * 1.05


def test_palette_runs_light_to_dark_through_the_stated_stops():
    p = sg.palette()
    assert len(p) == 101 and p[0] == [0, 0, 0]
    assert p[1] == [204, 236, 214] and p[50] == [65, 174, 118] and p[100] == [0, 68, 27]
    assert len({tuple(c) for c in p[1:]}) == 100
    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in p[1:]]
    assert all(a > b for a, b in zip(lum, lum[1:]))


def test_each_zip_is_fetched_once_and_refused_unless_pinned(tmp_path):
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        shutil.copy(FIX / url.split("/")[-2], path)

    epoch = "2023_2024"
    with pytest.raises(sg.SourceChanged, match="is not the pinned"):
        sg.fetch(tmp_path, epoch, sha256="0" * 64, fetch_to=fetch_to)
    assert not list(tmp_path.iterdir())  # the refused download is not kept
    got = sg.fetch(
        tmp_path, epoch, sha256=PINS[epoch], fetch_to=fetch_to
    )  # positive control
    assert sg.fetch(tmp_path, epoch, sha256=PINS[epoch], fetch_to=fetch_to) == got
    url = "https://zenodo.org/api/records/18612240/files/GlobalSeagrass2023_2024.zip/content"
    assert calls == [url] * 2  # the kept file is not fetched again
    got.write_bytes(b"changed")
    with pytest.raises(sg.SourceChanged, match="delete it to fetch again"):
        sg.fetch(tmp_path, epoch, sha256=PINS[epoch], fetch_to=fetch_to)


def test_only_the_release_layout_is_read(tmp_path):
    epoch = "2019_2020"
    fix = FIX / sg.zip_name(epoch)
    assert sg.members(fix, epoch) == names(epoch)  # positive control

    def zipped(extra):
        p = tmp_path / "z.zip"
        shutil.copy(fix, p)
        with zipfile.ZipFile(p, "a") as z:
            z.writestr(extra, b"x")
        return p

    for extra in [
        "GlobalSeagrass2019_2020/readme.txt",
        "GlobalSeagrass2019_2020-0000655360-0001048576.tif",
        "GlobalSeagrass2019_2020/GlobalSeagrass2023_2024-0000655360-0001048576.tif",
    ]:
        with pytest.raises(sg.SourceChanged, match="unexpected members"):
            sg.members(zipped(extra), epoch)

    with rasterio.open(f"/vsizip/{fix}/{names(epoch)[0]}") as src:
        prof, a = src.profile, src.read(1)

    def tif(**change):
        p = tmp_path / "t.tif"
        data = change.pop("data", a)
        with rasterio.open(p, "w", **(prof | change)) as dst:
            for b in range(1, dst.count + 1):
                dst.write(data.astype(dst.dtypes[0]), b)
        return rasterio.open(p)

    with tif() as ok:
        sg.check_profile(ok, "same")  # positive control: the profile rewritten as is
    t = prof["transform"]
    for change, why in [
        ({"count": 2}, "2 bands"),
        ({"dtype": "uint16"}, "dtype uint16"),
        ({"crs": "EPSG:3857"}, "crs"),
        ({"transform": rasterio.Affine(t.a * 2, 0, t.c, 0, t.e * 2, t.f)}, "pixel"),
        ({"transform": rasterio.Affine(t.a, 0, 180.5, 0, t.e, t.f)}, "bounds"),
        ({"transform": rasterio.Affine(t.a, 0, t.c, 0, t.e, 75.5)}, "bounds"),
    ]:
        with tif(**change) as bad, pytest.raises(sg.SourceChanged, match=why):
            sg.check_profile(bad, "changed")
    two = a.copy()
    two[0, 0] = 2
    with tif(data=two) as bad, pytest.raises(sg.SourceChanged, match="values above 1"):
        cs.accumulate(bad, 9, {})


def test_main_writes_one_listed_8_bit_pyramid_per_epoch_whose_pixels_are_the_shares(
    tmp_path,
):
    out = tmp_path / "out"
    m = sg.main(
        ["--out-dir", str(out), "--cache", str(tmp_path / "cache")],
        fetch_to=lambda url, path: shutil.copy(FIX / url.split("/")[-2], path),
        pins=PINS,
        band_rows=64,
    )
    assert json.loads((out / "seagrass.json").read_text()) == m
    assert [e["key"] for e in m["epochs"]] == EPOCHS
    assert [(e["label"], e["year"], e["members"]) for e in m["epochs"]] == [
        ("2019–2020", 2019, 2),
        ("2023–2024", 2023, 2),
    ]
    assert (
        m["tile"] == "data/seagrass/{epoch}/{z}/{x}/{y}.png"
        and m["source"]["licence"] == "CC BY 4.0"
    )
    assert m["tileBytes"] == sum(e["tileBytes"] for e in m["epochs"])
    colour = {tuple(c + [255]): i for i, c in enumerate(m["palette"]) if i}
    pixels = {}
    for e in m["epochs"]:
        root = out / "seagrass" / e["key"]
        listed = {f"{z}/{x}/{y}.png" for z, xs in e["tiles"].items() for x, y in xs}
        written = {str(p.relative_to(root)) for p in root.rglob("*.png")}
        assert listed == written and len(e["tiles"]) == sg.MAX_LEVEL + 1
        assert sum(p.stat().st_size for p in root.rglob("*.png")) == e["tileBytes"]
        # the readout decodes tiles with src/data/pngDecode.js, which reads 8-bit images only: IHDR bit depth 8, palette
        for p in root.rglob("*.png"):
            head = p.read_bytes()[:26]
            assert head[12:16] == b"IHDR" and (head[24], head[25]) == (8, 3), p
        want_grass, want_total = brute(e["key"], 9)
        seen = {}
        for x, y in e["tiles"]["9"]:
            im = np.asarray(
                Image.open(
                    io.BytesIO((root / "9" / str(x) / f"{y}.png").read_bytes())
                ).convert("RGBA")
            )
            for r in range(256):
                for c in range(256):
                    k = (x * 256 + c, y * 256 + r)
                    px = tuple(int(v) for v in im[r, c])
                    if want_grass.get(k, 0):
                        pct = math.floor(
                            Fraction(100 * want_grass[k], want_total[k])
                            + Fraction(1, 2)
                        )
                        assert colour[px] == max(1, min(100, pct)), (e["key"], k, px)
                        seen[k] = colour[px]
                    else:
                        assert px[3] == 0, (e["key"], k, px)
        assert len(seen) == sum(1 for v in want_grass.values() if v)
        pixels[e["key"]] = seen
    # the two epochs are drawn from their own files: the same cells differ
    common = pixels["2019_2020"].keys() & pixels["2023_2024"].keys()
    assert common and any(
        pixels["2019_2020"][k] != pixels["2023_2024"][k] for k in common
    )
