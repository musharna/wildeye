"""pipeline/cetaceans.py — parse, monitoring-window filter, weekly aggregation, fetch, end-to-end.

Fixture rows are shaped from real PACM files fetched 2026-09-12:
  narw/detections.csv header: id,analysis_id,deployment_id,species,date,presence,locations
  UNB:UNB_GSL_202605_CABOT,UNB:UNB_GSL_202605_CABOT:UNB:REAL-TIME_ANALYSIS,UNB:UNB_GSL_202605_CABOT,RIWH,2026-05-14,n,null
  mobile `locations`: [{"analysis_period_start_datetime":"2025-12-20 07:17:24",
      "analysis_period_end_datetime":"2025-12-20 07:32:24","latitude":43.1908,"longitude":-69.8765,"presence":"m"}]
  narw/deployments.json row keys: id, analysis_id, site_id, deployment_organization_code, ..., site, latitude,
      longitude, monitoring_start_datetime, monitoring_end_datetime, platform_type, deployment_type, qc_data, ...
Every test was run against a deliberate mutant (named in each docstring) and seen to fail.
"""

import datetime as dt
import gzip
import json
import urllib.error

import pipeline.cetaceans as m
from pipeline.cetaceans import (
    THEMES,
    aggregate,
    fetch_theme,
    parse_detections,
    week_ends,
)

HEADER = "id,analysis_id,deployment_id,species,date,presence,locations\n"


def det(dep, date, presence, species="RIWH", locations="null"):
    return {
        "id": dep,
        "analysis_id": f"{dep}:X",
        "deployment_id": dep,
        "species": species,
        "date": date,
        "presence": presence,
        "locations": locations,
    }


def dep(
    id,
    site="DAL",
    lat=48.0159,
    lon=-64.1329,
    org="UNB",
    mobile=False,
    start="2026-01-01",
    end="2026-12-31",
    qc="REAL_TIME",
):
    return {
        "id": id,
        "site_id": f"{org}:{site}:25",
        "deployment_organization_code": org,
        "deployment_id": id,
        "deployment_code": id.split(":")[-1],
        "project": "UNB_GSL",
        "site": site,
        "latitude": lat,
        "longitude": lon,
        "monitoring_start_datetime": f"{start} 13:09:32",
        "monitoring_end_datetime": f"{end} 08:58:18",
        "platform_type": "ELECTRIC_GLIDER" if mobile else "BOTTOM_MOUNTED_MOORING",
        "deployment_type": "MOBILE" if mobile else "STATIONARY",
        "qc_data": qc,
        "data_poc": "Someone <someone@example.org>",
    }


def test_parse_detections_keeps_analysed_rows_in_window_and_rejects_a_wrong_header():
    """Mutant: `r["presence"] in PRESENT` → `True` fails (the `na` row leaks); dropping the
    header check fails the ValueError assertion."""
    text = (
        HEADER
        + "UNB:A,UNB:A:X,UNB:A,RIWH,2026-05-14,n,null\n"
        + "UNB:A,UNB:A:X,UNB:A,RIWH,2026-05-15,y,null\n"
        + "UNB:A,UNB:A:X,UNB:A,RIWH,2026-05-13,na,null\n"
        + "DFO:B,DFO:B:RIWH,DFO:B,RIWH,2018-01-06,y,null\n"
        + 'WHOI:C,WHOI:C:X,WHOI:C,RIWH,2026-05-10,m,"[{""latitude"":43.1908,""longitude"":-69.8765,""presence"":""m""}]"\n'
    )
    rows = parse_detections(text, "2026-01-01")
    assert [(r["date"], r["presence"]) for r in rows] == [
        ("2026-05-14", "n"),
        ("2026-05-15", "y"),
        ("2026-05-10", "m"),
    ]
    assert json.loads(rows[2]["locations"])[0]["latitude"] == 43.1908, (
        "quoted JSON column survives csv parsing"
    )
    # positive control on the header guard: a file without `presence` must not parse silently
    try:
        parse_detections("id,deployment_id,date\nA,A,2026-05-14\n", "2026-01-01")
        assert False, "must raise"
    except ValueError as e:
        assert "presence" in str(e)


def test_week_ends_newest_first():
    """Mutant: `range(weeks)` → `range(1, weeks + 1)` fails."""
    assert week_ends(dt.date(2026, 5, 15), 3) == [
        dt.date(2026, 5, 15),
        dt.date(2026, 5, 8),
        dt.date(2026, 5, 1),
    ]


def test_aggregate_bins_days_per_theme_label_and_keeps_effort_for_no_detection_stations():
    """Mutants seen failing: (a) `_week_index` `//` → `/` (bins collapse), (b) label lookup
    removed (`species` keyed 'narw' instead of 'right whale'), (c) `elif presence == 'm'`
    dropped (possible days vanish), (d) `st["effort"][k].add` removed (e goes to 0)."""
    deps = {"UNB:A": dep("UNB:A")}
    narw = [
        det("UNB:A", "2026-05-15", "y"),  # bin 0
        det("UNB:A", "2026-05-09", "y"),  # end-6 → bin 0
        det("UNB:A", "2026-05-08", "m"),  # end-7 → bin 1
        det("UNB:A", "2026-05-01", "n"),  # bin 2: monitored, nothing heard
        det("UNB:A", "2026-01-01", "y"),  # outside a 3-week window
    ]
    fin = [
        det("UNB:A", "2026-05-15", "y", species="FIWH"),
        det("UNB:A", "2026-05-15", "n", species="FIWH"),
    ]
    feats, c = aggregate({"narw": (narw, deps), "fin": (fin, deps)}, weeks=3)
    assert (
        c["outside_window"] == 1
        and c["detection_days"] == 3
        and c["stations"] == 1
        and c["data_end"] == "2026-05-15"
    )
    p = feats[0]["properties"]
    assert feats[0]["geometry"]["coordinates"] == [-64.1329, 48.0159]
    assert (
        p["station"] == "DAL"
        and p["org"] == "UNB"
        and p["mobile"] is False
        and p["qc"] == ["REAL_TIME"]
    )
    assert p["species"] == {"right whale": 2, "fin whale": 1} and p["possible"] == {
        "right whale": 1
    }
    assert p["codes"] == {"right whale": ["RIWH"], "fin whale": ["FIWH"]}
    assert p["weeks"] == [
        {"w": "2026-05-15", "n": {"right whale": 2, "fin whale": 1}, "m": {}, "e": 2},
        {"w": "2026-05-08", "n": {}, "m": {"right whale": 1}, "e": 1},
        {"w": "2026-05-01", "n": {}, "m": {}, "e": 1},
    ]
    assert p["n"] == 3 and p["e"] == 4, (
        "effort counts distinct monitored days across themes"
    )
    assert "data_poc" not in json.dumps(feats) and "example.org" not in json.dumps(
        feats
    ), "contributor e-mails never leave the pipeline"
    # a station with monitored days but no detection still exists (faded on the globe), n = 0
    feats2, c2 = aggregate({"narw": ([det("UNB:A", "2026-05-15", "n")], deps)}, weeks=3)
    assert (
        len(feats2) == 1
        and feats2[0]["properties"]["n"] == 0
        and feats2[0]["properties"]["e"] == 1
    )
    assert aggregate({"narw": ([], deps)}, 3) == (
        [],
        {
            "rows": 0,
            "no_deployment": 0,
            "outside_monitoring": 0,
            "no_position": 0,
            "outside_window": 0,
            "detection_days": 0,
            "stations": 0,
            "organizations": 0,
            "data_end": None,
        },
    )


def test_aggregate_drops_days_outside_the_deployment_monitoring_window_with_positive_control():
    """Real defect: PACM sperm theme rows for PIFSC:PIFSC_WM_MACS18_1803_DS4 (monitored
    2018-07-12..2018-07-24) are dated 2026. Mutant: `_monitored` → `return True` fails
    (the 2018 buoy appears as a 2026 station)."""
    buoy = dep(
        "PIFSC:DS4",
        site="",
        org="PIFSC",
        mobile=True,
        start="2018-07-12",
        end="2018-07-24",
        lat=17.2598,
        lon=145.398,
        qc="POST_PROCESSED",
    )
    buoy["site_id"] = None
    good = dep("UNB:A")
    undated = dep(
        "WHOI:U", org="WHOI", site="U"
    )  # distinct site: default org/site would merge it into UNB:A
    del undated["monitoring_end_datetime"]
    rows = [
        det("PIFSC:DS4", "2026-05-01", "n", species="PSWH"),
        det("UNB:A", "2026-05-01", "y"),
        det("WHOI:U", "2026-05-01", "y"),
        det("NOPE:Z", "2026-05-01", "y"),
    ]
    feats, c = aggregate(
        {"sperm": (rows, {"PIFSC:DS4": buoy, "UNB:A": good, "WHOI:U": undated})},
        weeks=2,
        data_end=dt.date(2026, 5, 1),
    )
    assert (
        c["outside_monitoring"] == 1 and c["no_deployment"] == 1 and c["stations"] == 2
    )
    assert {f["properties"]["org"] for f in feats} == {"UNB", "WHOI"}, (
        "in-window and undated deployments kept; 2018 buoy dropped"
    )


def test_aggregate_positions_mobile_platforms_at_the_mean_of_their_day_locations():
    """Mutant: `_day_position` ignoring `locations` (deployment lat/lon only) fails the
    coordinate assertion; keying mobile by site_id instead of deployment merges two gliders."""
    g1 = dep("WHOI:G1", site="GL", org="WHOI", mobile=True, lat=40.0, lon=-70.0)
    g2 = dep("WHOI:G2", site="GL", org="WHOI", mobile=True, lat=40.0, lon=-70.0)
    loc = lambda la, lo, p: json.dumps(
        [
            {
                "analysis_period_start_datetime": "2026-05-14 07:17:24",
                "latitude": la,
                "longitude": lo,
                "presence": p,
            }
        ]
    )
    rows = [
        det("WHOI:G1", "2026-05-14", "y", locations=loc(43.0, -69.0, "y")),
        det("WHOI:G1", "2026-05-15", "n", locations=loc(45.0, -67.0, "n")),
        det("WHOI:G2", "2026-05-15", "y"),  # no locations → deployment position
    ]
    feats, c = aggregate({"narw": (rows, {"WHOI:G1": g1, "WHOI:G2": g2})}, weeks=1)
    assert c["stations"] == 2, "two gliders at one nominal site stay two stations"
    by = {f["properties"]["station"]: f for f in feats}
    assert (
        by["G1"]["geometry"]["coordinates"] == [-68.0, 44.0]
        and by["G1"]["properties"]["mobile"] is True
    )
    assert by["G2"]["geometry"]["coordinates"] == [-70.0, 40.0]
    # positive control for no_position: a stationary deployment without coordinates is counted, not placed
    nolat = dep("UNB:N")
    nolat["latitude"] = None
    _, c2 = aggregate(
        {"narw": ([det("UNB:N", "2026-05-15", "y")], {"UNB:N": nolat})}, weeks=1
    )
    assert c2["no_position"] == 1 and c2["stations"] == 0


def test_fetch_theme_requests_csv_then_deployments_with_the_repo_ua_and_gunzips():
    """Mutant: `_get_bytes` without the gzip branch returns compressed bytes → UnicodeDecodeError."""
    urls = []

    def fetch(url, timeout=300):
        urls.append(url)
        if url.endswith("detections.csv"):
            return (HEADER + "UNB:A,UNB:A:X,UNB:A,RIWH,2026-05-14,y,null\n").encode()
        return json.dumps([dep("UNB:A")]).encode()

    slept = []
    rows, deps = fetch_theme("narw", "2026-01-01", fetch, sleep=slept.append)
    assert urls == [f"{m.BASE}/narw/detections.csv", f"{m.BASE}/narw/deployments.json"]
    assert (
        rows[0]["presence"] == "y" and "UNB:A" in deps and slept == [m.SLEEP, m.SLEEP]
    )
    assert (
        "github.com/musharna/wildeye" in m.UA["User-Agent"]
        and m.UA["Accept-Encoding"] == "gzip"
    )

    class R:
        headers = {"Content-Encoding": "gzip"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return gzip.compress(
                b'[{"code":"UNB","name":"University of New Brunswick"}]'
            )

    import pipeline.cetaceans as mod

    saved = mod.urllib.request.urlopen
    mod.urllib.request.urlopen = lambda req, timeout=0: R()
    try:
        assert mod.fetch_organizations() == {"UNB": "University of New Brunswick"}
    finally:
        mod.urllib.request.urlopen = saved


def test_get_bytes_retries_5xx_with_backoff_but_not_4xx(monkeypatch):
    """Mutant: `e.code < 500` → `e.code < 400` fails (404 gets retried)."""
    calls = {"n": 0}
    codes = [503, 200]

    class R:
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"ok"

    def urlopen(req, timeout=0):
        c = codes[calls["n"]]
        calls["n"] += 1
        if c != 200:
            raise urllib.error.HTTPError(req.full_url, c, "x", {}, None)
        return R()

    monkeypatch.setattr(m.urllib.request, "urlopen", urlopen)
    slept = []
    assert m._get_bytes("https://x/a", sleep=slept.append) == b"ok" and slept == [30]
    calls["n"] = 0
    codes[:] = [404, 200]
    try:
        m._get_bytes("https://x/b", sleep=slept.append)
        assert False
    except urllib.error.HTTPError as e:
        assert e.code == 404 and calls["n"] == 1


def test_main_end_to_end_writes_geojson(tmp_path, monkeypatch):
    """Mutant: `write_atomic(... "species": [...])` keyed by theme id fails the species list."""
    monkeypatch.setattr(
        m,
        "fetch_organizations",
        lambda fetch=None: {"UNB": "University of New Brunswick", "X": "Unused"},
    )
    monkeypatch.setattr(m.time, "sleep", lambda s: None)

    def fake_theme(theme, since, fetch=None, sleep=None):
        rows = [det("UNB:A", "2026-05-15", "y" if theme == "narw" else "n")]
        return rows, {"UNB:A": dep("UNB:A")}

    monkeypatch.setattr(m, "fetch_theme", fake_theme)
    out = tmp_path / "c.geojson"
    m.main(["--out", str(out), "--weeks", "4"])
    gj = json.loads(out.read_text())
    assert (
        gj["type"] == "FeatureCollection"
        and gj["data_end"] == "2026-05-15"
        and gj["weeks"] == 4
    )
    assert gj["species"] == list(THEMES.values()) and gj["species"][0] == "right whale"
    assert gj["organizations"] == {"UNB": "University of New Brunswick"}, (
        "only organisations with a station are listed"
    )
    assert len(gj["features"]) == 1 and gj["features"][0]["properties"]["species"] == {
        "right whale": 1
    }
    assert (
        "Public Domain" in gj["source"]["licence"]
        and "Science Center v1.3.8. Accessed on" in gj["source"]["citation"]
    )
