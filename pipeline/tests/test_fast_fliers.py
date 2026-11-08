import datetime as dt
import json

import pytest

from pipeline import fast_fliers as ff
from pipeline.tests.test_insect_check import COL, HOUR, T, profile

# COL: a 10 m/s wind from the west (u = 10, v = 0) at every height. A bird's air vector = ground - wind.
WIND = lambda t: COL if ff.ic.nearest_hour(t) == HOUR else None


def ground(air_south: float) -> tuple[float, float]:
    """Ground velocity of a bird flying `air_south` m/s due south through COL's wind."""
    return 10.0, -air_south


def test_planted_airspeeds_land_in_their_class_and_a_heading_flip_changes_nothing():
    rows = [
        (200, *ground(18.0), 10.0),
        (400, *ground(9.0), 20.0),
        (600, *ground(13.0), 30.0),
        (800, *ground(2.0), 40.0),
    ]
    d = ff.class_density([(T, profile(rows))], WIND)
    assert (d["fast"], d["slow"], d["mid"], d["insect"]) == (10.0, 20.0, 30.0, 40.0)
    flipped = [
        (h, 10.0 - (u - 10.0), -v, dens) for h, u, v, dens in rows
    ]  # same airspeed, opposite heading
    assert ff.class_density([(T, profile(flipped))], WIND) == d


def test_a_planted_30_percent_fast_night_reads_030_and_a_night_with_none_reads_exactly_0():
    planted = profile([(200, *ground(18.0), 30.0), (400, *ground(9.0), 70.0)])
    assert ff.share(ff.class_density([(T, planted)], WIND), "fast") == pytest.approx(
        0.30, abs=0.01
    )
    none = profile([(200, *ground(9.0), 30.0), (400, *ground(11.0), 70.0)])
    assert ff.share(ff.class_density([(T, none)], WIND), "fast") == 0.0


def test_class_edges_follow_the_rules():
    assert [ff.klass(a) for a in (4.99, 5.0, 11.99, 12.0, 14.99, 15.0, 23.0)] == [
        "insect",
        "slow",
        "slow",
        "mid",
        "mid",
        "fast",
        "fast",
    ]


def test_bins_without_a_wind_are_counted_not_classed():
    p = profile([(200, *ground(18.0), 30.0)])
    d = ff.class_density([(T, p)], lambda t: None)
    assert (
        d["no_wind"] == 30.0
        and all(d[c] == 0.0 for c in ff.CLASSES)
        and d["profiles_used"] == 0
    )
    assert ff.share(d, "fast") is None
    assert (
        ff.class_density([(T, p)], WIND)["fast"] == 30.0
    )  # the same bin with a wind is classed


def test_weighted_median_day_is_where_half_the_passage_has_gone():
    s = {"2025-09-01": 10.0, "2025-09-10": 10.0, "2025-10-01": 30.0, "2025-10-05": 0.0}
    assert ff.weighted_median_day(s) == dt.date(2025, 10, 1)
    assert ff.weighted_median_day({"2025-09-01": 0.0}) is None


def dens(fast=0.0, slow=0.0, mid=0.0, insect=0.0):
    return {
        "fast": fast,
        "slow": slow,
        "mid": mid,
        "insect": insect,
        "no_wind": 0.0,
        "profiles_used": 1,
    }


def test_m1_counts_radars_whose_season_fast_share_reaches_two_percent():
    radars = {f"K{i:03d}": {"2025-09-01": dens(fast=3.0, slow=97.0)} for i in range(14)}
    radars |= {f"L{i:03d}": {"2025-09-01": dens(fast=1.0, slow=99.0)} for i in range(6)}
    assert ff.m1(radars)["radars_passing"] == 14 and ff.m1(radars)["passes"]
    radars["K000"]["2025-09-01"] = dens(fast=1.9, slow=98.1)
    assert not ff.m1(radars)["passes"]


def season(fast_day: str, slow_day: str):
    return {fast_day: dens(fast=50.0, slow=50.0), slow_day: dens(fast=0.0, slow=100.0)}


def test_m2_needs_fast_a_week_later_and_the_slow_control_in_the_songbird_window():
    # fast passage all on Oct 25 (half of that night is fast), slow mostly on Sep 25
    radars = {f"K{i:03d}": season("2025-10-25", "2025-09-25") for i in range(14)}
    mt = {sid: {"2025-10-25": 100.0, "2025-09-25": 100.0} for sid in radars}
    r = ff.m2(radars, 2025, mt)
    assert r["radars_later"] == 14 and r["slow_control_radars"] == 14 and r["passes"]
    k = r["per_radar"]["K000"]
    assert k["fast"] == "2025-10-25" and k["lag_days"] == 30
    # the control: slow peaking in August is not songbirds, so the gate fails even though fast is later
    late = {sid: season("2025-10-25", "2025-08-05") for sid in radars}
    mt2 = {sid: {"2025-10-25": 100.0, "2025-08-05": 300.0} for sid in radars}
    assert not ff.m2(late, 2025, mt2)["passes"]


def test_m3_agreeing_engines_pass_and_a_doubled_fast_share_fails_the_ratio():
    nights = {
        f"2025-09-{d:02d}": (dens(fast=f, slow=100 - f), dens(fast=f, slow=100 - f))
        for d, f in zip(range(1, 8), (1, 3, 2, 8, 5, 9, 4))
    }
    assert ff.m3({"KOKX": nights})["passes"]
    off = {
        n: (a, dens(fast=min(99.0, a["fast"] * 3), slow=100 - min(99.0, a["fast"] * 3)))
        for n, (a, _) in nights.items()
    }
    r = ff.m3({"KOKX": off})
    assert r["median_rho"] == pytest.approx(1.0) and r["ratio"] > 2 and not r["passes"]


def test_m4_same_year_must_beat_the_wrong_year():
    weeks = [dt.date(2025, 8, 4) + dt.timedelta(weeks=k) for k in range(8)]
    duck = {
        f"W{w.isocalendar()[1]:02d}": s for w, s in zip(weeks, (1, 4, 2, 6, 3, 8, 5, 7))
    }
    same = {
        w.isoformat(): dens(fast=s, slow=100 - s)
        for w, s in zip(weeks, (1, 4, 2, 6, 3, 8, 5, 7))
    }
    wrong = {
        (w + dt.timedelta(days=364)).isoformat(): dens(fast=s, slow=100 - s)
        for w, s in zip(weeks, (8, 7, 6, 5, 4, 3, 2, 1))
    }
    sids = [f"K{i:03d}" for i in range(15)]
    r = ff.m4(
        {s: duck for s in sids}, {s: same for s in sids}, {s: wrong for s in sids}
    )
    assert r["radars_same_beats_wrong"] == 15 and r["passes"]
    assert r["per_radar"]["K000"]["same"] == pytest.approx(1.0)
    r = ff.m4(
        {s: duck for s in sids}, {s: wrong for s in sids}, {s: same for s in sids}
    )  # arms swapped
    assert r["radars_same_beats_wrong"] == 0 and not r["passes"]
    r = ff.m4(
        {s: duck for s in sids}, {s: same for s in sids}, {s: same for s in sids}
    )  # a tie is not a win: two identical years cannot tell this year's ducks from the calendar
    assert r["per_radar"]["K000"]["same"] == r["per_radar"]["K000"]["wrong"]
    assert r["radars_same_beats_wrong"] == 0 and not r["passes"]


def test_raob_column_reads_direction_from_and_knots_and_skips_rows_without_height():
    rows = [
        {"hght": 100, "drct": 270, "sknt": 10 / 0.514444},
        {"hght": None, "drct": 0, "sknt": 5},
        {"hght": 1500, "drct": 180, "sknt": 20 / 0.514444},
    ]
    c = ff.raob_column(rows)
    assert c["hgt"] == [100.0, 1500.0]
    assert c["u"][0] == pytest.approx(10.0) and c["v"][0] == pytest.approx(
        0.0, abs=1e-9
    )  # from the west
    assert c["v"][1] == pytest.approx(20.0) and c["u"][1] == pytest.approx(
        0.0, abs=1e-9
    )  # from the south
    assert ff.raob_column(rows[:2]) is None


def test_near_stations_takes_the_nearest_within_50_km_only():
    sites = {"KOKX": {"lat": 40.8656, "lon": -72.8639}}
    feats = [
        {"geometry": {"coordinates": [-72.86, 40.87]}, "properties": {"sid": "OKX"}},
        {
            "geometry": {"coordinates": [-72.6, 40.9]},
            "properties": {"sid": "FAR"},
        },  # ~22 km
        {
            "geometry": {"coordinates": [-72.0, 41.3]},
            "properties": {"sid": "OUT85"},
        },  # ~85 km, beyond 50
        {"geometry": {"coordinates": [-75.0, 40.0]}, "properties": {"sid": "OUT"}},
    ]
    assert [c["station"] for c in ff.near_stations(sites, feats)["KOKX"]] == [
        "OKX",
        "FAR",
    ]
    assert ff.near_stations(sites, feats[2:]) == {}


def test_pick_station_passes_over_a_station_with_no_launches_and_says_why(
    tmp_path, monkeypatch
):
    head = b"station,validUTC,levelcode,pressure_mb,height_m,tmpc,dwpc,drct,speed_kts\n"
    row = b"KIAD,2025-10-01 00:00:00,4,1000.0,150.0,1,1,85.0,7\n"
    monkeypatch.setattr(
        ff.ic, "_get", lambda url: head + (row if "KIAD" in url else b"")
    )
    monkeypatch.setattr(ff.time, "sleep", lambda s: None)
    ff._SONDES.clear()
    pick, skipped = ff.pick_station(
        [{"station": "KNEL", "km": 13.2}, {"station": "KIAD", "km": 40.0}],
        [2025],
        tmp_path,
    )
    assert pick == {"station": "KIAD", "km": 40.0}
    assert [s["station"] for s in skipped] == ["KNEL"] and "no launches" in skipped[0][
        "why"
    ]
    pick, skipped = ff.pick_station([{"station": "KNEL", "km": 13.2}], [2025], tmp_path)
    assert pick is None and len(skipped) == 1
    monkeypatch.setattr(
        ff.ic, "_get", lambda url: b"station,validUTC\n"
    )  # a broken answer is not "no launches"
    ff._SONDES.clear()
    with pytest.raises(ValueError, match="header lacks"):
        ff.pick_station([{"station": "KXXX", "km": 1.0}], [2024], tmp_path)
    ff._SONDES.clear()


def test_duck_share_asks_gbif_for_ebird_inside_150_km_and_a_countless_answer_raises():
    asked = []

    def get(url):
        asked.append(url)
        return json.dumps({"count": 50 if "familyKey" in url else 1000}).encode()

    r = ff.duck_share(
        {"lat": 40.0, "lon": -73.0},
        dt.date(2025, 9, 1),
        dt.date(2025, 9, 7),
        get=get,
        sleep=0,
    )
    assert r == {"aves": 1000, "anatidae": 50, "share": 0.05}
    assert all(
        "datasetKey=4fa7b334-ce0d-4e88-aaae-2e0c138d049e" in u
        and "150km" in u
        and "limit=0" in u
        for u in asked
    )
    assert "classKey=212" in asked[0] and "familyKey=2986" in asked[1]
    with pytest.raises(ValueError, match="without a count"):
        ff.gbif_count({"x": 1}, get=lambda url: b'{"results": []}')


def test_iso_weeks_cover_the_season_once():
    ws = ff.iso_weeks(2025)
    days = sum((b - a).days + 1 for _, a, b in ws)
    assert days == len(ff.season_nights(2025)) == 107
    assert ws[0][1] == dt.date(2025, 8, 1) and ws[-1][2] == dt.date(2025, 11, 15)


def test_verdict_is_fired_only_when_every_gate_passes():
    assert ff.verdict({"M0": {"passes": True}, "M1": {"passes": True}}) == "FIRED"
    assert ff.verdict({"M0": {"passes": True}, "M1": {"passes": False}}) == "VOID"


def test_raob_csv_groups_levels_by_launch_reads_m_as_missing_and_refuses_a_header_without_wind():
    text = (
        "station,validUTC,levelcode,pressure_mb,height_m,tmpc,dwpc,drct,speed_kts,bearing,range_sm\n"
        "KOKX,2025-10-01 00:00:00,4,1000.0,150.0,20.8,13.8,85.0,7,M,M\n"
        "KOKX,2025-10-01 00:00:00,4,1002.0,132.47,20.8,13.8,M,M,M,M\n"
        "KOKX,2025-10-01 12:00:00,4,925.0,800.0,15.0,10.0,270.0,20,M,M\n"
    )
    got = ff.parse_raob_csv(text)
    t0 = dt.datetime(2025, 10, 1, 0, tzinfo=dt.UTC)
    assert sorted(got) == [t0, dt.datetime(2025, 10, 1, 12, tzinfo=dt.UTC)]
    assert got[t0][0] == {"pres": 1000.0, "hght": 150.0, "drct": 85.0, "sknt": 7.0}
    assert got[t0][1]["drct"] is None and got[t0][1]["sknt"] is None
    assert ff.raob_column(got[t0]) is None  # one level with wind is not a column
    assert (
        ff.ic.raob_uv(got[t0], 1000.0) is not None
    )  # the M0 reader takes these rows as they are
    with pytest.raises(ValueError, match="header lacks"):
        ff.parse_raob_csv(
            "station,validUTC,pressure_mb,height_m\nKOKX,2025-10-01 00:00:00,1000,150\n"
        )


def test_merged_area_ids_are_skipped_for_the_real_station_and_an_empty_season_raises(
    tmp_path, monkeypatch
):
    sites = {"KJAX": {"lat": 30.4847, "lon": -81.7019}}
    feats = [
        {"geometry": {"coordinates": [-81.70, 30.48]}, "properties": {"sid": "_JAX"}},
        {"geometry": {"coordinates": [-81.68, 30.50]}, "properties": {"sid": "KJAX"}},
    ]
    assert [c["station"] for c in ff.near_stations(sites, feats)["KJAX"]] == ["KJAX"]
    head = b"station,validUTC,levelcode,pressure_mb,height_m,tmpc,dwpc,drct,speed_kts\n"
    monkeypatch.setattr(ff.ic, "_get", lambda url: head)
    monkeypatch.setattr(ff.time, "sleep", lambda s: None)
    ff._SONDES.clear()
    with pytest.raises(ValueError, match="no launches for KZZZ"):
        ff.sondes("KZZZ", [2025], tmp_path)
    monkeypatch.setattr(
        ff.ic,
        "_get",
        lambda url: head + b"KOKX,2025-10-01 00:00:00,4,1000.0,150.0,1,1,85.0,7\n",
    )
    assert len(ff.sondes("KOKX", [2025], tmp_path)) == 1
    ff._SONDES.clear()


def test_the_run_refuses_a_season_whose_last_night_has_not_ended():
    end = dt.datetime(2026, 11, 16, 11, 30, tzinfo=dt.UTC)
    windows = {("KOKX", dt.date(2026, 11, 15)): (end - dt.timedelta(hours=13), end),
               ("KOKX", dt.date(2026, 8, 1)): (dt.datetime(2026, 8, 1, 0, tzinfo=dt.UTC), dt.datetime(2026, 8, 1, 10, tzinfo=dt.UTC))}
    with pytest.raises(SystemExit, match="not over: its last night ends 2026-11-16 11:30 UTC; run after 2026-11-16 14:30"):
        ff.season_over(windows, dt.datetime(2026, 11, 8, 6, tzinfo=dt.UTC))
    with pytest.raises(SystemExit, match="not over"):
        ff.season_over(windows, end + dt.timedelta(hours=2))  # inside the RAP lag
    assert ff.season_over(windows, end + dt.timedelta(hours=3, minutes=1)) is None  # over: the run goes ahead
