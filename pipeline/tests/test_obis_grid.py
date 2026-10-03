"""OBIS record grid (docs/superpowers/specs/2026-10-02-obis-grid-design.md).

The cell sums run the pipeline's own DuckDB query on parquet files shaped like OBIS's export (the columns it reads, inside
the same `interpreted` struct), with planted records whose right answer is written out by hand.
"""

import json

import pytest

import duckdb  # noqa: E402  (a hard import: CI without duckdb must fail, not skip)

from pipeline import obis_grid as og  # noqa: E402
from pipeline import obis_licences as ol  # noqa: E402

CC0_TEXT = (
    "To the extent possible under law, the publisher has waived all rights to these data and has dedicated them to the  "
    "Public Domain (CC0 1.0)"
)
BY_TEXT = (
    "This work is licensed under a  Creative Commons Attribution (CC-BY) 4.0 License"
)
NC_TEXT = "This work is licensed under a  Creative Commons Attribution Non Commercial (CC-BY-NC) 4.0 License"


def test_licence_table_reads_every_wording_and_refuses_an_unread_one():
    assert ol.licence(CC0_TEXT) == ol.CC0
    assert ol.licence(BY_TEXT) == ol.CC_BY
    # OBIS serves the same wording with other runs of spaces and newlines
    assert (
        ol.licence(
            "This work is licensed under a\n         Creative Commons Attribution (CC-BY) 4.0 License"
        )
        == ol.CC_BY
    )
    assert ol.licence(NC_TEXT) == ol.OUT
    # 580 datasets say non-commercial and CC-BY at once: the restrictive reading wins
    assert (
        ol.licence(
            "This work is licensed under a Creative Commons Attribution Non Commercial (CC-BY) 4.0 License"
        )
        == ol.OUT
    )
    assert ol.licence(None) == ol.OUT and ol.licence("Unrestricted") == ol.OUT
    with pytest.raises(ol.LicenceError, match="not classed"):
        ol.licence(
            "This work is licensed under a Creative Commons Attribution 5.0 License"
        )


def _export(path, dataset, rows):
    """A parquet file with the export's columns: rows are (lat, lon, species id, year, dropped, absence)."""
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE r (dataset_id VARCHAR, la DOUBLE, lo DOUBLE, sp BIGINT, y INTEGER, dropped BOOLEAN, absence BOOLEAN)"
    )
    con.executemany("INSERT INTO r VALUES (?, ?, ?, ?, ?, ?, ?)", [(dataset, *row) for row in rows])
    con.execute(
        "CREATE VIEW export AS SELECT dataset_id, dropped, absence, struct_pack(decimalLatitude := la, "
        "decimalLongitude := lo, speciesid := sp, date_year := y) AS interpreted FROM r"
    )
    con.execute(f"COPY export TO '{path}' (FORMAT parquet)")  # nosec B608 - path is pytest's tmp_path, no other value
    return path


A_ROWS = [
    (10.2, -19.9, 1, 2001, False, False),
    (10.9, -19.1, 1, 2005, False, False),
    (
        10.5,
        -19.5,
        2,
        1999,
        True,
        False,
    ),  # dropped by OBIS's quality checks: not counted
    (10.5, -19.5, 3, 2010, False, True),  # an absence: not counted
    (
        -0.5,
        -0.5,
        None,
        None,
        False,
        False,
    ),  # not identified to species: a record, no species, no year
    (
        90.0,
        180.0,
        4,
        2020,
        False,
        False,
    ),  # the pole and the antimeridian fold into the last cell
]
B_ROWS = [
    (10.0, -20.0, 1, 1990, False, False),  # on the cell's south-west corner: in it
    (10.1, -19.8, 5, 2015, False, False),
]


def test_cells_sum_records_species_datasets_and_years(tmp_path):
    con = og.connect()
    a = og.stage(
        con,
        str(_export(tmp_path / "a.parquet", "A", A_ROWS)),
        "A",
        tmp_path / "A.parquet",
    )
    b = og.stage(
        con,
        str(_export(tmp_path / "b.parquet", "B", B_ROWS)),
        "B",
        tmp_path / "B.parquet",
    )
    assert (a, b) == (4, 2)
    cells = og.aggregate(con, [tmp_path / "A.parquet", tmp_path / "B.parquet"])
    assert cells == [
        [-1, -1, 1, 0, 1, None, None],
        [
            10,
            -20,
            4,
            2,
            2,
            1990,
            2015,
        ],  # species 1 in both datasets counts once; 2 and 3 were dropped / absent; B's 2015 record is in this cell
        [89, 179, 1, 1, 1, 2020, 2020],
    ]


def test_record_classes_and_pixels():
    assert [
        og.record_bin(n) for n in (1, 9, 10, 99, 100, 999_999, 1_000_000, 50_000_000)
    ] == [0, 0, 1, 1, 2, 5, 6, 6]
    with pytest.raises(ValueError, match="at least one record"):
        og.record_bin(0)
    import io

    from PIL import Image

    im = Image.open(
        io.BytesIO(
            og.render(
                [[89, -180, 5, 1, 1, 2000, 2000], [-90, 179, 10_000, 3, 1, 2000, 2000]]
            )
        )
    )
    assert im.size == (360, 180)
    assert im.getpixel((0, 0)) == 0  # 89–90°N, 180–179°W: north-west corner
    assert im.getpixel((359, 179)) == 4  # 90–89°S, 179–180°E: south-east corner
    assert im.getpixel((180, 90)) == og.NODATA
    rgba = im.convert("RGBA")
    assert rgba.getpixel((180, 90))[3] == 0  # no records: transparent
    assert rgba.getpixel((0, 0)) == (*og.RAMP[0], 255)  # positive control: a drawn cell is opaque, in its class colour


def _fake_api(datasets, files):
    """get() for the dataset listing (one page) and the S3 listing (one page)."""

    def get(url):
        if url.startswith(og.API + "/dataset"):
            return json.dumps({"total": len(datasets), "results": datasets}).encode()
        if url.startswith(og.BUCKET):
            body = "".join(
                f"<Contents><Key>occurrence/{i}.parquet</Key><LastModified>x</LastModified><ETag>&quot;{e}&quot;</ETag>"
                "<Size>1</Size></Contents>"
                for i, e in files.items()
            )
            return f"<ListBucketResult>{body}</ListBucketResult>".encode()
        raise AssertionError(url)

    return get


IDS = {k: f"{k * 8}-0000-0000-0000-000000000000"[:36] for k in "abcd"}


def test_main_draws_only_cc0_and_cc_by_datasets(tmp_path):
    src = {
        IDS["a"]: _export(tmp_path / "a.parquet", IDS["a"], A_ROWS),
        IDS["b"]: _export(tmp_path / "b.parquet", IDS["b"], B_ROWS),
        IDS["c"]: _export(
            tmp_path / "c.parquet", IDS["c"], [(40.5, 5.5, 9, 2000, False, False)]
        ),
    }
    datasets = [
        {"id": IDS["a"], "title": "A", "records": 6, "intellectualrights": CC0_TEXT},
        {"id": IDS["b"], "title": "B", "records": 2, "intellectualrights": BY_TEXT},
        {"id": IDS["c"], "title": "C", "records": 1, "intellectualrights": NC_TEXT},
        {
            "id": IDS["d"],
            "title": "D",
            "records": 7,
            "intellectualrights": BY_TEXT,
        },  # listed, not in the export
    ]
    files = {IDS["a"]: "e1", IDS["b"]: "e2", IDS["c"]: "e3"}
    out = tmp_path / "out"
    argv = ["--out-dir", str(out), "--staging", str(tmp_path / "staging")]
    assert (
        og.main(argv, get=_fake_api(datasets, files), source_url=lambda i: str(src[i]))
        == 0
    )
    doc = json.loads((out / "obis_grid.json").read_text())
    assert [c[:2] for c in doc["cells"]] == [
        [-1, -1],
        [10, -20],
        [89, 179],
    ]  # C's 40°N 5°E cell is not drawn
    assert doc["share"] == {
        "datasets_in": 2,
        "datasets_total": 4,
        "datasets_out": 1,
        "records_in": 6,
        "records_total_listed": 16,
    }
    listed = json.loads((out / "obis_grid_datasets.json").read_text())["datasets"]
    assert [(d["title"], d["licence"], d["records"]) for d in listed] == [
        ("A", ol.CC0, 4),
        ("B", ol.CC_BY, 2),
    ]
    assert (out / "obis_grid.png").exists()
    # a wording nobody has read stops the run before anything is written
    datasets.append(
        {
            "id": IDS["d"],
            "title": "E",
            "records": 1,
            "intellectualrights": "All rights reserved",
        }
    )
    out2 = tmp_path / "out2"
    with pytest.raises(ol.LicenceError, match="All rights reserved"):
        og.main(
            ["--out-dir", str(out2), "--staging", str(tmp_path / "staging")],
            get=_fake_api(datasets, files),
        )
    assert not out2.exists()


def test_a_rerun_reads_only_datasets_whose_file_changed(tmp_path):
    src = _export(tmp_path / "a.parquet", IDS["a"], A_ROWS)
    datasets = [{"id": IDS["a"], "title": "A", "records": 6, "licence": ol.CC0}]
    read = []

    def source_url(i):
        read.append(i)
        return str(src)

    staging = tmp_path / "staging"
    first, _ = og.build(datasets, {IDS["a"]: "e1"}, staging, source_url=source_url)
    again, _ = og.build(datasets, {IDS["a"]: "e1"}, staging, source_url=source_url)
    assert read == [IDS["a"]] and again["cells"] == first["cells"]
    # positive control in the same test: a new ETag means a new file, read again
    og.build(datasets, {IDS["a"]: "e2"}, staging, source_url=source_url)
    assert read == [IDS["a"], IDS["a"]]
