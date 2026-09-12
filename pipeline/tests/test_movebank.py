import datetime as dt
from pipeline.movebank import is_licence_page, fetch_csv, fetch_events, process_study

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
    feats, st = process_study(src, {"id": 481458, "common": {"Cathartes aura": "turkey vulture"}}, _fetch_factory("CC_BY"), now=now)
    assert st["individuals"] == 2 and st["dropped_individuals"] == 1 and st["segments"] == 1
    # a taxon with no common-name mapping falls back to the study default, then to the canonical name
    f3, _ = process_study(src, {"id": 481458, "default_species": "vulture"}, _fetch_factory("CC_BY"), now=now)
    assert f3[0]["properties"]["species"] == "vulture"
    f4, _ = process_study(src, {"id": 481458}, _fetch_factory("CC_BY"), now=now)
    assert f4[0]["properties"]["species"] == "Cathartes aura"
    p = feats[0]["properties"]
    assert p["dataset"] == "mb:481458:Julie" and p["species"] == "turkey vulture" and p["sci"] == "Cathartes aura"
    assert p["license"] == "CC BY 4.0" and p["citation"] == "Cite V" and p["n"] == 8
    # the licence is read live: a listed study that turned CC_BY_NC yields nothing
    feats2, st2 = process_study(src, {"id": 481458}, _fetch_factory("CC_BY_NC"), now=now)
    assert feats2 == [] and "CC_BY_NC" in st2["dropped"]
