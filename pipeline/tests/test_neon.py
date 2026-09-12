import datetime as dt
import json
from pipeline.neon import fetch_sites, fetch_month_csv, month_summary, recent_months, build, main, PRODUCT

CSV = """uid,siteID,plotID,trapStatus,collectDate,tagID,taxonID,scientificName,fate
1,ABBY,ABBY_001,5 - capture,2026-07-06T00:00Z,T1,PEMA,Peromyscus maniculatus,processed
2,ABBY,ABBY_001,5 - capture,2026-07-07T00:00Z,T1,PEMA,Peromyscus maniculatus,processed
3,ABBY,ABBY_001,5 - capture,2026-07-07T00:00Z,,MIOR,Microtus oregoni,escaped
4,ABBY,ABBY_001,6 - trap set and empty,2026-07-06T00:00Z,,,,
5,ABBY,ABBY_001,1 - trap not set,2026-07-06T00:00Z,,,,
6,ABBY,ABBY_001,3 - trap door open or closed w/ spoor left,2026-07-06T00:00Z,,,,
"""


def test_month_summary_counts_set_traps_captures_individuals_species():
    s = month_summary(CSV)
    assert s == {"trapnights": 5, "captures": 3, "per100": 60.0, "individuals": 1, "species": {"Peromyscus maniculatus": 2, "Microtus oregoni": 1}}
    assert month_summary("uid,trapStatus\n1,1 - trap not set\n")["per100"] is None


def test_recent_months_wraps_year():
    assert recent_months(dt.date(2026, 2, 10), 4) == ["2026-02", "2026-01", "2025-12", "2025-11"]


def test_fetch_sites_and_month_csv_parse_api_shapes():
    sites_json = json.dumps({"data": [
        {"siteCode": "ABBY", "siteName": "Abby Road NEON", "siteLatitude": 45.76, "siteLongitude": -122.33, "siteType": "GRADIENT",
         "dataProducts": [{"dataProductCode": PRODUCT, "availableMonths": ["2026-07", "2026-05"]}, {"dataProductCode": "DP1.10093.001", "availableMonths": ["2026-07"]}]},
        {"siteCode": "HARV", "siteName": "Harvard", "siteLatitude": 42.5, "siteLongitude": -72.2, "siteType": "CORE", "dataProducts": [{"dataProductCode": "DP1.10093.001", "availableMonths": ["2026-07"]}]},
    ]}).encode()
    seen = []
    def fetch(url, timeout=120, token=None):
        seen.append((url, token))
        if url.endswith("/sites"):
            return sites_json
        if "/data/" in url:
            return json.dumps({"data": {"release": "PROVISIONAL", "files": [
                {"name": "NEON.D16.ABBY.DP1.10072.001.mam_perplotnight.2026-07.basic.x.csv", "url": "https://f/plot"},
                {"name": "NEON.D16.ABBY.DP1.10072.001.mam_pertrapnight.2026-07.expanded.x.csv", "url": "https://f/exp"},
                {"name": "NEON.D16.ABBY.DP1.10072.001.mam_pertrapnight.2026-07.basic.x.csv", "url": "https://f/basic"}]}}).encode()
        assert url == "https://f/basic", url
        return CSV.encode()
    sites = fetch_sites(fetch, token="tok")
    assert sites == [{"code": "ABBY", "name": "Abby Road NEON", "lat": 45.76, "lon": -122.33, "type": "GRADIENT", "months": ["2026-05", "2026-07"]}]
    assert seen[0][1] == "tok", "token header goes to the API"
    text, release = fetch_month_csv("ABBY", "2026-07", fetch, token="tok")
    assert release == "PROVISIONAL" and "Peromyscus" in text
    # no basic table file → None
    assert fetch_month_csv("ABBY", "2026-07", lambda u, timeout=120, token=None: json.dumps({"data": {"files": []}}).encode()) is None


def test_build_skips_months_not_available_and_empty_effort_with_positive_control():
    sites = [{"code": "ABBY", "name": "Abby", "lat": 45.76, "lon": -122.33, "type": "GRADIENT", "months": ["2026-07", "2026-06", "2026-05"]}]
    calls = []
    def fm(site, month):
        calls.append(month)
        if month == "2026-06":
            return None
        if month == "2026-05":
            return ("uid,trapStatus\n1,1 - trap not set\n", "RELEASE-2026")
        return (CSV, "PROVISIONAL")
    feats, c = build(sites, ["2026-08", "2026-07", "2026-06", "2026-05"], fm, sleep=0)
    assert calls == ["2026-07", "2026-06", "2026-05"], "2026-08 is not available and is never requested"
    assert c == {"sites": 1, "site_months": 1, "captures": 3, "trapnights": 5, "provisional": 1, "empty": 2}
    p = feats[0]["properties"]
    assert p["months"] == [{"m": "2026-07", "release": "PROVISIONAL", "trapnights": 5, "captures": 3, "per100": 60.0, "individuals": 1, "species": {"Peromyscus maniculatus": 2, "Microtus oregoni": 1}}]
    assert p["species"]["Peromyscus maniculatus"] == 2 and feats[0]["geometry"]["coordinates"] == [-122.33, 45.76]
    # a site with no usable months is not emitted
    assert build(sites, ["2026-06"], fm, sleep=0)[0] == []


def test_main_end_to_end(tmp_path, monkeypatch):
    import pipeline.neon as m
    monkeypatch.setenv("NEON_TOKEN", "tok")
    monkeypatch.setattr(m, "fetch_sites", lambda fetch=None, token=None: [{"code": "ABBY", "name": "Abby", "lat": 1.0, "lon": 2.0, "type": "CORE", "months": ["2026-07"]}])
    monkeypatch.setattr(m, "fetch_month_csv", lambda s, mo, fetch=None, token=None: (CSV, "PROVISIONAL"))
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    out = tmp_path / "neon.geojson"
    main(["--out", str(out), "--months", "3", "--today", "2026-09-12"])
    gj = json.loads(out.read_text())
    assert gj["months"] == ["2026-09", "2026-08", "2026-07"] and len(gj["features"]) == 1 and "CC BY 4.0" in gj["source"]["licence"]
    assert gj["counts"]["captures"] == 3
    monkeypatch.delenv("NEON_TOKEN")
    try:
        main(["--out", str(out)]); assert False
    except RuntimeError as e:
        assert "NEON_TOKEN" in str(e)
