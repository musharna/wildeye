"""The per-species list the species card reads (spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md)."""

import json

import numpy as np
import pytest
from shapely.geometry import box

from pipeline import geomodel_species as gsp
from pipeline.geomodel_sources import GROUPS, SourceError
from pipeline import geomodel_check as gc
from pipeline.tests.test_geomodel_check import FakeSources


class ListingFakes(FakeSources):
    """FakeSources that records which collections were listed and can fail the tiles of some taxa."""

    def __init__(self, *, failing_tiles=(), **kw):
        super().__init__(**kw)
        self.listed, self.failing_tiles = [], set(failing_tiles)

    def species(self, group):
        self.listed.append(group)
        return super().species(group)

    def tile_mask(self, taxon_id, z, x, y):
        if taxon_id in self.failing_tiles:
            raise SourceError(f"HTTP 500 for tile {taxon_id}/{z}/{x}/{y}", 500)
        return super().tile_mask(taxon_id, z, x, y)


def _verdicts(tmp_path, version="2.34", **verdicts):
    path = tmp_path / "verdicts.json"
    path.write_text(
        json.dumps(
            {
                "generated_at": "2026-09-30T17:32:10+00:00",
                "geomodel_version": version,
                "groups": {g: {"verdict": v} for g, v in verdicts.items()},
            }
        )
    )
    return path


def _run(tmp_path, fake, verdicts, *args):
    out = tmp_path / "species.json"
    code = gsp.main(["--verdicts", str(verdicts), "--out", str(out), *args], sources=fake)
    return code, out


def test_every_species_of_a_passing_collection_is_listed_with_its_tile_iou(tmp_path):
    fake = ListingFakes(n=4, disagree={1})
    code, out = _run(
        tmp_path,
        fake,
        _verdicts(tmp_path, Arachnida="pass", Aves="fail", Fungi="insufficient"),
    )
    assert code == 0
    doc = json.loads(out.read_text())
    assert fake.listed == ["Arachnida"]  # a failing collection costs no tile requests
    assert doc["species"]["Species 0"] == {"id": 0, "group": "Arachnida", "iou": 1.0, "check": "full"}
    assert (
        doc["species"]["Species 1"]["iou"] == 0.0
    )  # tiles that draw nothing where the range is
    assert set(doc["species"]) == {f"Species {i}" for i in range(4)}
    assert doc["species_iou_min"] == 0.70
    assert doc["geomodel_version"] == "2.34"
    assert doc["verdicts_generated_at"] == "2026-09-30T17:32:10+00:00"
    assert {g: v["verdict"] for g, v in doc["groups"].items()} == {
        "Arachnida": "pass",
        "Aves": "fail",
        "Fungi": "insufficient",
    }
    # the browser places a GBIF taxon in its collection from these keys
    assert doc["groups"]["Aves"]["include"] == sorted(GROUPS["Aves"]["include"])
    assert doc["groups"]["Aves"]["exclude"] == []


def test_the_browser_gets_exclude_keys_where_a_collection_has_them(tmp_path):
    fake = ListingFakes(n=1)
    code, out = _run(tmp_path, fake, _verdicts(tmp_path, OtherAnimalia="fail"))
    assert code == 0
    doc = json.loads(out.read_text())
    assert doc["groups"]["OtherAnimalia"]["exclude"] == sorted(
        GROUPS["OtherAnimalia"]["exclude"]
    )
    assert doc["groups"]["OtherAnimalia"][
        "exclude"
    ]  # non-empty: fish, insects, birds... are taken out
    assert doc["species"] == {} and fake.tiles_asked == set()


def test_a_species_whose_tiles_fail_is_listed_unchecked_and_the_run_exits_3(tmp_path):
    fake = ListingFakes(n=3, failing_tiles={2})
    code, out = _run(tmp_path, fake, _verdicts(tmp_path, Arachnida="pass"))
    assert code == 3
    doc = json.loads(out.read_text())  # written anyway: the other species are good
    assert doc["species"]["Species 2"]["iou"] is None
    assert doc["species"]["Species 0"]["iou"] == 1.0
    assert doc["unchecked"] == 1


def test_a_model_version_other_than_the_verdicts_writes_nothing(tmp_path):
    fake = ListingFakes(n=3)
    code, out = _run(
        tmp_path, fake, _verdicts(tmp_path, version="2.33", Arachnida="pass")
    )
    assert code == 2
    assert not out.exists()
    assert fake.tiles_asked == set()
    # positive control: the same verdicts at the live version do list
    code, out = _run(
        tmp_path,
        ListingFakes(n=3),
        _verdicts(tmp_path, version="2.34", Arachnida="pass"),
    )
    assert code == 0 and out.exists()


def test_a_name_listed_twice_stops_before_any_tile(tmp_path):
    class Twice(ListingFakes):
        def species(self, group):
            return [(1, "Species 1"), (2, "Species 1")]

    fake = Twice()
    code, out = _run(tmp_path, fake, _verdicts(tmp_path, Arachnida="pass"))
    assert code == 2
    assert not out.exists() and fake.tiles_asked == set()


def test_a_second_run_checks_only_what_the_last_run_of_the_same_model_left(tmp_path):
    verdicts = _verdicts(tmp_path, Arachnida="pass")
    first = ListingFakes(n=4, failing_tiles={3})
    code, out = _run(tmp_path, first, verdicts)
    assert code == 3 and first.tiles_asked == {0, 1, 2}
    second = ListingFakes(n=4)
    code, out = _run(tmp_path, second, verdicts)
    assert code == 0
    assert second.tiles_asked == {3}  # 0-2 reused from the last list
    assert json.loads(out.read_text())["species"]["Species 3"]["iou"] == 1.0
    # positive control: a list from another model version is not reused
    doc = json.loads(out.read_text())
    doc["geomodel_version"] = "2.33"
    out.write_text(json.dumps(doc))
    third = ListingFakes(n=4)
    assert _run(tmp_path, third, verdicts)[0] == 0
    assert third.tiles_asked == {0, 1, 2, 3}


class Killed(BaseException):
    """A timeout or SIGTERM stand-in: nothing in the listing catches it."""


def test_progress_is_written_as_it_goes_so_a_killed_run_keeps_it(tmp_path, monkeypatch):
    monkeypatch.setattr(gsp, "CHECKPOINT_EVERY", 2)

    class KilledAt4(ListingFakes):
        def tile_mask(self, taxon_id, z, x, y):
            if taxon_id == 4:
                raise Killed()
            return super().tile_mask(taxon_id, z, x, y)

    with pytest.raises(Killed):
        _run(tmp_path, KilledAt4(n=6), _verdicts(tmp_path, Arachnida="pass"))
    doc = json.loads((tmp_path / "species.json").read_text())
    # every species is named from the first write, so an unchecked one reads "couldn't be checked", not "not in the model"
    assert set(doc["species"]) == {f"Species {i}" for i in range(6)}
    assert [doc["species"][f"Species {i}"]["iou"] for i in range(6)] == [1.0, 1.0, 1.0, 1.0, None, None]
    assert doc["unchecked"] == 2


def test_a_run_killed_on_its_first_species_already_names_them_all(tmp_path):
    class KilledAt0(ListingFakes):
        def tile_mask(self, taxon_id, z, x, y):
            raise Killed()

    with pytest.raises(Killed):
        _run(tmp_path, KilledAt0(n=3), _verdicts(tmp_path, Arachnida="pass"))
    doc = json.loads((tmp_path / "species.json").read_text())
    assert {n: s["iou"] for n, s in doc["species"].items()} == {"Species 0": None, "Species 1": None, "Species 2": None}
    assert doc["unchecked"] == 3


# Skim, then full (spec: "Skim first"): one tile per species tonight, every tile over the following days.
SKIM_RANGE = box(0.0, -5.0, 20.0, 30.0)  # z3 tiles 4/3 (lat 0-41, most of the range) and 4/4 (lat -41-0, the 5-degree sliver)


class TileLog(ListingFakes):
    """Every tile asked, in order; `wrong_tile` draws nothing there (a served map that differs only in part)."""

    def __init__(self, *, wrong_tile=None, **kw):
        super().__init__(**kw)
        self.calls, self.wrong_tile = [], wrong_tile

    def range_geom(self, group, taxon_id):
        return SKIM_RANGE

    def tile_mask(self, taxon_id, z, x, y):
        self.calls.append((taxon_id, z, x, y))
        if taxon_id in self.failing_tiles:
            raise SourceError(f"HTTP 500 for tile {taxon_id}/{z}/{x}/{y}", 500)
        if taxon_id in self.disagree or (x, y) == self.wrong_tile:
            return np.zeros((64, 64), bool)
        return gc.range_tile_mask(SKIM_RANGE, z, x, y, 64)


def test_skim_asks_one_tile_per_species_the_one_holding_most_of_the_range(tmp_path):
    verdicts = _verdicts(tmp_path, Arachnida="pass")
    fake = TileLog(n=3, disagree={1})
    code, out = _run(tmp_path, fake, verdicts, "--mode", "skim")
    assert code == 0
    assert fake.calls == [(0, 3, 4, 3), (1, 3, 4, 3), (2, 3, 4, 3)]
    doc = json.loads(out.read_text())
    assert doc["species"]["Species 0"] == {"id": 0, "group": "Arachnida", "iou": 1.0, "check": "skim", "iou_skim": 1.0}
    assert doc["species"]["Species 1"]["iou"] == 0.0  # a served map that misses the range fails on its one tile
    # positive control: the full check asks both tiles of the range
    full = TileLog(n=1)
    gsp.main(["--verdicts", str(verdicts), "--out", str(tmp_path / "full.json")], sources=full)
    assert full.calls == [(0, 3, 4, 3), (0, 3, 4, 4)]


def test_the_full_pass_upgrades_skims_keeps_the_skim_score_and_skips_full_checks(tmp_path):
    verdicts = _verdicts(tmp_path, Arachnida="pass")
    _run(tmp_path, TileLog(n=2, wrong_tile=(4, 4)), verdicts, "--mode", "skim")
    full = TileLog(n=2, wrong_tile=(4, 4))
    code, out = _run(tmp_path, full, verdicts)
    assert code == 0
    assert full.calls == [(0, 3, 4, 3), (0, 3, 4, 4), (1, 3, 4, 3), (1, 3, 4, 4)]
    s0 = json.loads(out.read_text())["species"]["Species 0"]
    # the skim saw only the agreeing tile; the full check sees the part that differs
    assert s0["check"] == "full" and s0["iou_skim"] == 1.0 and s0["iou"] < 1.0
    again = TileLog(n=2)
    assert _run(tmp_path, again, verdicts)[0] == 0
    assert again.calls == []  # nothing left to check in full
    skim = TileLog(n=2)
    _run(tmp_path, skim, verdicts, "--mode", "skim")
    assert skim.calls == []  # a skim never re-checks, or overwrites, a full check
    assert json.loads(out.read_text())["species"]["Species 0"] == s0


def test_entries_written_before_check_kinds_count_as_full(tmp_path):
    verdicts = _verdicts(tmp_path, Arachnida="pass")
    out = tmp_path / "species.json"
    out.write_text(json.dumps({"geomodel_version": "2.34", "species": {
        "Species 0": {"id": 0, "group": "Arachnida", "iou": 0.91},
        "Species 1": {"id": 1, "group": "Arachnida", "iou": None},
    }}))
    fake = TileLog(n=2)
    assert _run(tmp_path, fake, verdicts)[0] == 0
    assert [c[0] for c in fake.calls] == [1, 1]  # only the unchecked one
    doc = json.loads(out.read_text())["species"]
    assert doc["Species 0"] == {"id": 0, "group": "Arachnida", "iou": 0.91, "check": "full"}
    assert doc["Species 1"]["check"] == "full"


def test_calibration_skims_fully_checked_species_without_changing_their_verdict(tmp_path):
    verdicts = _verdicts(tmp_path, Arachnida="pass")
    _run(tmp_path, TileLog(n=2, wrong_tile=(4, 4)), verdicts)
    before = json.loads((tmp_path / "species.json").read_text())["species"]
    cal = TileLog(n=2, wrong_tile=(4, 4))
    assert _run(tmp_path, cal, verdicts, "--mode", "skim", "--include-full")[0] == 0
    assert cal.calls == [(0, 3, 4, 3), (1, 3, 4, 3)]
    after = json.loads((tmp_path / "species.json").read_text())["species"]
    for name in before:
        assert after[name]["iou"] == before[name]["iou"] and after[name]["check"] == "full"
        assert after[name]["iou_skim"] == 1.0


def test_a_tile_budget_stops_before_going_over_and_the_next_run_goes_on(tmp_path):
    verdicts = _verdicts(tmp_path, Arachnida="pass")
    first = TileLog(n=5)
    code, out = _run(tmp_path, first, verdicts, "--max-tiles", "5")
    assert code == 3  # species left unchecked
    assert len(first.calls) == 4  # two species of two tiles; a third would make 6
    doc = json.loads(out.read_text())
    assert [doc["species"][f"Species {i}"]["iou"] for i in range(5)] == [1.0, 1.0, None, None, None]
    second = TileLog(n=5)
    assert _run(tmp_path, second, verdicts, "--max-tiles", "100")[0] == 0
    assert sorted({c[0] for c in second.calls}) == [2, 3, 4]
    skim = TileLog(n=5)
    code = gsp.main(["--verdicts", str(verdicts), "--out", str(tmp_path / "skim.json"), "--mode", "skim", "--max-tiles", "2"], sources=skim)
    assert code == 3 and len(skim.calls) == 2


def test_only_limits_which_species_are_checked_and_the_list_still_names_all(tmp_path):
    verdicts = _verdicts(tmp_path, Arachnida="pass")
    names = tmp_path / "names.txt"
    names.write_text("Species 1\nSpecies 3\n")
    fake = TileLog(n=4)
    code, out = _run(tmp_path, fake, verdicts, "--mode", "skim", "--only", str(names))
    assert code == 3  # species 0 and 2 are still unchecked
    assert [c[0] for c in fake.calls] == [1, 3]
    doc = json.loads(out.read_text())["species"]
    assert set(doc) == {f"Species {i}" for i in range(4)}
    assert doc["Species 0"]["iou"] is None and doc["Species 1"]["check"] == "skim"
    names.write_text("Species 9\n")  # a name not in the passing collections is an error, not a silent no-op
    with pytest.raises(SystemExit):
        _run(tmp_path, TileLog(n=4), verdicts, "--mode", "skim", "--only", str(names))


def test_the_full_check_takes_the_cheapest_species_first_so_a_budget_covers_the_most(tmp_path):
    big = box(0.0, -5.0, 100.0, 30.0)  # 3 x 2 = 6 z3 tiles; SKIM_RANGE is 2

    class Sized(TileLog):
        def range_geom(self, group, taxon_id):
            return big if taxon_id == 0 else SKIM_RANGE

        def tile_mask(self, taxon_id, z, x, y):
            self.calls.append((taxon_id, z, x, y))
            return gc.range_tile_mask(self.range_geom(None, taxon_id), z, x, y, 64)

    verdicts = _verdicts(tmp_path, Arachnida="pass")
    fake = Sized(n=3)
    code, out = _run(tmp_path, fake, verdicts, "--max-tiles", "4")
    assert code == 3
    assert sorted({c[0] for c in fake.calls}) == [1, 2]  # the two 2-tile species, not the 6-tile one listed first
    doc = json.loads(out.read_text())["species"]
    assert doc["Species 0"]["iou"] is None and doc["Species 1"]["check"] == "full"
    rest = Sized(n=3)
    assert _run(tmp_path, rest, verdicts, "--max-tiles", "6")[0] == 0
    assert {c[0] for c in rest.calls} == {0}  # positive control: the big one is checked when the budget allows


def test_a_daily_budget_counts_the_tiles_runs_asked_in_the_last_24_hours(tmp_path):
    import datetime as dt

    verdicts = _verdicts(tmp_path, Arachnida="pass")
    t0 = dt.datetime(2026, 10, 1, 23, 0, tzinfo=dt.timezone.utc)

    def run(fake, at):
        out = tmp_path / "species.json"
        args = ["--verdicts", str(verdicts), "--out", str(out), "--max-tiles-per-day", "6"]
        return gsp.main(args, sources=fake, now=lambda: at)

    first = TileLog(n=6)
    assert run(first, t0) == 3 and len(first.calls) == 6  # 3 species of 2 tiles
    log_ = json.loads((tmp_path / "species.json").read_text())["tile_log"]
    assert log_ == [{"at": "2026-10-01T23:00:00+00:00", "tiles": 6}]
    soon = TileLog(n=6)
    assert run(soon, t0 + dt.timedelta(hours=23)) == 3
    assert soon.calls == []  # the day's 6 are spent: a rerun or an early cron asks nothing
    later = TileLog(n=6)
    assert run(later, t0 + dt.timedelta(hours=24, minutes=1)) == 0
    assert len(later.calls) == 6  # positive control: a day on, the budget is back
    log_ = json.loads((tmp_path / "species.json").read_text())["tile_log"]
    assert [e["tiles"] for e in log_] == [6, 0, 6]


def test_the_tile_log_survives_a_new_model_version(tmp_path):
    import datetime as dt

    # requests count against iNaturalist's day whatever model they were for
    out = tmp_path / "species.json"
    at = dt.datetime(2026, 10, 1, 12, 0, tzinfo=dt.timezone.utc)
    out.write_text(json.dumps({"geomodel_version": "2.33", "species": {}, "tile_log": [{"at": at.isoformat(), "tiles": 5}]}))
    fake = TileLog(n=3)
    args = ["--verdicts", str(_verdicts(tmp_path, Arachnida="pass")), "--out", str(out), "--max-tiles-per-day", "6"]
    assert gsp.main(args, sources=fake, now=lambda: at + dt.timedelta(hours=1)) == 3
    assert fake.calls == []  # 1 tile left: no 2-tile species fits


def test_the_full_check_decodes_only_the_ranges_it_checks(tmp_path):
    # Ranking by tile cost reads the ranges' bounds; decoding every range first took ~25 silent minutes for the passing
    # collections before the first log line (Arachnida v2.34: 32.7 ms per range, 0.06 s for all 3,544 headers)
    big = box(0.0, -5.0, 100.0, 30.0)  # 6 z3 tiles; SKIM_RANGE is 2

    class Counted(TileLog):
        def __init__(self, **kw):
            super().__init__(**kw)
            self.decoded = []

        def _range(self, taxon_id):
            return big if taxon_id == 0 else SKIM_RANGE

        def range_geom(self, group, taxon_id):
            self.decoded.append(taxon_id)
            return self._range(taxon_id)

        def range_bounds(self, group, taxon_id):
            return self._range(taxon_id).bounds

        def tile_mask(self, taxon_id, z, x, y):
            self.calls.append((taxon_id, z, x, y))
            return gc.range_tile_mask(self._range(taxon_id), z, x, y, 64)

    verdicts = _verdicts(tmp_path, Arachnida="pass")
    fake = Counted(n=3)
    code, out = _run(tmp_path, fake, verdicts, "--max-tiles", "4")
    assert code == 3
    assert sorted(fake.decoded) == [1, 2], "the 6-tile species past the budget is never decoded"
    assert sorted({c[0] for c in fake.calls}) == [1, 2]  # and the cheap two are still checked first
    rest = Counted(n=3)
    assert _run(tmp_path, rest, verdicts, "--max-tiles", "6")[0] == 0
    assert rest.decoded == [0]  # positive control: the big one is decoded when its turn comes
