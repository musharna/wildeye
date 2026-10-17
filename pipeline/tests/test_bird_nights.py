import csv
import datetime as dt
import gzip
import json
from pathlib import Path
import pytest
from pipeline.bird_nights import sun_event, night_window, stored_profiles, night_total, build_nights, main
from pipeline.vol2bird import save_profile

FIX = Path(__file__).parent / "fixtures"
NIGHT = FIX / "vp_KOKX_20261017"            # eight real KOKX profiles, 01:01-03:28 UTC on 10-17
KOKX = {"id": "KOKX", "name": "Upton NY", "lat": 40.8655, "lon": -72.8639}
UTC = dt.UTC
HDR = "# date   time HGHT    u      v       w     ff    dd  sd_vvp gap dbz     eta   dens   DBZH   n   n_dbz n_all n_dbz_all\n"

def rows(path: Path) -> list[dict]:
    return list(csv.DictReader(line for line in path.read_text().splitlines() if not line.startswith("#")))

def iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))

def prof(when: dt.datetime, bins: list[tuple], kept: tuple = (1, 1)) -> str:
    """A vol2bird stdout profile; bins are (height_m, dens, ff or None for a gap bin); kept is each bin's
    (n_dbz, n_dbz_all)."""
    out = [HDR]
    for h, dens, ff in bins:
        f, g = ("nan", "T") if ff is None else (f"{ff}", "F")
        out.append(f"{when:%Y%m%d} {when:%H%M} {h} nan nan nan {f} nan 2.0 {g} 0.0 0.0 {dens} 0.0 1 {kept[0]} 1 {kept[1]}\n")
    return "".join(out)

def store_night(root: Path) -> None:
    for f in sorted(NIGHT.glob("KOKX*.txt")):
        save_profile(f.read_text(), "KOKX", "2026/10/17/KOKX/" + f.name.removesuffix(".txt"), root)

def test_sun_event_matches_biorad_for_every_site_and_season():
    sites = {s["id"]: s for s in json.loads((FIX.parent.parent / "sites.json").read_text())}
    g = rows(FIX / "biorad_sun.csv")
    assert len(g) == 80
    for r in g:
        s = sites[r["site"]]
        sunset, sunrise = night_window(dt.date.fromisoformat(r["night"]), s["lon"], s["lat"])
        assert abs((sunset - iso(r["sunset"])).total_seconds()) < 0.01, r
        assert abs((sunrise - iso(r["sunrise"])).total_seconds()) < 0.01, r
    with pytest.raises(ValueError, match="no sun rise"):            # polar night: no event, no guess
        sun_event(dt.date(2026, 12, 21), 15.0, 80.0, rising=True)

def test_night_total_matches_biorad_on_real_profiles(tmp_path: Path):
    store_night(tmp_path)
    after = dt.datetime(2026, 10, 17, 11, 30, tzinfo=UTC)               # after sunrise: not this night
    save_profile(prof(after, [(0, 50.0, 10.0), (200, 0.0, 10.0)]), "KOKX", "2026/10/17/KOKX/KOKX20261017_113000_V06", tmp_path)
    sunset, sunrise = night_window(dt.date(2026, 10, 16), KOKX["lon"], KOKX["lat"])
    ps = stored_profiles(tmp_path, "KOKX", sunset, sunrise)
    assert len(ps) == 8 and ps[0][0] == dt.datetime(2026, 10, 17, 1, 1, tzinfo=UTC)
    n = night_total(ps, sunset, sunrise)
    g = rows(NIGHT / "biorad.csv")
    assert n["mt_birds_km"] == pytest.approx(float(g[-1]["mt"]), rel=1e-12)
    assert n["peak_mtr_birds_km_h"] == pytest.approx(32.81436, rel=1e-9) and n["peak_time"] == "2026-10-17T01:38:00Z"
    # steps 10, 9, 9, 9, 93, 11, 6 min; mean of those under an hour 9 -> 5+9+9+9+9+9+8.5+3 = 61.5 min
    assert n["coverage"] == pytest.approx(61.5 * 60 / (sunrise - sunset).total_seconds())
    assert n["profiles"] == 8 and 0 < n["speedless_share"] < 1

def test_night_total_by_hand_speedless_empty_and_no_profiles():
    t0 = dt.datetime(2026, 10, 17, 1, 0, tzinfo=UTC)
    a = prof(t0, [(0, 10.0, 5.0), (200, 0.0, 5.0)])                       # vid 2, mtr 36, all seen
    b = prof(t0 + dt.timedelta(minutes=10), [(0, 10.0, None), (200, 0.0, 5.0)])   # vid 2, no speed
    c = prof(t0 + dt.timedelta(minutes=20), [(0, "nan", 5.0), (200, "nan", 5.0)])  # no density at all
    sunset, sunrise = t0 - dt.timedelta(hours=1), t0 + dt.timedelta(hours=1)
    n = night_total([(t0, a), (t0 + dt.timedelta(minutes=10), b), (t0 + dt.timedelta(minutes=20), c)], sunset, sunrise)
    assert n["profiles"] == 3 and n["profiles_without_density"] == 1
    assert n["mt_birds_km"] == pytest.approx(36 * 5 / 60)                # a stands for 5 min; b, c add 0
    # hours a 5, b 10, c 5 min; c (no density) is in coverage, not in measured_coverage or the share
    assert n["coverage"] == pytest.approx(20 / 120) and n["measured_coverage"] == pytest.approx(15 / 120)
    assert n["speedless_share"] == pytest.approx((10 * 2) / (5 * 2 + 10 * 2))
    assert n["peak_mtr_birds_km_h"] == pytest.approx(36.0) and n["peak_time"] == "2026-10-17T01:00:00Z"
    rain = night_total([(t0 + dt.timedelta(minutes=20), c)], sunset, sunrise)  # a night of rain only
    assert rain["mt_birds_km"] == 0.0 and rain["measured_coverage"] == 0.0 and rain["peak_time"] is None
    none = night_total([], sunset, sunrise)
    assert none["mt_birds_km"] is None and none["coverage"] == 0.0 and none["profiles"] == 0

def test_build_nights_merges_marks_complete_prunes_and_isolates_a_bad_site(tmp_path: Path):
    store, out = tmp_path / "vp", tmp_path / "birds_nights.json"
    store_night(store)
    bad = {"id": "KBAD", "name": "bad", "lat": 40.0, "lon": -75.0}
    (store / "KBAD" / "20261017").mkdir(parents=True)
    (store / "KBAD" / "20261017" / "KBAD20261017_010000_V06.txt.gz").write_bytes(b"not gzip")
    out.write_text(json.dumps({"sites": {"KOKX": [{"night": "2026-07-01", "mt_birds_km": 1.0}],
                                         "KGRR": [{"night": "2026-10-15", "mt_birds_km": 2.0}]}}))
    doc = build_nights(store, [KOKX, bad], out, dt.datetime(2026, 10, 17, 6, 0, tzinfo=UTC))
    assert json.loads(out.read_text()) == doc
    kokx, = doc["sites"]["KOKX"]                                          # 07-01 pruned; 10-17 not begun
    assert kokx["night"] == "2026-10-16" and kokx["complete"] is False
    assert kokx["mt_birds_km"] == pytest.approx(11.3739864, rel=1e-9)
    assert doc["sites"]["KGRR"][0]["mt_birds_km"] == 2.0                  # other sites kept
    assert list(doc["failures"]) == ["KBAD 2026-10-16"] and "KBAD" not in doc["sites"]
    later = build_nights(store, [KOKX], out, dt.datetime(2026, 10, 17, 12, 0, tzinfo=UTC))
    assert later["sites"]["KOKX"][0]["complete"] is True and later["failures"] == {}

def test_main_refuses_unknown_site(tmp_path: Path):
    with pytest.raises(SystemExit, match="unknown site"):
        main(["build", "--night", "2026-10-16", "--site", "KNOPE", "--vp-dir", str(tmp_path), "--out", str(tmp_path / "o.json")])

def test_a_whole_real_night_with_rain_matches_biorad_scan_by_scan(tmp_path: Path):
    """Every archived KOKX volume of night 2026-10-16 (140 scans, 22 of them rain with no density at all),
    run through vol2bird by `bird_nights backfill`; bioRad's mt for the same files is the golden."""
    night = FIX / "vp_KOKX_night_20261016"
    for f in night.glob("*.txt.gz"):
        dest = tmp_path / "KOKX" / f.name[4:12] / f.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(f.read_bytes())
    sunset, sunrise = night_window(dt.date(2026, 10, 16), KOKX["lon"], KOKX["lat"])
    ps = stored_profiles(tmp_path, "KOKX", sunset, sunrise)
    g = rows(night / "biorad.csv")
    assert len(ps) == len(g) == 140
    from pipeline.vol2bird import integrate_profile, parse_profile, migration_traffic
    mt = migration_traffic([t for t, _ in ps],
                           [integrate_profile(parse_profile(x))["mtr_birds_km_h"] or 0.0 for _, x in ps])
    for (t, _), cum, row in zip(ps, mt, g):
        assert t == iso(row["datetime"]) and cum == pytest.approx(float(row["mt"]), rel=1e-12, abs=1e-12)
    n = night_total(ps, sunset, sunrise)
    assert n["mt_birds_km"] == pytest.approx(float(g[-1]["mt"]), rel=1e-12)
    assert n["profiles_without_density"] == 22 and n["measured_coverage"] < n["coverage"] <= 1

def test_keeps_exactly_keep_nights_nights(tmp_path: Path):
    """Review of #99: the cutoff was inclusive, so KEEP_NIGHTS = 60 kept 61 nights."""
    out = tmp_path / "n.json"
    now = dt.datetime(2026, 10, 17, 6, 0, tzinfo=UTC)
    nights = [(now.date() - dt.timedelta(days=d)).isoformat() for d in range(0, 62)]
    out.write_text(json.dumps({"sites": {"KGRR": [{"night": n} for n in nights]}}))
    doc = build_nights(tmp_path / "vp", [], out, now, keep_nights=60)
    kept = [e["night"] for e in doc["sites"]["KGRR"]]
    assert len(kept) == 60 and kept[0] == "2026-08-19" and kept[-1] == "2026-10-17"   # 08-18 is 60 back

def test_backfill_with_a_failed_volume_still_rebuilds_the_nights_then_fails(tmp_path: Path, monkeypatch):
    """Review of #99: one failed volume of ~140 stopped the night table from being rebuilt
    from the ones that did land; now it is rebuilt and the run still exits non-zero."""
    import pipeline.bird_nights as bn
    built = []
    monkeypatch.setattr(bn, "backfill_night", lambda site, night, root, workdir, workers: ["2026/10/17/KOKX/K_V06"])
    monkeypatch.setattr(bn, "build_nights", lambda root, sites, out, now, nights=None: built.append(nights) or {"failures": {}})
    with pytest.raises(SystemExit, match="1 volumes failed"):
        main(["backfill", "--night", "2026-10-16", "--site", "KOKX", "--vp-dir", str(tmp_path), "--out", str(tmp_path / "o.json")])
    assert built == [[dt.date(2026, 10, 16)]]
    monkeypatch.setattr(bn, "backfill_night", lambda site, night, root, workdir, workers: [])   # positive control
    main(["backfill", "--night", "2026-10-16", "--site", "KOKX", "--vp-dir", str(tmp_path), "--out", str(tmp_path / "o.json")])
    assert len(built) == 2

def test_night_bio_gate_share_weights_profiles_by_the_time_they_stand_for():
    t0 = dt.datetime(2026, 10, 17, 1, 0, tzinfo=UTC)
    a = prof(t0, [(0, 10.0, 5.0), (200, 0.0, 5.0)], kept=(50, 50))                     # all echo kept, 5 min
    b = prof(t0 + dt.timedelta(minutes=10), [(0, "nan", 5.0), (200, "nan", 5.0)], kept=(0, 80))  # rain, 10 min
    c = prof(t0 + dt.timedelta(minutes=20), [(0, "nan", 5.0), (200, "nan", 5.0)], kept=(0, 0))   # empty sky
    sunset, sunrise = t0 - dt.timedelta(hours=1), t0 + dt.timedelta(hours=1)
    n = night_total([(t0, a), (t0 + dt.timedelta(minutes=10), b), (t0 + dt.timedelta(minutes=20), c)], sunset, sunrise)
    assert n["bio_gate_share"] == pytest.approx((5 * 1.0 + 10 * 0.0) / 15)            # c has no echo to share
    assert night_total([(t0 + dt.timedelta(minutes=20), c)], sunset, sunrise)["bio_gate_share"] is None
    assert night_total([(t0, a)], sunset, sunrise)["bio_gate_share"] is None     # one profile stands for no time
    assert night_total([], sunset, sunrise)["bio_gate_share"] is None

def test_night_bio_gate_share_tells_the_rain_night_from_the_clear_one():
    """The rain readout (wildeye radar-depth ledger, Q2) on real nights: KOKX 2026-10-16 had rain overnight
    (JFK ASOS 0.10 in), KLOT the same night was dry (ORD); profiles as vol2bird wrote them. Per-scan numbers
    are awk's sum($16)/sum($18) over each file."""
    from pipeline.vol2bird import bio_gate_share, parse_profile
    sites = {s["id"]: s for s in json.loads((FIX.parent.parent / "sites.json").read_text())}
    shares = {}
    for site in ("KOKX", "KLOT"):
        sunset, sunrise = night_window(dt.date(2026, 10, 16), sites[site]["lon"], sites[site]["lat"])
        ps = [(dt.datetime.strptime(f.name[4:19], "%Y%m%d_%H%M%S").replace(tzinfo=UTC), gzip.decompress(f.read_bytes()).decode())
              for f in sorted((FIX / f"vp_{site}_night_20261016").glob("*.txt.gz"))]
        assert len(ps) == {"KOKX": 140, "KLOT": 39}[site]
        shares[site] = night_total(ps, sunset, sunrise)["bio_gate_share"]
        if site == "KOKX":
            per = {t.strftime("%H%M"): bio_gate_share(parse_profile(x)) for t, x in ps}
            assert per["2227"] == pytest.approx(0.474254, abs=1e-6) and per["0115"] == pytest.approx(0.213764, abs=1e-6)
            assert per["0457"] == pytest.approx(0.000013, abs=1e-6)
    assert shares["KOKX"] < 0.25 < 0.6 < shares["KLOT"], shares
