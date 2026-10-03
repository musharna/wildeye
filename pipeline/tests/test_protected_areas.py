"""Protected areas (docs/superpowers/specs/2026-10-03-protected-areas-design.md).

The extract runs the pipeline's own DuckDB query on a parquet file shaped like Overture's land_use (the columns it reads,
in the same structs, maps and lists), and the tiles are checked pixel by pixel on planted polygons whose right answer is
worked out by hand: at max level 2 a tile is 180 / 2² = 45° and a pixel 45 / 256°.
"""

import json

# a hard import: CI without duckdb must fail, not skip
import duckdb
import numpy as np
import pytest
import shapely
from PIL import Image
from shapely.geometry import LineString, Polygon, box

from pipeline import protected_areas as pa

P2 = 45 / 256  # pixel size at level 2 (geographic scheme: a level-z tile is 180 / 2^z degrees)


def _overture(path, rows):
    """A parquet file with Overture's land_use columns: rows are dicts with id, name, subtype, class, tags, dataset,
    license, record_id, wikidata, geom (shapely); extra sources via `more_sources`."""
    con = duckdb.connect()
    con.execute(
        """CREATE TABLE t (
            id VARCHAR,
            names STRUCT("primary" VARCHAR, common MAP(VARCHAR, VARCHAR)),
            subtype VARCHAR,
            class VARCHAR,
            source_tags MAP(VARCHAR, VARCHAR),
            sources STRUCT(property VARCHAR, dataset VARCHAR, license VARCHAR, record_id VARCHAR)[],
            wikidata VARCHAR,
            geometry BLOB,
            bbox STRUCT(xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE)
        )"""
    )
    for r in rows:
        g = r["geom"]
        w, s, e, n = g.bounds
        tags = r.get("tags", {})
        src = [
            (
                r.get("dataset", "OpenStreetMap"),
                r.get("license", "ODbL-1.0"),
                r.get("record_id", "r1@1"),
            )
        ] + r.get("more_sources", [])
        con.execute(
            'INSERT INTO t VALUES (?, struct_pack("primary" := ?, common := MAP {}::MAP(VARCHAR, VARCHAR)), ?, ?, '
            "MAP(?::VARCHAR[], ?::VARCHAR[]), ?::STRUCT(property VARCHAR, dataset VARCHAR, license VARCHAR, record_id VARCHAR)[], ?, ?, "
            "struct_pack(xmin := ?, xmax := ?, ymin := ?, ymax := ?))",
            [
                r["id"],
                r.get("name"),
                r.get("subtype", "protected"),
                r["class"],
                list(tags),
                list(tags.values()),
                [
                    {"property": "", "dataset": d, "license": li, "record_id": rid}
                    for d, li, rid in src
                ],
                r.get("wikidata"),
                shapely.to_wkb(g),
                w,
                e,
                s,
                n,
            ],
        )
    con.execute(f"COPY t TO '{path}' (FORMAT parquet)")
    return path


def _area(geom, group, name="a", cls="nature_reserve"):
    return pa.Area(name, cls, group, None, None, "w1", None, geom, pa.km2(geom))


def _row(**kw):
    return {
        "id": "x",
        "class": "national_park",
        "dataset": "OpenStreetMap",
        "license": "ODbL-1.0",
        "n_sources": 1,
        **kw,
    }


def test_class_table_groups_every_class_and_refuses_an_unread_class_or_source():
    pa.check_rows(
        [_row(**{"class": c}) for c in pa.CLASSES]
    )  # positive control: every read class and OSM source passes
    assert (
        pa.CLASSES["national_park"][0] == pa.NATIONAL_PARK
        and pa.CLASSES["wilderness_area"][0] == pa.STRICT
    )
    assert pa.CLASSES["aboriginal_land"][0] is pa.OUT
    with pytest.raises(
        pa.ProtectedAreasError, match="class 'marine_reserve' .* is not in CLASSES"
    ):
        pa.check_rows([_row(), _row(**{"class": "marine_reserve"})])
    with pytest.raises(
        pa.ProtectedAreasError, match="'Esri Community Maps' under 'CDLA'"
    ):
        pa.check_rows([_row(dataset="Esri Community Maps", license="CDLA")])
    with pytest.raises(pa.ProtectedAreasError, match="under 'CC-BY-4.0'"):
        pa.check_rows([_row(license="CC-BY-4.0")])
    with pytest.raises(pa.ProtectedAreasError, match="from 2 source"):
        pa.check_rows([_row(n_sources=2)])


def test_latest_release_takes_the_newest_including_a_two_digit_revision():
    xml = "".join(
        f"<Prefix>release/{n}/</Prefix>"
        for n in [
            "2026-08-19.0",
            "2026-09-23.1",
            "2026-09-23.10",
            "2026-09-23.2",
            "junk",
        ]
    )
    assert pa.latest_release(lambda url: xml.encode()) == "2026-09-23.10"
    with pytest.raises(pa.ProtectedAreasError, match="no release"):
        pa.latest_release(lambda url: b"<ListBucketResult></ListBucketResult>")
    assert pa.source_glob("2026-09-23.1").endswith(
        "release/2026-09-23.1/theme=base/type=land_use/*"
    )
    with pytest.raises(ValueError, match="not an Overture release"):
        pa.source_glob("2026-09-23.1/../x")


def test_extract_reads_overture_shaped_rows_and_keeps_only_protected_ones_in_the_bbox(
    tmp_path,
):
    ys = box(-111.0, 44.1, -110.0, 45.1)
    src = _overture(
        tmp_path / "lu.parquet",
        [
            {
                "id": "a",
                "name": "Yellowstone",
                "class": "national_park",
                "tags": {
                    "protection_title": "National Park",
                    "operator": "NPS",
                    "x": "y",
                },
                "record_id": "r1453306@35",
                "wikidata": "Q351",
                "geom": ys,
            },
            {
                "id": "b",
                "name": "City park",
                "subtype": "park",
                "class": "park",
                "geom": box(-110.5, 44.5, -110.4, 44.6),
            },
            {
                "id": "c",
                "name": "Far away",
                "class": "nature_reserve",
                "geom": box(10, 10, 11, 11),
            },
        ],
    )
    out = tmp_path / "staged.parquet"
    assert (
        pa.extract(duckdb.connect(), str(src), out, (-112.0, 44.0, -109.0, 46.0)) == 1
    )
    row = (
        duckdb.connect()
        .execute(
            "SELECT name, class, title, operator, osm, wikidata, dataset, license, n_sources, geometry FROM read_parquet($p)",
            {"p": str(out)},
        )
        .fetchone()
    )
    assert row[:9] == (
        "Yellowstone",
        "national_park",
        "National Park",
        "NPS",
        "r1453306",
        "Q351",
        "OpenStreetMap",
        "ODbL-1.0",
        1,
    )
    assert shapely.from_wkb(bytes(row[9])).equals(ys)
    # the whole globe: both protected rows, never the park subtype
    assert pa.extract(duckdb.connect(), str(src), out) == 2


def test_load_repairs_simplifies_and_counts_what_it_leaves_out(tmp_path):
    bowtie = Polygon(
        [(0, 0), (1, 1), (1, 0), (0, 1)]
    )  # self-intersecting: invalid until repaired
    assert not bowtie.is_valid
    src = _overture(
        tmp_path / "lu.parquet",
        [
            {"id": "a", "name": "Bow", "class": "nature_reserve", "geom": bowtie},
            {"id": "b", "name": "", "class": "national_park", "geom": box(5, 5, 6, 6)},
            {
                "id": "c",
                "name": "Tenure",
                "class": "aboriginal_land",
                "geom": box(7, 7, 8, 8),
            },
            {
                "id": "d",
                "name": "Line",
                "class": "forest",
                "geom": LineString([(0, 0), (1, 1)]),
            },
        ],
    )
    out = tmp_path / "staged.parquet"
    pa.extract(duckdb.connect(), str(src), out)
    areas, counts = pa.load(out)
    assert counts == {"rows": 4, "left_out_class": 1, "no_polygon": 1, "unnamed": 1}
    by = {a.osm and a.name: a for a in areas}
    assert by["Bow"].geom.is_valid and by["Bow"].geom.area == pytest.approx(0.5)
    assert by[None].group == pa.NATIONAL_PARK and by[None].km2 == pytest.approx(
        111.32**2 * np.cos(np.radians(5.5))
    )


def test_finest_tiles_paint_exact_pixels_and_the_most_protective_group_wins():
    # 10 × 10 pixels of "other" in the north-west corner of tile (0, 0); a strict square over its south-east 4 × 4
    other = box(-180, 90 - 10 * P2, -180 + 10 * P2, 90)
    strict = box(-180 + 6 * P2, 90 - 10 * P2, -180 + 10 * P2, 90 - 6 * P2)
    for areas in (
        [_area(other, pa.OTHER), _area(strict, pa.STRICT)],
        [_area(strict, pa.STRICT), _area(other, pa.OTHER)],
    ):
        tiles = pa.finest_tiles(areas, 2)
        assert list(tiles) == [(0, 0)]  # only the painted tile
        want = np.zeros((256, 256), np.uint8)
        want[:10, :10] = pa.OTHER
        want[6:10, 6:10] = pa.STRICT
        np.testing.assert_array_equal(tiles[(0, 0)], want)
    # a national park in the south-east corner of the globe lands in the last tile, last pixel
    se = box(180 - P2, -90, 180, -90 + P2)
    tiles = pa.finest_tiles([_area(se, pa.NATIONAL_PARK)], 2)
    assert (
        list(tiles) == [(7, 3)]
        and tiles[(7, 3)][255, 255] == pa.NATIONAL_PARK
        and tiles[(7, 3)].sum() == pa.NATIONAL_PARK
    )
    # an area reaching a tenth of a pixel into tile (0, 0) touches it but paints no pixel there: that tile is not kept
    sliver = box(-135 - 0.1 * P2, 80, -135 + 5 * P2, 85)
    assert list(pa.finest_tiles([_area(sliver, pa.OTHER)], 2)) == [(1, 0)]


def test_coarser_levels_keep_any_protection_and_colour_each_block_by_its_majority():
    one = box(
        -180 + 3 * P2, 90 - 4 * P2, -180 + 4 * P2, 90 - 3 * P2
    )  # pixel (row 3, col 3) of level-2 tile (0, 0)
    levels = dict(pa.pyramid(pa.finest_tiles([_area(one, pa.NATIONAL_PARK)], 2), 2))
    assert levels[2][(0, 0)][3, 3] == pa.NATIONAL_PARK
    assert (
        list(levels[1]) == [(0, 0)]
        and levels[1][(0, 0)][1, 1] == pa.NATIONAL_PARK
        and levels[1][(0, 0)].sum() == pa.NATIONAL_PARK
    )  # a lone pixel still shows: one protected pixel of four is a majority of the protected ones
    assert list(levels[0]) == [(0, 0)] and levels[0][(0, 0)][0, 0] == pa.NATIONAL_PARK
    # a child in the other half of the parent lands in that half: level-2 tile (1, 1) → level-1 tile (0, 0), pixels offset 128
    t = pa.coarser({(1, 1): np.full((256, 256), pa.OTHER, np.uint8)})
    assert (
        list(t) == [(0, 0)]
        and t[(0, 0)][128:, 128:].min() == pa.OTHER
        and t[(0, 0)][:128, :].max() == 0
    )
    # one 2 × 2 block each: 3 other + 1 strict → other; 2 park + 2 strict → strict (tie to the more protective);
    # 1 park + 3 empty → park; 2 other + 1 park + 1 strict → other
    child = np.zeros((256, 256), np.uint8)
    for col, block in enumerate(
        [
            [pa.OTHER, pa.OTHER, pa.OTHER, pa.STRICT],
            [pa.NATIONAL_PARK, pa.STRICT, pa.NATIONAL_PARK, pa.STRICT],
            [pa.NATIONAL_PARK, 0, 0, 0],
            [pa.OTHER, pa.NATIONAL_PARK, pa.OTHER, pa.STRICT],
        ]
    ):
        child[0:2, 2 * col : 2 * col + 2] = np.array(block, np.uint8).reshape(2, 2)
    got = pa.coarser({(0, 0): child})[(0, 0)][0, :5]
    assert got.tolist() == [pa.OTHER, pa.STRICT, pa.NATIONAL_PARK, pa.OTHER, 0]


def test_shard_key_folds_the_north_and_east_edges():
    assert pa.shard_key(44.6, -110.5) == (44, -111)
    assert pa.shard_key(90, 180) == (89, 179) and pa.shard_key(-90, -180) == (-90, -180)
    assert pa.shard_key(-0.1, -0.1) == (-1, -1)


def _decode(ring):
    """A shard ring back to (lon, lat) pairs: the first pair absolute, each later one a difference, in 1e-4 degrees."""
    xs, ys, x, y = [], [], 0, 0
    for i in range(0, len(ring), 2):
        x, y = (ring[i], ring[i + 1]) if i == 0 else (x + ring[i], y + ring[i + 1])
        xs.append(x / pa.COORD_SCALE)
        ys.append(y / pa.COORD_SCALE)
    return list(zip(xs, ys))


def test_rings_are_delta_integers_the_layer_decodes():
    # the literal src/data/protectedAreas.test.mjs decodes: shapely's box(1, 2, 3, 4) runs (3, 2), (3, 4), (1, 4), (1, 2)
    assert pa._rings(box(1, 2, 3, 4)) == [[30000, 20000, 0, 20000, -20000, 0, 0, -20000]]
    assert Polygon(_decode(pa._rings(box(1, 2, 3, 4))[0])).equals(box(1, 2, 3, 4))
    # rounded to 1e-4 degrees, the error never accumulating along the ring
    wobbly = Polygon([(10.00004, 0.00006), (10.99996, 0.0), (10.5, 0.99994)])
    got = _decode(pa._rings(wobbly)[0])
    assert got == [(10.0, 0.0001), (11.0, 0.0), (10.5, 0.9999)]


def test_shards_clip_each_area_to_its_cells_and_keep_holes():
    ring = box(0.3, 0.2, 1.8, 0.8).difference(
        box(1.2, 0.4, 1.4, 0.6)
    )  # spans cells (0, 0) and (0, 1); the hole lies in (0, 1)
    cells = pa.shards([_area(ring, pa.OTHER, name="Holey")])
    assert sorted(cells) == [(0, 0), (0, 1)]
    west, east = cells[(0, 0)][0], cells[(0, 1)][0]
    assert (
        west["name"] == "Holey"
        and len(west["polygons"]) == 1
        and len(west["polygons"][0]) == 1
    )  # no hole in the west part
    assert Polygon(_decode(west["polygons"][0][0])).equals(box(0.3, 0.2, 1, 0.8))
    assert len(east["polygons"][0]) == 2  # exterior + the hole
    assert Polygon(_decode(east["polygons"][0][0])).equals(box(1, 0.2, 1.8, 0.8))
    assert Polygon(_decode(east["polygons"][0][1])).equals(box(1.2, 0.4, 1.4, 0.6))


def test_main_writes_listed_tiles_and_shards_then_the_manifest_and_nothing_on_an_unread_class(
    tmp_path,
):
    src = _overture(
        tmp_path / "lu.parquet",
        [
            {
                "id": "a",
                "name": "Park",
                "class": "national_park",
                "geom": box(-110.6, 44.4, -110.4, 44.6),
            },
            {
                "id": "b",
                "name": "Wild",
                "class": "wilderness_area",
                "geom": box(20.0, -30.0, 21.0, -29.0),
            },
            # smaller than a level-3 pixel (0.088°) and covering no pixel centre: listed, never painted
            {
                "id": "c",
                "name": "Speck",
                "class": "nature_reserve",
                "geom": box(0.001, 0.001, 0.01, 0.01),
            },
            # the same, in the Park's tile (pixel centres at -110.3467 and -110.2588): the tile is painted, not here
            {
                "id": "d",
                "name": "Speck by the park",
                "class": "nature_reserve",
                "geom": box(-110.33, 44.45, -110.32, 44.46),
            },
            # a 0.02° square around one level-3 pixel centre (column 3200, row 1500): its whole window is one pixel
            {
                "id": "e",
                "name": "Dot",
                "class": "nature_reserve",
                "geom": box(101.2839453125, -41.8898828125, 101.3039453125, -41.8698828125),
            },
        ],
    )
    out = tmp_path / "out"
    assert (
        pa.main(
            [
                "--release",
                "2026-09-23.1",
                "--source",
                str(src),
                "--out-dir",
                str(out),
                "--staging",
                str(tmp_path / "st"),
                "--max-level",
                "3",
            ]
        )
        == 0
    )
    m = json.loads((out / "protected_areas.json").read_text())
    assert (
        m["release"] == "2026-09-23.1"
        and m["maxLevel"] == 3
        and m["counts"]["areas"] == 5
    )
    assert (
        m["counts"]["by_group"] == {"strict": 1, "national_park": 1, "other": 3}
        and m["counts"]["unpainted_at_max_level"] == 2
    )
    on_disk = sorted(
        str(p.relative_to(out / "protected" / "tiles"))
        for p in (out / "protected" / "tiles").rglob("*.png")
    )
    listed = sorted(f"{z}/{x}/{y}.png" for z, xy in m["tiles"].items() for x, y in xy)
    assert (
        on_disk == listed and len(listed) == 3 + 3 + 3 + 2
    )  # one tile per painting area at levels 3, 2 and 1; at level 0 Wild and Dot share the eastern tile
    # 1° cells; Wild's box ends on the 21°E and 29°S lines, so the cells past them get nothing
    assert sorted(m["shards"]) == [[-42, 101], [-30, 20], [0, 0], [44, -111]]
    assert m["shard_degrees"] == 1 and m["coord_scale"] == 10_000
    assert sorted(p.name for p in (out / "protected" / "shards").iterdir()) == [
        "-30_20.json",
        "-42_101.json",
        "0_0.json",
        "44_-111.json",
    ]
    z3 = m["tiles"]["3"]
    x, y = next(t for t in z3 if t[0] < 8)
    img = np.array(Image.open(out / "protected" / "tiles" / "3" / str(x) / f"{y}.png"))
    assert set(np.unique(img)) == {0, pa.NATIONAL_PARK}

    bad = _overture(
        tmp_path / "bad.parquet",
        [
            {
                "id": "z",
                "name": "New",
                "class": "marine_reserve",
                "geom": box(0, 0, 1, 1),
            }
        ],
    )
    out2 = tmp_path / "out2"
    with pytest.raises(pa.ProtectedAreasError, match="marine_reserve"):
        pa.main(
            [
                "--release",
                "2026-09-23.1",
                "--source",
                str(bad),
                "--out-dir",
                str(out2),
                "--staging",
                str(tmp_path / "st2"),
            ]
        )
    assert (
        not (out2 / "protected_areas.json").exists()
        and not (out2 / "protected").exists()
    )
