"""Biodiversity hotspots pipeline: the pinned Zenodo zip, the 36-hotspot rule, outer limits, the land premise gate, the
budget (spec 2026-10-07-hotspots-design.md)."""

import colorsys
import hashlib
import io
import json
import os
import random
import re
import zipfile
from pathlib import Path

import pytest
import shapefile
from shapely import STRtree
from shapely.geometry import MultiPolygon, Point, box, shape
from shapely.geometry.polygon import orient

from pipeline import hotspots as hs

CACHE = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))
REAL_ZIP = CACHE / "hotspots" / hs.ZIP_NAME
LAND_ZIP = CACHE / "ne_10m_land.zip"


def square(i):
    """Hotspot i's synthetic land: a 1° square on the equator, 2° apart."""
    return box(i * 2, 0, i * 2 + 1, 1)


def ring_around(i):
    """An outer limit around hotspot i's square: a 1.8° box with the square cut out, as the source's outer limits
    exclude their hotspot's land."""
    return box(i * 2 - 0.4, -0.4, i * 2 + 1.4, 1.4).difference(square(i))


def area_rows(names=hs.NAMES):
    return [
        (n, "hotspot area", square(i).__geo_interface__) for i, n in enumerate(names)
    ]


def make_zip(path, rows):
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON)
    w.field("NAME", "C", 45)
    w.field("Type", "C", 25)
    for name, kind, geom in rows:
        g = shape(geom)
        rings = []
        for p in getattr(g, "geoms", [g]):
            p = orient(p, sign=-1.0)  # shapefile outer rings run clockwise, holes anticlockwise
            rings.append(list(p.exterior.coords))
            rings.extend(list(h.coords) for h in p.interiors)
        w.poly(rings)
        w.record(name, kind)
    w.close()
    with zipfile.ZipFile(path, "w") as z:
        for ext, buf in (("shp", shp), ("shx", shx), ("dbf", dbf)):
            z.writestr(f"hotspots_2016_1.{ext}", buf.getvalue())
    return path


def test_the_names_are_the_36_hotspots_each_with_its_own_colour():
    assert len(hs.NAMES) == 36 and len(set(hs.NAMES)) == 36
    assert list(hs.NAMES) == sorted(hs.NAMES)
    # the 2011 addition and the 2016.1 addition (README)
    assert {"Forests of East Australia", "North American Coastal Plain"} <= set(
        hs.NAMES
    )
    colours = [hs.colour(n) for n in hs.NAMES]
    assert len(set(colours)) == 36 and all(
        re.fullmatch(r"#[0-9a-f]{6}", c) for c in colours
    )
    lightness = [
        colorsys.rgb_to_hls(*(int(c[i : i + 2], 16) / 255 for i in (1, 3, 5)))[1]
        for c in colours
    ]
    assert all(abs(a - b) >= 0.1 for a, b in zip(lightness, lightness[1:])), (
        "neighbours alternate two lightness steps"
    )
    with pytest.raises(ValueError, match="'Amazonia' is not one of the 36 hotspots"):
        hs.colour("Amazonia")


def test_build_writes_each_area_with_its_unsimplified_area_and_each_outer_limit_in_its_hotspots_colour():
    first, second = hs.NAMES[0], hs.NAMES[1]
    islet = box(
        0.5, 3, 0.52, 3.02
    )  # 0.0004 deg²: under min_area, so dropped from the drawing but not from the area
    rows = area_rows()
    rows[0] = (
        first,
        "hotspot area",
        MultiPolygon([square(0), islet]).__geo_interface__,
    )
    rows += [
        (second, "outer limit", ring_around(1).__geo_interface__),
        (first, "outer limit", ring_around(0).__geo_interface__),
    ]
    feats, counts = hs.build(rows, tol=0.0001, min_area=0.001)
    assert counts["areas"] == 36 and counts["outer_limits"] == 2
    kinds = [(f["properties"]["kind"], f["properties"]["name"]) for f in feats]
    assert kinds == [("area", n) for n in hs.NAMES] + [
        ("outer", first),
        ("outer", second),
    ]
    a0 = feats[0]["properties"]
    assert (
        a0["color"] == hs.colour(first)
        and feats[36]["properties"]["color"] == a0["color"]
    )
    one = feats[1]["properties"]["area_km2"]
    assert one == pytest.approx(12364, rel=0.002), "a 1° square on the equator"
    assert a0["area_km2"] == pytest.approx(one * 1.0004, abs=2), (
        "the islet counts in the area"
    )
    assert shape(feats[0]["geometry"]).geom_type == "Polygon", "but is not drawn"
    assert "area_km2" not in feats[36]["properties"], (
        "an outer limit is not part of the hotspot: no area"
    )
    outer = shape(feats[36]["geometry"])
    assert outer.covers(Point(-0.2, 0.5)) and not outer.covers(Point(0.5, 0.5)), (
        "the hotspot's land stays a hole"
    )


def test_anything_but_the_36_areas_once_each_stops_the_build():
    rows = area_rows()
    assert hs.build(rows)[1]["areas"] == 36  # positive control
    with pytest.raises(ValueError, match=r"hotspot areas missing: \['Japan'\]"):
        hs.build([r for r in rows if r[0] != "Japan"])
    with pytest.raises(ValueError, match="'Japan' hotspot area appears twice"):
        hs.build(rows + [r for r in rows if r[0] == "Japan"])
    with pytest.raises(ValueError, match="'Amazonia' is not one of the 36 hotspots"):
        hs.build(rows + [("Amazonia", "hotspot area", square(40).__geo_interface__)])
    with pytest.raises(ValueError, match="'Amazonia' is not one of the 36 hotspots"):
        hs.build(
            rows + [("Amazonia", "outer limit", ring_around(40).__geo_interface__)]
        )
    with pytest.raises(ValueError, match="'Japan' outer limit appears twice"):
        hs.build(
            rows + [("Japan", "outer limit", ring_around(0).__geo_interface__)] * 2
        )
    with pytest.raises(
        ValueError,
        match="'Japan': type 'buffer' is neither 'hotspot area' nor 'outer limit'",
    ):
        hs.build(rows + [("Japan", "buffer", ring_around(0).__geo_interface__)])


def test_a_hotspot_part_wider_than_cesium_draws_is_cut_but_an_outer_limit_is_kept_whole():
    wide = box(-170, 10, -60, 20)  # 110° of longitude
    rows = area_rows()
    rows[5] = (hs.NAMES[5], "hotspot area", wide.__geo_interface__)
    rows.append(
        (
            hs.NAMES[5],
            "outer limit",
            box(-171, 9, -59, 21).difference(wide).__geo_interface__,
        )
    )
    feats, _ = hs.build(rows, tol=0.0001, min_area=0.0001)
    cut = shape(feats[5]["geometry"])
    assert [round(p.bounds[0]) for p in cut.geoms] == [-170, -90], (
        "cut at -90°, a multiple of 90° from -180°"
    )
    assert cut.symmetric_difference(wide).area < 1e-9
    assert shape(feats[36]["geometry"]).geom_type == "Polygon", (
        "an outline needs no cut: a cut would draw as a limit"
    )
    assert shape(feats[4]["geometry"]).equals(square(4)), (
        "positive control: a 1° hotspot is kept whole"
    )


def test_an_invalid_simplified_shape_stops_the_build(monkeypatch):
    rows = area_rows()
    assert hs.build(rows)[1]["areas"] == 36  # positive control
    bowtie = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
    }
    monkeypatch.setattr(hs, "simplify_geometry", lambda g, tol, min_area: bowtie)
    with pytest.raises(
        ValueError,
        match=f"{hs.NAMES[0]!r} hotspot area: simplified geometry is invalid",
    ):
        hs.build(rows)


def test_land_share_is_the_share_of_hotspot_area_on_land_and_the_premise_gate_needs_no_shift_clearly_best():
    geoms = [square(i) for i in range(36)]
    land = [square(i) for i in range(36)]
    assert hs.land_share(geoms, land) == pytest.approx(1.0)
    assert hs.land_share(geoms, land, 1, 1) == 0.0, (
        "shifted 1° E and N, a 1° square touches its land at a corner only"
    )
    assert hs.land_share(geoms, land, 0.5, 0) == pytest.approx(0.5, rel=1e-3)
    assert hs.land_share(geoms, land[:18]) == pytest.approx(0.5, rel=1e-3), (
        "land under half the squares"
    )
    ok = hs.premise(geoms, land)
    assert ok == {
        "land_share": pytest.approx(1.0),
        "land_share_shifted": 0.0,
        "shift_deg": [1.0, 1.0],
    }
    with pytest.raises(
        ValueError, match=r"only 50\.0% of hotspot area is on land at no shift"
    ):
        hs.premise(geoms, land[:18])
    with pytest.raises(
        ValueError, match=r"not clearly better than shifted 1° E, 1° N \(100\.0%\)"
    ):
        hs.premise(
            geoms, [box(-10, -10, 80, 10)]
        )  # land everywhere: the shifted control scores the same
    # the margin's edge: land over every square, plus a band north of them covering a share f of each shifted square
    def banded(f):
        return [box(-1, 0, 80, 1), box(-1, 1, 80, 1 + f)]

    assert hs.land_share(geoms, banded(0.951), 1, 1) == pytest.approx(0.951, abs=0.001)
    with pytest.raises(ValueError, match="not clearly better"):
        hs.premise(geoms, banded(0.951))  # 4.9 points better
    assert hs.premise(geoms, banded(0.94))["land_share_shifted"] == pytest.approx(0.94, abs=0.001), "6 points better passes"


def test_the_zip_is_used_only_when_its_md5_is_zenodos(tmp_path):
    src = make_zip(tmp_path / "src.zip", area_rows())
    good = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(src.read_bytes())

    cache = tmp_path / "cache"
    p = hs.fetch(cache, fetch_to=fetch_to, want=good)
    assert p.read_bytes() == src.read_bytes() and calls == [hs.FILE_URL]
    assert hs.fetch(cache, fetch_to=fetch_to, want=good) == p and len(calls) == 1, (
        "cached"
    )
    with pytest.raises(ValueError, match="is not Zenodo's"):
        hs.fetch(cache, fetch_to=fetch_to, want="0" * 32)
    p.unlink()
    with pytest.raises(ValueError, match="is not Zenodo's"):
        hs.fetch(cache, fetch_to=fetch_to, want="0" * 32)
    assert not p.exists() and not list(cache.glob("*.part")), (
        "a refused download leaves nothing"
    )


def test_read_rows_gives_name_type_and_shape_per_row(tmp_path):
    rows = area_rows()[:2] + [
        (hs.NAMES[0], "outer limit", ring_around(0).__geo_interface__)
    ]
    got = list(hs.read_rows(make_zip(tmp_path / "z.zip", rows)))
    assert [(n, k) for n, k, _ in got] == [(n, k) for n, k, _ in rows]
    assert shape(got[2][2]).equals(ring_around(0)), "holes survive the round trip"


def test_main_writes_the_collection_and_nothing_when_over_budget_or_off_land(tmp_path):
    src = make_zip(
        tmp_path / "src.zip",
        area_rows() + [(hs.NAMES[3], "outer limit", ring_around(3).__geo_interface__)],
    )
    good = hashlib.md5(src.read_bytes(), usedforsecurity=False).hexdigest()

    def fetch_to(url, path):
        path.write_bytes(src.read_bytes())

    land = [square(i) for i in range(36)]
    out = tmp_path / "out" / "hotspots.geojson"
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
    assert hs.main(args, fetch_to=fetch_to, want=good, land=land) == 0
    d = json.loads(out.read_text())
    assert len(d["features"]) == 37 and d["source"]["licence"].startswith(
        "CC BY-SA 4.0"
    )
    assert (
        "CC BY-SA 4.0" in d["source"]["note"] and "outer limit" in d["source"]["note"]
    )
    assert (
        d["counts"]["land_share"] == pytest.approx(1.0)
        and d["counts"]["land_share_shifted"] == 0.0
    )
    assert (
        d["counts"]["tol_deg"] == 0.0001
        and d["features"][36]["properties"]["kind"] == "outer"
    )
    before = out.read_bytes()
    with pytest.raises(SystemExit, match="over the 1,000 B budget: nothing written"):
        hs.main([*args, "--budget", "1000"], fetch_to=fetch_to, want=good, land=land)
    with pytest.raises(ValueError, match="hotspot area is on land at no shift"):
        hs.main(args, fetch_to=fetch_to, want=good, land=land[:10])
    assert out.read_bytes() == before


# Pre-registered from scripts/qa_hotspots_truth.py (GDAL + shapely on the raw zip, not this pipeline), 2026-10-07:
# (lat, lon) → (hotspot areas, outer limits) holding the point. Every point is ≥ 0.04° from any raw boundary.
POINTS = {
    "borneo": ((0.5, 114.0), ["Sundaland"], []),
    "cusco": ((-13.5, -72.0), ["Tropical Andes"], []),
    "viti-levu": ((-17.8, 178.0), ["Polynesia-Micronesia"], []),
    "banda-sea": ((-5.5, 127.0), [], ["Wallacea"]),
    "koro-sea": ((-17.5, 179.5), [], ["Polynesia-Micronesia"]),
    "fiji-east-of-180": ((-17.0, -179.5), [], ["Polynesia-Micronesia"]),
    "caribbean-sea": ((15.0, -75.0), [], []),
    "amazon": ((-3.0, -60.0), [], []),
    "edge-in-2": ((20.8146, -100.9382), ["Madrean Pine-Oak Woodlands"], []),
    "edge-out-8": ((32.2499, -109.0958), [], []),
    "edge-out-6": ((18.6584, -72.7865), [], ["Caribbean Islands"]),
    "antimeridian-in-1": ((-44.0142, -176.5207), ["New Zealand"], []),
    "antimeridian-out-1": ((-40.8595, 176.291), [], ["New Zealand"]),
}
# geodesic WGS 84 areas from the same script (km²); the pipeline's are spherical, so they agree to under 1%
TRUTH_KM2 = {
    "Sundaland": 1494436,
    "Polynesia-Micronesia": 47102,
    "Cerrado": 2024824,
    "New Zealand": 270590,
}


# Not skipped when the cache is empty: main downloads both inputs through the pinned fetchers (Zenodo md5, Natural
# Earth sha256), so a fresh CI runner checks the published shapes against the real source too.
def test_real_release_reads_the_raw_answer_at_pinned_and_random_points(tmp_path):
    out = tmp_path / "hotspots.geojson"
    assert hs.main(["--cache", str(CACHE), "--out", str(out)]) == 0
    assert REAL_ZIP.exists() and LAND_ZIP.exists()
    assert out.stat().st_size <= hs.BUDGET_BYTES
    d = json.loads(out.read_text())
    c = d["counts"]
    assert c["areas"] == 36 and c["outer_limits"] == 17
    assert c["land_share"] > 0.99 and c["land_share_shifted"] < 0.85, (
        "measured 99.43% and 83.29% on 2026-10-07"
    )
    area = {
        f["properties"]["name"]: shape(f["geometry"])
        for f in d["features"]
        if f["properties"]["kind"] == "area"
    }
    outer = {
        f["properties"]["name"]: shape(f["geometry"])
        for f in d["features"]
        if f["properties"]["kind"] == "outer"
    }
    assert sorted(area) == list(hs.NAMES)
    parts = [
        p for g in (*area.values(), *outer.values()) for p in getattr(g, "geoms", [g])
    ]
    assert all(p.is_valid for p in parts)
    km2 = {
        f["properties"]["name"]: f["properties"]["area_km2"]
        for f in d["features"]
        if f["properties"]["kind"] == "area"
    }
    for name, want in TRUTH_KM2.items():
        assert km2[name] == pytest.approx(want, rel=0.01), name

    raw_area, raw_outer = {}, {}
    for name, kind, geom in hs.read_rows(REAL_ZIP):
        (raw_area if kind == "hotspot area" else raw_outer)[name] = shape(geom).buffer(
            0
        )
    hits = lambda shapes, p: sorted(n for n, g in shapes.items() if g.covers(p))  # noqa: E731
    for name, ((lat, lon), want_area, want_outer) in POINTS.items():
        p = Point(lon, lat)
        assert (hits(raw_area, p), hits(raw_outer, p)) == (want_area, want_outer), (
            f"{name}: raw shapes"
        )
        assert (hits(area, p), hits(outer, p)) == (want_area, want_outer), (
            f"{name}: published shapes"
        )

    # Random points well clear of every raw boundary read on the published shapes what they read on the raw ones,
    # except on islets the drawing drops (parts under min_area before simplification, or that simplify below it).
    edges = STRtree([g.boundary for g in (*raw_area.values(), *raw_outer.values())])
    small = [
        p
        for g in raw_area.values()
        for p in getattr(g, "geoms", [g])
        if p.area < 4 * hs.MIN_AREA
    ]
    rng = random.Random(7)
    checked = agree = islet = 0
    while checked < 1500:
        name = rng.choice(hs.NAMES)
        x0, y0, x1, y1 = raw_area[name].bounds
        p = Point(rng.uniform(x0, x1), rng.uniform(y0, y1))
        if len(edges.query(p, predicate="dwithin", distance=hs.DEFAULT_TOL + 0.005)):
            continue
        checked += 1
        if (hits(raw_area, p), hits(raw_outer, p)) == (hits(area, p), hits(outer, p)):
            agree += 1
        else:
            assert any(s.covers(p) for s in small), (
                f"{p} reads differently and is not on an islet"
            )
            islet += 1
    assert agree >= 1450, (agree, islet)
