import datetime as dt
from pipeline.wastewater import (clean_rows, site_trend, week_ends, county_index, to_features, fetch_rows,
                                 EXCLUDED_SOURCES, PAGE)

D = dt.date(2026, 9, 11)


def row(site, date, conc, fips="01001", pop="1000", source="State_Territory", detect="yes"):
    return {"site": site, "state_territory": "al", "source": source, "county_fips": fips,
            "population_served": pop, "sample_collect_date": date, "pcr_target_avg_conc": str(conc),
            "pcr_target_detect": detect}


def test_clean_drops_excluded_source_and_bad_rows_keeps_good_ones_splits_multi_county():
    rows = [row("a", "2026-09-01", 100),
            row("b", "2026-09-01", 100, source=EXCLUDED_SOURCES[0]),
            row("c", "not-a-date", 100), row("d", "2026-09-01", "nan"), row("e", "2026-09-01", 5, fips=""),
            row("f", "2026-09-01", 900, fips="06075, 06081", detect="no")]
    out = clean_rows(rows)
    assert [r["site"] for r in out] == ["a", "f"]          # positive control: a and f survive
    assert out[1]["fips"] == ["06075", "06081"] and out[1]["conc"] == 0.0  # non-detect → 0


def test_site_trend_windows_and_min_samples():
    s = [(D - dt.timedelta(days=k), 100.0) for k in range(15, 30)]   # prior window: 100
    s += [(D - dt.timedelta(days=k), 1000.0) for k in range(0, 15)]  # recent window: 1000
    t = site_trend(s, D)
    assert abs(t - 1.0) < 0.01                       # 10x rise ≈ +1.0 log10
    assert site_trend(s[:16], D) is None             # recent window has 1 sample < MIN_SAMPLES
    assert site_trend([], D) is None
    flat = [(D - dt.timedelta(days=k), 50.0) for k in range(0, 30)]
    assert site_trend(flat, D) == 0.0                # positive control: flat series → 0
    # one wild sample (unit slip) must not swing the trend: median, not mean
    spiked = flat[:1] + [(D, 5e7)] + flat[1:]
    assert abs(site_trend(spiked, D)) < 0.05
    # and a million-fold artefact is clamped to the display range
    art = [(D - dt.timedelta(days=k), 0.0) for k in range(15, 30)] + [(D - dt.timedelta(days=k), 1e7) for k in range(0, 15)]
    assert site_trend(art, D) == 2.0


def test_week_ends_newest_first():
    assert week_ends(D, 3) == [D, D - dt.timedelta(days=7), D - dt.timedelta(days=14)]


def test_county_index_population_weights_and_multi_county_membership():
    rows = []
    for k in range(0, 30):
        d = (D - dt.timedelta(days=k)).isoformat()
        rows.append(row("big", d, 1000 if k < 15 else 100, fips="01001", pop="9000"))   # +1.0
        rows.append(row("small", d, 100 if k < 15 else 1000, fips="01001, 01003", pop="1000"))  # -1.0
    idx = county_index(clean_rows(rows), D, weeks=2)
    c = idx["01001"]
    assert c["sites"] == 2 and c["pop"] == 10000
    assert abs(c["weeks"][0]["t"] - 0.8) < 0.02 and c["weeks"][0]["n"] == 2   # (9000*1 + 1000*-1)/10000
    assert idx["01003"]["sites"] == 1 and abs(idx["01003"]["weeks"][0]["t"] + 1.0) < 0.02
    assert c["weeks"][1]["w"] == (D - dt.timedelta(days=7)).isoformat()


def test_to_features_reports_missing_shapes():
    counties = {"01001": {"sites": 1, "pop": 5, "st": "AL", "weeks": [{"w": "2026-09-11", "t": None, "n": 0},
                                                                     {"w": "2026-09-04", "t": 0.2, "n": 1}]},
                "99999": {"sites": 1, "pop": 5, "st": "ZZ", "weeks": []}}
    shapes = {"01001": {"name": "Autauga", "st": "AL", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}}}
    feats, missing = to_features(counties, shapes)
    assert missing == ["99999"] and len(feats) == 1
    p = feats[0]["properties"]
    assert p["trend"] == 0.2 and p["name"] == "Autauga" and p["fips"] == "01001"


def test_fetch_rows_pages_and_filters_server_side():
    urls = []

    def fetch(u, timeout=120):
        urls.append(u)
        return [row("x", "2026-09-01", 1)] * (PAGE if len(urls) == 1 else 3)

    out = fetch_rows(dt.date(2026, 7, 1), fetch)
    assert len(out) == PAGE + 3 and len(urls) == 2
    assert "offset=50000" in urls[1] and "WastewaterSCAN" in urls[0] and "sars-cov-2" in urls[0]


def test_main_end_to_end_writes_parseable_geojson(tmp_path, monkeypatch):
    import json
    import pipeline.wastewater as ww
    rows = [row("a", (D - dt.timedelta(days=k)).isoformat(), 1000 if k < 15 else 100) for k in range(30)]
    monkeypatch.setattr(ww, "fetch_rows", lambda since, fetch=None: rows)
    monkeypatch.setattr(ww, "load_county_shapes", lambda zp, wanted, fetch_bytes=None: {
        "01001": {"name": "Autauga", "st": "AL", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}}})
    out = tmp_path / "w.geojson"
    assert ww.main(["--out", str(out), "--weeks", "2", "--today", D.isoformat(), "--cache", str(tmp_path)]) == 0
    g = json.loads(out.read_text())
    assert g["type"] == "FeatureCollection" and g["counts"]["counties"] == 1   # a dict, not a JSON string
    assert abs(g["features"][0]["properties"]["trend"] - 1.0) < 0.01
    assert g["source"]["licence"] == "Public Domain U.S. Government"
