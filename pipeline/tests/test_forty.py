"""Forest Typology 2020: the pinned STAC index and its class table, reading a COG's 16x overview, classing by the summed
probabilities, the pyramid, the output. Fixture COGs are written with rasterio in UTM zone 31N, 1 km pixels, with
average overviews (the real ones are cubic), so a uniform region has the same probabilities at every level."""

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from pipeline import forty

rasterio = pytest.importorskip("rasterio")
duckdb = pytest.importorskip("duckdb")
from rasterio.transform import Affine

CRS = "EPSG:32631"
N = 256  # 256 km square fixture tiles, 16 x 16 px at the 16x overview


def cog(
    path: Path,
    bands: np.ndarray,
    x0: float,
    y_top: float,
    bottom_up: bool = False,
    overviews=(2, 4, 8, 16),
) -> str:
    """A 5-band uint8 GeoTIFF of `bands` (north row first) with its top-left corner at (x0, y_top) in UTM 31N metres;
    written with rows south first when bottom_up, as ForTy's are."""
    data = bands[:, ::-1] if bottom_up else bands
    tf = (
        Affine(1000, 0, x0, 0, 1000, y_top - N * 1000)
        if bottom_up
        else Affine(1000, 0, x0, 0, -1000, y_top)
    )
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=N,
        height=N,
        count=bands.shape[0],
        dtype="uint8",
        crs=CRS,
        transform=tf,
        nodata=255,
        tiled=True,
        blockxsize=256,
        blockysize=256,
    ) as dst:
        dst.write(data)
        if overviews:
            dst.build_overviews(list(overviews), rasterio.enums.Resampling.average)
    return str(path)


def fill(*probs) -> np.ndarray:
    """A uniform tile with the five given probabilities (0-250)."""
    return np.stack([np.full((N, N), p, np.uint8) for p in probs])


def item(href, west, south, east, north, id_="t"):
    return {
        "id": id_,
        "href": href,
        "west": west,
        "south": south,
        "east": east,
        "north": north,
    }


def bbox(x0, y_top):
    """Geographic bbox of a fixture tile, slightly padded."""
    from rasterio.warp import transform_bounds

    w, s, e, n = transform_bounds(
        CRS, "EPSG:4326", x0, y_top - N * 1000, x0 + N * 1000, y_top
    )
    return w - 0.01, s - 0.01, e + 0.01, n + 0.01


def index_at(out: Path, m: dict, lat: float, lon: float, z: int | None = None) -> int:
    """The palette index the pyramid holds at a point, at level z (the finest by default); 0 for an unwritten tile."""
    z = m["maxLevel"] if z is None else z
    d = 180 / 2**z
    x, y = int((lon + 180) // d), int((90 - lat) // d)
    if [x, y] not in m["tiles"][str(z)]:
        return 0
    px = int(((lon + 180) - x * d) / d * 256)
    py = int(((90 - lat) - y * d) / d * 256)
    return int(
        np.asarray(Image.open(out / "forty" / str(z) / str(x) / f"{y}.png"))[py, px]
    )


def utm_to_geo(x, y):
    from rasterio.warp import transform

    lon, lat = transform(CRS, "EPSG:4326", [x], [y])
    return lat[0], lon[0]


def test_build_classes_each_place_by_its_most_likely_type_north_up_whichever_way_the_rows_run(
    tmp_path,
):
    """Top half primary, bottom half naturally regenerating, the east quarter other land, a corner without data. The
    same ground written bottom-up (as ForTy is) and top-down draws the same; other land and no data stay clear."""
    b = fill(10, 10, 10, 10, 10)
    b[0, : N // 2] = 200
    b[1, N // 2 :] = 200
    b[:, :, 3 * N // 4 :] = 10  # other = 250 - 50 = 200
    b[:, : N // 8, : N // 8] = 255
    x0, y_top = 300000, 3000000  # about 27°N, 1°E
    built = {}
    for flip in (True, False):
        href = cog(tmp_path / f"t{flip}.tif", b, x0, y_top, bottom_up=flip)
        out = tmp_path / f"out{flip}"
        m = forty.build([item(href, *bbox(x0, y_top))], out, max_level=3, workers=2)
        pts = {
            "north": utm_to_geo(x0 + 100_000, y_top - 70_000),
            "south": utm_to_geo(x0 + 100_000, y_top - 190_000),
            "other": utm_to_geo(x0 + 230_000, y_top - 190_000),
            "nodata": utm_to_geo(x0 + 10_000, y_top - 10_000),
            "outside": utm_to_geo(x0 - 60_000, y_top - 100_000),
        }
        built[flip] = {k: index_at(out, m, *v) for k, v in pts.items()}
    assert built[True] == {
        "north": 1,
        "south": 2,
        "other": 0,
        "nodata": 0,
        "outside": 0,
    }
    assert built[False] == built[True]


def test_overlapping_tiles_sum_their_probabilities_rather_than_the_last_one_winning(
    tmp_path,
):
    """Two tiles over the same ground: A says primary 0.8, naturally regenerating 0.2; B says regenerating 0.48, other
    0.52. Alone, B would leave the ground clear; summed, primary (0.8) leads regenerating (0.68) and other (0.52)."""
    x0, y_top = 300000, 3000000
    a = cog(tmp_path / "a.tif", fill(200, 50, 0, 0, 0), x0, y_top)
    b = cog(tmp_path / "b.tif", fill(0, 120, 0, 0, 0), x0, y_top)
    lat, lon = utm_to_geo(x0 + 128_000, y_top - 128_000)
    m = forty.build(
        [item(b, *bbox(x0, y_top), "b")], tmp_path / "b_only", max_level=3, workers=1
    )
    assert index_at(tmp_path / "b_only", m, lat, lon) == 0, (
        "control: B alone is other land"
    )
    m = forty.build(
        [item(a, *bbox(x0, y_top), "a"), item(b, *bbox(x0, y_top), "b")],
        tmp_path / "both",
        max_level=3,
        workers=1,
    )
    assert index_at(tmp_path / "both", m, lat, lon) == 1


def test_a_coarser_pixel_takes_the_type_its_area_most_likely_is_not_any_forest_inside_it():
    """One child primary (0.9) and three other land: summed, other land leads, so the parent is clear; three primary
    children and one other: primary. A majority over painted children only would paint the first one primary."""
    sums = np.zeros((6, 2, 2), np.float32)
    weight = np.ones((2, 2), np.float32)
    sums[0, 0, 0], sums[5, 0, 0] = 0.9, 0.1
    sums[5, 0, 1] = sums[5, 1, 0] = sums[5, 1, 1] = 1
    assert forty.classify(sums, weight).tolist() == [[1, 0], [0, 0]]
    assert forty.classify(forty.halve(sums), forty.halve(weight)).tolist() == [[0]]
    sums[0], sums[5] = 0.9, 0.1
    sums[0, 1, 1], sums[5, 1, 1] = 0, 1
    assert forty.classify(forty.halve(sums), forty.halve(weight)).tolist() == [[1]]
    assert forty.classify(sums, np.zeros((2, 2), np.float32)).tolist() == [
        [0, 0],
        [0, 0],
    ], "no data is clear"


def _stac(path: Path, classes=None) -> Path:
    classes = classes or forty.STAC_CLASSES
    cls = ", ".join(
        f"{{'value': {i}, 'name': '{c}', 'title': '{c}'}}"
        for i, c in enumerate(classes)
    )
    duckdb.sql(
        f"copy (select 'raster_31R_1' as id, {{'forty': {{'href': 'https://e/x.tif', 'classification:classes': [{cls}]}}}} as assets,"
        " {'xmin': 1.0, 'ymin': 2.0, 'xmax': 3.0, 'ymax': 4.0} as bbox) to '"
        + str(path)
        + "' (format parquet)"
    )
    return path


def test_the_stac_index_is_pinned_and_its_class_table_checked(tmp_path):
    good = _stac(tmp_path / "good.parquet")
    sha = hashlib.sha256(good.read_bytes()).hexdigest()
    cache = tmp_path / "cache"
    p = forty.fetch_stac(
        cache,
        sha,
        url="u",
        fetch_to=lambda u, part: part.write_bytes(good.read_bytes()),
    )
    assert forty.read_items(p) == [
        {
            "id": "raster_31R_1",
            "href": "https://e/x.tif",
            "west": 1.0,
            "south": 2.0,
            "east": 3.0,
            "north": 4.0,
        }
    ]
    with pytest.raises(ValueError, match="the index changed"):
        forty.fetch_stac(
            tmp_path / "c2",
            "0" * 64,
            url="u",
            fetch_to=lambda u, part: part.write_bytes(good.read_bytes()),
        )
    assert not (tmp_path / "c2" / "forty_2020_stac.parquet").exists(), (
        "the changed file is deleted"
    )
    swapped = forty.STAC_CLASSES[:]
    swapped[2], swapped[3] = swapped[3], swapped[2]
    with pytest.raises(ValueError, match="1 items lack the class table"):
        forty.read_items(_stac(tmp_path / "swapped.parquet", swapped))


def test_a_tile_is_retried_then_fails_the_run_by_name(tmp_path, monkeypatch):
    monkeypatch.setattr(forty.time, "sleep", lambda s: None)
    x0, y_top = 300000, 3000000
    href = cog(tmp_path / "a.tif", fill(200, 0, 0, 0, 0), x0, y_top)
    calls = []

    def flaky(h, fails):
        calls.append(h)
        if len(calls) <= fails:
            raise OSError("HTTP 503")
        return forty.open_tile(h)

    m = forty.build(
        [item(href, *bbox(x0, y_top))],
        tmp_path / "ok",
        max_level=3,
        workers=1,
        opener=lambda h: flaky(h, 2),
    )
    assert len(calls) == 3 and m["classes"][0]["km2"] > 0, "two failures, then read"
    calls.clear()
    with pytest.raises(RuntimeError, match="raster_31R_9: 3 reads failed: HTTP 503"):
        forty.build(
            [item(href, *bbox(x0, y_top), "raster_31R_9")],
            tmp_path / "bad",
            max_level=3,
            workers=1,
            opener=lambda h: flaky(h, 3),
        )
    assert not (tmp_path / "bad" / "forty.json").exists()


def test_open_tile_reads_the_16x_overview_and_refuses_a_cog_without_one(tmp_path):
    a, tf, crs = forty.open_tile(
        cog(tmp_path / "a.tif", fill(200, 0, 0, 0, 0), 300000, 3000000)
    )
    assert a.shape == (5, 16, 16) and tf.a == 16000 and str(crs) == CRS
    with pytest.raises(ValueError, match=r"overviews \[2, 4, 8\], no 16x"):
        forty.open_tile(
            cog(
                tmp_path / "b.tif",
                fill(200, 0, 0, 0, 0),
                300000,
                3000000,
                overviews=(2, 4, 8),
            )
        )
    with pytest.raises(ValueError, match="4 bands of uint8, expected 5"):
        forty.open_tile(cog(tmp_path / "c.tif", fill(200, 0, 0, 0), 300000, 3000000))


def test_the_manifest_lists_exactly_the_tiles_written_with_each_types_area(tmp_path):
    x0, y_top = 300000, 3000000
    b = fill(10, 10, 10, 10, 10)
    b[0, : N // 2] = 200
    b[4, N // 2 :] = 200
    href = cog(tmp_path / "a.tif", b, x0, y_top)
    out = tmp_path / "out"
    m = forty.build([item(href, *bbox(x0, y_top))], out, max_level=3, workers=1)
    on_disk = sorted(
        str(p.relative_to(out / "forty")) for p in (out / "forty").rglob("*.png")
    )
    listed = sorted(f"{z}/{x}/{y}.png" for z, ts in m["tiles"].items() for x, y in ts)
    assert (
        on_disk == listed
        and set(m["tiles"]) == {"0", "1", "2", "3"}
        and all(m["tiles"].values())
    )
    assert json.loads((out / "forty.json").read_text()) == m
    km2 = {c["label"]: c["km2"] for c in m["classes"]}
    assert (
        25_000 < km2["primary forest"] < 40_000
        and 25_000 < km2["tree crops and agroforestry"] < 40_000
    ), km2
    assert km2["planted forest"] == 0
    assert (
        m["source"]["licence"] == "CC BY 4.0"
        and m["tile"] == "data/forty/{z}/{x}/{y}.png"
    )
    assert m["classes"][0]["rgb"] == [0x1B, 0x78, 0x37]


def test_probabilities_cap_a_cubic_overshoot_at_one():
    """The 16x overviews are cubic, which can overshoot 250 near an edge: 253 is a probability of 1, not 1.012, and
    leaves nothing for other land. A value inside the range passes through (positive control)."""
    a = np.zeros((5, 1, 2), np.uint8)
    a[0, 0] = [253, 125]
    p = forty.probabilities(a)
    assert p[:, 0, 0].tolist() == [1, 0, 0, 0, 0, 0, 1]
    assert p[:, 0, 1].tolist() == [0.5, 0, 0, 0, 0, 0.5, 1]
    assert np.allclose(p[:6].sum(0), 1)


def test_a_tile_is_painted_to_its_edges(tmp_path):
    """A uniform primary tile paints right up to each edge (5 and 15 km in), so neighbouring tiles meet without a clear
    seam; ground just outside stays clear (control)."""
    x0, y_top = 300000, 3000000
    href = cog(tmp_path / "t.tif", fill(200, 10, 10, 10, 10), x0, y_top, bottom_up=True)
    out = tmp_path / "out"
    m = forty.build([item(href, *bbox(x0, y_top))], out, max_level=3, workers=2)
    mid, far = N * 500, N * 1000
    inside = {
        f"{side} {k} km": utm_to_geo(*xy)
        for k in (5, 15)
        for side, xy in {
            "north": (x0 + mid, y_top - k * 1000),
            "south": (x0 + mid, y_top - far + k * 1000),
            "west": (x0 + k * 1000, y_top - mid),
            "east": (x0 + far - k * 1000, y_top - mid),
        }.items()
    }
    assert {k: index_at(out, m, *v) for k, v in inside.items()} == dict.fromkeys(
        inside, 1
    )
    assert index_at(out, m, *utm_to_geo(x0 + mid, y_top + 40_000)) == 0
