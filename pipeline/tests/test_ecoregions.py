"""pipeline/ecoregions.py. Record fixtures are REAL rows of Ecoregions2017.dbf (RESOLVE zip fetched
2026-09-12 from storage.googleapis.com/teow2016, read with pyshp, encoding latin-1). Each test names
the mutant it was seen to fail on."""

import io
import json
import zipfile

import pytest
import shapefile
from shapely.geometry import shape

import pipeline.ecoregions as m

ADELIE = {
    "OBJECTID": 1.0,
    "ECO_NAME": "Adelie Land tundra",
    "BIOME_NUM": 11.0,
    "BIOME_NAME": "Tundra",
    "REALM": "Antarctica",
    "ECO_BIOME_": "AN11",
    "NNH": 1,
    "ECO_ID": 117,
    "SHAPE_LENG": 9.74978020742,
    "SHAPE_AREA": 0.0389483162871,
    "NNH_NAME": "Half Protected",
    "COLOR": "#63CFAB",
    "COLOR_BIO": "#9ED7C2",
    "COLOR_NNH": "#257339",
    "LICENSE": "CC-BY 4.0",
}
ADMIRALTY = {
    "OBJECTID": 2.0,
    "ECO_NAME": "Admiralty Islands lowland rain forests",
    "BIOME_NUM": 1.0,
    "BIOME_NAME": "Tropical & Subtropical Moist Broadleaf Forests",
    "REALM": "Australasia",
    "ECO_BIOME_": "AU01",
    "NNH": 2,
    "ECO_ID": 135,
    "SHAPE_LENG": 4.80034928313,
    "SHAPE_AREA": 0.170598978809,
    "NNH_NAME": "Nature Could Reach Half Protected",
    "COLOR": "#70A800",
    "COLOR_BIO": "#38A700",
    "COLOR_NNH": "#7BC141",
    "LICENSE": "CC-BY 4.0",
}
AEGEAN = {
    "OBJECTID": 3.0,
    "ECO_NAME": "Aegean and Western Turkey sclerophyllous and mixed forests",
    "BIOME_NUM": 12.0,
    "BIOME_NAME": "Mediterranean Forests, Woodlands & Scrub",
    "REALM": "Palearctic",
    "ECO_BIOME_": "PA12",
    "NNH": 4,
    "ECO_ID": 785,
    "SHAPE_LENG": 162.523043817,
    "SHAPE_AREA": 13.8449517466,
    "NNH_NAME": "Nature Imperiled",
    "COLOR": "#FF7F7C",
    "COLOR_BIO": "#FE0000",
    "COLOR_NNH": "#EE1E23",
    "LICENSE": "CC-BY 4.0",
}
ROCK_ICE = {
    "OBJECTID": 207.0,
    "ECO_NAME": "Rock and Ice",
    "BIOME_NUM": 11.0,
    "BIOME_NAME": "N/A",
    "REALM": "N/A",
    "ECO_BIOME_": "N/A",
    "NNH": 0,
    "ECO_ID": 0,
    "SHAPE_LENG": 6629.94445998,
    "SHAPE_AREA": 6487.84862098,
    "NNH_NAME": "N/A",
    "COLOR": "#E2E2E0",
    "COLOR_BIO": "#FFEAAF",
    "COLOR_NNH": "#E2E2E0",
    "LICENSE": "CC-BY 4.0",
}


def sq(x, y, s):
    return [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]


def poly(*rings):
    return {"type": "Polygon", "coordinates": list(rings)}


def parts(gj):
    return gj["coordinates"] if gj["type"] == "MultiPolygon" else [gj["coordinates"]]


def test_properties_maps_real_rows_and_drops_rock_and_ice():
    """Mutants: swapping NNH 2/3 labels fails the NNH_NAME check; removing the ECO_ID 0 guard makes
    Rock and Ice raise (its COLOR_BIO #FFEAAF is not a biome colour)."""
    assert m.properties(AEGEAN) == {
        "eco_id": 785,
        "name": "Aegean and Western Turkey sclerophyllous and mixed forests",
        "biome": 12,
        "biome_name": "Mediterranean Forests, Woodlands & Scrub",
        "realm": "Palearctic",
        "nnh": 4,
        "nnh_name": "Nature Imperiled",
    }
    for rec in (ADELIE, ADMIRALTY, AEGEAN):
        p = m.properties(rec)
        assert (
            p["nnh_name"] == rec["NNH_NAME"] and p["biome_name"] == rec["BIOME_NAME"]
        ), "labels match RESOLVE's own columns"
    assert m.properties(ROCK_ICE) is None


def test_properties_fails_loud_on_unknown_biome_and_palette_drift():
    """Mutant: deleting the COLOR_BIO comparison lets the drifted row through."""
    assert m.properties(ADMIRALTY)["biome"] == 1, "positive control"
    with pytest.raises(ValueError, match="unknown BIOME_NUM 15"):
        m.properties({**ADMIRALTY, "BIOME_NUM": 15.0})
    with pytest.raises(ValueError, match="palette drifted"):
        m.properties({**ADMIRALTY, "COLOR_BIO": "#38A701"})


def test_simplify_repairs_invalid_source_to_valid_output():
    """Mutant: removing both make_valid calls -> set_precision raises GEOS TopologyException on the bowtie."""
    ok = m.simplify_geometry(poly(sq(0, 0, 2)), 0.05, 0.02)
    assert (
        ok["type"] == "Polygon"
        and shape(ok).is_valid
        and shape(ok).area == pytest.approx(4)
    ), "positive control"
    bowtie = poly([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]])
    assert not shape(bowtie).is_valid
    out = m.simplify_geometry(bowtie, 0.05, 0.02)
    assert (
        shape(out).is_valid
        and out["type"] == "MultiPolygon"
        and len(out["coordinates"]) == 2
    )
    assert shape(out).area == pytest.approx(2)


def test_snapping_keeps_output_valid_where_rounding_would_not():
    """A vertex 0.0004° above the bottom edge rounds onto that edge (a self-touching ring).
    Mutant: replacing set_precision with plain rounding yields an invalid ring."""
    near = poly([[0, 0], [1, 0], [1, 1], [0.5, 0.0004], [0, 1], [0, 0]])
    assert shape(near).is_valid
    naive = poly(m._rnd(near["coordinates"][0]))
    assert not shape(naive).is_valid, "the hazard is real: rounding alone breaks it"
    out = m.simplify_geometry(near, 0.0001, 0.0)
    assert shape(out).is_valid
    assert all(
        round(v, 3) == v for ring in parts(out) for r in ring for pt in r for v in pt
    ), "coordinates on the 0.001 grid"


def test_simplify_drops_small_parts_and_holes_but_keeps_largest_part():
    """Mutant: removing the `or [max(...)]` fallback makes the all-small geometry raise."""
    g = {
        "type": "MultiPolygon",
        "coordinates": [
            [
                sq(0, 0, 3),
                sq(0.2, 0.2, 0.1),
                sq(1, 1, 0.8),
            ],  # hole 0.01 deg² dropped, hole 0.64 kept
            [sq(10, 10, 0.1)],  # island 0.01 deg² dropped
        ],
    }
    out = m.simplify_geometry(g, 0.01, 0.02)
    assert out["type"] == "Polygon" and len(out["coordinates"]) == 2
    assert shape(out).area == pytest.approx(9 - 0.64)
    tiny = {"type": "MultiPolygon", "coordinates": [[sq(0, 0, 0.1)], [sq(5, 5, 0.12)]]}
    out = m.simplify_geometry(tiny, 0.01, 0.02)
    assert out["type"] == "Polygon" and shape(out).area == pytest.approx(0.0144), (
        "largest part kept"
    )


def test_build_sorts_counts_and_computes_area_from_unsimplified_shape():
    """Mutant: computing area_km2 from the simplified geometry (hole dropped) inflates it past 1 %."""
    holed = poly(
        sq(0, 0, 1), sq(0.5, 0.5, 0.1)
    )  # 1° cell at the equator minus a 0.1° hole
    rows = [
        (AEGEAN, holed),
        (ROCK_ICE, poly(sq(0, 0, 5))),
        (ADELIE, poly(sq(20, -70, 1))),
    ]
    feats, counts, per_biome = m.build(rows, tol=0.05, min_area=0.02)
    assert [f["properties"]["eco_id"] for f in feats] == [117, 785]
    assert (
        counts["rows"] == 3
        and counts["dropped_rows"] == 1
        and counts["ecoregions"] == 2
        and counts["biomes"] == 2
    )
    assert counts["invalid_in"] == 0 and counts["vertices_in"] == 5 + 5 + 5
    aeg = feats[1]["properties"]
    assert aeg["area_km2"] == pytest.approx(12364 * 0.99, rel=0.01), (
        "equator 1° cell ≈ 12,364 km², minus the 1 % hole"
    )
    assert len(feats[1]["geometry"]["coordinates"]) == 1, (
        "hole below min_area dropped from the display shape only"
    )
    assert sorted(per_biome) == [11, 12]


def test_dissolve_biomes_unions_adjacent_ecoregions_with_same_schema():
    """Mutant: skipping unary_union (MultiPolygon of the parts) leaves 2 parts for biome 1."""
    rows = [
        (ADMIRALTY, poly(sq(0, 0, 1))),
        (
            {**ADMIRALTY, "ECO_ID": 999, "ECO_NAME": "Neighbour forests"},
            poly(sq(1, 0, 1)),
        ),
        (ADELIE, poly(sq(20, -70, 1))),
    ]
    feats, _, per_biome = m.build(rows, tol=0.01, min_area=0.01)
    seed = m.dissolve_biomes(per_biome, feats, tol=0.01, min_area=0.01)
    assert [f["properties"]["biome"] for f in seed] == [1, 11]
    b1 = seed[0]
    assert b1["geometry"]["type"] == "Polygon" and shape(
        b1["geometry"]
    ).area == pytest.approx(2)
    forests = [f["properties"] for f in feats if f["properties"]["biome"] == 1]
    assert [p["eco_id"] for p in forests] == [135, 999]
    assert b1["properties"]["area_km2"] == sum(p["area_km2"] for p in forests)
    assert (
        b1["properties"]["name"]
        == "Tropical & Subtropical Moist Broadleaf Forests (2 ecoregions, dissolved)"
    )
    assert set(b1["properties"]) == set(feats[0]["properties"]), (
        "seed uses the layer's property schema"
    )


def test_read_rows_decodes_latin1_dbf_inside_zip(tmp_path):
    """Mutant: encoding="utf-8" raises UnicodeDecodeError on "Paraná"."""
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(
        shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON, encoding="latin-1"
    )
    w.field("ECO_NAME", "C", 150)
    w.field("ECO_ID", "N", 11)
    w.poly([[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]])
    w.record("Alto Paraná Atlantic forests", 440)
    w.close()
    zp = tmp_path / "Ecoregions2017.zip"
    with zipfile.ZipFile(zp, "w") as z:
        for ext, buf in (("shp", shp), ("shx", shx), ("dbf", dbf)):
            z.writestr(f"Ecoregions2017.{ext}", buf.getvalue())
    rows = list(m.read_rows(zp))
    assert len(rows) == 1
    rec, geom = rows[0]
    assert rec["ECO_NAME"] == "Alto Paraná Atlantic forests" and rec["ECO_ID"] == 440
    assert geom["type"] == "Polygon" and shape(geom).area == pytest.approx(1)


def test_fetch_zip_downloads_once_and_rejects_non_zip(tmp_path):
    """Mutant: dropping the PK check writes an HTML error page into the cache."""
    calls = []
    zp = m.fetch_zip(
        tmp_path / "a" / "E.zip", lambda url: calls.append(url) or b"PK\x03\x04rest"
    )
    assert zp.read_bytes().startswith(b"PK") and calls == [m.ZIP_URL]
    m.fetch_zip(zp, lambda url: calls.append(url) or b"PK")
    assert len(calls) == 1, "cached zip is not re-downloaded"
    bad = tmp_path / "b" / "E.zip"
    with pytest.raises(RuntimeError, match="not a zip"):
        m.fetch_zip(bad, lambda url: b"<html>quota</html>")
    assert not bad.exists()


def test_main_writes_layer_and_seed_and_gates_on_expected_count(tmp_path, monkeypatch):
    """Mutant: removing the EXPECTED_ECOREGIONS gate writes a short file instead of exiting."""
    rows = [
        (AEGEAN, poly(sq(26, 37, 2))),
        (ROCK_ICE, poly(sq(0, 0, 5))),
        (ADELIE, poly(sq(140, -67, 1))),
    ]
    monkeypatch.setattr(m, "fetch_zip", lambda path, fetch_bytes=None: path)
    monkeypatch.setattr(m, "read_rows", lambda zp: iter(rows))
    monkeypatch.setattr(m, "EXPECTED_ECOREGIONS", 2)
    out, seed = tmp_path / "e.geojson", tmp_path / "seed.geojson"
    m.main(["--out", str(out), "--seed-out", str(seed), "--cache", str(tmp_path)])
    gj = json.loads(out.read_text())
    assert (
        len(gj["features"]) == 2
        and "CC BY 4.0" in gj["source"]["licence"]
        and gj["counts"]["tol_deg"] == 0.05
    )
    assert gj["biomes"]["14"] == {"name": "Mangroves", "color": "#FE01C4"}
    sd = json.loads(seed.read_text())
    assert sd["counts"]["seed"] is True and [
        f["properties"]["eco_id"] for f in sd["features"]
    ] == ["biome-11", "biome-12"]
    assert "SEED" in sd["source"]["note"]
    monkeypatch.setattr(m, "EXPECTED_ECOREGIONS", 3)
    out2 = tmp_path / "e2.geojson"
    with pytest.raises(SystemExit, match="expected 3 ecoregions, built 2"):
        m.main(["--out", str(out2), "--cache", str(tmp_path)])
    assert not out2.exists()
