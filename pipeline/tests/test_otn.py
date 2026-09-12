import datetime as dt
import json
import urllib.error

from pipeline.otn import (
    species_index,
    week_ends,
    aggregate,
    fetch_detections,
    DET_COLS,
    PROJ_COLS,
    main,
)


def det(t, tx, lat=44.0, lon=-63.0, station="S1", proj="P"):
    return {
        "time": t,
        "latitude": lat,
        "longitude": lon,
        "detection_transmittername": tx,
        "platform_name": station,
        "project_reference": proj,
    }


SPECIES = {
    "A69-1": ("striped bass", "Morone saxatilis"),
    "A69-2": ("atlantic cod", "Gadus morhua"),
}


def test_species_index_first_nonempty_name_wins_and_blank_rows_are_skipped():
    rel = [
        {
            "transmittername": "A69-1",
            "vernacularname": "Striped bass",
            "scientificname": "Morone saxatilis",
            "project_reference": "P",
        },
        {
            "transmittername": "A69-1",
            "vernacularname": "other",
            "scientificname": "X",
            "project_reference": "Q",
        },
        {
            "transmittername": "",
            "vernacularname": "ghost",
            "scientificname": "",
            "project_reference": "P",
        },
        {
            "transmittername": "A69-3",
            "vernacularname": "",
            "scientificname": "",
            "project_reference": "P",
        },
        {
            "transmittername": "A69-4",
            "vernacularname": "",
            "scientificname": "Salmo salar",
            "project_reference": "P",
        },
    ]
    idx = species_index(rel)
    assert idx == {
        "A69-1": ("striped bass", "Morone saxatilis"),
        "A69-4": ("Salmo salar", "Salmo salar"),
    }


def test_week_ends_newest_first():
    assert week_ends(dt.date(2025, 7, 30), 3) == [
        dt.date(2025, 7, 30),
        dt.date(2025, 7, 23),
        dt.date(2025, 7, 16),
    ]


def test_aggregate_bins_by_week_joins_species_and_drops_unjoined_with_positive_control():
    rows = [
        det("2025-07-30T03:00:00Z", "A69-1"),  # newest → week 0
        det("2025-07-24T00:00:00Z", "A69-1"),  # 6 days earlier → week 0
        det("2025-07-23T23:00:00Z", "A69-2"),  # 7 days earlier → week 1
        det("2025-07-23T23:00:00Z", "A69-2", station="S2", lat=45.0),  # other station
        det("2025-07-01T00:00:00Z", "A69-1"),  # outside a 2-week window
        det("2025-07-30T00:00:00Z", "UNKNOWN"),  # no public release → dropped
    ]
    feats, counts = aggregate(rows, SPECIES, weeks=2)
    assert (
        counts["unjoined"] == 1
        and counts["joined"] == 5
        and counts["outside_window"] == 1
    )
    assert (
        counts["data_end"] == "2025-07-30"
        and counts["stations"] == 2
        and counts["species"] == 2
    )
    s1 = next(f for f in feats if f["properties"]["station"] == "S1")
    assert s1["properties"]["species"] == {"striped bass": 2, "atlantic cod": 1}
    assert s1["properties"]["weeks"] == [
        {"w": "2025-07-30", "n": {"striped bass": 2}, "a": 1},
        {"w": "2025-07-23", "n": {"atlantic cod": 1}, "a": 1},
    ]
    assert s1["properties"]["animals"] == 2 and s1["properties"]["n"] == 3
    assert s1["geometry"]["coordinates"] == [-63.0, 44.0]
    # positive control: nothing unjoined when every transmitter is public
    _, c2 = aggregate(rows[:1], SPECIES, weeks=2)
    assert c2["unjoined"] == 0 and c2["joined"] == 1
    # mutant guard: the unknown transmitter must not leak into any station
    assert all("UNKNOWN" not in json.dumps(f) for f in feats)
    assert aggregate([], SPECIES, 2) == (
        [],
        {
            "rows": 0,
            "joined": 0,
            "unjoined": 0,
            "outside_window": 0,
            "stations": 0,
            "projects": 0,
            "species": 0,
            "data_end": None,
        },
    )


def test_fetch_detections_treats_erddap_404_as_empty_but_raises_other_errors():
    def http(code):
        def f(url, timeout=600):
            raise urllib.error.HTTPError(url, code, "x", {}, None)

        return f

    assert fetch_detections("2026-01-01", http(404)) == []
    try:
        fetch_detections("2026-01-01", http(500))
        assert False, "500 must raise"
    except urllib.error.HTTPError as e:
        assert e.code == 500
    # positive control: a real table parses and the query carries the time filter
    seen = {}

    def ok(url, timeout=600):
        seen["url"] = url
        return {
            "table": {
                "columnNames": list(DET_COLS),
                "rows": [["2025-07-30T00:00:00Z", 1.0, 2.0, "A69-1", "S", "P"]],
            }
        }

    rows = fetch_detections("2025-01-01", ok)
    assert (
        rows[0]["detection_transmittername"] == "A69-1"
        and "time>=2025-01-01T00:00:00Z" in seen["url"]
    )


def test_main_end_to_end_writes_geojson(tmp_path, monkeypatch):
    import pipeline.otn as m

    monkeypatch.setattr(
        m,
        "fetch_releases",
        lambda fetch=None: [
            {
                "transmittername": "A69-1",
                "vernacularname": "Striped bass",
                "scientificname": "Morone saxatilis",
                "project_reference": "P",
            }
        ],
    )
    monkeypatch.setattr(
        m,
        "fetch_projects",
        lambda detections, fetch=None: {
            "P": dict(zip(PROJ_COLS, ["P", "Proj", "Cite me", "Org", "https://u"]))
        },
    )
    monkeypatch.setattr(
        m,
        "fetch_detections",
        lambda since, fetch=None: [
            det("2025-07-30T03:00:00Z", "A69-1"),
            det("2025-07-30T04:00:00Z", "A69-9"),
        ],
    )
    out = tmp_path / "otn.geojson"
    main(["--out", str(out), "--weeks", "4"])
    gj = json.loads(out.read_text())
    assert (
        gj["type"] == "FeatureCollection"
        and gj["data_end"] == "2025-07-30"
        and gj["species"] == ["striped bass"]
    )
    assert gj["projects"] == {
        "P": {
            "project_name": "Proj",
            "project_citation": "Cite me",
            "project_pi_organization": "Org",
            "project_infourl": "https://u",
        }
    }
    assert gj["counts"]["unjoined"] == 1 and len(gj["features"]) == 1
    assert "CC BY 4.0" in gj["source"]["licence"]


def test_fetch_projects_one_narrow_query_per_project_never_distinct():
    from pipeline.otn import fetch_projects

    urls = []

    def fetch(url, timeout=600):
        urls.append(url)
        pr = "P" if "%22P%22" in url else "Q"
        return {"table": {"columnNames": list(PROJ_COLS), "rows": [[pr, "N" + pr, "C" + pr, "O", "u"]]}}

    rows = [det("2025-07-30T03:00:00Z", "A", proj="P"), det("2025-07-01T00:00:00Z", "B", proj="P"), det("2025-06-01T00:00:00Z", "C", proj="Q")]
    out = fetch_projects(rows, fetch, sleep=0)
    assert out == {"P": dict(zip(PROJ_COLS, ["P", "NP", "CP", "O", "u"])), "Q": dict(zip(PROJ_COLS, ["Q", "NQ", "CQ", "O", "u"]))}
    assert len(urls) == 2 and all("distinct" not in u for u in urls)
    assert "time%3E%3D2025-07-30T00%3A00%3A00Z" in urls[0] or "time>=2025-07-30T00:00:00Z" in urls[0]


def test_get_json_retries_5xx_with_backoff_but_not_4xx(monkeypatch):
    import pipeline.otn as m

    calls = {"n": 0}
    codes = [503, 504, 200]

    class R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"ok": 1}'

    def urlopen(req, timeout=0):
        c = codes[calls["n"]]
        calls["n"] += 1
        if c != 200:
            raise urllib.error.HTTPError(req.full_url, c, "x", {}, None)
        return R()

    monkeypatch.setattr(m.urllib.request, "urlopen", urlopen)
    slept = []
    assert m._get_json("https://x/a", sleep=slept.append) == {"ok": 1}
    assert calls["n"] == 3 and slept == [30, 60]
    # a 4xx is final and never retried
    calls["n"] = 0
    codes[:] = [404, 200, 200]
    try:
        m._get_json("https://x/b", sleep=slept.append)
        assert False
    except urllib.error.HTTPError as e:
        assert e.code == 404 and calls["n"] == 1
