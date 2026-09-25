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
    main,
    seed_collection,
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
                ds("lu", "Global Register of Introduced and Invasive Species GRIIS - Luxembourg"),
                ds("no", "Global Register of Invasive and Introduced Species - Norway"),
            ],
        },
    }
    seen = []

    def fetch_json(url):
        seen.append(url)
        off = int(url.split("offset=")[1])
        return pages[off]

    got, protected = list_checklists(fetch_json, limit=2)
    assert [c["key"] for c in got] == ["lu", "mw", "no", "nz", "re"], (
        "GRIIS area checklists only, sorted by key"
    )
    assert protected == ["Lake Mburo, Uganda"], "protected-area checklists are set aside and named, not dropped"
    assert len(seen) == 2 and "limit=2" in seen[0]
    assert [c["area"] for c in got] == ["Luxembourg", "Malawi", "Norway", "New Zealand", "Reunion"]
    nz = got[3]
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
        ds("z", "Alien plants of Zedland (draft)")]}}
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
            # Bulgaria, Montserrat, TAAF (2026-09-25)
            ("12", "present", "Native|Invasive"),  # native in part, invasive elsewhere: alien there
            ("13", "present", "Cryptogenic|Unknown"),
            ("14", "cryptogenic|uncertain", "introduced"),  # an origin value in the status column
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
            "12": "Invasive in the north of the island (122).",
            "13": "Null",
            "14": "Invasive",
        },
    )
    got = count_list(t)
    assert got["basis"] == "impact"
    assert got["introduced"] == 7, "1, 2, 3, 7, 8, 9, 12 are present and introduced"
    assert got["invasive"] == 4, (
        "1, 2, 9, 12; 'Invasive?' is not a flag, 4/5/6/10/14 are not present introduced species"
    )
    assert got["excluded"] == {"not present": 3, "origin unknown": 4}
    assert got["presence"] == "stated"


def test_count_list_a_list_without_an_occurrence_status_column_counts_its_rows_and_says_presence_is_not_stated():
    """Turkey (2026-09-25): 968 rows, no occurrenceStatus term in meta.xml. Folding a missing column into
    'not present' drew Turkey as 0 introduced species."""
    t = tables([("1", "x", "Alien"), ("2", "x", "Alien"), ("3", "x", "Cryptogenic|Uncertain")],
               {"1": "Invasive", "2": "Null", "3": "Invasive"})
    for r in t["Distribution"]:
        del r["occurrenceStatus"]
    got = count_list(t)
    assert (got["introduced"], got["invasive"], got["presence"]) == (2, 1, "not stated")
    assert got["excluded"] == {"origin unknown": 1}


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


def test_count_list_reads_the_invasive_basis_the_list_states():
    """Belgium (2026-09-25): isInvasive present but blank on all 3,320 rows, invasiveness in Darwin Core
    degreeOfEstablishment words, pipe-joined, one row per region; read as the flag it drew 0 invasive.
    Afghanistan: blank flags and no degree column states nothing, which is not 0."""
    be = tables(
        [
            ("1", "present", "introduced", "invasive"),
            ("1", "present", "introduced", "NA"),  # the same taxon in another region
            ("2", "present", "introduced", "casual|invasive"),
            ("3", "present", "introduced", "widespreadInvasive"),
            ("4", "present", "introduced", "NA|established"),
            ("5", "present", "introduced", "invasive (category D2)"),
            ("6", "present", "introduced", "colonising"),
        ],
        {k: "" for k in "123456"},
    )
    be["Taxon"] = [r for r in be["Taxon"] if r["id"] != "6"]  # a distribution row with no taxon row
    got = count_list(be)
    assert (got["basis"], got["introduced"], got["invasive"]) == ("spread", 5, 4)
    assert got["excluded"] == {"no taxon row": 1}

    af = count_list(tables([("1", "present", "alien"), ("2", "present", "alien")], {"1": "", "2": ""}))
    assert (af["basis"], af["introduced"], af["invasive"]) == ("not stated", 2, None)

    chad = count_list(tables([("1", "present", "alien")], {"1": "Null"}))
    assert (chad["basis"], chad["invasive"]) == ("impact", 0), "a stated Null flag is a statement"


def test_count_list_refuses_values_it_has_no_rule_for():
    with pytest.raises(ValueError, match="occurrenceStatus 'Transient'"):
        count_list(tables([("1", "Transient", "Alien")], {"1": "Null"}))
    with pytest.raises(ValueError, match="establishmentMeans 'Vagrant'"):
        count_list(tables([("1", "Present", "Vagrant")], {"1": "Null"}))
    with pytest.raises(ValueError, match="isInvasive 'Maybe'"):
        count_list(tables([("1", "Present", "Alien")], {"1": "Maybe"}))
    with pytest.raises(ValueError, match=r"degreeOfEstablishment 'casual\|weird' has no rule"):
        count_list(tables([("1", "present", "introduced", "casual|weird")]))
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
        "uk": {"basis": "impact", "presence": "not stated", "introduced": 2000, "invasive": 300, "excluded": {}},
        "nz": {
            "basis": "impact",
            "presence": "stated",
            "introduced": 829,
            "invasive": 443,
            "excluded": {"origin unknown": 1},
        },
        "ch": {"basis": "impact", "presence": "stated", "introduced": 40, "invasive": 9, "excluded": {}},
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
        "presence": "not stated",
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
            "presence": "stated",
            "version": "2020-10-05",
        }
    ]


def test_build_refuses_an_unmapped_list_an_unknown_unit_and_two_lists_on_one_unit():
    units = {"NZL": {"type": "MultiPolygon", "coordinates": [sq(170, -40)]}}
    c = {"basis": "impact", "presence": "stated", "introduced": 1, "invasive": 0, "excluded": {}}
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


def griis_zip(rows):
    """rows = [(id, status, means, isInvasive)] → a GRIIS-layout DwC-A."""
    files = [
        ("core", DWC + "Taxon", "taxon.txt", [(1, DWC + "scientificName", None)], "\\t", 1),
        ("ext", GBIF + "Distribution", "distribution.txt",
         [(1, DWC + "occurrenceStatus", None), (2, DWC + "establishmentMeans", None)], "\\t", 1),
        ("ext", GBIF + "SpeciesProfile", "speciesprofile.txt", [(1, GBIF + "isInvasive", None)], "\\t", 1),
    ]
    texts = {
        "taxon.txt": "id\tname\n" + "".join(f"{r[0]}\tsp{r[0]}\n" for r in rows),
        "distribution.txt": "id\ts\tm\n" + "".join(f"{r[0]}\t{r[1]}\t{r[2]}\n" for r in rows),
        "speciesprofile.txt": "id\tf\n" + "".join(f"{r[0]}\t{r[3]}\n" for r in rows),
    }
    return dwca(files, texts)


def main_world(tmp_path, *, nz_rows=None, listed=("nz", "ch")):
    """A fake GBIF + Natural Earth for main(): New Zealand drawn on NZL, Chatham Islands not drawn, one
    protected-area list."""
    titles = {"nz": "Global Register of Introduced and Invasive Species - New Zealand",
              "ch": "Global Register of Introduced and Invasive Species - Chatham Islands, New Zealand"}
    page = {"count": 3, "endOfRecords": True, "results": [ds(k, titles[k]) for k in listed] + [
        ds("pa", "Protected Areas - Global Register of Introduced and Invasive Species - Lake Mburo, Uganda")]}
    zips = {
        "nz": griis_zip(nz_rows or [("1", "Present", "Alien", "Invasive"), ("2", "Present", "Alien", "Null"),
                                    ("3", "Absent", "Alien", "Invasive")]),
        "ch": griis_zip([("1", "Present", "Alien", "Null")]),
    }
    ne = {"type": "FeatureCollection", "features": [ne_feature("NZL", "NZL", "NZ", [sq(170, -45)])]}

    def fetch_bytes(url):
        if "archive.do?r=" in url:
            return zips[url.rsplit("=", 1)[1]]
        if url.endswith("ne_50m_admin_0_map_units.geojson"):
            return json.dumps(ne).encode()
        raise AssertionError(f"unexpected fetch {url}")

    areas = tmp_path / "areas.json"
    areas.write_text(json.dumps({"nz": {"area": "New Zealand", "units": ["NZL"]},
                                 "ch": {"area": "Chatham Islands, New Zealand", "units": []}}))
    return (lambda url: page), fetch_bytes, areas


def test_main_writes_the_layer_file_and_refuses_a_list_it_cannot_count(tmp_path):
    fetch_json, fetch_bytes, areas = main_world(tmp_path)
    out = tmp_path / "griis.geojson"
    main(["--out", str(out), "--cache", str(tmp_path / "c")], fetch_json=fetch_json, fetch_bytes=fetch_bytes,
         areas=areas)
    gj = json.loads(out.read_text())
    assert gj["type"] == "FeatureCollection" and gj["source"]["id"] == "griis"
    assert "CC BY 4.0" in gj["source"]["licence"] and "ISSG" in gj["source"]["name"] + gj["source"]["citation"]
    [f] = gj["features"]
    assert (f["properties"]["area"], f["properties"]["introduced"], f["properties"]["invasive"]) == ("New Zealand", 2, 1)
    assert [n["area"] for n in gj["not_drawn"]] == ["Chatham Islands, New Zealand"]
    assert gj["protected_areas"] == ["Lake Mburo, Uganda"]

    fetch_json, fetch_bytes, areas = main_world(tmp_path, nz_rows=[("1", "Present", "Weird", "Null")])
    bad = tmp_path / "bad.geojson"
    with pytest.raises(ValueError, match="New Zealand.*establishmentMeans 'Weird' has no rule"):
        main(["--out", str(bad), "--cache", str(tmp_path / "c2")], fetch_json=fetch_json, fetch_bytes=fetch_bytes,
             areas=areas)
    assert not bad.exists()


def test_main_refuses_a_listing_missing_more_than_a_tenth_of_the_reviewed_table(tmp_path):
    fetch_json, fetch_bytes, areas = main_world(tmp_path, listed=("nz",))
    out = tmp_path / "griis.geojson"
    with pytest.raises(SystemExit, match="1 of 2 lists in griis_areas.json are not in GBIF's listing"):
        main(["--out", str(out), "--cache", str(tmp_path / "c")], fetch_json=fetch_json, fetch_bytes=fetch_bytes,
             areas=areas)
    assert not out.exists()


def test_seed_collection_keeps_the_lists_with_the_most_introduced_species_simplified_and_says_so():
    def feat(key, n, x):
        ring = [[x, 0], [x + 0.5, 0.001], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]
        speck = [[x + 3, 3], [x + 3.01, 3], [x + 3.01, 3.01], [x + 3, 3]]
        return {"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[ring], [speck]]},
                "properties": {"key": key, "area": key, "introduced": n}}

    gj = {"type": "FeatureCollection", "source": {"name": "GRIIS"}, "not_drawn": [{"area": "x"}],
          "protected_areas": ["y"], "features": [feat("SML", 10, 0), feat("BIG", 3000, 10), feat("MID", 900, 20)]}
    s = seed_collection(gj, n=2, tol=0.1, min_area=0.05)
    assert [f["properties"]["key"] for f in s["features"]] == ["BIG", "MID"]
    g = s["features"][0]["geometry"]
    assert g["type"] == "Polygon" and len(g["coordinates"][0]) == 5, "speck dropped, near-collinear vertex simplified"
    assert s["features"][0]["properties"] == gj["features"][1]["properties"], "values are never subsampled"
    assert "seed: 2 of 3 lists" in s["source"]["subsample"] and "run pipeline/run_griis.sh" in s["source"]["subsample"]
    assert s["not_drawn"] == [{"area": "x"}] and s["protected_areas"] == ["y"]
    assert gj["features"][1]["geometry"]["type"] == "MultiPolygon", "input left untouched"
