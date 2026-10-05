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


def test_a_missing_colour_map_link_is_an_error_where_one_is_expected(tmp_path):
    # Review 2026-09-22: only a failed colour-map *fetch* raised; a dropped link wrote a caption-only
    # legend and exited 0. Black Marble is true colour and has none, which must still pass.
    out = tmp_path / "gibs.json"
    out.write_text('{"old": true}')
    cls = (FIX / "gibs_colormap_classes.xml").read_bytes()
    ramp = (FIX / "gibs_colormap_ramp.xml").read_bytes()
    no_evi_map = CAP.replace(
        b"colormaps/v1.3/MODIS_L3_EVI.xml", b"colormaps/v1.2/MODIS_L3_EVI.xml"
    )
    assert no_evi_map != CAP

    def fetch_from(cap):
        return lambda url: cls if "IGBP" in url else ramp if "colormaps" in url else cap

    layers = {k: v for k, v in g.LAYERS.items() if v["gibsId"] in IDS}
    with pytest.raises(LookupError, match="gibs-evi"):
        g.main(["--out", str(out)], fetch=fetch_from(no_evi_map), layers=layers)
    assert json.loads(out.read_text()) == {"old": True}
    assert g.main(["--out", str(out)], fetch=fetch_from(CAP), layers=layers) == 0
    assert "gibs-nightlights" in json.loads(out.read_text())["layers"]


def test_ramp_decode_table_is_every_data_entry_with_its_interval():
    cm = g.parse_colormap((FIX / "gibs_colormap_ramp.xml").read_bytes())  # LST, K
    d = cm["decode"]
    assert len(d) == 252  # 253 entries minus the one nodata entry
    assert d[-1] == [255, 1, 0, 350.02, 652.0]
    assert all(len(e) == 5 and e[3] < e[4] for e in d)
    assert len({tuple(e[:3]) for e in d}) == len(d)  # exact lookup needs unique colours
    assert cm["ramp"]["stops"][-1] == [255, 1, 0]  # the legend is unchanged


def test_evi_decode_table_from_the_real_colormap():
    cm = g.parse_colormap((FIX / "gibs_colormap_evi.xml").read_bytes())
    d = cm["decode"]
    assert len(d) == 134
    assert d[-1] == [0, 0, 1, 0.9751, 1.0001]
    assert not any(
        e[3] < -0.2 for e in d
    )  # the nodata "Classifications" map is not in it


def test_class_layers_carry_no_decode_table():
    cm = g.parse_colormap((FIX / "gibs_colormap_classes.xml").read_bytes())
    assert "decode" not in cm and len(cm["classes"]) == 18


def test_an_open_ended_bin_is_stored_with_a_null_end():
    # GEDI's real colour map ends with value="[250,+INF)"; JSON has no infinity, so the open end is null
    # and the browser reads "≥ 250". The live pipeline run raised on it (2026-09-23), the fixtures did not.
    cm = g.parse_colormap((FIX / "gibs_colormap_gedi.xml").read_bytes())
    d = cm["decode"]
    assert d[-1][3:] == [250.0, None]
    assert all(
        e[4] is not None and e[3] < e[4] for e in d[:-1]
    )  # every closed bin still parses
    json.dumps(cm, allow_nan=False)  # and the manifest stays strict JSON
    with pytest.raises(ValueError, match="unparseable colour-map value 'x'"):
        g._interval("x")


def test_the_data_map_is_the_opaque_one_even_beside_a_two_entry_no_data_map():
    # SEDAC's real colour map (2026-10-02): its No Data map lists "No Species" and "No Data", two legend
    # entries, both transparent; "more than one legend entry" picked both and raised.
    cm = g.parse_colormap((FIX / "gibs_colormap_sedac.xml").read_bytes())
    r = cm["ramp"]
    assert (r["min"], r["max"], r["unit"]) == (1.0, 255.0, "")
    d = cm["decode"]
    assert (
        len(d) == 254
        and d[0] == [210, 255, 210, 1.0, 1.0]
        and d[-1] == [0, 128, 0, 255.0, 255.0]
    )
    assert len({tuple(e[:3]) for e in d}) == len(d)
    # the layers that passed before still find the same data map
    assert (
        len(g.parse_colormap((FIX / "gibs_colormap_evi.xml").read_bytes())["decode"])
        == 134
    )
    assert (
        len(
            g.parse_colormap((FIX / "gibs_colormap_classes.xml").read_bytes())[
                "classes"
            ]
        )
        == 18
    )


def test_a_single_value_is_an_exact_interval():
    assert g._interval("[12]") == (12.0, 12.0)
    assert g._interval("[12,13)") == (12.0, 13.0)
    for bad in ("[12", "12]", "[]"):
        with pytest.raises(ValueError, match="unparseable colour-map value"):
            g._interval(bad)


def _sedac_fetch(url):
    if "Amphibian" in url:
        return (FIX / "gibs_colormap_sedac.xml").read_bytes()
    if "IGBP" in url:
        return (FIX / "gibs_colormap_classes.xml").read_bytes()
    return CAP


def test_an_undated_layer_carries_the_year_of_its_data():
    layers = {
        "gibs-amphibians": g.LAYERS["gibs-amphibians"],
        "gibs-landcover": g.LAYERS["gibs-landcover"],
    }
    doc = g.build(_sedac_fetch, layers)
    am = doc["layers"]["gibs-amphibians"]
    assert am["times"] == [] and am["asOf"] == "2013" and am["maximumLevel"] == 7
    assert (
        "asOf" not in doc["layers"]["gibs-landcover"]
    )  # a dated layer keeps its served dates only
    undated = {k: v for k, v in layers["gibs-amphibians"].items() if k != "asOf"}
    with pytest.raises(
        LookupError,
        match="gibs-amphibians: GIBS serves no dates and LAYERS gives no asOf",
    ):
        g.build(_sedac_fetch, {"gibs-amphibians": undated})
    with pytest.raises(LookupError, match="gibs-landcover: GIBS serves dates, so asOf"):
        g.build(
            _sedac_fetch,
            {"gibs-landcover": {**layers["gibs-landcover"], "asOf": "2013"}},
        )


def test_no_data_colours_are_those_only_ever_transparent():
    # GIBS's empty SEDAC tile in EPSG:3857 is an all-black palette PNG with no tRNS chunk (probe 2026-10-02),
    # so the colour map's "No Data" black arrives opaque. A colour the map only ever declares transparent is
    # no data whatever its alpha; GEDI also draws black as data, so its black is not no data.
    def nodata(name):
        return g.parse_colormap((FIX / f"gibs_colormap_{name}.xml").read_bytes()).get(
            "noData"
        )

    assert nodata("sedac") == [[0, 0, 0], [255, 255, 255]]
    assert nodata("classes") == [[0, 0, 0]]
    assert nodata("ramp") == [[64, 64, 64]]
    assert (
        nodata("gedi") is None
    )  # black is a GEDI data colour as well as its no-data colour


def test_gpp_canopy_and_anthromes_are_listed_with_their_gibs_ids():
    # wave 2 (spec 2026-10-03-gibs-gpp-canopy-anthromes-design.md): ids and the undated layer's period
    want = {
        "gibs-gpp": "MODIS_Terra_L4_Gross_Primary_Productivity_8Day",
        "gibs-canopy": "GEDI_ISS_L3_Canopy_Height_Mean_RH100_201904-202303",
        "gibs-anthromes": "Anthropogenic_Biomes_of_the_World_2001-2006",
    }
    assert {k: g.LAYERS[k]["gibsId"] for k in want} == want
    assert g.LAYERS["gibs-anthromes"]["asOf"] == "2001–2006"
    # GPP and canopy are dated in GIBS (canopy: one 2019-04-18/P1429D interval), so asOf would raise in build
    assert "asOf" not in g.LAYERS["gibs-gpp"] and "asOf" not in g.LAYERS["gibs-canopy"]


def test_gpp_reads_the_production_map_and_its_classification_colours_are_no_data():
    # GPP's real colour map (2026-10-03) carries a "Classifications" map of seven transparent classes (urban,
    # water, snow/ice, barren, fill...) beside the production ramp; those pixels must read no data, not a value
    cm = g.parse_colormap((FIX / "gibs_colormap_gpp.xml").read_bytes())
    r = cm["ramp"]
    assert (r["min"], r["max"], r["unit"]) == (0.0, 0.12, " kgC/m²")
    d = cm["decode"]
    assert len(d) == 240 and d[0] == [100, 0, 0, 0.0, 0.0005]
    assert [
        0,
        255,
        113,
        0.0585,
        0.059,
    ] in d  # Germany, 2024-06-25 (probe of the live tile)
    assert len({tuple(e[:3]) for e in d}) == len(d)
    assert sorted(map(tuple, cm["noData"])) == [
        (0, 0, 1),
        (0, 1, 1),
        (25, 25, 112),
        (30, 145, 20),
        (190, 190, 190),
        (255, 165, 0),
        (255, 255, 253),
    ]
    assert not {tuple(c) for c in cm["noData"]} & {tuple(e[:3]) for e in d}


def test_canopy_height_has_an_open_top_bin_and_black_as_no_data():
    cm = g.parse_colormap((FIX / "gibs_colormap_canopy.xml").read_bytes())
    r = cm["ramp"]
    assert (r["min"], r["max"], r["unit"]) == (0.0, 45.0, " m")
    d = cm["decode"]
    assert len(d) == 91 and d[-1] == [0, 16, 0, 45.0, None]
    assert [72, 144, 1, 22.5, 23.0] in d  # Amazon at 5°S 65°W (probe of the live tile)
    # unlike GEDI biomass, canopy height never draws black as data
    assert cm["noData"] == [[0, 0, 0]]
    assert not any(e[:3] == [0, 0, 0] for e in d)


def test_anthromes_are_21_classes_and_black_is_no_data():
    cm = g.parse_colormap((FIX / "gibs_colormap_anthromes.xml").read_bytes())
    labels = [c["label"] for c in cm["classes"]]
    assert len(labels) == 21 and labels[0] == "Urban" and labels[-1] == "Barren"
    assert {"label": "Remote forest", "rgb": [158, 215, 194]} in cm["classes"]
    assert {"label": "Residential rainfed mosaic", "rgb": [152, 230, 0]} in cm[
        "classes"
    ]
    assert "decode" not in cm and cm["noData"] == [[0, 0, 0]]
