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
