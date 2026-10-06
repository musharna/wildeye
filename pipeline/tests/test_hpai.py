import datetime as dt
import json
from pathlib import Path

from pipeline.hpai import parse_rows, _norm, county_lookup, county_index, to_features, main

CSV = """State,County,Collection Date,Date Detected,HPAI Strain,Bird Species,WOAH Classification,Sampling Method,Submitting Agency
Georgia,Quitman,9/1/2026,9/9/2026,EA H5N1,Canada goose,Wild bird,Morbidity/Mortality,NWDP
Georgia,Quitman,9/1/2026,9/5/2026,EA H5N1,Canada goose,Wild Bird,Hunter Harvest,NWDP
Georgia,Quitman,8/20/2026,8/27/2026,EA H5N1,Bald eagle,Captive wild bird,Morbidity/Mortality,NWDP
Georgia,Quitman,1/1/2022,1/13/2022,EA H5N1,Mallard,Wild bird,Hunter harvest,NWDP
Louisiana,St. Tammany,9/1/2026,9/9/2026,EA H5N1,Snow goose,Wild bird,Live bird,NWDP
Nebraska,Unknown,9/1/2026,9/9/2026,EA H5N1,Mallard,Wild bird,Live bird,NWDP
Georgia,Quitman,,Unknown,EA H5N1,Mallard,Wild bird,Live bird,NWDP
"""

SHAPES = {
    "13239": {"name": "Quitman", "st": "GA", "state_name": "Georgia", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}},
    "22103": {"name": "St. Tammany", "st": "LA", "state_name": "Louisiana", "geometry": {"type": "Polygon", "coordinates": [[[2, 2], [3, 2], [3, 3], [2, 2]]]}},
}


def test_parse_rows_normalises_class_and_drops_unparseable_dates():
    rows, c = parse_rows(CSV)
    assert c == {"rows": 7, "no_date": 1}
    assert len(rows) == 6
    assert rows[0]["detected"] == dt.date(2026, 9, 9) and rows[0]["captive"] is False
    assert rows[2]["captive"] is True and rows[1]["method"] == "hunter harvest"
    assert rows[3]["collected"] == dt.date(2022, 1, 1)


def test_norm_strips_county_words_and_saint():
    assert _norm("St. Tammany Parish") == _norm("Saint Tammany") == "sainttammany"
    assert _norm("Quitman County") == "quitman" and _norm("Doña Ana") == "doaana"
    assert _norm("Juneau City and Borough") == "juneau"


def test_county_index_bins_by_week_counts_captive_and_reports_unmatched_with_positive_control():
    rows, _ = parse_rows(CSV)
    idx, c = county_index(rows, county_lookup(SHAPES), dt.date(2026, 9, 11), weeks=4)
    assert c["unmatched"] == 1 and c["unmatched_names"] == 1, "Nebraska/Unknown cannot be placed"
    assert c["in_window"] == 4 and c["outside_window"] == 1 and c["counties"] == 2
    q = idx["13239"]
    assert q["n"] == 3 and q["n_all"] == 4
    assert q["weeks"] == [
        {"w": "2026-09-11", "n": 2, "captive": 0, "sp": {"Canada goose": 2}},
        {"w": "2026-08-28", "n": 1, "captive": 1, "sp": {"Bald eagle": 1}},
    ]
    assert q["species"]["Canada goose"] == 2
    # positive control: the Louisiana row matched through the parish/St. normalisation
    assert idx["22103"]["n"] == 1
    # a county with detections only outside the window is not emitted
    idx2, _ = county_index(rows[3:4], county_lookup(SHAPES), dt.date(2026, 9, 11), weeks=4)
    assert idx2 == {}


def test_to_features_carries_shape_and_properties():
    rows, _ = parse_rows(CSV)
    idx, _ = county_index(rows, county_lookup(SHAPES), dt.date(2026, 9, 11), 4)
    feats = to_features(idx, SHAPES)
    assert [f["properties"]["fips"] for f in feats] == ["13239", "22103"]
    assert feats[0]["properties"]["st"] == "GA" and feats[0]["geometry"]["type"] == "Polygon"
    json.dumps(feats)


def test_main_end_to_end(tmp_path, monkeypatch):
    import pipeline.hpai as m
    monkeypatch.setattr(m, "load_county_shapes", lambda zip_path, wanted, fetch_bytes=None: SHAPES)
    src = tmp_path / "in.csv"
    src.write_text(CSV)
    out = tmp_path / "hpai.geojson"
    main(["--out", str(out), "--csv", str(src), "--today", "2026-09-11", "--weeks", "4", "--cache", str(tmp_path)])
    gj = json.loads(out.read_text())
    assert gj["newest"] == "2026-09-09" and gj["weeks"][0] == "2026-09-11" and len(gj["features"]) == 2
    assert gj["counts"]["unmatched"] == 1 and gj["counts"]["no_date"] == 1
    assert "Public Domain" in gj["source"]["licence"]


# --- fetching from usda.gov --------------------------------------------------------------
# Akamai in front of usda.gov answers 403 Access Denied to a request without the headers a
# browser sends. Measured 2026-10-06 with urllib from the cron's connection: the wildeye
# User-Agent plus Accept, Accept-Encoding: gzip and Accept-Language got 200; without
# Accept-Language, or with the User-Agent alone (what hpai.py sent), 403. _Akamai replays that
# rule, so it encodes the measurement; the live check is run_hpai.sh.
import gzip
import urllib.error
import urllib.request

import pytest

ACCESS_DENIED = b"""<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;www&#46;aphis&#46;usda&#46;gov&#47;sites&#47;default&#47;files&#47;hpai&#45;wild&#45;birds&#46;csv" on this server.<P>
</BODY>
</HTML>
"""


class _Resp:
    def __init__(self, body: bytes, headers: dict):
        self._body, self.headers = body, headers

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _akamai(monkeypatch, body: bytes, encoding: str | None = "gzip"):
    """Patch urllib.request.urlopen with the rule measured above. Returns the requests seen."""
    seen = []

    def fake(req, *a, **k):
        h = {k.lower(): v for k, v in req.header_items()}
        seen.append(h)
        if not all(k in h for k in ("user-agent", "accept", "accept-language")) or "gzip" not in h.get("accept-encoding", ""):
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)
        if encoding == "gzip":
            return _Resp(gzip.compress(body), {"Content-Encoding": "gzip"})
        return _Resp(body, {"Content-Encoding": encoding} if encoding else {})
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    return seen


def test_fetch_csv_sends_the_headers_akamai_wants_and_unzips_the_reply(monkeypatch):
    from pipeline.hpai import fetch_csv
    seen = _akamai(monkeypatch, b"\xef\xbb\xbf" + CSV.encode())
    assert fetch_csv() == CSV, "gzip body unzipped and the BOM stripped"
    assert seen[0]["user-agent"].startswith("wildeye/"), "still says who is asking"
    # positive control: a server that ignores Accept-Encoding and sends plain bytes
    _akamai(monkeypatch, CSV.encode(), encoding=None)
    assert fetch_csv() == CSV
    # an encoding we never asked for is an error, not bytes to parse
    _akamai(monkeypatch, CSV.encode(), encoding="br")
    with pytest.raises(RuntimeError, match="Content-Encoding 'br'"):
        fetch_csv()


def test_main_refuses_a_page_that_is_not_the_table_with_positive_control(tmp_path, monkeypatch):
    import pipeline.hpai as m
    monkeypatch.setattr(m, "load_county_shapes", lambda zip_path, wanted, fetch_bytes=None: SHAPES)
    out = tmp_path / "hpai.geojson"
    args = ["--out", str(out), "--today", "2026-09-11", "--weeks", "4", "--cache", str(tmp_path)]
    # an error page served with 200 parses to zero rows: refused, nothing written
    monkeypatch.setattr(m, "fetch_csv", lambda: ACCESS_DENIED.decode())
    with pytest.raises(RuntimeError, match="no dated detection rows"):
        main(args)
    assert not out.exists()
    # positive control: the table is written
    monkeypatch.setattr(m, "fetch_csv", lambda: CSV)
    main(args)
    assert len(json.loads(out.read_text())["features"]) == 2
