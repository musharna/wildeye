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

from datetime import datetime, timezone, timedelta
from pipeline.nexrad import nearest_key, key_time

def test_key_time_parses_utc():
    assert key_time("2026/09/11/KOKX/KOKX20260911_025354_V06") == datetime(2026, 9, 11, 2, 53, 54, tzinfo=timezone.utc)

def test_nearest_key_within_tolerance_else_none():
    keys = ["2026/09/11/KOKX/KOKX20260911_025354_V06", "2026/09/11/KOKX/KOKX20260911_030754_V06",
            "2026/09/11/KOKX/KOKX20260911_030754_V06_MDM"]
    t = datetime(2026, 9, 11, 3, 0, tzinfo=timezone.utc)
    assert nearest_key(keys, t, timedelta(minutes=20)) == "2026/09/11/KOKX/KOKX20260911_025354_V06"
    assert nearest_key(keys, t + timedelta(hours=2), timedelta(minutes=20)) is None
