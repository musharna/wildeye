from analysis.s3_year_vs_counting import reading


def r(gap, lo, hi):
    return {"gap": gap, "ci_lo": lo, "ci_hi": hi, "testable": True}


def test_reading_follows_the_note():
    neg, pos, flat = r(-1.0, -1.5, -0.5), r(1.0, 0.5, 1.5), r(0.1, -0.2, 0.4)
    assert reading(neg, pos) == "counting, not year (mixed pixels drive it)"
    assert reading(neg, neg) == "counting, not year (the rest of the method drives it)"
    assert reading(neg, flat) == "counting, not year"
    assert reading(pos, neg) == "year, not counting"
    assert reading(flat, pos) == "unresolved"
    assert reading({**neg, "testable": False}, pos) == "unresolved"
