"""Mammal richness pipeline: the pinned Zenodo files, the release's layout and species list, the overlap rule, group
counts, the tile encoding the layer decodes, the checks that stop the run, and the real release (spec
2026-10-04-mammal-richness-design.md)."""

import csv
import hashlib
import json
import os
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import pyogrio.raw
import pytest
import shapely
from PIL import Image
from shapely.geometry import MultiPolygon, box

from pipeline import mammals as mm

CACHE = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))

# name → (ORDER, shape); three overlap the cell 0.7–0.8° N, 0.7–0.8° E (row 892, column 1807 of the 0.1° grid)
RANGES = {
    "Mus a": ("RODENTIA", box(0, 0, 1, 1)),
    "Myotis b": ("CHIROPTERA", box(0.5, 0.5, 1.5, 1.5)),
    # smaller than a cell and holding no cell centre: counted by the overlap rule only
    "Tachyglossus parvus": ("MONOTREMATA", box(0.72, 0.72, 0.74, 0.74)),
    "Pan far": ("PRIMATES", box(-60, -10, -59, -9)),
}
CELL = (892, 1807)


def ranges(spec=RANGES):
    for name, (order, g) in spec.items():
        yield name, order, g, g.bounds


def listed(spec=RANGES):
    return {name: order for name, (order, _) in spec.items()}


def cell_centre(row, col, res=mm.RES):
    return 90 - (row + 0.5) * res, -180 + (col + 0.5) * res


def test_every_overlapping_range_counts_by_group():
    counts = mm.rasterise(ranges(), listed())
    assert counts.shape == (4, 1800, 3600) and counts.dtype == np.uint16
    assert counts[:, CELL[0], CELL[1]].tolist() == [1, 1, 0, 1], (
        "rodent, bat, the monotreme under other"
    )
    assert counts[:, 900 - 5, 1800 + 5].tolist() == [1, 0, 0, 0], (
        "0.45° N, 0.55° E: the rodent only"
    )
    assert counts[2].sum() == 100, "1° × 1° primate range: 10 × 10 cells"
    assert counts[:, 0, 0].sum() == 0 and counts[:, 1700, 1800].sum() == 0


def test_the_species_read_must_be_the_release_list_each_once():
    assert mm.rasterise(ranges(), listed())[0].max() == 1  # positive control
    with pytest.raises(
        ValueError, match="Mus a \\(RODENTIA\\) is not on the release's list as None"
    ):
        mm.rasterise(ranges(), {k: v for k, v in listed().items() if k != "Mus a"})
    with pytest.raises(
        ValueError,
        match="Mus a \\(RODENTIA\\) is not on the release's list as PRIMATES",
    ):
        mm.rasterise(ranges(), {**listed(), "Mus a": "PRIMATES"})
    with pytest.raises(
        ValueError, match="1 listed species have no range: \\['Sorex z'\\]"
    ):
        mm.rasterise(ranges(), {**listed(), "Sorex z": "EULIPOTYPHLA"})
    twice = [*ranges(), ("Mus a", "RODENTIA", box(5, 5, 6, 6), (5, 5, 6, 6))]
    with pytest.raises(ValueError, match="Mus a: mapped twice"):
        mm.rasterise(iter(twice), listed())


def test_an_overfull_cell_stops_the_run():
    rodents = {f"R{i}": ("RODENTIA", box(0.72, 0.72, 0.74, 0.74)) for i in range(256)}
    with pytest.raises(ValueError, match="a cell holds 256 species"):
        mm.rasterise(ranges(rodents), listed(rodents))
    first = dict(list(rodents.items())[:255])
    assert mm.rasterise(ranges(first), listed(first)).max() == 255  # positive control


def test_a_range_that_burns_no_cell_stops_the_run():
    empty = [("Nullus", "RODENTIA", MultiPolygon(), (0.72, 0.72, 0.74, 0.74))]
    with pytest.raises(ValueError, match="Nullus: range overlaps no cell"):
        mm.rasterise(iter(empty), {"Nullus": "RODENTIA"})
    off = [("Extra", "RODENTIA", box(190, 0, 191, 1), (190, 0, 191, 1))]
    with pytest.raises(
        ValueError, match=r"Extra: range \(190, 0, 191, 1\) is off the globe"
    ):
        mm.rasterise(iter(off), {"Extra": "RODENTIA"})


def test_palette_one_distinct_colour_per_count_rising_in_luminance():
    def luminance(c):
        lin = [
            x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
            for x in (v / 255 for v in c)
        ]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

    for top in (1, 2, 200, 255):
        pal = mm.palette(top)
        assert len(pal) == top + 1 and len(set(pal)) == top + 1
    pal = mm.palette(200)
    assert pal[1] == mm.RAMP[0] and pal[200] == mm.RAMP[-1]
    light = [luminance(c) for c in pal[1:]]
    assert light == sorted(light), "more species reads lighter on the dark globe"


def read_px(path, lat, lon, z):
    """Pixel (palette index or RGB) at a point of tile level z, by the same arithmetic as the layer's geoTilePixel."""
    n = mm.TILE * 2 ** (z + 1)
    gx, gy = int((lon + 180) / 360 * n), int((90 - lat) / 180 * (n // 2))
    x, y = gx // mm.TILE, gy // mm.TILE
    return path(x, y), (gx % mm.TILE, gy % mm.TILE)


def test_tiles_carry_the_exact_total_and_groups_at_every_cell(tmp_path):
    counts = mm.rasterise(ranges(), listed())
    sizes = mm.write_tiles(counts, tmp_path)
    assert sizes["display"] > 0 and sizes["groups"] > 0
    for z in range(mm.MAX_LEVEL + 1):
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
    t = Image.open(tmp_path / "3" / "8" / "3.png")
    (_, (px, py)) = read_px(lambda x, y: (x, y), *cell_centre(*CELL), 3)
    alpha = t.convert("RGBA").getchannel("A")
    assert alpha.getpixel((px, py)) == 255 and alpha.getpixel((0, 0)) == 0, (
        "a count is opaque; no species is transparent"
    )
    assert t.getpalette()[3:12] == [v for c in mm.palette(3)[1:] for v in c]


def write_order(d: Path, order: str, spec: dict, *, member=None, field_order=None):
    """One release-shaped zip: <Order>/MDD_<Order>.gpkg holding sciname, order, family per species."""
    d.mkdir(parents=True, exist_ok=True)
    gpkg = d / f"MDD_{order}.gpkg"
    gpkg.unlink(missing_ok=True)
    names = list(spec)
    pyogrio.raw.write(
        str(gpkg),
        geometry=np.array(
            [shapely.to_wkb(MultiPolygon([spec[n][1]])) for n in names], dtype=object
        ),
        field_data=[
            np.array(names, dtype=object),
            np.array([field_order or order] * len(names), dtype=object),
            np.array(["Fam"] * len(names), dtype=object),
        ],
        fields=["sciname", "order", "family"],
        driver="GPKG",
        geometry_type="MultiPolygon",
        crs="EPSG:4326",
        layer=f"MDD_{order}",
    )
    with zipfile.ZipFile(d / f"MDD_{order}.zip", "w") as z:
        z.write(gpkg, member or f"{order}/MDD_{order}.gpkg")
    gpkg.unlink()
    return d / f"MDD_{order}.zip"


def write_source(d: Path, spec=RANGES):
    by_order = {}
    for name, (order, g) in spec.items():
        by_order.setdefault(order.capitalize(), {})[name] = (order, g)
    for order, sub in by_order.items():
        write_order(d, order, sub)
    with open(d / mm.SPECIES_LIST, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Order", "Family", "Genus", "Species", "MDD_SciName"])
        for name, (order, _) in spec.items():
            w.writerow([order.capitalize(), "Fam", *name.split(), name])
    return d


def md5s(d: Path):
    return {
        p.name: hashlib.md5(p.read_bytes(), usedforsecurity=False).hexdigest()
        for p in sorted(d.iterdir())
    }


def test_each_file_is_used_only_when_its_md5_is_zenodos(tmp_path):
    src = write_source(tmp_path / "src")
    want = md5s(src)
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes((src / url.split("/files/")[1].split("/")[0]).read_bytes())

    cache = tmp_path / "cache"
    d = mm.fetch(cache, fetch_to=fetch_to, want=want)
    assert sorted(p.name for p in d.iterdir()) == sorted(want)
    assert calls == [f"{mm.RECORD_API}/files/{n}/content" for n in want]
    assert mm.fetch(cache, fetch_to=fetch_to, want=want) == d and len(calls) == len(
        want
    ), "cached"
    bad = {**want, "MDD_Rodentia.zip": "0" * 32}
    with pytest.raises(ValueError, match="MDD_Rodentia.zip: md5 .* is not Zenodo's"):
        mm.fetch(cache, fetch_to=fetch_to, want=bad)
    (d / "MDD_Rodentia.zip").unlink()
    with pytest.raises(ValueError, match="is not Zenodo's"):
        mm.fetch(cache, fetch_to=fetch_to, want=bad)
    assert not (d / "MDD_Rodentia.zip").exists() and not list(d.glob("*.part")), (
        "a refused download leaves nothing"
    )


def test_only_the_release_layout_is_read(tmp_path):
    src = write_source(tmp_path / "src")
    zips = sorted(p.name for p in src.glob("*.zip"))
    got = list(mm.read_ranges(src, zips, batch=1))
    assert sorted(n for n, *_ in got) == sorted(
        RANGES
    )  # positive control, read one feature at a time
    assert {n: o for n, o, *_ in got} == listed()
    one = {"Mus a": RANGES["Mus a"]}
    for kw, why in [
        ({"member": "Rodentia/readme.txt"}, "are not one <Order>/MDD_<Order>.gpkg"),
        (
            {"member": "Primates/MDD_Primates.gpkg"},
            "MDD_Rodentia.zip holds Primates/MDD_Primates.gpkg",
        ),
        ({"field_order": "Primates"}, "MDD_Rodentia.zip: Mus a is in order Primates"),
    ]:
        bad = tmp_path / "bad"
        write_order(bad, "Rodentia", one, **kw)
        with pytest.raises(ValueError, match=why):
            list(mm.read_ranges(bad, ["MDD_Rodentia.zip"]))
    with zipfile.ZipFile(bad / "MDD_Rodentia.zip", "a") as z:
        z.writestr("Rodentia/extra.txt", "x")
    with pytest.raises(ValueError, match="are not one"):
        list(mm.read_ranges(bad, ["MDD_Rodentia.zip"]))


def test_main_publishes_tiles_and_manifest_and_nothing_over_budget(tmp_path):
    src = write_source(tmp_path / "src")
    want = md5s(src)

    def fetch_to(url, path):
        path.write_bytes((src / url.split("/files/")[1].split("/")[0]).read_bytes())

    out = tmp_path / "out"
    args = ["--cache", str(tmp_path / "cache"), "--out-dir", str(out)]
    assert mm.main(args, fetch_to=fetch_to, want=want) == 0
    m = json.loads((out / "mammals.json").read_text())
    assert (m["maxLevel"], m["maxSpecies"], m["species"], m["groups"]) == (
        3,
        3,
        4,
        ["rodents", "bats", "primates", "other"],
    )
    assert m["palette"] == [list(c) for c in mm.palette(3)]
    assert (
        m["source"]["licence"].startswith("CC BY 4.0")
        and "jbi.14330" in m["source"]["citation"]
    )
    assert (out / "mammals" / "3" / "4" / "3.png").exists() and (
        out / "mammals" / "groups" / "4" / "3.png"
    ).exists()
    before = (out / "mammals.json").read_bytes()
    with pytest.raises(SystemExit, match="over the 1,000 B budget: nothing published"):
        mm.main([*args, "--budget", "1000"], fetch_to=fetch_to, want=want)
    assert (out / "mammals.json").read_bytes() == before and (
        out / "mammals" / "3"
    ).is_dir()
    assert not (out / ".mammals.tmp").exists()


SMALL = ["MDD_Monotremata.zip", "MDD_Microbiotheria.zip", "MDD_Notoryctemorphia.zip"]


# Real execution in CI: three small orders and the species list come from Zenodo through the pinned fetcher (md5s from
# the module), are read by the module's reader, and match the raw polygons read with pyogrio + shapely here.
def test_real_small_orders_read_and_count_as_their_raw_polygons(tmp_path):
    want = {n: mm.FILES[n] for n in [*SMALL, mm.SPECIES_LIST]}
    d = mm.fetch(CACHE / mm.CACHE_DIR, want=want)
    full = mm.species_list(d / mm.SPECIES_LIST)
    assert len(full) == mm.EXPECTED_SPECIES
    small = {
        k: v
        for k, v in full.items()
        if v in {"MONOTREMATA", "MICROBIOTHERIA", "NOTORYCTEMORPHIA"}
    }
    # 5 monotremes, 3 monitos del monte (Dromiciops), 2 marsupial moles (Notoryctes), by the release's own list
    assert Counter(small.values()) == {"MONOTREMATA": 5, "MICROBIOTHERIA": 3, "NOTORYCTEMORPHIA": 2}, small
    counts = mm.rasterise(mm.read_ranges(d, SMALL), small)
    assert counts[:3].sum() == 0, "no rodents, bats or primates in these orders"
    # every range of the three orders from the raw GeoPackages, and the cells around their bounds
    shapes = {}
    for zname in SMALL:
        order = zname[4:-4]
        path = f"/vsizip/{d / zname}/{order}/MDD_{order}.gpkg"
        _, _, geom, fields = pyogrio.raw.read(path, columns=["sciname"])
        shapes |= dict(zip(fields[0], shapely.from_wkb(geom)))
    assert set(shapes) == set(small)
    rng = np.random.default_rng(6362)
    checked = {"in": 0, "out": 0}
    for name, g in shapes.items():
        x0, y0, x1, y1 = g.bounds
        rows = rng.integers(int((90 - y1) / mm.RES) - 2, int((90 - y0) / mm.RES) + 3, 12)
        cols = rng.integers(int((x0 + 180) / mm.RES) - 2, int((x1 + 180) / mm.RES) + 3, 12)
        for row, col in zip(rows.tolist(), cols.tolist()):
            cell = box(-180 + col * mm.RES, 90 - (row + 1) * mm.RES, -180 + (col + 1) * mm.RES, 90 - row * mm.RES)
            want_n = sum(1 for h in shapes.values() if h.intersects(cell))
            assert counts[3, row, col] == want_n, (name, row, col)
            checked["in" if want_n else "out"] += 1
    assert checked["in"] >= 40 and checked["out"] >= 10, checked


# Pre-registered from the raw polygons with shapely (ranges whose shape intersects the 0.1° cell) before the layer was
# written: cell centre → rodents, bats, primates, other. Needs the whole release (10.3 GB) in the cache: too large for
# CI, so it skips loudly there; the real run checks it.
CELLS = {}


@pytest.mark.skipif(
    not all((CACHE / mm.CACHE_DIR / n).exists() for n in mm.FILES),
    reason="the full MDD release (10.3 GB) is not in the cache: run `python -m pipeline.mammals` first",
)
def test_real_release_cells_read_the_counts_of_the_raw_ranges(tmp_path):
    assert CELLS, "pre-register the cells first"
    assert mm.main(["--cache", str(CACHE), "--out-dir", str(tmp_path)]) == 0
    m = json.loads((tmp_path / "mammals.json").read_text())
    assert m["species"] == mm.EXPECTED_SPECIES
    assert sum(m["bytes"].values()) <= mm.BUDGET_BYTES
    out = tmp_path / "mammals"
    for name, ((lat, lon), want) in CELLS.items():
        (tile, px) = read_px(
            lambda x, y: Image.open(out / "3" / str(x) / f"{y}.png"), lat, lon, 3
        )
        (g, gpx) = read_px(
            lambda x, y: Image.open(out / "groups" / str(x) / f"{y}.png"), lat, lon, 3
        )
        total, rgb = tile.getpixel(px), list(g.getpixel(gpx))
        assert [*rgb, total - sum(rgb)] == want, name


def test_a_species_listed_twice_stops_the_run(tmp_path):
    src = write_source(tmp_path / "src")
    assert mm.species_list(src / mm.SPECIES_LIST) == listed()  # positive control: the list as written
    with open(src / mm.SPECIES_LIST, "a", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerow(["Rodentia", "Fam", "Mus", "a", "Mus a"])
    with pytest.raises(ValueError, match="Mus a is listed twice"):
        mm.species_list(src / mm.SPECIES_LIST)
