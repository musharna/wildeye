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
