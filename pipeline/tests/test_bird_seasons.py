import datetime as dt
import json
import shutil
from pathlib import Path
from pipeline.bird_nights import night_total, night_window, stored_profiles
from pipeline.bird_seasons import SITES, archive, archive_file, build, load, season_nights, season_of

U = dt.UTC
KLOT_FIX = Path(__file__).parent / "fixtures" / "vp_KLOT_night_20261016"   # 39 real KLOT profiles, 05:50-12:06 UTC 17 Oct
# birds_nights.json as served 2026-10-19 02:49 UTC, KAKQ and KBUF (src/data/fixtures/README.md)
NIGHTS = Path(__file__).parents[2] / "src" / "data" / "fixtures" / "birds_nights_history_20261019.json"

def test_fall_is_aug_1_to_nov_15():
    assert season_of(dt.date(2025, 7, 31)) is None and season_of(dt.date(2025, 8, 1)) == "fall-2025"
    assert season_of(dt.date(2026, 11, 15)) == "fall-2026" and season_of(dt.date(2026, 11, 16)) is None
    n = season_nights("fall-2026")
    assert (n[0], n[-1], len(n)) == (dt.date(2026, 8, 1), dt.date(2026, 11, 15), 107)

def test_archive_freezes_finished_nights_once_and_never_rewrites_them(tmp_path):
    src = json.loads(NIGHTS.read_text())
    now = dt.datetime(2026, 10, 19, 2, 49, 9, tzinfo=U)
    doc = {"seasons": {}}
    added = archive(doc, src, now)
    fall = doc["seasons"]["fall-2026"]
    kakq = {n["night"]: n for n in src["sites"]["KAKQ"]}
    assert fall["KAKQ"]["2026-10-17"] == {k: kakq["2026-10-17"][k] for k in ("mt_birds_km", "bio_gate_share", "coverage")}
    assert "2026-10-18" not in fall["KAKQ"], "tonight is not over"
    # KBUF was not seeded yet: its past nights have no profiles and stay out, its live nights go in
    kbuf = {n["night"]: n for n in src["sites"]["KBUF"]}
    assert sorted(fall["KBUF"]) == sorted(k for k, n in kbuf.items() if n["profiles"] and k < "2026-10-18")
    assert added == len(fall["KAKQ"]) + len(fall["KBUF"]) == 21 + 2
    # sunrise + 6 h: night 10-17 ends ~11:20 UTC on the 18th, so at 17:00 it is not frozen and at 17:30 it is
    sr = dt.datetime.fromisoformat(kakq["2026-10-17"]["sunrise"].replace("Z", "+00:00"))
    early = {"seasons": {}}
    archive(early, src, sr + dt.timedelta(hours=5, minutes=59))
    assert "2026-10-17" not in early["seasons"]["fall-2026"]["KAKQ"] and "2026-10-16" in early["seasons"]["fall-2026"]["KAKQ"]
    on_time = {"seasons": {}}
    archive(on_time, src, sr + dt.timedelta(hours=6))
    assert "2026-10-17" in on_time["seasons"]["fall-2026"]["KAKQ"], "frozen at exactly sunrise + 6 h"
    # append-only: a later file that disagrees changes nothing, and nothing is added twice
    changed = json.loads(NIGHTS.read_text())
    for n in changed["sites"]["KAKQ"]:
        n["mt_birds_km"] = 1.0
    assert archive(doc, changed, now) == 0
    assert fall["KAKQ"]["2026-10-17"]["mt_birds_km"] == kakq["2026-10-17"]["mt_birds_km"]
    # the file round trip keeps it, and an archive with nothing new does not rewrite the file
    path = tmp_path / "birds_seasons.json"
    assert archive_file(path, src, now) == 23
    stamp = path.stat().st_mtime_ns
    assert archive_file(path, src, now + dt.timedelta(hours=1)) == 0 and path.stat().st_mtime_ns == stamp
    assert load(path)["seasons"]["fall-2026"]["KAKQ"]["2026-10-17"] == fall["KAKQ"]["2026-10-17"]
    assert load(path)["windows"] == {"fall": ["08-01", "11-15"]}

def test_build_freezes_a_past_night_from_real_profiles_and_skips_empty_ones(tmp_path):
    day = tmp_path / "vp" / "KLOT" / "20261017"
    day.mkdir(parents=True)
    for f in KLOT_FIX.glob("*.txt.gz"):
        shutil.copy2(f, day / f.name)
    klot = next(s for s in SITES if s["id"] == "KLOT")
    doc = {"seasons": {}}
    added, failures = build(doc, tmp_path / "vp", [klot], "fall-2026", dt.datetime(2026, 10, 18, 12, tzinfo=U))
    assert failures == {} and added == 1
    _, sr = night_window(dt.date(2026, 10, 16), klot["lon"], klot["lat"])
    assert build({"seasons": {}}, tmp_path / "vp", [klot], "fall-2026", sr + dt.timedelta(hours=5)) == (0, {}), \
        "not frozen before sunrise + 6 h"
    sunset, sunrise = night_window(dt.date(2026, 10, 16), klot["lon"], klot["lat"])
    want = night_total(stored_profiles(tmp_path / "vp", "KLOT", sunset, sunrise), sunset, sunrise)
    assert doc["seasons"]["fall-2026"]["KLOT"] == {"2026-10-16": {k: want[k] for k in ("mt_birds_km", "bio_gate_share", "coverage")}}
    assert want["mt_birds_km"] > 0
