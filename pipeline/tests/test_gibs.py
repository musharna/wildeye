import json
from pathlib import Path

import pytest

import pipeline.gibs as g

FIX = Path(__file__).parent / "fixtures"
CAP = (FIX / "gibs_capabilities.xml").read_bytes()
IDS = {
    "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual",
    "MODIS_Terra_L3_EVI_16Day",
    "VIIRS_Black_Marble",
}


def test_parse_layers_reads_tiles_times_and_colormap_link():
    got = g.parse_layers(CAP, IDS)
    assert set(got) == IDS  # the NDVI decoy is not picked up
    lc = got["MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual"]
    assert (
        lc["tileMatrixSet"] == "GoogleMapsCompatible_Level8" and lc["maximumLevel"] == 8
    )
    assert lc["format"] == "png"
    assert lc["times"] == ["2001-01-01/2024-01-01/P1Y"]
    assert lc["colormapUrl"].endswith("/colormaps/v1.3/MODIS_IGBP_Land_Cover_Type.xml")
    evi = got["MODIS_Terra_L3_EVI_16Day"]
    assert evi["times"][0].startswith("2000-03-05/") and evi["times"][0].endswith(
        "/P16D"
    )
    assert (
        len(evi["times"]) > 20
    )  # one interval per year: 16-day composites restart each January
    assert got["VIIRS_Black_Marble"]["colormapUrl"] is None


def test_parse_layers_fails_loud_when_a_layer_is_gone():
    with pytest.raises(LookupError, match="MODIS_Renamed_Layer"):
        g.parse_layers(CAP, IDS | {"MODIS_Renamed_Layer"})


def test_colormap_classes_keep_nasa_labels_and_colours():
    cm = g.parse_colormap((FIX / "gibs_colormap_classes.xml").read_bytes())
    assert cm["classes"][0] == {
        "label": "Evergreen Needleleaf Forests",
        "rgb": [33, 138, 33],
    }
    assert cm["classes"][-1]["label"] == "Unclassified"
    assert len(cm["classes"]) == 18 and "ramp" not in cm


def test_colormap_ramp_uses_the_data_map_not_the_no_data_map():
    cm = g.parse_colormap((FIX / "gibs_colormap_ramp.xml").read_bytes())
    assert "classes" not in cm
    r = cm["ramp"]
    assert (r["min"], r["max"], r["unit"]) == (200.0, 350.0, " K")
    assert (
        len(r["stops"]) == 9
        and r["stops"][0] == [201, 0, 255]
        and r["stops"][-1] == [255, 1, 0]
    )


def test_build_writes_nothing_when_any_fetch_fails(tmp_path):
    out = tmp_path / "gibs.json"
    out.write_text('{"old": true}')

    def fetch(url):
        if "colormaps" in url:
            raise OSError("GIBS colormap down")
        return CAP

    layers = {k: v for k, v in g.LAYERS.items() if v["gibsId"] in IDS}
    with pytest.raises(OSError, match="colormap down"):
        g.main(["--out", str(out)], fetch=fetch, layers=layers)
    assert json.loads(out.read_text()) == {"old": True}


def test_build_keys_by_wildeye_id_and_carries_captions(tmp_path):
    out = tmp_path / "gibs.json"
    cls = (FIX / "gibs_colormap_classes.xml").read_bytes()
    ramp = (FIX / "gibs_colormap_ramp.xml").read_bytes()

    def fetch(url):
        if "IGBP" in url:
            return cls
        return ramp if "colormaps" in url else CAP

    layers = {k: v for k, v in g.LAYERS.items() if v["gibsId"] in IDS}
    assert g.main(["--out", str(out)], fetch=fetch, layers=layers) == 0
    doc = json.loads(out.read_text())
    assert set(doc["layers"]) == {"gibs-landcover", "gibs-evi", "gibs-nightlights"}
    assert (
        doc["layers"]["gibs-landcover"]["classes"][0]["label"]
        == "Evergreen Needleleaf Forests"
    )
    bm = doc["layers"]["gibs-nightlights"]
    assert "classes" not in bm and "ramp" not in bm and bm["legend"]  # caption only
