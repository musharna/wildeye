"""pipeline/arbonet.py — MMWR weeks, Socrata paging + label filter, YTD differencing, state index, end to end.

Fixture rows are verbatim from data.cdc.gov/resource/x9gk-5huc.json (Texas, West Nile, 2026,
fetched 2026-09-12); only `sort_order`/`geocode` are dropped. Mutants, each seen to FAIL 2026-09-12
(re-verified by the resuming agent; M2 had SURVIVED the original fixture and was fixed):
  M1 mmwr_week_end: `(5 - jan4.weekday()) % 7` → `(6 - ...)`      → week-end dates off by one day.
  M2 weekly_new: `base = last_cum if last_year == yw[0] else 0` → `base = last_cum`
     → Ohio 2026 week-1 bin 2 → 0 (the Texas "-" week 1 alone could not tell; Ohio row added).
  M3 weekly_new: drop the `state in AGGREGATES` skip              → 'U.S. Residents' appears in the index.
  M4 state_index: `if cell["new"]:` → `if True:`                  → zero weeks listed (positive control:
                                                                    non-zero weeks still listed).
  M5 fetch_rows: `if len(rows) < PAGE: return out` → `return out` → second page never fetched.
  M6 fetch_rows: exact `label in ('<DISEASES keys>')` list instead of prefixes
     → the double-spaced live La Crosse / Jamestown Canyon labels match no server clause (the live
       2026-09-12 file had 0 cases for both because of exactly this).
  M7 DISEASES: drop the "Severe dengue" row                       → Florida week-20 den bin 3 → 2.
"""

import datetime as dt
import json
import pipeline.arbonet as m
from pipeline.arbonet import (
    fetch_rows,
    mmwr_week_end,
    mmwr_year_week,
    weekly_new,
    state_index,
    to_features,
    main,
    PAGE,
)

SQ = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
WNV = "Arboviral diseases, West Nile virus disease"
# real rows: Texas WNV 2026 weeks 24–35 (m1 = current week, m3 = cum YTD, m4 = cum YTD previous year)
TX = [
    {
        "states": "Texas",
        "year": "2026",
        "week": "24",
        "label": WNV,
        "m1_flag": "-",
        "m2": "18.0",
        "m3": "2.0",
        "m4": "1.0",
        "location1": "Texas",
    },
    {
        "states": "Texas",
        "year": "2026",
        "week": "25",
        "label": WNV,
        "m1_flag": "-",
        "m2": "18.0",
        "m3": "4.0",
        "m4": "2.0",
        "location1": "Texas",
    },
    {
        "states": "Texas",
        "year": "2026",
        "week": "26",
        "label": WNV,
        "m1": "1.0",
        "m2": "18.0",
        "m3": "5.0",
        "m4": "2.0",
        "location1": "Texas",
    },
    {
        "states": "Texas",
        "year": "2026",
        "week": "33",
        "label": WNV,
        "m1": "5.0",
        "m2": "20.0",
        "m3": "45.0",
        "m4": "62.0",
        "location1": "Texas",
    },
    {
        "states": "Texas",
        "year": "2026",
        "week": "34",
        "label": WNV,
        "m1": "1.0",
        "m2": "20.0",
        "m3": "48.0",
        "m4": "78.0",
        "location1": "Texas",
    },
    {
        "states": "Texas",
        "year": "2026",
        "week": "35",
        "label": WNV,
        "m1_flag": "-",
        "m2": "20.0",
        "m3": "48.0",
        "m4": "98.0",
        "location1": "Texas",
    },
]


def row(state, week, m3, label=WNV, year="2026", m3_flag=None, m4=None, m4_flag=None):
    r = {"states": state, "year": year, "week": str(week), "label": label}
    if m3 is not None:
        r["m3"] = f"{m3}.0"
    if m3_flag:
        r["m3_flag"] = m3_flag
    if m4 is not None:
        r["m4"] = f"{m4}.0"
    if m4_flag:
        r["m4_flag"] = m4_flag
    return r


def test_mmwr_week_ends_on_saturday_and_round_trips():
    # 4 Jan 2026 is a Sunday → MMWR week 1 of 2026 is 4–10 Jan; 28 Dec–3 Jan is week 53 of 2025
    assert mmwr_week_end(2026, 1) == dt.date(2026, 1, 10) and mmwr_week_end(
        2026, 35
    ) == dt.date(2026, 9, 5)
    assert mmwr_week_end(2025, 53) == dt.date(2026, 1, 3)  # 2025 has 53 MMWR weeks
    assert all(
        mmwr_week_end(y, w).weekday() == 5
        for y in (2024, 2025, 2026)
        for w in (1, 20, 52)
    )
    assert mmwr_year_week(dt.date(2026, 9, 12)) == (2026, 36) and mmwr_year_week(
        dt.date(2026, 1, 4)
    ) == (2026, 1)
    assert mmwr_year_week(dt.date(2026, 1, 1)) == (2025, 53)
    assert mmwr_year_week(dt.date(2025, 12, 30)) == (2025, 53)


def test_fetch_rows_pages_until_a_short_page_with_the_disease_filter():
    calls = []

    def fetch(url, timeout=300):
        calls.append(url)
        return [TX[0]] * PAGE if len(calls) == 1 else [TX[1]]

    out = fetch_rows(2026, 23, fetch, sleep=0)
    assert len(out) == PAGE + 1 and len(calls) == 2 and "%24offset=50000" in calls[1]
    assert (
        "week%3A%3Anumber+%3E%3D+23" in calls[0]
        and "starts_with%28label%2C+%27Dengue+virus+infections%2C%27%29" in calls[0]
    )
    assert "year%3D%272026%27" in calls[0]


# every tracked label VERBATIM from the live dataset (2026-09-12 $group=label probe; note the double
# spaces in La Crosse and Jamestown Canyon)
LIVE_LABELS = [
    "Arboviral diseases, Eastern equine encephalitis virus disease",
    "Arboviral diseases, Jamestown Canyon  virus disease",
    "Arboviral diseases, La Crosse  virus disease",
    "Arboviral diseases, Powassan virus disease",
    "Arboviral diseases, St. Louis encephalitis virus disease",
    "Arboviral diseases, West Nile virus disease",
    "Dengue virus infections, Dengue",
    "Dengue virus infections, Severe dengue",
]


def _server_matches(url: str, label: str) -> bool:
    """Emulate the SoQL label clause of a fetch_rows URL: starts_with(label, 'X') or label in ('X', ...)."""
    import re, urllib.parse

    where = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["$where"][0]
    prefixes = re.findall(r"starts_with\(label, '((?:[^']|'')*)'\)", where)
    m = re.search(r"label in \((.*)\)", where)
    exact = re.findall(r"'((?:[^']|'')*)'", m.group(1)) if m else []
    return any(label.startswith(p) for p in prefixes) or label in exact


def test_fetch_filter_reaches_every_tracked_live_label_including_double_spaced_ones():
    calls = []
    fetch_rows(2026, 1, lambda url, timeout=300: calls.append(url) or [], sleep=0)
    missed = [lbl for lbl in LIVE_LABELS if not _server_matches(calls[0], lbl)]
    assert missed == [], f"server filter would return no rows for {missed}"
    # positive controls on the emulator: an unrelated disease is NOT matched; an exact list IS parsed
    assert not _server_matches(calls[0], "Anthrax")
    assert _server_matches("u?%24where=label+in+%28%27A%27%2C+%27B%27%29", "B")
    weekly, c = weekly_new([row("Wisconsin", 35, 1, label=LIVE_LABELS[1])])
    assert weekly["Wisconsin"]["jcv"][(2026, 35)]["new"] == 1 and c.get("unknown_label", 0) == 0


def test_weekly_new_diffs_cumulative_ytd_not_current_week_and_reads_flags():
    weekly, c = weekly_new(
        TX
        + [
            row("U.S. Residents", 33, 317),
            row("New York", 33, 3),
            row("New York City", 33, 5),
            row(
                "Texas", 1, None, m3_flag="-", year="2026"
            ),  # "-" = no reported cases → 0
            row("Texas", 34, 60, year="2025"),
            row("Texas", 35, 62, year="2025"),
            row(
                "Texas", 52, 90, year="2025"
            ),  # last week of 2025, then 2026 restarts at 0
            row("Ohio", 52, 10, year="2025"),
            row("Ohio", 1, 2, year="2026"),  # year restart with cases already in week 1
            row("Alaska", 33, None, m3_flag="N"),  # not reportable → no data
            row(
                "Texas", 33, 1, label="Arboviral diseases, La Crosse  virus disease"
            ),  # double space in the live label
            row(
                "Texas", 33, 1, label="Arboviral diseases, Chikungunya virus disease"
            ),  # not tracked
        ]
    )
    tx, oh = weekly["Texas"]["wnv"], weekly["Ohio"]["wnv"]
    assert oh[(2026, 1)]["new"] == 2, "a new year's first report counts from 0, not a diff vs December"
    assert [tx[(2026, w)]["new"] for w in (24, 25, 26, 33, 34, 35)] == [
        2,
        2,
        1,
        40,
        3,
        0,
    ], "diff of m3, NOT m1 (5,1,-)"
    assert tx[(2026, 35)] == {"new": 0, "ytd": 48, "prev": 98}
    assert tx[(2026, 1)] == {"new": 0, "ytd": 0, "prev": 0}, (
        '"-" flag reads as 0, not no-data'
    )
    assert (
        tx[(2025, 35)]["new"] == 2
        and tx[(2025, 52)]["new"] == 28
        and tx[(2026, 24)]["new"] == 2
    ), "year restarts the base"
    assert "U.S. Residents" not in weekly and c["aggregate_rows"] == 1
    assert weekly["New York"]["wnv"][(2026, 33)]["ytd"] == 8, "NYC merged into New York"
    assert "Alaska" not in weekly and c["no_data_cells"] == 1
    assert (
        weekly["Texas"]["lac"][(2026, 33)]["new"] == 1
        and "chik" not in weekly["Texas"]
        and c["unknown_label"] == 1
    )


def test_weekly_new_downward_revision_is_zeroed_and_counted():
    weekly, c = weekly_new([row("Ohio", 30, 5), row("Ohio", 31, 3), row("Ohio", 32, 6)])
    assert [weekly["Ohio"]["wnv"][(2026, w)]["new"] for w in (30, 31, 32)] == [
        5,
        0,
        3,
    ] and c["revised_down"] == 1


def test_state_index_lists_only_nonzero_weeks_within_the_window_with_ytd_and_last_year():
    weekly, _ = weekly_new(
        TX
        + [
            row("Texas", 34, 8, label="Dengue virus infections, Dengue", m4=55),
            row("Texas", 33, 6, label="Dengue virus infections, Dengue", m4=50),
            row("Florida", 10, 2),
            row("Florida", 20, 2, label="Dengue virus infections, Dengue"),
            row("Florida", 20, 1, label="Dengue virus infections, Severe dengue"),
        ]
    )
    idx, ends = state_index(weekly, dt.date(2026, 9, 12), weeks=4)
    assert ends == ["2026-09-12", "2026-09-05", "2026-08-29", "2026-08-22"]
    tx = idx["Texas"]
    assert tx["weeks"] == [
        {"w": "2026-08-29", "n": {"wnv": 3, "den": 2}},
        {"w": "2026-08-22", "n": {"wnv": 40, "den": 6}},
    ], "week 35 (0 new) and week 26 (outside) omitted"
    assert (
        tx["n"] == 51
        and tx["by"] == {"wnv": 43, "den": 8}
        and tx["asof"] == "2026-09-05"
    )
    assert tx["ytd"] == {"wnv": 48, "den": 8} and tx["prev_ytd"] == {
        "wnv": 98,
        "den": 55,
    }
    assert "Florida" not in idx, "no cases in the window → no feature"
    feats, missing = to_features(
        idx, {"Texas": {"fips": "48", "st": "TX", "geometry": SQ}, "Florida": {"fips": "12", "st": "FL", "geometry": SQ}}
    )
    # Every shape is drawn; a zero-case state is a grey feature with n=0 (mutant: iterating the index
    # instead of the shapes drops Florida, which is how AK/MT/VT/WV vanished from the map).
    assert [f["properties"]["st"] for f in feats] == ["FL", "TX"] and missing == []
    fl = feats[0]["properties"]
    assert fl["n"] == 0 and fl["weeks"] == [] and fl["asof"] is None
    assert feats[1]["properties"]["n"] == 51, "positive control: the state with cases keeps its data"
    _, miss2 = to_features({"Guam": {"n": 1}}, {})
    assert miss2 == ["Guam"]
    idx3, _ = state_index(weekly, dt.date(2026, 5, 20), weeks=1)
    assert idx3["Florida"]["weeks"] == [{"w": "2026-05-23", "n": {"den": 3}}], "severe dengue counts with dengue"
    idx2, _ = state_index(weekly, dt.date(2026, 3, 12), weeks=2)
    assert idx2 == {
        "Florida": {
            "n": 2,
            "by": {"wnv": 2},
            "ytd": {"wnv": 2},
            "prev_ytd": {"wnv": 0},  # m4 absent + no flag = "-" = 0 cases last year
            "asof": "2026-03-14",
            "weeks": [{"w": "2026-03-14", "n": {"wnv": 2}}],
        }
    }


def test_main_end_to_end(tmp_path, monkeypatch):
    fetched = []
    monkeypatch.setattr(
        m,
        "fetch_rows",
        lambda year, min_week, fetch=None, sleep=0: (
            fetched.append((year, min_week))
            or [r for r in TX if r["year"] == str(year)]
        ),
    )
    monkeypatch.setattr(
        m,
        "load_state_shapes",
        lambda zip_path, fetch_bytes=None: {
            "Texas": {"fips": "48", "st": "TX", "geometry": SQ}
        },
    )
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    out = tmp_path / "a.geojson"
    main(
        [
            "--out",
            str(out),
            "--weeks",
            "8",
            "--today",
            "2026-09-12",
            "--cache",
            str(tmp_path),
        ]
    )
    gj = json.loads(out.read_text())
    assert fetched == [(2026, 27)], (
        "8 weeks back is MMWR week 28; one week earlier is the diff base"
    )
    assert (
        gj["newest"] == "2026-09-05"
        and gj["counts"]["features"] == 1
        and gj["counts"]["cases"] == 43
    )
    assert gj["diseases"]["pow"] == {
        "name": "Powassan",
        "vector": "tick",
        "labels": ["Arboviral diseases, Powassan virus disease"],
    }
    assert len(gj["diseases"]) == 7 and len(gj["diseases"]["den"]["labels"]) == 2
    assert "Public Domain" in gj["source"]["licence"] and gj["features"][0][
        "properties"
    ]["weeks"][0] == {"w": "2026-08-29", "n": {"wnv": 3}}
