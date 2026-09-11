from pipeline.nexrad import pick_latest_key

def test_pick_latest_ignores_mdm_and_returns_newest():
    keys = [
        "2026/09/11/KOKX/KOKX20260911_000512_V06",
        "2026/09/11/KOKX/KOKX20260911_001210_V06_MDM",
        "2026/09/11/KOKX/KOKX20260911_001210_V06",
    ]
    assert pick_latest_key(keys) == "2026/09/11/KOKX/KOKX20260911_001210_V06"

def test_pick_latest_empty_is_none():
    assert pick_latest_key([]) is None
    assert pick_latest_key(["x/KOKX20260911_000512_V06_MDM"]) is None
