import numpy as np
import pytest
from pipeline.raster import color_to_alpha, PaletteChanged, fill_empty_right_edge


def test_pinned_colour_becomes_transparent_others_survive_and_fraction_reported():
    rgba = np.zeros((4, 4, 4), np.uint8)
    rgba[..., :3] = (10, 20, 30); rgba[..., 3] = 255          # pinned "no stress" colour
    rgba[0, 0] = (200, 50, 50, 255); rgba[1, 1] = (0, 0, 0, 0)  # one alert pixel, one land (already transparent)
    out, frac = color_to_alpha(rgba, (10, 20, 30))
    assert out[2, 2, 3] == 0 and tuple(out[0, 0]) == (200, 50, 50, 255) and out[1, 1, 3] == 0
    assert abs(frac - 14 / 15) < 1e-9


def test_mask_is_explicit_not_most_frequent_colour():
    """A day when a real alert class dominates must NOT be hidden (the old mode-colour heuristic did)."""
    rgba = np.zeros((4, 4, 4), np.uint8)
    rgba[..., :3] = (200, 50, 50); rgba[..., 3] = 255   # alert colour dominates today
    rgba[0, 0] = (10, 20, 30, 255)                       # one no-stress pixel
    out, _ = color_to_alpha(rgba, (10, 20, 30))
    assert out[0, 0, 3] == 0 and out[2, 2, 3] == 255


def test_missing_pinned_colour_fails_loud_but_empty_image_is_fine():
    rgba = np.zeros((2, 2, 4), np.uint8); rgba[..., :3] = (1, 2, 3); rgba[..., 3] = 255
    with pytest.raises(PaletteChanged):
        color_to_alpha(rgba, (9, 9, 9))
    empty = np.zeros((2, 2, 4), np.uint8)
    out, frac = color_to_alpha(empty, (9, 9, 9))
    assert frac == 0.0 and out.shape == empty.shape


def test_process_rejects_legacy_mode_color(monkeypatch, tmp_path):
    from pipeline import raster
    monkeypatch.setattr(raster, "fetch_png", lambda url, timeout=180: np.zeros((2, 2, 4), np.uint8))
    with pytest.raises(ValueError, match="transparent must be"):
        raster.process({"id": "x", "url": "u", "transparent": "mode_color", "name": "n", "icon": "i",
                        "bounds": {}, "legend": "", "credit": "", "credit_key": ""}, tmp_path)


def test_only_flag_keeps_unselected_products_in_manifest(tmp_path, monkeypatch):
    """Regression: --only X used to rewrite rasters.json with X alone (dropping the other drapes)."""
    import json
    from pipeline import raster
    out = tmp_path / "data"; out.mkdir()
    (out / "rasters.json").write_text(json.dumps({"generated_at": "t", "failures": {}, "products": [
        {"id": "crw-bleaching", "png": "data/rasters/crw-bleaching.png", "time": "2026-09-09T12:00:00Z"},
        {"id": "oisst", "png": "data/rasters/oisst.png", "time": "2026-08-26T12:00:00Z"}]}))
    monkeypatch.setattr(raster, "process", lambda p, d: {"id": p["id"], "png": f"data/rasters/{p['id']}.png", "time": "new"})
    raster.main(["--out", str(out), "--only", "chlor-a"])
    ids = {p["id"]: p for p in json.loads((out / "rasters.json").read_text())["products"]}
    assert set(ids) == {"crw-bleaching", "oisst", "chlor-a"}
    assert ids["oisst"]["time"] == "2026-08-26T12:00:00Z" and ids["chlor-a"]["time"] == "new"


def test_archive_frame_dedupes_same_acquisition_prunes_old_and_returns_sorted_history(tmp_path):
    import datetime as dt
    from pipeline.raster import archive_frame
    latest = tmp_path / "x.png"; latest.write_bytes(b"png-bytes")
    old = tmp_path / "x" ; old.mkdir()
    stale = (dt.datetime.now(dt.UTC) - dt.timedelta(days=40)).strftime("%Y%m%dT%H%M%SZ")
    (old / f"{stale}.png").write_bytes(b"old")
    (old / "notes.txt").write_text("ignored")
    # acquisitions dated from today: archive_frame prunes against the wall clock, so fixed dates expire (this test's
    # 2026-09-10 frame was pruned on arrival from 2026-10-10)
    day = (dt.datetime.now(dt.UTC) - dt.timedelta(days=2)).replace(hour=12, minute=0, second=0, microsecond=0)
    t1, t2 = (d.strftime("%Y-%m-%dT%H:%M:%SZ") for d in (day, day + dt.timedelta(days=1)))
    f1, f2 = (d.strftime("%Y%m%dT%H%M%SZ.png") for d in (day, day + dt.timedelta(days=1)))
    h1 = archive_frame(latest, "x", t1, tmp_path, keep_days=30)
    h2 = archive_frame(latest, "x", t1, tmp_path, keep_days=30)   # same acquisition again
    h3 = archive_frame(latest, "x", t2, tmp_path, keep_days=30)
    assert h1 == h2 == [{"time": t1, "png": f"data/rasters/x/{f1}"}]
    assert [e["time"] for e in h3] == [t1, t2]
    assert not (old / f"{stale}.png").exists(), "frame older than keep_days pruned"
    assert sorted(p.name for p in old.iterdir()) == [f1, f2, "notes.txt"]


def test_catalog_products_take_the_year_from_the_date_not_the_manifest():
    """ndvi's catalog and data URLs had 2026 written in (ncei .../cdr/ndvi/2026/...), so from 1 January the layer would
    have kept reading 2026's last file. Every catalog product writes {year} instead."""
    import json
    import re
    from pathlib import Path
    products = [p for p in json.loads((Path(__file__).parents[1] / "rasters.json").read_text()) if "catalog" in p]
    assert [p["id"] for p in products] == ["ndvi"], "control: the catalog products this test covers"
    for p in products:
        for k in ("catalog", "url_template"):
            assert "{year}" in p[k] and not re.search(r"/(19|20)\d\d/", p[k]), f"{p['id']}.{k}: {p[k]}"


def test_resolve_source_reads_this_years_catalog_and_last_years_only_when_this_one_is_missing():
    """NCEI publishes a day's file ~2 days later and opens the new year's directory with its first file (2025's 12-31
    file is dated 2026-01-05; a future year's catalog is a 404, checked 2026-10-12). So in early January the newest file
    is in last year's catalog: read this year's, fall back to last year's only on a 404 or no matching file, and take
    the data URL's year from the file's own date. Any other HTTP error is raised, not fallen back from."""
    import datetime as dt
    import io
    import urllib.error

    import pytest

    from pipeline.raster import resolve_source
    prod = {"id": "ndvi", "catalog": "https://c/{year}/catalog.xml", "url_template": "https://d/{year}/{file}",
            "file_regex": r"VIIRS-Land_v001_[A-Z0-9]+_NOAA-20_\d{8}_c\d+\.nc", "time_regex": r"_(\d{4})(\d{2})(\d{2})_c"}
    f = "VIIRS-Land_v001_JP113C1_NOAA-20_{}_c{}143010.nc".format

    def server(pages):
        seen = []

        def read(url):
            seen.append(url)
            page = pages.get(url, 404)
            if isinstance(page, int):
                raise urllib.error.HTTPError(url, page, "x", {}, io.BytesIO())
            return page
        return read, seen

    read, seen = server({"https://c/2026/catalog.xml": f"<a>{f('20261230', '20270101')}</a><a>{f('20261231', '20270105')}</a>"})
    url, when = resolve_source(prod, today=dt.date(2027, 1, 3), read_catalog=read)
    assert seen == ["https://c/2027/catalog.xml", "https://c/2026/catalog.xml"], "2027 is a 404: fall back once"
    assert url == "https://d/2026/" + f("20261231", "20270105") and when == "2026-12-31T00:00:00Z"

    read, seen = server({"https://c/2027/catalog.xml": f"<a>{f('20270108', '20270110')}</a>", "https://c/2026/catalog.xml": "x"})
    url, when = resolve_source(prod, today=dt.date(2027, 1, 12), read_catalog=read)
    assert seen == ["https://c/2027/catalog.xml"] and url == "https://d/2027/" + f("20270108", "20270110")

    read, seen = server({"https://c/2027/catalog.xml": "<catalog/>", "https://c/2026/catalog.xml": f"<a>{f('20261231', '20270105')}</a>"})
    assert resolve_source(prod, today=dt.date(2027, 1, 2), read_catalog=read)[1] == "2026-12-31T00:00:00Z", "empty: fall back"

    read, _ = server({"https://c/2027/catalog.xml": 500, "https://c/2026/catalog.xml": f"<a>{f('20261231', '20270105')}</a>"})
    with pytest.raises(urllib.error.HTTPError, match="500|x"):
        resolve_source(prod, today=dt.date(2027, 1, 3), read_catalog=read)
    read, _ = server({})
    with pytest.raises(RuntimeError, match="2027/catalog.xml.*2026/catalog.xml"):
        resolve_source(prod, today=dt.date(2027, 1, 3), read_catalog=read)


def test_resolve_source_picks_newest_catalog_file_and_dates_it():
    from pipeline.raster import resolve_source
    prod = {"id": "ndvi", "catalog": "c", "url_template": "https://x/wms/{file}?GetMap",
            "file_regex": r"VIIRS-Land_v001_[A-Z0-9]+_NOAA-20_\d{8}_c\d+\.nc", "time_regex": r"_(\d{4})(\d{2})(\d{2})_c"}
    xml = ('<dataset name="VIIRS-Land_v001_JP113C1_NOAA-20_20260905_c20260907143010.nc"/>'
           '<dataset name="VIIRS-Land_v001_JP113C1_NOAA-20_20260906_c20260908143010.nc"/>'
           '<dataset name="VIIRS-Land_v001_JP113C1_NOAA-20_20260904_c20260906143010.nc"/>')
    url, when = resolve_source(prod, xml)
    assert url.endswith("NOAA-20_20260906_c20260908143010.nc?GetMap") and when == "2026-09-06T00:00:00Z"
    assert resolve_source({"id": "s", "url": "u"}) == ("u", None)
    import pytest
    with pytest.raises(RuntimeError, match="no file matching"):
        resolve_source(prod, "<catalog/>")


def test_ramp_rgba_and_fetch_cmems_pick_latest_analysis_day_and_flip_north_up():
    import datetime as dt
    import numpy as np
    from pipeline.raster import ramp_rgba, fetch_cmems

    ramp = {"min": 0, "max": 10, "stops": [[0, 0, 0], [255, 255, 255]]}
    out = ramp_rgba(np.array([[0.0, 5.0, 10.0, np.nan, 20.0]]), ramp)
    assert out[0, 0].tolist() == [0, 0, 0, 255] and out[0, 1].tolist() == [128, 128, 128, 255]
    assert out[0, 2].tolist() == [255, 255, 255, 255] and out[0, 3, 3] == 0, "NaN is transparent"
    assert out[0, 4].tolist() == [255, 255, 255, 255], "above max clamps"

    class DA:
        def __init__(self, arr, dims): self.values, self.dims = arr, dims
        def isel(self, **kw):
            a = self.values
            if "time" in kw: a = a[kw["time"]]
            if "depth" in kw: a = a[kw["depth"]]
            return DA(a, tuple(d for d in self.dims if d not in kw))
    times = np.array(["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"], dtype="datetime64[ns]")
    field = np.zeros((4, 1, 2, 3)); field[2, 0] = [[1, 2, 3], [7, 8, 9]]  # day index 2 = 2026-09-12; row 0 = south
    ds = {"o2": DA(field, ("time", "depth", "latitude", "longitude")), "time": DA(times, ("time",)), "latitude": DA(np.array([10.0, 20.0]), ("latitude",)), "longitude": DA(np.array([0.0, 1.0, 2.0]), ("longitude",))}
    seen = {}
    def open_dataset(**kw):
        seen.update(kw); return ds
    product = {"id": "cmems-o2", "cmems": {"dataset_id": "d", "variable": "o2", "max_depth": 1}, "ramp": ramp}
    rgba, when, extras = fetch_cmems(product, today=dt.date(2026, 9, 12), open_dataset=open_dataset)
    assert extras == {"bounds": {"west": -0.5, "south": 5.0, "east": 2.5, "north": 25.0}}, "cell edges, not centres"
    assert when == "2026-09-12T00:00:00Z", "the forecast day (13th) is skipped"
    assert seen["dataset_id"] == "d" and seen["variables"] == ["o2"]
    assert rgba.shape == (2, 3, 4) and rgba[0, 0, 0] > rgba[1, 0, 0], "north row first: values 7–9 on top of 1–3"
    try:
        fetch_cmems(product, today=dt.date(2026, 9, 1), open_dataset=open_dataset); assert False
    except RuntimeError as e:
        assert "no time step" in str(e)


def test_fetch_cmems_block_averages_a_fine_grid_onto_exact_cell_centres():
    """chlor-a reads Copernicus-GlobColour's 4 km grid (8640x4320) and draws it at 0.25 deg (1440x720): each 6x6 block
    is the mean of its finite cells (land, ice and cloud NaN ignored; an all-NaN block stays clear). The dataset's
    float32 coordinates sit ~5e-6 deg off the true centres, which made the block centres fail edge_align's
    regular-grid check (real coordinates, 2026-10-12), so the block path checks the configured whole-globe grid and
    draws on its exact centres. Same geometry with 30 deg cells in 3x3 blocks to keep it small."""
    import datetime as dt

    import numpy as np
    import pytest

    from pipeline.cmems_pft import GridChanged
    from pipeline.raster import fetch_cmems

    class DA:
        def __init__(self, arr, dims): self.values, self.dims = arr, dims
        def isel(self, **kw):
            return DA(self.values[kw["time"]], tuple(d for d in self.dims if d != "time"))
    jitter = np.where(np.arange(12) % 2, 5e-6, -5e-6)
    lon = (-180 + (np.arange(12) + 0.5) * 30 + jitter).astype(np.float32)
    lat = (-90 + (np.arange(6) + 0.5) * 30 + jitter[:6]).astype(np.float32)  # south first, as the dataset stores it
    north_up = np.full((6, 12), 10.0)
    north_up[0:3, 0:3] = 0.0                                                   # NW block: 0 -> black
    north_up[0:3, 3:6] = [[np.nan, 0, 10], [np.nan, 0, 10], [np.nan, 0, 10]]   # mean of the finite cells is 5
    north_up[0:3, 6:9] = np.nan                                                # no finite cell -> clear
    field = np.stack([np.zeros((6, 12)), north_up[::-1]])
    ds = {"CHL": DA(field, ("time", "latitude", "longitude")),
          "time": DA(np.array(["2026-10-10", "2026-10-11"], dtype="datetime64[ns]"), ("time",)),
          "latitude": DA(lat, ("latitude",)), "longitude": DA(lon, ("longitude",))}
    ramp = {"min": 0, "max": 10, "stops": [[0, 0, 0], [255, 255, 255]]}
    product = {"id": "chlor-a", "cmems": {"dataset_id": "d", "variable": "CHL", "block": 3, "grid": [12, 6]}, "ramp": ramp}
    rgba, when, extras = fetch_cmems(product, today=dt.date(2026, 10, 12), open_dataset=lambda **kw: ds)
    assert when == "2026-10-11T00:00:00Z"
    assert rgba.shape == (2, 4, 4), "one pixel per 3x3 block"
    assert extras == {"bounds": {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}}
    assert rgba[0, 0].tolist() == [0, 0, 0, 255] and rgba[0, 3].tolist() == [255, 255, 255, 255]
    assert rgba[0, 1].tolist() == [128, 128, 128, 255], "NaN cells are left out of the mean, not counted as 0"
    assert rgba[0, 2, 3] == 0 and rgba[1, 2].tolist() == [255, 255, 255, 255], "all-NaN block clear, south row drawn"
    with pytest.raises(GridChanged, match="expected 24x12"):
        fetch_cmems(product | {"cmems": product["cmems"] | {"grid": [24, 12]}}, today=dt.date(2026, 10, 12),
                    open_dataset=lambda **kw: ds)


def test_fill_empty_right_edge_closes_the_antimeridian_seam_only_when_erddap_left_it_empty():
    """Mutant seen failing: returning the image unchanged (the seam stays). Positive controls: an image
    with data in its last column, and one with nothing beside an empty last column, are untouched."""
    img = np.zeros((3, 4, 4), dtype=np.uint8)
    img[:, :3] = [10, 20, 30, 255]          # data everywhere except the last column (ERDDAP's output)
    fixed = fill_empty_right_edge(img)
    assert (fixed[:, -1] == [10, 20, 30, 255]).all()
    assert (img[:, -1, 3] == 0).all(), "input not modified in place"
    full = np.full((3, 4, 4), 200, dtype=np.uint8)
    assert fill_empty_right_edge(full) is full
    land = np.zeros((3, 4, 4), dtype=np.uint8)
    land[:, :2] = [1, 2, 3, 255]            # last two columns empty (e.g. land/no data) → leave the gap
    assert fill_empty_right_edge(land) is land


# The cmems-o2 / cmems-ph ramps as of 2026-10-07, inlined so the pin below cannot move with a config edit.
_O2_RAMP = {"min": 195, "max": 395, "stops": [[127, 29, 29], [239, 138, 98], [247, 247, 247], [103, 169, 207], [5, 48, 97]]}
_PH_RAMP = {"min": 7.95, "max": 8.16, "stops": [[84, 48, 5], [223, 194, 125], [245, 245, 245], [128, 205, 193], [1, 102, 94]]}


def _linear_field(ramp):
    lo, hi = ramp["min"], ramp["max"]
    span = hi - lo
    v = np.random.default_rng(7).uniform(lo - 0.2 * span, hi + 0.2 * span, (64, 128))
    v[::7, ::5] = np.nan
    return v


def test_ramp_without_log_renders_byte_identically_to_before_the_log_option():
    """The sha256 of each linear ramp's output was taken with ramp_rgba as it stood before `log` existed
    (1c1677c53). `log: False` is the same ramp. Seen failing: any change to the linear path."""
    import hashlib
    from pipeline.raster import ramp_rgba
    for ramp, want in ((_O2_RAMP, "9dd0e4bf70ea2565e5739a1f320ee58eadb645236c6a3562c5a8cab286c2fa2c"),
                       (_PH_RAMP, "02ca55ad10573f611c5a32fb4248e557609f811e2ce4c738c8b10c7eff323f0d")):
        v = _linear_field(ramp)
        assert hashlib.sha256(ramp_rgba(v, ramp).tobytes()).hexdigest() == want
        assert hashlib.sha256(ramp_rgba(v, ramp | {"log": False}).tobytes()).hexdigest() == want


def test_log_ramp_interpolates_on_log10_between_min_and_max():
    """cmems-zooc: 0.05..5 on five stops, so each stop is half a decade apart. Seen failing before `log`
    existed: the geometric mean 0.5 landed a tenth of the way up (near stop 0), not on the middle stop."""
    from pipeline.raster import ramp_rgba
    stops = [[0, 0, 0], [40, 0, 0], [80, 0, 0], [120, 0, 0], [160, 0, 0]]
    ramp = {"min": 0.05, "max": 5, "log": True, "stops": stops}
    v = np.array([[0.05, 0.05 * 10 ** 0.5, 0.5, 5 * 10 ** -0.5, 5.0, 0.05 * 10 ** 0.25, 1e-9, 0.0, -1.0, 7.0, np.nan]])
    out = ramp_rgba(v, ramp)
    assert out[0, :5, 0].tolist() == [0, 40, 80, 120, 160], "every half decade is one stop"
    assert out[0, 5, 0] == 20, "a quarter decade is half way between stop 0 and stop 1"
    assert out[0, 6:9, 0].tolist() == [0, 0, 0], "tiny, zero and negative clamp to the low end"
    assert (out[0, :10, 3] == 255).all(), "every finite value is opaque"
    assert out[0, 9, 0] == 160, "above max clamps to the top"
    assert out[0, 10, 3] == 0, "NaN (land) is transparent"
    # positive control: the same values on the linear ramp put 0.5 a tenth of the way up, not on the middle stop
    lin = ramp_rgba(v[:, :5], ramp | {"log": False})
    assert lin[0, 2, 0] == round(160 * (0.5 - 0.05) / 4.95)
    # a log ramp cannot start at 0: refused by name, while the 0.05 start above rendered
    with pytest.raises(ValueError, match="log ramp needs 0 < min < max"):
        ramp_rgba(v, ramp | {"min": 0})


def _drawn_at(lat, lon, b, w, h):
    """The pixel the browser shows at (lat, lon): a mirror of drapePixel in src/data/rasterDrape.js."""
    import math
    span = b["east"] - b["west"]
    x = ((lon - b["west"]) % 360) + b["west"] if span >= 360 else lon
    return min(h - 1, math.floor((b["north"] - lat) / (b["north"] - b["south"]) * h)), min(w - 1, math.floor((x - b["west"]) / span * w))


def _misplaced(rgba, b, lat_c, lon_c, step, first_row=0):
    """Points well inside each cell (centre ± 0.4 cell) whose drawn pixel shows a different cell. The image encodes
    each cell's (row, col) in its colour, so a pixel names the cell it was drawn from; lat_c[0] is row `first_row`."""
    h, w = rgba.shape[:2]
    bad = 0
    for i, la in enumerate(lat_c, start=first_row):
        for j, lo in enumerate(lon_c):
            for dla in (-0.4, 0.0, 0.4):
                for dlo in (-0.4, 0.0, 0.4):
                    plat, plon = la + dla * step, lo + dlo * step
                    if not (b["south"] <= plat <= b["north"]):
                        continue
                    y, x = _drawn_at(plat, plon, b, w, h)
                    if (int(rgba[y, x, 0]), int(rgba[y, x, 1])) != (i, j):
                        bad += 1
    return bad


def _coded(lat_c, lon_c):
    """North-up RGBA whose pixel (r, c) is coloured (r, c, 0, 255): row r is lat_c[r] (north first)."""
    import numpy as np
    rgba = np.zeros((len(lat_c), len(lon_c), 4), np.uint8)
    rgba[..., 0] = np.arange(len(lat_c))[:, None]
    rgba[..., 1] = np.arange(len(lon_c))[None, :]
    rgba[..., 3] = 255
    return rgba


def test_edge_align_draws_every_copernicus_cell_where_it_is():
    """The Copernicus 0.25° grids give cell CENTRES (lat -80..90, lon -180..179.75); the drape stretches the image
    across `bounds` edge to edge. Taking the centre range as the edges drew each cell half a cell east and up to half a
    cell north/south (control below: the old geometry misplaces points). edge_align returns the true edges: the 90°N
    row (half past the pole) is dropped, and the half-cell offset from ±180 is removed by drawing each cell two pixels
    wide and turning the image one pixel, so it spans exactly -180..180. Same geometry at a 10° step to keep it small."""
    import numpy as np
    from pipeline.raster import edge_align

    step = 10.0
    lat_c = np.arange(90.0, -80.0 - 1e-9, -step)  # north first, as fetch_cmems draws it: 90, 80, ..., -80
    lon_c = np.arange(-180.0, 180.0 - 1e-9, step)  # -180 .. 170
    old = _coded(lat_c, lon_c)
    old_bounds = {"west": -180, "south": -80, "east": 180, "north": 90}
    assert _misplaced(old, old_bounds, lat_c, lon_c, step) > 0, "control: centres taken as edges misplace cells"

    rgba, b = edge_align(_coded(lat_c, lon_c), lat_c, lon_c)
    assert b == {"west": -180.0, "south": -85.0, "east": 180.0, "north": 85.0}
    assert rgba.shape == (len(lat_c) - 1, 2 * len(lon_c), 4), "90°N row dropped, two pixels per cell"
    keep = lat_c[1:]
    assert _misplaced(rgba, b, keep, lon_c, step, first_row=1) == 0
    # The cell centred on -180 straddles the antimeridian: its west half is the image's last pixel.
    assert rgba[0, 0, 1] == 0 and rgba[0, -1, 1] == 0 and rgba[0, -2, 1] == len(lon_c) - 1


def test_edge_align_leaves_an_edge_aligned_or_regional_grid_alone_and_refuses_one_it_cannot_place():
    import numpy as np
    import pytest
    from pipeline.raster import edge_align

    lat_c = np.arange(85.0, -85.0 - 1e-9, -10.0)
    lon_c = np.arange(-175.0, 175.0 + 1e-9, 10.0)  # centres half a cell in: edges already -180..180
    src = _coded(lat_c, lon_c)
    rgba, b = edge_align(src.copy(), lat_c, lon_c)
    assert np.array_equal(rgba, src) and b == {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
    assert _misplaced(rgba, b, lat_c, lon_c, 10.0) == 0

    reg_lat = np.array([50.0, 49.0, 48.0]); reg_lon = np.array([-10.0, -9.0])  # regional: edges are just ± half a cell
    rgba, b = edge_align(_coded(reg_lat, reg_lon), reg_lat, reg_lon)
    assert rgba.shape == (3, 2, 4) and b == {"west": -10.5, "south": 47.5, "east": -8.5, "north": 50.5}

    odd_lon = np.arange(-177.0, 180.0 - 1e-9, 10.0)  # global, but 3° off: no whole-pixel turn can place it
    with pytest.raises(ValueError, match="cannot place"):
        edge_align(_coded(lat_c, odd_lon), lat_c, odd_lon)
    with pytest.raises(ValueError, match="regular"):
        edge_align(_coded(lat_c, np.array([0.0, 1.0, 3.0])), lat_c, np.array([0.0, 1.0, 3.0]))


def test_process_puts_the_cmems_cell_edge_bounds_in_the_manifest(monkeypatch, tmp_path):
    """The cmems rows carry no configured bounds: the manifest's bounds are fetch_cmems's cell edges, and the
    manifest's width/height are the redrawn image's. Mutant seen surviving without this test: process dropping
    fetch_cmems's extras (the manifest entry then had no bounds and the drape could not draw)."""
    from pipeline import raster
    edges = {"west": -180.0, "south": -80.125, "east": 180.0, "north": 89.875}
    img = np.zeros((680, 2880, 4), np.uint8); img[..., 3] = 255
    monkeypatch.setattr(raster, "fetch_cmems", lambda p: (img, "2026-10-07T00:00:00Z", {"bounds": edges}))
    entry = raster.process({"id": "cmems-o2", "cmems": {}, "name": "n", "icon": "i", "legend": "", "credit": "",
                            "credit_key": "cmems", "ramp": {"min": 0, "max": 1, "stops": [[0, 0, 0], [1, 1, 1]]}}, tmp_path)
    assert entry["bounds"] == edges and (entry["width"], entry["height"]) == (2880, 680)


def test_fetch_erddap_grid_draws_the_numbers_through_the_ramp_north_up_with_cell_edges():
    """oisst reads ERDDAP's numbers (.nc) instead of its coloured transparentPng, whose colour bar the manifest ramp
    only approximated (median 4-12 levels off, 2026-10-12), so the legend was not exact and clicks could not be read
    back. The field is drawn through the ramp like the cmems layers: north-up, NaN (land) clear, cell-edge bounds,
    and the time step's own timestamp; a response with more than one time step is refused."""
    import numpy as np
    import pytest

    from pipeline.raster import fetch_erddap_grid

    class DA:
        def __init__(self, arr, dims=()): self.values, self.dims = np.asarray(arr), dims
    sst = np.array([[[[0.0, 10.0, np.nan], [20.0, 30.0, 32.0]]]])  # time, zlev, lat (south first), lon
    ds = {"sst": DA(sst, ("time", "zlev", "latitude", "longitude")),
          "time": DA(np.array(["2026-10-11T12:00:00"], dtype="datetime64[ns]")),
          "latitude": DA([-45.0, 45.0]), "longitude": DA([-120.0, 0.0, 120.0])}
    seen = []
    ramp = {"min": 0, "max": 30, "stops": [[0, 0, 0], [255, 255, 255]]}
    product = {"id": "oisst", "erddap_grid": {"url": "https://e/x.nc?sst[(last)]", "variable": "sst"}, "ramp": ramp}
    rgba, when, extras = fetch_erddap_grid(product, read_nc=lambda url: seen.append(url) or ds)
    assert seen == ["https://e/x.nc?sst[(last)]"] and when == "2026-10-11T12:00:00Z"
    assert extras == {"bounds": {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}}
    assert rgba.shape == (2, 3, 4)
    assert rgba[0, 0].tolist() == [170, 170, 170, 255] and rgba[0, 2].tolist() == [255, 255, 255, 255], "north row first"
    assert rgba[1, 0].tolist() == [0, 0, 0, 255] and rgba[1, 2, 3] == 0, "south row: 0 is the low end, NaN is clear"
    two = dict(ds, time=DA(np.array(["2026-10-10T12:00:00", "2026-10-11T12:00:00"], dtype="datetime64[ns]")))
    with pytest.raises(ValueError, match="one time step"):
        fetch_erddap_grid(product, read_nc=lambda url: two)


def test_fetch_erddap_grid_hides_at_or_below_scales_and_refuses_transposed_axes():
    """The CRW layers: DHW and HotSpot hide 0 and below (the legend says so; the ERDDAP PNGs did it by matching one pinned
    colour), sea ice is a 0..1 fraction drawn on a % ramp (`scale`). A field whose axes are (longitude, latitude) is
    refused by name even when the grid is square, where a shape check alone could not tell (PR #83 review)."""
    import numpy as np
    import pytest

    from pipeline.raster import fetch_erddap_grid

    class DA:
        def __init__(self, arr, dims=()): self.values, self.dims = np.asarray(arr), dims
    field = np.array([[[-0.5, 0.0, 0.25], [0.5, np.nan, 1.0]]])  # time, lat (north first), lon
    dims = ("time", "latitude", "longitude")
    ds = {"v": DA(field, dims), "time": DA(np.array(["2026-10-11T12:00:00"], dtype="datetime64[ns]")),
          "latitude": DA([45.0, -45.0]), "longitude": DA([-120.0, 0.0, 120.0])}
    ramp = {"min": 0, "max": 100, "stops": [[0, 0, 0], [200, 200, 200]]}
    base = {"id": "crw", "ramp": ramp}
    rgba, _, _ = fetch_erddap_grid(base | {"erddap_grid": {"url": "u", "variable": "v", "scale": 100,
                                                           "clear_at_or_below": 0}}, read_nc=lambda url: ds)
    assert rgba[0, :, 3].tolist() == [0, 0, 255], "-0.5 and 0 hidden, 0.25 shown"
    assert rgba[0, 2].tolist() == [50, 50, 50, 255] and rgba[1, 2].tolist() == [200, 200, 200, 255], "x100: 25 % and 100 %"
    assert rgba[1, 0].tolist() == [100, 100, 100, 255] and rgba[1, 1, 3] == 0, "50 % shown, NaN clear"
    plain, _, _ = fetch_erddap_grid(base | {"erddap_grid": {"url": "u", "variable": "v"}}, read_nc=lambda url: ds)
    assert plain[0, :, 3].tolist() == [255, 255, 255], "without clear_at_or_below nothing is hidden"
    square = {"v": DA(np.zeros((1, 2, 2)), ("time", "longitude", "latitude")), "time": ds["time"],
              "latitude": DA([45.0, -45.0]), "longitude": DA([-90.0, 90.0])}
    with pytest.raises(ValueError, match="longitude, latitude"):
        fetch_erddap_grid(base | {"erddap_grid": {"url": "u", "variable": "v"}}, read_nc=lambda url: square)


def test_process_routes_erddap_grid_and_puts_its_cell_edge_bounds_in_the_manifest(monkeypatch, tmp_path):
    from pipeline import raster
    edges = {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
    img = np.zeros((720, 1440, 4), np.uint8); img[..., 3] = 255
    monkeypatch.setattr(raster, "fetch_erddap_grid", lambda p: (img, "2026-10-11T12:00:00Z", {"bounds": edges}))
    entry = raster.process({"id": "oisst", "erddap_grid": {}, "name": "n", "icon": "i", "legend": "", "credit": "",
                            "credit_key": "noaa-oisst", "ramp": {"min": 0, "max": 1, "stops": [[0, 0, 0], [1, 1, 1]]}}, tmp_path)
    assert entry["bounds"] == edges and entry["time"] == "2026-10-11T12:00:00Z"
    assert (entry["width"], entry["height"]) == (1440, 720)


def test_fetch_opendap_grid_reads_the_catalog_file_strided_and_keeps_0_to_1():
    """ndvi reads the NDVI numbers over OPeNDAP instead of NCEI's WMS PNG (seq-YlGn, which the manifest ramp only
    approximated). The newest catalog file is read at `stride` from `offset` (the centre 0.05 deg cell of each 0.25 deg
    block, the cells the WMS drew); values outside `clear_outside` [0, 1] are clear, which is what the WMS showed
    (2026-10-12: it hid < 0 and the > 1 values beyond valid_range, showed 0..1). A file whose own time is not the date
    in its name is refused next to the passing path."""
    import numpy as np
    import pytest

    from pipeline.raster import fetch_opendap_grid

    class DA:
        def __init__(self, arr, dims=()): self.values, self.dims = np.asarray(arr), dims
    ndvi = np.array([[[-0.05, 0.0, 0.45], [0.9, 1.2, np.nan]]])  # time, lat (north first), lon
    t = DA(np.array(["2026-10-09T00:00:00"], dtype="datetime64[ns]"))
    ds = {"NDVI": DA(ndvi, ("time", "latitude", "longitude")), "time": t,
          "latitude": DA([45.0, -45.0]), "longitude": DA([-120.0, 0.0, 120.0])}
    catalog = ('<dataset urlPath="a/VIIRS-Land_v001_JP113C1_NOAA-20_20261008_c20261010143010.nc"/>'
               '<dataset urlPath="a/VIIRS-Land_v001_JP113C1_NOAA-20_20261009_c20261011143011.nc"/>')
    product = {"id": "ndvi", "catalog": "https://c/catalog.xml",
               "file_regex": "VIIRS-Land_v001_[A-Z0-9]+_NOAA-20_\\d{8}_c\\d+\\.nc", "time_regex": "_(\\d{4})(\\d{2})(\\d{2})_c",
               "url_template": "https://d/dodsC/{file}",
               "opendap_grid": {"variable": "NDVI", "stride": 5, "offset": 2, "clear_outside": [0, 1]},
               "ramp": {"min": 0, "max": 0.9, "stops": [[0, 0, 0], [90, 90, 90]]}}
    seen = []
    rgba, when, extras = fetch_opendap_grid(product, catalog_xml=catalog,
                                            read_grid=lambda *a: seen.append(a) or ds)
    assert seen == [("https://d/dodsC/VIIRS-Land_v001_JP113C1_NOAA-20_20261009_c20261011143011.nc", "NDVI", 5, 2)]
    assert when == "2026-10-09T00:00:00Z" and extras["bounds"] == {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
    assert rgba[0, :, 3].tolist() == [0, 255, 255], "< 0 clear, 0 and 0.45 drawn"
    assert rgba[0, 1].tolist() == [0, 0, 0, 255] and rgba[0, 2].tolist() == [45, 45, 45, 255]
    assert rgba[1, :, 3].tolist() == [255, 0, 0], "0.9 drawn, 1.2 (beyond valid_range) and NaN clear"
    late = dict(ds, time=DA(np.array(["2026-10-10T00:00:00"], dtype="datetime64[ns]")))
    with pytest.raises(ValueError, match="2026-10-10T00:00:00Z.*2026-10-09T00:00:00Z"):
        fetch_opendap_grid(product, catalog_xml=catalog, read_grid=lambda *a: late)


def test_process_routes_opendap_grid(monkeypatch, tmp_path):
    from pipeline import raster
    edges = {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
    img = np.zeros((720, 1440, 4), np.uint8)
    img[..., 3] = 255
    monkeypatch.setattr(raster, "fetch_opendap_grid", lambda p: (img, "2026-10-09T00:00:00Z", {"bounds": edges}))
    entry = raster.process({"id": "ndvi", "opendap_grid": {}, "catalog": "x", "name": "n", "icon": "i", "legend": "",
                            "credit": "", "credit_key": "noaa-ndvi-cdr",
                            "ramp": {"min": 0, "max": 1, "stops": [[0, 0, 0], [1, 1, 1]]}}, tmp_path)
    assert entry["bounds"] == edges and entry["time"] == "2026-10-09T00:00:00Z"


def test_edge_align_accepts_float32_centres_and_still_refuses_an_irregular_grid():
    """NCEI's NDVI stores its 0.05 deg centres as float32: taken every 5th from the 3rd, each centre is within half a
    float32 step (3.8e-6 deg near 90) of the 0.25 deg grid, but 2 of 719 latitude gaps then differ from 0.25 by more
    than allclose's default 2.5e-6, so the first real ndvi run was refused as irregular (2026-10-12). Regularity is
    judged at the coordinates' own precision and the step comes from the whole span, so the edges land on +-90/180; a
    grid with one centre really out of place is still refused."""
    import numpy as np
    import pytest

    from pipeline.raster import edge_align

    lat = np.float32(89.875 - 0.25 * np.arange(720))
    lat[128:256] -= np.float32(2.0 ** -18)  # bit-identical to the file's strided latitudes (2026-10-09)
    lon = np.float32(-179.875 + 0.25 * np.arange(1440))
    assert (~np.isclose(-np.diff(lat.astype(float)), 0.25)).sum() > 0, "control: the float32 gaps are not all 0.25"
    rgba, b = edge_align(np.zeros((len(lat), len(lon), 4), np.uint8), lat, lon)
    assert b == {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0} and rgba.shape[:2] == (720, 1440)
    bent = lat.copy()
    bent[300] += np.float32(0.01)
    with pytest.raises(ValueError, match="regular grid"):
        edge_align(np.zeros((len(lat), len(lon), 4), np.uint8), bent, lon)

    # the same coordinates through a fetch: the float32 must reach edge_align (a cast to float64 first hid it)
    from pipeline.raster import fetch_erddap_grid

    class DA:
        def __init__(self, arr, dims=()): self.values, self.dims = np.asarray(arr), dims
    ds = {"v": DA(np.zeros((1, 720, 1440)), ("time", "latitude", "longitude")), "latitude": DA(lat), "longitude": DA(lon),
          "time": DA(np.array(["2026-10-09T00:00:00"], dtype="datetime64[ns]"))}
    product = {"id": "ndvi", "erddap_grid": {"url": "u", "variable": "v"}, "ramp": {"min": 0, "max": 1, "stops": [[0, 0, 0], [1, 1, 1]]}}
    _, _, extras = fetch_erddap_grid(product, read_nc=lambda url: ds)
    assert extras["bounds"] == {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}


def test_edge_align_places_a_grid_whose_straddling_cell_is_the_last_one():
    """The mirror of the Copernicus case (PR #68 review): centres -170..180, so the west edge sits half a cell INSIDE
    -180 and the cell centred on 180 straddles the antimeridian at the east end; its east half must become the
    image's first pixel. Mutants this kills: turning the image the same way for both offsets."""
    import numpy as np
    from pipeline.raster import edge_align

    step = 10.0
    lat_c = np.arange(85.0, -85.0 - 1e-9, -step)
    lon_c = np.arange(-170.0, 180.0 + 1e-9, step)  # -170 .. 180
    old = _coded(lat_c, lon_c)
    assert _misplaced(old, {"west": -180, "south": -90, "east": 180, "north": 90}, lat_c, lon_c, step) > 0, "control"
    rgba, b = edge_align(_coded(lat_c, lon_c), lat_c, lon_c)
    assert b == {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0} and rgba.shape[1] == 2 * len(lon_c)
    assert _misplaced(rgba, b, lat_c, lon_c, step) == 0
    assert rgba[0, 0, 1] == len(lon_c) - 1 and rgba[0, -1, 1] == len(lon_c) - 1 and rgba[0, 1, 1] == 0
