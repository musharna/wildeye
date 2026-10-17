import csv
import datetime as dt
import gzip
from pathlib import Path
import pytest
from pipeline.vol2bird import (parse_profile, reduce_profile, integrate_profile, migration_traffic,
                               profile_time, save_profile, prune_profiles)

FIX = Path(__file__).parent / "fixtures" / "KOKX_profile.txt"
# eight real KOKX profiles, 2026-10-17 01:01-03:28 UTC, with a 93-min hole (bioRad's interval cap)
NIGHT = Path(__file__).parent / "fixtures" / "vp_KOKX_20261017"

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

# --- bioRad-equivalent integration. Golden numbers come from a second engine:
# pipeline/biorad_golden.R runs bioRad 0.12.0's integrate_profile on the same files.

def golden(path: Path) -> list[dict]:
    rows = [line for line in path.read_text().splitlines() if not line.startswith("#")]
    return list(csv.DictReader(rows))

def test_parse_profile_keeps_sd_vvp_and_gap():
    bins = parse_profile(FIX.read_text())
    assert bins[0]["sd_vvp"] == 3.90 and bins[0]["gap"] is False
    assert bins[9]["gap"] is True and bins[9]["ff"] is None and bins[9]["dens"] == 1.90

def test_integrate_profile_matches_biorad_on_one_profile():
    g, = golden(FIX.with_name("KOKX_profile.biorad.csv"))
    r = integrate_profile(parse_profile(FIX.read_text()))
    assert r["vid_birds_km2"] == pytest.approx(float(g["vid"]), rel=1e-12)
    assert r["mtr_birds_km_h"] == pytest.approx(float(g["mtr"]), rel=1e-12)
    assert profile_time(FIX.read_text()) == dt.datetime(2026, 9, 11, 2, 53, tzinfo=dt.UTC)

def test_night_matches_biorad_per_profile_and_cumulative():
    files = sorted(NIGHT.glob("KOKX*.txt"))
    g = golden(NIGHT / "biorad.csv")
    assert len(files) == len(g) == 8
    texts = [f.read_text() for f in files]
    recs = [integrate_profile(parse_profile(t)) for t in texts]
    times = [profile_time(t) for t in texts]
    assert [t.strftime("%Y-%m-%dT%H:%M:%SZ") for t in times] == [r["datetime"] for r in g]
    mt = migration_traffic(times, [r["mtr_birds_km_h"] for r in recs])
    for rec, cum, row in zip(recs, mt, g):
        assert rec["vid_birds_km2"] == pytest.approx(float(row["vid"]), rel=1e-12, abs=1e-12)
        assert rec["mtr_birds_km_h"] == pytest.approx(float(row["mtr"]), rel=1e-12, abs=1e-12)
        assert cum == pytest.approx(float(row["mt"]), rel=1e-12, abs=1e-12)
    # 03:11: birds in the column (vid > 0) but no speed where they fly, so bioRad's mtr is 0;
    # the share says the 0 is missing speed, not missing birds
    assert recs[5]["vid_birds_km2"] > 0 and recs[5]["mtr_birds_km_h"] == 0
    assert recs[5]["speedless_share"] == 1.0
    assert 0 < recs[4]["speedless_share"] < 1

def test_integrate_profile_by_hand_gap_bin_and_clipping():
    bins = [{"height_m": 0, "dens": 10.0, "ff": 5.0}, {"height_m": 200, "dens": 20.0, "ff": None}]
    r = integrate_profile(bins)
    assert r["vid_birds_km2"] == pytest.approx(10 * 0.2 + 20 * 0.2)
    assert r["mtr_birds_km_h"] == pytest.approx(10 * 5 * 3.6 * 0.2)   # gap bin counts in vid only
    assert r["speedless_share"] == pytest.approx(4 / 6)
    c = integrate_profile(bins, alt_max_m=100)                          # half of bin 0, none of bin 1
    assert c["vid_birds_km2"] == pytest.approx(1.0) and c["mtr_birds_km_h"] == pytest.approx(18.0)
    none = integrate_profile([{**b, "dens": None} for b in bins])
    assert none == {"vid_birds_km2": None, "mtr_birds_km_h": None, "speedless_share": None}
    with pytest.raises(ValueError, match="uneven height bins"):
        integrate_profile(bins + [{"height_m": 500, "dens": 1.0, "ff": 1.0}])

def test_integrate_profile_rejects_duplicate_and_too_few_bins_but_nulls_an_empty_profile():
    """Review of #96: a duplicated height bin made the step 0, every dh 0 and vid/mtr 0 for a
    profile with birds; an empty profile raised and failed the site where reduce_profile gives nulls."""
    dup = [{"height_m": 200, "dens": 10.0, "ff": 5.0}, {"height_m": 200, "dens": 20.0, "ff": 5.0}]
    with pytest.raises(ValueError, match="duplicate height bins"):
        integrate_profile(dup)
    with pytest.raises(ValueError, match="at least two height bins"):
        integrate_profile(dup[:1])
    assert integrate_profile([]) == {"vid_birds_km2": None, "mtr_birds_km_h": None, "speedless_share": None}
    assert reduce_profile([])["density_birds_km3"] is None              # same answer as the old record
    ok = integrate_profile([dup[0], {**dup[1], "height_m": 400}])       # positive control
    assert ok["vid_birds_km2"] == pytest.approx(10 * 0.2 + 20 * 0.2)

def test_migration_traffic_rejects_unordered_times_and_missing_rates():
    t0 = dt.datetime(2026, 10, 17, 1, tzinfo=dt.UTC)
    ts = [t0, t0 + dt.timedelta(minutes=10)]
    assert migration_traffic(ts, [60.0, 60.0]) == pytest.approx([5.0, 10.0])   # 5 min each side
    with pytest.raises(ValueError, match="strictly increasing"):
        migration_traffic(ts[::-1], [60.0, 60.0])
    with pytest.raises(ValueError, match="no migration traffic rate"):
        migration_traffic(ts, [60.0, None])
    assert migration_traffic([t0], [60.0]) == [0.0]                     # bioRad: one profile, dt 0

def test_profile_time_rejects_text_without_rows():
    with pytest.raises(ValueError, match="no profile rows"):
        profile_time("# vol2bird header only\n")

def test_save_profile_stores_raw_text_once_per_scan_and_prunes_old_days(tmp_path: Path):
    text = FIX.read_text()
    key = "2026/09/11/KOKX/KOKX20260911_025354_V06"
    p = save_profile(text, "KOKX", key, tmp_path)
    assert p == tmp_path / "KOKX" / "20260911" / "KOKX20260911_025354_V06.txt.gz"
    assert gzip.decompress(p.read_bytes()).decode() == text
    assert save_profile(text + "changed", "KOKX", key, tmp_path) == p   # same scan: first write kept
    assert gzip.decompress(p.read_bytes()).decode() == text
    assert list(tmp_path.rglob("*.tmp")) == []
    old = save_profile(text, "KOKX", "2026/07/01/KOKX/KOKX20260701_000000_V06", tmp_path)
    edge = save_profile(text, "KOKX", "2026/07/14/KOKX/KOKX20260714_000000_V06", tmp_path)  # 60 days back
    removed = prune_profiles(tmp_path, keep_days=60, today=dt.date(2026, 9, 12))
    assert removed == [old.parent] and not old.parent.exists()
    assert p.exists() and edge.exists()
