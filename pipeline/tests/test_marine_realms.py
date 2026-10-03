"""Marine realms pipeline: the pinned figshare zip, the Fig. 1 table, land removal, the 30-realm rule, the budget
(spec 2026-10-03-marine-realms-design.md)."""

import colorsys
import hashlib
import io
import json
import os
import re
import zipfile
from pathlib import Path

import pytest
import shapefile
from shapely.geometry import MultiPolygon, Point, Polygon, box, shape

from pipeline import marine_realms as mr

CACHE = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))
REAL_ZIP = CACHE / "realms" / mr.ZIP_NAME
LAND_ZIP = CACHE / "ne_10m_land.zip"


def square(r):
    """Realm r's synthetic shape: a 1° square on the equator, 2° apart."""
    return box((r - 1) * 2, 0, (r - 1) * 2 + 1, 1)


def make_zip(path, realms=range(1, 31)):
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON)
    w.field("Realm", "N", 10, 0)
    for r in realms:
        w.poly(
            [list(square(r).exterior.coords)[::-1]]
        )  # shapefile outer rings run clockwise
        w.record(r)
    w.close()
    with zipfile.ZipFile(path, "w") as z:
        for ext, buf in (("shp", shp), ("shx", shx), ("dbf", dbf)):
            z.writestr(f"MarineRealms.{ext}", buf.getvalue())
    return path


def test_the_table_is_the_papers_30_realms_in_8_groups_each_with_its_own_colour():
    assert sorted(mr.REALMS) == list(range(1, 31))
    assert (
        {g for _, g, _, _ in mr.REALMS.values()} == set(mr.GROUPS) == set(range(1, 9))
    )
    # the paper's text: Black Sea 84 %, Red Sea 74 %, Chile 68 %, Inner Baltic 63 %, South-East Pacific 59 % = realms 2, 14, 25, 1, 10
    assert [mr.REALMS[r][2] for r in (2, 14, 25, 1, 10)] == [84, 74, 68, 63, 59]
    assert sum(1 for *_, g in [(0, mr.REALMS[r][1]) for r in mr.REALMS] if g == 6) == 18
    colours = [mr.colour(r) for r in mr.REALMS]
    assert len(set(colours)) == 30 and all(
        re.fullmatch(r"#[0-9a-f]{6}", c) for c in colours
    )
    lightness = [
        colorsys.rgb_to_hls(*(int(c[i : i + 2], 16) / 255 for i in (1, 3, 5)))[1]
        for c in colours
    ]
    assert all(abs(a - b) >= 0.1 for a, b in zip(lightness, lightness[1:])), (
        "neighbouring realm numbers alternate between two lightness steps"
    )
    p = mr.properties(2)
    assert (p["name"], p["group"], p["pct_unique"], p["species"]) == (
        "Black Sea",
        2,
        84,
        192,
    )
    with pytest.raises(ValueError, match="realm 31 is not one of the paper's 30"):
        mr.properties(31)


def test_land_is_cut_out_of_a_realm_and_its_area_is_the_sea_left():
    island = box(2.25, 0.25, 2.75, 0.75)  # inside realm 2's square
    islet = box(
        2.8, 0.8, 2.95, 0.95
    )  # a second one: every land polygon is removed, not only the first
    rows = [(r, square(r).__geo_interface__) for r in range(1, 31)]
    feats, counts = mr.build(rows, tol=0.0001, min_area=0.0001, land=[island, islet])
    assert counts["realms"] == 30 and [f["properties"]["realm"] for f in feats] == list(
        range(1, 31)
    )
    two = shape(feats[1]["geometry"])
    assert not two.contains(Point(2.5, 0.5)), "the island is land"
    assert not two.contains(Point(2.875, 0.875)), "so is the islet"
    assert two.contains(Point(2.1, 0.1)), "the sea around them is still the realm"
    plain = mr.build(rows, tol=0.0001, min_area=0.0001)[0]
    assert shape(plain[1]["geometry"]).contains(Point(2.5, 0.5)), (
        "positive control: without land the island is sea"
    )
    assert feats[1]["properties"]["area_km2"] == pytest.approx(
        plain[1]["properties"]["area_km2"] * (1 - 0.25 - 0.0225), rel=0.005
    )
    assert feats[2]["properties"]["area_km2"] == plain[2]["properties"]["area_km2"], (
        "land elsewhere changes nothing"
    )


def test_anything_but_the_30_realms_once_each_stops_the_build():
    rows = [(r, square(r).__geo_interface__) for r in range(1, 31)]
    with pytest.raises(ValueError, match=r"missing from the shapefile: \[7\]"):
        mr.build([x for x in rows if x[0] != 7])
    with pytest.raises(ValueError, match="realm 3 appears twice"):
        mr.build(rows + [rows[2]])
    with pytest.raises(ValueError, match="realm 31 is not one of the paper's 30"):
        mr.build(rows + [(31, square(1).__geo_interface__)])
    assert mr.build(rows)[1]["realms"] == 30


def test_a_polygon_wrapping_the_globe_is_cut_into_strips_cesium_can_draw():
    ring = box(-180, -80, 180, -40).difference(
        box(-10, -70, 10, -60)
    )  # a circumpolar band with a hole
    cut = mr.split_wide(ring)
    parts = list(cut.geoms)
    assert len(parts) == 4 and all(p.bounds[2] - p.bounds[0] <= 90 for p in parts)
    assert sorted(round(p.bounds[0]) for p in parts) == [-180, -90, 0, 90]
    assert (
        cut.area == pytest.approx(ring.area)
        and cut.symmetric_difference(ring).area < 1e-9
    )
    assert not cut.covers(Point(0, -65)), "the hole stays a hole across the cut"
    narrow = box(10, 0, 95, 5)
    assert mr.split_wide(narrow).equals(narrow), (
        "positive control: 85° wide is kept whole"
    )
    rows = [(r, square(r).__geo_interface__) for r in range(1, 30)] + [
        (30, ring.__geo_interface__)
    ]
    feats, _ = mr.build(rows, tol=0.0001, min_area=0.0001)
    assert len(shape(feats[29]["geometry"]).geoms) == 4, (
        "build cuts the published shape"
    )


def test_an_invalid_cut_strip_stops_the_build(monkeypatch):
    rows = [(r, square(r).__geo_interface__) for r in range(1, 31)]
    assert mr.build(rows)[1]["realms"] == 30  # positive control
    bowtie = Polygon([(0, 0), (1, 1), (1, 0), (0, 1), (0, 0)])
    monkeypatch.setattr(mr, "split_wide", lambda g: MultiPolygon([bowtie]))
    with pytest.raises(ValueError, match="realm 1: a cut strip is invalid"):
        mr.build(rows)


def test_the_zip_is_used_only_when_its_md5_is_figshares(tmp_path):
    src = make_zip(tmp_path / "src.zip")
    good = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(src.read_bytes())

    cache = tmp_path / "cache"
    p = mr.fetch(cache, fetch_to=fetch_to, want=good)
    assert p.read_bytes() == src.read_bytes() and calls == [mr.FILE_URL]
    assert mr.fetch(cache, fetch_to=fetch_to, want=good) == p and len(calls) == 1, (
        "cached"
    )
    with pytest.raises(ValueError, match="is not figshare's"):
        mr.fetch(cache, fetch_to=fetch_to, want="0" * 32)
    p.unlink()
    with pytest.raises(ValueError, match="is not figshare's"):
        mr.fetch(cache, fetch_to=fetch_to, want="0" * 32)
    assert not p.exists() and not list(cache.glob("*.part")), (
        "a refused download leaves nothing"
    )


def test_main_writes_the_collection_and_nothing_over_budget(tmp_path):
    src = make_zip(tmp_path / "src.zip")
    good = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()

    def fetch_to(url, path):
        path.write_bytes(src.read_bytes())

    out = tmp_path / "out" / "marine_realms.geojson"
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
    assert (
        mr.main(args, fetch_to=fetch_to, want=good, land=[box(2.25, 0.25, 2.75, 0.75)])
        == 0
    )
    d = json.loads(out.read_text())
    assert len(d["features"]) == 30 and d["source"]["licence"].startswith("CC BY 4.0")
    assert (
        d["groups"]["8"] == "Southern Ocean"
        and "Land (Natural Earth 10 m" in d["source"]["note"]
    )
    assert d["features"][1]["properties"]["name"] == "Black Sea"
    before = out.read_bytes()
    with pytest.raises(SystemExit, match="over the 1,000 B budget: nothing written"):
        mr.main([*args, "--budget", "1000"], fetch_to=fetch_to, want=good, land=[])
    assert out.read_bytes() == before


# Pre-registered 2026-10-03, before the layer was written: sea points and the realm the paper's Fig. 1 numbers there
# (checked on the raw shapes), and land points, islands included, that must be in none.
SEA = {
    "Black Sea": ((43.0, 34.0), 2),
    "Red Sea": ((20.0, 38.5), 14),
    "Inner Baltic": ((60.5, 20.5), 1),
    "Mediterranean": ((35.0, 18.0), 5),
    "Gulf of Mexico": ((25.0, -90.0), 11),
    "Gulf of California": ((27.0, -111.0), 12),
    "Southern Ocean": ((-62.0, 0.0), 30),
    "Tasman Sea": ((-35.0, 160.0), 15),
    "off Chile": ((-33.0, -72.5), 25),
    "Gulf of Guinea": ((3.0, 3.0), 23),
    "mid North Atlantic": ((40.0, -40.0), 18),
    "mid South Pacific": ((-30.0, -130.0), 10),
    "mid Indian Ocean": ((-20.0, 80.0), 19),
}
LAND = {
    "Kansas": (38.0, -98.0),
    "Sahara": (23.0, 13.0),
    "Antarctica": (-80.0, 0.0),
    "Borneo": (0.5, 114.0),
    "Madagascar": (-20.0, 46.5),
    "Britain": (53.0, -1.5),
    "Honshu": (36.5, 138.5),
}


# Not skipped when the cache is empty: main downloads both inputs through the pinned fetchers (figshare md5, Natural
# Earth sha256), so a fresh CI runner checks the published shapes against the real source too (review of PR #45).
def test_real_release_points_read_the_papers_realm_and_land_reads_none(tmp_path):
    out = tmp_path / "marine_realms.geojson"
    assert mr.main(["--cache", str(CACHE), "--out", str(out)]) == 0
    assert REAL_ZIP.exists() and LAND_ZIP.exists()
    d = json.loads(out.read_text())
    assert out.stat().st_size <= mr.BUDGET_BYTES
    geoms = {f["properties"]["realm"]: shape(f["geometry"]) for f in d["features"]}
    parts = [p for g in geoms.values() for p in getattr(g, "geoms", [g])]
    assert sorted(geoms) == list(range(1, 31)) and all(p.is_valid for p in parts)
    widths = [p.bounds[2] - p.bounds[0] for p in parts]
    assert max(widths) <= mr.MAX_PART_WIDTH, "every part is narrow enough for Cesium"
    raw = {r: shape(g).buffer(0) for r, g in mr.read_rows(REAL_ZIP)}
    for name, ((lat, lon), want) in SEA.items():
        pt = Point(lon, lat)
        assert [r for r, g in raw.items() if g.contains(pt)] == [want], (
            f"{name}: raw shapes"
        )
        # covers, not contains: the Southern Ocean point lies on a strip cut (0°), inside the realm but on an edge
        assert [r for r, g in geoms.items() if g.covers(pt)] == [want], (
            f"{name}: published shapes"
        )
    for name, (lat, lon) in LAND.items():
        assert not [r for r, g in geoms.items() if g.covers(Point(lon, lat))], (
            f"{name} is land"
        )
    assert {r for r, g in raw.items() if g.contains(Point(114.0, 0.5))} == {13}, (
        "Borneo is inside realm 13 in the source"
    )
