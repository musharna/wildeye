from pathlib import Path
from pipeline.vol2bird import parse_profile, reduce_profile

FIX = Path(__file__).parent / "fixtures" / "KOKX_profile.txt"

def test_parse_profile_reads_real_fixture():
    bins = parse_profile(FIX.read_text())
    assert len(bins) >= 10
    assert all("height_m" in b and "dens" in b for b in bins)
    assert bins[0]["height_m"] < bins[-1]["height_m"]
    assert bins[0]["dens"] == 109.0 and bins[0]["dd"] == 148.8
    assert bins[9]["dd"] is None  # nan row → None

def test_reduce_profile_positive_and_negative_control():
    bins = parse_profile(FIX.read_text())
    r = reduce_profile(bins)
    assert r["bins"] == len(bins)
    assert r["density_birds_km3"] > 10          # positive control: real migration night
    assert 140 <= r["heading_deg"] <= 165
    assert r["peak_altitude_m"] == 0
    assert r["u_ms"] > 0 and r["v_ms"] < 0          # SSE flow: east +, north -
    empty = [{**b, "dens": None, "dd": None, "ff": None} for b in bins]
    e = reduce_profile(empty)                   # negative control
    assert e["density_birds_km3"] is None and e["heading_deg"] is None
    assert e["u_ms"] is None

def test_reduce_profile_circular_mean():
    bins = [
        {"height_m": 200, "dens": 1.0, "dd": 350.0, "ff": 10.0},
        {"height_m": 400, "dens": 1.0, "dd": 10.0, "ff": 10.0},
    ]
    r = reduce_profile(bins)
    assert min(r["heading_deg"], 360 - r["heading_deg"]) < 1e-6
    assert r["peak_altitude_m"] == 200 and r["speed_ms"] == 10.0
