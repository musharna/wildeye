import io
import json
import zipfile

import pytest

from pipeline.griis import (
    area_of,
    list_checklists,
    cached_archive,
    read_dwca,
    count_list,
    load_units,
    build,
)

DWC = "http://rs.tdwg.org/dwc/terms/"
GBIF = "http://rs.gbif.org/terms/1.0/"


def meta_xml(files):
    """files = [(kind, rowType, location, [(index|None, term, default)], sep, header)] → a DwC-A meta.xml."""
    parts = ['<archive xmlns="http://rs.tdwg.org/dwc/text/" metadata="eml.xml">']
    for kind, row_type, loc, fields, sep, header in files:
        tag = "core" if kind == "core" else "extension"
        idtag = "id" if kind == "core" else "coreid"
        parts.append(
            f'<{tag} encoding="UTF-8" fieldsTerminatedBy="{sep}" linesTerminatedBy="\\n" fieldsEnclosedBy="" '
            f'ignoreHeaderLines="{header}" rowType="{row_type}"><files><location>{loc}</location></files><{idtag} index="0" />'
        )
        for idx, term, default in fields:
            ia = f' index="{idx}"' if idx is not None else ""
            da = f' default="{default}"' if default is not None else ""
            parts.append(f'<field{ia} term="{term}"{da}/>')
        parts.append(f"</{tag}>")
    parts.append("</archive>")
    return "".join(parts)


def dwca(files, texts):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("meta.xml", meta_xml(files))
        for name, text in texts.items():
            z.writestr(name, text)
    return buf.getvalue()


def test_read_dwca_maps_columns_by_meta_xml_index_not_by_header_names():
    files = [
        (
            "core",
            DWC + "Taxon",
            "taxon.txt",
            [(1, DWC + "scientificName", None), (2, DWC + "kingdom", None)],
            "\\t",
            1,
        ),
        (
            "ext",
            GBIF + "Distribution",
            "distribution.txt",
            [
                (1, DWC + "countryCode", None),
                (2, DWC + "occurrenceStatus", None),
                (None, DWC + "establishmentMeans", "Alien"),
            ],
            "\\t",
            1,
        ),
        (
            "ext",
            GBIF + "SpeciesProfile",
            "sp.csv",
            [(1, GBIF + "isInvasive", None)],
            ",",
            0,
        ),
    ]
    texts = {
        # headers deliberately wrong: the reader must go by meta.xml indexes
        "taxon.txt": "id\tWRONG\tALSO_WRONG\n1\tRattus rattus\tAnimalia\n2\tLantana camara\tPlantae\n",
        "distribution.txt": "id\tx\ty\n1\tWS\tPresent\n2\tWS\tPresent\n",
        "sp.csv": "1,Invasive\n2,null\n",
    }
    t = read_dwca(dwca(files, texts))
    assert t["Taxon"] == [
        {"id": "1", "scientificName": "Rattus rattus", "kingdom": "Animalia"},
        {"id": "2", "scientificName": "Lantana camara", "kingdom": "Plantae"},
    ]
    assert t["Distribution"][0] == {
        "id": "1",
        "countryCode": "WS",
        "occurrenceStatus": "Present",
        "establishmentMeans": "Alien",
    }, "a field with only a default takes it on every row"
    assert [r["isInvasive"] for r in t["SpeciesProfile"]] == ["Invasive", "null"], (
        "header-less comma file read in full"
    )

    no_meta = io.BytesIO()
    with zipfile.ZipFile(no_meta, "w") as z:
        z.writestr("taxon.txt", "id\n1\n")
    with pytest.raises(ValueError, match="meta.xml"):
        read_dwca(no_meta.getvalue())

    short = dwca(files, {**texts, "distribution.txt": "id\tx\ty\n1\tWS\n"})
    with pytest.raises(
        ValueError, match="distribution.txt line 2: 2 columns, meta.xml needs 3"
    ):
        read_dwca(short)


def ds(
    key,
    title,
    *,
    modified="2026-03-28T10:00:00.000+00:00",
    archive=True,
    dtype="CHECKLIST",
):
    eps = [{"type": "EML", "url": f"https://cloud.gbif.org/griis/eml.do?r={key}"}]
    if archive:
        eps.append(
            {
                "type": "DWC_ARCHIVE",
                "url": f"https://cloud.gbif.org/griis/archive.do?r={key}",
            }
        )
    return {
        "key": key,
        "title": title,
        "type": dtype,
        "modified": modified,
        "doi": f"10.15468/{key}",
        "license": "http://creativecommons.org/licenses/by/4.0/legalcode",
        "citation": {"text": f"Pagad S (2026). {title}. ISSG."},
        "endpoints": eps,
    }


def test_area_of_strips_the_register_prefix_and_the_version_tag():
    assert (
        area_of("Global Register of Introduced and Invasive Species - New Zealand")
        == "New Zealand"
    )
    assert (
        area_of("Global Register of Introduced and Invasive Species -Samoa") == "Samoa"
    )
    assert (
        area_of("Global Register of Introduced and Invasive Species- Egypt") == "Egypt"
    )
    assert (
        area_of("GRIIS Checklist of Introduced and Invasive Species - Malawi")
        == "Malawi"
    )
    assert (
        area_of(
            "Global Register of Introduced and Invasive Species - Hawaii, United States (ver.2.0, 2022)"
        )
        == "Hawaii, United States"
    )
    assert (
        area_of(
            "Global Register of Introduced and Invasive Species - Eswatini (Swaziland)"
        )
        == "Eswatini (Swaziland)"
    )
    # 20 live titles use an en dash (2026-09-25: Reunion, Guadeloupe, Martinique, Azerbaijan, ...)
    assert area_of("Global Register of Introduced and Invasive Species – Reunion") == "Reunion"
    with pytest.raises(ValueError, match="not a GRIIS title"):
        area_of("Global Invasive Species Database")


def test_list_checklists_pages_through_the_publisher_keeps_griis_and_refuses_a_list_without_an_archive():
    pages = {
        0: {
            "count": 4,
            "endOfRecords": False,
            "results": [
                ds(
                    "nz",
                    "Global Register of Introduced and Invasive Species - New Zealand",
                ),
                ds("gisd", "Global Invasive Species Database"),
                ds("re", "Global Register of Introduced and Invasive Species – Reunion"),
                ds(
                    "pa",
                    "Protected Areas - Global Register of Introduced and Invasive Species - Lake Mburo, Uganda",
                ),
            ],
        },
        2: {
            "count": 4,
            "endOfRecords": True,
            "results": [
                ds(
                    "mw",
                    "GRIIS Checklist of Introduced and Invasive Species - Malawi",
                    modified="2020-10-05T00:00:00.000+00:00",
                ),
                ds(
                    "occ",
                    "Global Register of Introduced and Invasive Species - occurrences",
                    dtype="OCCURRENCE",
                ),
            ],
        },
    }
    seen = []

    def fetch_json(url):
        seen.append(url)
        off = int(url.split("offset=")[1])
        return pages[off]

    got, protected = list_checklists(fetch_json, limit=2)
    assert [c["key"] for c in got] == ["mw", "nz", "re"], (
        "GRIIS area checklists only, sorted by key"
    )
    assert protected == ["Lake Mburo, Uganda"], "protected-area checklists are set aside and named, not dropped"
    assert len(seen) == 2 and "limit=2" in seen[0]
    nz = got[1]
    assert nz == {
        "key": "nz",
        "title": "Global Register of Introduced and Invasive Species - New Zealand",
        "area": "New Zealand",
        "modified": "2026-03-28",
        "doi": "10.15468/nz",
        "licence": "CC BY 4.0",
        "citation": "Pagad S (2026). Global Register of Introduced and Invasive Species - New Zealand. ISSG.",
        "archive": "https://cloud.gbif.org/griis/archive.do?r=nz",
    }

    bad = {
        0: {
            "count": 1,
            "endOfRecords": True,
            "results": [
                ds(
                    "x",
                    "Global Register of Introduced and Invasive Species - Nowhere",
                    archive=False,
                )
            ],
        }
    }
    with pytest.raises(ValueError, match="Nowhere.*no DWC_ARCHIVE"):
        list_checklists(lambda url: bad[int(url.split("offset=")[1])], limit=2)

    odd = {
        0: {
            "count": 1,
            "endOfRecords": True,
            "results": [
                {
                    **ds(
                        "y",
                        "Global Register of Introduced and Invasive Species - Oddland",
                    ),
                    "license": "http://example.org/all-rights-reserved",
                }
            ],
        }
    }
    with pytest.raises(ValueError, match="Oddland.*licence"):
        list_checklists(lambda url: odd[int(url.split("offset=")[1])], limit=2)

    unknown = {0: {"count": 1, "endOfRecords": True, "results": [
        ds("z", "Introduced and Invasive Species of Zedland (draft)")]}}
    with pytest.raises(ValueError, match="Zedland.*title"):
        list_checklists(lambda url: unknown[int(url.split("offset=")[1])], limit=2)


def test_cached_archive_downloads_once_per_version_and_refetches_a_new_one(tmp_path):
    calls = []

    def fetch_bytes(url):
        calls.append(url)
        return b"PK-zip-" + url.encode()

    c = {
        "key": "nz",
        "modified": "2026-03-28",
        "archive": "https://cloud.gbif.org/griis/archive.do?r=nz",
    }
    p1 = cached_archive(c, tmp_path, fetch_bytes)
    p2 = cached_archive(c, tmp_path, fetch_bytes)
    assert p1 == p2 and p1.name == "nz_2026-03-28.zip" and len(calls) == 1, (
        "same version: one download"
    )
    p3 = cached_archive({**c, "modified": "2026-08-26"}, tmp_path, fetch_bytes)
    assert p3.name == "nz_2026-08-26.zip" and len(calls) == 2, (
        "a new version is fetched"
    )
    assert not p1.exists(), (
        "the superseded version is removed so the cache does not grow every month"
    )
    assert p3.read_bytes().startswith(b"PK-zip-")


def tables(dist, sp=None):
    """dist = [(id, status, means[, degree])]; sp = {id: isInvasive} or None (the US-RIIS layout has no isInvasive)."""
    t = {"Taxon": [{"id": r[0]} for r in dist], "Distribution": []}
    for r in dist:
        row = {
            "id": r[0],
            "countryCode": "XX",
            "occurrenceStatus": r[1],
            "establishmentMeans": r[2],
        }
        if len(r) > 3:
            row["degreeOfEstablishment"] = r[3]
        t["Distribution"].append(row)
    if sp is not None:
        t["SpeciesProfile"] = [{"id": k, "isInvasive": v} for k, v in sp.items()]
    return t


def test_count_list_griis_flag_counts_present_introduced_species_and_their_invasive_flag():
    t = tables(
        [
            ("1", "Present", "Alien"),
            ("2", "present", "introduced"),
            ("3", "present", "Native|Alien"),
            (
                "4",
                "present",
                "Cryptogenic|Uncerain",
            ),  # origin unknown: not introduced (sic, as published)
            ("5", "eradicated", "Alien"),  # no longer present
            ("6", "uncertain", "alien"),
            ("7", "present", "introduced (alien, exotic, non-native, nonindigenous)"),
            # spellings met in the live archives (2026-09-25): Malaysia, Niue, Republic of Korea
            ("8", "Reported", "Alien"),
            (
                "9",
                "Invasive",
                "Alien",
            ),  # a flag written in the status column: the species is there
            ("10", "Present", ""),  # origin not stated
            ("11", "Present", "Cryptogenic/Uncertain"),
        ],
        {
            "1": "Invasive",
            "2": "yes",
            "3": "Null",
            "4": "Invasive",
            "5": "Invasive",
            "6": "TRUE",
            "7": "Invasive?",
            "8": "",
            "9": "Invasive",
            "10": "Invasive",
            "11": "Null",
        },
    )
    got = count_list(t)
    assert got["basis"] == "impact"
    assert got["introduced"] == 6, "1, 2, 3, 7, 8, 9 are present and introduced"
    assert got["invasive"] == 3, (
        "1, 2, 9; 'Invasive?' is not a flag, 4/5/6/10 are not present introduced species"
    )
    assert got["excluded"] == {"not present": 2, "origin unknown": 3}


def test_count_list_us_riis_layout_reads_the_spread_category():
    t = tables(
        [
            (
                "1",
                "present",
                "introduced (alien, exotic, non-native, nonindigenous)",
                "invasive (category D2)",
            ),
            (
                "2",
                "present",
                "introduced: assisted colonization",
                "widespread invasive (category E)",
            ),
            (
                "3",
                "present",
                "introduced (alien, exotic, non-native, nonindigenous)",
                "established (category C3)",
            ),
        ]
    )
    t["SpeciesProfile"] = [
        {"id": "1", "isHybrid": "FALSE"}
    ]  # the US-RIIS profile carries no isInvasive column
    got = count_list(t)
    assert (got["basis"], got["introduced"], got["invasive"]) == ("spread", 3, 2)


def test_count_list_refuses_values_it_has_no_rule_for():
    with pytest.raises(ValueError, match="occurrenceStatus 'Transient'"):
        count_list(tables([("1", "Transient", "Alien")], {"1": "Null"}))
    with pytest.raises(ValueError, match="establishmentMeans 'Vagrant'"):
        count_list(tables([("1", "Present", "Vagrant")], {"1": "Null"}))
    with pytest.raises(ValueError, match="isInvasive 'Maybe'"):
        count_list(tables([("1", "Present", "Alien")], {"1": "Maybe"}))
    with pytest.raises(ValueError, match="degreeOfEstablishment 'casual'"):
        count_list(tables([("1", "present", "introduced", "casual")]))
    with pytest.raises(
        ValueError, match="neither an isInvasive column nor degreeOfEstablishment"
    ):
        count_list(tables([("1", "present", "introduced")]))
    assert (
        count_list(tables([("1", "Present", "Alien")], {"1": "Invasive"}))["invasive"]
        == 1
    ), "positive control"


def sq(x, y, d=1.0):
    return [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]]


def ne_feature(gu, adm, iso2, polys):
    return {
        "type": "Feature",
        "properties": {"GU_A3": gu, "ADM0_A3": adm, "ISO_A2": iso2, "NAME": gu},
        "geometry": {"type": "MultiPolygon", "coordinates": polys},
    }


def test_load_units_keys_map_units_by_gu_a3_and_splits_the_us_into_three_pieces(
    tmp_path,
):
    ne = {
        "type": "FeatureCollection",
        "features": [
            ne_feature("ENG", "GBR", "-99", [sq(-1, 51)]),
            ne_feature("SCT", "GBR", "-99", [sq(-4, 56)]),
            ne_feature(
                "USA",
                "USA",
                "US",
                [
                    sq(-105, 39),  # Colorado → lower 48
                    sq(-158.2, 21.2, 0.5),  # Oahu → Hawaii
                    sq(-150, 61),  # Anchorage → Alaska
                    sq(172.9, 52.8, 0.3),  # Attu, west of the antimeridian → Alaska
                    sq(-81.9, 24.5, 0.3),  # Key West → lower 48 (south, but east)
                ],
            ),
        ],
    }
    p = tmp_path / "mu.geojson"
    p.write_text(json.dumps(ne))
    u = load_units(p)
    assert set(u) == {"ENG", "SCT", "USA-CONT", "USA-AK", "USA-HI"}, (
        "USA replaced by its three pieces"
    )
    assert (
        len(u["USA-CONT"]["coordinates"]) == 2
        and len(u["USA-AK"]["coordinates"]) == 2
        and len(u["USA-HI"]["coordinates"]) == 1
    )
    assert u["ENG"]["coordinates"] == [sq(-1, 51)]


def lst(key, area, modified="2026-03-28"):
    return {
        "key": key,
        "title": f"GRIIS - {area}",
        "area": area,
        "modified": modified,
        "doi": f"10.15468/{key}",
        "licence": "CC BY 4.0",
        "citation": f"Pagad S. {area}.",
        "archive": f"https://x/{key}",
    }


def test_build_joins_lists_to_their_map_units_and_names_the_undrawn():
    units = {
        "ENG": {"type": "MultiPolygon", "coordinates": [sq(0, 0)]},
        "SCT": {"type": "MultiPolygon", "coordinates": [sq(0, 2)]},
        "NZL": {"type": "MultiPolygon", "coordinates": [sq(170, -40)]},
    }
    lists = [
        lst("uk", "United Kingdom"),
        lst("nz", "New Zealand"),
        lst("ch", "Chatham Islands, New Zealand", "2020-10-05"),
    ]
    counts = {
        "uk": {"basis": "impact", "introduced": 2000, "invasive": 300, "excluded": {}},
        "nz": {
            "basis": "impact",
            "introduced": 829,
            "invasive": 443,
            "excluded": {"origin unknown": 1},
        },
        "ch": {"basis": "impact", "introduced": 40, "invasive": 9, "excluded": {}},
    }
    table = {
        "uk": {"area": "United Kingdom", "units": ["ENG", "SCT"]},
        "nz": {"area": "New Zealand", "units": ["NZL"]},
        "ch": {"area": "Chatham Islands, New Zealand", "units": []},
    }
    feats, not_drawn = build(lists, counts, table, units)
    assert [f["properties"]["key"] for f in feats] == ["nz", "uk"]
    uk = feats[1]
    assert uk["geometry"] == {
        "type": "MultiPolygon",
        "coordinates": [sq(0, 0), sq(0, 2)],
    }, "one list, all its units"
    assert uk["properties"] == {
        "key": "uk",
        "area": "United Kingdom",
        "units": ["ENG", "SCT"],
        "introduced": 2000,
        "invasive": 300,
        "basis": "impact",
        "version": "2026-03-28",
        "doi": "10.15468/uk",
        "licence": "CC BY 4.0",
        "citation": "Pagad S. United Kingdom.",
    }
    assert not_drawn == [
        {
            "key": "ch",
            "area": "Chatham Islands, New Zealand",
            "introduced": 40,
            "invasive": 9,
            "basis": "impact",
            "version": "2020-10-05",
        }
    ]


def test_build_refuses_an_unmapped_list_an_unknown_unit_and_two_lists_on_one_unit():
    units = {"NZL": {"type": "MultiPolygon", "coordinates": [sq(170, -40)]}}
    c = {"basis": "impact", "introduced": 1, "invasive": 0, "excluded": {}}
    with pytest.raises(ValueError, match="Tokelau.*not in griis_areas.json"):
        build([lst("tk", "Tokelau")], {"tk": c}, {}, units)
    with pytest.raises(ValueError, match="New Zealand.*unit 'NZX'"):
        build(
            [lst("nz", "New Zealand")],
            {"nz": c},
            {"nz": {"area": "New Zealand", "units": ["NZX"]}},
            units,
        )
    with pytest.raises(
        ValueError, match="NZL is claimed by two lists: Aotearoa and New Zealand"
    ):
        build(
            [lst("nz", "New Zealand"), lst("ao", "Aotearoa")],
            {"nz": c, "ao": c},
            {
                "nz": {"area": "New Zealand", "units": ["NZL"]},
                "ao": {"area": "Aotearoa", "units": ["NZL"]},
            },
            units,
        )
    feats, _ = build(
        [lst("nz", "New Zealand")],
        {"nz": c},
        {
            "nz": {"area": "New Zealand", "units": ["NZL"]},
            "gone": {"area": "Withdrawn", "units": []},
        },
        units,
    )
    assert len(feats) == 1, (
        "positive control; a table row for a withdrawn list is only logged"
    )
