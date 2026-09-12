"""pipeline/phenology.py — USA-NPN status reports per site per week per phenophase class.

Fixture rows are verbatim from getObservations.json responses fetched 2026-09-12
(plant, Activity and Development requests), trimmed only in count; species ids/functional
types re-checked against a live getSpecies.json the same day (robin 246, monarch 396).
Mutants each test was seen to fail on are named in the test docstrings.
"""

import datetime as dt
import json
import pipeline.phenology as m
from pipeline.phenology import (
    aggregate,
    classify,
    collect,
    fetch_observations,
    fetch_functional_types,
    observations_url,
    main,
)

# real rows (2026-09-12): a plant "no", a plant "yes", an animal "no"
FRUIT_NO = {
    "observation_id": 57549484,
    "update_datetime": -9999,
    "site_id": 24702,
    "latitude": 33.76149,
    "longitude": -111.842232,
    "elevation_in_meters": 760,
    "state": "AZ",
    "species_id": 1022,
    "genus": "Senna",
    "species": "covesii",
    "common_name": "Coues' cassia",
    "kingdom": "Plantae",
    "individual_id": 372942,
    "phenophase_id": 501,
    "phenophase_description": "Open flowers",
    "observation_date": "2026-09-05",
    "day_of_year": 248,
    "phenophase_status": 0,
    "intensity_category_id": 50,
    "intensity_value": -9999,
    "abundance_value": -9999,
}
MUSKRAT_NO = {
    "observation_id": 57551071,
    "update_datetime": "2026-09-06 20:51:26",
    "site_id": 10145,
    "latitude": 42.602543,
    "longitude": -83.250992,
    "elevation_in_meters": 277,
    "state": "MI",
    "species_id": 2394,
    "genus": "Ondatra",
    "species": "zibethicus",
    "common_name": "common muskrat",
    "kingdom": "Animalia",
    "individual_id": 376217,
    "phenophase_id": 292,
    "phenophase_description": "Live individuals",
    "observation_date": "2026-09-05",
    "day_of_year": 248,
    "phenophase_status": 0,
    "intensity_category_id": -9999,
    "intensity_value": -9999,
    "abundance_value": -9999,
}
# real getSpecies rows, trimmed to the fields used
SPECIES = [
    {
        "species_id": 1022,
        "common_name": "Coues' cassia",
        "kingdom": "Plantae",
        "functional_type": "Forb",
    },
    {
        "species_id": 2394,
        "common_name": "common muskrat",
        "kingdom": "Animalia",
        "functional_type": "Mammal",
    },
    {
        "species_id": 246,
        "common_name": "American robin",
        "kingdom": "Animalia",
        "functional_type": "Bird",
    },
    {
        "species_id": 396,
        "common_name": "monarch",
        "kingdom": "Animalia",
        "functional_type": "Insect",
    },
]
FUNCTIONAL = {1022: "Forb", 2394: "Mammal", 246: "Bird", 396: "Insect"}
# real Development rows (phenophase_category[0]=Development, 2026-09-06..12): emergence yes, and a mortality phenophase
PUPAE_YES = {
    "observation_id": 57554057,
    "update_datetime": "2026-09-06 13:59:43",
    "site_id": 17414,
    "latitude": 42.936153,
    "longitude": -73.433449,
    "elevation_in_meters": 147,
    "state": "NY",
    "species_id": 396,
    "genus": "Danaus",
    "species": "plexippus",
    "common_name": "monarch",
    "kingdom": "Animalia",
    "individual_id": 86971,
    "phenophase_id": 522,
    "phenophase_description": "Pupae",
    "observation_date": "2026-09-06",
    "day_of_year": 249,
    "phenophase_status": 1,
    "intensity_category_id": -9999,
    "intensity_value": -9999,
    "abundance_value": 1,
}
DEAD_ADULTS = {
    "observation_id": 57562238,
    "update_datetime": -9999,
    "site_id": 30414,
    "latitude": 45.553257,
    "longitude": -94.143799,
    "elevation_in_meters": 312,
    "state": "MN",
    "species_id": 396,
    "genus": "Danaus",
    "species": "plexippus",
    "common_name": "monarch",
    "kingdom": "Animalia",
    "individual_id": 162840,
    "phenophase_id": 289,
    "phenophase_description": "Dead adults",
    "observation_date": "2026-09-06",
    "day_of_year": 249,
    "phenophase_status": 0,
    "intensity_category_id": -9999,
    "intensity_value": -9999,
    "abundance_value": -9999,
}


def row(base, **kw):
    return {**base, **kw}


def test_observations_url_carries_request_src_window_and_indexed_categories():
    """mutant: drop the enumerate index (`phenophase_category[]`) → fails on the exact param names."""
    u = observations_url(
        ("Fruits", "Seed cones"), dt.date(2026, 7, 19), dt.date(2026, 9, 12)
    )
    assert u.startswith(m.API + "/observations/getObservations.json?")
    assert (
        "request_src=wildeye" in u
        and "start_date=2026-07-19" in u
        and "end_date=2026-09-12" in u
    )
    assert (
        "phenophase_category%5B0%5D=Fruits" in u
        and "phenophase_category%5B1%5D=Seed+cones" in u
    )


def test_fetch_observations_rejects_non_list_and_functional_types_index_species():
    """mutant: return `rows` unconditionally in fetch_observations → the error-dict case no longer raises."""
    assert fetch_observations(
        ("Fruits",),
        dt.date(2026, 9, 1),
        dt.date(2026, 9, 12),
        fetch=lambda u: [FRUIT_NO],
    ) == [FRUIT_NO]
    try:
        fetch_observations(
            ("Fruits",),
            dt.date(2026, 9, 1),
            dt.date(2026, 9, 12),
            fetch=lambda u: {"error": "Route not found"},
        )
        assert False, "a dict answer must raise"
    except RuntimeError as e:
        assert "Route not found" in str(e)
    assert fetch_functional_types(fetch=lambda u: SPECIES) == FUNCTIONAL


def test_classify_plants_by_request_animals_by_functional_type():
    """mutants: (a) `return classes[0]` for every row → the muskrat would land in 'insects';
    (b) delete the DEAD_PREFIX check → the Dead adults row classifies as 'insects' (Pupae is the positive control)."""
    assert classify(FRUIT_NO, ("fruits",), FUNCTIONAL) == "fruits"
    assert classify(MUSKRAT_NO, ("insects", "birds"), FUNCTIONAL) is None, (
        "mammal in the Activity request is not served"
    )
    assert (
        classify(row(MUSKRAT_NO, species_id=246), ("insects", "birds"), FUNCTIONAL)
        == "birds"
    )
    assert (
        classify(row(MUSKRAT_NO, species_id=396), ("insects", "birds"), FUNCTIONAL)
        == "insects"
    )
    assert classify(PUPAE_YES, ("insects",), FUNCTIONAL) == "insects", (
        "emergence row is served"
    )
    assert classify(DEAD_ADULTS, ("insects",), FUNCTIONAL) is None, (
        "a mortality phenophase is not emergence"
    )
    assert (
        classify(row(MUSKRAT_NO, species_id=999999), ("insects", "birds"), FUNCTIONAL)
        is None
    ), "unknown species → None"


def test_aggregate_bins_weeks_counts_yes_and_checked_drops_uncertain_and_outside_window():
    """mutants: `st not in (0, 1)` → `st != 1` (the 'no' row stops counting as checked; obs assertion fails);
    `k >= weeks` → `k > weeks` (the 2026-07-18 row, exactly 56 days back, leaks in as bin 8; outside_window count fails)."""
    today = dt.date(2026, 9, 12)
    rows = {
        "fruits": [
            row(FRUIT_NO, phenophase_status=1, observation_date="2026-09-12"),  # bin 0
            row(
                FRUIT_NO,
                phenophase_status=1,
                observation_date="2026-09-06",
                observation_id=2,
            ),  # bin 0 (7 days ending 09-12)
            row(
                FRUIT_NO,
                phenophase_status=0,
                observation_date="2026-09-05",
                observation_id=3,
            ),  # bin 1, checked only
            row(
                FRUIT_NO,
                phenophase_status=-1,
                observation_date="2026-09-05",
                observation_id=4,
            ),  # uncertain
            row(
                FRUIT_NO,
                phenophase_status=1,
                observation_date="2026-07-01",
                observation_id=5,
            ),  # outside 8 weeks
            row(
                FRUIT_NO,
                phenophase_status=1,
                observation_date="2026-07-18",
                observation_id=7,
            ),  # exactly 56 days back = bin 8, outside
            row(
                FRUIT_NO,
                phenophase_status=0,
                observation_date="2026-07-19",
                observation_id=8,
            ),  # 55 days back = bin 7, oldest in-window day
            row(
                FRUIT_NO,
                phenophase_status=1,
                observation_date="2026-09-10",
                site_id=1,
                latitude=-9999,
                observation_id=6,
            ),
        ],
        "birds": [
            row(
                MUSKRAT_NO,
                species_id=246,
                common_name="American robin",
                phenophase_status=1,
                observation_date="2026-09-01",
                site_id=24702,
                state="AZ",
            )
        ],
        "leaves": [],
    }
    feats, c = aggregate(rows, today, weeks=8)
    assert c == {
        "in_window": 5,
        "uncertain": 1,
        "outside_window": 2,
        "no_coords": 1,
        "sites": 1,
        "sites_with_yes": 1,
        "yes_leaves": 0,
        "yes_flowers": 0,
        "yes_fruits": 2,
        "yes_insects": 0,
        "yes_birds": 1,
    }
    p = feats[0]["properties"]
    assert feats[0]["geometry"] == {
        "type": "Point",
        "coordinates": [-111.84223, 33.76149],
    }
    assert (
        p["site"] == 24702
        and p["st"] == "AZ"
        and p["n"] == 3
        and p["classes"] == {"fruits": 2, "birds": 1}
    )
    assert p["weeks"] == [
        {
            "w": "2026-09-12",
            "yes": {"fruits": 2},
            "obs": {"fruits": 2},
            "sp": {"fruits": {"Coues' cassia": 2}},
        },
        {
            "w": "2026-09-05",
            "yes": {"birds": 1},
            "obs": {"fruits": 1, "birds": 1},
            "sp": {"birds": {"American robin": 1}},
        },
        {"w": "2026-07-25", "yes": {}, "obs": {"fruits": 1}, "sp": {}},
    ], (
        "bin 1 has the checked-only fruit row (obs but no yes) and the robin yes; bin 7 the oldest in-window check"
    )


def test_collect_makes_one_species_call_and_one_call_per_request_with_sleep(
    monkeypatch,
):
    """mutant: drop `time.sleep(sleep)` in collect → the sleep log stays empty."""
    calls, slept = [], []
    monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))

    def fetch(url, timeout=600):
        calls.append(url)
        if "getSpecies" in url:
            return SPECIES
        if "Activity" in url:
            return [
                MUSKRAT_NO,
                row(
                    MUSKRAT_NO,
                    species_id=396,
                    common_name="monarch",
                    phenophase_status=1,
                ),
            ]
        if "Development" in url:
            return [PUPAE_YES, DEAD_ADULTS]
        return [row(FRUIT_NO, phenophase_status=1)]

    by_cls, raw = collect(
        dt.date(2026, 7, 19), dt.date(2026, 9, 12), fetch=fetch, sleep=2.0
    )
    assert (
        len(calls) == 6
        and "getSpecies" in calls[0]
        and all("request_src=wildeye" in u for u in calls)
    )
    assert slept == [2.0] * 5
    assert {k: len(v) for k, v in by_cls.items()} == {
        "leaves": 1,
        "flowers": 1,
        "fruits": 1,
        "insects": 2,
        "birds": 0,
    }, "insects = the Activity monarch + the Development pupae; dead adults dropped"
    assert raw["animals:activity"] == 2 and raw["animals:activity:unclassed"] == 1
    assert raw["animals:development"] == 2 and raw["animals:development:unclassed"] == 1


def test_main_end_to_end(tmp_path, monkeypatch):
    """mutant: since = today - 7*weeks days (off by one) → the `since` assertion fails."""
    monkeypatch.setattr(
        m,
        "collect",
        lambda since, until, fetch=None, sleep=2.0: (
            {
                "fruits": [
                    row(FRUIT_NO, phenophase_status=1, observation_date="2026-09-10")
                ],
                "leaves": [],
                "flowers": [],
                "insects": [],
                "birds": [],
            },
            {"plants:fruits": 1},
        ),
    )
    out = tmp_path / "p.geojson"
    main(["--out", str(out), "--today", "2026-09-12"])
    gj = json.loads(out.read_text())
    assert (
        gj["since"] == "2026-07-19"
        and gj["newest"] == "2026-09-10"
        and len(gj["weeks"]) == 8
        and gj["weeks"][0] == "2026-09-12"
    )
    assert gj["counts"]["sites_with_yes"] == 1 and gj["counts"]["raw"] == {
        "plants:fruits": 1
    }
    assert (
        gj["classes"]["insects"] == "Insect activity/emergence"
        and "CC BY 4.0" in gj["source"]["licence"]
    )
    assert (
        "Nature's Notebook" in gj["source"]["note"]
        and "10.5066/F78S4N1V" in gj["source"]["citation"]
    )
    assert len(gj["features"]) == 1 and gj["features"][0]["properties"]["site"] == 24702
