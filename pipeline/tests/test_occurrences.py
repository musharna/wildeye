import json
from pathlib import Path
from pipeline.occurrences import (
    licence_ok,
    normalise_gbif,
    normalise_obis,
    dedupe,
    to_feature,
)

TAXON = {
    "id": "humpback",
    "name": "Humpback whale",
    "sci": "Megaptera novaeangliae",
    "gbif_key": 5220086,
    "group": "whales",
    "icon": "🐋",
}


def test_licence_filter_keeps_cc0_ccby_only():
    assert licence_ok("https://creativecommons.org/publicdomain/zero/1.0/")
    assert licence_ok("http://creativecommons.org/licenses/by/4.0/legalcode")
    assert licence_ok("CC_BY_4_0")
    assert not licence_ok("http://creativecommons.org/licenses/by-nc/4.0/legalcode")
    assert not licence_ok("https://creativecommons.org/licenses/by-sa/4.0")
    assert not licence_ok("https://creativecommons.org/licenses/by-nc-sa/4.0")
    assert not licence_ok("Copyright Someone. No use without permission.")
    assert not licence_ok(None)


def test_normalise_drops_nc_and_missing_coords():
    ok = {
        "key": 1,
        "eventDate": "2026-08-02T18:24:01",
        "decimalLatitude": 49.49,
        "decimalLongitude": -124.67,
        "license": "http://creativecommons.org/licenses/by/4.0/legalcode",
        "datasetName": "X",
        "basisOfRecord": "HUMAN_OBSERVATION",
    }
    r = normalise_gbif(ok, TAXON)
    assert (
        r["date"] == "2026-08-02" and r["url"].endswith("/1") and r["source"] == "gbif"
    )
    assert (
        normalise_gbif(
            ok | {"license": "http://creativecommons.org/licenses/by-nc/4.0/legalcode"},
            TAXON,
        )
        is None
    )
    assert normalise_gbif(ok | {"decimalLatitude": None}, TAXON) is None
    assert normalise_gbif(ok | {"eventDate": "2026"}, TAXON) is None
    o = normalise_obis(
        {
            "eventDate": "2026-07-16T17:52:55-02:30",
            "decimalLatitude": 48.7,
            "decimalLongitude": -53.09,
            "license": "https://creativecommons.org/publicdomain/zero/1.0/",
            "dataset_id": "abc",
        },
        TAXON,
    )
    assert (
        o["date"] == "2026-07-16"
        and o["source"] == "obis"
        and o["url"] == "https://obis.org/dataset/abc"
    )


def test_dedupe_merges_same_day_same_cell_across_sources():
    a = {
        "taxon": "humpback",
        "date": "2026-08-02",
        "lat": 57.74509,
        "lon": 10.63559,
        "source": "gbif",
    }
    b = {**a, "lat": 57.7452, "lon": 10.6356, "source": "obis"}  # same 0.001° cell
    c = {**a, "lat": 57.80}  # different cell
    d = dedupe([a, b, c])
    assert len(d) == 2 and d[0]["source"] == "gbif"


def test_feature_schema():
    r = {
        "taxon": "humpback",
        "date": "2026-08-02",
        "lat": 1.0,
        "lon": 2.0,
        "source": "gbif",
        "dataset": "X",
        "license": "CC0",
        "basis": "HUMAN_OBSERVATION",
        "url": None,
    }
    f = to_feature(r, TAXON)
    assert f["geometry"]["coordinates"] == [2.0, 1.0]
    for k in (
        "taxon",
        "name",
        "sci",
        "group",
        "icon",
        "date",
        "source",
        "dataset",
        "license",
        "basis",
        "url",
    ):
        assert k in f["properties"], k
    json.dumps(f)


def test_taxa_config_is_well_formed():
    taxa = json.loads((Path(__file__).parents[1] / "taxa.json").read_text())
    ids = [t["id"] for t in taxa]
    assert len(ids) == len(set(ids))
    for t in taxa:
        assert isinstance(t["gbif_key"], int) and t["sci"] and t["group"] and t["icon"]


def test_licence_label_never_collapses_distinct_licences():
    from pipeline.occurrences import licence_label
    assert licence_label("https://creativecommons.org/publicdomain/zero/1.0") == "CC0 1.0"
    assert licence_label("http://creativecommons.org/licenses/by/4.0/legalcode") == "CC BY 4.0"
    assert licence_label("CC_BY_4_0") == "CC BY 4.0"
    assert licence_label(None) == "unknown"
    assert licence_label("https://example.org/odd") == "https://example.org/odd"


def test_gbif_records_flags_truncation_at_cap(monkeypatch):
    import pipeline.occurrences as occ
    page = {"results": [{"key": i, "eventDate": "2026-08-02", "decimalLatitude": 1.0, "decimalLongitude": 2.0,
                          "license": "CC_BY_4_0", "datasetKey": "dk"} for i in range(300)], "endOfRecords": False}
    monkeypatch.setattr(occ, "_get_json", lambda url, timeout=60: page)
    recs, truncated = occ.gbif_records(TAXON, None, None, cap=600)
    assert truncated is True and len(recs) == 600
    small = {"results": page["results"][:5], "endOfRecords": True}
    monkeypatch.setattr(occ, "_get_json", lambda url, timeout=60: small)
    recs, truncated = occ.gbif_records(TAXON, None, None, cap=600)
    assert truncated is False and len(recs) == 5  # positive control: uncapped run is not flagged


def test_feature_carries_provenance_and_resolve_datasets_dedupes_and_records_failure():
    from pipeline.occurrences import resolve_datasets
    r = {"taxon": "humpback", "date": "2026-08-02", "lat": 1.0, "lon": 2.0, "source": "gbif", "dataset": "X",
         "dataset_key": "dk1", "license": "http://creativecommons.org/licenses/by/4.0/legalcode",
         "uncertainty_m": 30.0, "basis": "HUMAN_OBSERVATION", "url": None}
    f = to_feature(r, TAXON)
    assert f["properties"]["dataset_key"] == "dk1" and f["properties"]["license_label"] == "CC BY 4.0"
    assert f["properties"]["uncertainty_m"] == 30.0
    calls = []
    def fg(k): calls.append(k); return {"source": "gbif", "title": "T", "doi": "10.1/x", "publisher": "P"}
    def fo(k): raise RuntimeError("obis down")
    ds = resolve_datasets([r, r, {**r, "source": "obis", "dataset_key": "ok1"}], fetch_gbif=fg, fetch_obis=fo)
    assert calls == ["dk1"] and ds["dk1"]["doi"] == "10.1/x"
    assert "error" in ds["ok1"] and ds["ok1"]["title"] == "X"


def test_npn_adapter_keeps_only_observed_phenophases_and_carries_cc_by():
    from pipeline.occurrences import npn_records, normalise_npn, resolve_datasets, NPN_DATASET_KEY
    import datetime as dt
    taxon = {**TAXON, "id": "common-milkweed", "npn_species_id": 199}
    rows = [
        {"observation_date": "2026-08-01", "latitude": 38.4, "longitude": -78.9, "phenophase_status": 1, "phenophase_description": "Fruits"},
        {"observation_date": "2026-08-01", "latitude": 38.4, "longitude": -78.9, "phenophase_status": 0, "phenophase_description": "Fruits"},
        {"observation_date": "2026-08-02", "latitude": 38.4, "longitude": -78.9, "phenophase_status": -1, "phenophase_description": "Fruits"},
        {"observation_date": "bad", "latitude": 1, "longitude": 2, "phenophase_status": 1},
    ]
    seen = []
    recs, truncated = npn_records(taxon, dt.date(2026, 8, 1), dt.date(2026, 9, 1), fetch=lambda u, timeout=180: (seen.append(u), rows)[1])
    assert "species_id%5B0%5D=199" in seen[0] and "start_date=2026-08-01" in seen[0]
    assert truncated is False and len(recs) == 1
    assert recs[0]["source"] == "npn" and recs[0]["basis"] == "phenophase: Fruits" and "licenses/by/4.0" in recs[0]["license"]
    assert npn_records(TAXON, dt.date(2026, 8, 1), dt.date(2026, 9, 1), fetch=lambda *a, **k: (_ for _ in ()).throw(AssertionError("no npn id → no call"))) == ([], False)
    assert normalise_npn({"phenophase_status": 1, "observation_date": "2026-08-01", "latitude": None, "longitude": 1}, taxon) is None
    ds = resolve_datasets(recs, fetch_gbif=lambda k: 1 / 0, fetch_obis=lambda k: 1 / 0)
    assert ds[NPN_DATASET_KEY]["publisher"] == "USA National Phenology Network" and "Nature's Notebook" in ds[NPN_DATASET_KEY]["citation"]


def test_xc_adapter_keeps_cc_by_only_within_recording_window_and_pages(monkeypatch):
    import datetime as dt
    from pipeline.occurrences import xc_records, normalise_xc, resolve_datasets, XC_DATASET_KEY, XC_TAXON, to_feature
    rec = lambda **k: {"id": "1", "gen": "Hirundo", "sp": "rustica", "en": "Barn Swallow", "lat": "48.0", "lon": "11.0", "date": "2026-08-20", "lic": "https://creativecommons.org/licenses/by/4.0/", "rec": "A. Recordist", "q": "A", "grp": "birds", "type": "song", **k}
    pages = {1: {"numPages": 2, "recordings": [rec(), rec(id="2", lic="https://creativecommons.org/licenses/by-nc-sa/4.0/"), rec(id="3", date="2024-08-25"), rec(id="4", lat=None)]},
             2: {"numPages": 2, "recordings": [rec(id="5", lic="https://creativecommons.org/publicdomain/zero/1.0/")]}}
    seen = []
    def fetch(url, timeout=120):
        seen.append(url); return pages[int(url.rsplit("page=", 1)[1])]
    monkeypatch.setattr("pipeline.occurrences.time.sleep", lambda s: None)
    recs, trunc = xc_records(dt.date(2026, 8, 1), dt.date(2026, 9, 1), "k", fetch)
    assert [r["url"] for r in recs] == ["https://xeno-canto.org/1", "https://xeno-canto.org/5"], "NC-SA, out-of-window date and missing lat dropped"
    assert trunc is False and len(seen) == 2 and "lic%3Aby" in seen[0] and "key=k" in seen[0]
    assert recs[0]["taxon"] == "xc:hirundo-rustica" and recs[0]["basis"] == "birds song by A. Recordist (quality A)"
    # no key → nothing, no call
    assert xc_records(dt.date(2026, 8, 1), dt.date(2026, 9, 1), None, lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not call"))) == ([], False)
    # API error surfaces
    try:
        xc_records(dt.date(2026, 8, 1), dt.date(2026, 9, 1), "k", lambda u, timeout=120: {"error": "unauthorized"}); assert False
    except RuntimeError as e:
        assert "unauthorized" in str(e)
    # positive control: page limit marks truncation
    _, t2 = xc_records(dt.date(2026, 8, 1), dt.date(2026, 9, 1), "k", fetch, page_limit=1)
    assert t2 is True
    f = to_feature(recs[0], {**XC_TAXON, "id": recs[0]["taxon"], "name": recs[0]["name"], "sci": recs[0]["sci"]})
    assert f["properties"]["group"] == "sounds" and f["properties"]["license_label"] == "CC BY 4.0"
    assert resolve_datasets(recs)[XC_DATASET_KEY]["publisher"] == "Xeno-canto Foundation"


def test_nas_adapter_pages_each_year_and_keeps_only_dated_located_rows_in_window(monkeypatch):
    import datetime as dt
    from pipeline.occurrences import nas_records, normalise_nas, resolve_datasets, NAS_DATASET_KEY, NAS_TAXON, to_feature
    rec = lambda **k: {"key": 1, "scientificName": "Dreissena polymorpha", "commonName": "zebra mussel", "group": "Mollusks-Bivalves", "year": 2026, "month": 8, "day": 20,
                       "decimalLatitude": 41.9, "decimalLongitude": -80.8, "state": "Ohio", "county": "Ashtabula", "status": "established", "recordType": "NAS sighting report", "speciesID": 5, **k}
    pages = {("2025", "0"): {"endOfRecords": "true", "results": [rec(year=2025, month=12, day=30)]},
             ("2026", "0"): {"endOfRecords": "false", "results": [rec(), rec(month=None), rec(decimalLatitude=None), rec(year=2026, month=9, day=30)]},
             ("2026", "2000"): {"endOfRecords": "true", "results": [rec(key=2, scientificName="Pterois volitans/miles", commonName="lionfish", month=8, day=21)]}}
    seen = []
    def fetch(url, timeout=300):
        seen.append(url); q = dict(x.split("=") for x in url.split("?")[1].split("&")); return pages[(q["year"], q["offset"])]
    monkeypatch.setattr("pipeline.occurrences.time.sleep", lambda s: None)
    recs, trunc = nas_records(dt.date(2025, 12, 1), dt.date(2026, 9, 12), fetch)
    assert [r["date"] for r in recs] == ["2025-12-30", "2026-08-20", "2026-08-21"], "no month, no coords and a future date are dropped"
    assert trunc is False and len(seen) == 3 and "year=2025" in seen[0] and "offset=2000" in seen[2]
    assert recs[2]["taxon"] == "nas:pterois-volitans-miles" and recs[1]["basis"] == "Mollusks-Bivalves · NAS sighting report · established · Ohio, Ashtabula County"
    assert recs[1]["url"].endswith("SpeciesID=5") and recs[1]["license"].startswith("Public Domain")
    _, t2 = nas_records(dt.date(2026, 1, 1), dt.date(2026, 9, 12), fetch, page_limit=1)
    assert t2 is True, "page limit reports truncation"
    assert normalise_nas(rec(scientificName=""), dt.date(2026, 1, 1), dt.date(2026, 12, 31)) is None
    f = to_feature(recs[1], {**NAS_TAXON, "id": recs[1]["taxon"], "name": recs[1]["name"], "sci": recs[1]["sci"]})
    assert f["properties"]["group"] == "invasives" and f["properties"]["icon"] == "🦞"
    assert resolve_datasets(recs)[NAS_DATASET_KEY]["publisher"] == "U.S. Geological Survey"
