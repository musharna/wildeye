from pathlib import Path
from pipeline.aloft import parse_vpts, latest_profile, radar_feature

FIX = Path(__file__).parent / "fixtures" / "seang_vpts_tail.csv"

def test_parse_groups_by_time_and_keeps_radar_position():
    prof = parse_vpts(FIX.read_text())
    assert prof["radar"] == "seang"
    assert abs(prof["lat"] - 56.367451) < 1e-6 and abs(prof["lon"] - 12.851691) < 1e-6
    assert len(prof["times"]) >= 2
    t, bins = latest_profile(prof)
    assert t.endswith("Z") and bins and all("height_m" in b and "dens" in b for b in bins)

def test_latest_profile_skips_all_empty_timestamps():
    text = FIX.read_text()
    # append a later timestamp with no data at all: must NOT be chosen
    header = text.splitlines()[0]
    empty = "seang,2026-09-10T00:00:00Z,0,,,,,,,TRUE,,,,,0,0,0,0,11.0,2.0,,56.367451,12.851691,209,5.3,x.h5"
    prof = parse_vpts(text + "\n" + empty)
    t, _ = latest_profile(prof)
    assert t != "2026-09-10T00:00:00Z"

def test_radar_feature_schema_matches_birds():
    prof = parse_vpts(FIX.read_text())
    f = radar_feature(prof)
    p = f["properties"]
    for k in ("site", "name", "scan_time", "stale", "density_birds_km3", "heading_deg", "speed_ms", "peak_altitude_m", "u_ms", "v_ms"):
        assert k in p, k
    assert f["geometry"]["coordinates"] == [prof["lon"], prof["lat"]]
    assert p["source"] == "aloft-baltrad"


def _shifted(text: str, scan: str) -> str:
    """The fixture with its newest profile time, 2026-09-09T23:45:00Z, moved to `scan`."""
    return text.replace("2026-09-09T23:45:00Z", scan)


def _ago(hours: float) -> str:
    import datetime as dt
    return (dt.datetime.now(dt.UTC) - dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_a_profile_older_than_the_stale_limit_is_marked_stale_and_a_recent_one_is_not():
    """stale was hard-coded False: on 2026-11-08, 16 of 153 live radars had a newest profile over 4 days old (one from
    2025-05-04) and every one read as current. The fixture's newest profile is from 2026-09-09."""
    from pipeline import aloft
    text = FIX.read_text()
    old = radar_feature(parse_vpts(text))["properties"]
    assert old["scan_time"] == "2026-09-09T23:45:00Z" and old["stale"] is True
    recent = _ago(35)  # the usual age at the daily run
    fresh = radar_feature(parse_vpts(_shifted(text, recent)))["properties"]
    assert fresh["scan_time"] == recent and fresh["stale"] is False
    late = _ago(aloft.STALE_AFTER.total_seconds() / 3600 + 0.1)
    assert radar_feature(parse_vpts(_shifted(text, late)))["properties"]["stale"] is True
    edge = _ago(aloft.STALE_AFTER.total_seconds() / 3600 - 0.1)
    assert radar_feature(parse_vpts(_shifted(text, edge)))["properties"]["stale"] is False


def _main_with(monkeypatch, tmp_path, results):
    """aloft.main over the radars in `results`: a scan time (the radar succeeds) or an exception (it fails)."""
    import json
    from pipeline import aloft
    text = FIX.read_text()

    def process(r):
        v = results[r]
        if isinstance(v, BaseException):
            raise v
        f = radar_feature(parse_vpts(_shifted(text, v)))
        f["properties"]["site"] = r
        return f
    monkeypatch.setattr(aloft, "list_radars", lambda: sorted(results))
    monkeypatch.setattr(aloft, "process_radar", process)
    out = tmp_path / "aloft.geojson"
    aloft.main(["--out", str(out), "--workers", "1"])
    return json.loads(out.read_text())


def test_main_counts_stale_radars_apart_from_fresh_ones(monkeypatch, tmp_path):
    fc = _main_with(monkeypatch, tmp_path, {"a": _ago(35), "b": "2026-09-09T23:45:00Z", "c": RuntimeError("no daily csv")})
    assert {f["properties"]["site"]: f["properties"]["stale"] for f in fc["features"]} == {"a": False, "b": True}
    assert (fc["site_count"], fc["fresh_count"], fc["stale_count"]) == (3, 1, 1) and list(fc["failures"]) == ["c"]


def test_a_run_where_every_radar_fails_leaves_the_last_file_and_its_stamp_alone(monkeypatch, tmp_path):
    """The run wrote generated_at = now over an empty feature list, then exited 1: freshness.py read the layer as
    fresh while the map lost every radar. A partial run still stamps (the positive control)."""
    import json
    import pytest
    fc = _main_with(monkeypatch, tmp_path, {"a": _ago(35), "b": RuntimeError("timeout")})
    assert fc["fresh_count"] == 1 and fc["generated_at"] >= _ago(1)
    out = tmp_path / "aloft.geojson"
    before = fc | {"generated_at": "2026-11-01T06:20:00Z"}
    out.write_text(json.dumps(before))
    with pytest.raises(SystemExit, match="every radar failed"):
        _main_with(monkeypatch, tmp_path, {"a": RuntimeError("timeout"), "b": RuntimeError("timeout")})
    assert json.loads(out.read_text()) == before
