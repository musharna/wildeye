"""Reptile richness pipeline: the pinned Zenodo files, the overlap rule, group counts, the tile encoding the layer
decodes, the checks that stop the run, and the real release at pre-registered cells (spec
2026-10-03-reptile-richness-design.md)."""

import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest
import shapefile
from PIL import Image
from shapely.geometry import box, mapping

from pipeline import reptiles as rp

CACHE = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))

# name → (group, shape); three overlap the cell 0.7–0.8° N, 0.7–0.8° E (row 892, column 1807 of the 0.1° grid)
RANGES = {
    "Lizardus a": ("lizard", box(0, 0, 1, 1)),
    "Serpens b": ("snake", box(0.5, 0.5, 1.5, 1.5)),
    # smaller than a cell and holding no cell centre: counted by the overlap rule only
    "Crocus parvus": ("croc", box(0.72, 0.72, 0.74, 0.74)),
    "Testudo far": ("turtle", box(-60, -10, -59, -9)),
}
CELL = (892, 1807)


def ranges(spec=RANGES):
    for name, (group, g) in spec.items():
        yield name, group, mapping(g), g.bounds


def cell_centre(row, col, res=rp.RES):
    return 90 - (row + 0.5) * res, -180 + (col + 0.5) * res


def test_every_overlapping_range_counts_by_group():
    counts = rp.rasterise(ranges(), expect=4)
    assert counts.shape == (4, 1800, 3600) and counts.dtype == np.uint16
    assert counts[:, CELL[0], CELL[1]].tolist() == [1, 1, 0, 1], (
        "lizard, snake, the croc under other"
    )
    assert counts[:, 900 - 5, 1800 + 5].tolist() == [1, 0, 0, 0], (
        "0.45° N, 0.55° E: the lizard only"
    )
    assert counts[2].sum() == 100, "1° × 1° turtle range: 10 × 10 cells"
    assert counts[:, 0, 0].sum() == 0 and counts[:, 1700, 1800].sum() == 0


def test_a_tiny_range_still_counts():
    one = {"Crocus parvus": RANGES["Crocus parvus"]}
    counts = rp.rasterise(ranges(one), expect=1)
    assert int(counts.sum()) == 1 and counts[3, CELL[0], CELL[1]] == 1


def test_an_unknown_group_a_wrong_species_count_or_an_overfull_cell_stops_the_run():
    assert rp.rasterise(ranges(), expect=4)[0].max() == 1  # positive control
    with pytest.raises(ValueError, match="4 species, not 10,914"):
        rp.rasterise(ranges())
    odd = {**RANGES, "Dracus": ("dragon", box(5, 5, 6, 6))}
    with pytest.raises(ValueError, match="Dracus: group 'dragon' is not one of"):
        rp.rasterise(ranges(odd), expect=5)
    lizards = {f"L{i}": ("lizard", box(0.72, 0.72, 0.74, 0.74)) for i in range(256)}
    with pytest.raises(ValueError, match="a cell holds 256 species"):
        rp.rasterise(ranges(lizards), expect=256)
    assert (
        rp.rasterise(ranges(dict(list(lizards.items())[:255])), expect=255).max() == 255
    )


def test_a_range_that_burns_no_cell_stops_the_run():
    empty = [("Nullus", "lizard", {"type": "Polygon", "coordinates": []}, (0.72, 0.72, 0.74, 0.74))]
    with pytest.raises(ValueError, match="Nullus: range overlaps no cell"):
        rp.rasterise(iter(empty), expect=1)  # rasterio only warns and burns nothing
    off = [("Extra", "lizard", mapping(box(190, 0, 191, 1)), (190, 0, 191, 1))]
    with pytest.raises(ValueError, match=r"Extra: range \(190, 0, 191, 1\) is off the globe"):
        rp.rasterise(iter(off), expect=1)


def test_palette_one_distinct_colour_per_count_rising_in_luminance():
    def luminance(c):
        lin = [
            x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
            for x in (v / 255 for v in c)
        ]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

    for top in (1, 2, 189, 255):
        pal = rp.palette(top)
        assert len(pal) == top + 1 and len(set(pal)) == top + 1
    pal = rp.palette(189)
    assert pal[1] == rp.RAMP[0] and pal[189] == rp.RAMP[-1]
    light = [luminance(c) for c in pal[1:]]
    assert light == sorted(light), "more species reads lighter on the dark globe"


def test_a_ramp_that_repeats_colours_stops_the_run(monkeypatch):
    assert len(set(rp.palette(255))) == 256  # positive control: the real ramp
    monkeypatch.setattr(rp, "RAMP", [(10, 10, 10), (12, 12, 12)])  # 3 shades for 255 counts
    with pytest.raises(ValueError, match="fewer than 256 distinct colours"):
        rp.palette(255)


def read_px(path, lat, lon, z):
    """Pixel (palette index or RGB) at a point of tile level z, by the same arithmetic as the layer's geoTilePixel."""
    n = rp.TILE * 2 ** (z + 1)
    gx, gy = int((lon + 180) / 360 * n), int((90 - lat) / 180 * (n // 2))
    x, y = gx // rp.TILE, gy // rp.TILE
    return path(x, y), (gx % rp.TILE, gy % rp.TILE)


def test_tiles_carry_the_exact_total_and_groups_at_every_cell(tmp_path):
    counts = rp.rasterise(ranges(), expect=4)
    sizes = rp.write_tiles(counts, tmp_path)
    assert sizes["display"] > 0 and sizes["groups"] > 0
    for z in range(rp.MAX_LEVEL + 1):
        assert len(list((tmp_path / str(z)).rglob("*.png"))) == 2 ** (z + 1) * 2**z
    assert len(list((tmp_path / "groups").rglob("*.png"))) == 128
    total = counts.sum(0)
    for row, col in [CELL, (895, 1805), (994, 1205), (0, 0), (1700, 1800)]:
        lat, lon = cell_centre(row, col)
        (tile, px) = read_px(
            lambda x, y: Image.open(tmp_path / "3" / str(x) / f"{y}.png"), lat, lon, 3
        )
        assert tile.mode == "P" and tile.getpixel(px) == total[row, col], (row, col)
        (g, px) = read_px(
            lambda x, y: Image.open(tmp_path / "groups" / str(x) / f"{y}.png"),
            lat,
            lon,
            3,
        )
        assert g.mode == "RGB" and list(g.getpixel(px)) == counts[:3, row, col].tolist()
    # the test cell 0.75° N, 0.75° E lies in level-3 tile x 8, y 3 (22.5° tiles)
    t = Image.open(tmp_path / "3" / "8" / "3.png")
    (_, (px, py)) = read_px(lambda x, y: (x, y), *cell_centre(*CELL), 3)
    alpha = t.convert("RGBA").getchannel("A")
    assert alpha.getpixel((px, py)) == 255 and alpha.getpixel((0, 0)) == 0, (
        "a count is opaque; no species is transparent"
    )
    assert t.getpalette()[3:12] == [v for c in rp.palette(3)[1:] for v in c]


def test_coarser_levels_average_the_cells_with_species():
    total = np.zeros((1800, 3600), np.uint16)
    total[0:900, 0:1800] = 4  # north-west quarter
    total[0:450, 0:900] = 8
    lv = dict(rp.levels(total))
    assert lv[3].shape == (2048, 4096) and lv[0].shape == (256, 512)
    assert lv[0][0, 0] == 8 and lv[0][127, 255] == 4 and lv[0][128, 256] == 0
    sparse = np.zeros((1800, 3600), np.uint16)
    sparse[::2, ::2] = 3  # a quarter of the cells hold 3: the mean over all would be ~1, over cells with species 3
    assert (dict(rp.levels(sparse))[0] == 3).all()


def write_source(d: Path, spec=RANGES):
    d.mkdir(parents=True, exist_ok=True)
    w = shapefile.Writer(str(d / rp.SHP), shapeType=shapefile.POLYGON, encoding="utf-8")
    w.field("binomial", "C", 254)
    w.field("TaxonID", "C", 6)
    w.field("group", "C", 15)
    w.field("family", "C", 18)
    w.field("area", "N", 16, 8)
    for i, (name, (group, g)) in enumerate(spec.items()):
        w.poly([list(g.exterior.coords)[::-1]])
        w.record(name, f"R{i:05d}", group, "Fam", 1.0)
    w.close()
    (d / f"{rp.SHP}.prj").write_text('GEOGCS["GCS_WGS_1984"]')
    return d


def md5s(src):
    return {
        n: hashlib.md5((src / n).read_bytes(), usedforsecurity=False).hexdigest()
        for n in rp.FILES
    }


def test_each_file_is_used_only_when_its_md5_is_zenodos(tmp_path):
    src = write_source(tmp_path / "src")
    want = md5s(src)
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes((src / url.split("/files/")[1].split("/")[0]).read_bytes())

    cache = tmp_path / "cache"
    d = rp.fetch(cache, fetch_to=fetch_to, want=want)
    assert sorted(p.name for p in d.iterdir()) == sorted(rp.FILES)
    assert calls == [f"{rp.RECORD_API}/files/{n}/content" for n in rp.FILES]
    assert rp.fetch(cache, fetch_to=fetch_to, want=want) == d and len(calls) == len(
        rp.FILES
    ), "cached"
    bad = {**want, "Gard_1_7_ranges.dbf": "0" * 32}
    with pytest.raises(ValueError, match="Gard_1_7_ranges.dbf: md5 .* is not Zenodo's"):
        rp.fetch(cache, fetch_to=fetch_to, want=bad)
    (d / "Gard_1_7_ranges.dbf").unlink()
    with pytest.raises(ValueError, match="is not Zenodo's"):
        rp.fetch(cache, fetch_to=fetch_to, want=bad)
    assert not (d / "Gard_1_7_ranges.dbf").exists() and not list(d.glob("*.part")), (
        "a refused download leaves nothing"
    )


def test_main_publishes_tiles_and_manifest_and_nothing_over_budget(tmp_path):
    src = write_source(tmp_path / "src")
    want = md5s(src)

    def fetch_to(url, path):
        path.write_bytes((src / url.split("/files/")[1].split("/")[0]).read_bytes())

    out = tmp_path / "out"
    args = ["--cache", str(tmp_path / "cache"), "--out-dir", str(out)]
    assert rp.main(args, fetch_to=fetch_to, want=want, expect=4) == 0
    m = json.loads((out / "reptiles.json").read_text())
    assert (m["maxLevel"], m["maxSpecies"], m["species"], m["groups"]) == (
        3,
        3,
        4,
        ["lizards", "snakes", "turtles", "other"],
    )
    assert m["palette"] == [list(c) for c in rp.palette(3)]
    assert (
        m["source"]["licence"].startswith("CC0")
        and "s41559-017-0332-2" in m["source"]["citation"]
    )
    assert (out / "reptiles" / "3" / "4" / "3.png").exists() and (
        out / "reptiles" / "groups" / "4" / "3.png"
    ).exists()
    before = (out / "reptiles.json").read_bytes()
    with pytest.raises(SystemExit, match="over the 1,000 B budget: nothing published"):
        rp.main([*args, "--budget", "1000"], fetch_to=fetch_to, want=want, expect=4)
    assert (out / "reptiles.json").read_bytes() == before and (
        out / "reptiles" / "3"
    ).is_dir()
    assert not (out / ".reptiles.tmp").exists()


# Pre-registered 2026-10-03 from the raw shapes with shapely (ranges whose shape intersects the 0.1° cell), before the
# layer was written: cell centre → lizards, snakes, turtles, other.
CELLS = {
    "Peninsular Malaysia": ((3.75, 101.75), [68, 102, 17, 2]),
    "central Amazon": ((-3.05, -60.05), [47, 113, 13, 7]),
    "inland Australia": ((-25.05, 133.05), [82, 22, 0, 0]),
    "Madagascar": ((-18.95, 47.55), [20, 12, 1, 0]),
    "Texas": ((30.25, -97.75), [17, 37, 15, 1]),
    "Northland (tuatara)": ((-35.45, 174.75), [7, 0, 0, 1]),
    "Sahara": ((23.05, 10.05), [14, 7, 0, 0]),
    "Greenland ice": ((72.05, -40.05), [0, 0, 0, 0]),
    "Antarctica": ((-80.05, 0.05), [0, 0, 0, 0]),
    "mid Pacific": ((0.05, -149.95), [0, 0, 0, 0]),
}


# Not skipped when the cache is empty: main downloads the release through the pinned fetcher (Zenodo md5s), so a
# fresh CI runner checks the published tiles against the real source too.
def test_real_release_cells_read_the_counts_of_the_raw_ranges(tmp_path):
    assert rp.main(["--cache", str(CACHE), "--out-dir", str(tmp_path)]) == 0
    m = json.loads((tmp_path / "reptiles.json").read_text())
    assert (m["species"], m["maxSpecies"]) == (10914, 189)
    assert sum(m["bytes"].values()) <= rp.BUDGET_BYTES
    out = tmp_path / "reptiles"
    for name, ((lat, lon), want) in CELLS.items():
        (tile, px) = read_px(
            lambda x, y: Image.open(out / "3" / str(x) / f"{y}.png"), lat, lon, 3
        )
        (g, gpx) = read_px(
            lambda x, y: Image.open(out / "groups" / str(x) / f"{y}.png"), lat, lon, 3
        )
        total, rgb = tile.getpixel(px), list(g.getpixel(gpx))
        assert [*rgb, total - sum(rgb)] == want, name
