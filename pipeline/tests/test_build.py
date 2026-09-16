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

def test_process_site_unlinks_volume_after_processing(tmp_path: Path, monkeypatch):
    """Workdir is transient input, not a cache: keys are timestamped so nothing ever
    re-hits, and leaving volumes behind grew /tmp by ~23 GB/day (2026-09-15)."""
    import pipeline.build_birds as bb

    key = "2026/09/11/KOKX/KOKX20260911_001210_V06"
    made = {}

    def fake_download(k, dest_dir):
        dest_dir.mkdir(parents=True, exist_ok=True)
        p = dest_dir / Path(k).name
        p.write_bytes(b"volume")
        made["path"] = p
        return p

    monkeypatch.setattr(bb, "download_volume", fake_download)
    monkeypatch.setattr(bb, "run_vol2bird", lambda vol: "raw")
    monkeypatch.setattr(bb, "parse_profile", lambda raw: "prof")
    monkeypatch.setattr(bb, "reduce_profile", lambda prof: REC)
    monkeypatch.setattr(bb, "ppi_for_volume", lambda vol, png: ("grid", "bounds"))

    feat, meta = bb.process_site(SITE, tmp_path / "work", tmp_path / "ppi", key=key)

    # positive control: the run still produced its output
    assert feat["properties"]["site"] == "KOKX"
    assert meta["png"] == "data/birds_ppi/KOKX.png"
    # the regression itself: no volume left behind
    assert not made["path"].exists()
    assert list((tmp_path / "work").rglob("*V06")) == []

def test_process_site_unlinks_volume_even_when_processing_fails(tmp_path: Path, monkeypatch):
    """A partial/corrupt download must not survive to poison the next run's cache hit."""
    import pytest
    import pipeline.build_birds as bb

    key = "2026/09/11/KOKX/KOKX20260911_001210_V06"
    made = {}

    def fake_download(k, dest_dir):
        dest_dir.mkdir(parents=True, exist_ok=True)
        p = dest_dir / Path(k).name
        p.write_bytes(b"partial")
        made["path"] = p
        return p

    def boom(vol):
        raise RuntimeError("vol2bird exploded")

    monkeypatch.setattr(bb, "download_volume", fake_download)
    monkeypatch.setattr(bb, "run_vol2bird", boom)

    with pytest.raises(RuntimeError, match="vol2bird exploded"):
        bb.process_site(SITE, tmp_path / "work", tmp_path / "ppi", key=key)

    assert not made["path"].exists()
