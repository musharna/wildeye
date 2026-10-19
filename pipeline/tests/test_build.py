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

def test_write_atomic_failed_write_leaves_no_temp_file_and_the_old_file(tmp_path: Path):
    """A write that raises half-way kept its tmp*.tmp beside the target, and deploy_pages shipped it."""
    import pytest
    p = tmp_path / "b.geojson"
    write_atomic(p, {"a": 1})
    with pytest.raises(TypeError, match="not JSON serializable"):
        write_atomic(p, {"a": 2, "b": object()})   # fails after '{"a":2,' is already in the buffer
    assert json.loads(p.read_text()) == {"a": 1}, "the last good file stays"
    assert sorted(x.name for x in tmp_path.iterdir()) == ["b.geojson"]
    write_atomic(p, {"a": 3})
    assert json.loads(p.read_text()) == {"a": 3}

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
    monkeypatch.setattr(bb, "integrate_profile", lambda prof: {})
    monkeypatch.setattr(bb, "bio_gate_share", lambda prof: None)
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

def test_process_site_integrates_and_keeps_the_raw_profile(tmp_path: Path, monkeypatch):
    """The real KOKX vol2bird output goes through the real parse/reduce/integrate: the feature
    carries bioRad's numbers (pipeline/tests/fixtures/KOKX_profile.biorad.csv) and the raw text
    lands in the store; without vp_dir nothing is stored."""
    import gzip
    import pytest
    import pipeline.build_birds as bb

    fix = Path(__file__).parent / "fixtures" / "KOKX_profile.txt"
    key = "2026/09/11/KOKX/KOKX20260911_025354_V06"

    def fake_download(k, dest_dir):
        dest_dir.mkdir(parents=True, exist_ok=True)
        p = dest_dir / Path(k).name
        p.write_bytes(b"volume")
        return p

    monkeypatch.setattr(bb, "download_volume", fake_download)
    monkeypatch.setattr(bb, "run_vol2bird", lambda vol: fix.read_text())
    monkeypatch.setattr(bb, "ppi_for_volume", lambda vol, png: ("grid", "bounds"))

    feat, _ = bb.process_site(SITE, tmp_path / "work", tmp_path / "ppi", key=key, vp_dir=tmp_path / "vp")
    p = feat["properties"]
    assert p["mtr_birds_km_h"] == pytest.approx(1147.8423600000001, rel=1e-12)
    assert p["vid_birds_km2"] == pytest.approx(52.230000000000004, rel=1e-12)
    assert p["density_birds_km3"] > 10                       # the old record is still there
    assert p["bio_gate_share"] == pytest.approx(0.758218, abs=1e-6)  # awk sum($16)/sum($18)
    stored, = (tmp_path / "vp").rglob("*.txt.gz")
    assert stored.relative_to(tmp_path / "vp").as_posix() == "KOKX/20260911/KOKX20260911_025354_V06.txt.gz"
    assert gzip.decompress(stored.read_bytes()).decode() == fix.read_text()

    # a new scan without vp_dir is stored nowhere (a new key, so the store's dedup can't hide a write)
    bb.process_site(SITE, tmp_path / "work2", tmp_path / "ppi", key="2026/09/11/KOKX/KOKX20260911_030354_V06")
    assert list(tmp_path.rglob("*.txt.gz")) == [stored]

def test_main_writes_the_night_table_even_when_every_site_fails(tmp_path: Path, monkeypatch):
    """The night table is rebuilt from the profile store on every run, beside birds.geojson,
    and a run where every site failed still says so (SystemExit) after writing it."""
    import pytest
    import pipeline.build_birds as bb

    calls = []
    def boom(site, workdir, ppi_dir, vp_dir=None):
        raise RuntimeError("no volume")
    def fake_nights(root, sites, out, now, **kw):
        calls.append((root, [s["id"] for s in sites], out))
        return {"failures": {}}
    monkeypatch.setattr(bb, "process_site", boom)
    monkeypatch.setattr(bb, "build_nights", fake_nights)
    out = tmp_path / "data" / "birds.geojson"
    with pytest.raises(SystemExit, match="every site failed"):
        bb.main(["--out", str(out), "--sites", "2", "--workers", "1", "--vp-dir", str(tmp_path / "vp")])
    assert calls == [(tmp_path / "vp", ["KOKX", "KBOX"], tmp_path / "data" / "birds_nights.json")]
    assert json.loads(out.read_text())["fresh_count"] == 0
