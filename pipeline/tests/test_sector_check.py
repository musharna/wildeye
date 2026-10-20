import pytest
from pipeline.sector_check import radar_factor, verdict

def test_radar_factor_is_the_median_night_ratio_over_nights_both_have():
    land = {"n1": {"old": 20.0, "new": 4.0}, "n2": {"old": 30.0, "new": 6.0}, "n3": {"old": None, "new": 1.0}, "n4": {"old": 9.0, "new": 2.0}}
    full = {"n1": {"old": 10.0, "new": 2.0}, "n2": {"old": 10.0, "new": 3.0}, "n3": {"old": 5.0, "new": 1.0}, "n4": {"old": 0.0, "new": 1.0}}
    f = radar_factor(land, full)
    assert f["nights"] == 2 and f["old"] == pytest.approx(2.5)        # n3 no land value, n4 full is 0
    assert f["new"] == pytest.approx(2.0)                             # mt: 2, 2, 1, 2 -> median 2 over its own nights

def test_verdict_follows_the_rule_fixed_before_the_run():
    sea = {"A": 0.5, "B": 0.5, "C": 0.5, "D": 0.5, "E": 0.5}          # predicted 2.0, half-way 1.5
    def run(factors):
        return verdict({k: {"old": v} for k, v in zip(sea, factors)}, sea)["verdict"]
    assert run([1.5, 1.6, 2.0, 1.5, 1.0]) == "supported"               # 4 of 5 reach half the predicted rise
    assert run([1.49, 1.6, 2.0, 1.5, 1.0]) == "mixed"
    assert run([1.0, 1.05, 1.09, 0.9, 1.6]) == "falsified"             # 4 of 5 below 1.1
    assert run([1.1, 1.05, 1.09, 0.9, 1.6]) == "mixed"                 # 1.1 is not below 1.1
    v = verdict({"A": {"old": 1.5}}, {"A": 0.5})
    assert v["radars"]["A"]["predicted"] == pytest.approx(2.0) and v["radars"]["A"]["needed"] == pytest.approx(1.5)

def test_main_writes_every_radar_when_one_has_no_common_nights(tmp_path, monkeypatch, capsys):
    """Review of #103: a radar with no usable night pair made the print loop format None and raise before the
    JSON was written, so one empty radar lost all five. It now reads '-' and the others are kept."""
    import json
    import pipeline.sector_check as sc
    def fake_site_nights(root, site, nights):
        val = None if (root.name == "sector" and site["id"] == "KOKX") else (20.0 if root.name == "sector" else 10.0)
        return {"2026-10-16": {"old": val, "new": val}}
    monkeypatch.setattr(sc, "site_nights", fake_site_nights)
    sectors = tmp_path / "sectors.json"
    sectors.write_text(json.dumps({s: {"sea_share": 0.5, "sector": [0, 90]} for s in sc.SECTOR_RADARS}))
    out = tmp_path / "out.json"
    sc.main(["--full-vp", str(tmp_path / "full"), "--sector-vp", str(tmp_path / "sector"), "--sectors", str(sectors),
             "--first-night", "2026-10-16", "--last-night", "2026-10-16", "--out", str(out)])
    doc = json.loads(out.read_text())
    assert doc["verdict"]["radars"]["KOKX"]["factor"] is None and doc["factors"]["KOKX"]["nights"] == 0
    assert all(doc["verdict"]["radars"][s]["factor"] == 2.0 for s in sc.SECTOR_RADARS if s != "KOKX")   # the rest kept
    assert doc["verdict"]["verdict"] == "supported"                       # 4 of 5 reach 1.5
    printed = capsys.readouterr().out
    assert "KOKX sea 0.50 sector [0, 90] factor - (mt -)" in printed and "KMHX sea 0.50 sector [0, 90] factor 2.00" in printed
