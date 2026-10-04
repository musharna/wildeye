"""HAEDAT harmful algal events: the pinned archive, dates, the licence check, counts per position.

The fixture is a subset of the real 3.35 archive (2025-05-23) with its own eml.xml and meta.xml and rows copied
verbatim: every event at the Gulf of Maine point (44.14, -67.53; 47 events) and the Bungo Channel point (33.61,
131.89; 107 events, one dated 0000-00-00), the 9 Yucatán events at longitude -808.8684, and the 1770 and 1860
records. Expected numbers below were counted from the raw rows with awk, not with this module.
"""

import hashlib
import json
import zipfile
from pathlib import Path

import pytest
from pipeline import haedat

FIX = Path(__file__).parent / "fixtures" / "haedat_dwca_subset.zip"
FIX_SHA = hashlib.sha256(FIX.read_bytes()).hexdigest()


def test_year_is_the_leading_four_digit_year_from_1700_and_anything_else_is_undated():
    assert haedat.year_of("2014-05-01/2014-07-31", 2026) == 2014
    assert haedat.year_of("1992/05/01/1992/06/01", 2026) == 1992
    assert haedat.year_of("2025", 2026) == 2025
    assert haedat.year_of("1770-03-01", 2026) == 1770  # a real historical record, kept
    for undated in (
        "0000-00-00/0000-00-00",
        "88-8-15",
        "21-07-08/28-07-08",
        "28/05/2002",
        "004-02-18/004-03-02",
        "2031-01-01",
        "",
        "19920",
    ):
        assert haedat.year_of(undated, 2026) is None, undated


def test_the_archive_is_fetched_once_and_refused_unless_it_is_the_pinned_file(tmp_path):
    calls = []

    def fetch_to(url, path):
        calls.append(url)
        path.write_bytes(FIX.read_bytes())

    with pytest.raises(ValueError, match="is not the pinned"):
        haedat.fetch(tmp_path, sha256="0" * 64, fetch_to=fetch_to)
    assert not list(tmp_path.iterdir())  # the refused download is not kept
    got = haedat.fetch(tmp_path, sha256=FIX_SHA, fetch_to=fetch_to)  # positive control
    assert got.read_bytes() == FIX.read_bytes()
    assert haedat.fetch(tmp_path, sha256=FIX_SHA, fetch_to=fetch_to) == got
    assert len(calls) == 2  # the cached copy is reused
    got.write_bytes(b"changed")
    with pytest.raises(ValueError, match="delete it to fetch again"):
        haedat.fetch(tmp_path, sha256=FIX_SHA, fetch_to=fetch_to)


def rewrite(tmp_path, name, change):
    out = tmp_path / "changed.zip"
    with zipfile.ZipFile(FIX) as src, zipfile.ZipFile(out, "w") as dst:
        for item in src.namelist():
            data = src.read(item).decode("utf-8")
            dst.writestr(item, change(data) if item == name else data)
    return out


def test_an_archive_that_drops_cc_by_or_adds_an_illness_is_refused(tmp_path):
    events, rights = haedat.read_archive(
        FIX, 2026
    )  # positive control: the real metadata reads
    assert len(events) == 165
    assert "Creative Commons Attribution (CC-BY) 4.0 License" in rights["text"]
    nc = rewrite(
        tmp_path,
        "eml.xml",
        lambda s: s.replace("licenses/by/4.0", "licenses/by-nc/4.0"),
    )
    with pytest.raises(ValueError, match="no longer states CC BY 4.0"):
        haedat.read_archive(nc, 2026)
    new = rewrite(
        tmp_path,
        "extendedmeasurementorfact.txt",
        lambda s: s.replace("\tASP\t", "\tBMAA\t", 1),
    )
    with pytest.raises(ValueError, match="unknown HAB associated illness 'BMAA'"):
        haedat.read_archive(new, 2026)


def test_counts_per_position_by_year_and_illness():
    events, _ = haedat.read_archive(FIX, 2026)
    positions = {
        (p["lat"], p["lon"]): p
        for p in haedat.by_position([e for e in events if haedat.on_globe(e)])
    }
    assert len(positions) == 4  # the Yucatán point is off the globe
    maine = positions[(44.14, -67.53)]
    assert sum(v["n"] for v in maine["years"].values()) == 47
    assert maine["years"]["1988"]["n"] == 10 and maine["years"]["2019"]["n"] == 3
    # US-14-001 is linked to ASP and PSP: one event, counted under both
    assert maine["years"]["2014"] == {"n": 1, "ill": {"ASP": 1, "PSP": 1}}
    assert maine["uncertaintyKm"] == 100.0
    assert maine["countries"] == ["UNITED STATES"]
    # the whole top five and top three, ties broken by name (counted from the rows with awk)
    assert maine["species"] == [
        ["Alexandrium tamarense", 8],
        ["Alexandrium spp.", 6],
        ["Pseudo-nitzschia spp.", 6],
        ["Alexandrium fundyense", 5],
        ["Alexandrium sp.", 5],
    ]
    assert maine["places"] == ["Maine Coastline", "Gulf of Maine", "Eastern Maine."]
    assert maine["undated"] == {"n": 0, "ill": {}}
    bungo = positions[(33.61, 131.89)]
    # JP-01-008 is dated 0000-00-00 and has no illness: undated, under None
    assert bungo["undated"] == {"n": 1, "ill": {"None": 1}}
    assert sum(v["n"] for v in bungo["years"].values()) == 106
    # causative taxa only, the whole top five pinned (review of PR #52: an either-or assertion passed on both outcomes).
    # Karenia mikimotoi is causative in 19 events and merely present in 1 more; Chattonella antiqua is causative in 3
    # and present in 2, so it ties Alexandrium tamarense at 3 and falls sixth by name, where counting the present rows
    # would give it 5 and list it fourth
    assert bungo["species"] == [
        ["Karenia mikimotoi", 19],
        ["Gymnodinium mikimotoi Miyake et Kominami ex Oda 1935", 7],
        ["Heterosigma akashiwo", 6],
        ["Cochlodinium polykrikoides", 5],
        ["Alexandrium tamarense", 3],
    ]
    assert bungo["places"] == [
        "Northern part of Hiroshima Bay",
        "Suonada",
        "Bungo-suido (Ehime prefecture)",
    ]
    # AU-70-001 (1770) has no illness row in the archive
    assert positions[(-19.94, 148.81)]["years"] == {
        "1770": {"n": 1, "ill": {"None": 1}}
    }


def test_main_publishes_positions_lists_the_undated_and_off_globe_and_no_contacts(
    tmp_path,
):
    def fetch_to(url, path):
        path.write_bytes(FIX.read_bytes())

    haedat.main(
        ["--out-dir", str(tmp_path / "out"), "--cache", str(tmp_path / "cache")],
        fetch_to=fetch_to,
        sha256=FIX_SHA,
    )
    text = (tmp_path / "out" / "haedat.json").read_text()
    d = json.loads(text)
    assert d["events"] == 156  # 165 less the 9 off the globe
    assert len(d["positions"]) == 4
    assert d["undated"] == ["HAEDAT:JP-04:JP-01-008"]
    assert len(d["offGlobe"]) == 9 and all(
        "(21.7187, -808.8684)" in o for o in d["offGlobe"]
    )
    assert d["illnesses"] == [
        "PSP",
        "DSP",
        "ASP",
        "NSP",
        "AZP",
        "CFP",
        "Cyano",
        "Aerosol",
        "Other",
        "None",
    ]
    assert (
        d["source"]["doi"] == "10.25607/k68d5v"
        and d["source"]["licence"] == "CC BY 4.0"
    )
    assert "@" not in text  # no e-mail addresses
    assert "higherGeography" not in text and '"region"' not in text
