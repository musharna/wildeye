import datetime as dt
import json
import shutil
from pathlib import Path
import pytest
from pipeline.bird_nights import night_total, night_window, stored_profiles
from pipeline.sampling_check import (scan_time, night_files, slot_subset, mt, relative_error, nearest_rank, decide,
                                     MIN_NIGHTS)

FIX = Path(__file__).parent / "fixtures" / "vp_KLOT_night_20261016"   # 39 real KLOT profiles, 05:50-12:06 UTC 17 Oct
U = dt.UTC

def store(tmp_path: Path) -> Path:
    day = tmp_path / "KLOT" / "20261017"
    day.mkdir(parents=True)
    for f in FIX.glob("*.txt.gz"):
        shutil.copy2(f, day / f.name)
    return tmp_path

def klot_night():
    sites = {s["id"]: s for s in json.loads((Path(__file__).parent.parent / "sites.json").read_text())}
    return night_window(dt.date(2026, 10, 16), sites["KLOT"]["lon"], sites["KLOT"]["lat"])

def test_every_scan_total_is_the_live_night_total_on_real_profiles(tmp_path):
    root = store(tmp_path)
    sunset, sunrise = klot_night()
    files = night_files(root, "KLOT", sunset, sunrise)
    assert len(files) == 39 and files[0][0] == dt.datetime(2026, 10, 17, 5, 50, 38, tzinfo=U)
    assert mt(files, sunset, sunrise) == night_total(stored_profiles(root, "KLOT", sunset, sunrise), sunset, sunrise)["mt_birds_km"]
    sub = slot_subset(files, sunset, every_min=30)
    assert 0 < len(sub) < len(files) and mt(sub, sunset, sunrise) != mt(files, sunset, sunrise)
    assert night_files(root, "KLOT", sunset, dt.datetime(2026, 10, 17, 5, 50, 37, tzinfo=U)) == []   # window by scan time

def test_slot_subset_keeps_the_first_scan_of_each_slot_from_sunset():
    ss = dt.datetime(2026, 10, 1, 22, 0, tzinfo=U)
    t = [ss + dt.timedelta(minutes=m) for m in (0, 4, 9.99, 10, 14, 25, 41)]
    files = [(x, Path(f"K{i}")) for i, x in enumerate(t)][::-1]          # unsorted on purpose
    assert [p.name for _, p in slot_subset(files, ss)] == ["K0", "K3", "K5", "K6"]   # slots 0, 1, 2, 4

def test_scan_time_relative_error_and_nearest_rank():
    assert scan_time("KLOT20261017_055038_V06.txt.gz") == dt.datetime(2026, 10, 17, 5, 50, 38, tzinfo=U)
    with pytest.raises(ValueError, match="no scan time"):
        scan_time("notes.txt")
    assert relative_error(110.0, 100.0) == pytest.approx(0.1) and relative_error(90.0, 100.0) == pytest.approx(-0.1)
    assert relative_error(5.0, 0.0) is None and relative_error(None, 1.0) is None and relative_error(1.0, None) is None
    assert relative_error(1.0, -1.0) is None                                   # a total is never negative; refuse one
    assert nearest_rank([float(i) for i in range(1, 11)], 0.9) == 9.0          # ceil(9.0) = 9th of 10
    assert nearest_rank([float(i) for i in range(1, 21)], 0.9) == 18.0
    assert nearest_rank([float(i) for i in range(1, 12)], 0.9) == 10.0         # ceil(9.9) = 10th of 11
    with pytest.raises(ValueError, match="no values"):
        nearest_rank([], 0.9)

def test_decide_fits_q_on_early_nights_and_ships_only_at_the_bar():
    fit = [{"night": "2026-10-01", "r": x / 100} for x in range(1, 11)] + [{"night": "2026-10-02", "r": None}]
    q = 0.09
    def held(n_in, n_out):
        return [{"night": "2026-10-10", "r": -0.05}] * n_in + [{"night": "2026-10-10", "r": 0.5}] * n_out
    d = decide(fit + held(34, 6), "2026-10-07")
    assert d["q"] == q and d["fit_nights"] == 10 and d["held_out_nights"] == 40 and d["held_out_inside"] == 0.85
    assert d["ships"] is True                                                  # exactly 85 % of 40
    assert decide(fit + held(33, 7), "2026-10-07")["ships"] is False           # 82.5 %
    assert decide(fit + held(39, 0), "2026-10-07")["ships"] is False and MIN_NIGHTS == 40   # 39 nights
    assert decide(fit + [{"night": "2026-10-10", "r": -q}] * 40, "2026-10-07")["ships"] is True   # |r| = q is inside
