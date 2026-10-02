"""Wetlands (GLWD v2) pipeline: pinned download, legend, mode warp with the sea excluded, tile pyramid (spec 2026-10-01-wetlands-design.md)."""

import hashlib
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import from_origin

from pipeline import glwd

CELL = 0.234375  # a third of a level-0 pixel (0.703125°), so every level-0 pixel is exactly 3 × 3 source cells
TOP = 84.375  # = 90 − 8 level-0 rows; the data stop here, as GLWD's do at 84°N
W, H = 1536, 600  # 180°W–180°E × 84.375°N–56.25°S
LEGEND_CSV = (Path(__file__).parent / "fixtures" / "GLWD_Legend_v2_0.csv").read_bytes()


def cells(col, row):
    """The 3 × 3 source block under level-0 pixel (col, row)."""
    return slice(3 * (row - 8), 3 * (row - 8) + 3), slice(3 * col, 3 * col + 3)


def source_grid():
    a = np.full((H, W), 255, np.uint8)  # all sea
    blk = np.full(9, 255, np.uint8)
    blk[:4] = 28  # A: 5 sea + 4 mangrove → mangrove (the sea does not vote)
    a[cells(100, 50)] = blk.reshape(3, 3)
    blk = np.zeros(9, np.uint8)
    blk[:4] = 23  # B: 5 dryland + 4 boreal peat → dryland
    a[cells(101, 50)] = blk.reshape(3, 3)
    # C (102, 50): all sea → no data
    blk = np.array(
        [1, 1, 1, 1, 2, 2, 2, 0, 0], np.uint8
    )  # D: 4 lake + 3 saline lake + 2 dryland → lake
    a[cells(103, 50)] = blk.reshape(3, 3)
    return a


def write_source_zip(path, grid=None, legend_ids=range(34)):
    tif = path.parent / "src.tif"
    grid = source_grid() if grid is None else grid
    with rasterio.open(
        tif,
        "w",
        driver="GTiff",
        width=W,
        height=H,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=from_origin(-180, TOP, CELL, CELL),
        nodata=255,
    ) as dst:
        dst.write(grid, 1)
    # GLWD's own legend, byte for byte (CRLF, names with commas quoted); drop rows to make a broken one
    rows = LEGEND_CSV.split(b"\r\n")
    csv = b"\r\n".join(rows[:1] + [r for r in rows[1:] if r and int(r.split(b",")[0]) in legend_ids]) + b"\r\n"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("GLWD_Legend_v2_0.csv", csv)
        z.write(tif, "GLWD_v2_0_combined_classes/GLWD_v2_0_main_class_50pct.tif")
    return path


def md5(path):
    return hashlib.md5(path.read_bytes(), usedforsecurity=False).hexdigest()


def test_source_is_the_pinned_figshare_zip():
    assert glwd.SOURCE == (54001814, "aea80ff46211b349ffbaa871442fd0ed")
    assert glwd.NODATA == 34


def test_colours_are_33_distinct_shades_in_8_families_none_the_transparent_codes():
    assert sorted(glwd.CLASS_COLOURS) == list(range(1, 34))
    rgbs = [c for c, _ in glwd.CLASS_COLOURS.values()]
    assert len(set(rgbs)) == 33
    assert glwd.DRYLAND_RGB == (0, 0, 0) and glwd.NODATA_RGB == (255, 255, 255)
    assert not {glwd.DRYLAND_RGB, glwd.NODATA_RGB} & set(rgbs)
    assert len(glwd.FAMILIES) == 8
    assert {f for _, f in glwd.CLASS_COLOURS.values()} == set(glwd.FAMILIES)


def test_legend_is_read_from_the_zip_verbatim_and_a_short_one_is_refused(tmp_path):
    z = write_source_zip(tmp_path / "s.zip")
    legend = glwd.read_legend(z)
    assert sorted(legend) == list(range(34))
    assert (
        legend[28] == "Mangrove"
        and legend[23] == "Arctic/boreal peatland, non-forested"
    ), "CRLF stripped, quoted commas kept"
    assert legend[10] == "Riverine, regularly flooded, forested" and legend[33] == "Rice paddies"
    assert LEGEND_CSV.count(b"\r\n") == 35, "the fixture still has GLWD's CRLF line ends"
    short = write_source_zip(tmp_path / "short.zip", legend_ids=range(33))
    with pytest.raises(ValueError, match="legend"):
        glwd.read_legend(short)


def test_a_level_takes_the_mode_of_its_cells_and_the_sea_does_not_vote():
    lvl = glwd.render_level(source_grid(), from_origin(-180, TOP, CELL, CELL), 0)
    assert lvl.shape == (256, 512)
    assert lvl[50, 100] == 28, "5 sea + 4 mangrove: a coastal mangrove survives"
    assert lvl[50, 101] == 0, "5 dryland + 4 peat: mostly dryland"
    assert lvl[50, 102] == glwd.NODATA, "all sea"
    assert lvl[50, 103] == 1, "4 lake + 3 saline + 2 dryland: the most common"
    assert (lvl[:8] == glwd.NODATA).all(), "north of the data"
    assert (lvl[208:] == glwd.NODATA).all(), "south of the data"


def test_fetch_refuses_a_wrong_md5_cached_or_fetched_and_keeps_only_a_checked_file(
    tmp_path,
):
    body = b"zip bytes"
    good = hashlib.md5(body, usedforsecurity=False).hexdigest()
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(body)

    p = glwd.fetch_source(tmp_path, fetch_to=fetch_to, source=(123, good))
    assert p.read_bytes() == body and calls == [
        "https://ndownloader.figshare.com/files/123"
    ]
    assert (
        glwd.fetch_source(tmp_path, fetch_to=fetch_to, source=(123, good)) == p
        and len(calls) == 1
    ), "cached"
    with pytest.raises(ValueError, match="md5"):
        glwd.fetch_source(tmp_path, fetch_to=fetch_to, source=(123, "0" * 32))
    p.unlink()
    with pytest.raises(ValueError, match="md5"):
        glwd.fetch_source(tmp_path, fetch_to=fetch_to, source=(123, "0" * 32))
    assert not p.exists() and not list(tmp_path.glob("*.part")), (
        "a refused download leaves nothing behind"
    )


def test_main_writes_every_tile_and_a_manifest_naming_the_classes(tmp_path):
    src = write_source_zip(tmp_path / "src.zip")
    cache, out = tmp_path / "cache", tmp_path / "out"

    def fetch_to(url, path):
        path.write_bytes(src.read_bytes())

    glwd.main(
        ["--cache", str(cache), "--out-dir", str(out), "--max-level", "1"],
        fetch_to=fetch_to,
        source=(1, md5(src)),
    )
    m = json.loads((out / "glwd.json").read_text())
    assert m["maxLevel"] == 1 and m["tile"] == "data/glwd/{z}/{x}/{y}.png"
    assert m["dryland"] == [0, 0, 0] and m["noData"] == [255, 255, 255]
    classes = {c["id"]: c for c in m["classes"]}
    assert sorted(classes) == list(range(1, 34))
    assert classes[28]["name"] == "Mangrove" and classes[28]["rgb"] == list(
        glwd.CLASS_COLOURS[28][0]
    )
    assert classes[28]["family"] == glwd.CLASS_COLOURS[28][1]
    assert [f["name"] for f in m["families"]] == list(glwd.FAMILIES)
    assert (
        m["source"]["doi"] == "10.5194/essd-17-2277-2025"
        and "CC BY 4.0" in m["source"]["licence"]
    )
    files = sorted(
        p.relative_to(out / "glwd").as_posix() for p in (out / "glwd").rglob("*.png")
    )
    assert files == ["0/0/0.png", "0/1/0.png"] + [
        f"1/{x}/{y}.png" for x in range(4) for y in range(2)
    ]
    im = Image.open(
        out / "glwd" / "0" / "0" / "0.png"
    )  # west half: level-0 pixel (100, 50) is at (100, 50)
    assert im.mode == "P"
    rgba = im.convert("RGBA")
    assert im.getpixel((100, 50)) == 28 and rgba.getpixel((100, 50)) == (
        *glwd.CLASS_COLOURS[28][0],
        255,
    )
    assert im.getpixel((101, 50)) == 0 and rgba.getpixel((101, 50)) == (0, 0, 0, 0), (
        "dryland: transparent, black"
    )
    assert im.getpixel((102, 50)) == glwd.NODATA and rgba.getpixel((102, 50)) == (
        255,
        255,
        255,
        0,
    ), "sea: transparent, white"
