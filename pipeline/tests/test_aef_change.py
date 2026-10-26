"""AlphaEarth change: the pinned index, locations with every year, reading a south-up overview, the frozen score, the
no-data mask, the coarse-pixel rule, painting, the cache and the output. Fixture COGs are 256 px of 64 int8 bands with
2x and 4x overviews, so the 4x overview is the 64-cell read."""

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from pipeline import aef_change as ac

rasterio = pytest.importorskip("rasterio")
duckdb = pytest.importorskip("duckdb")
from rasterio.transform import Affine

CRS = "EPSG:32631"
SIZE = 1280.0  # metres per cell, as at the real 128x overview
SIDE = ac.CELL * SIZE


def q(v: np.ndarray) -> np.ndarray:
    """Quantize unit vectors (64, ...) the way the dataset does: sign(v) · 127.5 · sqrt(|v|)."""
    return np.clip(np.round(np.sign(v) * 127.5 * np.sqrt(np.abs(v))), -127, 127).astype(
        np.int8
    )


def vec(seed: int) -> np.ndarray:
    v = np.random.default_rng(seed).normal(size=64)
    return v / np.linalg.norm(v)


def stack_years(base: np.ndarray, noise=0.02, seed=0) -> dict:
    """{year: 64 x CELL x CELL int8}: base (64,) everywhere, with a little independent noise per cell and year."""
    rng = np.random.default_rng(seed)
    out = {}
    for y in ac.YEARS:
        v = base[:, None, None] + noise * rng.normal(size=(64, ac.CELL, ac.CELL))
        out[y] = q(v / np.linalg.norm(v, axis=0))
    return out


def test_score_flags_new_2025_state_not_rotation_or_old_change():
    a = stack_years(vec(1))
    other, third = vec(2), vec(3)
    a[2025][:, 10, 10] = q(other)  # never seen before 2025: flagged
    for y in ac.YEARS:  # a two-crop rotation: 2025 equals 2023, so its novelty is low
        a[y][:, 20, 20] = q(other if y % 2 else third)
    for y in range(2021, 2026):  # changed in 2021 and stayed: by 2025 the state is old
        a[y][:, 30, 30] = q(other)
    z = ac.score(a)
    assert z[10, 10] > 40
    assert z[20, 20] < ac.THRESHOLD and z[30, 30] < ac.THRESHOLD
    flags = ac.band(z)
    assert flags[10, 10] == 4
    assert (flags > 0).mean() < 0.01  # noise alone stays below the line


def test_score_looks_back_three_years_against_the_median_year():
    a = stack_years(vec(21))
    x, y_ = vec(22), vec(23)
    for yr in (
        2022,
        2025,
    ):  # flooded in 2022 and again in 2025: 2025 is three years from a state seen before
        a[yr][:, 12, 12] = q(x)
    a[2021][:, 14, 14] = q(
        y_
    )  # a one-year event in 2021, then a new state in 2025: the 2021 spike is one year of five
    a[2025][:, 14, 14] = q(x)
    z = ac.score(a)
    assert z[12, 12] < ac.THRESHOLD
    assert z[14, 14] > 40


def test_score_floor_keeps_tiny_jumps_on_constant_ground_clear():
    a = stack_years(vec(4), noise=0.0)
    assert np.isfinite(ac.score(a)).all()
    assert (ac.score(a) < ac.THRESHOLD).all()
    # a 2025 nudge of cosine distance ~0.01 on perfectly constant ground: MAD is 0, the floor of 0.003 makes it ~3
    nudged = vec(4) + 0.14 * vec(5)
    a[2025][:, 5, 5] = q(nudged / np.linalg.norm(nudged))
    z = ac.score(a)
    assert 0 < z[5, 5] < ac.THRESHOLD
    a[2025][:, 6, 6] = q(vec(6))  # a real jump on the same ground is flagged
    assert ac.score(a)[6, 6] > ac.THRESHOLD


def test_no_data_in_any_year_masks_the_cell_and_its_neighbours():
    a = stack_years(vec(7))
    a[2018][:, 40, 40] = -128
    z = ac.score(a)
    assert np.isnan(z[39:42, 39:42]).all()
    assert np.isfinite(z[37, 40]) and np.isfinite(z[40, 43])
    assert np.isfinite(z).sum() == ac.CELL**2 - 9
    assert (ac.band(z)[39:42, 39:42] == ac.NO_SCORE).all()


def test_band_edges():
    z = np.array([np.nan, 0.0, 6.49, 6.5, 9.99, 10.0, 39.9, 40.0, 1e6], np.float32)
    assert ac.band(z).tolist() == [255, 0, 0, 1, 1, 2, 3, 4, 4]


def cog(
    path: Path,
    data: np.ndarray,
    x0: float,
    y_top: float,
    south_up: bool,
    overviews=(2, 4),
) -> str:
    """A 64-band int8 GeoTIFF of `data` (64, 256, 256; north row first), stored rows south first when south_up, as
    AEF's are."""
    px = SIDE / 256
    tf = (
        Affine(px, 0, x0, 0, px, y_top - SIDE)
        if south_up
        else Affine(px, 0, x0, 0, -px, y_top)
    )
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=256,
        height=256,
        count=64,
        dtype="int8",
        crs=CRS,
        transform=tf,
        nodata=-128,
        tiled=True,
        blockxsize=256,
        blockysize=256,
    ) as dst:
        dst.write(data[:, ::-1] if south_up else data)
        if overviews:
            dst.build_overviews(list(overviews), rasterio.enums.Resampling.nearest)
    return str(path)


def test_open_overview_returns_north_up_from_a_south_up_file(tmp_path):
    data = np.zeros((64, 256, 256), np.int8)
    data[0, :128] = 100  # north half
    data[0, 128:] = -100
    x0, top = 500000.0, 5000000.0
    for south_up in (True, False):
        a, tf = ac.open_overview(
            cog(tmp_path / f"t{south_up}.tif", data, x0, top, south_up)
        )
        assert a.shape == (64, 64, 64)
        assert a[0, 0, 0] == 100 and a[0, 63, 0] == -100  # row 0 is north either way
        assert (tf.c, tf.f, tf.a, tf.e) == (x0, top, SIZE, -SIZE)
    with pytest.raises(ValueError, match="no 64-cell overview"):
        ac.open_overview(
            cog(tmp_path / "noovr.tif", data, x0, top, True, overviews=(2,))
        )


def write_index(path: Path, rows: list[tuple]) -> Path:
    """A parquet index of (zone, crs, utm_west, utm_south, year, path, west, south, east, north)."""
    con = duckdb.connect()
    con.execute(
        "create table t (utm_zone varchar, crs varchar, utm_west double, utm_south double, utm_east double,"
        " utm_north double, year bigint, path varchar, wgs84_west double, wgs84_south double, wgs84_east double,"
        " wgs84_north double)"
    )
    for zone, crs, uw, us, year, p, w, s, e, n in rows:
        con.execute(
            "insert into t values (?,?,?,?,?,?,?,?,?,?,?,?)",
            [zone, crs, uw, us, uw + SIDE, us + SIDE, year, p, w, s, e, n],
        )
    con.execute("copy t to ? (format parquet)", [str(path)])
    return path


def test_read_locations_keeps_only_footprints_with_every_year(tmp_path):
    rows = [("31N", CRS, 0.0, 0.0, y, f"a{y}", 1, 2, 3, 4) for y in ac.YEARS]
    rows += [
        ("31N", CRS, SIDE, 0.0, y, f"b{y}", 1, 2, 3, 4) for y in ac.YEARS if y != 2019
    ]
    locs, skipped = ac.read_locations(write_index(tmp_path / "i.parquet", rows))
    assert skipped == 1
    assert [x["key"] for x in locs] == ["31N_0_0"]
    assert (
        locs[0]["paths"][2025] == "a2025"
        and locs[0]["crs"] == CRS
        and locs[0]["utm"] == (0.0, 0.0, SIDE, SIDE)
    )
    bad = rows + [("31N", "EPSG:32632", 0.0, 0.0, 2020, "x", 1, 2, 3, 4)]
    with pytest.raises(ValueError, match="CRS differs"):
        ac.read_locations(write_index(tmp_path / "j.parquet", bad))


def test_fetch_index_refuses_a_changed_file_and_keeps_the_pinned_one(tmp_path):
    body = b"index bytes"
    good = hashlib.sha256(body).hexdigest()

    def fetch_to(url, path):
        path.write_bytes(body)

    path = ac.fetch_index(tmp_path, good, fetch_to=fetch_to)
    assert path.read_bytes() == body
    with pytest.raises(ValueError, match="sha256"):
        ac.fetch_index(tmp_path, "0" * 64, fetch_to=fetch_to)
    assert not path.exists()


def test_classify_paints_a_quarter_flagged_pixel_in_the_median_band():
    finest = np.full((4, 4), 0, np.uint8)
    finest[0, 0] = 3  # 1 of 4 in the top-left 2 x 2: painted, band 3
    finest[0, 2] = 4  # top-right: 3 flagged of 4, bands 1, 1, 4: median 1
    finest[1, 2] = finest[1, 3] = 1
    finest[2:, :2] = ac.NO_SCORE
    finest[3, 1] = 2  # bottom-left: 1 scored pixel, flagged: painted
    finest[2:, 2:] = ac.NO_SCORE  # bottom-right: nothing scored
    counts = ac.halve(ac.one_hot(finest))
    assert (
        ac.classify(ac.one_hot(finest)).tolist()
        == np.where(finest == ac.NO_SCORE, 0, finest).tolist()
    )
    assert ac.classify(counts).tolist() == [[3, 1], [2, 0]]
    sparse = np.zeros((8, 8), np.uint8)
    sparse[0, 0] = 4  # 1 in 16 after two halvings: below COVER, clear
    assert ac.classify(ac.halve(ac.halve(ac.one_hot(sparse)))).tolist() == [
        [0, 0],
        [0, 0],
    ]


def fixture_location(tmp_path: Path, x0: float, y0: float, changed: bool) -> dict:
    """A location in UTM 31N whose nine years are south-up fixture COGs; when changed, 8 x 8 cells in the north half
    (rows 8-15, columns 28-35) change in 2025, so a row flip would move them."""
    from rasterio.warp import transform_bounds

    base = vec(11)
    paths = {}
    for y in ac.YEARS:
        v = np.broadcast_to(base[:, None, None], (64, 256, 256)).copy()
        if changed and y == 2025:
            v[:, 32:64, 112:144] = vec(12)[:, None, None]
        rng = np.random.default_rng(y)
        v = v + 0.02 * rng.normal(size=v.shape)
        paths[y] = cog(
            tmp_path / f"{x0:.0f}_{y}.tif",
            q(v / np.linalg.norm(v, axis=0)),
            x0,
            y0 + SIDE,
            True,
        )
    return {
        "key": f"31N_{x0:.0f}_{y0:.0f}",
        "crs": CRS,
        "utm": (x0, y0, x0 + SIDE, y0 + SIDE),
        "wgs84": transform_bounds(CRS, "EPSG:4326", x0, y0, x0 + SIDE, y0 + SIDE),
        "paths": paths,
    }


def test_build_paints_the_changed_patch_and_resumes_from_the_cache(tmp_path):
    from pyproj import Transformer

    locs = [
        fixture_location(tmp_path, 400000.0, 5000000.0, True),
        fixture_location(tmp_path, 400000.0 + SIDE, 5000000.0, False),
    ]
    scores = ac.score_all(locs, tmp_path / "cache", workers=4)
    m = ac.build(locs, scores, tmp_path / "out", max_level=6)
    assert m["locationsScored"] == 2 and m["classes"][3]["km2"] > 0
    flagged_km2 = sum(c["km2"] for c in m["classes"])
    assert (
        60 < flagged_km2 < 160
    )  # 8 x 8 cells of 1.64 km² = 105 km², drawn at ~1.2 km x ~0.8 km pixels
    assert 0.9 * 2 * (SIDE / 1000) ** 2 < m["scoredKm2"] < 1.1 * 2 * (SIDE / 1000) ** 2
    to_geo = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    d = 180 / 2**6 / 256

    def pixel(x, y):
        lon, lat = to_geo.transform(x, y)
        gx, gy = int((lon + 180) / d), int((90 - lat) / d)
        tile = (
            tmp_path / "out" / "aef_change" / "6" / str(gx // 256) / f"{gy // 256}.png"
        )
        return (
            Image.open(tile).getpixel((gx % 256, gy % 256)) if tile.exists() else None
        )

    centre_x = 400000.0 + 32 * SIZE
    assert (
        pixel(centre_x, 5000000.0 + SIDE - 12 * SIZE) == 4
    )  # the patch, 12 cells below the north edge
    assert pixel(centre_x, 5000000.0 + 12 * SIZE) in (
        0,
        None,
    )  # where a row flip would put it: clear
    assert pixel(400000.0 + SIDE + 32 * SIZE, 5000000.0 + SIDE - 12 * SIZE) in (
        0,
        None,
    )  # the unchanged location
    doc = json.loads((tmp_path / "out" / "aef_change.json").read_text())
    assert doc["tiles"] == m["tiles"] and doc["source"]["licence"] == "CC BY 4.0"
    assert all(str(k) in doc["tiles"] for k in range(7))

    def broken(path):
        raise AssertionError("read again despite the cache")

    again = ac.score_all(locs, tmp_path / "cache", workers=4, opener=broken)
    assert all(np.array_equal(again[k], scores[k], equal_nan=True) for k in scores)


def test_a_file_that_keeps_failing_fails_the_run_and_one_retry_is_fine(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(ac.time, "sleep", lambda s: None)
    loc = fixture_location(tmp_path, 400000.0, 5000000.0, False)
    calls = []

    def flaky(path):
        calls.append(path)
        if len(calls) == 1:
            raise OSError("reset")
        return ac.open_overview(path)

    assert np.isfinite(ac.score_location(loc, flaky)).all()

    def dead(path):
        raise OSError("HTTP 503")

    with pytest.raises(RuntimeError, match="3 reads failed: HTTP 503"):
        ac.score_location(loc, dead)


def test_an_overview_off_the_index_footprint_is_refused(tmp_path):
    loc = fixture_location(tmp_path, 400000.0, 5000000.0, False)
    loc["utm"] = (400000.0 + SIZE, 5000000.0, 400000.0 + SIZE + SIDE, 5000000.0 + SIDE)
    with pytest.raises(ValueError, match="not the index's footprint"):
        ac.score_location(loc)


def test_paint_keeps_the_first_scored_cell_where_two_locations_meet():
    from rasterio.warp import transform_bounds

    fp = (400000.0, 5000000.0, 400000.0 + SIDE, 5000000.0 + SIDE)

    def loc(key):
        return {
            "key": key,
            "crs": CRS,
            "utm": fp,
            "wgs84": transform_bounds(CRS, "EPSG:4326", *fp),
            "paths": {},
        }

    flagged = np.full((ac.CELL, ac.CELL), 25.0, np.float32)
    quiet = np.zeros((ac.CELL, ac.CELL), np.float32)
    empty = np.full((ac.CELL, ac.CELL), np.nan, np.float32)
    lon, lat = transform_bounds(CRS, "EPSG:4326", *fp)[:2]
    block = (int((lon + 180) // 45), int((90 - lat) // 45))
    first = ac.paint_block([loc("a"), loc("b")], {"a": flagged, "b": quiet}, block, 6)
    assert (first == 3).sum() > 4000 and (first == 0).sum() == 0
    second = ac.paint_block([loc("a"), loc("b")], {"a": empty, "b": quiet}, block, 6)
    assert (second == 0).sum() > 4000, "where the first has no score, the second fills"
