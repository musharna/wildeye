"""cmems-pft: dominant phytoplankton group per 0.25° cell (spec docs/superpowers/specs/2026-10-07-cmems-phytoplankton-types.md)."""

import datetime as dt
import json
from pathlib import Path

import numpy as np
import pytest

from pipeline import freshness
from pipeline.cmems_pft import (
    GridChanged,
    check_grid,
    dominant_group,
    fetch_cmems_dominant,
    paint_classes,
)
from pipeline.raster import archive_frame

HERE = Path(__file__).resolve().parent.parent
GROUPS = ["DIATO", "DINO", "HAPTO", "GREEN", "PROKAR"]
D, N, H, G, P = range(5)


def _cells(n_cells_x=4, block=6, fill=0.1):
    """A (5, block, n_cells_x * block) stack, every group `fill` everywhere: one row of cells."""
    return np.full((5, block, n_cells_x * block), fill, np.float32)


def test_block_mean_then_argmax_not_a_vote_of_pixels():
    """In cell 0 haptophytes lead on 35 of 36 pixels but one diatom bloom pixel carries the block mean: diatoms (a
    vote of pixels would give haptophytes). Cell 2 is the reverse: one diatom pixel of 3.0 against haptophytes at 0.5
    everywhere, so the mean is haptophytes and the block maximum would be diatoms. Mutants seen failing: argmin, block
    max instead of mean (cell 2), block axes transposed."""
    s = _cells(3)
    s[H, :, 0:6] = 0.11
    s[D, 0, 0] = 10.0
    s[G, :, 6:12] = 0.5  # cell 1: positive control, green algae plainly
    s[H, :, 12:18] = 0.5
    s[D, 0, 12] = 3.0
    assert dominant_group(s, 6).tolist() == [[D, G, H]]


def test_a_pixel_missing_any_group_is_left_out_for_every_group():
    """Cell 0: where PROKAR is NaN (cloud in its retrieval) diatoms are huge; over the pixels where all five exist
    PROKAR leads. Per-group nanmean would pick diatoms. Cell 1 (positive control) has no NaN: PROKAR. Cell 2 has no
    pixel with all five groups: -1. Cell 3 is all NaN: -1. Mutants seen failing: per-group nanmean (cell 0 -> D),
    `cnt == 0` mask dropped (cells 2-3 -> 0), a pixel kept when any group is present."""
    s = _cells(4)
    s[P, :, 0:12] = 0.3
    s[P, 0:3, 0:6] = np.nan
    s[D, 0:3, 0:6] = 5.0
    s[D, :, 12:18] = 1.0
    s[N, :, 12:18] = np.nan  # every pixel of cell 2 lacks dinoflagellates
    s[:, :, 18:24] = np.nan
    out = dominant_group(s, 6)
    assert out.tolist() == [[P, P, -1, -1]]
    assert out.dtype == np.int8


def test_ties_go_to_the_first_class_and_shape_must_divide():
    s = _cells(1)
    assert dominant_group(s, 6).tolist() == [[0]]
    s[3] = 0.2
    assert dominant_group(s, 6).tolist() == [[3]]
    with pytest.raises(ValueError, match="divisible"):
        dominant_group(np.zeros((5, 7, 12), np.float32), 6)


def test_paint_classes_colours_each_group_and_leaves_no_data_clear():
    cls = np.array([[0, 1, -1], [4, 2, 3]], np.int8)
    rgbs = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15]]
    out = paint_classes(cls, rgbs)
    assert out.shape == (2, 3, 4) and out.dtype == np.uint8
    assert out[0, 0].tolist() == [1, 2, 3, 255] and out[0, 1].tolist() == [4, 5, 6, 255]
    assert out[1, 0].tolist() == [13, 14, 15, 255] and out[1, 2].tolist() == [
        10,
        11,
        12,
        255,
    ]
    assert out[0, 2, 3] == 0


def _grid(w, h):
    lon = (-180 + (np.arange(w) + 0.5) * 360 / w).astype(np.float32)
    lat = (-90 + (np.arange(h) + 0.5) * 180 / h).astype(np.float32)
    return lat, lon


def test_check_grid_accepts_the_whole_globe_at_the_stated_size_only():
    lat, lon = _grid(12, 6)
    check_grid(lat, lon, [12, 6])  # positive control, south first
    check_grid(lat[::-1], lon, [12, 6])  # and north first
    with pytest.raises(GridChanged, match="12x6"):
        check_grid(lat, lon, [24, 12])
    with pytest.raises(GridChanged, match="12x6, expected 12x12"):
        check_grid(lat, lon, [12, 12])  # the height alone differs
    with pytest.raises(GridChanged, match="longitude"):
        check_grid(lat, lon + 0.25, [12, 6])  # shifted by a quarter cell
    with pytest.raises(GridChanged, match="latitude"):
        check_grid(np.linspace(-80, 80, 6).astype(np.float32), lon, [12, 6])


class _DA:
    def __init__(self, arr, dims):
        self.values, self.dims = arr, dims

    def isel(self, **kw):
        a = self.values
        if "time" in kw:
            a = a[kw["time"]]
        return _DA(a, tuple(d for d in self.dims if d not in kw))


def _product(rgbs=None):
    rgbs = rgbs or [
        [230, 159, 0],
        [204, 121, 167],
        [86, 180, 233],
        [0, 158, 115],
        [240, 228, 66],
    ]
    return {
        "id": "cmems-pft",
        "cmems_dominant": {"dataset_id": "pft", "block": 6, "grid": [12, 12]},
        "classes": [
            {"label": v.lower(), "variable": v, "rgb": c} for v, c in zip(GROUPS, rgbs)
        ],
    }


def _dataset():
    """Two months on a 12x12 globe (2x2 cells), latitude south first. Month 1 (index 1): south-west cell
    diatoms, south-east haptophytes, north-west prokaryotes, north-east all NaN. PROCHLO is huge everywhere and must
    not be read."""
    times = np.array(["2026-08-01", "2026-09-01", "2026-10-01"], dtype="datetime64[ns]")
    lat, lon = _grid(12, 12)
    f = {v: np.full((3, 12, 12), 0.1, np.float32) for v in GROUPS}
    f["DIATO"][1, 0:6, 0:6] = 1.0
    f["HAPTO"][1, 0:6, 6:12] = 1.0
    f["PROKAR"][1, 6:12, 0:6] = 1.0
    for v in GROUPS:
        f[v][1, 6:12, 6:12] = np.nan
    ds = {v: _DA(a, ("time", "latitude", "longitude")) for v, a in f.items()}
    ds["PROCHLO"] = _DA(
        np.full((3, 12, 12), 50.0, np.float32), ("time", "latitude", "longitude")
    )
    ds |= {
        "time": _DA(times, ("time",)),
        "latitude": _DA(lat, ("latitude",)),
        "longitude": _DA(lon, ("longitude",)),
    }
    return ds


def test_fetch_reads_the_five_groups_of_the_latest_month_north_up():
    seen = {}

    def open_dataset(**kw):
        seen.update(kw)
        return _dataset()

    rgba, when = fetch_cmems_dominant(
        _product(), today=dt.date(2026, 9, 30), open_dataset=open_dataset
    )
    assert when == "2026-09-01T00:00:00Z", "October (index 2) is after today"
    _, first_day = fetch_cmems_dominant(_product(), today=dt.date(2026, 9, 1), open_dataset=open_dataset)
    assert first_day == "2026-09-01T00:00:00Z", "a month is served from its first day"
    assert seen["dataset_id"] == "pft" and seen["variables"] == GROUPS, (
        "PROCHLO is not read"
    )
    assert rgba.shape == (2, 2, 4)
    # north row first: north-west prokaryotes, north-east clear; south-west diatoms, south-east haptophytes
    assert rgba[0, 0].tolist() == [240, 228, 66, 255] and rgba[0, 1, 3] == 0
    assert rgba[1, 0].tolist() == [230, 159, 0, 255] and rgba[1, 1].tolist() == [
        86,
        180,
        233,
        255,
    ]
    with pytest.raises(RuntimeError, match="no time step"):
        fetch_cmems_dominant(
            _product(), today=dt.date(2026, 7, 31), open_dataset=open_dataset
        )


def test_fetch_refuses_a_month_with_no_cell_at_all():
    ds = _dataset()
    for v in GROUPS:
        ds[v].values[0] = np.nan
    with pytest.raises(RuntimeError, match="no cell"):
        fetch_cmems_dominant(
            _product(), today=dt.date(2026, 8, 15), open_dataset=lambda **kw: ds
        )
    rgba, _ = fetch_cmems_dominant(
        _product(), today=dt.date(2026, 9, 15), open_dataset=lambda **kw: ds
    )
    assert (rgba[..., 3] == 255).sum() == 3, (
        "positive control: September has three cells"
    )


def test_process_routes_cmems_dominant_to_its_own_fetch(tmp_path, monkeypatch):
    from pipeline import cmems_pft, raster

    called = {}

    def fake(product, **kw):
        called["id"] = product["id"]
        return paint_classes(
            np.array([[0, -1]], np.int8), [[1, 2, 3]] * 5
        ), "2026-09-01T00:00:00Z"

    monkeypatch.setattr(cmems_pft, "fetch_cmems_dominant", fake)
    monkeypatch.setattr(
        raster,
        "fetch_cmems",
        lambda *a, **k: pytest.fail("the ramp fetch must not run"),
    )
    entry = raster.process(
        _product() | {"bounds": {}, "kind": "classes", "keep_days": 400}, tmp_path
    )
    assert (
        called["id"] == "cmems-pft"
        and entry["time"] == "2026-09-01T00:00:00Z"
        and entry["width"] == 2
    )
    assert [h["time"] for h in entry["history"]] == ["2026-09-01T00:00:00Z"]


def test_a_month_refetched_daily_keeps_one_frame_and_survives_the_30_day_prune(
    tmp_path,
):
    """The monthly stamp is the month's first day, so by the time it is published it is 30+ days old: the default
    keep_days (30) would delete it on its first run. Positive control: keep_days 400 keeps it, once."""
    latest = tmp_path / "x.png"
    latest.write_bytes(b"png")
    month = (dt.datetime.now(dt.UTC) - dt.timedelta(days=36)).strftime(
        "%Y-%m-01T00:00:00Z"
    )
    assert archive_frame(latest, "short", month, tmp_path, 30) == []
    for _ in range(3):
        hist = archive_frame(latest, "pft", month, tmp_path, 400)
    assert [h["time"] for h in hist] == [month] and len(
        list((tmp_path / "pft").glob("*.png"))
    ) == 1


def test_the_configured_product_is_the_five_groups_in_a_distinct_palette():
    products = {p["id"]: p for p in json.loads((HERE / "rasters.json").read_text())}
    p = products["cmems-pft"]
    assert [c["variable"] for c in p["classes"]] == GROUPS
    assert (
        p["kind"] == "classes"
        and p["keep_days"] >= 62
        and p["credit_key"] == "cmems-globcolour"
    )
    assert p["cmems_dominant"] == {
        "dataset_id": "cmems_obs-oc_glo_bgc-plankton_nrt_l4-multi-4km_P1M",
        "block": 6,
        "grid": [8640, 4320],
    }
    assert len({tuple(c["rgb"]) for c in p["classes"]}) == 5
    assert "https://doi.org/10.48670/moi-00279" in p["credit"] and p[
        "credit"
    ].startswith("Generated using E.U. Copernicus Marine Service Information")


def test_freshness_gives_the_monthly_product_two_months_plus_publication_lag():
    now = dt.datetime(2026, 11, 8, tzinfo=dt.UTC)
    rasters = {
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "failures": {},
        "products": [
            {
                "id": "cmems-pft",
                "time": (now - dt.timedelta(days=68)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        ],
    }
    stamps = {"rasters.json": rasters["generated_at"]}
    assert (
        freshness.assess(stamps, rasters, now, layers={"rasters.json": "daily"}) == []
    ), "September's mean read on 8 November"
    rasters["products"][0]["time"] = (now - dt.timedelta(days=80)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    assert [
        p["layer"]
        for p in freshness.assess(
            stamps, rasters, now, layers={"rasters.json": "daily"}
        )
    ] == ["rasters.json: cmems-pft"]
