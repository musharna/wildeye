import datetime as dt
import inspect
import pytest
from pipeline.movebank import is_licence_page, fetch_csv, fetch_events, process_study, study_window, _get_text

H = 3600


def test_licence_handshake_once_then_refuse(monkeypatch):
    calls = []

    def html_then_csv(url):
        calls.append(url)
        return "<html>License Terms</html>" if "license-md5" not in url else "a,b\n1,2\n"

    assert fetch_csv({"entity_type": "study"}, html_then_csv) == [{"a": "1", "b": "2"}]
    assert len(calls) == 2 and "license-md5=" in calls[1]
    # positive control: plain CSV needs one call
    calls.clear()
    assert fetch_csv({"entity_type": "study"}, lambda u: (calls.append(u), "x\n9\n")[1]) == [{"x": "9"}] and len(calls) == 1
    # a licence page that persists is an error, never parsed as data
    try:
        fetch_csv({"entity_type": "study"}, lambda u: "<html>License Terms</html>")
        assert False
    except RuntimeError as e:
        assert "licence page" in str(e)
    assert is_licence_page("  <!DOCTYPE html>") and not is_licence_page("individual_local_identifier,timestamp")


def test_fetch_events_filters_invisible_and_bad_rows():
    body = ("individual_local_identifier,timestamp,location_long,location_lat,visible\n"
            "Julie,2026-09-01 00:00:00.000,-112.1,32.7,true\n"
            "Julie,2026-09-01 01:00:00.000,,,true\n"
            "Julie,2026-09-01 02:00:00.000,-112.2,32.8,false\n"
            "Julie,2026-09-01 03:00:00.000,-500,32.8,true\n")
    seen = {}
    fixes = fetch_events(481458, dt.datetime(2026, 9, 1, tzinfo=dt.UTC), lambda u: seen.setdefault("u", u) and body)
    assert len(fixes) == 1 and fixes[0]["animal"] == "Julie" and fixes[0]["lon"] == -112.1
    assert "timestamp_start=20260901000000000" in seen["u"] and "sensor_type_id=653" in seen["u"]


def _fetch_factory(license_type):
    def fetch(url):
        if "entity_type=study" in url:
            return f"id,name,citation,license_type,license_terms,principal_investigator_name\n481458,Vultures,Cite V,{license_type},,PI\n"
        if "entity_type=individual" in url:
            return "local_identifier,taxon_canonical_name\nJulie,Cathartes aura\nBob,Coragyps atratus\n"
        rows = ["individual_local_identifier,timestamp,location_long,location_lat,visible"]
        for i in range(8):
            rows.append(f"Julie,2026-08-0{1 + i // 4} {i % 4 * 6:02d}:00:00.000,-112.{i},32.7,true")
        rows.append("Bob,2026-08-01 00:00:00.000,-110.0,31.0,true")  # too few fixes
        return "\n".join(rows) + "\n"
    return fetch


def test_process_study_builds_per_individual_tracks_and_refuses_non_cc():
    src = {"id": "movebank", "name": "Movebank", "days": 60, "min_fixes": 5, "min_gap_s": H, "segment_gap_h": 24, "max_speed_ms": 50, "min_age_days": 7}
    now = dt.datetime(2026, 9, 1, tzinfo=dt.UTC).timestamp()
    feats, st = process_study(src, {"id": 481458, "days": 60, "common": {"Cathartes aura": "turkey vulture"}}, _fetch_factory("CC_BY"), now=now)
    assert st["individuals"] == 2 and st["dropped_individuals"] == 1 and st["segments"] == 1
    # a taxon with no common-name mapping falls back to the study default, then to the canonical name
    f3, _ = process_study(src, {"id": 481458, "days": 60, "default_species": "vulture"}, _fetch_factory("CC_BY"), now=now)
    assert f3[0]["properties"]["species"] == "vulture"
    f4, _ = process_study(src, {"id": 481458, "days": 60}, _fetch_factory("CC_BY"), now=now)
    assert f4[0]["properties"]["species"] == "Cathartes aura"
    p = feats[0]["properties"]
    assert p["dataset"] == "mb:481458:Julie" and p["species"] == "turkey vulture" and p["sci"] == "Cathartes aura"
    assert p["license"] == "CC BY 4.0" and p["citation"] == "Cite V" and p["n"] == 8
    # the licence is read live: a listed study that turned CC_BY_NC yields nothing
    feats2, st2 = process_study(src, {"id": 481458, "days": 60}, _fetch_factory("CC_BY_NC"), now=now)
    assert feats2 == [] and "CC_BY_NC" in st2["dropped"]


NOW = dt.datetime(2026, 9, 1, tzinfo=dt.UTC).timestamp()
SRC = {"id": "movebank", "name": "Movebank", "min_fixes": 5, "min_gap_s": H, "segment_gap_h": 24,
       "max_speed_ms": 50, "min_age_days": 7, "max_individuals": 12}


def test_study_window_is_exactly_one_of_days_or_start_end_and_at_most_a_year():
    # positive controls: each legal form
    s, e = study_window({"id": 1, "days": 60}, NOW)
    assert s == dt.datetime(2026, 7, 3, tzinfo=dt.UTC) and e is None
    s, e = study_window({"id": 1, "start": "2014-12-01", "end": "2015-12-01"}, NOW)
    assert (s, e) == (dt.datetime(2014, 12, 1, tzinfo=dt.UTC), dt.datetime(2015, 12, 1, tzinfo=dt.UTC))
    for bad, why in [({"id": 1}, "exactly one"), ({"id": 1, "days": 60, "start": "2014-12-01", "end": "2015-12-01"}, "exactly one"),
                     ({"id": 1, "start": "2014-12-01"}, "exactly one"), ({"id": 1, "start": "2015-12-01", "end": "2014-12-01"}, "before"),
                     ({"id": 1, "start": "2014-01-01", "end": "2015-12-01"}, "366"), ({"id": 1, "days": 400}, "366")]:
        with pytest.raises(ValueError, match=why):
            study_window(bad, NOW)


def test_fetch_events_pushes_the_end_bound_only_when_given():
    seen = []
    body = "individual_local_identifier,timestamp,location_long,location_lat,visible\n"
    fetch_events(1, dt.datetime(2014, 12, 1, tzinfo=dt.UTC), lambda u: (seen.append(u), body)[1], end=dt.datetime(2015, 12, 1, tzinfo=dt.UTC))
    fetch_events(1, dt.datetime(2014, 12, 1, tzinfo=dt.UTC), lambda u: (seen.append(u), body)[1])
    assert "timestamp_start=20141201000000000" in seen[0] and "timestamp_end=20151201000000000" in seen[0]
    assert "timestamp_end" not in seen[1]


def _study_fetch(animals: dict[str, str], fixes: dict[str, int], extra_rows=()):
    """animals: local id → taxon; fixes: local id → number of 2-hourly fixes ending 10 days before NOW."""
    def fetch(url):
        if "entity_type=study" in url:
            return "id,name,citation,license_type,license_terms,principal_investigator_name\n9,S,Cite,CC_0,,PI\n"
        if "entity_type=individual" in url:
            return "local_identifier,taxon_canonical_name\n" + "".join(f"{a},{t}\n" for a, t in animals.items())
        rows = ["individual_local_identifier,timestamp,location_long,location_lat,visible"]
        for a, n in fixes.items():
            for i in range(n):
                t = dt.datetime.fromtimestamp(NOW - 10 * 86400 - (n - i) * 2 * H, dt.UTC)
                rows.append(f"{a},{t:%Y-%m-%d %H:%M:%S}.000,{10 + i * 0.001},{20 + i * 0.001},true")
        rows += list(extra_rows)
        return "\n".join(rows) + "\n"
    return fetch


def test_humans_are_refused_and_counted_other_animals_kept():
    fetch = _study_fetch({"Ann": "Homo sapiens", "Bo": "Ciconia ciconia"}, {"Ann": 10, "Bo": 10})
    feats, st = process_study(SRC, {"id": 9, "days": 60, "group": "birds"}, fetch, now=NOW)
    assert st["refused_human"] == 1
    assert {f["properties"]["animal"] for f in feats} == {"Bo"}, "positive control: the stork is kept"
    assert all(f["properties"]["group"] == "birds" for f in feats)


def test_fixes_after_run_time_are_dropped_and_counted():
    future = [f"Bo,{dt.datetime.fromtimestamp(NOW + 86400 * 365, dt.UTC):%Y-%m-%d %H:%M:%S}.000,11,21,true"]
    fetch = _study_fetch({"Bo": "Ciconia ciconia"}, {"Bo": 10}, future)
    feats, st = process_study(SRC, {"id": 9, "days": 60, "group": "birds"}, fetch, now=NOW)
    assert st["future_dropped"] == 1
    assert st["kept"] == 10 and max(t for f in feats for t in f["properties"]["times"]) < "2026-09-01"


def test_at_most_max_individuals_kept_by_most_fixes_deterministically():
    animals = {f"a{i:02d}": "Panthera leo" for i in range(14)}
    counts = {f"a{i:02d}": 6 + i for i in range(14)}  # a00 and a01 have the fewest fixes
    counts["a13"] = counts["a12"]  # tie → broken by id
    feats, st = process_study(SRC, {"id": 9, "days": 60, "group": "land mammals"}, _study_fetch(animals, counts), now=NOW)
    kept = sorted({f["properties"]["animal"] for f in feats})
    assert kept == [f"a{i:02d}" for i in range(2, 14)] and st["capped_individuals"] == 2
    # positive control: under the cap nothing is capped
    _, st2 = process_study(SRC | {"max_individuals": 20}, {"id": 9, "days": 60, "group": "land mammals"}, _study_fetch(animals, counts), now=NOW)
    assert st2["capped_individuals"] == 0


def test_per_study_min_gap_overrides_the_source():
    fetch = _study_fetch({"Bo": "Ciconia ciconia"}, {"Bo": 24})  # 2-hourly for 48 h
    _, st = process_study(SRC, {"id": 9, "days": 60, "group": "birds"}, fetch, now=NOW)
    _, st12 = process_study(SRC, {"id": 9, "days": 60, "group": "birds", "min_gap_s": 12 * H}, fetch, now=NOW)
    assert st["kept"] == 24 and st12["kept"] == 5  # 0,12,24,36 h + last fix


def test_archival_window_bounds_the_request():
    seen = []
    base = _study_fetch({"Bo": "Ciconia ciconia"}, {"Bo": 10})
    process_study(SRC, {"id": 9, "start": "2014-12-01", "end": "2015-12-01", "group": "birds"}, lambda u: (seen.append(u), base(u))[1], now=NOW)
    ev = [u for u in seen if "entity_type=event" in u][0]
    assert "timestamp_start=20141201000000000" in ev and "timestamp_end=20151201000000000" in ev


def test_read_timeout_is_120_s():
    assert inspect.signature(_get_text).parameters["timeout"].default == 120
