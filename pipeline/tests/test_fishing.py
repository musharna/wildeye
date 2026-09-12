"""pipeline/fishing.py — Global Fishing Watch 4Wings report → 1° weekly grid.

No Global Fishing Watch token exists on this machine (GFW_API_KEY is the Global Forest Watch
key; the fishing gateway answers it 401 {"error":"invalid token"}, probed 2026-09-12), so no
live report could be fetched. Fixture rows are copied verbatim from the report response in the
API's own worked example (globalfishingwatch.org/our-apis/documentation/docs/api-workflows/
analyzing-fishing-effort-in-a-region, fetched live 2026-09-12):

    {"total": 2, "entries": [{"public-global-fishing-effort:v3.0": [
        {"callsign": "DAK1142", "dataset": "public-global-vessel-identity:v3.0", "date": "2025-01",
         "entryTimestamp": "2024-11-01T11:00:00Z", "exitTimestamp": "2025-01-30T23:00:00Z",
         "firstTransmissionDate": "2022-08-19T15:17:37Z", "flag": "SEN", "geartype": "TRAWLERS",
         "hours": 1.8858333333333333, "imo": "", "lastTransmissionDate": "2025-02-17T23:59:25Z",
         "lat": 15.68, "lon": -17.059999465942383, "mmsi": "663103000", "shipName": "RIA DE DAKAR",
         "vesselId": "90ab31dfb-bcab-a05f-d12f-2544e1869205", "vesselType": "FISHING"}, …]}]}

and the request body shape from GlobalFishingWatch/gfw-api-python-client
tests/fixtures/fourwings/fourwings_report_request_body.json ({"geojson": {"coordinates": …,
"type": "Polygon"}}).

Mutants (each run against this file; the named test fails, restored afterwards):
  M1 rows_of — `version = version or k` → `version = None`          (test_rows_of…)
  M2 aggregate — `math.floor` → `round`                              (test_aggregate…)
  M3 aggregate — drop `or not h`                                     (test_aggregate…)
  M4 build — `< min_hours` → `<= min_hours`                          (test_build…)
  M5 top_cells — `-f["properties"]["hours"]` → `f["properties"]["hours"]` (test_build…)
  M6 _post body — `{"geojson": geometry}` → `{"geojson": json.dumps(geometry)}` (test_post…)
  M7 fetch_all — delete the version-mismatch raise                   (test_fetch_all…)
  M8 DATASET — `:v3.0` → `:latest`                                   (test_report_url…)
"""

import datetime as dt
import io
import json
import zipfile
import pytest
import pipeline.fishing as m
from pipeline.fishing import (
    rows_of,
    aggregate,
    build,
    top_cells,
    parse_report,
    report_url,
    tile_geometry,
    week_ends,
    fetch_all,
    token,
    main,
    TILES,
)

VERBATIM_ROW = {
    "callsign": "DAK1142",
    "dataset": "public-global-vessel-identity:v3.0",
    "date": "2025-01",
    "entryTimestamp": "2024-11-01T11:00:00Z",
    "exitTimestamp": "2025-01-30T23:00:00Z",
    "firstTransmissionDate": "2022-08-19T15:17:37Z",
    "flag": "SEN",
    "geartype": "TRAWLERS",
    "hours": 1.8858333333333333,
    "imo": "",
    "lastTransmissionDate": "2025-02-17T23:59:25Z",
    "lat": 15.68,
    "lon": -17.059999465942383,
    "mmsi": "663103000",
    "shipName": "RIA DE DAKAR",
    "vesselId": "90ab31dfb-bcab-a05f-d12f-2544e1869205",
    "vesselType": "FISHING",
}


def row(lat, lon, hours, geartype="TRAWLERS"):
    return {
        **VERBATIM_ROW,
        "lat": lat,
        "lon": lon,
        "hours": hours,
        "geartype": geartype,
    }


REPORT = {
    "total": 2,
    "entries": [
        {
            "public-global-fishing-effort:v3.0": [
                VERBATIM_ROW,
                row(14.19, -17.559999465942383, 1.0191666666666663),
            ]
        }
    ],
}


def test_rows_of_reads_version_and_rows_from_the_documented_shape():
    v, rows = rows_of(REPORT)
    assert (
        v == "public-global-fishing-effort:v3.0"
        and len(rows) == 2
        and rows[0]["hours"] == 1.8858333333333333
    )
    assert rows_of({"total": 0, "entries": []}) == (None, [])
    with pytest.raises(RuntimeError, match="entries"):
        rows_of({"error": "invalid token"})


def test_parse_report_handles_plain_json_and_zip():
    assert parse_report(json.dumps(REPORT).encode(), "application/json")["total"] == 2
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("report.json", json.dumps(REPORT))
        z.writestr("caveats.txt", "x")
    assert parse_report(buf.getvalue(), "application/zip")["total"] == 2
    buf2 = io.BytesIO()
    with zipfile.ZipFile(buf2, "w") as z:
        z.writestr("caveats.txt", "x")
    with pytest.raises(RuntimeError):
        parse_report(buf2.getvalue(), "application/zip")


def test_report_url_pins_the_concrete_version_and_tile_geometry():
    u = report_url(dt.date(2026, 9, 6), dt.date(2026, 9, 12))
    assert (
        "spatial-resolution=LOW" in u
        and "spatial-aggregation=false" in u
        and "group-by=GEARTYPE" in u
    )
    assert (
        "temporal-resolution=ENTIRE" in u
        and "date-range=2026-09-06%2C2026-09-12" in u
        and "format=JSON" in u
    )
    assert "public-global-fishing-effort%3Av3.0" in u and "latest" not in u, (
        "never the latest alias"
    )
    g = tile_geometry(90, 0)
    assert g["type"] == "Polygon"
    ring = g["coordinates"][0]
    assert ring[0] == ring[-1] == [90, 0] and ring[2] == [180, 89.9], (
        "north tile stops short of the pole"
    )
    assert len(TILES) == 8 and tile_geometry(-180, -90)["coordinates"][0][0] == [
        -180,
        -89.9,
    ]


def test_post_sends_bearer_and_a_geometry_object_body(monkeypatch):
    seen = {}

    class Resp:
        headers = {"Content-Type": "application/json"}

        def read(self):
            return json.dumps(REPORT).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(req, timeout=None):
        seen["body"], seen["auth"], seen["method"] = (
            json.loads(req.data),
            req.get_header("Authorization"),
            req.get_method(),
        )
        return Resp()

    monkeypatch.setattr(m.urllib.request, "urlopen", urlopen)
    out = m._post("https://x", tile_geometry(0, 0), "TOK")
    assert (
        out["total"] == 2 and seen["method"] == "POST" and seen["auth"] == "Bearer TOK"
    )
    assert (
        isinstance(seen["body"]["geojson"], dict)
        and seen["body"]["geojson"]["type"] == "Polygon"
    ), "geometry object, not a string"


def test_aggregate_floors_0p1_rows_into_1deg_cells_per_week_per_gear():
    w1, w0 = dt.date(2026, 9, 12), dt.date(2026, 9, 5)
    cells = aggregate(
        [
            (
                w1,
                [
                    row(15.68, -17.06, 1.9),
                    row(15.02, -17.99, 0.6, "PURSE_SEINES"),
                    row(14.19, -17.56, 1.0),
                    row(30.5, 30.5, 0.0),
                    {"lat": None, "lon": 1, "hours": 3},
                ],
            ),
            (w0, [row(15.9, -17.1, 4.0)]),
        ]
    )
    assert sorted(cells) == [(-18, 14), (-18, 15)], (
        "-17.06 floors to -18 (round gives -17); zero-hour and lat-less rows ignored"
    )
    assert cells[(-18, 15)] == {
        "2026-09-12": {"trawlers": 1.9, "purse_seines": 0.6},
        "2026-09-05": {"trawlers": 4.0},
    }
    assert cells[(-18, 14)] == {"2026-09-12": {"trawlers": 1.0}}


def test_build_keeps_cells_at_or_above_min_hours_with_bins_newest_first_and_counts():
    ends = week_ends(dt.date(2026, 9, 12), 2)
    weekly = [
        (
            ends[0],
            [
                row(15.68, -17.06, 1.9),
                row(15.02, -17.99, 0.6, "PURSE_SEINES"),
                row(14.19, -17.56, 1.0),
                row(0.5, 0.5, 0.4),
            ],
        ),
        (ends[1], [row(15.9, -17.1, 4.0)]),
    ]
    feats, counts = build(weekly, ends, min_hours=1.0)
    assert [(f["properties"]["lon"], f["properties"]["lat"]) for f in feats] == [
        (-18, 14),
        (-18, 15),
    ], (
        "the 0.4 h cell at (0,0) is dropped; the 1.0 h cell is kept (positive control at the edge)"
    )
    p = feats[1]["properties"]
    assert p == {
        "lon": -18,
        "lat": 15,
        "hours": 6.5,
        "top": "trawlers",
        "gear": {"trawlers": 5.9, "purse_seines": 0.6},
        "weeks": [
            {
                "w": "2026-09-12",
                "hours": 2.5,
                "gear": {"trawlers": 1.9, "purse_seines": 0.6},
            },
            {"w": "2026-09-05", "hours": 4.0, "gear": {"trawlers": 4.0}},
        ],
    }
    assert feats[1]["geometry"] == {
        "type": "Polygon",
        "coordinates": [[[-18, 15], [-17, 15], [-17, 16], [-18, 16], [-18, 15]]],
    }
    assert counts == {
        "cells": 2,
        "rows": 5,
        "hours": 7.5,
        "gears": {"trawlers": 6.9, "purse_seines": 0.6},
    }
    top = top_cells(feats, max_bytes=400)
    assert [f["properties"]["hours"] for f in top] == [6.5], (
        "busiest first and the byte budget stops after one"
    )
    assert len(top_cells(feats)) == 2, "positive control: the default budget keeps both"


def test_fetch_all_posts_one_report_per_week_and_tile_and_rejects_a_version_change():
    calls = []

    def post(url, geometry, tok):
        calls.append((url, geometry["coordinates"][0][0], tok))
        return REPORT if len(calls) == 1 else {"total": 0, "entries": []}

    v, weekly = fetch_all(week_ends(dt.date(2026, 9, 12), 2), "T", post, sleep=0)
    assert (
        v == "public-global-fishing-effort:v3.0"
        and len(calls) == 16
        and calls[0][2] == "T"
    )
    assert (
        "2026-09-06%2C2026-09-12" in calls[0][0]
        and "2026-08-30%2C2026-09-05" in calls[8][0]
    )
    assert [c[1] for c in calls[:8]] == [[lon, max(lat, -89.9)] for lon, lat in TILES]
    assert [(e.isoformat(), len(r)) for e, r in weekly] == [
        ("2026-09-12", 2),
        ("2026-09-05", 0),
    ]
    bumped = {
        "total": 1,
        "entries": [{"public-global-fishing-effort:v4.0": [VERBATIM_ROW]}],
    }
    with pytest.raises(RuntimeError, match="v4.0"):
        fetch_all(
            week_ends(dt.date(2026, 9, 12), 1), "T", lambda u, g, t: bumped, sleep=0
        )


def test_token_missing_exits_loud_and_main_end_to_end(tmp_path, monkeypatch):
    monkeypatch.delenv("GFW_FISHING_TOKEN", raising=False)
    with pytest.raises(SystemExit) as e:
        token()
    assert "GFW_FISHING_TOKEN" in str(e.value) and "our-apis/tokens" in str(e.value)
    monkeypatch.setenv("GFW_FISHING_TOKEN", "T")
    monkeypatch.setattr(
        m,
        "fetch_all",
        lambda ends, tok, post=None, sleep=2.0: (
            m.DATASET,
            [(ends[0], rows_of(REPORT)[1])],
        ),
    )
    out, seed = tmp_path / "f.geojson", tmp_path / "seed.geojson"
    main(
        [
            "--out",
            str(out),
            "--seed-out",
            str(seed),
            "--weeks",
            "1",
            "--today",
            "2026-09-12",
        ]
    )
    gj = json.loads(out.read_text())
    assert (
        gj["source"]["version"] == "public-global-fishing-effort:v3.0"
        and "CC BY-NC 4.0" in gj["source"]["licence"]
    )
    assert gj["source"]["attribution"] == "Powered by Global Fishing Watch"
    assert (
        gj["gears"] == ["trawlers"]
        and gj["weeks"] == ["2026-09-12"]
        and len(gj["features"]) == 2
    )
    sg = json.loads(seed.read_text())
    assert sg["counts"]["seed_cells"] == 2 and "top 2 of 2" in sg["source"]["subsample"]
