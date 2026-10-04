"""Intact Forest Landscapes: the pinned GeoPackages, their layout, burning the editions in order, the pyramid, the output.

The fixtures are the real November 2025 editions cut to four patches, rows and metadata tables copied verbatim with
sqlite3: SAM_80 (unchanged 2000-2025), SAM_77 (gone by 2013), SAM_171 (smaller in 2013 and in 2020) and SAM_134
(smaller in every edition, so all five classes occur). Expected classes at points are found with shapely from the
unsimplified polygons, not from the burned tiles.
"""

import hashlib
import io
import json
import shutil
import sqlite3
import struct
from pathlib import Path

import numpy as np
import pytest
import shapely
from PIL import Image
from pipeline import ifl

FIX = Path(__file__).parent / "fixtures" / "ifl"
YEARS = [2000, 2013, 2016, 2020, 2025]
SHAS = {
    y: hashlib.sha256((FIX / f"IFL_{y}.gpkg").read_bytes()).hexdigest() for y in YEARS
}
EDITIONS = tuple((y, SHAS[y]) for y in YEARS)


def stated(year):
    """(patches, hectares) read straight from the fixture with sqlite3."""
    con = sqlite3.connect(FIX / f"IFL_{year}.gpkg")
    n, ha = con.execute(
        f'select count(*), sum("Area{year}") from "IFL_{year}"'  # nosec B608 - year is one of the five fixture years in YEARS; a local read-only fixture
    ).fetchone()
    con.close()
    return n, ha


def pixel(tiles, lat, lon, z=ifl.MAX_LEVEL):
    """The burned class at a point: Cesium's geographic scheme, as the layer's readout reads it (0 = no tile or empty)."""
    n = 2**z * ifl.TILE
    gx, gy = int((lon + 180) / 360 * 2 * n), min(int((90 - lat) / 180 * n), n - 1)
    t = tiles.get((gx // ifl.TILE, gy // ifl.TILE))
    return 0 if t is None else int(t[gy % ifl.TILE, gx % ifl.TILE])


def test_geometry_blobs_with_each_envelope_and_refusals():
    wkb = shapely.to_wkb(shapely.box(0, 0, 1, 1))
    # envelope sizes from the GeoPackage standard, table 6: none, xy, xyz, xym, xyzm doubles
    for code, size in {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.items():
        blob = (
            b"GP\x00"
            + bytes([1 | (code << 1)])
            + struct.pack("<i", 4326)
            + b"\x00" * size
            + wkb
        )
        assert ifl.gpkg_geometry(blob).equals(shapely.box(0, 0, 1, 1)), code
    with pytest.raises(ifl.IflChanged, match="extended"):
        ifl.gpkg_geometry(b"GP\x00" + bytes([0x21]) + b"\x00" * 4 + wkb)
    with pytest.raises(ifl.IflChanged, match="envelope code 5"):
        ifl.gpkg_geometry(b"GP\x00" + bytes([1 | (5 << 1)]) + b"\x00" * 4 + wkb)
    with pytest.raises(ifl.IflChanged, match="not a version-1"):
        ifl.gpkg_geometry(b"XX\x00\x01" + b"\x00" * 4 + wkb)


def test_editions_are_fetched_once_and_refused_unless_pinned(tmp_path):
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes((FIX / "IFL_2013.gpkg").read_bytes())

    with pytest.raises(ifl.IflChanged, match="is not the pinned"):
        ifl.fetch(tmp_path, 2013, "0" * 64, fetch_to=fetch_to)
    assert not list(tmp_path.iterdir())  # the refused download is not kept
    got = ifl.fetch(tmp_path, 2013, SHAS[2013], fetch_to=fetch_to)  # positive control
    assert calls == ["https://intactforests.org/shp/IFL_2013.gpkg"] * 2
    assert ifl.fetch(tmp_path, 2013, SHAS[2013], fetch_to=fetch_to) == got
    assert len(calls) == 2  # the kept file is not fetched again
    got.write_bytes(b"changed")
    with pytest.raises(ifl.IflChanged, match="delete it to fetch again"):
        ifl.fetch(tmp_path, 2013, SHAS[2013], fetch_to=fetch_to)


def test_an_edition_is_read_only_in_its_documented_layout(tmp_path):
    rows = ifl.read_edition(
        FIX / "IFL_2000.gpkg", 2000
    )  # positive control: the real layout reads
    assert [r["id"] for r in rows] == ["SAM_134", "SAM_171", "SAM_77", "SAM_80"]  # fid order
    assert [r["id"] for r in ifl.read_edition(FIX / "IFL_2025.gpkg", 2025)] == ["SAM_80", "SAM_134", "SAM_171"]
    assert sum(r["area_ha"] for r in rows) == pytest.approx(stated(2000)[1])
    assert all(r["geom"].geom_type == "MultiPolygon" for r in rows)

    def changed(sql):
        p = tmp_path / "IFL_2000.gpkg"
        shutil.copy(FIX / "IFL_2000.gpkg", p)
        con = sqlite3.connect(p)
        con.execute(sql)
        con.commit()
        con.close()
        return p

    for sql, match in [
        ('alter table "IFL_2000" rename column "Area2000" to "Area_ha"', "columns are"),
        ("update gpkg_contents set srs_id = 3857", "gpkg_contents"),
        (
            "update gpkg_geometry_columns set geometry_type_name = 'GEOMETRY'",
            "geometry column",
        ),
    ]:
        with pytest.raises(ifl.IflChanged, match=match):
            ifl.read_edition(changed(sql), 2000)
    with pytest.raises(ifl.IflChanged, match="gpkg_contents"):
        ifl.read_edition(FIX / "IFL_2000.gpkg", 2013)  # the wrong year's table


def burned():
    raw = [
        [r["geom"] for r in ifl.read_edition(FIX / f"IFL_{y}.gpkg", y)] for y in YEARS
    ]
    simple = [
        [shapely.simplify(g, ifl.SIMPLIFY_DEG, preserve_topology=True) for g in gs]
        for gs in raw
    ]
    return raw, *ifl.burn(simple)


def test_each_place_holds_the_last_edition_that_covers_it():
    raw, tiles, stats = burned()
    unions = [shapely.union_all(gs) for gs in raw]
    for k in range(1, 6):
        # inside edition k and outside edition k + 1 (shapely, unsimplified): this place was last intact in k
        region = (
            unions[k - 1] if k == 5 else shapely.difference(unions[k - 1], unions[k])
        )
        # the centre of the widest circle inside it, whose radius clears a pixel's half-diagonal plus the simplification
        circle = shapely.maximum_inscribed_circle(region, 1e-5)
        p, radius = shapely.Point(circle.coords[0]), circle.length
        assert radius > 180 / 2**ifl.MAX_LEVEL / ifl.TILE * 0.71 + ifl.SIMPLIFY_DEG, (k, radius)
        assert pixel(tiles, p.y, p.x) == k, (k, p)
    outside = shapely.Point(-30.0, 0.0)  # mid-Atlantic, far from every fixture patch
    assert not any(u.contains(outside) for u in unions)
    assert pixel(tiles, outside.y, outside.x) == 0
    # each edition's burned area against its own stated area (within 2 % for patches of 500-1,000 km² at ~610 m)
    for y, s in zip(YEARS, stats):
        assert s["km2"] == pytest.approx(stated(y)[1] / 100, rel=0.02), y
    assert stats[0]["km2NotInPrevious"] == 0


def test_an_edition_covering_new_ground_is_counted_and_still_wins():
    a = shapely.box(10, 0, 11, 1)
    b = shapely.box(10.5, 0, 11.5, 1)  # half of it was not in the edition before
    tiles, stats = ifl.burn([[a], [b]])
    assert pixel(tiles, 0.5, 10.25) == 1  # only in the first
    assert pixel(tiles, 0.5, 10.75) == 2  # in both: the later wins
    assert pixel(tiles, 0.5, 11.25) == 2  # only in the later
    half = stats[1]["km2"] / 2
    assert stats[1]["km2NotInPrevious"] == pytest.approx(half, rel=0.01)
    assert stats[0]["km2NotInPrevious"] == 0
    # a later edition wholly inside the earlier one adds nothing new (positive control)
    _, nested = ifl.burn([[a], [shapely.box(10.2, 0.2, 10.8, 0.8)]])
    assert nested[1]["km2NotInPrevious"] == 0 and nested[1]["km2"] > 0
    # "previous" is the edition just before, not any earlier one: a, then elsewhere, then a again is all new ground
    _, back = ifl.burn([[a], [shapely.box(20, 0, 21, 1)], [a]])
    assert back[2]["km2NotInPrevious"] == pytest.approx(back[2]["km2"]) and back[2]["km2"] > 0


def test_coarser_levels_keep_the_majority_ties_to_the_more_recent():
    def child(values):
        t = np.zeros((ifl.TILE, ifl.TILE), np.uint8)
        t[0, 0], t[0, 1], t[1, 0], t[1, 1] = values
        return t

    for values, want in [
        ((5, 5, 1, 0), 5),
        ((1, 1, 5, 0), 1),
        ((2, 4, 0, 0), 4),
        ((0, 0, 0, 3), 3),
        ((1, 2, 3, 4), 4),
    ]:
        assert ifl.coarser({(0, 0): child(values)})[(0, 0)][0, 0] == want, values
    # child (1, 0) is the north-east quarter of its parent: x is the column, y the row
    parent = ifl.coarser({(1, 0): child((5, 5, 5, 5))})
    assert list(parent) == [(0, 0)]
    assert parent[(0, 0)][0, 128] == 5 and parent[(0, 0)][128, 0] == 0 and parent[(0, 0)][0, 0] == 0


def test_main_writes_listed_tiles_and_a_manifest_with_the_stated_and_burned_areas(
    tmp_path,
):
    def fetch_to(url, path):
        path.write_bytes((FIX / Path(url).name).read_bytes())

    out = tmp_path / "out"
    m = ifl.main(
        ["--out-dir", str(out), "--cache", str(tmp_path / "cache")],
        fetch_to=fetch_to,
        editions=EDITIONS,
    )
    on_disk = json.loads((out / "ifl.json").read_text())
    assert on_disk["tiles"] == m["tiles"]
    listed = {f"{z}/{x}/{y}.png" for z, xs in m["tiles"].items() for x, y in xs}
    written = {str(p.relative_to(out / "ifl")) for p in (out / "ifl").rglob("*.png")}
    assert listed == written and len(m["tiles"]) == ifl.MAX_LEVEL + 1
    # the readout decodes tiles with src/data/pngDecode.js, which reads 8-bit images only: IHDR bit depth 8, palette
    for p in (out / "ifl").rglob("*.png"):
        head = p.read_bytes()[:26]
        assert head[12:16] == b"IHDR" and (head[24], head[25]) == (8, 3), (p, head[24], head[25])
    assert (
        [e["patches"] for e in m["editions"]]
        == [stated(y)[0] for y in YEARS]
        == [4, 3, 3, 3, 3]
    )
    assert [e["areaHa"] for e in m["editions"]] == [round(stated(y)[1]) for y in YEARS]
    assert (
        m["classes"][4]["label"] == "intact forest landscape in 2025"
        and m["source"]["licence"] == "CC BY 4.0"
    )
    # a tile as the browser decodes it: the class colour, opaque; an empty pixel, transparent
    z = str(ifl.MAX_LEVEL)
    x, y = m["tiles"][z][0]
    im = np.asarray(
        Image.open(
            io.BytesIO((out / "ifl" / z / str(x) / f"{y}.png").read_bytes())
        ).convert("RGBA")
    )
    colours = {tuple(c["rgb"] + [255]) for c in ifl.CLASSES}
    seen = {tuple(px) for px in im.reshape(-1, 4) if px[3]}
    assert seen and seen <= colours
    assert (im[..., 3] == 0).any() and (im[im[..., 3] == 0][:, :3] == 0).all()
