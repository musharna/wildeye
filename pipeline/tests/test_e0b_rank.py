import datetime as dt
import random

from pipeline import e0_dieoffs as e0
from pipeline import e0b_rank as rb
from pipeline.tests.test_e0_dieoffs import weekly


def zero_inflated_panel(n_counties=200, seed=5):
    """DSCI shaped like the real series (E0's lesson). Each county-year draws from the mix measured on the real cache
    (first week of July, 48,022 county-years, 2026-11-08): 0 56.1%, 1-10 2.4%, 10-50 4.5%, 50-200 24.2%, >200 12.8%.
    E0's unit-test panel (uniform 0-400, no zeros) could not show the tail that voided E0; this one does (below)."""
    rng = random.Random(seed)
    bins = [
        (0.561, 0, 0),
        (0.024, 1, 10),
        (0.045, 10, 50),
        (0.242, 50, 200),
        (0.128, 200, 500),
    ]

    def draw():
        u = rng.random()
        for p, lo, hi in bins:
            if u < p:
                return rng.uniform(lo, hi) if hi else 0.0
            u -= p
        return rng.uniform(200, 500)

    out = {}
    for i in range(n_counties):
        level = {y: draw() for y in range(2000, 2027)}
        out[f"{i:05d}"] = e0.Dsci(
            weekly(
                dt.date(2000, 1, 4),
                dt.date(2026, 6, 30),
                lambda d, lv=level: lv[d.year],
            )
        )
    return out


def cases_on(dsci, n=5):
    rng = random.Random(9)
    return [
        {
            "id": k,
            "fips": f,
            "start": dt.date(rng.randint(2001, 2025), rng.randint(1, 12), 15),
            "cls": "X",
            "suspect": False,
        }
        for k, f in enumerate(f for f in dsci for _ in range(n))
    ]


def test_rank_score_is_the_mid_rank_among_the_stratum_years_and_says_nothing_when_it_cannot():
    vals = {2010: 0.0, 2011: 0.0, 2012: 100.0, 2013: 0.0}
    assert rb.rank_score(2012, vals) == (0.5, None)  # above all 3 others: u = 1
    s, why = rb.rank_score(2010, vals)  # 0 below, 2 tied of 3: u = 1/3
    assert why is None and abs(s - (1 / 3 - 0.5)) < 1e-12
    assert rb.rank_score(2012, {2010: 5.0, 2011: 5.0, 2012: 5.0}) == (
        None,
        "stratum_flat",
    )
    assert rb.rank_score(2012, {2011: 0.0, 2012: 9.0}) == (None, "few_years")
    assert rb.rank_score(2014, vals) == (None, "no_map")


def test_on_zero_inflated_drought_the_no_effect_plant_reads_0_and_beta_1_reads_above_and_e0s_mean_z_does_not():
    dsci = zero_inflated_panel()
    base = cases_on(dsci)
    off = rb.class_stats(rb.planted_cases(base, dsci, beta=0.0), dsci, draws=400)[
        "classes"
    ]["planted_beta_0"]
    on = rb.class_stats(rb.planted_cases(base, dsci, beta=1.0), dsci, draws=400)[
        "classes"
    ]["planted_beta_1"]
    assert not e0.excludes_zero(off["ci"]) and abs(off["mean_s"]) < 0.03
    assert on["ci"][0] > 0
    # the same fixture through E0's statistic shows E0's failure: the no-effect plant reads drought
    e0_off = e0.class_stats(e0.planted_cases(base, dsci, beta=0.0), dsci, draws=400)[
        "classes"
    ]["planted_beta_0"]
    assert e0_off["mean_z"] > 0.2 and e0_off["ci"][0] > 0


def test_a_planted_case_is_scored_in_its_source_cases_stratum_and_the_placebo_in_its_own():
    # one spike year, 2016: inside a 2012 case's stratum (2008-2016), outside a 2009 case's own (2005-2013)
    s = e0.Dsci(
        weekly(
            dt.date(2000, 1, 4),
            dt.date(2026, 6, 30),
            lambda d: 300.0 if d.year == 2016 else float(d.year % 2),
        )
    )
    planted = {
        "fips": "x",
        "start": dt.date(2009, 7, 14),
        "stratum_year": 2012,
        "cls": "p",
    }
    own = {"fips": "x", "start": dt.date(2009, 7, 14), "cls": "p"}
    in_source = rb.case_score(planted, s)[0]
    in_own = rb.case_score(own, s)[0]
    assert in_source != in_own
    assert (
        in_source == rb.rank_score(2009, rb.stratum(2012, dt.date(2009, 7, 14), s))[0]
    )
    real = {"fips": "x", "start": dt.date(2012, 7, 10), "cls": "p"}
    shifted = dt.date(2012, 7, 10) + dt.timedelta(weeks=26)
    assert (
        rb.case_score(real, s, shift_weeks=26)[0]
        == rb.rank_score(2013, rb.stratum(2013, shifted, s))[0]
    )


def test_the_expected_plant_is_exactly_0_with_no_effect_and_above_0_with_beta_1():
    dsci = zero_inflated_panel(n_counties=60)
    base = cases_on(dsci)
    null = rb.expected_cases(base, dsci, beta=0.0)
    scored = [c["score"] for c in null if c["score"] is not None]
    assert len(scored) > 200 and all(
        v == 0 for v in scored
    )  # a mid-rank averages exactly 1/2 over positions
    off = rb.class_stats(null, dsci, draws=200)["classes"]["expected_beta_0"]
    on = rb.class_stats(rb.expected_cases(base, dsci, beta=1.0), dsci, draws=200)[
        "classes"
    ]["expected_beta_1"]
    assert not e0.excludes_zero(off["ci"]) and on["ci"][0] > 0.1
    assert (
        sum(c["score_why"] == "stratum_flat" for c in null) > 0
    )  # all-zero strata are dropped, not scored 0


def test_a_case_at_the_turn_of_the_year_is_scored_as_its_own_iso_week():
    # 2019-12-30 is ISO 2020 week 1. ISO 2020 is 100 and ISO 2024 is 200, the rest 0-2, so in its own stratum
    # (ISO 2016-2024) the case is above 7 of 8 years: s = 7/8 - 1/2. Keyed by its calendar year (2019) it was scored
    # as the week of 2018-12-31 (one of its own referents), in a stratum (2015-2023) that misses 2024.
    rows, d = [], dt.date(2000, 1, 1)
    while d <= dt.date(2026, 6, 30):
        iy = d.isocalendar().year
        rows.append(
            {
                "mapDate": f"{d.isoformat()}T00:00:00",
                "dsci": {2020: 100.0, 2024: 200.0}.get(iy, float(iy % 3)),
            }
        )
        d += dt.timedelta(days=1)
    s = e0.Dsci(rows)
    case = {"fips": "x", "start": dt.date(2019, 12, 30), "cls": "p"}
    assert rb.case_score(case, s) == (7 / 8 - 0.5, None)
    week53 = {
        "fips": "x",
        "start": dt.date(2021, 1, 1),
        "cls": "p",
    }  # ISO 2020 week 53: only 53-week years match
    # 2016-2024 holds one 53-week ISO year (2020), so the stratum is too small to score (review of PR #167: the old
    # `in (None, "few_years")` also passed if the case were wrongly scored)
    assert rb.case_score(week53, s) == (None, "few_years")
    assert rb.iso_year(week53["start"]) == 2020
    plants = rb.planted_cases([case | {"id": 1}], {"x": s}, beta=0.0)
    assert all(
        rb.case_score(p, s)[1] is None for p in plants
    )  # a drawn year is always one with a map
