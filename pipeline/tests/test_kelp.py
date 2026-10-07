"""Floating kelp: polygons burnt onto a subgrid of each ~150 m cell, the share per cell at every level, the refusals.

Expected counts are made here without GDAL: every subpixel centre of the cells in question is tested against the
polygons with shapely.contains_xy, and the shares with Fraction. Level-9 cells are 360/2**18 degrees wide and the
subpixels 1/64 of that, both exact binary fractions, so a polygon can be laid exactly on subpixel edges.
"""

import hashlib
import io
import json
import zipfile
from fractions import Fraction
from math import floor
from pathlib import Path

import numpy as np
import pyogrio
import pytest
import shapely
import shapely.affinity
from PIL import Image
from pipeline import cell_share
from pipeline import kelp

D = 360 / 2**18  # a level-9 cell, degrees
S = kelp.SUB
STEP = D / S
WIDTH = 2**18  # level-9 cells around the world
REAL_ZIP = (
    Path(
        __import__("os").environ.get(
            "WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"
        )
    )
    / "kelp"
    / kelp.ZIP_NAME
)


def cell_box(gx, gy, c0=0, r0=0, c1=S, r1=S):
    """The part of cell (gx, gy) from subpixel column c0 to c1 and row r0 to r1 (top-left origin)."""
    w = -180 + gx * D
    n = 90 - gy * D
    return shapely.box(w + c0 * STEP, n - r1 * STEP, w + c1 * STEP, n - r0 * STEP)


def brute(polys, cells, z=9):
    """{(gx, gy) at level z: subpixel centres inside any polygon}, over the level-9 cells given, longitudes wrapped."""
    union = shapely.union_all(polys)
    out = {}
    k = 9 - z
    for gx, gy in cells:
        i = np.arange(S) + 0.5
        lon = -180 + gx * D + i * STEP
        lat = 90 - gy * D - i * STEP
        X, Y = np.meshgrid(lon, lat)
        n = int(shapely.contains_xy(union, X.ravel(), Y.ravel()).sum())
        # the same place one world east or west, for polygons written past ±180°
        for shift in (-360, 360):
            n += int(shapely.contains_xy(union, X.ravel() + shift, Y.ravel()).sum())
        if n:
            key = ((gx % WIDTH) >> k, gy >> k)
            out[key] = out.get(key, 0) + n
    return out


def flat(tiles):
    return {
        (tx * 256 + int(c), ty * 256 + int(r)): int(arr[r, c])
        for (tx, ty), arr in tiles.items()
        for r, c in zip(*np.nonzero(arr))
    }


def cells_near(polys, pad=1):
    x0, y0, x1, y1 = shapely.total_bounds(polys)
    gx0, gx1 = floor((x0 + 180) / D) - pad, floor((x1 + 180) / D) + pad
    gy0, gy1 = floor((90 - y1) / D) - pad, floor((90 - y0) / D) + pad
    return [(gx, gy) for gx in range(gx0, gx1 + 1) for gy in range(gy0, gy1 + 1)]


MONTEREY = (floor((-121.9 + 180) / D), floor((90 - 36.6) / D))


def test_a_polygon_of_known_area_in_one_cell_gives_its_share():
    gx, gy = MONTEREY
    # a quarter of the cell laid on subpixel edges: exactly 32 x 32 of the 64 x 64 subpixels
    quarter = cell_box(gx, gy, 8, 16, 40, 48)
    counts, km2 = kelp.burn(np.array([quarter]))
    assert flat(counts) == {(gx, gy): 1024}
    assert cell_share.shares(np.array([[1024]]), np.array([[S * S]])).tolist() == [[25]]
    assert km2 == pytest.approx(kelp.sphere_km2(np.array([quarter])), rel=1e-6)
    # a polygon with edges off the subgrid: the count is the centres inside it, within the boundary's subpixels of
    # its true area
    tri = shapely.Polygon(
        [
            (-180 + (gx + 0.1037) * D, 90 - (gy + 0.0911) * D),
            (-180 + (gx + 0.9123) * D, 90 - (gy + 0.2219) * D),
            (-180 + (gx + 0.3311) * D, 90 - (gy + 0.8843) * D),
        ]
    )
    counts, _ = kelp.burn(np.array([tri]))
    got = flat(counts)
    assert got == brute([tri], [(gx, gy)])
    true = shapely.area(tri) / D**2
    assert (
        abs(got[(gx, gy)] / S**2 - true) < 3 * S / S**2
    )  # three edges, each crossing < S subpixels
    assert 0.25 < true < 0.35


def test_a_polygon_across_cell_and_tile_edges_splits_by_subpixel_centres():
    # cells 255 and 256 of a row are in different tiles: the polygon covers parts of four cells in two tiles
    gx, gy = 256 * 300 + 255, 256 * 200 + 255
    w, n = -180 + gx * D, 90 - gy * D
    rect = shapely.box(
        w + 40 * STEP, n - (64 + 10) * STEP, w + (64 + 24) * STEP, n - 50 * STEP
    )
    counts, _ = kelp.burn(np.array([rect]))
    got = flat(counts)
    assert got == {
        (gx, gy): 24 * 14,
        (gx + 1, gy): 24 * 14,
        (gx, gy + 1): 24 * 10,
        (gx + 1, gy + 1): 24 * 10,
    }
    assert set(counts) == {(300, 200), (301, 200), (300, 201), (301, 201)}
    # off-grid edges across the same corner: as the brute count says
    poly = shapely.Polygon(
        [
            (w + 37.3 * STEP, n - 51.7 * STEP),
            (w + 90.1 * STEP, n - 45.2 * STEP),
            (w + 70.9 * STEP, n - 99.6 * STEP),
            (w + 20.2 * STEP, n - 80.4 * STEP),
        ]
    )
    counts, _ = kelp.burn(np.array([poly]))
    assert flat(counts) == brute([poly], cells_near([poly]))
    assert len(flat(counts)) == 4


def test_a_polygon_reaching_one_subpixel_into_the_next_cell_counts_there():
    # the windows are snapped out to whole cells, so only a span that ends on a cell's first subpixel can lose it
    gx, gy = MONTEREY
    w, n = -180 + gx * D, 90 - gy * D
    rect = shapely.box(
        w + 40 * STEP, n - (64 + 1) * STEP, w + (64 + 1) * STEP, n - 50 * STEP
    )
    counts, _ = kelp.burn(np.array([rect]))
    assert flat(counts) == {
        (gx, gy): 24 * 14,
        (gx + 1, gy): 1 * 14,
        (gx, gy + 1): 24 * 1,
        (gx + 1, gy + 1): 1,
    }


def test_the_antimeridian_splits_a_polygon_between_the_last_and_first_columns():
    gy = 256 * 150 + 7
    n = 90 - gy * D
    # 10 subpixels each side of 180°, written past 180°E and, separately, past 180°W
    east = shapely.box(180 - 10 * STEP, n - 30 * STEP, 180 + 10 * STEP, n - 5 * STEP)
    west = shapely.affinity.translate(east, -360)
    for poly in (east, west):
        counts, km2 = kelp.burn(np.array([poly]))
        assert flat(counts) == {(WIDTH - 1, gy): 10 * 25, (0, gy): 10 * 25}
        assert set(counts) == {(1023, 150), (0, 150)}
        assert km2 == pytest.approx(kelp.sphere_km2(np.array([poly])), rel=1e-6)
    # an off-grid one: as the brute count over both ends of the world
    poly = shapely.Polygon(
        [
            (179.99931, n - 0.00013),
            (180.00071, n - 0.00009),
            (180.00029, n - 0.00117),
            (179.99957, n - 0.00101),
        ]
    )
    counts, _ = kelp.burn(np.array([poly]))
    want = brute([poly], [(WIDTH - 1, gy), (0, gy)])
    assert flat(counts) == want and set(want) == {(WIDTH - 1, gy), (0, gy)}
    # the same ring written the long way round (-179.99943 → +179.99943) is not a small polygon: refused
    long_way = shapely.box(-180 + 0.00057, n - 0.0005, 180 - 0.00057, n)
    with pytest.raises(cell_share.SourceChanged, match="long way round"):
        kelp.burn(np.array([east, long_way]))


def test_coarser_levels_hold_the_exact_share_of_their_subpixels(tmp_path):
    rng = np.random.default_rng(7)
    gx0, gy0 = 256 * 400 + 250, 256 * 300 + 120  # a block of cells across a tile edge
    polys = []
    for _ in range(40):
        cx = -180 + (gx0 + rng.uniform(0, 12)) * D
        cy = 90 - (gy0 + rng.uniform(0, 12)) * D
        r = rng.uniform(0.2, 2.5) * D
        polys.append(shapely.Point(cx, cy).buffer(r, quad_segs=5))
    polys = np.array(
        shapely.get_parts(shapely.union_all(polys))
    )  # disjoint, as the release's are
    counts, _ = kelp.burn(polys)
    cells = cells_near(polys)
    assert flat(counts) == brute(polys, cells)
    m = kelp.write(counts, {"features": len(polys)}, tmp_path, now=None)
    pal = {tuple(c): i for i, c in enumerate(m["palette"])}
    for z in (9, 8, 6, 3, 0):
        want = brute(polys, cells, z)
        per = (S << (9 - z)) ** 2
        for (x, y), k in want.items():
            share = max(1, min(100, floor(Fraction(100 * k, per) + Fraction(1, 2))))
            im = Image.open(
                tmp_path / "kelp" / str(z) / str(x // 256) / f"{y // 256}.png"
            ).convert("RGBA")
            px = im.getpixel((x % 256, y % 256))
            assert px[3] == 255 and pal[px[:3]] == share, (z, x, y, k, share)
        assert sorted(map(tuple, m["tiles"][str(z)])) == sorted(
            {(x // 256, y // 256) for x, y in want}
        )


def test_subgrid_totals_are_cell_share_grids_of_the_virtual_raster():
    import rasterio

    for max_level, sub in ((2, 4), (3, 2)):
        width, height = 2 ** (max_level + 1) * 256 * sub, 2**max_level * 256 * sub
        step = 360 / width
        grid = cell_share.Grid(
            rasterio.Affine(step, 0, -180, 0, -step, 90), width, height, max_level
        )
        for z in range(max_level, -1, -1):
            tiles = [(x, y) for x in range(2 ** (z + 1)) for y in range(2**z)]
            want = cell_share.totals(tiles, [grid], z, max_level)
            got = cell_share.totals(tiles, [kelp.Subgrid(sub)], z, max_level)
            assert all((want[k] == got[k]).all() for k in tiles), (max_level, sub, z)
            assert int(got[tiles[0]][0, 0]) == (sub << (max_level - z)) ** 2


def test_a_count_over_the_cell_total_or_tiles_over_the_budget_publish_nothing(tmp_path):
    gy = 256 * 150 + 7
    n = 90 - gy * D
    east = shapely.box(180 - 10 * STEP, n - 30 * STEP, 180 + 10 * STEP, n - 5 * STEP)
    whole = cell_box(*MONTEREY)
    ok, _ = kelp.burn(np.array([whole]))
    m = kelp.write(
        ok, {"features": 1}, tmp_path
    )  # positive control: a full cell is 100%, published
    assert m["tiles"]["9"] == [[MONTEREY[0] // 256, MONTEREY[1] // 256]]
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))
    manifest = (tmp_path / "kelp.json").read_bytes()
    # the same place written at both ends of the world: each subpixel counted twice
    twice, _ = kelp.burn(np.array([east, shapely.affinity.translate(east, -360)]))
    assert max(flat(twice).values()) == 2 * 10 * 25
    full, _ = kelp.burn(
        np.array(
            [
                cell_box(WIDTH - 1, gy),
                shapely.affinity.translate(cell_box(WIDTH - 1, gy), -360),
            ]
        )
    )
    with pytest.raises(
        cell_share.SourceChanged, match="more class pixels than source pixels"
    ):
        kelp.write(full, {"features": 2}, tmp_path)
    with pytest.raises(
        cell_share.SourceChanged, match="over the 100 B budget: nothing published"
    ):
        kelp.write(ok, {"features": 1}, tmp_path, budget=100)
    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before
    assert (tmp_path / "kelp.json").read_bytes() == manifest
    assert m["tileBytes"] > 100  # the budget refused a real write, not an empty one


def test_drawn_and_polygon_areas_must_agree():
    kelp.check_areas(2216.2 * 1.004, 2216.2)  # positive control: 0.4% apart
    with pytest.raises(cell_share.SourceChanged, match="more than 0.5% apart"):
        kelp.check_areas(2216.2 * 1.006, 2216.2)
    with pytest.raises(cell_share.SourceChanged, match="more than 0.5% apart"):
        kelp.check_areas(2216.2 * 0.994, 2216.2)
    with pytest.raises(cell_share.SourceChanged, match="apart"):
        kelp.check_areas(0.0, 0.0)


def test_sphere_area_is_the_band_area_of_a_lon_lat_box():
    box = shapely.box(10, 40, 11, 41)
    want = (
        cell_share.EARTH_KM**2
        * np.radians(1)
        * (np.sin(np.radians(41)) - np.sin(np.radians(40)))
    )
    assert kelp.sphere_km2(np.array([box])) == pytest.approx(want, rel=1e-12)
    assert 9000 < want < 9500  # 1° x 1° at 40°N: ~9,400 km²


def test_palette_runs_light_to_dark_through_the_stated_stops():
    p = kelp.palette()
    assert len(p) == 101 and p[0] == [0, 0, 0]
    assert (
        p[1] == [255, 237, 160] and p[50] == [236, 112, 20] and p[100] == [102, 37, 6]
    )
    assert len({tuple(c) for c in p[1:]}) == 100
    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in p[1:]]
    assert all(a > b for a, b in zip(lum, lum[1:]))


def fixture_zip(path: Path, polys, crs="EPSG:4326") -> Path:
    """A zip of the release's layout holding a shapefile of `polys` (with Z, as the release's) at its member path.

    Written with pyogrio's raw writer, which CI's environment has (geopandas it does not)."""
    shp_dir = path / "shp"
    shp_dir.mkdir(parents=True)
    pyogrio.raw.write(
        shp_dir / "Global_Kelp_Canopy_2-24.shp",
        shapely.to_wkb(shapely.force_3d(np.array(polys)), flavor="iso"),
        field_data=[
            np.arange(1, len(polys) + 1, dtype=np.int64),
            np.array(["Peru"] * len(polys), dtype=object),
        ],
        fields=["OBJECTID", "Country"],
        driver="ESRI Shapefile",
        geometry_type="Polygon Z",
        crs=crs,
        encoding="UTF-8",
    )
    zpath = path / kelp.ZIP_NAME
    folder = kelp.MEMBER.rsplit("/", 1)[0]
    with zipfile.ZipFile(zpath, "w") as z:
        for f in sorted(shp_dir.iterdir()):
            z.write(f, f"{folder}/{f.name}")
    return zpath


def test_main_reads_the_zip_in_place_refuses_a_changed_file_and_a_wrong_count(tmp_path):
    polys = [
        cell_box(*MONTEREY, 0, 0, 64, 32),
        cell_box(MONTEREY[0] + 3, MONTEREY[1], 0, 0, 16, 16),
    ]
    src = fixture_zip(tmp_path, polys)
    # the fixture is the release's layout: Polygon Z, EPSG:4326, at the member path
    info = pyogrio.read_info(f"/vsizip/{src}/{kelp.MEMBER}")
    assert (info["geometry_type"], info["crs"], info["features"]) == (
        "Polygon Z",
        "EPSG:4326",
        2,
    )
    md5 = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(src.read_bytes())

    out, cache = tmp_path / "out", tmp_path / "cache"
    argv = ["--out-dir", str(out), "--cache", str(cache)]
    with pytest.raises(cell_share.SourceChanged, match="is not Zenodo's"):
        kelp.main(argv, fetch_to=fetch_to, md5="0" * 32, expect=2)
    # the refused download is not kept
    assert not cache.exists() or not list(cache.iterdir())
    with pytest.raises(cell_share.SourceChanged, match="2 features, not the 3"):
        kelp.main(argv, fetch_to=fetch_to, md5=md5, expect=3)
    assert not (out / "kelp.json").exists()
    m = kelp.main(argv, fetch_to=fetch_to, md5=md5, expect=2)  # positive control
    assert calls == [kelp.ZIP_URL] * 2  # the kept file is not fetched again
    assert m["features"] == 2 and m["maxLevel"] == 9 and m["subpixels"] == 64
    assert json.loads((out / "kelp.json").read_text()) == m
    leaf = [MONTEREY[0] // 256, MONTEREY[1] // 256]
    assert m["tiles"]["9"] == [leaf]
    im = Image.open(
        io.BytesIO((out / "kelp" / "9" / str(leaf[0]) / f"{leaf[1]}.png").read_bytes())
    )
    assert im.mode == "P"
    assert im.getpixel((MONTEREY[0] % 256, MONTEREY[1] % 256)) == 50
    # 256 of 4,096 subpixels: 6.25%
    assert im.getpixel(((MONTEREY[0] + 3) % 256, MONTEREY[1] % 256)) == 6
    assert m["kelpKm2"] == pytest.approx(m["drawnKm2"], abs=0.1)
    (cache / kelp.ZIP_NAME).write_bytes(b"changed")
    with pytest.raises(cell_share.SourceChanged, match="delete it to fetch again"):
        kelp.main(argv, fetch_to=fetch_to, md5=md5, expect=2)


def test_read_drops_z_and_refuses_another_crs(tmp_path):
    # positive control: the release's Polygon Z in EPSG:4326 reads as 2D polygons
    ok = fixture_zip(tmp_path / "ok", [cell_box(*MONTEREY)])
    polys = kelp.read_polygons(f"/vsizip/{ok}/{kelp.MEMBER}", expect=1)
    assert len(polys) == 1 and not shapely.has_z(polys).any()
    assert shapely.equals(polys[0], cell_box(*MONTEREY))
    src = fixture_zip(
        tmp_path / "merc", [shapely.box(0, 0, 1000, 1000)], crs="EPSG:3857"
    )
    with pytest.raises(cell_share.SourceChanged, match="is not EPSG:4326"):
        kelp.read_polygons(f"/vsizip/{src}/{kelp.MEMBER}", expect=1)


@pytest.mark.skipif(
    not REAL_ZIP.exists(), reason=f"the release zip is not cached at {REAL_ZIP}"
)
def test_the_real_release_reads_as_pinned():
    assert kelp._md5(REAL_ZIP) == kelp.ZIP_MD5
    polys = kelp.read_polygons(f"/vsizip/{REAL_ZIP}/{kelp.MEMBER}")
    assert len(polys) == 426489
    assert not shapely.has_z(polys).any()
    x0, y0, x1, y1 = shapely.total_bounds(polys)
    assert (
        -177 < x0 < -176.9
        and 178.8 < x1 < 178.9
        and -56 < y0 < -55.9
        and 61.4 < y1 < 61.5
    )
    # the paper's Source Data sums to 2,216.55 km²
    assert kelp.sphere_km2(polys) == pytest.approx(2216.18, abs=0.01)


def test_main_publishes_nothing_when_the_drawn_area_is_off(tmp_path, monkeypatch):
    polys = [cell_box(*MONTEREY, 0, 0, 64, 32)]
    src = fixture_zip(tmp_path, polys)
    md5 = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()
    out = tmp_path / "out"
    argv = ["--out-dir", str(out), "--cache", str(tmp_path / "cache")]

    def fetch_to(url, path):
        path.write_bytes(src.read_bytes())

    m = kelp.main(argv, fetch_to=fetch_to, md5=md5, expect=1)  # positive control
    assert m["drawnKm2"] == m["kelpKm2"]
    before = (out / "kelp.json").read_bytes()
    real_burn = kelp.burn

    def short_burn(polys, **kw):
        counts, km2 = real_burn(polys, **kw)
        return counts, km2 * 0.9  # as if a block were dropped

    monkeypatch.setattr(kelp, "burn", short_burn)
    with pytest.raises(cell_share.SourceChanged, match="more than 0.5% apart"):
        kelp.main(argv, fetch_to=fetch_to, md5=md5, expect=1)
    assert (out / "kelp.json").read_bytes() == before
