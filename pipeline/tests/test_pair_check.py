import datetime as dt
import json
from pathlib import Path
import pytest
from pipeline.pair_check import spearman, old_product, pair_stats, verdict, site_nights, PAIRS

FIX = Path(__file__).parent / "fixtures"
UTC = dt.UTC
HDR = "# date   time HGHT    u      v       w     ff    dd  sd_vvp gap dbz     eta   dens   DBZH   n   n_dbz n_all n_dbz_all\n"

def prof(when, dens):
    return HDR + "".join(f"{when:%Y%m%d} {when:%H%M} {h} nan nan nan 5.0 180 2.0 F 0.0 0.0 {d} 0.0 1 1 1 1\n"
                         for h, d in zip((0, 200), dens))

def test_spearman_matches_r_including_ties_and_refuses_what_has_no_rank_order():
    # golden: R 4.3.3 cor(x, y, method = "spearman")
    assert spearman([1, 2, 3, 4, 5, 6], [2, 1, 4, 3, 6, 5]) == pytest.approx(0.828571428571429, abs=1e-12)
    assert spearman([3, 1, 4, 1, 5, 9, 2, 6], [2, 7, 1, 8, 2, 8, 1, 8]) == pytest.approx(0.198853681209925, abs=1e-12)
    assert spearman([0, 0, 10, 20, 20, 5, 7], [1, 0, 3, 30, 25, 4, 9]) == pytest.approx(0.872871560943970, abs=1e-12)
    assert spearman([1, 2], [2, 1]) is None                       # too few nights
    assert spearman([1, 1, 1], [1, 2, 3]) is None                 # a flat series has no order
    with pytest.raises(ValueError, match="3 values against 2"):
        spearman([1, 2, 3], [1, 2])

def test_old_product_is_the_time_weighted_night_mean_of_the_old_density():
    t0 = dt.datetime(2026, 10, 1, 2, 0, tzinfo=UTC)
    ps = [(t0, prof(t0, (10.0, 20.0))),                                         # mean 15, stands for 5 min
          (t0 + dt.timedelta(minutes=10), prof(t0, ("nan", "nan"))),           # no density: left out
          (t0 + dt.timedelta(minutes=30), prof(t0, (30.0, 30.0)))]             # 30, 10 min
    assert old_product(ps) == pytest.approx((5 * 15 + 10 * 30) / 15)           # unweighted would be 22.5
    assert old_product([]) is None and old_product(ps[1:2]) is None

def test_pair_stats_uses_nights_both_radars_have_and_folds_the_ratio():
    a = {"n1": {"new": 10.0}, "n2": {"new": 30.0}, "n3": {"new": 0.0}, "n4": {"new": 80.0}, "n5": {"new": None}}
    b = {"n1": {"new": 20.0}, "n2": {"new": 40.0}, "n3": {"new": 5.0}, "n4": {"new": 80.0}, "n5": {"new": 1.0}}
    s = pair_stats(a, b, "new")
    assert s["nights"] == 4 and s["spearman"] == pytest.approx(1.0)              # n5 missing at a
    # ratios 0.5, 0.75, 1.0: n3 (a = 0) is not in them, else the median would be 0.625
    assert s["median_ratio"] == pytest.approx(0.75) and s["folded_ratio"] == pytest.approx(4 / 3)
    assert pair_stats(a, b, "new", keep=lambda x, y: x["new"] != 30.0)["nights"] == 3

def test_verdict_passes_only_when_all_four_checks_hold():
    def p(s_new, r_new, s_old, r_old):
        return {"new": {"spearman": s_new, "folded_ratio": r_new}, "old": {"spearman": s_old, "folded_ratio": r_old}}
    good = [p(0.9, 1.2, 0.6, 1.8), p(0.85, 1.3, 0.7, 1.6), p(0.5, 2.5, 0.4, 3.0)]   # medians: 0.85/1.3 vs 0.6/1.8
    v = verdict(good)
    assert v["pass"] is True and v["median_spearman"] == {"new": 0.85, "old": 0.6}
    assert verdict([p(0.79, 1.2, 0.6, 1.8)])["checks"]["median Spearman >= 0.8"] is False
    assert verdict([p(0.9, 1.51, 0.6, 1.8)])["pass"] is False
    assert verdict([p(0.8, 1.5, 0.6, 1.8)])["pass"] is True                    # both bounds are inclusive
    tie = verdict([p(0.9, 1.2, 0.9, 1.2)])["checks"]                          # level with the old is not better
    assert not tie["beats the old product on Spearman"] and not tie["beats the old product on ratio"]
    assert verdict([p(0.9, 1.2, 0.95, 1.8)])["checks"]["beats the old product on Spearman"] is False
    assert verdict([p(0.9, 1.2, 0.6, 1.1)])["checks"]["beats the old product on ratio"] is False
    assert verdict([p(None, None, None, None)])["pass"] is False

def test_site_nights_reads_the_store_and_matches_biorad_on_a_real_night(tmp_path: Path):
    night = FIX / "vp_KOKX_night_20261016"
    for f in night.glob("*.txt.gz"):
        dest = tmp_path / "KOKX" / f.name[4:12] / f.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(f.read_bytes())
    kokx = {s["id"]: s for s in json.loads((FIX.parent.parent / "sites.json").read_text())}["KOKX"]
    out = site_nights(tmp_path, kokx, [dt.date(2026, 10, 16), dt.date(2026, 10, 15)])
    g = (night / "biorad.csv").read_text().strip().splitlines()[-1].split(",")
    assert out["2026-10-16"]["new"] == pytest.approx(float(g[-1]), rel=1e-12)    # bioRad mt of the same files
    assert out["2026-10-16"]["profiles"] == 140 and out["2026-10-16"]["old"] > 0
    assert out["2026-10-15"] == {"new": None, "old": None, "profiles": 0, "coverage": 0.0, "bio_gate_share": None}

def test_pairs_are_the_neighbours_fixed_before_the_data():
    sites = {s["id"] for s in json.loads((FIX.parent.parent / "sites.json").read_text())}
    assert len(PAIRS) == 11 and len(set(PAIRS)) == 11 and all(a in sites and b in sites for a, b in PAIRS)
