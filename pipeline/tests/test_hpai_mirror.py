import datetime as dt
import hashlib
import json

import pytest

from pipeline.tests.test_hpai import CSV

# What usda.gov sends the home connection instead of the CSV (2026-10-06), reference number shortened.
ACCESS_DENIED = """<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;www&#46;aphis&#46;usda&#46;gov&#47;sites&#47;default&#47;files&#47;hpai&#45;wild&#45;birds&#46;csv" on this server.<P>
Reference&#32;&#35;18&#46;aa132817
</BODY>
</HTML>
"""


def test_check_table_refuses_what_is_not_the_detection_table_with_positive_control():
    from pipeline.hpai_mirror import check_table

    assert check_table(CSV) == {"rows": 7, "dated": 6, "newest": "2026-09-09"}
    with pytest.raises(ValueError, match="missing columns"):
        check_table(ACCESS_DENIED)
    with pytest.raises(ValueError, match="no row with a detection date"):
        check_table(CSV.splitlines()[0] + "\n")


def test_main_writes_the_csv_and_a_sidecar_that_matches_it(tmp_path, monkeypatch):
    import pipeline.hpai_mirror as m

    monkeypatch.setattr(m, "fetch_csv", lambda: CSV)
    m.main(["--out-dir", str(tmp_path)])
    body = (tmp_path / "hpai-wild-birds.csv").read_bytes()
    meta = json.loads((tmp_path / "hpai-wild-birds.json").read_text())
    assert body.decode() == CSV
    assert meta["sha256"] == hashlib.sha256(body).hexdigest()
    assert meta["rows"] == 7 and meta["newest"] == "2026-09-09"
    assert (
        meta["source"]
        == "https://www.aphis.usda.gov/sites/default/files/hpai-wild-birds.csv"
    )
    fetched = dt.datetime.strptime(meta["fetched_at"], "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=dt.UTC
    )
    assert abs(dt.datetime.now(dt.UTC) - fetched) < dt.timedelta(minutes=5)
    # what hpai.py reads back is what was fetched
    import pipeline.hpai as h
    from pipeline.hpai import fetch_mirror

    monkeypatch.setattr(
        h,
        "_get",
        lambda url, timeout: body if url == h.MIRROR_CSV else json.dumps(meta).encode(),
    )
    assert fetch_mirror(dt.datetime.now(dt.UTC))[0] == CSV


def test_main_writes_nothing_when_usda_gov_sends_access_denied(tmp_path, monkeypatch):
    import pipeline.hpai_mirror as m

    monkeypatch.setattr(m, "fetch_csv", lambda: ACCESS_DENIED)
    with pytest.raises(ValueError, match="missing columns"):
        m.main(["--out-dir", str(tmp_path)])
    assert list(tmp_path.iterdir()) == []
