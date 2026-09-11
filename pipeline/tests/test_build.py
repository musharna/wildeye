import json
from pathlib import Path
from pipeline.build_birds import build_feature, merge_last_good, write_atomic

SITE = {"id": "KOKX", "name": "Upton NY", "lat": 40.8655, "lon": -72.8639}
REC = {"density_birds_km3": 12.5, "heading_deg": 200.0, "speed_ms": 9.0, "peak_altitude_m": 600, "bins": 20}

def test_build_feature_shape():
    f = build_feature(SITE, REC, "2026/09/11/KOKX/KOKX20260911_001210_V06")
    assert f["type"] == "Feature"
    assert f["geometry"] == {"type": "Point", "coordinates": [-72.8639, 40.8655]}
    assert f["properties"]["site"] == "KOKX"
    assert f["properties"]["density_birds_km3"] == 12.5
    assert f["properties"]["scan_time"] == "2026-09-11T00:12:10Z"
    assert f["properties"]["stale"] is False

def test_merge_last_good_keeps_failed_site_marked_stale():
    prev = {"type": "FeatureCollection", "features": [
        build_feature(SITE, REC, "2026/09/10/KOKX/KOKX20260910_235959_V06")]}
    feats = merge_last_good({}, prev)
    assert len(feats) == 1 and feats[0]["properties"]["stale"] is True
    assert prev["features"][0]["properties"]["stale"] is False  # input not mutated

def test_merge_new_overrides_prev():
    prev = {"type": "FeatureCollection", "features": [build_feature(SITE, REC, "2026/09/10/KOKX/KOKX20260910_235959_V06")]}
    fresh = build_feature(SITE, {**REC, "density_birds_km3": 1.0}, "2026/09/11/KOKX/KOKX20260911_001210_V06")
    feats = merge_last_good({"KOKX": fresh}, prev)
    assert len(feats) == 1
    assert feats[0]["properties"]["density_birds_km3"] == 1.0 and feats[0]["properties"]["stale"] is False

def test_write_atomic(tmp_path: Path):
    p = tmp_path / "b.geojson"
    write_atomic(p, {"a": 1})
    assert json.loads(p.read_text()) == {"a": 1}
    assert not list(tmp_path.glob("*.tmp"))
