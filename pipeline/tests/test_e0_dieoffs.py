import datetime as dt
import random

import pytest

from pipeline import e0_dieoffs as e0


def event(
    fips=("01001",),
    start="2012-07-10",
    kind="Mortality/Morbidity",
    diags=None,
    eid=1,
    countries=(30,),
):
    diags = (
        diags
        if diags is not None
        else [
            {
                "major": True,
                "priority": 1,
                "suspect": False,
                "diagnosis_type_string": "Toxin",
            }
        ]
    )
    return {
        "id": eid,
        "event_type_string": kind,
        "start_date": start,
        "administrativelevelones": [{"country": c} for c in countries],
        "administrativeleveltwos": [{"fips_code": f} for f in fips],
        "eventdiagnoses": diags,
    }


def test_a_case_is_one_county_a_dated_mortality_event_with_a_major_diagnosis():
    c, why = e0.to_case(event())
    assert (
        why is None
        and c["fips"] == "01001"
        and c["cls"] == "Toxin"
        and c["start"] == dt.date(2012, 7, 10)
    )
    assert e0.to_case(event(fips=("01001", "01003")))[1] == "multi_county"
    assert e0.to_case(event(kind="Other"))[1] == "not_mortality"
    assert e0.to_case(event(start="2000-06-01"))[1] == "outside_years"
    assert e0.to_case(event(start="2026-01-02"))[1] == "outside_years"
    assert e0.to_case(event(diags=[]))[1] == "no_diagnosis"
    assert (
        e0.to_case(event(fips=(1001,)))[0]["fips"] == "01001"
    )  # numeric FIPS keep their leading zero
    # a Canadian census division ("1005 ", Newfoundland) must not be padded into Barbour County, AL
    assert e0.to_case(event(fips=("1005 ",), countries=(7,)))[1] == "not_us"
    assert e0.to_case(event(countries=(30, 7)))[1] == "not_us"  # straddles the border
    assert e0.to_case(event(countries=()))[1] == "not_us"  # no state recorded
    assert (
        e0.to_case(event(fips=("01005 ", "01005")))[0]["fips"] == "01005"
    )  # a stray space; the same county twice is one county
    assert e0.to_case(event(fips=("ab123",)))[1] == "bad_fips"
    assert e0.to_case(event(fips=("  ",)))[1] == "no_county"


def test_the_major_diagnosis_wins_over_priority_and_suspect_is_kept_for_the_sensitivity_arm():
    diags = [
        {
            "major": False,
            "priority": 1,
            "suspect": False,
            "diagnosis_type_string": "Bacteria",
        },
        {
            "major": True,
            "priority": 2,
            "suspect": True,
            "diagnosis_type_string": "Virus",
        },
    ]
    c, _ = e0.to_case(event(diags=diags))
    assert c["cls"] == "Virus" and c["suspect"] is True
    c, _ = e0.to_case(event(diags=[diags[0]]))
    assert c["cls"] == "Bacteria" and c["suspect"] is False


def weekly(start: dt.date, end: dt.date, f) -> list[dict]:
    """USDM-like rows every Tuesday from `start` with dsci = f(date)."""
    out, d = [], start
    while d <= end:
        out.append({"mapDate": f"{d.isoformat()}T00:00:00", "dsci": f(d)})
        d += dt.timedelta(days=7)
    return out


def test_dsci_takes_the_map_on_or_before_and_refuses_a_stale_one():
    s = e0.Dsci(weekly(dt.date(2012, 1, 3), dt.date(2012, 3, 27), lambda d: d.day))
    assert (
        s.value(dt.date(2012, 1, 3)) == 3
        and s.value(dt.date(2012, 1, 9)) == 3
        and s.value(dt.date(2012, 1, 10)) == 10
    )
    assert s.value(dt.date(2012, 1, 2)) is None  # before the first map
    assert s.value(dt.date(2012, 4, 10)) is None  # last map is 14 days old


def test_case_z_compares_the_same_iso_week_in_neighbouring_years_only():
    # every year is 100 except 2012, which is 300 in every week: the case in 2012 is far above its referents
    s = e0.Dsci(
        weekly(
            dt.date(2000, 1, 4),
            dt.date(2026, 6, 30),
            lambda d: 300 if d.year == 2012 else 100 + (d.year % 3),
        )
    )
    z, why = e0.case_z(dt.date(2012, 7, 10), s)
    assert why is None and z > 50
    flat = e0.Dsci(
        weekly(
            dt.date(2000, 1, 4),
            dt.date(2026, 6, 30),
            lambda d: 300 if d.year == 2012 else 100,
        )
    )
    assert e0.case_z(dt.date(2012, 7, 10), flat) == (None, "referents_flat")
    # a year 5 away is outside +-4: a spike there changes nothing
    far = e0.Dsci(
        weekly(
            dt.date(2000, 1, 4),
            dt.date(2026, 6, 30),
            lambda d: 999 if d.year == 2007 else 100 + (d.year % 3),
        )
    )
    near = e0.Dsci(
        weekly(dt.date(2000, 1, 4), dt.date(2026, 6, 30), lambda d: 100 + (d.year % 3))
    )
    assert e0.case_z(dt.date(2012, 7, 10), far) == e0.case_z(dt.date(2012, 7, 10), near)


def panel(n_counties=60, seed=3):
    """Real-shaped DSCI: each county drifts year to year at random; one series per county."""
    rng = random.Random(seed)
    out = {}
    for i in range(n_counties):
        level = {y: rng.uniform(0, 400) for y in range(2000, 2027)}
        out[f"{i:05d}"] = e0.Dsci(
            weekly(
                dt.date(2000, 1, 4),
                dt.date(2026, 6, 30),
                lambda d, lv=level: lv[d.year],
            )
        )
    return out


def cases_on(dsci, n=4, cls="X"):
    rng = random.Random(9)
    return [
        {
            "id": k,
            "fips": f,
            "start": dt.date(rng.randint(2005, 2021), rng.randint(1, 12), 15),
            "cls": cls,
            "suspect": False,
        }
        for k, f in enumerate(f for f in dsci for _ in range(n))
    ]


def test_planted_drought_effect_is_recovered_and_no_effect_gives_a_ci_through_zero():
    dsci = panel()
    base = cases_on(dsci)
    on = e0.class_stats(e0.planted_cases(base, dsci, beta=3.0), dsci, draws=400)
    off = e0.class_stats(e0.planted_cases(base, dsci, beta=0.0), dsci, draws=400)
    r_on, r_off = (
        next(iter(on["classes"].values())),
        next(iter(off["classes"].values())),
    )
    assert r_on["ci"][0] > 0 and r_on["mean_z"] > 0.3
    assert not e0.excludes_zero(r_off["ci"])
    assert r_on["cases"] == r_off["cases"] == len(base)


def test_the_placebo_shift_moves_every_case_26_weeks():
    dsci = {
        "00001": e0.Dsci(
            weekly(
                dt.date(2000, 1, 4),
                dt.date(2026, 6, 30),
                lambda d: (400 if d.month in (1, 2) else 0) + (d.year % 5),
            )
        )
    }
    c = [
        {
            "id": 1,
            "fips": "00001",
            "start": dt.date(2012, 7, 10),
            "cls": "X",
            "suspect": False,
        }
    ]
    real = e0.class_stats(c * 3, dsci, draws=50)["classes"]["X"]["mean_z"]
    shifted = e0.class_stats(c * 3, dsci, shift_weeks=26, draws=50)["classes"]["X"][
        "mean_z"
    ]
    assert real == pytest.approx(e0.case_z(dt.date(2012, 7, 10), dsci["00001"])[0])
    assert shifted == pytest.approx(e0.case_z(dt.date(2013, 1, 8), dsci["00001"])[0])


def stats(classes):
    return {"classes": classes, "dropped": {}, "level": 0.99}


def r(cases, lo, hi):
    return {"cases": cases, "counties": 10, "mean_z": (lo + hi) / 2, "ci": [lo, hi]}


def test_verdict_needs_the_planted_truth_and_a_quiet_trauma_and_a_quiet_placebo():
    planted_on, planted_off = (
        stats({"p": r(100, 0.2, 0.5)}),
        stats({"p": r(100, -0.1, 0.1)}),
    )
    real = stats(
        {
            "Toxin": r(80, 0.1, 0.4),
            "Trauma": r(90, -0.1, 0.1),
            "Virus": r(70, 0.05, 0.3),
            "Fungus": r(10, 0.5, 0.9),
        }
    )
    placebo = stats(
        {
            "Toxin": r(80, -0.1, 0.1),
            "Trauma": r(90, -0.1, 0.1),
            "Virus": r(70, 0.01, 0.2),
        }
    )
    v = e0.verdict(real, placebo, planted_on, planted_off)
    assert v["status"] == "CLOSED" and v["findings"] == [
        "Toxin"
    ]  # Virus also moves at the placebo; Fungus < 50 cases
    assert v["tested"] == ["Toxin", "Trauma", "Virus"]
    loud = stats(real["classes"] | {"Trauma": r(90, 0.05, 0.2)})
    assert e0.verdict(loud, placebo, planted_on, planted_off)["status"] == "VOID"
    assert e0.verdict(loud, placebo, planted_on, planted_off)["findings"] == []
    blind = stats({"p": r(100, -0.1, 0.3)})
    assert e0.verdict(real, placebo, blind, planted_off)["status"] == "VOID"
    no_trauma = stats({c: v for c, v in real["classes"].items() if c != "Trauma"})
    assert e0.verdict(no_trauma, placebo, planted_on, planted_off)["status"] == "VOID"
    seeing_things = stats(
        {"p": r(100, 0.05, 0.2)}
    )  # the no-effect plant reads an effect: the method invents one
    assert e0.verdict(real, placebo, planted_on, seeing_things)["status"] == "VOID"


def test_the_ci_widens_with_the_number_of_classes_tested():
    dsci = panel()
    cases = e0.planted_cases(cases_on(dsci), dsci, beta=1.0)
    one = e0.class_stats(cases, dsci, k=1, draws=1000)
    eight = e0.class_stats(cases, dsci, k=8, draws=1000)
    a, b = (
        next(iter(one["classes"].values()))["ci"],
        next(iter(eight["classes"].values()))["ci"],
    )
    assert one["level"] == 0.95 and eight["level"] == pytest.approx(1 - 0.05 / 8)
    assert b[0] < a[0] and b[1] > a[1]


def test_a_dropped_route_is_retried_an_http_error_is_not_and_the_last_failure_names_the_fetch():
    import urllib.error

    calls, waits = [], []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise urllib.error.URLError(OSError(101, "Network is unreachable"))
        return [{"ok": 1}]

    assert e0._with_retries(flaky, "USDM 01001", sleep=waits.append) == [{"ok": 1}]
    assert len(calls) == 3 and waits == [5.0, 10.0]

    def down():
        raise urllib.error.URLError(OSError(101, "Network is unreachable"))

    with pytest.raises(RuntimeError, match="USDM 01001: 6 tries failed"):
        e0._with_retries(down, "USDM 01001", sleep=lambda s: None)

    def http500():
        calls.append(1)
        raise urllib.error.HTTPError("u", 500, "boom", {}, None)

    calls.clear()
    with pytest.raises(urllib.error.HTTPError):
        e0._with_retries(http500, "USDM 01001", sleep=lambda s: None)
    assert len(calls) == 1


def test_fetch_dsci_goes_through_the_web_opener_caches_and_keeps_an_empty_answer(
    tmp_path, monkeypatch
):
    import io
    import json as _json
    import urllib.request

    asked = []

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake(req, timeout=None):
        asked.append(req.full_url)
        body = (
            b"[]"
            if "02261" in req.full_url
            else _json.dumps([{"mapDate": "2012-01-03T00:00:00", "dsci": 7}]).encode()
        )
        return Resp(body)

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    assert e0.fetch_dsci("01001", tmp_path, sleep=0) == [
        {"mapDate": "2012-01-03T00:00:00", "dsci": 7}
    ]
    assert (
        e0.fetch_dsci("01001", tmp_path, sleep=0)[0]["dsci"] == 7 and len(asked) == 1
    )  # second call from cache
    assert (
        e0.fetch_dsci("02261", tmp_path, sleep=0) == []
        and (tmp_path / "dsci_02261.json").read_text() == "[]"
    )
    assert "aoi=01001" in asked[0] and asked[0].startswith(
        "https://usdmdataservices.unl.edu/"
    )
