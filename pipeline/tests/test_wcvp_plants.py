"""WCVP native plants per TDWG Level-3 unit: the counting rules (native, endemic, introduced), columns by meta.xml,
the vocabulary and location checks, eml version and licence, the pinned fetch, the build, the budget, and the real
release against counts from an independent duckdb route (spec 2026-10-06-wcvp-plants-design.md)."""

import hashlib
import json
import os
import re
import zipfile
from pathlib import Path

import pytest
from shapely.geometry import Point, box, mapping, shape

from pipeline import wcvp_plants as wp

CACHE = Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))

# meta.xml as Kew writes it (fields by index; the header row is not trusted). {dist_cols} lets a test reorder the
# distribution columns.
META = """<?xml version='1.0' encoding='utf-8'?>
<archive xmlns="http://rs.tdwg.org/dwc/text/" metadata="eml.xml">
  <core encoding="UTF-8" fieldsTerminatedBy="|" linesTerminatedBy="\\n" fieldsEnclosedBy='' ignoreHeaderLines="1" rowType="http://rs.tdwg.org/dwc/terms/Taxon">
    <files><location>wcvp_taxon.csv</location></files>
    <id index="0" />
    <field index="0" term="http://rs.tdwg.org/dwc/terms/taxonID"/>
    <field index="1" term="http://rs.tdwg.org/dwc/terms/scientificName"/>
    <field index="2" term="http://rs.tdwg.org/dwc/terms/taxonRank"/>
    <field index="3" term="http://rs.tdwg.org/dwc/terms/taxonomicStatus"/>
  </core>
  <extension encoding="UTF-8" fieldsTerminatedBy="|" linesTerminatedBy="\\n" fieldsEnclosedBy='' ignoreHeaderLines="1" rowType="http://rs.gbif.org/terms/1.0/Distribution">
    <files><location>wcvp_distribution.csv</location></files>
    <coreid index="0" />
{dist_fields}
    <field index="6" default="http://creativecommons.org/licenses/by/3.0" term="http://purl.org/dc/terms/license"/>
  </extension>
</archive>"""
DIST_ORDER = (
    "locality",
    "establishmentMeans",
    "locationID",
    "occurrenceStatus",
    "threatStatus",
)
EML = """<eml><dataset><pubDate>2026-06-04</pubDate><intellectualRights><para>This work is licensed under a
<ulink url="{licence}"><citetitle>CC BY 3.0</citetitle></ulink>.</para></intellectualRights></dataset>
<additionalMetadata><metadata><col><version>{version}</version></col></metadata></additionalMetadata></eml>"""

# taxonID → (name, rank, status)
TAXA = {
    "1": ("Aa endemica", "Species", "Accepted"),
    "2": ("Aa wide", "Species", "Accepted"),
    "3": ("Aa weed", "Species", "Accepted"),
    "4": ("Aa coarse", "Species", "Accepted"),
    "5": ("Aa synonym", "Species", "Synonym"),
    "6": ("Aa endemica subsp. x", "Subspecies", "Accepted"),
    "7": ("Aa maybe", "Species", "Provisionally Accepted"),
    "8": ("Aa gone", "Species", "Accepted"),
    "9": ("Aa coarse weed", "Species", "Accepted"),
}
# (taxonID, location, establishmentMeans, occurrenceStatus, threatStatus)
DIST = [
    ("1", "AAA", "", "", ""),  # endemic to AAA
    (
        "1",
        "BBB",
        "",
        "",
        "Extinct",
    ),  # extinct in BBB: not native there, still endemic to AAA
    ("1", "CCC", "", "Doubtful", ""),  # doubtful in CCC: not native there
    ("2", "AAA", "", "", ""),
    ("2", "BBB", "", "", ""),  # native in two units: endemic to neither
    ("2", "CCC", "introduced", "", ""),
    ("3", "BBB", "", "", ""),
    ("3", "AAA", "introduced", "", ""),
    (
        "3",
        "CCC",
        "introduced",
        "",
        "Extinct",
    ),  # an introduction now extinct: not counted
    ("3", "CCC", "introduced", "Doubtful", ""),  # a doubtful introduction: not counted
    ("4", "CCC", "", "", ""),
    (
        "4",
        "84",
        "",
        "",
        "",
    ),  # also native in Level-2 region 84: not provably endemic to CCC
    ("5", "AAA", "", "", ""),  # synonym: never counted
    ("6", "AAA", "", "", ""),  # subspecies: never counted
    ("7", "AAA", "", "", ""),  # provisionally accepted: never counted
    ("8", "AAA", "", "", "Extinct"),  # extinct everywhere: in no count
    ("9", "CCC", "", "", ""),
    (
        "9",
        "8",
        "introduced",
        "",
        "",
    ),  # an introduced Level-1 row does not touch endemism
    ("2", "AAA", "", "", ""),  # a repeated row counts once
]
# Want, from the rules above, by hand: {code: (native, endemic, introduced)}. Endemic: Aa endemica in AAA, Aa weed in
# BBB (introduced elsewhere), Aa coarse weed in CCC; Aa coarse is not (its Level-2 row).
WANT = {"AAA": (2, 1, 1), "BBB": (2, 1, 0), "CCC": (2, 1, 1)}
UNITS = {"AAA": ("Alpha", 1), "BBB": ("Beta", 2), "CCC": ("Gamma", 3)}


def write_zip(
    path: Path,
    taxa=TAXA,
    dist=DIST,
    order=DIST_ORDER,
    version="16.0",
    licence=wp.LICENCE_URL,
) -> Path:
    """A synthetic WCVP archive: Kew's file names, `|` separated, unquoted, header misspelled as in 16.0."""
    ns = {"threatStatus": "http://iucn.org/terms/"}  # as Kew's meta.xml; the rest are Darwin Core terms
    fields = "\n".join(
        f'    <field index="{i + 1}" term="{ns.get(t, "http://rs.tdwg.org/dwc/terms/")}{t}"/>'
        for i, t in enumerate(order)
    )
    taxon = ["taxonid|scientfiicname|taxonrank|taxonomicstatus"] + [
        f"{k}|{n}|{r}|{s}" for k, (n, r, s) in taxa.items()
    ]
    head = [
        "coreid",
        *[t.lower() for t in DIST_ORDER],
    ]  # the header keeps Kew's order whatever meta.xml says
    rows = ["|".join(head)]
    for sid, loc, est, occ, thr in dist:
        v = {
            "locality": f"place {loc}",
            "establishmentMeans": est,
            "locationID": f"TDWG:{loc}",
            "occurrenceStatus": occ,
            "threatStatus": thr,
        }
        rows.append("|".join([sid, *[v[t] for t in order]]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("meta.xml", META.format(dist_fields=fields))
        z.writestr("eml.xml", EML.format(version=version, licence=licence))
        z.writestr("wcvp_taxon.csv", "\n".join(taxon) + "\n")
        z.writestr("wcvp_distribution.csv", "\n".join(rows) + "\n")
    return path


def write_units(path: Path, units=UNITS, shapes=None) -> Path:
    feats = [
        {
            "type": "Feature",
            "properties": {
                "LEVEL3_NAM": name,
                "LEVEL3_COD": code,
                "LEVEL2_COD": l2,
                "LEVEL1_COD": 9,
            },
            "geometry": mapping((shapes or {}).get(code, box(i * 2, 0, i * 2 + 1, 1))),
        }
        for i, (code, (name, l2)) in enumerate(units.items())
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    return path


def counts_of(zpath: Path, codes=set(UNITS)):
    counts, stats, _ = wp.count_archive(zpath, codes)
    return {
        c: (v["native"], v["endemic"], v["introduced"]) for c, v in counts.items()
    }, stats


def test_bins_are_half_decades_coloured_dark_to_light_and_zero_has_none():
    assert [wp.bin_of(n) for n in (1, 9, 10, 29, 30, 99, 100, 299, 300, 999, 1000, 2999, 3000, 9999, 10000, 25490)] == [
        0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7,
    ]  # fmt: skip
    assert wp.bin_of(0) is None, "Bouvet Island: no native species recorded"
    with pytest.raises(ValueError, match="-1 species"):
        wp.bin_of(-1)
    cols = wp.BIN_COLOURS
    assert (
        len(cols) == len(wp.BIN_EDGES) == 8
        and len(set(cols)) == 8
        and wp.NONE_COLOUR not in cols
    )
    assert all(re.fullmatch(r"#[0-9a-f]{6}", c) for c in (*cols, wp.NONE_COLOUR))

    def luminance(c):
        v = [int(c[k : k + 2], 16) / 255 for k in (1, 3, 5)]
        lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in v]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

    light = [luminance(c) for c in cols]
    assert light == sorted(light), "more species reads lighter on the dark globe"
    assert (
        wp.bin_label(0) == "1–9"
        and wp.bin_label(3) == "100–299"
        and wp.bin_label(7) == "10,000+"
    )


def test_native_endemic_and_introduced_follow_the_rules(tmp_path):
    got, stats = counts_of(write_zip(tmp_path / "a.zip"))
    assert got == WANT
    assert stats["species"] == 6, "accepted species: 1, 2, 3, 4, 8, 9"
    assert stats["endemic_lost_to_coarse_rows"] == 1, "species 4"


@pytest.mark.parametrize(
    "row, effect",
    [
        (
            ("2", "CCC", "", "", ""),
            {"CCC": (3, 1, 0)},
        ),  # a third native: Aa wide is native, no longer introduced, in CCC
        (
            ("1", "BBB", "", "", ""),
            {"AAA": (2, 0, 1), "BBB": (3, 1, 0)},
        ),  # endemic no more
        (
            ("1", "85", "", "", ""),
            {"AAA": (2, 0, 1)},
        ),  # a native Level-2 row ends endemism
        (("1", "85", "introduced", "", ""), {}),  # an introduced one does not
        (
            ("8", "BBB", "introduced", "", ""),
            {"BBB": (2, 1, 1)},
        ),  # introduced and extant counts
    ],
)
def test_one_more_row_moves_exactly_the_counts_it_should(tmp_path, row, effect):
    base = (
        DIST
        if row[0] != "2"
        else [r for r in DIST if r[:3] != ("2", "CCC", "introduced")]
    )
    got, _ = counts_of(write_zip(tmp_path / "a.zip", dist=[*base, row]))
    assert got == {**WANT, **effect}


def test_columns_come_from_meta_xml_not_the_header(tmp_path):
    swapped = (
        "locality",
        "occurrenceStatus",
        "locationID",
        "establishmentMeans",
        "threatStatus",
    )
    got, _ = counts_of(write_zip(tmp_path / "a.zip", order=swapped))
    assert got == WANT, "meta.xml swaps two columns; the header still names Kew's order"
    assert (
        counts_of(write_zip(tmp_path / "b.zip"))[0] == WANT
    )  # positive control: Kew's own order
    with zipfile.ZipFile(write_zip(tmp_path / "c.zip")) as z:
        spec = wp.read_meta(z)["Distribution"]
        assert (spec["sep"], spec["quote"], spec["skip"]) == ("|", "", 1)
        with pytest.raises(ValueError, match=r"declares no \['nosuchTerm'\]"):
            list(wp.iter_rows(z, spec, ("coreid", "nosuchTerm")))


def test_a_short_row_stops_the_run(tmp_path):
    p = write_zip(tmp_path / "a.zip")
    assert counts_of(p)[0] == WANT  # positive control
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(p) as src, zipfile.ZipFile(bad, "w") as z:
        for n in src.namelist():
            data = src.read(n)
            if n == "wcvp_distribution.csv":
                data += b"1|place|\n"
            z.writestr(n, data)
    with pytest.raises(
        ValueError, match="wcvp_distribution.csv line 21: 3 columns, meta.xml needs 6"
    ):
        counts_of(bad)


@pytest.mark.parametrize(
    "row, why",
    [
        (("1", "AAA", "Introduced", "", ""), "establishmentMeans 'Introduced'"),
        (("1", "AAA", "", "doubtful", ""), "occurrenceStatus 'doubtful'"),
        (("1", "AAA", "", "", "Endangered"), "threatStatus 'Endangered'"),
        (("1", "ZZZ", "", "", ""), "Level-3 code ZZZ has no boundary"),
        (("1", "ABC1", "", "", ""), "location 'TDWG:ABC1' is not a WGSRPD code"),
        (("1", "123", "", "", ""), "location 'TDWG:123' is not a WGSRPD code"),
        # an unknown value is refused even on a row no count uses (a synonym)
        (("5", "AAA", "", "", "Endangered"), "taxon 5 at TDWG:AAA"),
    ],
)
def test_a_value_outside_the_published_vocabulary_stops_the_run(tmp_path, row, why):
    assert counts_of(write_zip(tmp_path / "ok.zip"))[0] == WANT  # positive control
    with pytest.raises(ValueError, match=re.escape(why)):
        counts_of(write_zip(tmp_path / "bad.zip", dist=[*DIST, row]))


def test_the_archive_must_still_say_version_16_under_cc_by_3(tmp_path):
    with zipfile.ZipFile(write_zip(tmp_path / "ok.zip")) as z:
        assert wp.check_eml(z) == {
            "version": "16.0",
            "licence": "CC BY 3.0",
            "published": "2026-06-04",
        }
    with zipfile.ZipFile(write_zip(tmp_path / "v.zip", version="17.0")) as z:
        with pytest.raises(ValueError, match="version '17.0', not 16.0"):
            wp.check_eml(z)
    with zipfile.ZipFile(
        write_zip(
            tmp_path / "l.zip",
            licence="https://creativecommons.org/licenses/by-nc/3.0/",
        )
    ) as z:
        with pytest.raises(
            ValueError,
            match="does not name https://creativecommons.org/licenses/by/3.0/",
        ):
            wp.check_eml(z)


def test_build_carries_counts_names_colours_and_areas(tmp_path):
    units = wp.read_units(write_units(tmp_path / "l3.geojson"))
    counts = {
        c: dict(zip(("native", "endemic", "introduced"), v)) for c, v in WANT.items()
    }
    counts["CCC"] = {"native": 0, "endemic": 0, "introduced": 4}
    feats, stats = wp.build(units, counts, expect=3)
    assert [f["properties"]["id"] for f in feats] == ["AAA", "BBB", "CCC"] and stats[
        "units"
    ] == 3
    a = feats[0]["properties"]
    assert (
        a["name"],
        a["level2"],
        a["level1"],
        a["native"],
        a["endemic"],
        a["introduced"],
    ) == ("Alpha", 1, 9, 2, 1, 1)
    assert a["bin"] == 0 and a["color"] == wp.BIN_COLOURS[0]
    assert a["area_km2"] == pytest.approx(12_300, rel=0.01), "1° square on the equator"
    c = feats[2]["properties"]
    assert c["bin"] is None and c["color"] == wp.NONE_COLOUR, (
        "no native species: the grey, not the first bin"
    )
    with pytest.raises(ValueError, match="3 Level-3 units, not 369"):
        wp.build(units, counts)


def test_every_island_is_kept_and_a_unit_across_the_globe_is_cut(tmp_path):
    from shapely.geometry import MultiPolygon

    atoll = MultiPolygon(
        [box(10, 0, 10.05, 0.05), box(11, 0, 11.004, 0.004)]
    )  # 0.0025 and 0.000016 deg²
    wide = box(-180, -80, 180, -70)
    units = wp.read_units(
        write_units(tmp_path / "l3.geojson", shapes={"BBB": atoll, "CCC": wide})
    )
    counts = {c: {"native": 1, "endemic": 0, "introduced": 0} for c in UNITS}
    feats, _ = wp.build(units, counts, expect=3)
    def parts_of(f):
        g = shape(f["geometry"])
        return list(getattr(g, "geoms", [g]))

    assert len(parts_of(feats[1])) == 2, "both islets drawn"
    parts = parts_of(feats[2])
    assert len(parts) == 4 and all(p.bounds[2] - p.bounds[0] <= 90 for p in parts)
    assert shape(feats[0]["geometry"]).geom_type == "Polygon", (
        "positive control: a narrow unit is kept whole"
    )


def test_a_repeated_code_stops_the_run(tmp_path):
    assert (
        len(wp.read_units(write_units(tmp_path / "ok.geojson"))) == 3
    )  # positive control
    p = write_units(
        tmp_path / "bad.geojson", units={"AAA": ("Alpha", 1), "BBB": ("Beta", 2)}
    )
    doc = json.loads(p.read_text())
    doc["features"].append(doc["features"][0])
    p.write_text(json.dumps(doc))
    with pytest.raises(ValueError, match="Level-3 code AAA appears twice"):
        wp.read_units(p)


def _sources(tmp_path):
    src = {
        wp.ZIP: write_zip(tmp_path / "src" / wp.ZIP),
        wp.L3: write_units(tmp_path / "src" / wp.L3),
    }
    want = {
        n: (url, hashlib.md5(src[n].read_bytes(), usedforsecurity=False).hexdigest())
        for n, (url, _) in wp.FILES.items()
    }
    by_url = {url: src[n] for n, (url, _) in wp.FILES.items()}
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(by_url[url].read_bytes())

    return want, fetch_to, calls


def test_each_file_is_used_only_when_its_md5_is_the_pinned_one(tmp_path):
    want, fetch_to, calls = _sources(tmp_path)
    cache = tmp_path / "cache"
    d = wp.fetch(cache, fetch_to=fetch_to, want=want)
    assert sorted(p.name for p in d.iterdir()) == sorted(wp.FILES)
    assert calls == [wp.ZIP_URL, wp.L3_URL]
    assert wp.fetch(cache, fetch_to=fetch_to, want=want) == d and len(calls) == 2, (
        "cached"
    )
    bad = {**want, wp.L3: (wp.L3_URL, "0" * 32)}
    with pytest.raises(
        ValueError, match="level3.geojson: md5 .* is not the pinned 0{32}; delete it"
    ):
        wp.fetch(cache, fetch_to=fetch_to, want=bad)
    (d / wp.L3).unlink()
    with pytest.raises(ValueError, match="level3.geojson: md5 .* is not the pinned"):
        wp.fetch(cache, fetch_to=fetch_to, want=bad)
    assert not (d / wp.L3).exists() and not list(d.glob("*.part")), (
        "a refused download leaves nothing"
    )


def test_main_writes_the_collection_and_nothing_over_budget(tmp_path):
    want, fetch_to, _ = _sources(tmp_path)
    out = tmp_path / "out" / "plants_wcvp.geojson"
    args = ["--cache", str(tmp_path / "cache"), "--out", str(out)]
    assert wp.main(args, fetch_to=fetch_to, want=want, expect=3) == 0
    d = json.loads(out.read_text())
    assert {
        f["properties"]["id"]: (
            f["properties"]["native"],
            f["properties"]["endemic"],
            f["properties"]["introduced"],
        )
        for f in d["features"]
    } == WANT
    assert (
        d["source"]["licence"].startswith("CC BY 3.0")
        and d["source"]["version"] == "16.0"
    )
    assert "CC BY 4.0" in d["source"]["boundaries"]
    assert d["bins"] == [
        {"min": e, "label": wp.bin_label(i), "color": wp.BIN_COLOURS[i]}
        for i, e in enumerate(wp.BIN_EDGES)
    ]
    assert d["none_color"] == wp.NONE_COLOUR and d["counts"]["species"] == 6
    before = out.read_bytes()
    with pytest.raises(SystemExit, match="over the 1,000 B budget: nothing written"):
        wp.main([*args, "--budget", "1000"], fetch_to=fetch_to, want=want, expect=3)
    assert out.read_bytes() == before


# Known answers from the independent route (duckdb SQL over the CSVs extracted from the zip, not this module's code;
# the query is in the PR), 2026-10-06: code → (name, native, endemic, introduced, a point inside the unit).
KNOWN = {
    "CLM": ("Colombia", 25490, 7935, 701, (4.6, -74.1)),
    "BZE": ("Brazil Northeast", 11692, 3153, 289, (-8.0, -40.0)),
    "MDG": ("Madagascar", 11929, 9907, 373, (-19.0, 46.7)),
    "HAW": ("Hawaii", 1238, 1063, 1404, (19.6, -155.5)),
    "GRB": ("Great Britain", 2948, 643, 2356, (52.5, -1.5)),
    "GER": ("Germany", 4469, 393, 2846, (51.0, 10.0)),
    "BOU": ("Bouvet I.", 0, 0, 0, None),
}


# Not skipped when the cache is empty: main downloads both files through the pinned fetcher, so a fresh CI runner
# checks the release too.
def test_real_release_matches_the_independent_counts(tmp_path):
    out = tmp_path / "plants_wcvp.geojson"
    assert wp.main(["--cache", str(CACHE), "--out", str(out)]) == 0
    d = json.loads(out.read_text())
    assert out.stat().st_size <= wp.BUDGET_BYTES and d["counts"]["units"] == 369
    assert (
        d["counts"]["species"] == 365_813
        and d["counts"]["species_native_somewhere"] == 364_706
    )
    by = {f["properties"]["id"]: f for f in d["features"]}
    for code, (name, native, endemic, introduced, at) in KNOWN.items():
        p = by[code]["properties"]
        assert (p["name"], p["native"], p["endemic"], p["introduced"]) == (
            name,
            native,
            endemic,
            introduced,
        ), code
        if at:
            hit = [
                c
                for c, f in by.items()
                if shape(f["geometry"]).covers(Point(at[1], at[0]))
            ]
            assert hit == [code], f"{name}: the point lies in {hit}"
    parts = [
        q
        for f in d["features"]
        for q in getattr(shape(f["geometry"]), "geoms", [shape(f["geometry"])])
    ]
    assert (
        all(q.is_valid for q in parts)
        and max(q.bounds[2] - q.bounds[0] for q in parts) <= wp.MAX_PART_WIDTH
    )
    assert sum(f["properties"]["endemic"] for f in d["features"]) == 206_723


def test_area_is_the_unsimplified_units(tmp_path):
    from shapely.geometry import Polygon

    from pipeline.gfw import geometry_area_km2

    # a 1° square whose top edge has 0.008° teeth: under the 0.01° tolerance, so the drawn edge loses them
    top = [(x / 100, 1 + (0.008 if k % 2 else 0)) for k, x in enumerate(range(100, -1, -1))]
    saw = Polygon([(0, 0), (1, 0), *top])
    units = wp.read_units(write_units(tmp_path / "l3.geojson", shapes={"AAA": saw}))
    counts = {c: {"native": 1, "endemic": 0, "introduced": 0} for c in UNITS}
    feats, _ = wp.build(units, counts, expect=3)
    drawn = feats[0]["geometry"]
    want = round(geometry_area_km2(mapping(saw)))
    assert feats[0]["properties"]["area_km2"] == want
    assert abs(want - round(geometry_area_km2(drawn))) > 20, "the drawn shape's area differs, so the test can tell"
