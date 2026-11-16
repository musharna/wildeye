from pipeline import e0b_rank as rb
from pipeline import e0c_waterbird as wb
from pipeline.tests.test_e0b_rank import cases_on, zero_inflated_panel


def sp(order, cls="Aves"):
    return {"class_name": cls, "order_name": order}


def test_bird_group_keeps_only_events_whose_every_species_is_on_one_side():
    assert (
        wb.bird_group({"species": [sp("Anseriformes"), sp("Charadriiformes")]})
        == "waterbird"
    )
    assert (
        wb.bird_group({"species": [sp("Passeriformes"), sp("Columbiformes")]})
        == "other_bird"
    )
    assert (
        wb.bird_group({"species": [sp("Anseriformes"), sp("Passeriformes")]})
        == "excluded"
    )
    assert (
        wb.bird_group({"species": [sp("Anseriformes"), sp("Rodentia", "Mammalia")]})
        == "excluded"
    )
    assert wb.bird_group({"species": []}) == "excluded"
    assert wb.bird_group({}) == "excluded"
    assert (
        wb.bird_group({"species": [sp("Procellariiformes")]}) == "other_bird"
    )  # pelagic: not crowded by drought


def test_arms_pick_class_and_group_together():
    cases = [
        {"id": 1, "cls": "Trauma"},
        {"id": 2, "cls": "Trauma"},
        {"id": 3, "cls": "Bacteria"},
        {"id": 4, "cls": "Bacteria"},
        {"id": 5, "cls": "Toxin"},
    ]
    groups = {
        1: "waterbird",
        2: "other_bird",
        3: "waterbird",
        4: "other_bird",
        5: "waterbird",
    }
    got = {c["id"]: c["cls"] for c in wb.arms(cases, groups)}
    assert got == {1: wb.GATE, 3: "waterbird_bacteria", 4: "other_bird_bacteria"}


def stats(mean, lo, hi, n=100):
    return {
        "classes": {
            wb.GATE: {"cases": n, "counties": n, "mean_s": mean, "ci": [lo, hi]}
        }
    }


def test_verdict_reads_each_outcome_and_is_void_when_the_plant_fails_or_the_arm_is_small():
    on, off = stats(0.26, 0.25, 0.27), stats(0.0, 0.0, 0.0)

    def v(real, on=on, off=off):
        return wb.verdict(real, stats(0, -0.1, 0.1), on, off)

    assert v(stats(0.06, 0.01, 0.1))["reading"] == "detection_supported"
    assert (
        v(stats(0.0, -0.03, 0.03))["reading"] == "detection_of_finding_size_ruled_out"
    )
    assert v(stats(0.0, -0.06, 0.06))["reading"] == "inconclusive"
    # the boundary: an upper bound at the finding does not rule it out
    assert v(stats(0.0, -0.03, wb.FINDING))["reading"] == "inconclusive"
    assert v(stats(0.0, -0.03, 0.03))["status"] == "CLOSED"
    assert v(stats(0.0, -0.03, 0.03), on=stats(0.26, -0.01, 0.5))["status"] == "VOID"
    assert v(stats(0.0, -0.03, 0.03), off=stats(0.02, 0.01, 0.03))["status"] == "VOID"
    assert v(stats(0.0, -0.03, 0.03, n=49))["status"] == "VOID"


def test_on_zero_inflated_drought_a_planted_detection_lean_is_supported_and_no_lean_is_not():
    """The gate arm through the production scoring: cases drawn toward drier years (beta = 1) must read
    detection_supported; cases at random years (beta = 0) must not."""
    dsci = zero_inflated_panel(n_counties=120)
    base = [c | {"cls": wb.GATE} for c in cases_on(dsci, n=3)]
    on = rb.class_stats(
        rb.expected_cases(base, dsci, beta=1.0), dsci, k=wb.GATE_K, draws=300
    )
    off = rb.class_stats(
        rb.expected_cases(base, dsci, beta=0.0), dsci, k=wb.GATE_K, draws=300
    )

    def relabel(cs):
        return [c | {"cls": wb.GATE} for c in cs]

    lean = rb.class_stats(
        relabel(rb.planted_cases(base, dsci, beta=1.0)), dsci, k=wb.GATE_K, draws=300
    )
    none = rb.class_stats(
        relabel(rb.planted_cases(base, dsci, beta=0.0)), dsci, k=wb.GATE_K, draws=300
    )
    placebo = stats(0, -0.1, 0.1)
    assert wb.verdict(lean, placebo, on, off)["reading"] == "detection_supported"
    assert wb.verdict(none, placebo, on, off)["reading"] != "detection_supported"
    assert wb.verdict(none, placebo, on, off)["status"] == "CLOSED"
