import datetime as dt
import json
from pipeline.gfw import with_key, latest_version, query_week, ring_area_km2, geometry_area_km2, load_countries, build, week_ends, main

SQ = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}  # ~1° square at the equator ≈ 12,364 km²


def test_latest_version_sorts_and_never_returns_the_alias():
    assert latest_version(lambda u, key=None, timeout=300: {"data": {"versions": ["v20260911", "latest", "v20260912", "v20260101"]}}) == "v20260912"


def test_query_week_builds_sql_window_and_parses_rows():
    seen = {}
    def fetch(url, key=None, timeout=300):
        seen["url"] = url; seen["key"] = key
        return {"status": "success", "data": [{"iso": "BRA", "n": 10, "ha": 1.234567}, {"iso": None, "n": 1, "ha": 1}]}
    rows = query_week("v20260912", dt.date(2026, 9, 11), "k", fetch)
    assert rows == {"BRA": {"n": 10, "ha": 1.23}} and seen["key"] == "k"
    assert "2026-09-05" in seen["url"] and "2026-09-11" in seen["url"] and "confidence+%21%3D+%27low%27" in seen["url"] and "/v20260912/" in seen["url"]
    try:
        query_week("v1", dt.date(2026, 9, 11), "k", lambda u, key=None, timeout=300: {"status": "failed", "message": "bad"}); assert False
    except RuntimeError as e:
        assert "bad" in str(e)


def test_area_is_sane():
    a = geometry_area_km2(SQ)
    assert 12000 < a < 12700
    assert geometry_area_km2({"type": "MultiPolygon", "coordinates": [SQ["coordinates"], SQ["coordinates"]]}) == 2 * a
    assert ring_area_km2([[0, 0], [1, 1]]) == 0.0


def test_load_countries_falls_back_to_adm0_a3_and_caches(tmp_path):
    ne = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"ISO_A3": "-99", "ADM0_A3": "FRA", "ADMIN": "France"}, "geometry": SQ},
        {"type": "Feature", "properties": {"ISO_A3": "BRA", "ADM0_A3": "BRA", "ADMIN": "Brazil"}, "geometry": SQ},
        {"type": "Feature", "properties": {"ISO_A3": "-99", "ADM0_A3": "-99", "ADMIN": "Nowhere"}, "geometry": SQ},
    ]}
    calls = []
    p = tmp_path / "ne.geojson"
    c = load_countries(p, lambda u: (calls.append(u), json.dumps(ne).encode())[1])
    assert sorted(c) == ["BRA", "FRA"] and c["FRA"]["name"] == "France" and 12000 < c["FRA"]["area_km2"] < 12700
    load_countries(p)  # cached: no second fetch
    assert len(calls) == 1


def test_build_keeps_only_countries_with_alerts_and_reports_missing_shapes():
    countries = {"BRA": {"name": "Brazil", "area_km2": 8_500_000, "geometry": SQ}}
    weekly = [(dt.date(2026, 9, 11), {"BRA": {"n": 100, "ha": 50.0}, "XXX": {"n": 5, "ha": 1.0}, "ARG": {"n": 0, "ha": 0.0}}),
              (dt.date(2026, 9, 4), {"BRA": {"n": 20, "ha": 8.0}})]
    feats, counts = build(weekly, countries)
    assert counts == {"countries": 1, "missing_shape": 1, "alerts": 120}, "ARG had zero alerts and is not a missing shape"
    p = feats[0]["properties"]
    assert p["n"] == 120 and p["ha"] == 58.0 and p["weeks"] == [{"w": "2026-09-11", "n": 100, "ha": 50.0}, {"w": "2026-09-04", "n": 20, "ha": 8.0}]
    assert p["ha_per_1e4km2"] == round(58.0 / 850, 2)


def test_main_end_to_end(tmp_path, monkeypatch):
    import pipeline.gfw as m
    monkeypatch.setenv("GFW_API_KEY", "k")
    monkeypatch.setattr(m, "latest_version", lambda fetch=None, key=None: "v20260912")
    monkeypatch.setattr(m, "query_week", lambda v, end, key, fetch=None: {"BRA": {"n": 3, "ha": 1.0}})
    monkeypatch.setattr(m, "load_countries", lambda path, fetch_bytes=None: {"BRA": {"name": "Brazil", "area_km2": 8_500_000, "geometry": SQ}})
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    out = tmp_path / "gfw.geojson"
    main(["--out", str(out), "--weeks", "2", "--today", "2026-09-12", "--cache", str(tmp_path)])
    gj = json.loads(out.read_text())
    assert gj["weeks"] == ["2026-09-12", "2026-09-05"] and gj["source"]["version"] == "v20260912" and gj["features"][0]["properties"]["n"] == 6
    assert week_ends(dt.date(2026, 9, 12), 2) == [dt.date(2026, 9, 12), dt.date(2026, 9, 5)]


def test_with_key_goes_in_the_query_string_never_a_header():
    assert with_key("https://x/a", "k") == "https://x/a?x-api-key=k"
    assert with_key("https://x/a?sql=1", "k") == "https://x/a?sql=1&x-api-key=k"
    assert with_key("https://x/a", None) == "https://x/a"
