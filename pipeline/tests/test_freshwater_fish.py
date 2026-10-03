"""Freshwater fish per basin pipeline: the pinned Zenodo files, the species-table check, families, bins, the basin
count, overlaps, the budget (spec 2026-10-03-freshwater-fish-design.md)."""

import hashlib
import json
import os
import re
from pathlib import Path

import openpyxl
import pytest
import shapefile
from shapely.geometry import Point, box, shape

from pipeline import freshwater_fish as ff

CACHE = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))

# basin id → (name in the source, realm, country, species with their family)
BASINS = {
    "B0001": (
        "Big.River",
        "Neotropic",
        "Brazil",
        [("Aa a", "Cichlidae"), ("Aa b", "Cichlidae"), ("Bb a", "Characidae")],
    ),
    "B0002": ("Small", "Palearctic", "France", [("Cc a", "Cyprinidae")]),
    "B0003": (
        "Rio.Mexico",
        "Nearctic",
        "México",
        [("Aa a", "Cichlidae"), ("Dd a", "Poeciliidae")],
    ),
}


def square(i):
    """Basin i's synthetic shape: a 1° square on the equator, 2° apart."""
    return box(i * 2, 0, i * 2 + 1, 1)


def write_source(d: Path, basins=BASINS, n_specs=None, shapes=None):
    """The four files of the Zenodo record, synthetic: a Latin-1 shapefile and the species workbook."""
    d.mkdir(parents=True, exist_ok=True)
    w = shapefile.Writer(
        str(d / "Basin_202412_3364"), shapeType=shapefile.POLYGON, encoding="latin-1"
    )
    for name, kind, size in (
        ("basin_d", "C", 10),
        ("basin", "C", 80),
        ("bggrph_", "C", 20),
        ("country", "C", 80),
    ):
        w.field(name, kind, size)
    w.field("n_specs", "N", 10, 0)
    w.field("cntr_ln", "F", 19, 11)
    w.field("cntr_lt", "F", 19, 11)
    for i, (bid, (name, realm, country, sp)) in enumerate(basins.items()):
        g = (shapes or {}).get(bid, square(i))
        w.poly(
            [list(p.exterior.coords)[::-1] for p in getattr(g, "geoms", [g])]
        )  # shapefile outer rings run clockwise
        w.record(
            bid,
            name,
            realm,
            country,
            (n_specs or {}).get(bid, len(sp)),
            i * 2 + 0.5,
            0.5,
        )
    w.close()
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "CAS"
    ws.append(
        [
            "cas_info",
            "year_description",
            "references",
            "authorship",
            "valid_name",
            "class",
            "order",
            "family",
            "basin",
        ]
    )
    species = {}
    for name, _, _, sp in basins.values():
        for s, fam in sp:
            species.setdefault((s, fam), []).append(name)
    for (s, fam), where in species.items():
        ws.append(
            [
                f"{s}: Holotype text",
                2000,
                "1, 2",
                f"{s} Author 2000",
                s,
                "Actinopteri",
                "Order",
                fam,
                ";".join(where),
            ]
        )
    ws.append(
        ["no name row", 2000, "", "", None, "Actinopteri", "Order", "Nofam", "Small"]
    )
    wb.save(d / "cas_freshwater_202412.xlsx")
    return d


def test_bins_are_log_spaced_and_coloured_dark_to_light():
    assert [ff.bin_of(n) for n in (1, 9, 10, 24, 25, 99, 100, 999, 1000, 2815)] == [
        0,
        0,
        1,
        1,
        2,
        3,
        4,
        6,
        7,
        7,
    ]
    with pytest.raises(ValueError, match="0 species"):
        ff.bin_of(0)
    cols = ff.BIN_COLOURS
    assert len(cols) == len(ff.BIN_EDGES) == 8 and len(set(cols)) == 8
    assert all(re.fullmatch(r"#[0-9a-f]{6}", c) for c in cols)

    def luminance(c):
        """WCAG relative luminance: HLS lightness is not perceptual."""
        v = [int(c[k : k + 2], 16) / 255 for k in (1, 3, 5)]
        lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in v]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

    light = [luminance(c) for c in cols]
    assert light == sorted(light), "more species reads lighter on the dark globe"
    assert ff.bin_label(0) == "1–9" and ff.bin_label(7) == "1,000+"


def test_build_carries_counts_families_names_and_areas(tmp_path):
    d = write_source(tmp_path / "src")
    feats, counts = ff.build(
        ff.read_basins(d), ff.read_species(d), tol=0.0001, min_area=0.0001, expect=3
    )
    assert [f["properties"]["id"] for f in feats] == [
        "B0001",
        "B0002",
        "B0003",
    ] and counts["basins"] == 3
    big = feats[0]["properties"]
    assert (big["name"], big["realm"], big["country"], big["species"]) == (
        "Big River",
        "Neotropic",
        "Brazil",
        3,
    )
    assert big["families"] == [["Cichlidae", 2], ["Characidae", 1]], (
        "largest family first"
    )
    assert feats[2]["properties"]["country"] == "México", "the dbf is Latin-1"
    assert big["bin"] == 0 and big["color"] == ff.BIN_COLOURS[0]
    assert big["area_km2"] == pytest.approx(12_300, rel=0.01), (
        "1° square on the equator"
    )
    blob = json.dumps(feats)
    assert "Holotype" not in blob and "Author" not in blob, (
        "Catalogue of Fishes text is never published"
    )


def test_area_is_the_unsimplified_basins(tmp_path):
    from shapely.geometry import MultiPolygon, mapping

    from pipeline.gfw import geometry_area_km2

    raw = MultiPolygon([square(1), box(3.5, 0, 3.6, 0.1)])  # a 0.01 deg² island, under min_area
    d = write_source(tmp_path / "src", shapes={"B0002": raw})
    feats, _ = ff.build(ff.read_basins(d), ff.read_species(d), expect=3)
    small = feats[1]
    drawn = shape(small["geometry"])
    assert len(getattr(drawn, "geoms", [drawn])) == 1, "the island is not drawn"
    want = round(sum(geometry_area_km2(mapping(p)) for p in raw.geoms))
    assert small["properties"]["area_km2"] == want, "but its area counts"
    assert want - round(geometry_area_km2(mapping(drawn))) > 100


def test_a_count_the_species_table_does_not_back_stops_the_build(tmp_path):
    d = write_source(tmp_path / "ok")
    assert (
        ff.build(ff.read_basins(d), ff.read_species(d), expect=3)[1]["basins"] == 3
    )  # positive control
    bad = write_source(tmp_path / "bad", n_specs={"B0002": 2})
    with pytest.raises(
        ValueError,
        match="basin B0002 \\(Small\\): n_specs 2 but the species table lists 1",
    ):
        ff.build(ff.read_basins(bad), ff.read_species(bad), expect=3)


def test_a_species_in_two_rows_stops_the_run(tmp_path):
    d = write_source(tmp_path / "ok")
    assert ff.read_species(d)["Big.River"]["families"] == {
        "Cichlidae": 2,
        "Characidae": 1,
    }  # positive control
    wb = openpyxl.load_workbook(d / "cas_freshwater_202412.xlsx")
    wb["CAS"].append(
        ["again", 2000, "", "", "Aa a", "Actinopteri", "Order", "Cichlidae", "Big.River"]
    )
    wb.save(d / "cas_freshwater_202412.xlsx")
    with pytest.raises(ValueError, match="species 'Aa a' has more than one row"):
        ff.read_species(d)


def test_the_wrong_number_of_basins_a_repeated_id_or_an_unknown_realm_stops_the_build(
    tmp_path,
):
    d = write_source(tmp_path / "src")
    basins, species = list(ff.read_basins(d)), ff.read_species(d)
    assert ff.build(basins, species, expect=3)[1]["basins"] == 3
    with pytest.raises(ValueError, match="3 basins, not 3,364"):
        ff.build(basins, species)
    with pytest.raises(ValueError, match="basin B0001 appears twice"):
        ff.build(basins + basins[:1], species, expect=4)
    rec, geom = basins[1]
    with pytest.raises(
        ValueError, match="basin B0002: realm 'Atlantis' is not one of the 7"
    ):
        ff.build(
            [basins[0], ({**rec, "bggrph_": "Atlantis"}, geom), basins[2]],
            species,
            expect=3,
        )


def test_a_basin_across_the_globe_is_cut_into_strips(tmp_path):
    wide = box(-180, -17, 180, -16)
    d = write_source(tmp_path / "src", shapes={"B0003": wide})
    feats, _ = ff.build(
        ff.read_basins(d), ff.read_species(d), tol=0.0001, min_area=0.0001, expect=3
    )
    parts = list(shape(feats[2]["geometry"]).geoms)
    assert len(parts) == 4 and all(p.bounds[2] - p.bounds[0] <= 90 for p in parts)
    assert shape(feats[0]["geometry"]).geom_type == "Polygon", (
        "positive control: a narrow basin is kept whole"
    )


def test_each_file_is_used_only_when_its_md5_is_zenodos(tmp_path):
    src = write_source(tmp_path / "src")
    want = {
        n: hashlib.md5((src / n).read_bytes(), usedforsecurity=False).hexdigest()
        for n in ff.FILES
    }
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes((src / url.split("/files/")[1].split("/")[0]).read_bytes())

    cache = tmp_path / "cache"
    d = ff.fetch(cache, fetch_to=fetch_to, want=want)
    assert sorted(p.name for p in d.iterdir()) == sorted(ff.FILES)
    assert calls == [f"{ff.RECORD_API}/files/{n}/content" for n in ff.FILES]
    assert ff.fetch(cache, fetch_to=fetch_to, want=want) == d and len(calls) == len(
        ff.FILES
    ), "cached"
    bad = {**want, "Basin_202412_3364.dbf": "0" * 32}
    with pytest.raises(
        ValueError, match="Basin_202412_3364.dbf: md5 .* is not Zenodo's"
    ):
        ff.fetch(cache, fetch_to=fetch_to, want=bad)
    (d / "Basin_202412_3364.dbf").unlink()
    with pytest.raises(ValueError, match="is not Zenodo's"):
        ff.fetch(cache, fetch_to=fetch_to, want=bad)
    assert not (d / "Basin_202412_3364.dbf").exists() and not list(d.glob("*.part")), (
        "a refused download leaves nothing"
    )


def test_main_writes_the_collection_and_nothing_over_budget(tmp_path):
    src = write_source(tmp_path / "src")
    want = {
        n: hashlib.md5((src / n).read_bytes(), usedforsecurity=False).hexdigest()
        for n in ff.FILES
    }

    def fetch_to(url, path):
        path.write_bytes((src / url.split("/files/")[1].split("/")[0]).read_bytes())

    out = tmp_path / "out" / "freshwater_fish.geojson"
    args = [
        "--cache",
        str(tmp_path / "cache"),
        "--out",
        str(out),
        "--tol",
        "0.0001",
        "--min-area",
        "0.0001",
    ]
    assert ff.main(args, fetch_to=fetch_to, want=want, expect=3) == 0
    d = json.loads(out.read_text())
    assert len(d["features"]) == 3 and d["source"]["licence"].startswith("CC BY 4.0")
    assert d["bins"] == [
        {"min": e, "label": ff.bin_label(i), "color": ff.BIN_COLOURS[i]}
        for i, e in enumerate(ff.BIN_EDGES)
    ]
    assert d["counts"]["species"] == 5, "distinct named species across basins"
    before = out.read_bytes()
    with pytest.raises(SystemExit, match="over the 1,000 B budget: nothing written"):
        ff.main([*args, "--budget", "1000"], fetch_to=fetch_to, want=want, expect=3)
    assert out.read_bytes() == before


# Pre-registered 2026-10-03 from the raw shapes, before the layer was written: points and every basin under them
# (two where the source's basins overlap), and points in no basin.
POINTS = {
    "Amazon": ((-3.0, -60.0), {"Amazon": 2815}),
    "Congo": ((-1.0, 20.0), {"Congo": 1232}),
    "Mississippi": ((35.0, -90.0), {"Mississippi": 490}),
    "Thames": ((51.6, -1.0), {"Thames UK": 31}),
    "Lake Baikal": ((53.0, 108.0), {"Yenisey": 100}),
    "Komo / Mabelle overlap": ((0.94, 10.065), {"Komo River": 6, "Mabelle River": 3}),
    "Charnley / Sale overlap": ((-16.193, 125.47), {"Charnley": 5, "Sale River": 3}),
}
EMPTY = {
    "mid Atlantic": (30.0, -30.0),
    "Greenland ice": (72.0, -40.0),
    "Antarctica": (-80.0, 0.0),
    "inland Australia": (-25.0, 133.0),
}


# Not skipped when the cache is empty: main downloads the four files through the pinned fetcher (Zenodo md5s), so a
# fresh CI runner checks the published shapes against the real source too.
def test_real_release_points_read_the_basins_of_the_raw_shapes(tmp_path):
    out = tmp_path / "freshwater_fish.geojson"
    assert ff.main(["--cache", str(CACHE), "--out", str(out)]) == 0
    d = json.loads(out.read_text())
    assert out.stat().st_size <= ff.BUDGET_BYTES and d["counts"]["basins"] == 3364
    geoms = [(f["properties"], shape(f["geometry"])) for f in d["features"]]
    parts = [p for _, g in geoms for p in getattr(g, "geoms", [g])]
    assert (
        all(p.is_valid for p in parts)
        and max(p.bounds[2] - p.bounds[0] for p in parts) <= ff.MAX_PART_WIDTH
    )
    raw = [(rec, shape(g)) for rec, g in ff.read_basins(CACHE / ff.CACHE_DIR)]
    for name, ((lat, lon), want) in POINTS.items():
        pt = Point(lon, lat)
        assert {
            r["basin"].replace(".", " "): r["n_specs"] for r, g in raw if g.covers(pt)
        } == want, f"{name}: raw"
        assert {p["name"]: p["species"] for p, g in geoms if g.covers(pt)} == want, (
            f"{name}: published"
        )
    for name, (lat, lon) in EMPTY.items():
        assert not [p for p, g in geoms if g.covers(Point(lon, lat))], (
            f"{name} is in no basin"
        )
    amazon = next(p for p, _ in geoms if p["name"] == "Amazon")
    # counted straight from the workbook's rows, 2026-10-03 (Acestrorhamphidae: split from Characidae in 2024)
    assert amazon["families"] == [
        ["Loricariidae", 380],
        ["Acestrorhamphidae", 323],
        ["Cichlidae", 257],
        ["Stevardiidae", 154],
        ["Callichthyidae", 132],
    ]
