"""pipeline/nc_series.py: a yearly multi-step netCDF cached by ETag and read one step at a time (soil-moisture)."""

import numpy as np
import pytest

from pipeline import nc_series

REGEX = r"smang_m_gdo_\d{8}_\d{8}_t\.nc"


def test_cached_reuses_an_unchanged_file_refetches_a_changed_one_and_refuses_a_short_download(
    tmp_path,
):
    """The file is ~600 MB and the server rewrites it in place every dekad, so the ETag decides: same ETag, no download;
    a new one, a new download. A download shorter than the server's Content-Length is refused and the cached copy kept.
    Once a new year's file is in, last year's leaves the cache; a file of another name pattern stays."""
    fetched = []

    def fetch_to(body):
        def f(url, part):
            fetched.append(url)
            part.write_bytes(body)

        return f

    name = "smang_m_gdo_20260101_20261011_t.nc"
    p = nc_series.cached(
        "u",
        tmp_path,
        name,
        REGEX,
        head=lambda u: ('"a"', 5),
        fetch_to=fetch_to(b"12345"),
    )
    assert p.read_bytes() == b"12345" and fetched == ["u"]
    assert (
        nc_series.cached(
            "u",
            tmp_path,
            name,
            REGEX,
            head=lambda u: ('"a"', 5),
            fetch_to=fetch_to(b"xxxxx"),
        )
        == p
    )
    assert fetched == ["u"] and p.read_bytes() == b"12345", (
        "same ETag: not fetched again"
    )
    nc_series.cached(
        "u",
        tmp_path,
        name,
        REGEX,
        head=lambda u: ('"b"', 5),
        fetch_to=fetch_to(b"67890"),
    )
    assert (
        p.read_bytes() == b"67890" and (tmp_path / f"{name}.etag").read_text() == '"b"'
    )
    with pytest.raises(ValueError, match="downloaded 3 bytes, the server said 5"):
        nc_series.cached(
            "u",
            tmp_path,
            name,
            REGEX,
            head=lambda u: ('"c"', 5),
            fetch_to=fetch_to(b"123"),
        )
    assert (
        p.read_bytes() == b"67890" and (tmp_path / f"{name}.etag").read_text() == '"b"'
    ), "the good copy is kept"
    assert not (tmp_path / f"{name}.part").exists()
    (tmp_path / "notes.txt").write_text("keep")
    nxt = "smang_m_gdo_20270101_20270111_t.nc"
    nc_series.cached(
        "u2", tmp_path, nxt, REGEX, head=lambda u: ('"d"', 2), fetch_to=fetch_to(b"ok")
    )
    assert sorted(f.name for f in tmp_path.iterdir()) == [
        "notes.txt",
        nxt,
        f"{nxt}.etag",
    ]


def test_newest_file_is_the_last_year_listed_and_none_is_an_error():
    listing = (
        '<a href="smang_m_gdo_20250101_20251221_t.nc">x</a> <a href="smang_m_gdo_20250101_20251221_t.zip">z</a>'
        '<a href="smang_m_gdo_20260101_20261011_t.nc">y</a> <a href="copyright.txt">c</a>'
    )
    product = {"id": "soil-moisture", "file_regex": REGEX, "catalog": "https://e/"}
    assert (
        nc_series.newest_file(product, listing) == "smang_m_gdo_20260101_20261011_t.nc"
    )
    with pytest.raises(RuntimeError, match="no file matching"):
        nc_series.newest_file(product, '<a href="copyright.txt">c</a>')


def _write(path, noisy=True):
    xr = pytest.importorskip("xarray")
    pytest.importorskip("netCDF4")
    # a 4x2 grid of 90° cells from -180, 90 (north first), centres stored as float32 like smang's
    lon = np.array([-135.0, -45.0, 45.0, 135.0])
    lat = np.array([45.0, -45.0])
    if noisy:
        lon, lat = lon + 6e-6, lat - 2e-6
    v = np.array(
        [
            [[-2.5, -1.2, 0.3, np.nan], [1.2, 1.7, 2.0, 84808.8]],
            [[-1.7, 0.0, 1.0, -1.0], [-69.0, 1.49, np.nan, 3.0]],
        ],
        dtype="float32",
    )
    ds = xr.Dataset(
        {"smang": (("time", "lat", "lon"), v)},
        coords={
            "time": np.array(["2026-10-01", "2026-10-11"], dtype="datetime64[ns]"),
            "lat": lat.astype("float32"),
            "lon": lon.astype("float32"),
        },
    )
    ds.to_netcdf(path)
    return path


CLASSES = [
    {"label": f"c{k}", "rgb": [k * 30, 0, 0]} | ({"hidden": True} if k == 3 else {})
    for k in range(7)
]


def _product(**c):
    return {
        "id": "soil-moisture",
        "kind": "classes",
        "classes": CLASSES,
        "file_regex": REGEX,
        "nc_series": {
            "variable": "smang",
            "stride": 1,
            "offset": 0,
            "bins": [-2, -1.5, -1, 1, 1.5, 2],
            "grid": {"west": -180, "north": 90, "cell": 90, "width": 4, "height": 2},
        }
        | c,
    }


def test_fetch_draws_the_newest_step_classed_by_the_bins_on_exact_centres(tmp_path):
    """The newest step by default, classed by GDO's legend edges (v < -2 → 0 ... v >= 2 → 6), so the absurd values the
    file holds where the baseline barely varies (84808.8, -69) take the end classes as on GDO's map. The float32 centres
    are replaced by the configured grid's exact ones, so the bounds are the grid's edges (edge_align refused
    -180.0000061). Hidden near-normal (code 3) and NaN are clear."""
    path = _write(tmp_path / "smang_m_gdo_20260101_20261011_t.nc")
    rgba, when, extras = nc_series.fetch_nc_series(_product(), file=path)
    assert when == "2026-10-11T00:00:00Z"
    assert extras == {
        "bounds": {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
    }
    codes = [
        [None if px[3] == 0 and px[0] == 0 else px[0] // 30 for px in row]
        for row in rgba.tolist()
    ]
    assert codes == [[1, 3, 4, 3], [0, 4, None, 6]], (
        "-1.7→1, 0→3, 1.0→4 (edge goes up), -1.0→3; -69→0, 1.49→4, 3→6"
    )
    assert rgba[0, 1, 3] == 0 and rgba[0, 0, 3] == 255, (
        "near normal hidden, a class shown"
    )
    older, when0, _ = nc_series.fetch_nc_series(
        _product(time="2026-10-01T00:00:00Z"), file=path
    )
    assert when0 == "2026-10-01T00:00:00Z"
    assert [[px[0] // 30 for px in row] for row in older.tolist()][1] == [4, 5, 6, 6], (
        "84808.8 → the top class"
    )
    assert older[0, 0, 0] // 30 == 0 and older[0, 3, 3] == 0, (
        "-2.5 → bottom class; NaN clear"
    )
    with pytest.raises(ValueError, match="has no step 2026-09-21T00:00:00Z"):
        nc_series.fetch_nc_series(_product(time="2026-09-21T00:00:00Z"), file=path)
    moved = _product(
        grid={"west": -179, "north": 90, "cell": 90, "width": 4, "height": 2}
    )
    with pytest.raises(ValueError, match="cell centres are not the 90.0° grid"):
        nc_series.fetch_nc_series(moved, file=path)
    with pytest.raises(ValueError, match="grid is 4x2, expected 3x2"):
        nc_series.fetch_nc_series(
            _product(
                grid={"west": -180, "north": 90, "cell": 90, "width": 3, "height": 2}
            ),
            file=path,
        )
    with pytest.raises(ValueError, match="bins need kind classes"):
        nc_series.fetch_nc_series(_product() | {"kind": "ramp"}, file=path)


def test_series_steps_lists_the_files_steps_from_since_each_drawing_its_own_step(
    tmp_path,
):
    path = _write(tmp_path / "smang_m_gdo_20260101_20261011_t.nc")
    steps = nc_series.series_steps(_product(), "2026-10-05T00:00:00Z", file=path)
    assert [t for t, _ in steps] == ["2026-10-11T00:00:00Z"]
    steps = nc_series.series_steps(_product(), "2026-01-01T00:00:00Z", file=path)
    assert [t for t, _ in steps] == ["2026-10-01T00:00:00Z", "2026-10-11T00:00:00Z"]
    for t, v in steps:
        assert nc_series.fetch_nc_series(v, file=path)[1] == t
    assert "time" not in _product()["nc_series"], "the product itself is left as it was"


def test_raster_routes_nc_series_to_its_fetch_and_its_steps(monkeypatch, tmp_path):
    from pipeline import raster

    img = np.zeros((2, 4, 4), dtype=np.uint8)
    seen = []
    monkeypatch.setattr(
        nc_series,
        "fetch_nc_series",
        lambda p: seen.append(p["id"]) or (img, "2026-10-11T00:00:00Z", {"bounds": {}}),
    )
    monkeypatch.setattr(nc_series, "series_steps", lambda p, since: [("t", p)])
    rgba, when, _, _ = raster.render(_product(), tmp_path)
    assert seen == ["soil-moisture"] and when == "2026-10-11T00:00:00Z" and rgba is img
    assert raster.source_steps(_product(), "s") == [("t", _product())]
    assert raster.source_steps({"id": "x", "cmems": {}}, "s") == [], (
        "positive control: a newest-only source lists none"
    )


def test_soil_moisture_labels_say_where_the_bins_put_each_edge():
    """np.digitize puts a value on an edge in the class above it (edges[k-1] <= v < edges[k]), so the bottom class is
    "< −2" and the top "≥ 2"; it was labelled "≤ −2" while −2.0 itself was drawn one class up (PR #132 review)."""
    import json
    from pathlib import Path

    p = next(
        x
        for x in json.loads((Path(__file__).parents[1] / "rasters.json").read_text())
        if x["id"] == "soil-moisture"
    )
    edges, labels = p["nc_series"]["bins"], [c["label"] for c in p["classes"]]
    num = lambda e: f"{e:g}".replace("-", "−")
    assert len(labels) == len(edges) + 1
    assert labels[0].endswith(f"< {num(edges[0])} σ") and labels[-1].endswith(
        f"≥ {num(edges[-1])} σ"
    )
    for k in range(1, len(edges)):
        assert labels[k].endswith(f"{num(edges[k - 1])} to {num(edges[k])} σ"), labels[
            k
        ]
    assert list(
        np.digitize(np.array(edges, dtype=float), np.array(edges, dtype=float))
    ) == list(range(1, len(edges) + 1)), "each edge falls in the class it opens"


def test_a_strided_read_draws_the_picked_cells_on_their_own_centres(tmp_path):
    """Every 3rd cell from the 2nd (stride 3, offset 1), as soil-moisture takes every 5th from the 3rd: the picked cells'
    values must land on the picked cells' centres. With stride 1 and offset 0 any slicing lines up (PR #132 review), so
    here every cell not picked holds a near-normal 0 and each picked cell a value of its own class."""
    xr = pytest.importorskip("xarray")
    pytest.importorskip("netCDF4")
    lon = -165.0 + 30.0 * np.arange(12)  # 12 x 6 cells of 30 degrees, north first
    lat = 75.0 - 30.0 * np.arange(6)
    v = np.zeros((1, 6, 12), dtype="float32")
    v[0, 1, [1, 4, 7, 10]] = [-2.5, -1.7, -1.2, 1.2]
    v[0, 4, [1, 4, 7, 10]] = [1.7, 2.5, np.nan, -2.0]
    v[0, 1, 0] = v[0, 0, 1] = v[0, 2, 2] = (
        9.0  # a neighbour of a picked cell, in the top class: a slip would show it
    )
    xr.Dataset(
        {"smang": (("time", "lat", "lon"), v)},
        coords={
            "time": np.array(["2026-10-11"], dtype="datetime64[ns]"),
            "lat": lat.astype("float32"),
            "lon": lon.astype("float32"),
        },
    ).to_netcdf(tmp_path / "s.nc")
    product = _product(
        stride=3,
        offset=1,
        grid={"west": -180, "north": 90, "cell": 30, "width": 12, "height": 6},
    )
    rgba, when, extras = nc_series.fetch_nc_series(product, file=tmp_path / "s.nc")
    assert rgba.shape == (2, 4, 4) and when == "2026-10-11T00:00:00Z"
    assert extras == {
        "bounds": {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
    }
    codes = [
        [None if px[3] == 0 and px[0] == 0 else px[0] // 30 for px in row]
        for row in rgba.tolist()
    ]
    assert codes == [[0, 1, 2, 4], [5, 6, None, 1]], (
        "-2.0 itself is drawn in the class it opens"
    )
