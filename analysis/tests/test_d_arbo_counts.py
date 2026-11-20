"""D feasibility counts: which counties are near a radar, what a county-year is, and what the downloads must be."""

import hashlib
import io
import urllib.error
import urllib.request
import zipfile

import pytest

from analysis import d_arbo_counts as d

RADARS = [
    {"id": "KONE", "lat": 40.0, "lon": -75.0},
    {"id": "KTWO", "lat": 41.0, "lon": -75.0},
]
# 40.5 N is ~56 km from each radar; 45 N, -60 E is over 1,000 km from both
CENT = {"10001": (40.5, -75.0), "10002": (45.0, -60.0), "10003": (39.0, -75.0)}


def test_a_county_between_two_radars_counts_for_both_and_a_far_one_for_none():
    near = d.near(RADARS, CENT)
    assert near == {"KONE": {"10001", "10003"}, "KTWO": {"10001"}}
    # 10003 is ~111 km from KONE (in) and ~222 km from KTWO (out): the radius is 150 km, not 100 or 250
    assert (
        100
        < d.km((40.0, -75.0), CENT["10003"])
        < 150
        < d.km((41.0, -75.0), CENT["10003"])
        < 250
    )


def _csv(path, header, rows):
    path.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")
    return path


def test_a_county_year_is_one_row_pooled_spans_are_skipped_and_a_repeat_stops_the_run(
    tmp_path,
):
    head = '"Year","County","Activity","Reported human cases","Neuroinvasive disease cases"'
    main = _csv(
        tmp_path / "a.csv",
        head,
        [
            "2024,10001,Human infections,3,2",
            "2025,10001,Human infections,,",
            "2003-2024,10001,Human infections,40,30",
        ],
    )
    extra = _csv(tmp_path / "b.csv", head, ["2022, 09001 ,Human infections,2,2"])
    cases, pooled = d.county_years([main, extra], "Reported human cases")
    # a blank count is 0; the pooled span is not a year and is counted, not added; a padded code is stripped
    assert cases == {("10001", 2024): 3, ("10001", 2025): 0, ("09001", 2022): 2}
    assert pooled == 1
    assert (
        d.county_years([main], "Neuroinvasive disease cases")[0][("10001", 2024)] == 2
    )
    # the same county-year in two files would be added twice
    again = _csv(tmp_path / "c.csv", head, ["2024,10001,Human infections,1,1"])
    with pytest.raises(
        RuntimeError, match=r"c\.csv: county-year \('10001', 2024\) appears twice"
    ):
        d.county_years([main, again], "Reported human cases")


def test_cases_near_a_radar_are_summed_over_its_counties_by_year():
    cases = {
        ("10001", 2024): 3,
        ("10003", 2024): 4,
        ("10002", 2024): 50,
        ("10001", 2025): 1,
    }
    table = d.radar_year(cases, d.near(RADARS, CENT), range(2024, 2026))
    assert table == {"KONE": {2024: 7, 2025: 1}, "KTWO": {2024: 3, 2025: 1}}


def _gaz(path, rows):
    lines = ["GEOID\tNAME\tINTPTLAT\tINTPTLONG" + " " * 20]
    lines += [f"{f}\tx\t{lat}\t{lon}   " for f, (lat, lon) in rows.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_connecticut_planning_regions_come_from_the_2024_gazetteer_and_nothing_else_does(
    tmp_path,
):
    regions = {f"091{i}0": (41.5, -72.0 - i / 10) for i in range(1, 10)}
    _gaz(
        tmp_path / "2021_Gaz_counties_national.txt",
        {"09001": (41.2, -73.4), "36103": (40.9, -72.8)},
    )
    _gaz(
        tmp_path / "2024_Gaz_counties_national.txt",
        regions | {"36103": (0.0, 0.0), "48999": (30.0, -99.0)},
    )
    cent = d.centroids(tmp_path)
    # the nine regions are added; a 2021 point is not replaced by its 2024 one; other 2024-only codes are not taken
    assert set(cent) == {"09001", "36103", *regions}
    assert cent["36103"] == (40.9, -72.8) and cent["09110"] == (41.5, -72.1)
    # eight regions means the file is not the one this was written for
    del regions["09190"]
    _gaz(tmp_path / "2024_Gaz_counties_national.txt", regions)
    with pytest.raises(
        RuntimeError, match="expected 9 new Connecticut planning regions"
    ):
        d.centroids(tmp_path)


def test_variance_shares_tell_a_swing_all_radars_share_from_a_difference_between_radars():
    def table(f):
        return {r: {y: f(r, y) for y in (2003, 2004, 2005)} for r in ("A", "B", "C")}

    level = {"A": 1, "B": 10, "C": 100}
    swing = {2003: 1, 2004: 10, 2005: 100}
    # radars that differ 100-fold and years that differ by a fifth (with no year difference at all there is no
    # within-radar variance to take a share of)
    mostly_radars = d.two_way(
        table(lambda r, y: 1000 * level[r] + 200 * level[r] * (y - 2003))
    )
    assert mostly_radars["radar"] > 0.99 and mostly_radars["year"] < 0.01
    only_years = d.two_way(table(lambda r, y: swing[y]))
    assert only_years["year"] == pytest.approx(1.0) and only_years[
        "radar"
    ] == pytest.approx(0.0, abs=1e-12)
    assert only_years["year_of_within_radar"] == pytest.approx(1.0)
    # one radar-year off the pattern: something is left, and the three shares still sum to 1
    odd = table(lambda r, y: swing[y] * level[r])
    odd["B"][2004] = 0
    shares = d.two_way(odd)
    assert shares["left"] > 0.01
    assert shares["radar"] + shares["year"] + shares["left"] == pytest.approx(1.0)
    assert shares["year_of_within_radar"] == pytest.approx(
        shares["year"] / (shares["year"] + shares["left"])
    )


def test_onset_months_are_read_in_calendar_order_for_one_span_and_a_missing_month_stops_the_run(
    tmp_path,
):
    head = '"Type","Year","Month","Reported Cases"'
    rows = [
        f"All disease cases,1999-2025,{m},{i}" for i, m in enumerate(reversed(d.MONTHS))
    ]
    rows += [
        "All disease cases,2024,Jan,999",
        "Neuroinvasive disease cases,1999-2025,Jan,888",
    ]
    path = _csv(tmp_path / "m.csv", head, rows)
    assert d.by_month(path, "1999-2025") == list(range(11, -1, -1))
    short = _csv(tmp_path / "s.csv", head, rows[1:])  # no December
    with pytest.raises(RuntimeError, match=r"s\.csv: span '1999-2025' has months"):
        d.by_month(short, "1999-2025")


def test_coverage_is_the_share_of_the_seasons_days_with_a_file():
    listing = {
        "KONE": {
            "2019-04": 30,
            "2019-05": 13,
            "2019-06": 30,
            "2020-04": 30,
            "2020-05": 31,
        }
    }
    cov = d.coverage(listing, ["KONE"], range(2019, 2022), (4, 5), 61)
    assert cov == {("KONE", 2019): 43 / 61, ("KONE", 2020): 1.0, ("KONE", 2021): 0.0}


def _page(radar, days, token=None):
    keys = "".join(
        f"<Key>nexrad/daily/{radar}/{day[:4]}/{radar}_vpts_{day}.csv</Key>"
        for day in days
    )
    more = (
        f"<IsTruncated>true</IsTruncated><NextContinuationToken>{token}</NextContinuationToken>"
        if token
        else ""
    )
    return f"<ListBucketResult>{keys}{more}</ListBucketResult>".encode()


def test_the_archive_listing_follows_every_page_and_counts_daily_files_by_month():
    asked = []

    def get(url):
        asked.append(url)
        if "continuation-token=t2" in url:
            # the last page also holds a key that is not a daily profile, and one of another radar
            other = b"<Key>nexrad/daily/KONE/2003/readme.txt</Key><Key>nexrad/daily/KTWO/2003/KTWO_vpts_20030401.csv</Key>"
            return _page("KONE", ["20030501"]) + other
        return _page("KONE", ["20030401", "20030402"], token="t2")

    assert d.list_archive(["KONE"], get=get, pause=0) == {
        "KONE": {"2003-04": 2, "2003-05": 1}
    }
    assert (
        len(asked) == 2
        and "prefix=nexrad%2Fdaily%2FKONE%2F" in asked[0]
        and "continuation-token" not in asked[0]
    )
    # a page that says there is more but gives no token would end the count early
    with pytest.raises(
        RuntimeError, match="KONE: a truncated listing page without a token"
    ):
        d.list_archive(
            ["KONE"],
            get=lambda url: (
                _page("KONE", ["20030401"]) + b"<IsTruncated>true</IsTruncated>"
            ),
            pause=0,
        )
    # an empty listing is a wrong prefix or a moved bucket, not a radar with no data
    with pytest.raises(RuntimeError, match="KONE: the listing holds no daily file"):
        d.list_archive(["KONE"], get=lambda url: _page("KONE", []), pause=0)


def test_a_download_that_is_not_the_pinned_file_is_refused_and_a_good_one_is_fetched_once(
    tmp_path, monkeypatch
):
    plain, zipped = b"Year,County\n2024,10001\n", b"GEOID\tINTPTLAT\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("gaz.txt", zipped)
        zf.writestr("other.txt", b"not this one")
    served = {
        "https://example.org/a.csv": plain,
        "https://example.org/gaz.zip": buf.getvalue(),
    }
    monkeypatch.setattr(
        d,
        "INPUTS",
        {
            "a.csv": (
                "https://example.org/a.csv",
                hashlib.sha256(plain).hexdigest(),
                None,
            ),
            "gaz.txt": (
                "https://example.org/gaz.zip",
                hashlib.sha256(zipped).hexdigest(),
                "gaz.txt",
            ),
        },
    )
    asked = []

    def get(url):
        asked.append(url)
        return served[url]

    # positive control: both arrive, the zip member is what is stored, and a second call asks for nothing
    assert d.fetch_inputs(tmp_path, get=get, pause=0) == ["a.csv", "gaz.txt"]
    assert (tmp_path / "a.csv").read_bytes() == plain and (
        tmp_path / "gaz.txt"
    ).read_bytes() == zipped
    assert d.fetch_inputs(tmp_path, get=get, pause=0) == [] and len(asked) == 2
    # a changed capture is not written
    (tmp_path / "a.csv").unlink()
    served["https://example.org/a.csv"] = plain + b"2025,10001\n"
    with pytest.raises(
        RuntimeError, match="a.csv: sha256 .* expected .*; nothing written"
    ):
        d.fetch_inputs(tmp_path, get=get, pause=0)
    assert not (tmp_path / "a.csv").exists()
    # a file on disk that was edited is caught on the next run
    (tmp_path / "a.csv").write_bytes(plain + b"edited\n")
    with pytest.raises(
        RuntimeError, match="a.csv: sha256 .* expected .*; delete it and rerun"
    ):
        d.fetch_inputs(tmp_path, get=get, pause=0)


class _Answer:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b"body"


def _http(code):
    return urllib.error.HTTPError(
        "https://example.org/x", code, "x", {}, io.BytesIO(b"")
    )


def test_get_retries_a_busy_server_or_a_dropped_connection_and_gives_a_refusal_back_at_once(
    monkeypatch,
):
    waits, answers = [], []

    def fake_urlopen(url, timeout=None):
        a = answers.pop(0)
        if isinstance(a, BaseException):
            raise a
        return a

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(d.time, "sleep", waits.append)
    # positive control: a 503, a 429 and a dropped connection are each waited out, longer each time
    answers[:] = [_http(503), _http(429), ConnectionResetError(104, "reset"), _Answer()]
    assert d.get("https://example.org/x") == b"body"
    assert waits == [5, 10, 20]
    # a refusal (403, 404) is the answer: raised as it came, with no wait and no second request
    for code in (403, 404):
        waits.clear()
        answers[:] = [_http(code), _Answer()]
        with pytest.raises(urllib.error.HTTPError) as e:
            d.get("https://example.org/x")
        assert e.value.code == code and waits == [] and len(answers) == 1
    # a server that stays busy is given up on after `tries` requests, and its last error is the one raised
    waits.clear()
    answers[:] = [_http(503), _http(502), _Answer()]
    with pytest.raises(urllib.error.HTTPError) as e:
        d.get("https://example.org/x", tries=2)
    assert e.value.code == 502 and waits == [5] and len(answers) == 1
