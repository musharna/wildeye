"""Penguin colonies: the R save-file reader, the pinned release files, the licence check, and the per site x species
summary.

Fixtures (pipeline/tests/fixtures/penguins/): `penguin_obs.rda`, `sites.rda`, `species.rda` and `README.md` are the
release's own files (mapppdr v3.1, commit 88c73a50, CC BY 4.0 data), byte for byte, so CI reads the real format. The
small `kinds.rda`, `factor.rda`, `altrep.rda` and `notdf.rda` were written by R 4.3.3 with save():
  kinds <- data.frame(i = c(1L, NA, -7L), d = c(1.5, NA, NaN), l = c(TRUE, NA, FALSE), s = c("Adélie", NA, "NA"),
                      day = as.Date(c("2026-02-06", NA, "1892-11-01")))
  latin <- data.frame(s = iconv("Adélie", "UTF-8", "latin1")); save(kinds, latin, file = "kinds.rda")
  fac <- data.frame(f = factor(c("nests", "chicks"))); seqdf <- data.frame(a = 1:3)  # 1:3 is an ALTREP sequence
  notdf <- list(a = 1)
Every expected value below was read with R from the same files (Rscript, `load()`), not with this module.
"""

import copy
import gzip
import hashlib
import json
from pathlib import Path

import pytest
from pipeline import penguins, rda

FIX = Path(__file__).parent / "fixtures" / "penguins"
OBS, SITES, SPECIES = FIX / "penguin_obs.rda", FIX / "sites.rda", FIX / "species.rda"


def test_reader_reads_every_supported_kind_and_tells_na_from_nan():
    kinds = rda.data_frame(FIX / "kinds.rda", "kinds")
    assert [r["i"] for r in kinds] == [1, None, -7]
    assert [r["l"] for r in kinds] == [True, None, False]
    assert [type(r["l"]).__name__ for r in kinds] == ["bool", "NoneType", "bool"]  # not 1 and 0
    assert [r["s"] for r in kinds] == [
        "Adélie",
        None,
        "NA",
    ]  # NA_character_ is None; the string "NA" is not
    assert [r["day"] for r in kinds] == ["2026-02-06", None, "1892-11-01"]
    d = [r["d"] for r in kinds]
    assert (
        d[0] == 1.5 and d[1] is None and d[2] != d[2]
    )  # NA_real_ is None, NaN stays NaN
    assert rda.data_frame(FIX / "kinds.rda", "latin") == [
        {"s": "Adélie"}
    ]  # a latin-1 string decodes


def test_reader_refuses_what_it_would_read_wrong():
    # positive control in the same test: the release's own file reads
    assert len(rda.data_frame(SPECIES, "species")) == 7
    with pytest.raises(rda.RdaError, match=r"class \['factor'\] is not supported"):
        rda.data_frame(FIX / "factor.rda", "fac")
    with pytest.raises(rda.RdaError, match="ALTREP_SXP .* is not supported"):
        rda.data_frame(FIX / "altrep.rda", "seqdf")
    with pytest.raises(rda.RdaError, match="notdf is not a data.frame"):
        rda.data_frame(FIX / "notdf.rda", "notdf")
    with pytest.raises(rda.RdaError, match="no object 'sites'"):
        rda.data_frame(SPECIES, "sites")


def test_reader_refuses_a_stream_that_is_not_xdr_or_is_cut_short_or_has_trailing_bytes(
    tmp_path,
):
    raw = gzip.decompress(SPECIES.read_bytes())
    assert len(rda.read_objects(SPECIES)) == 1  # positive control
    bad = tmp_path / "bad.rda"
    bad.write_bytes(gzip.compress(b"RDA3\n" + raw[5:]))  # ASCII format, not XDR
    with pytest.raises(rda.RdaError, match="not an XDR .rda file"):
        rda.read_objects(bad)
    bad.write_bytes(gzip.compress(raw[:5] + b"A\n" + raw[7:]))  # an XDR header over an ASCII body
    with pytest.raises(rda.RdaError, match="not an XDR .rda file"):
        rda.read_objects(bad)
    bad.write_bytes(gzip.compress(raw[:-40]))
    with pytest.raises(rda.RdaError, match="stream ends at byte"):
        rda.read_objects(bad)
    bad.write_bytes(gzip.compress(raw + b"\0\0\0\0"))
    with pytest.raises(rda.RdaError, match="4 bytes left after the saved objects"):
        rda.read_objects(bad)


def test_reader_reads_the_release_tables_as_r_does():
    obs = rda.data_frame(OBS, "penguin_obs")
    sites = rda.data_frame(SITES, "sites")
    species = rda.data_frame(SPECIES, "species")
    assert (len(obs), len(sites), len(species)) == (5487, 729, 7)
    assert list(obs[0]) == [
        "site_id", "species_id", "citekey", "month", "day", "doy", "date", "year", "season", "type", "presence",
        "count", "accuracy", "vantage",
    ]  # fmt: skip
    # R: penguin_obs[1, ] and [4, ]
    assert obs[0] == {
        "site_id": "ACUN", "species_id": "ADPE", "citekey": "coria2011laurie", "month": None, "day": None, "doy": None,
        "date": None, "year": 1993, "season": 1993, "type": "nests", "presence": 1, "count": 2008, "accuracy": 1,
        "vantage": "ground",
    }  # fmt: skip
    assert (obs[3]["date"], obs[3]["season"], obs[3]["count"], obs[3]["accuracy"], obs[3]["vantage"]) == (
        "2011-02-25", 2010, 3079, 5, "vhr",
    )  # fmt: skip
    assert (
        obs[-1]["site_id"] == "ZIGZ"
        and obs[-1]["date"] == "1987-01-21"
        and obs[-1]["count"] == 1000
    )
    assert sites[0] == {
        "site_id": "ACUN", "site_name": "Acuna Island", "region": "South Orkney Islands", "ccamlr_id": "48.2",
        "latitude": -60.7612, "longitude": -44.637,
    }  # fmt: skip
    assert species[-1] == {
        "species_id": "UNPE",
        "common_name": "unknown penguin",
        "genus": None,
        "species": None,
    }
    # R: table(species_id); sum(is.na(count)); sum(presence == 0)
    from collections import Counter

    assert Counter(r["species_id"] for r in obs) == {
        "ADPE": 1920, "GEPE": 1585, "CHPE": 1507, "EMPE": 338, "MCPE": 124, "KIPE": 13,
    }  # fmt: skip
    assert sum(r["count"] is None for r in obs) == 23
    assert sum(r["presence"] == 0 for r in obs) == 162


def _sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


FIX_FILES = {
    "data/penguin_obs.rda": OBS,
    "data/sites.rda": SITES,
    "data/species.rda": SPECIES,
    "README.md": FIX / "README.md",
}


def _fake_fetch(calls):
    def fetch_to(url, path):
        calls.append(url)
        name = url.split(penguins.COMMIT + "/", 1)[1]
        path.write_bytes(FIX_FILES[name].read_bytes())

    return fetch_to


def test_the_pinned_files_are_the_release_files():
    # the fixtures are the release's files, so the pins in the module are checked against them here
    assert {n: _sha(p) for n, p in FIX_FILES.items()} == penguins.FILES


def test_each_file_is_fetched_once_from_the_commit_and_refused_unless_pinned(tmp_path):
    calls = []
    wrong = dict(penguins.FILES, **{"data/sites.rda": "0" * 64})
    with pytest.raises(ValueError, match="sites.rda: sha256 .* is not the pinned 0000"):
        penguins.fetch(tmp_path, files=wrong, fetch_to=_fake_fetch(calls))
    assert not (tmp_path / "data" / "sites.rda").exists()
    assert not list(
        (tmp_path / "data").glob("*.part")
    )  # the refused download is not kept
    calls.clear()
    got = penguins.fetch(tmp_path, fetch_to=_fake_fetch(calls))  # positive control
    assert sorted(calls) == sorted(
        penguins.BASE_URL + n for n in penguins.FILES if n != "data/penguin_obs.rda"
    )
    assert all(
        u.startswith("https://raw.githubusercontent.com/CCheCastaldo/mapppdr/88c73a50")
        for u in calls
    )
    assert {n: p.read_bytes() for n, p in got.items()} == {
        n: p.read_bytes() for n, p in FIX_FILES.items()
    }
    calls.clear()
    assert penguins.fetch(tmp_path, fetch_to=_fake_fetch(calls)) == got
    assert calls == []  # the cached copies are reused
    got["data/species.rda"].write_bytes(b"changed")
    with pytest.raises(ValueError, match="delete it to fetch again"):
        penguins.fetch(tmp_path, fetch_to=_fake_fetch(calls))


def test_a_readme_that_drops_cc_by_is_refused():
    readme = (FIX / "README.md").read_text(encoding="utf-8")
    assert "Creative Commons Attribution 4.0" in penguins.check_licence(
        readme
    )  # positive control: the real README
    with pytest.raises(ValueError, match="no longer states CC BY 4.0"):
        penguins.check_licence(readme.replace("licenses/by/4.0", "licenses/by-nc/4.0"))
    with pytest.raises(ValueError, match="no longer states CC BY 4.0"):
        penguins.check_licence(
            readme.replace(
                "Attribution 4.0\nInternational",
                "Attribution-NonCommercial 4.0\nInternational",
            )
        )


@pytest.fixture(scope="module")
def tables():
    return (
        rda.data_frame(OBS, "penguin_obs"),
        rda.data_frame(SITES, "sites"),
        rda.data_frame(SPECIES, "species"),
    )


def test_tables_outside_the_decisions_are_refused(tables):
    obs, sites, species = tables
    penguins.check_tables(obs, sites, species)  # positive control: the release passes

    def obs_with(i, **change):
        o = copy.deepcopy(obs)
        o[i].update(change)
        return o

    cases = [
        (obs_with(0, type="eggs"), sites, "unknown count type 'eggs'"),
        (obs_with(0, species_id="ROPE"), sites, "unknown species"),
        (obs_with(0, site_id="NOPE"), sites, "unknown site"),
        (obs_with(0, presence=2), sites, "presence 2 is not 0 or 1"),
        (obs_with(0, count=-1), sites, "negative count -1"),
        (obs_with(0, presence=0), sites, "an absence with count 2008"),
        (obs_with(0, count=0), sites, "present with a count of 0"),
        (obs_with(0, accuracy=6), sites, "accuracy 6 is not 1-5"),
        (obs_with(0, accuracy=0), sites, "accuracy 0 is not 1-5"),
        (obs_with(0, season=None), sites, "no season"),
        (obs_with(0, vantage="kite"), sites, "unknown vantage 'kite'"),
        (obs, sites + [dict(sites[0])], r"duplicate site ids \['ACUN'\]"),
        (obs, [dict(sites[0], latitude=60.7612)] + sites[1:], r"ACUN at \(60.7612"),
        (obs, [dict(sites[0], latitude=-54.9)] + sites[1:], r"ACUN at \(-54.9"),
        (obs, [dict(sites[0], latitude=None)] + sites[1:], r"ACUN at \(None"),
        (
            obs,
            [dict(sites[0], longitude=-184.6)] + sites[1:],
            r"ACUN at \(-60.7612, -184.6\)",
        ),
    ]
    for o, s, message in cases:
        with pytest.raises(ValueError, match=message):
            penguins.check_tables(o, s, species)
    # the edges that are allowed: an absence with count 0, presence only, accuracy NA, 55S and 180E exactly
    edge = obs_with(0, presence=0, count=0)
    edge[1].update(count=None, accuracy=None, vantage=None)
    penguins.check_tables(
        edge, [dict(sites[0], latitude=-55.0, longitude=180.0)] + sites[1:], species
    )


@pytest.fixture(scope="module")
def built(tables):
    out = penguins.build(*tables)
    return out, {(p["site"], p["species"]): p for p in out["points"]}


def test_one_point_per_breeding_site_and_species(built):
    out, by = built
    # R: unique(site_id, species_id) with max(presence) == 1 -> 918, equal to the authors' site_species table
    assert len(out["points"]) == 918
    from collections import Counter

    assert Counter(p["species"] for p in out["points"]) == {
        "CHPE": 369, "ADPE": 287, "GEPE": 142, "EMPE": 68, "MCPE": 44, "KIPE": 8,
    }  # fmt: skip
    assert len({p["site"] for p in out["points"]}) == 726
    assert out["absentOnly"] == [
        "DARX ADPE",
        "DEEI ADPE",
        "GREI ADPE",
        "GREI CHPE",
        "LEDD EMPE",
        "UNN2 ADPE",
    ]
    assert [s["id"] for s in out["species"]] == [
        "ADPE",
        "CHPE",
        "EMPE",
        "GEPE",
        "KIPE",
        "MCPE",
    ]  # no UNPE
    assert sum(p["latest"] is None for p in out["points"]) == 12
    acun = by[("ACUN", "ADPE")]
    assert (acun["name"], acun["region"], acun["lat"], acun["lon"]) == (
        "Acuna Island",
        "South Orkney Islands",
        -60.7612,
        -44.637,
    )


def test_latest_counts_keep_every_count_of_the_latest_counted_season_newest_first(
    built,
):
    _, by = built
    bong = by[("BONG", "ADPE")]
    assert (bong["records"], bong["surveys"], bong["first"], bong["last"]) == (
        14,
        14,
        1983,
        2025,
    )
    # two nest counts on 22 Dec 2025, ground and UAV: both kept, neither picked
    assert bong["latest"]["season"] == 2025
    assert sorted((c["count"], c["vantage"]) for c in bong["latest"]["counts"]) == [
        (1722, "ground"),
        (2707, "uav"),
    ]
    # a latest season whose newest count is chicks and whose earlier one is nests: newest date first
    brea = by[("BREA", "GEPE")]
    assert brea["latest"] == {
        "season": 2025,
        "counts": [
            {
                "type": "chicks",
                "count": 1471,
                "date": "2026-02-06",
                "accuracy": 3,
                "vantage": "ground",
            },
            {
                "type": "nests",
                "count": 2337,
                "date": "2025-12-14",
                "accuracy": 1,
                "vantage": "uav",
            },
        ],
    }
    assert (
        brea["presentOnly"] is None
    )  # its presence-only record (2022) is older than the counts
    assert (brea["records"], brea["surveys"], brea["first"]) == (3, 3, 2022)
    # one survey, two types, no date
    bart = by[("BART", "CHPE")]
    assert [(c["type"], c["count"], c["date"]) for c in bart["latest"]["counts"]] == [
        ("nests", 2353, None),
        ("chicks", 2399, None),
    ]
    assert (bart["records"], bart["surveys"], bart["first"], bart["last"]) == (
        35,
        25,
        1980,
        2019,
    )
    croz = by[("CROZ", "EMPE")]
    assert [(c["type"], c["count"], c["date"]) for c in croz["latest"]["counts"]] == [
        ("adults", 1664, "2018-11-04"),
        ("chicks", 1416, "2018-11-01"),
    ]
    assert (croz["records"], croz["surveys"]) == (31, 21)
    # a latest count that found none is a count
    assert by[("ANCH", "ADPE")]["latest"]["counts"] == [
        {"type": "nests", "count": 0, "date": None, "accuracy": 1, "vantage": "ground"}
    ]
    # presence only, never counted
    lazn = by[("LAZN", "EMPE")]
    assert lazn["latest"] is None and lazn["presentOnly"] == 2022
    assert (lazn["records"], lazn["surveys"], lazn["first"], lazn["last"]) == (
        5,
        5,
        2018,
        2022,
    )


def test_summarise_edges_a_later_presence_only_record_and_an_earlier_season_with_a_later_date():
    def rec(
        season, count, date=None, type_="nests", presence=1, cite="a", vantage="ground"
    ):
        return {"season": season, "count": count, "date": date, "type": type_, "presence": presence, "citekey": cite,
                "vantage": vantage, "accuracy": 1}  # fmt: skip

    s = penguins.summarise([rec(2010, 50), rec(2012, None)])
    assert (
        s["latest"]["season"] == 2010 and s["presentOnly"] == 2012
    )  # a later presence note is reported
    s = penguins.summarise([rec(2012, 50), rec(2012, None)])
    assert s["presentOnly"] is None  # not later than the count
    s = penguins.summarise([rec(2010, 50), rec(2012, 0, presence=0)])
    assert s["latest"]["counts"][0]["count"] == 0 and s["presentOnly"] is None
    # the season decides, not the date: 2011's count dated Jan 2012 is older than nothing in 2012
    s = penguins.summarise([rec(2011, 7, "2012-01-15"), rec(2012, 9, None)])
    assert s["latest"]["season"] == 2012 and [
        c["count"] for c in s["latest"]["counts"]
    ] == [9]
    # dated before undated within a season; surveys = distinct (citekey, season, date, vantage)
    s = penguins.summarise(
        [
            rec(2012, 1, None),
            rec(2012, 2, "2012-12-01"),
            rec(2012, 3, "2012-12-01", "chicks"),
        ]
    )
    # same date: ordered by type name, nests before chicks, only so that the order is fixed by the data
    assert [c["count"] for c in s["latest"]["counts"]] == [2, 3, 1]
    assert s["latest"]["counts"][-1]["date"] is None
    assert s["surveys"] == 2 and s["records"] == 3
    assert (
        penguins.summarise([rec(2012, 1, vantage="uav"), rec(2012, 2)])["surveys"] == 2
    )


def test_main_writes_the_points_the_absent_pairs_and_the_source(tmp_path):
    penguins.main(
        ["--out-dir", str(tmp_path / "out"), "--cache", str(tmp_path / "cache")],
        fetch_to=_fake_fetch([]),
    )
    d = json.loads((tmp_path / "out" / "penguins.json").read_text())
    assert len(d["points"]) == 918 and len(d["absentOnly"]) == 6
    assert (
        d["source"]["licence"] == "CC BY 4.0"
        and d["source"]["doi"] == "10.3897/BDJ.11.e101476"
    )
    assert (
        d["source"]["datasetDoi"] == "10.48361/zftxkr"
        and d["source"]["commit"] == penguins.COMMIT
    )
    assert "Creative Commons Attribution 4.0 International" in d["source"]["rights"]
    assert "citekey" not in json.dumps(d)  # no per-record citation keys published
