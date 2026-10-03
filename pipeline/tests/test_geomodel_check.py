"""Controls for the geomodel harness (docs/superpowers/specs/2026-09-29-geomodel-harness-design.md).

Every control here calls the harness's own estimator and decision rule on planted data, and asserts the
planted SIZE comes back, not only that something was detected.
"""

import datetime as dt
import json
import math

import numpy as np
import pytest
from shapely.geometry import box

from pipeline import geomodel_check as gc

WORLD = (-60.0, -40.0, 60.0, 40.0)  # lon/lat box the synthetic data lives in
RANGE = box(0.0, -10.0, 20.0, 10.0)  # the synthetic "modeled range"


def _points_with_share_inside(rng, n, share_inside):
    """n points in WORLD, exactly round(n * share_inside) of them inside RANGE."""
    k = round(n * share_inside)
    inside = np.column_stack([rng.uniform(0, 20, k), rng.uniform(-10, 10, k)])
    out = []
    while len(out) < n - k:
        p = (rng.uniform(WORLD[0], WORLD[2]), rng.uniform(WORLD[1], WORLD[3]))
        if not (0 <= p[0] <= 20 and -10 <= p[1] <= 10):
            out.append(p)
    return np.vstack([inside, np.array(out).reshape(-1, 2)])


@pytest.mark.parametrize("true_tss", [0.0, 0.2, 0.4, 0.6, 0.8])
def test_planted_tss_comes_back(true_tss):
    rng = np.random.default_rng(int(true_tss * 10))
    background = _points_with_share_inside(rng, 4000, 0.15)
    presences = _points_with_share_inside(rng, 400, 0.15 + true_tss)
    assert gc.tss(RANGE, presences, background) == pytest.approx(true_tss, abs=0.05)


def test_shuffle_null_and_real_signal_separate():
    rng = np.random.default_rng(7)
    background = _points_with_share_inside(rng, 4000, 0.15)
    presences = _points_with_share_inside(rng, 400, 0.75)
    real = gc.tss(RANGE, presences, background)
    shuffled = gc.shuffle_null_tss(RANGE, presences, background, rng)
    assert real == pytest.approx(0.6, abs=0.05)
    assert abs(shuffled) < 0.05


def test_equal_area_baseline_matches_the_range_area():
    rng = np.random.default_rng(3)
    training = np.column_stack([rng.uniform(-50, 50, 60), rng.uniform(-30, 30, 60)])
    target = gc.area_km2(RANGE)
    baseline = gc.equal_area_baseline(training, target)
    assert gc.area_km2(baseline) == pytest.approx(target, rel=0.02)
    # every training point is inside its own buffer; a point far from all of them is not
    assert gc.inside(baseline, training).all()
    assert not gc.inside(baseline, np.array([[179.0, 89.0]])).any()


def test_sign_test():
    assert gc.sign_test_p(wins=20, losses=5) < 0.05
    assert gc.sign_test_p(wins=13, losses=12) > 0.4
    assert gc.sign_test_p(wins=0, losses=0) == 1.0


def _species(model, baseline, n=30):
    return [
        gc.SpeciesResult(
            taxon_id=i,
            name=f"s{i}",
            n_presences=100,
            model_tss=model,
            baseline_tss=baseline,
        )
        for i in range(n)
    ]


def test_group_verdict_flips_between_the_ladder_rungs():
    # the decision rule itself: TSS 0.2 everywhere fails, 0.6 passes, both beating the baseline
    assert gc.group_verdict(_species(0.2, 0.1), skipped={})["verdict"] == "fail"
    assert gc.group_verdict(_species(0.6, 0.1), skipped={})["verdict"] == "pass"
    # a high TSS that does not beat circles around the training records fails
    assert gc.group_verdict(_species(0.6, 0.7), skipped={})["verdict"] == "fail"
    # fewer than 10 scored species is insufficient, not pass, however good they look
    few = gc.group_verdict(_species(0.9, 0.1, n=9), skipped={"too few presences": 21})
    assert few["verdict"] == "insufficient"
    assert few["skipped"] == {"too few presences": 21}


def test_planted_fake_scores_as_effort():
    # a species whose presences are drawn from the background: pure effort, TSS ~ 0 whatever the range
    rng = np.random.default_rng(11)
    background = _points_with_share_inside(rng, 4000, 0.3)
    fake = gc.planted_fake_presences(background, 400, rng)
    assert gc.tss(RANGE, fake, background) < gc.FAKE_TSS_MAX
    # positive control in the same test: real presences concentrated in the range score high
    real = _points_with_share_inside(rng, 400, 0.95)
    assert gc.tss(RANGE, real, background) >= gc.POSITIVE_TSS_MIN


class FakeSources:
    """A group 'Aves' of `n` species whose ranges are RANGE, with known right answers."""

    def __init__(self, n=40, presence_share=0.85, tiles_agree=True, unmatched=0, sparse=0, placement=0.1, inat_down=False, disagree=()):
        self.n, self.share, self.tiles_agree, self.placement = n, presence_share, tiles_agree, placement
        self.inat_down, self.presence_calls = inat_down, 0
        self.backgrounds = []  # groups whose effort background was drawn, in order
        self.disagree, self.tiles_asked = set(disagree), set()  # taxa whose tiles draw nothing; taxa asked for
        self.unmatched, self.sparse = set(range(unmatched)), set(range(unmatched, unmatched + sparse))
        self.verified = False

    def verify(self):
        self.verified = True

    def version(self):
        return "2.34"

    def placement_error(self):
        return self.placement

    def species(self, group):
        return [(i, f"Species {i}") for i in range(self.n)]

    def range_geom(self, group, taxon_id):
        return RANGE

    def range_bounds(self, group, taxon_id):
        return self.range_geom(group, taxon_id).bounds  # LiveSources reads these from the file's headers

    def background(self, group, n, rng):
        self.backgrounds.append(group)
        return _points_with_share_inside(rng, n, 0.15)

    def match(self, name):
        i = int(name.split()[1])
        return None if i in self.unmatched else 1000 + i

    def presences(self, key, rng):
        self.presence_calls += 1
        return _points_with_share_inside(rng, 5 if key - 1000 in self.sparse else 200, self.share)

    def training(self, key, rng):
        # the model's own records sit far from its range, so circles around them do worse than the model
        return np.column_stack([rng.uniform(-55, -45, 50), rng.uniform(25, 35, 50)])

    def tile_mask(self, taxon_id, z, x, y):
        if self.inat_down:
            from pipeline.geomodel_sources import SourceError

            raise SourceError("503 for https://api.inaturalist.org/v2/geomodel/1/3/4/3.png: downtime", 503)
        size = 64
        self.tiles_asked.add(taxon_id)
        agree = self.tiles_agree and taxon_id not in self.disagree
        return gc.range_tile_mask(RANGE, z, x, y, size) if agree else np.zeros((size, size), bool)


def test_run_scores_a_group_and_writes_the_verdicts(tmp_path):
    import json

    out = tmp_path / "verdicts.json"
    # 17 species: 2 with no GBIF match, 3 with too few presences, 12 good. Asking for 13 tries all 17.
    fake = FakeSources(n=17, unmatched=2, sparse=3)
    assert gc.main(["--out", str(out), "--groups", "Aves", "--species-per-group", "13", "--seed", "5"], sources=fake) == 0
    doc = json.loads(out.read_text())
    aves = doc["groups"]["Aves"]
    assert fake.verified and doc["geomodel_version"] == "2.34" and doc["seed"] == 5
    assert aves["month_verdict"] == "pass" and aves["n_scored"] == 12
    # one month of 12 species is not enough evidence to list a collection (ruling 2026-10-02); a second month,
    # read back from the file the first run wrote, is
    w, l = aves["beats_baseline"]["wins"], aves["beats_baseline"]["losses"]
    assert aves["verdict"] == "fail"
    assert aves["evidence"] == {"llr": round(w * math.log(1.2) + l * math.log(0.8), 4), "months": 1}
    argv = ["--out", str(out), "--groups", "Aves", "--species-per-group", "13", "--seed", "6"]
    month_later = lambda: dt.datetime.fromisoformat(doc["generated_at"]) + dt.timedelta(days=31)  # noqa: E731
    assert gc.main(argv, sources=FakeSources(n=17, unmatched=2, sparse=3), now=month_later) == 0
    again = json.loads(out.read_text())["groups"]["Aves"]
    assert again["verdict"] == "pass" and again["evidence"]["months"] == 2
    assert aves["median_tss"] == pytest.approx(0.70, abs=0.06)
    # unscored species are findings with their reason, not silently dropped
    assert aves["skipped"] == {"no exact GBIF species match": 2, "fewer than 30 non-iNaturalist presences": 3}
    c = doc["controls"]["per_group"]["Aves"]
    assert c["fake_tss"] < gc.FAKE_TSS_MAX and c["positive_tss"] >= gc.POSITIVE_TSS_MIN and abs(c["shuffle_tss"]) < 0.05
    assert doc["controls"]["tile_agreement"][0]["iou"] == 1.0
    assert doc["controls"]["effort_placement_error"] == 0.1


def test_a_failed_control_writes_nothing_and_exits_nonzero(tmp_path):
    out = tmp_path / "verdicts.json"
    # iNaturalist's tiles draw nothing where the GeoPackage has a range: what is tested is not what is shown
    assert gc.main(["--out", str(out), "--groups", "Aves", "--species-per-group", "12", "--seed", "5"], sources=FakeSources(tiles_agree=False)) == 2
    assert not out.exists()
    # positive control in the same test: the same run with agreeing tiles writes
    assert gc.main(["--out", str(out), "--groups", "Aves", "--species-per-group", "12", "--seed", "5"], sources=FakeSources()) == 0
    assert out.exists()


def test_a_group_with_too_few_scorable_species_is_insufficient():
    doc = gc.run(FakeSources(n=8), ["Aves"], np.random.default_rng(2), species_per_group=30)
    assert doc["groups"]["Aves"]["verdict"] == "insufficient" and doc["groups"]["Aves"]["n_scored"] == 8


def test_misplaced_effort_tiles_write_nothing(tmp_path):
    out = tmp_path / "verdicts.json"
    # the count tiles put records a cell or more away from GBIF's own search: the background is not effort
    argv = ["--out", str(out), "--groups", "Aves", "--species-per-group", "12", "--seed", "5"]
    assert gc.main(argv, sources=FakeSources(placement=0.9)) == 2
    assert not out.exists()
    # positive control in the same test: tiles within the bar write
    assert gc.main(argv, sources=FakeSources(placement=0.39)) == 0
    assert out.exists()


def test_a_run_reports_progress_as_it_goes(caplog):
    # a monthly run takes hours; jobd kills a job silent for an hour, and a silent run cannot be followed
    import logging

    fake = FakeSources(n=12, unmatched=1)  # asking for 12 of 12 tries every one, the unmatched one too
    with caplog.at_level(logging.INFO, logger="geomodel"):
        gc.run(fake, ["Aves"], np.random.default_rng(2), species_per_group=12)
    lines = [r.getMessage() for r in caplog.records]
    assert any(m.startswith("effort placement error 0.1") for m in lines)
    assert sum(m.startswith("Aves: Species ") for m in lines) == 11  # one line per scored species
    assert any(m.startswith("Aves: skipped Species ") and "no exact GBIF species match" in m for m in lines)
    assert any(m.startswith("Aves: pass (11 scored") for m in lines)


def test_the_inaturalist_check_runs_before_hours_of_gbif_work():
    # iNaturalist's API is the harness's only dependency on it; its downtime must cost seconds, not the run
    from pipeline.geomodel_sources import SourceError

    down = FakeSources(inat_down=True)
    with pytest.raises(SourceError, match="downtime"):
        gc.run(down, ["Aves", "Mammalia"], np.random.default_rng(1), species_per_group=12)
    assert down.presence_calls == 0
    # positive control in the same test: with iNaturalist up, the run goes on to score species
    up = FakeSources()
    gc.run(up, ["Aves", "Mammalia"], np.random.default_rng(1), species_per_group=12)
    assert up.presence_calls >= 24


def test_a_group_failing_its_controls_stops_the_run_before_the_next_group(monkeypatch):
    # each group costs minutes to hours of GBIF work; a run that will write nothing must stop at the first
    # failed control, not score every other group first. The real check_controls runs; Aves gets one more
    # failure on top, as a failed planted fake would give it.
    real = gc.check_controls
    monkeypatch.setattr(
        gc, "check_controls", lambda g, c: real(g, c) + (["Aves: planted fake scored 0.5"] if g == "Aves" else [])
    )
    bad = FakeSources()
    with pytest.raises(gc.ControlFailure, match="Aves: planted fake"):
        gc.run(bad, ["Aves", "Mammalia", "Amphibia"], np.random.default_rng(1), species_per_group=12)
    assert bad.backgrounds == ["Aves"]
    # positive control in the same test: with sound controls every group is scored
    monkeypatch.setattr(gc, "check_controls", real)
    good = FakeSources()
    gc.run(good, ["Aves", "Mammalia", "Amphibia"], np.random.default_rng(1), species_per_group=12)
    assert good.backgrounds == ["Aves", "Mammalia", "Amphibia"]


def test_tile_agreement_is_a_median_over_the_species_checked():
    # Ruling 2026-09-30 (maintainer): every one of 3 species >= 0.85 failed when tiles and GeoPackage agree
    # (5 of 20 random birds scored 0.80-0.83); a real single-species mismatch (Anser cygnoides, 0.03) is
    # step 2's per-species check, not a reason to throw away the run
    groups = ["Aves", "Mammalia"]
    # 5 species in each of 2 groups: all 10 are checked. Taxon 0 draws nothing, in both groups.
    two_off = FakeSources(n=5, disagree={0})
    doc = gc.run(two_off, groups, np.random.default_rng(3), species_per_group=5)
    checked = doc["controls"]["tile_agreement"]
    assert len(checked) == 10 and len({(a["group"], a["species"]) for a in checked}) == 10
    assert sorted(a["iou"] for a in checked)[:3] == [0.0, 0.0, 1.0]  # the two misses are recorded, and pass
    # six of ten drawing nothing fails the run before any scoring
    most_off = FakeSources(n=5, disagree={0, 1, 2})
    with pytest.raises(gc.ControlFailure, match="median IoU"):
        gc.run(most_off, groups, np.random.default_rng(3), species_per_group=5)
    assert most_off.presence_calls == 0
    # a one-group run still checks the full count (26), as its only group has the species for it
    solo = FakeSources()
    gc.run(solo, ["Aves"], np.random.default_rng(3), species_per_group=12)
    assert len(solo.tiles_asked) == gc.TILE_AGREEMENT_SPECIES == 26


def test_tile_agreement_checks_two_species_in_every_collection():
    # Ruling 2026-10-02 (maintainer): 10 species, one in each of 10 collections, failed a healthy month about
    # 2.7% of the time (Oct 1: median 0.8247, reproduced exactly with that day's tiles); measured on 129
    # random species over all 13 collections, 26 species (two in each) fail 0.85 about 0.15% of the time
    groups = [f"Group{i:02d}" for i in range(13)]
    for seed in range(20):
        checked = gc.check_tile_agreement(FakeSources(n=40), groups, np.random.default_rng(seed))
        per = {g: sum(a["group"] == g for a in checked) for g in groups}
        assert len(checked) == 26 and set(per.values()) == {2}
        assert len({(a["group"], a["species"]) for a in checked}) == 26  # never the same species twice
    # positive control in the same test: a failing median still stops the run
    with pytest.raises(gc.ControlFailure, match="median IoU"):
        gc.check_tile_agreement(FakeSources(n=40, tiles_agree=False), groups, np.random.default_rng(0))


def test_each_run_gets_its_own_work_dir_and_removes_only_that(tmp_path):
    # the monthly check and the species listing (or two listings) can overlap; one finishing must not delete the other's ranges
    with gc.run_workdir(tmp_path) as a:
        with gc.run_workdir(tmp_path) as b:
            assert a != b and a.parent == tmp_path and b.parent == tmp_path
            (a / "x.gpkg").write_text("a")
            (b / "y.gpkg").write_text("b")
        assert not b.exists()
        assert (a / "x.gpkg").exists()
    assert not a.exists() and tmp_path.exists()
    with gc.run_workdir(tmp_path, keep=True) as kept:
        pass
    assert kept.exists()


# ---- evidence across months (spec, ruling 2026-10-02) ----------------------------------------------


def _rows(wins, losses, median=0.7, ties=0):
    """Species with model TSS `median` that beat the baseline `wins` times and lose `losses` times."""
    gaps = [-0.1] * wins + [0.1] * losses + [0.0] * ties
    return [gc.SpeciesResult(i, f"s{i}", 100, median, round(median + d, 4)) for i, d in enumerate(gaps)]


def _month(wins, losses, median=0.7):
    return gc.group_verdict(_rows(wins, losses, median), skipped={})


def test_evidence_on_the_real_september_and_october_counts():
    # wins-losses of the Sept 30 run and the held Oct 2 run (jobd 5213). One month's sign test listed four new
    # collections in October; evidence carried from September lists two of them and holds fish and plants
    real = {
        "Arachnida": ((22, 6), (22, 8)),
        "Insecta": ((19, 11), (22, 8)),
        "Mollusca": ((18, 12), (23, 7)),
        "Actinopterygii": ((14, 16), (22, 8)),
        "Plantae": ((18, 12), (20, 10)),
        "Mammalia": ((18, 11), (18, 11)),
        "Aves": ((17, 13), (13, 17)),
    }
    listed, month_passed = set(), set()
    for group, (sep, octo) in real.items():
        first = gc.carry_evidence(_month(*sep), None)
        assert first["verdict"] == "fail", group  # September alone lists nothing (Arachnida 22-6: 2.67 < 2.89)
        second = gc.carry_evidence(_month(*octo), first)
        listed |= {group} if second["verdict"] == "pass" else set()
        month_passed |= {group} if second["month_verdict"] == "pass" else set()
    assert listed == {"Arachnida", "Insecta", "Mollusca"}
    assert month_passed == {"Arachnida", "Insecta", "Mollusca", "Actinopterygii", "Plantae"}


def test_evidence_lists_only_on_a_month_whose_median_tss_clears_the_bar():
    weak = gc.carry_evidence(_month(28, 2, median=0.3), None)
    assert weak["verdict"] == "fail" and weak["evidence"]["llr"] >= gc.LIST_AT
    # positive control in the same test: the same wins at a median of 0.7 list in one month
    strong = gc.carry_evidence(_month(28, 2, median=0.7), None)
    assert strong["verdict"] == "pass" and strong["evidence"]["llr"] >= gc.LIST_AT


def test_a_listed_group_survives_a_losing_month_and_drops_on_sustained_losses():
    group = None
    for _ in range(4):
        group = gc.carry_evidence(_month(28, 2), group)
    assert group["evidence"]["llr"] == pytest.approx(gc.EVIDENCE_CAP, abs=1e-4)  # capped, so it can still drop
    group = gc.carry_evidence(_month(10, 20), group)
    # one losing month: the month's own sign test fails, the group stays listed
    assert group["month_verdict"] == "fail" and group["verdict"] == "pass"
    months = 1
    while group["verdict"] == "pass":
        group = gc.carry_evidence(_month(10, 20), group)
        months += 1
        assert months < 10
    # 5.89 → 3.25 → 0.61 → -2.03 → -4.67: dropped on the fourth losing month, evidence starts over
    assert months == 4 and group["evidence"]["llr"] == 0.0


def test_doubt_is_floored_so_a_collection_that_improves_can_still_list():
    group = None
    for _ in range(6):
        group = gc.carry_evidence(_month(5, 25), group)
    assert group["verdict"] == "fail"
    assert group["evidence"]["llr"] == pytest.approx(gc.DROP_AT, abs=1e-4)  # not 6 months of banked doubt
    group = gc.carry_evidence(_month(24, 6), group)
    assert group["verdict"] == "fail"
    group = gc.carry_evidence(_month(24, 6), group)
    assert group["verdict"] == "pass"


def test_an_insufficient_month_leaves_the_evidence_alone():
    listed = gc.carry_evidence(_month(28, 2), None)
    thin = gc.carry_evidence(gc.group_verdict(_rows(9, 0), skipped={}), listed)
    assert thin["month_verdict"] == "insufficient"
    assert thin["verdict"] == "pass" and thin["evidence"] == listed["evidence"]
    # positive control in the same test: with no listing to keep, an insufficient month is insufficient
    assert gc.carry_evidence(gc.group_verdict(_rows(9, 0), skipped={}), None)["verdict"] == "insufficient"


def _doc(generated_at, version="2.34", **groups):
    out = {}
    for name, (wins, losses) in groups.items():
        rows = _rows(wins, losses)
        out[name] = {**gc.group_verdict(rows, skipped={}), "species": [r.__dict__ for r in rows]}
    return {
        "generated_at": generated_at,
        "seed": 1,
        "geomodel_version": version,
        "spec": "x",
        "thresholds": {},
        "groups": out,
        "controls": {},
    }


def test_prior_evidence_comes_only_from_an_earlier_file_on_the_same_model():
    sep = _doc("2026-09-30T17:32:03+00:00", Insecta=(22, 8))
    # a file from before the evidence rule counts as one month: its own species rows are replayed
    got = gc.prior_evidence(sep, "2.34", "2026-10-02T18:48:00+00:00")
    assert got["Insecta"]["evidence"] == {"llr": round(22 * math.log(1.2) + 8 * math.log(0.8), 4), "months": 1}
    # another model version: what was learnt about the old ranges does not carry
    assert gc.prior_evidence(sep, "2.35", "2026-10-02T18:48:00+00:00") == {}
    assert gc.prior_evidence(None, "2.34", "2026-10-02T18:48:00+00:00") == {}
    # the same run as its own prior would count one month twice
    with pytest.raises(gc.EvidenceError, match="not earlier"):
        gc.prior_evidence(sep, "2.34", "2026-09-30T17:32:03+00:00")


def test_rejudge_judges_a_saved_run_against_an_earlier_file_without_gbif_work(tmp_path):
    # the October run was held when the rule changed: its saved species rows are judged again
    sep, octo = tmp_path / "sep.json", tmp_path / "oct.json"
    sep.write_text(json.dumps(_doc("2026-09-30T17:32:03+00:00", Insecta=(19, 11), Plantae=(18, 12))))
    octo.write_text(json.dumps(_doc("2026-10-02T18:48:00+00:00", Insecta=(22, 8), Plantae=(20, 10))))
    out = tmp_path / "verdicts.json"
    assert gc.main(["--rejudge", str(octo), "--prior", str(sep), "--out", str(out)]) == 0
    doc = json.loads(out.read_text())
    assert doc["generated_at"] == "2026-10-02T18:48:00+00:00" and doc["seed"] == 1
    assert doc["groups"]["Insecta"]["verdict"] == "pass" and doc["groups"]["Plantae"]["verdict"] == "fail"
    assert doc["groups"]["Plantae"]["month_verdict"] == "pass"
    assert doc["thresholds"]["evidence"]["edge"] == 0.6
    # a run judged against itself is refused, and nothing is written
    twice = tmp_path / "twice.json"
    with pytest.raises(gc.EvidenceError, match="not earlier"):
        gc.main(["--rejudge", str(octo), "--prior", str(octo), "--out", str(twice)])
    assert not twice.exists()


@pytest.mark.parametrize(
    "flag", [["--groups", "Aves"], ["--seed", "3"], ["--species-per-group", "12"]]
)
def test_rejudge_refuses_the_flags_of_a_run(tmp_path, capsys, flag):
    # review of PR #36: `--rejudge FILE --groups Aves` judged and wrote every collection in FILE, the flag silently
    # unused; a re-judge takes its collections, seed and species from the saved run, so a run flag is an error
    sep, octo = tmp_path / "sep.json", tmp_path / "oct.json"
    sep.write_text(json.dumps(_doc("2026-09-30T17:32:03+00:00", Insecta=(19, 11))))
    octo.write_text(json.dumps(_doc("2026-10-02T18:48:00+00:00", Insecta=(22, 8))))
    out = tmp_path / "verdicts.json"
    with pytest.raises(SystemExit) as exc:
        gc.main(["--rejudge", str(octo), "--prior", str(sep), "--out", str(out), *flag])
    assert exc.value.code == 2 and f"{flag[0]} does not apply to --rejudge" in capsys.readouterr().err
    assert not out.exists()
    # positive control in the same test: without the run flag the re-judge writes
    assert gc.main(["--rejudge", str(octo), "--prior", str(sep), "--out", str(out)]) == 0
    assert out.exists()
