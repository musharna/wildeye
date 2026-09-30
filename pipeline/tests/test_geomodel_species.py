"""The per-species list the species card reads (spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md)."""

import json

from pipeline import geomodel_species as gsp
from pipeline.geomodel_sources import GROUPS, SourceError
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


def _run(tmp_path, fake, verdicts):
    out = tmp_path / "species.json"
    code = gsp.main(["--verdicts", str(verdicts), "--out", str(out)], sources=fake)
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
    assert doc["species"]["Species 0"] == {"id": 0, "group": "Arachnida", "iou": 1.0}
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
