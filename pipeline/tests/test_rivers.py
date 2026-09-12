"""pipeline/rivers.py — USGS Water Data OGC API `daily` → site-series.

Fixture rows are copied from real responses fetched 2026-09-12:
  daily/items?parameter_code=00010,00060&statistic_id=00003&state_code=41&time=P31D
    (USGS-10387150 temperature "22.6"; USGS-14046778 rows with "value": null;
     USGS-14316700 discharge "25.5"; `links` rel=next pointing at /ogcapi/v1/...?cursor=)
  daily/items?...&properties=monitoring_location_id,time_series_id,time,value
    (USGS-452807122215001: two series c66c5bef… and d11273bd…, 7 rows each)
  time-series-metadata/items?parameter_code=00010&statistic_id=00003
    (c66c5bef135c4cb9bebdf613d66d074e sublocation "Bottom WT Sensor",
     d11273bdce2c44e4a274c96d44e1778e "Top WT Sensor", both primary "Primary";
     USGS-021989715: one series with no sublocation + one "-23.28ft, NAVD88")
  monitoring-locations/items?id=USGS-01011000,... (Allagash River near Allagash, Maine;
    ST. LOUIS RIVER NEAR SKIBO, MN, hydrologic_unit_code 040102010203)
Mutants verified to fail each test are named per test.
"""

import datetime as dt
import json

import pytest

import pipeline.rivers as m
from pipeline.rivers import (
    aggregate,
    daily_url,
    day_range,
    fetch_locations,
    fetch_pages,
    locations_url,
    make_seed,
    pick,
    series,
    series_meta_url,
    sublocations,
)

TS = "6a34197e026a464087a2a6586e22565c"
BOTTOM, TOP = "c66c5bef135c4cb9bebdf613d66d074e", "d11273bdce2c44e4a274c96d44e1778e"


def row(sid, time, value, xy=(-120.18730555555555, 42.603500000000004), ts=TS):
    return {
        "type": "Feature",
        "properties": {
            "monitoring_location_id": sid,
            "time_series_id": ts,
            "time": time,
            "value": value,
        },
        "id": "0a236274-157f-4e6d-9125-6cc7d1aa1125",
        "geometry": {"type": "Point", "coordinates": list(xy)},
    }


def tsmeta(ts, sid, subloc):
    return {
        "type": "Feature",
        "id": ts,
        "geometry": None,
        "properties": {"monitoring_location_id": sid, "sublocation_identifier": subloc},
    }


def page(features, nxt=None):
    links = [
        {
            "type": "application/geo+json",
            "rel": "self",
            "title": "This document as GeoJSON",
            "href": "self",
        }
    ]
    if nxt:
        links.insert(
            0,
            {
                "rel": "next",
                "href": nxt,
                "type": "application/geo+json",
                "title": "Items (next)",
            },
        )
    return {
        "type": "FeatureCollection",
        "features": features,
        "numberReturned": len(features),
        "links": links,
    }


def loc(
    sid,
    name,
    state,
    huc="010100020711",
    typ="ST",
    xy=(-69.07944444444443, 47.069722222222225),
):
    return {
        "type": "Feature",
        "properties": {
            "monitoring_location_name": name,
            "state_name": state,
            "hydrologic_unit_code": huc,
            "site_type_code": typ,
        },
        "id": sid,
        "geometry": {"type": "Point", "coordinates": list(xy)},
    }


NEXT = (
    "https://api.waterdata.usgs.gov/ogcapi/v1/collections/daily/items?cursor=MDA1MWY0NzYtZWMwNS00YWNjLThiMjMtYzMzMGJmMDRkNmYx"
    "&parameter_code=00010&statistic_id=00003&time=P31D&limit=50000&properties=monitoring_location_id,time,value&f=json"
)


def test_urls_ask_for_daily_mean_one_parameter_series_id_and_narrow_properties():
    """Mutant: `statistic_id={MEAN}` removed from daily_url → min/max rows would mix into the mean series → fails;
    mutant 2: `time_series_id` dropped from daily properties → sensors could not be told apart → fails."""
    assert daily_url("00010", 31) == (
        "https://api.waterdata.usgs.gov/ogcapi/v0/collections/daily/items?f=json&parameter_code=00010"
        "&statistic_id=00003&time=P31D&limit=50000&properties=monitoring_location_id,time_series_id,time,value"
    )
    assert "time-series-metadata/items?" in series_meta_url(
        "00060"
    ) and "parameter_code=00060&statistic_id=00003" in series_meta_url("00060")
    lu = locations_url(["USGS-01011000", "USGS-04015438"])
    assert (
        "monitoring-locations/items?" in lu
        and lu.endswith("&id=USGS-01011000,USGS-04015438")
        and "limit=2" in lu
    )


def test_fetch_pages_follows_next_and_sleeps_between_pages_only():
    """Mutant: `url = next(...)` → `url = None and next(...)` stops after page 1 → fails;
    mutant 2: `if pages:` → `if True:` (sleep before the first page too) → naps == [2, 2] fails."""
    served, naps = [], []
    pages = {
        "first": page(
            [
                row("USGS-10387150", "2026-08-22", "22.6"),
                row("USGS-10387150", "2026-08-23", "22.6"),
            ],
            NEXT,
        ),
        NEXT: page([row("USGS-10387150", "2026-08-15", "22.0")]),
    }

    def fetch(u):
        served.append(u)
        return pages[u]

    out = fetch_pages("first", fetch, 2.0, sleep=naps.append)
    assert [r["properties"]["time"] for r in out] == [
        "2026-08-22",
        "2026-08-23",
        "2026-08-15",
    ]
    assert served == ["first", NEXT] and naps == [2.0]


def test_fetch_pages_fails_loud_on_runaway_paging(monkeypatch):
    """Mutant: MAX_PAGES guard removed → an endless next chain never raises (bounded here by a fetch counter).
    Positive control: a 2-page chain under the same low cap succeeds."""
    monkeypatch.setattr(m, "MAX_PAGES", 3)
    assert (
        len(
            fetch_pages(
                "a",
                lambda u: page(
                    [row("USGS-1", "2026-09-01", "1")], "b" if u == "a" else None
                ),
                0,
                sleep=lambda s: None,
            )
        )
        == 2
    )
    n = []

    def loop(u):
        n.append(u)
        if len(n) > 10:
            raise AssertionError("runaway paging not stopped")
        return page([], "loop")

    with pytest.raises(RuntimeError, match="more than 3 pages"):
        fetch_pages("loop", loop, 0, sleep=lambda s: None)


def test_series_drops_null_and_unparsable_first_value_wins_per_series_keep_filters():
    """Mutant: `except (TypeError, ValueError)` → `except ValueError` → TypeError on the real null row → fails;
    mutant 2: no duplicate check (overwrite) → 2026-08-22 becomes 99.0 → fails;
    mutant 3: rows keyed by location only (series id ignored) → the Top sensor's same-day row counts as a dup → fails."""
    sensor_site = "USGS-452807122215001"
    rows = [
        row(
            "USGS-14046778",
            "2026-08-28",
            None,
            xy=(-120.30191666666667, 44.72687222222223),
        ),
        row(
            "USGS-14046778",
            "2026-08-29",
            None,
            xy=(-120.30191666666667, 44.72687222222223),
        ),
        row("USGS-10387150", "2026-08-22", "22.6"),
        row("USGS-10387150", "2026-08-22", "99.0"),
        row("USGS-10387150", "2026-08-23", "Ice"),
        row(
            "USGS-14316700",
            "2026-09-10",
            "25.5",
            xy=(-122.728941540616, 43.3498420203775),
        ),
        row(sensor_site, "2026-08-12", "14.1", ts=BOTTOM),
        row(sensor_site, "2026-08-12", "19.9", ts=TOP),
    ]
    s, c = series(rows)
    assert set(s) == {"USGS-10387150", "USGS-14316700", sensor_site}, (
        "an id with only null values contributes no site"
    )
    assert s["USGS-10387150"] == {
        "xy": [-120.18730555555555, 42.603500000000004],
        "by": {TS: {"2026-08-22": 22.6}},
    }
    assert s[sensor_site]["by"] == {
        BOTTOM: {"2026-08-12": 14.1},
        TOP: {"2026-08-12": 19.9},
    }
    assert c == {"rows": 8, "null": 3, "dup": 1, "skipped": 0}
    k, kc = series(rows, keep={"USGS-14316700"})
    assert (
        list(k) == ["USGS-14316700"]
        and k["USGS-14316700"]["by"] == {TS: {"2026-09-10": 25.5}}
        and kc["skipped"] == 7
    )


def test_pick_one_series_per_gage_unlabelled_first_then_most_values_then_lowest_id():
    """Mutant: the `len(plain) == 1` preference removed → USGS-021989715 takes its fuller NAVD88 sensor → fails;
    mutant 2: sort by count dropped (lowest id always) → the sensor site takes BOTTOM (1 value) over TOP (2) → fails;
    mutant 3: `ids[0]` → `ids[-1]` on a tie → the tie site takes the higher id → fails."""
    drange = ["2026-09-09", "2026-09-10", "2026-09-11"]
    subloc = sublocations(
        [
            tsmeta(BOTTOM, "USGS-452807122215001", "Bottom WT Sensor"),
            tsmeta(TOP, "USGS-452807122215001", "Top WT Sensor"),
            tsmeta("aaa", "USGS-021989715", None),
            tsmeta("bbb", "USGS-021989715", "-23.28ft, NAVD88"),
            tsmeta("t1", "USGS-X", "East"),
            tsmeta("t2", "USGS-X", "West"),
        ]
    )
    sites = {
        "USGS-452807122215001": {
            "xy": [0, 0],
            "by": {
                BOTTOM: {"2026-09-10": 14.0, "2026-08-01": 1.0, "2026-08-02": 1.0},
                TOP: {"2026-09-10": 20.0, "2026-09-11": 21.0},
            },
        },
        "USGS-021989715": {
            "xy": [1, 1],
            "by": {"aaa": {"2026-09-11": 25.0}, "bbb": {d: 24.0 for d in drange}},
        },
        "USGS-X": {
            "xy": [2, 2],
            "by": {"t2": {"2026-09-11": 9.0}, "t1": {"2026-09-10": 8.0}},
        },
        "USGS-single": {"xy": [3, 3], "by": {TS: {"2026-09-11": 7.0}}},
    }
    out, multi = pick(sites, subloc, drange)
    assert multi == 3
    assert out["USGS-452807122215001"] == {
        "xy": [0, 0],
        "v": {"2026-09-10": 20.0, "2026-09-11": 21.0},
        "sensor": "Top WT Sensor",
    }, "in-window count decides (BOTTOM has more rows, but outside the window)"
    assert (
        out["USGS-021989715"]["v"] == {"2026-09-11": 25.0}
        and out["USGS-021989715"]["sensor"] is None
    )
    assert out["USGS-X"]["sensor"] == "East", (
        "tie on 1 value each → lowest series id t1"
    )
    assert out["USGS-single"] == {
        "xy": [3, 3],
        "v": {"2026-09-11": 7.0},
        "sensor": None,
    }


def test_fetch_locations_batches_and_raises_on_a_missing_id(monkeypatch):
    """Mutant: the `missing` check removed → a gage with no metadata passes silently → pytest.raises fails.
    Positive control: the complete lookup returns both ids across 2 batched requests."""
    monkeypatch.setattr(m, "ID_BATCH", 1)
    db = {
        "USGS-01011000": loc(
            "USGS-01011000", "Allagash River near Allagash, Maine", "Maine"
        ),
        "USGS-04015438": loc(
            "USGS-04015438",
            "ST. LOUIS RIVER NEAR SKIBO, MN",
            "Minnesota",
            "040102010203",
        ),
    }
    calls, naps = [], []

    def fetch(u):
        calls.append(u)
        return page([db[i] for i in u.split("&id=")[1].split(",") if i in db])

    out = fetch_locations(
        ["USGS-01011000", "USGS-04015438"], fetch, 2, sleep=naps.append
    )
    assert out["USGS-04015438"] == {
        "name": "ST. LOUIS RIVER NEAR SKIBO, MN",
        "state": "Minnesota",
        "huc": "040102010203",
        "type": "ST",
    }
    assert len(calls) == 2 and naps == [2]
    with pytest.raises(RuntimeError, match="1 location"):
        fetch_locations(
            ["USGS-01011000", "USGS-99999999"], fetch, 0, sleep=lambda s: None
        )


def test_day_range_ends_yesterday():
    """Mutant: `end = today` → last day 2026-09-12 → fails."""
    assert day_range(dt.date(2026, 9, 12), 3) == [
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
    ]


def test_aggregate_requires_both_aligns_rounds_reports_latest_and_sensor():
    """Mutant: `or` → `and` in the half rule lets the temperature-only site through → counts fail;
    mutant 2: `li` computed over q instead of t → latest.d becomes 2026-09-11 with t None → fails;
    mutant 3: sensor never written → `sensor` missing → fails (positive control: the unlabelled gage has no key)."""
    temp = {
        "USGS-10387150": {
            "xy": [-120.18730555555555, 42.603500000000004],
            "sensor": "Top WT Sensor",
            "v": {
                "2026-08-30": 17.7,
                "2026-08-31": 18.8,
                "2026-09-10": 21.04,
                "2026-07-01": 9.9,
            },
        },
        "USGS-04015438": {
            "xy": [-92.04, 47.48111111111111],
            "sensor": None,
            "v": {"2026-09-11": 16.8},
        },
        "USGS-01011000": {
            "xy": [-69.07944444444443, 47.069722222222225],
            "sensor": None,
            "v": {"2026-09-11": 16.1},
        },
    }
    flow = {
        "USGS-10387150": {
            "xy": [0, 0],
            "sensor": None,
            "v": {"2026-08-30": 12345.6, "2026-09-11": 0.987, "2026-08-31": 25.5},
        },
        "USGS-01011000": {"xy": [0, 0], "sensor": None, "v": {"2026-09-11": 299.0}},
    }
    meta = {
        "USGS-10387150": {
            "name": "LAKE ABERT NEAR VALLEY FALLS, OR",
            "state": "Oregon",
            "huc": "171200060000",
            "type": "LK",
        },
        "USGS-01011000": {
            "name": "Allagash River near Allagash, Maine",
            "state": "Maine",
            "huc": "010100020711",
            "type": "ST",
        },
    }
    feats, counts = aggregate(temp, flow, meta, dt.date(2026, 9, 12), 14)
    assert counts == {"temp_sites": 3, "half": 1, "gages": 2}
    maine, oregon = (f["properties"] for f in feats)
    assert "sensor" not in maine and maine["q"][-1] == 299
    assert feats[1]["geometry"]["coordinates"] == [-120.18731, 42.6035]
    p = oregon
    assert (
        p["site"] == "10387150"
        and p["state"] == "Oregon"
        and p["type"] == "LK"
        and p["d0"] == "2026-08-29"
    )
    assert p["sensor"] == "Top WT Sensor"
    assert p["t"] == [None, 17.7, 18.8] + [None] * 9 + [21.0, None], (
        "the July value is outside the window"
    )
    assert p["q"] == [None, 12300, 25.5] + [None] * 10 + [0.987]
    assert isinstance(p["q"][1], int) and isinstance(p["q"][2], float)
    assert p["latest"] == {"d": "2026-09-10", "t": 21.0, "q": None}


def _gj(n_states=3, per_state=4, days=30):
    feats = []
    for s in range(n_states):
        for k in range(per_state):
            t = [None] * days
            t[-1 if k % 2 == 0 else 0] = (
                15.0 + k
            )  # odd k: the only temperature is 29 days old
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [-100.123456, 40.654321],
                    },
                    "properties": {
                        "site": f"{s}{k:07d}",
                        "name": f"R{s}{k}",
                        "state": f"S{s}",
                        "huc": "x",
                        "type": "ST",
                        "d0": "2026-08-13",
                        "t": t,
                        "q": [5] * days,
                        "latest": {},
                    },
                }
            )
    feats[0]["properties"]["sensor"] = "TOP"
    return {
        "type": "FeatureCollection",
        "source": {"id": "rivers", "licence": "PD"},
        "days": days,
        "day0": "2026-08-13",
        "data_end": "2026-09-11",
        "counts": {},
        "features": feats,
    }


def test_make_seed_round_robin_trims_days_drops_stale_and_notes_subsample():
    """Mutant: `t[-days:]` → `t[:days]` → fresh gages lose their temperature / d0 wrong → fails;
    mutant 2: round-robin replaced by `gj["features"][:n]` → all picks from S0 → state set fails."""
    seed = make_seed(_gj(), n=6, days=10)
    ps = [f["properties"] for f in seed["features"]]
    assert {p["state"] for p in ps} == {"S0", "S1", "S2"}
    assert len(ps) == 3, (
        "6 picked (k=0,1 per state); the k=1 gages' only temperature is older than 10 days"
    )
    assert all(
        p["d0"] == "2026-09-02"
        and len(p["t"]) == 10
        and p["latest"] == {"d": "2026-09-11", "t": 15.0, "q": 5}
        for p in ps
    )
    assert "huc" not in ps[0] and seed["features"][0]["geometry"]["coordinates"] == [
        -100.123,
        40.654,
    ]
    assert ps[0]["sensor"] == "TOP" and "sensor" not in ps[1]
    assert (
        "3 of 12 gages" in seed["source"]["subsample"]
        and seed["days"] == 10
        and seed["day0"] == "2026-09-02"
    )


def test_make_seed_raises_when_over_the_cap(monkeypatch):
    """Mutant: size check removed → an oversized seed is returned → pytest.raises fails.
    Positive control: the same data under a 1 MB cap passes."""
    gj = _gj(n_states=1, per_state=2)
    monkeypatch.setattr(m, "SEED_MAX_BYTES", 1_000_000)
    assert make_seed(gj, n=2, days=10)["features"]
    monkeypatch.setattr(m, "SEED_MAX_BYTES", 200)
    with pytest.raises(SystemExit, match="seed is"):
        make_seed(gj, n=2, days=10)


def test_main_end_to_end_metadata_paged_daily_then_locations(tmp_path, monkeypatch):
    """Mutant: `keep=set(temp)` dropped from the flow call → flow_rows.skipped == 0 → fails;
    mutant 2: `days + 1` → `days` in _one_parameter → P30D → fails;
    mutant 3: `if not features:` exit removed → an all-half run writes a file → fails.
    The negative (no both-parameter gage → SystemExit, no file) has its positive control earlier in the
    same test (the full run writes the file)."""
    calls, naps = [], []
    monkeypatch.setattr(m.time, "sleep", naps.append)
    T = page(
        [
            row("USGS-10387150", "2026-08-22", "22.6", ts=TOP),
            row("USGS-10387150", "2026-08-22", "14.0", ts=BOTTOM),
            row("USGS-04015438", "2026-09-11", "16.8", xy=(-92.04, 47.48)),
        ]
    )
    Q1 = page(
        [row("USGS-10387150", "2026-09-10", "25.5")], NEXT.replace("00010", "00060")
    )
    Q2 = page([row("USGS-01133000", "2026-09-10", "44.3")])
    META_T = page(
        [
            tsmeta(BOTTOM, "USGS-10387150", "Bottom WT Sensor"),
            tsmeta(TOP, "USGS-10387150", "Top WT Sensor"),
        ]
    )

    def fetch(u):
        calls.append(u)
        if "monitoring-locations" in u:
            return page(
                [loc("USGS-10387150", "LAKE ABERT NEAR VALLEY FALLS, OR", "Oregon")]
            )
        if "time-series-metadata" in u:
            return META_T if "parameter_code=00010" in u else page([])
        if "cursor=" in u:
            return Q2
        return T if "parameter_code=00010" in u else Q1

    monkeypatch.setattr(m, "_get_json", fetch)
    out = tmp_path / "rivers.geojson"
    m.main(["--out", str(out), "--today", "2026-09-12"])
    kinds = [
        "meta"
        if "time-series-metadata" in c
        else "loc"
        if "monitoring-locations" in c
        else "page2"
        if "cursor=" in c
        else "daily"
        for c in calls
    ]
    assert kinds == ["meta", "daily", "meta", "daily", "page2", "loc"]
    assert all("time=P31D" in c for c, k in zip(calls, kinds) if k == "daily")
    assert calls[-1].endswith("&id=USGS-10387150") and naps == [2.0] * 5
    gj = json.loads(out.read_text())
    assert (
        gj["counts"]["gages"] == 1
        and gj["counts"]["half"] == 1
        and gj["counts"]["flow_rows"]["skipped"] == 1
    )
    assert gj["counts"]["temp_rows"]["multi_series_sites"] == 1
    assert gj["day0"] == "2026-08-13" and gj["data_end"] == "2026-09-11"
    assert (
        "Public Domain" in gj["source"]["licence"]
        and "does not imply endorsement" in gj["source"]["note"]
    )
    p = gj["features"][0]["properties"]
    assert p["name"] == "LAKE ABERT NEAR VALLEY FALLS, OR" and p["t"][9] == 14.0
    assert (
        p["sensor"] == "Bottom WT Sensor"
        and next(v for v in p["t"] if v is not None) == 14.0
    ), (
        "1 in-window value each → tie → lowest series id (c66c… = Bottom); never a mix of both sensors"
    )

    monkeypatch.setattr(
        m,
        "_get_json",
        lambda u: (
            page([row("USGS-04015438", "2026-09-11", "16.8")])
            if "parameter_code=00010" in u and "daily" in u
            else page([])
        ),
    )
    with pytest.raises(SystemExit, match="both temperature and discharge"):
        m.main(["--out", str(tmp_path / "x.geojson"), "--today", "2026-09-12"])
    assert not (tmp_path / "x.geojson").exists()


def test_main_seed_from_file_writes_seed_without_network(tmp_path, monkeypatch):
    """Mutant: `if a.seed_from:` → `if False:` falls through to the network path → the forbidden fetch raises → fails."""
    src = tmp_path / "full.geojson"
    src.write_text(json.dumps(_gj()))

    def no_net(u):
        raise AssertionError("network used")

    monkeypatch.setattr(m, "_get_json", no_net)
    m.main(
        [
            "--seed-from",
            str(src),
            "--seed-out",
            str(tmp_path / "seed.geojson"),
            "--seed-n",
            "6",
        ]
    )
    seed = json.loads((tmp_path / "seed.geojson").read_text())
    assert len(seed["features"]) == 3 and "subsample" in seed["source"]
