"""IUCN Red List enrichment. Fixture snippets are verbatim from real v4 responses
(rredlist's recorded cassettes tests/fixtures/rl_species.yml + rl_assessment.yml,
recorded 2024-09-18 against api.iucnredlist.org — the live API needs a token
that was absent this session)."""

import json
import urllib.error
import pytest
from pipeline.iucn import (
    split_name,
    pick_latest_global,
    normalise_assessment,
    lookup,
    build,
    Unauthorized,
    BASE,
)

# GET /api/v4/taxa/scientific_name?genus_name=Gorilla&species_name=gorilla (trimmed to 3 of 9 assessments)
SUMMARY = {
    "taxon": {"sis_id": 9404, "scientific_name": "Gorilla gorilla"},
    "assessments": [
        {
            "year_published": "2016",
            "latest": False,
            "sis_taxon_id": 9404,
            "url": "https://www.iucnredlist.org/species/9404/17963949",
            "assessment_id": 17963949,
            "scopes": [{"description": {"en": "Global"}, "code": "1"}],
        },
        {
            "year_published": "2018",
            "latest": True,
            "sis_taxon_id": 9404,
            "url": "https://www.iucnredlist.org/species/9404/136250858",
            "assessment_id": 136250858,
            "scopes": [{"description": {"en": "Global"}, "code": "1"}],
        },
        {
            "year_published": "2008",
            "latest": False,
            "sis_taxon_id": 9404,
            "url": "https://www.iucnredlist.org/species/9404/12983787",
            "assessment_id": 12983787,
            "scopes": [{"description": {"en": "Global"}, "code": "1"}],
        },
    ],
}
# GET /api/v4/assessment/166290968 (fields used; Europe-scope assessment of Fratercula arctica)
ASSESSMENT = {
    "assessment_id": 166290968,
    "year_published": "2021",
    "latest": True,
    "possibly_extinct": False,
    "sis_taxon_id": 22694927,
    "criteria": "A2abcde+4abcde",
    "url": "https://www.iucnredlist.org/species/22694927/166290968",
    "citation": "BirdLife International 2021. Fratercula arctica (Europe assessment). The IUCN Red List of Threatened Species 2021: e.T22694927A166290968. https://dx.doi.org/10.2305/IUCN.UK.2021-3.RLTS.T22694927A166290968.en. Accessed on 18 September 2024.",
    "red_list_category": {
        "version": "3.1",
        "description": {"en": "Endangered"},
        "code": "EN",
    },
    "scopes": [{"description": {"en": "Europe"}, "code": "2"}],
    "taxon": {"sis_id": 22694927, "scientific_name": "Fratercula arctica"},
}
NOSLEEP = lambda s: None  # noqa: E731


def test_split_name_binomial_vs_genus():
    assert split_name("Megaptera novaeangliae") == ("Megaptera", "novaeangliae")
    assert split_name("Bombus") is None and split_name("") is None
    # mutant: split_name returning ("Bombus", "") passes the first assert, fails the second


def test_pick_latest_global_prefers_latest_true_global_scope():
    # mutant: `latest is True` → `latest is False` picks 17963949/2016 here
    assert pick_latest_global(SUMMARY["assessments"])["assessment_id"] == 136250858
    regional = {
        "year_published": "2021",
        "latest": True,
        "assessment_id": 1,
        "scopes": [{"description": {"en": "Europe"}, "code": "2"}],
    }
    glob_old = {
        "year_published": "2010",
        "latest": True,
        "assessment_id": 2,
        "scopes": [{"description": {"en": "Global"}, "code": "1"}],
    }
    assert pick_latest_global([regional, glob_old])["assessment_id"] == 2, (
        "Global beats a newer regional one"
    )
    assert pick_latest_global([regional])["assessment_id"] == 1, (
        "regional-only taxa still get their latest"
    )
    assert (
        pick_latest_global([]) is None
        and pick_latest_global([{**glob_old, "latest": False}]) is None
    )


def test_normalise_assessment_carries_category_year_citation_url():
    e = normalise_assessment(ASSESSMENT)
    assert (
        e["category"] == "EN"
        and e["year"] == 2021
    )
    assert (
        e["url"].endswith("/22694927/166290968")
        and "e.T22694927A166290968" in e["citation"]
    )
    assert e["scope"] == "Europe"
    # §4: nothing beyond category/year/citation/url/scope is written (mutant: re-adding assessment_id fails)
    assert set(e) == {"category", "year", "citation", "url", "scope"}
    assert (
        normalise_assessment(
            {**ASSESSMENT, "scopes": [{"description": {"en": "Global"}, "code": "1"}]}
        )["scope"]
        == "Global"
    )
    with pytest.raises(
        ValueError
    ):  # mutant: dropping the code check returns category None silently
        normalise_assessment({**ASSESSMENT, "red_list_category": {}})
    json.dumps(e)


def _fetch_factory(pages, seen):
    def fetch(url, token):
        seen.append((url, token))
        for k, v in pages.items():
            if k in url:
                return v
        raise AssertionError(f"unexpected url {url}")

    return fetch


def test_lookup_two_calls_summary_then_assessment_with_token_and_pause():
    seen, slept = [], []
    pages = {
        "taxa/scientific_name?genus_name=Gorilla&species_name=gorilla": SUMMARY,
        "assessment/136250858": {**ASSESSMENT, "assessment_id": 136250858},
    }
    entry, why = lookup(
        {"id": "gorilla", "sci": "Gorilla gorilla"},
        "tok",
        _fetch_factory(pages, seen),
        slept.append,
    )
    assert why is None and entry["category"] == "EN"
    assert [u.split(BASE + "/")[1] for u, _ in seen] == [
        "taxa/scientific_name?genus_name=Gorilla&species_name=gorilla",
        "assessment/136250858",
    ]
    assert all(t == "tok" for _, t in seen)
    assert slept == [2.0, 2.0], (
        "2 s pause after every call (mutant: PAUSE_S=0 fails here)"
    )
    # genus-only → no call at all (negative), binomial above is the positive control
    assert lookup(
        {"id": "bumblebees", "sci": "Bombus"},
        "tok",
        lambda *a: (_ for _ in ()).throw(AssertionError("must not call")),
        NOSLEEP,
    ) == (None, "genus-level taxon, no species epithet")
    # 404 on the summary → (None, reason), not an exception
    assert lookup(
        {"id": "x", "sci": "Loxodonta africanum"}, "tok", lambda u, t: None, NOSLEEP
    ) == (None, "not found in the Red List")


def test_build_maps_by_taxon_id_records_skips_and_failures_and_raises_on_bad_token():
    taxa = [
        {"id": "gorilla", "sci": "Gorilla gorilla"},
        {"id": "bumblebees", "sci": "Bombus"},
        {"id": "ghost", "sci": "Loxodonta africanum"},
        {"id": "boom", "sci": "Ursus maritimus"},
    ]

    def fetch(url, token):
        if "Gorilla" in url:
            return SUMMARY
        if "assessment/136250858" in url:
            return {**ASSESSMENT, "assessment_id": 136250858}
        if "Loxodonta" in url:
            return None
        raise RuntimeError("500 for Ursus")

    out = build(taxa, "tok", fetch, NOSLEEP)
    assert set(out) == {"gorilla", "_meta"}
    assert out["gorilla"]["category"] == "EN"
    assert out["_meta"]["skipped"] == {
        "bumblebees": "genus-level taxon, no species epithet",
        "ghost": "not found in the Red List",
    }
    assert (
        "500 for Ursus" in out["_meta"]["failures"]["boom"]
    )  # mutant: swallowing to `skipped` fails here
    assert out["_meta"]["generated_at"].endswith("Z")

    # a rejected token aborts the whole run (a 401 on every taxon must not become 22 "failures")
    def bad(url, token):
        raise Unauthorized("IUCN API 401")

    with pytest.raises(Unauthorized):
        build(taxa[:1], "bad", bad, NOSLEEP)


def test_get_json_maps_404_to_none_and_401_to_unauthorized(monkeypatch):
    import pipeline.iucn as m

    def opener(code):
        def _open(req, timeout=60):
            assert req.get_header(
                "Authorization"
            ) == "tok" and "wildeye" in req.get_header("User-agent")
            raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)

        return _open

    monkeypatch.setattr(m.urllib.request, "urlopen", opener(404))
    assert (
        m._get_json(BASE + "/taxa/scientific_name?genus_name=A&species_name=b", "tok")
        is None
    )
    monkeypatch.setattr(m.urllib.request, "urlopen", opener(401))
    with pytest.raises(Unauthorized):
        m._get_json(BASE + "/assessment/1", "tok")
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    monkeypatch.setattr(m.urllib.request, "urlopen", opener(503))
    with pytest.raises(
        urllib.error.HTTPError
    ):  # 5xx retried then surfaced, never swallowed
        m._get_json(BASE + "/assessment/1", "tok")


def test_main_without_token_writes_empty_seed_once_and_exits_loud(
    tmp_path, monkeypatch, capsys
):
    import pipeline.iucn as m

    monkeypatch.delenv("IUCN_TOKEN", raising=False)
    out = tmp_path / "iucn.json"
    with pytest.raises(SystemExit) as ex:
        m.main(["--out", str(out)])
    assert "IUCN_TOKEN" in str(ex.value) and "users/sign_up" in str(ex.value)
    assert json.loads(out.read_text()) == {}
    out.write_text('{"humpback":{"category":"LC"}}')
    with pytest.raises(SystemExit):
        m.main(["--out", str(out)])
    assert json.loads(out.read_text()) == {"humpback": {"category": "LC"}}, (
        "an existing seed is never clobbered by {} (mutant: unconditional write fails here)"
    )
