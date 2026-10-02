"""BioTIME 2.0 pipeline: pinned files, per-study licence filter, citations, per-year counts (spec 2026-10-01-biotime-design.md)."""

import csv
import gzip
import hashlib
import io
import json

import pytest

from pipeline import biotime

META_FIELDS = [
    "STUDY_ID",
    "REALM",
    "TAXA",
    "ORGANISMS",
    "TITLE",
    "START_YEAR",
    "END_YEAR",
    "CENT_LAT",
    "CENT_LONG",
    "AREA_SQ_KM",
    "CONTACT_1",
    "CONT_1_MAIL",
    "PERMISSIONS",
    "WEB_LINK",
]
BIB_WEBB = (
    "@Article{BioTIME_cit1,\n  Study_id = {10},\n  Citation_id = {1},\n  Author = {Sara L Webb and Sara E Scanga},\n"
    "  Journal = {Ecology},\n  Number = {3},\n  Pages = {893-897},\n  Title = {Windstorm disturbance without patch "
    "dynamics: twelve years of change in a {Minnesota} forest},\n  Volume = {82},\n  Year = {2001},\n"
    "  Doi = {10.2307/2680207}\n}"
)


def meta_row(sid, perm="CC-by", area="5.0", taxa="Birds"):
    return {
        "STUDY_ID": str(sid),
        "REALM": "Terrestrial",
        "TAXA": taxa,
        "ORGANISMS": "songbirds",
        "TITLE": f"Study {sid}",
        "START_YEAR": "1990",
        "END_YEAR": "1995",
        "CENT_LAT": "47.4",
        "CENT_LONG": "-95.12",
        "AREA_SQ_KM": area,
        "CONTACT_1": "A Person",
        "CONT_1_MAIL": "person@example.org",
        "PERMISSIONS": perm,
        "WEB_LINK": "http://x.org/s",
    }


def write_csv(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fields)
        w.writeheader()
        w.writerows(rows)
    return path


def records_csv(rows):
    """The extract's output: gzipped CSV sorted by study then year."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(biotime.EXTRACT_COLUMNS)
    w.writerows(rows)
    return gzip.compress(buf.getvalue().encode())


def test_source_is_the_pinned_zenodo_v2_issue():
    assert biotime.RECORD == 15222193
    assert biotime.SOURCE["rds"] == (
        "biotime_v2_query_15April25.rds",
        "2fed9f6c8028d4c44d80769c594be056",
    )
    assert biotime.SOURCE["meta"] == (
        "biotime_v2_metadata_15April25.csv",
        "3daed71ed554888309f9f2443a847bea",
    )
    assert biotime.SOURCE["refs"] == (
        "references_biotime_v2_15April25.csv",
        "3c963064177e4369ccb730cee536651e",
    )


def test_licences_class_by_the_table_and_an_unknown_string_fails_loud():
    cases = {
        "CC-by": "open",
        "CC BYÂ ": "open",
        "ODC-by ": "open",
        "PDDL": "open",
        "U.S. Public Domain": "open",
        "Open Government Licence v3 (OGL)": "open",
        "CC0 1.0 Universal (CC0 1.0)\nPublic Domain Dedication": "open",
        "ODbL (CC-by-NC)": "non-commercial",
        "CC BY-NC-SA 4.0": "non-commercial",
        "CC-By-NC": "non-commercial",
        "ODbL": "share-alike",
        "Attribution and share-alike OdbL": "share-alike",
        "CC BY-SA": "share-alike",
        "": "unclear",
        "Citation required.": "unclear",
        "Public ": "unclear",
    }
    for text, want in cases.items():
        assert biotime.licence_class(text) == want, text
    with pytest.raises(ValueError, match="CC BY-ND"):
        biotime.licence_class("CC BY-ND")


def test_mojibake_is_repaired_and_clean_text_is_left_alone():
    assert biotime.repair("Australiaâ€™s IMOS â€“ NCRIS") == "Australia’s IMOS – NCRIS"
    assert biotime.repair("CC BYÂ ") == "CC BY"
    assert biotime.repair("Zürich, Université – fine") == "Zürich, Université – fine"


def test_citations_are_formatted_from_the_bibtex_in_citation_order():
    second = (
        BIB_WEBB.replace("Citation_id = {1}", "Citation_id = {2}")
        .replace(
            "Author = {Sara L Webb and Sara E Scanga}",
            "Author = {Smith, J and Jones, K and Lee, M}",
        )
        .replace("Year = {2001}", "Year = {2005}")
    )
    refs = biotime.read_citations_rows(
        [
            {"STUDY_ID": "10", "CITATION_ID": "2", "BIB": second},
            {"STUDY_ID": "10", "CITATION_ID": "1", "BIB": BIB_WEBB},
            {
                "STUDY_ID": "11",
                "CITATION_ID": "3",
                "BIB": "@Misc{x,\n  Title = {Only a title}\n}",
            },
        ]
    )
    assert refs[10][0] == (
        "Webb & Scanga (2001). Windstorm disturbance without patch dynamics: twelve years of change in a "
        "Minnesota forest. Ecology 82(3):893-897. doi:10.2307/2680207"
    )
    assert refs[10][1].startswith("Smith et al. (2005). Windstorm")
    assert refs[11] == ["Only a title."]


def test_counts_per_study_year_are_distinct_taxa_and_distinct_samples():
    rows = [
        (10, 1990, "s1", 47.40, -95.12, "Parus major"),
        (
            10,
            1990,
            "s1",
            47.40,
            -95.12,
            "Parus major",
        ),  # the same taxon twice in one sample
        (10, 1990, "s2", 47.40, -95.12, "Sitta europaea"),
        (10, 1992, "s9", 47.40, -95.12, "Parus major"),
        (
            12,
            1991,
            "a",
            10.0,
            20.0,
            "Sardina pilchardus",
        ),  # a dropped study: never counted
        (30, 2001, "t1", -30.123, 150.456, "Gadus morhua"),
        (30, 2001, "t2", -30.124, 150.456, "Gadus morhua"),  # the same 0.01° cell as t1
        (30, 2001, "t3", -31.5, 151.0, "Merluccius merluccius"),
        # a tie for rounding (R gives -139.02, Python -139.03) but one grid cell in both: cells are floor(x * 100)
        (30, 2001, "t4", 69.5533, -139.025, "Gadus morhua"),
        (30, 2001, "t5", 69.5533, -139.027, "Gadus morhua"),
    ]
    years, locs = biotime.count_years(
        biotime.iter_records(io.BytesIO(records_csv(rows))), keep={10, 30}, wide={30}
    )
    assert years == {10: {1990: (2, 2), 1992: (1, 1)}, 30: {2001: (2, 5)}}
    assert locs == {
        30: {2001: [(-139.025, 69.555), (150.455, -30.125), (151.005, -31.495)]}
    }, "wide studies only, 0.01° grid cells drawn at their centres, deduplicated"


def test_records_out_of_order_or_with_a_missing_field_are_refused():
    shuffled = records_csv(
        [(10, 1992, "s", 1.0, 2.0, "A a"), (10, 1990, "s", 1.0, 2.0, "A a")]
    )
    with pytest.raises(ValueError, match="sorted"):
        biotime.count_years(
            biotime.iter_records(io.BytesIO(shuffled)), keep={10}, wide=set()
        )
    renamed = gzip.compress(
        b"STUDY_ID,YEAR,SAMPLE,LATITUDE,LONGITUDE,valid_name\n10,1990,s,1.0,2.0,A a\n"
    )
    with pytest.raises(ValueError, match="extract columns"):
        list(biotime.iter_records(io.BytesIO(renamed)))
    holed = records_csv(
        [(10, 1990, "s", 1.0, 2.0, "A a"), (10, "NA", "s", 1.0, 2.0, "A a")]
    )
    with pytest.raises(ValueError, match="YEAR"):
        biotime.count_years(
            biotime.iter_records(io.BytesIO(holed)), keep={10}, wide=set()
        )
    ok = records_csv(
        [(10, 1990, "s", 1.0, 2.0, "A a"), (10, 1991, "s", 1.0, 2.0, "A a")]
    )
    assert biotime.count_years(
        biotime.iter_records(io.BytesIO(ok)), keep={10}, wide=set()
    )[0] == {10: {1990: (1, 1), 1991: (1, 1)}}


def test_fetch_refuses_a_wrong_md5_and_keeps_only_a_checked_file(tmp_path):
    body = b"rds bytes"
    good = hashlib.md5(body, usedforsecurity=False).hexdigest()
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(body)

    p = biotime.fetch(tmp_path, ("f.rds", good), fetch_to=fetch_to)
    assert p.read_bytes() == body and calls == [
        "https://zenodo.org/records/15222193/files/f.rds?download=1"
    ]
    assert (
        biotime.fetch(tmp_path, ("f.rds", good), fetch_to=fetch_to) == p
        and len(calls) == 1
    ), "cached"
    with pytest.raises(ValueError, match="md5"):
        biotime.fetch(tmp_path, ("f.rds", "0" * 32), fetch_to=fetch_to)
    with pytest.raises(ValueError, match="md5"):
        biotime.fetch(tmp_path, ("g.rds", "0" * 32), fetch_to=fetch_to)
    assert not (tmp_path / "g.rds").exists() and not list(tmp_path.glob("*.part")), (
        "a refused download leaves nothing"
    )


def test_main_writes_open_studies_only_with_counts_citations_and_no_contacts(tmp_path):
    cache, out = tmp_path / "cache", tmp_path / "out"
    cache.mkdir()
    write_csv(
        cache / "meta.csv",
        META_FIELDS,
        [
            meta_row(10, "CC-by"),
            meta_row(12, "ODbL (CC-by-NC)"),
            meta_row(13, "ODbL"),
            meta_row(14, "Citation required"),
            meta_row(30, "CC0", area="250000", taxa="Fish"),
        ],
    )
    write_csv(
        cache / "refs.csv",
        ["STUDY_ID", "CITATION_ID", "BIB"],
        [{"STUDY_ID": "10", "CITATION_ID": "1", "BIB": BIB_WEBB}],
    )
    (cache / "src.rds").write_bytes(b"rds")
    files = {"rds": "src.rds", "meta": "meta.csv", "refs": "refs.csv"}
    source = {
        k: (
            name,
            hashlib.md5((cache / name).read_bytes(), usedforsecurity=False).hexdigest(),
        )
        for k, name in files.items()
    }
    extracted = []

    def extract(rds, dest):
        extracted.append(rds)
        dest.write_bytes(
            records_csv(
                [
                    (10, 1990, "s1", 47.4, -95.12, "Parus major"),
                    (10, 1990, "s2", 47.4, -95.12, "Sitta europaea"),
                    (12, 1991, "a", 1.0, 1.0, "X y"),
                    (13, 1991, "a", 1.0, 1.0, "X y"),
                    (14, 1991, "a", 1.0, 1.0, "X y"),
                    (30, 2001, "t1", -30.0, 150.0, "Gadus morhua"),
                ]
            )
        )

    biotime.main(
        ["--cache", str(cache), "--out-dir", str(out)],
        fetch_to=None,
        source=source,
        extract=extract,
    )
    assert extracted == [cache / "src.rds"]
    m = json.loads((out / "biotime.json").read_text())
    assert [s["id"] for s in m["studies"]] == [10, 30]
    assert m["dropped"] == {"non-commercial": 1, "share-alike": 1, "unclear": 1}
    s10 = m["studies"][0]
    assert (
        s10["years"] == {"1990": [2, 2]}
        and s10["wide"] is False
        and s10["licence"] == "CC-by"
    )
    assert (
        s10["citations"] == [biotime.format_bib(BIB_WEBB)]
        and s10["lat"] == 47.4
        and s10["lon"] == -95.12
    )
    assert m["studies"][1]["wide"] is True and m["studies"][1]["citations"] == []
    text = (out / "biotime.json").read_text()
    assert "person@example.org" not in text and "A Person" not in text, (
        "contacts are not published"
    )
    assert (
        m["source"]["doi"] == "10.1111/geb.70003"
        and "CC BY 4.0" in m["source"]["licence"]
    )
    locs = json.loads((out / biotime.LOCATIONS).read_text())
    assert locs == {"30": {"2001": [[150.005, -29.995]]}}
