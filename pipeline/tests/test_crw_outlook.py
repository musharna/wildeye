"""NOAA CRW Four-Month Bleaching Outlook: finding the newest issue, reading the composite, the two output images.

The .nc fixtures are CRW's real issue of 2026-09-29 (icwk20260927) at 60% and 90%, the whole 0.5° grid of the
four-month composite and the surface flag with the files' own attributes (the other 20 weekly layers left out). The live run and scripts/qa-crw-outlook.mjs compare
the full outputs cell by cell with CRW's own published maps of the same issue.
"""

import io
from pathlib import Path
import numpy as np
import pytest
import xarray as xr
from PIL import Image
from pipeline import crw_outlook as co
from pipeline import raster

FIX = Path(__file__).parent / "fixtures"
INDEX = "https://example.test/outlook/"
NC = {p: FIX / f"crw_outlook_0{p}perc.nc" for p in (60, 90)}
PRODUCT = {
    "id": "crw-outlook",
    "name": "outlook",
    "icon": "x",
    "bounds": {"west": -180, "south": -90, "east": 180, "north": 90},
    "kind": "classes",
    "zrank": 85,
    "legend": "pinned",
    "credit_key": "noaa-crw",
    "crw_outlook": {"index": INDEX, "probabilities": [60, 90]},
    "classes": [
        {"label": "no stress", "rgb": [255, 255, 255], "hidden": True},
        {"label": "Watch", "rgb": [255, 210, 160]},
        {"label": "Warning", "rgb": [250, 170, 10]},
        {"label": "Alert Level 1", "rgb": [240, 0, 0]},
        {"label": "Alert Level 2", "rgb": [150, 0, 0]},
    ],
}


def name(p, icwk):
    return (
        f"cfsv2_outlook-0{p}perc_4mon-and-wkly_v5_icwk{icwk}_for_20261011to20270131.nc"
    )


def listing(*names):
    return "".join(f'<a href="{n}">{n}</a>' for n in names)


def test_newest_issue_with_every_probability_and_the_year_before_when_the_new_year_is_empty():
    pages = {
        INDEX: listing("2025/", "2026/"),
        f"{INDEX}2026/": listing(
            name(60, "20260920"),
            name(90, "20260920"),
            name(60, "20260927"),
            name(90, "20260927"),
            name(60, "20261004"),
        ),
    }  # 20261004: 90% not uploaded yet
    icwk, urls = co.newest_issue(INDEX, [60, 90], pages.__getitem__)
    assert icwk == "20260927"
    assert urls == {
        60: f"{INDEX}2026/{name(60, '20260927')}",
        90: f"{INDEX}2026/{name(90, '20260927')}",
    }
    pages = {
        INDEX: listing("2026/", "2027/"),
        f"{INDEX}2027/": listing(),
        f"{INDEX}2026/": listing(name(60, "20261227"), name(90, "20261227")),
    }
    assert co.newest_issue(INDEX, [60, 90], pages.__getitem__)[0] == "20261227"
    # no complete issue in the newest year that has files: an error, not an older year's issue
    pages = {
        INDEX: listing("2025/", "2026/"),
        f"{INDEX}2026/": listing(name(60, "20260104")),
        f"{INDEX}2025/": listing(name(60, "20251228"), name(90, "20251228")),
    }
    with pytest.raises(co.OutlookChanged, match="no issue has every probability"):
        co.newest_issue(INDEX, [60, 90], pages.__getitem__)
    with pytest.raises(co.OutlookChanged, match="no year directories"):
        co.newest_issue(INDEX, [60, 90], {INDEX: "<html></html>"}.__getitem__)


def test_composite_is_rolled_to_minus_180_land_marked_and_dated_from_the_attributes():
    with xr.open_dataset(NC[60]) as ds:
        raw = ds[co.VAR].values[0]
        lon = ds["lon"].values
        classes, meta = co.read_composite(ds)
    assert meta == {"start": "2026-10-05", "end": "2027-01-31", "issued": "2026-09-29"}
    # every column j is the cell centred on -179.75 + 0.5 j, looked up by its longitude in the file (not by a roll):
    # an edge-column check passed a roll one column off, because neighbouring cells mostly share a class
    lon180 = np.where(lon > 180, lon - 360, lon)
    for j in range(720):
        k = int(np.argmin(np.abs(lon180 - (-179.75 + 0.5 * j))))
        assert lon180[k] == pytest.approx(-179.75 + 0.5 * j)
        np.testing.assert_array_equal(
            classes[:, j], np.where(np.isnan(raw[:, k]), co.LAND, raw[:, k])
        )
    assert set(np.unique(classes).tolist()) == {0, 1, 2, 3, 4, co.LAND}
    assert int((classes == co.LAND).sum()) == int(np.isnan(raw).sum()) == 87478


def test_a_changed_file_is_an_error_not_a_quiet_map():
    with xr.open_dataset(NC[60]) as ds:
        ds = ds.load()
    co.read_composite(ds)  # positive control: the real file reads
    bad = ds.copy(deep=True)
    bad[co.VAR].values[0, 0, 0] = 7
    with pytest.raises(co.OutlookChanged, match="outside 0-4"):
        co.read_composite(bad)
    bad = ds.copy(deep=True)
    water = np.argwhere(~np.isnan(ds[co.VAR].values[0]))[0]
    bad["surface_flag"].values[tuple(water)] = 1
    with pytest.raises(co.OutlookChanged, match="surface_flag"):
        co.read_composite(bad)
    with pytest.raises(co.OutlookChanged, match="longitude grid"):
        co.read_composite(ds.assign_coords(lon=ds["lon"] - 180))
    # the latitude grid is checked as fully as the longitude one: a flipped, cropped or coarser grid keeps every other
    # check happy (and both probabilities agree with each other), so only this can stop it (review of PR #51)
    shifted = ds.assign_coords(
        lat=ds["lat"] - 0.25
    )  # 360 rows by 0.5, starting at 89.5
    squeezed = ds.assign_coords(
        lat=89.75 - 0.4 * np.arange(360)
    )  # 360 rows from 89.75, by 0.4
    flipped, cropped, coarse = (
        ds.isel(lat=slice(None, None, -1)),
        ds.isel(lat=slice(0, 359)),
        ds.isel(lat=slice(None, None, 2)),
    )
    for changed in (flipped, cropped, coarse, shifted, squeezed):
        with pytest.raises(co.OutlookChanged, match="latitude grid"):
            co.read_composite(changed)


def serve(files):
    pages = {
        INDEX: listing("2026/"),
        f"{INDEX}2026/": listing(*[name(p, "20260927") for p in files]),
    }
    blobs = {
        f"{INDEX}2026/{name(p, '20260927')}": f.read_bytes() for p, f in files.items()
    }
    return pages.__getitem__, blobs.__getitem__


def test_outputs_drape_the_60pct_composite_and_carry_both_probabilities_for_the_readout(
    tmp_path,
):
    read_text, read_bytes = serve(NC)
    rgba, when, extras = co.fetch_crw_outlook(PRODUCT, tmp_path, read_text, read_bytes)
    with xr.open_dataset(NC[60]) as a, xr.open_dataset(NC[90]) as b:
        low, high = co.read_composite(a)[0], co.read_composite(b)[0]
    assert when == "2026-09-29T00:00:00Z"
    data = np.asarray(Image.open(tmp_path / "crw-outlook.data.png"))
    np.testing.assert_array_equal(data[..., 0], low)
    np.testing.assert_array_equal(data[..., 1], high)
    assert (
        data[..., 3] == 255
    ).all()  # opaque: a canvas would premultiply anything less
    assert not (low == high).all()  # the two bytes are not one value written twice
    # drawn: each level in CRW's colour where the 60% composite reaches it; no-stress and land clear
    for k in (1, 2, 3, 4):
        assert (rgba[low == k] == [*PRODUCT["classes"][k]["rgb"], 255]).all()
    assert (rgba[(low == 0) | (low == co.LAND), 3] == 0).all()
    o = extras["outlook"]
    assert (o["start"], o["end"], o["issued"], o["icwk"], o["probabilities"]) == (
        "2026-10-05",
        "2027-01-31",
        "2026-09-29",
        "20260927",
        [60, 90],
    )
    assert o["data_png"] == "data/rasters/crw-outlook.data.png"
    assert extras["legend"].startswith(
        "Four-month outlook 2026-10-05 to 2027-01-31: the stress level reached by at least 60%"
    )


def test_probabilities_the_wrong_way_round_or_from_different_issues_are_refused(
    tmp_path,
):
    read_text, read_bytes = serve({60: NC[90], 90: NC[60]})
    with pytest.raises(co.OutlookChanged, match="exceeds the 60% level"):
        co.fetch_crw_outlook(PRODUCT, tmp_path, read_text, read_bytes)
    with xr.open_dataset(NC[90]) as ds:
        other = ds.load()
    other.attrs["date_issued"] = "20261006T141649Z"
    f = tmp_path / "other.nc"
    other.to_netcdf(f)
    read_text, read_bytes = serve({60: NC[60], 90: f})
    with pytest.raises(co.OutlookChanged, match="disagree on dates"):
        co.fetch_crw_outlook(PRODUCT, tmp_path, read_text, read_bytes)
    read_text, read_bytes = serve(NC)  # positive control
    assert (
        co.fetch_crw_outlook(PRODUCT, tmp_path, read_text, read_bytes)[1]
        == "2026-09-29T00:00:00Z"
    )


def test_process_routes_the_product_and_puts_the_outlook_in_the_manifest(
    tmp_path, monkeypatch
):
    read_text, read_bytes = serve(NC)
    monkeypatch.setattr(
        raster,
        "_read_bytes",
        lambda u, timeout=180: (
            read_text(u).encode() if u.endswith("/") else read_bytes(u)
        ),
    )
    entry = raster.process(PRODUCT, tmp_path / "rasters")
    assert entry["time"] == "2026-09-29T00:00:00Z"
    assert entry["outlook"]["probabilities"] == [60, 90]
    assert entry["legend"].startswith(
        "Four-month outlook 2026-10-05"
    )  # the dated legend replaces the pinned one
    assert entry["history"] == [
        {
            "time": "2026-09-29T00:00:00Z",
            "png": "data/rasters/crw-outlook/20260929T000000Z.png",
        }
    ]
    assert (tmp_path / "rasters" / "crw-outlook.data.png").exists()
    png = Image.open(
        io.BytesIO((tmp_path / "rasters" / "crw-outlook.png").read_bytes())
    )
    assert png.size == (720, 360)
