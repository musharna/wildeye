import datetime as dt
import io
import json
import urllib.error
import urllib.request

from pipeline import freshness as f

NOW = dt.datetime(2026, 10, 7, 15, 0, tzinfo=dt.UTC)


def ago(**kw) -> str:
    return (NOW - dt.timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rasters(generated_at: str, **times) -> dict:
    return {"generated_at": generated_at, "failures": {},
            "products": [{"id": pid, "time": t} for pid, t in times.items()]}


def test_a_layer_is_stale_after_two_missed_runs_with_positive_controls():
    stamps = {
        "hpai.geojson": ago(days=2, hours=7),       # daily, two runs missed: stale
        "gfw.geojson": ago(hours=30),               # daily, one run missed: not yet
        "birds.geojson": ago(hours=20),             # every 10 min, but the site changes daily: fresh
        "tracks.geojson": ago(days=10),             # weekly, one run missed: not yet
        "drought.geojson": ago(days=14, hours=7),   # weekly, two missed: stale
        "gmw.geojson": ago(days=40),                # monthly, one missed: not yet
    }
    stale = {p["layer"] for p in f.assess(stamps, None, NOW, layers={k: f.LAYERS[k] for k in stamps})}
    assert stale == {"hpai.geojson", "drought.geojson"}


def test_hpai_as_it_was_on_2026_09_14_is_reported():
    """The failure that went unseen for 25 days: the file written 2026-09-11, read three days later."""
    now = dt.datetime(2026, 9, 14, 15, 0, tzinfo=dt.UTC)
    problems = f.assess({"hpai.geojson": "2026-09-11T03:32:46Z"}, None, now, layers={"hpai.geojson": "daily"})
    assert [p["layer"] for p in problems] == ["hpai.geojson"]
    assert "3 days" in problems[0]["why"]


def test_an_unreadable_layer_is_a_problem_not_a_pass():
    layers = {"a.geojson": "daily", "b.geojson": "daily", "c.geojson": "daily"}
    stamps = {"a.geojson": "HTTP 404", "b.geojson": None, "c.geojson": ago(hours=3)}
    problems = {p["layer"]: p["why"] for p in f.assess(stamps, None, NOW, layers=layers)}
    assert set(problems) == {"a.geojson", "b.geojson"}, "c is the positive control"
    assert "HTTP 404" in problems["a.geojson"] and "no generated_at" in problems["b.geojson"]


def test_each_raster_product_is_checked_on_its_own_data_time():
    # rasters.json is rewritten every day even when one product's fetch fails, so the file is fresh
    rasters = _rasters(ago(hours=4), oisst=ago(days=2), ndvi=ago(days=8), **{"crw-outlook": ago(days=40)})
    problems = f.assess({"rasters.json": ago(hours=4)}, rasters, NOW, layers={"rasters.json": "daily"})
    assert [p["layer"] for p in problems] == ["rasters.json: ndvi"]
    # the monthly outlook gets a monthly limit, not the daily products' 7 days
    rasters = _rasters(ago(hours=4), **{"crw-outlook": ago(days=63)})
    assert [p["layer"] for p in f.assess({"rasters.json": ago(hours=4)}, rasters, NOW, layers={"rasters.json": "daily"})] == ["rasters.json: crw-outlook"]


class _Resp(io.BytesIO):
    pass


def _site(monkeypatch, files: dict):
    """Serve files {name: bytes} under f.BASE; anything else is a 404. Returns the (url, bytes read) pairs."""
    asked = []

    def fake(req, *a, **k):
        url = getattr(req, "full_url", req)
        name = url.removeprefix(f.BASE)
        if name not in files:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        asked.append(url)
        return _Resp(files[name])
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    return asked


def _all_fresh() -> dict:
    files = {name: json.dumps({"type": "FeatureCollection", "generated_at": ago(hours=5), "features": []}).encode()
             for name in f.LAYERS}
    files["rasters.json"] = json.dumps(_rasters(ago(hours=5), oisst=ago(days=2))).encode()
    return files


def test_main_reads_the_live_site_and_exits_stale_only_when_something_is_stale(tmp_path, monkeypatch):
    # a crash exits 1, so "stale" must be a code a crash cannot produce
    assert f.STALE_EXIT not in (0, 1)
    report = tmp_path / "report.md"
    # positive control: everything fresh
    _site(monkeypatch, _all_fresh())
    assert f.main(["--report", str(report), "--now", NOW.isoformat()]) == 0
    assert "every layer" in report.read_text().lower()
    # hpai frozen for 3 days, one file gone from the site
    files = _all_fresh()
    files["hpai.geojson"] = json.dumps({"generated_at": ago(days=3)}).encode()
    del files["fires.geojson"]
    _site(monkeypatch, files)
    assert f.main(["--report", str(report), "--now", NOW.isoformat()]) == f.STALE_EXIT
    text = report.read_text()
    assert "hpai.geojson" in text and "fires.geojson" in text and "HTTP 404" in text
    assert "<!-- stale: fires.geojson,hpai.geojson -->" in text, "the marker the workflow compares day to day"


def test_a_product_time_that_does_not_parse_is_reported_not_a_crash(tmp_path, monkeypatch):
    """PR #61 review: the product loop parsed `time` unguarded, so one bad value raised, no report
    was written, and the workflow never touched the issue."""
    rasters = _rasters(ago(hours=4), oisst=ago(days=2), ndvi="unknown")
    problems = f.assess({"rasters.json": ago(hours=4)}, rasters, NOW, layers={"rasters.json": "daily"})
    assert [(p["layer"], p["why"]) for p in problems] == [("rasters.json: ndvi", "could not read its data time: unknown")], "oisst is the positive control"
    # and through main: a report and the stale code, not a traceback
    files = _all_fresh()
    files["rasters.json"] = json.dumps(rasters).encode()
    _site(monkeypatch, files)
    report = tmp_path / "report.md"
    assert f.main(["--report", str(report), "--now", NOW.isoformat()]) == f.STALE_EXIT
    assert "rasters.json: ndvi" in report.read_text()


def test_rasters_json_of_the_wrong_shape_is_reported_not_a_crash(tmp_path, monkeypatch):
    """PR #61 delta review: values come straight from json.loads, so a number or an object where a
    time string belongs raised TypeError, which the ValueError guards did not catch."""
    report = tmp_path / "report.md"
    shapes = {
        "numbers for times": ({"generated_at": 1791316018, "products": [
            {"id": "ndvi", "time": 1791316018}, "not a product", {"id": "oisst", "time": ago(days=2)}]},
            {"rasters.json", "rasters.json: ndvi", "rasters.json: product 1"}),
        "a list, not an object": ([], {"rasters.json"}),
        "products not a list": ({"generated_at": ago(hours=4), "products": {"id": "ndvi"}}, {"rasters.json: products"}),
    }
    for label, (rasters, expected) in shapes.items():
        files = _all_fresh()
        files["rasters.json"] = json.dumps(rasters).encode()
        _site(monkeypatch, files)
        assert f.main(["--report", str(report), "--now", NOW.isoformat()]) == f.STALE_EXIT, label
        marker = report.read_text().splitlines()[0]
        assert set(marker.removeprefix("<!-- stale: ").removesuffix(" -->").split(",")) == expected, (label, marker)
