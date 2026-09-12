import datetime as dt
import json
from pipeline.whispers import fetch_events, normalise, county_index, to_features, main

SQ = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}


def ev(id, start, fips=("06027",), species=("Burrowing Owl",), diag=(("Pending", False),), affected=1, end=None):
    return {"id": id, "start_date": start, "end_date": end, "event_type_string": "Mortality/Morbidity", "affected_count": affected, "complete": False,
            "administrativeleveltwos": [{"fips_code": f, "name": "X"} for f in fips], "species": [{"name": s} for s in species],
            "eventdiagnoses": [{"diagnosis_string": d, "suspect": s} for d, s in diag]}


def test_fetch_events_pages_newest_first_skips_undated_and_stops_at_window_edge():
    pages = {1: {"next": "p2", "results": [ev(1, None), ev(2, "2026-09-04"), ev(3, "2026-08-01")]},
             2: {"next": None, "results": [ev(4, "2026-07-01"), ev(5, "2026-01-01"), ev(6, "2026-06-01")]}}
    calls = []
    def fetch(url, timeout=120):
        calls.append(url); page = int(url.rsplit("page=", 1)[1]); return pages[page]
    import pipeline.whispers as m
    out = fetch_events(dt.date(2026, 6, 15), fetch, sleep=0)
    assert [e["id"] for e in out] == [2, 3, 4], "undated skipped; stopped at the first row older than the window"
    assert len(calls) == 2 and "ordering=-start_date" in calls[0] and "page_size=500" in calls[0]


def test_normalise_needs_county_and_date_and_marks_suspect_diagnoses():
    n = normalise(ev(7, "2026-09-01", fips=("06027", "6029"), diag=(("HPAI", True), ("HPAI", True), ("Trauma", False)), affected=12))
    assert n["fips"] == ["06027", "06029"] and n["diagnoses"] == ["HPAI (suspect)", "Trauma"] and n["affected"] == 12 and n["end"] == "2026-09-01"
    assert normalise(ev(8, "2026-09-01", fips=())) is None and normalise(ev(9, None)) is None
    assert normalise(ev(10, "2026-09-01", diag=(("Exposure suspect", True),)))["diagnoses"] == ["Exposure suspect"], "no double suspect"


def test_county_index_bins_weeks_counts_multi_county_events_in_each_with_positive_control():
    events = [normalise(ev(1, "2026-09-10", species=("Canada Goose",), affected=40)),
              normalise(ev(2, "2026-09-03", fips=("06027", "06029"), species=("Bald Eagle",), affected=2)),
              normalise(ev(3, "2026-01-01"))]
    idx, c = county_index(events, dt.date(2026, 9, 12), weeks=4)
    assert c == {"in_window": 2, "outside_window": 1, "counties": 2}
    a = idx["06027"]
    assert a["n"] == 2 and a["affected"] == 42 and a["species"] == {"Canada Goose": 1, "Bald Eagle": 1}
    assert a["weeks"] == [{"w": "2026-09-12", "n": 1, "affected": 40, "sp": {"Canada Goose": 1}}, {"w": "2026-09-05", "n": 1, "affected": 2, "sp": {"Bald Eagle": 1}}]
    assert idx["06029"]["n"] == 1 and idx["06029"]["events"][0]["id"] == 2, "multi-county event counted in each county"
    assert a["events"][0]["id"] == 1, "events newest first"
    feats, missing = to_features(idx, {"06027": {"name": "Inyo", "st": "CA", "geometry": SQ}})
    assert [f["properties"]["fips"] for f in feats] == ["06027"] and missing == ["06029"]


def test_main_end_to_end(tmp_path, monkeypatch):
    import pipeline.whispers as m
    monkeypatch.setattr(m, "fetch_events", lambda since, fetch=None, max_pages=20, sleep=1.0: [ev(1, "2026-09-10", affected=3)])
    monkeypatch.setattr(m, "load_county_shapes", lambda zip_path, wanted, fetch_bytes=None: {"06027": {"name": "Inyo", "st": "CA", "geometry": SQ}})
    out = tmp_path / "w.geojson"
    main(["--out", str(out), "--weeks", "4", "--today", "2026-09-12", "--cache", str(tmp_path)])
    gj = json.loads(out.read_text())
    assert gj["newest"] == "2026-09-10" and gj["counts"]["events"] == 1 and len(gj["features"]) == 1 and "Public Domain" in gj["source"]["licence"]
