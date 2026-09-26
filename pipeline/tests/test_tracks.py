import json
from pipeline.tracks import (
    species_of,
    select_datasets,
    clean,
    downsample,
    segment,
    split_antimeridian,
    apply_publication_lag,
    to_features,
    process_dataset,
    list_erddap_datasets,
    GROUPS,
    carry_forward,
    collect_movebank,
    build_collection,
)
import pytest

H = 3600.0


def fx(t, lat, lon, cls="1", animal="A"):
    return {"t": t, "lat": lat, "lon": lon, "cls": cls, "animal": animal}


def test_species_and_selection_newest_per_species_with_exclusion():
    ids = [
        "atn_1_ribbon-seal_trajectory_20100101-20100301",
        "atn_2_ribbon-seal_trajectory_20160101-20160301",
        "atn_3_ribbon-seal_trajectory_20140101-20140301",
        "atn_4_false-killer-whale_trajectory_20130101-20130301",
    ]
    assert species_of(ids[3]) == "false-killer-whale"
    assert select_datasets(ids, 2) == [
        "atn_4_false-killer-whale_trajectory_20130101-20130301",
        "atn_3_ribbon-seal_trajectory_20140101-20140301",
        "atn_2_ribbon-seal_trajectory_20160101-20160301",
    ]
    assert select_datasets(ids, 5, exclude={"ribbon-seal"}) == [ids[3]]


def test_clean_sorts_drops_class_Z_and_impossible_speed_keeping_the_earlier_fix():
    fixes = [
        fx(2 * H, 0, 0.1),
        fx(0, 0, 0),
        fx(H, 0, 0.05),
        fx(H + 1, 5, 0, cls="Z"),
        fx(3 * H, 3.0, 0),
    ]  # last = 330 km in 1 h
    out = clean(fixes, max_speed_ms=10)
    assert [f["t"] for f in out] == [0, H, 2 * H]
    assert all(f["cls"] != "Z" for f in out)
    # positive control: a plausible fix survives
    assert len(clean([fx(0, 0, 0), fx(H, 0, 0.1)])) == 2


def test_downsample_keeps_endpoints_and_hourly_budget():
    fixes = [fx(i * 600, 0, i * 0.001) for i in range(13)]  # every 10 min for 2 h
    out = downsample(fixes, min_gap_s=H)
    assert [f["t"] for f in out] == [0, 6 * 600, 12 * 600]
    assert downsample(fixes[:2], H) == fixes[:2]


def test_segment_splits_on_long_gaps_and_antimeridian_is_split_with_crossing_points():
    fixes = [
        fx(0, 60, 179.0),
        fx(H, 60, 179.8),
        fx(2 * H, 60, -179.6),
        fx(30 * H, 61, -179.0),
    ]
    segs = segment(fixes, gap_h=24)
    assert [len(s) for s in segs] == [3, 1]
    parts = split_antimeridian(segs[0])
    assert len(parts) == 2
    assert parts[0][-1]["lon"] == 180.0 and parts[1][0]["lon"] == -180.0
    assert (
        abs(parts[0][-1]["t"] - parts[1][0]["t"]) < 1e-9
        and H < parts[0][-1]["t"] < 2 * H
    )
    assert (
        60 <= parts[0][-1]["lat"] <= 60
    )  # lat interpolated between equal lats stays 60
    # positive control: a non-crossing segment is untouched
    assert split_antimeridian([fx(0, 0, 10), fx(H, 0, 11)]) == [
        [fx(0, 0, 10), fx(H, 0, 11)]
    ]


def test_publication_lag_and_feature_validation():
    now = 100 * 86400.0
    fixes = [fx(0, 0, 0), fx(now - 8 * 86400, 0, 1), fx(now - 1 * 86400, 0, 2)]
    kept = apply_publication_lag(fixes, 7, now)
    assert [f["t"] for f in kept] == [0, now - 8 * 86400]
    src = {"id": "atn", "name": "ATN"}
    info = {
        "species": "x",
        "sci": "X y",
        "institution": "I",
        "citation": "C",
        "license": "L",
        "url": "u",
        "title": "T",
    }
    feats = to_features(
        "d", src, info, [kept, [fx(0, 0, 0)]]
    )  # single-fix segment dropped
    assert len(feats) == 1
    p = feats[0]["properties"]
    assert (
        p["n"] == 2 and len(p["times"]) == len(feats[0]["geometry"]["coordinates"]) == 2
    )
    assert (
        p["start"] == "1970-01-01T00:00:00Z"
        and p["citation"] == "C"
        and p["license"] == "L"
    )
    json.dumps(feats)


def test_process_dataset_end_to_end_with_stubbed_erddap():
    src = {
        "id": "atn",
        "name": "ATN",
        "base": "https://x/erddap",
        "min_fixes": 3,
        "min_gap_s": H,
        "segment_gap_h": 24,
        "max_speed_ms": 10,
        "drop_location_classes": ["Z"],
        "min_age_days": 7,
    }

    def fetch(url, timeout=90):
        if "/info/" in url:
            return {
                "table": {
                    "rows": [
                        [
                            "attribute",
                            "NC_GLOBAL",
                            "animal_common_name",
                            "String",
                            "spotted seal",
                        ],
                        ["attribute", "NC_GLOBAL", "license", "String", "free"],
                        ["attribute", "NC_GLOBAL", "citation", "String", "cite me"],
                    ]
                }
            }
        rows = [
            ["A", "2018-04-20T00:00:00Z", 60.0, 179.5, "1"],
            ["A", "2018-04-20T02:00:00Z", 60.1, -179.7, "2"],
            ["A", "2018-04-20T04:00:00Z", 60.2, -179.0, "B"],
            ["A", "2018-04-20T04:30:00Z", 70.0, -170.0, "Z"],
        ]
        return {
            "table": {
                "columnNames": [
                    "deploy_id",
                    "time",
                    "latitude",
                    "longitude",
                    "location_class",
                ],
                "rows": rows,
            }
        }

    feats, st = process_dataset(
        src | {"groups": {"spotted seal": "seals"}}, "atn_1_spotted-seal_trajectory_20180420-20180501", fetch, now=2e9
    )
    assert {f["properties"]["group"] for f in feats} == {"seals"}
    unmapped, _ = process_dataset(src, "atn_1_spotted-seal_trajectory_20180420-20180501", fetch, now=2e9)
    assert {f["properties"]["group"] for f in unmapped} == {None}
    assert st["raw"] == 4 and st["kept"] == 3 and st["segments"] == 2
    assert [f["geometry"]["coordinates"][-1][0] for f in feats][0] == 180.0
    assert (
        feats[0]["properties"]["species"] == "spotted seal"
        and feats[0]["properties"]["license"] == "free"
    )
    few, st2 = process_dataset(
        src,
        "atn_2_spotted-seal_trajectory_20180420-20180501",
        lambda u, timeout=90: (
            fetch(u)
            if "/info/" in u
            else {
                "table": {
                    "columnNames": [
                        "deploy_id",
                        "time",
                        "latitude",
                        "longitude",
                        "location_class",
                    ],
                    "rows": [],
                }
            }
        ),
        now=2e9,
    )
    assert few == [] and st2["dropped"] == "too few fixes"


def test_list_erddap_datasets_filters_by_match():
    t = {
        "table": {
            "columnNames": ["x", "Dataset ID"],
            "rows": [
                ["", "atn_1_a_trajectory_1"],
                ["", "allDatasets"],
                ["", "atn_2_b_trajectory_2"],
            ],
        }
    }
    assert list_erddap_datasets(
        "https://x/erddap", "_trajectory_", lambda u, timeout=90: t
    ) == ["atn_1_a_trajectory_1", "atn_2_b_trajectory_2"]


def test_config_is_well_formed():
    from pathlib import Path

    cfg = json.loads((Path(__file__).parents[1] / "tracks.json").read_text())
    for s in cfg:
        for k in (
            "id",
            "kind",
            "name",
            "base",
            "match",
            "max_per_species",
            "min_fixes",
            "min_age_days",
        ):
            assert k in s, k


DAY = 86400.0
NOW = 1_790_000_000.0  # 2026-09-21


def _feat(dataset, group="birds", species="white stork"):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            "properties": {"dataset": dataset, "species": species, "group": group, "source": "movebank"}}


def _prev(fetched_days_ago):
    iso = __import__("datetime").datetime.fromtimestamp(NOW - fetched_days_ago * DAY, __import__("datetime").UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"datasets": {"mb:7": {"kept": 3, "fetched_at": iso}, "mb:8": {"kept": 1, "fetched_at": iso}},
            "features": [_feat("mb:7:a"), _feat("mb:7:b"), _feat("mb:8:a"), _feat("atn_1")]}


def test_carry_forward_reuses_the_last_good_copy_up_to_28_days_then_drops():
    feats, st, fail = carry_forward("mb:7", _prev(7), NOW, "URLError(timeout)")
    assert [f["properties"]["dataset"] for f in feats] == ["mb:7:a", "mb:7:b"], "only this study's features, not mb:8 or ATN"
    assert st["carried"] is True and st["fetched_at"] == _prev(7)["datasets"]["mb:7"]["fetched_at"], "age keeps counting from the real fetch"
    assert fail == {"error": "URLError(timeout)", "carried_from": st["fetched_at"]}
    stale, _, fail2 = carry_forward("mb:7", _prev(29), NOW, "E")
    assert stale == [] and "older than 28" in fail2["dropped"] and fail2["error"] == "E"
    none, _, fail3 = carry_forward("mb:7", None, NOW, "E")
    assert none == [] and "no previous" in fail3["dropped"]
    unaged, _, fail4 = carry_forward("mb:7", {"datasets": {"mb:7": {"kept": 3}}, "features": [_feat("mb:7:a")]}, NOW, "E")
    assert unaged == [] and "no previous" in fail4["dropped"]


def test_collect_movebank_retries_once_at_the_end_then_carries():
    calls = []
    def process(src, study, now=None):
        calls.append(study["id"])
        if study["id"] == 7 and calls.count(7) == 1:
            raise TimeoutError("blip")          # fails once, retry succeeds
        if study["id"] == 8:
            raise TimeoutError("down")          # fails twice → carried
        return [_feat(f"mb:{study['id']}:x")], {"kept": 2}
    src = {"id": "movebank", "studies": [{"id": 7}, {"id": 8}, {"id": 9}]}
    feats, per, fails = collect_movebank(src, src["studies"], _prev(7), NOW, process, sleep=0, retry_pause=0)
    assert calls == [7, 8, 9, 7, 8], "one pass, then one retry each for the failures, at the end"
    assert sorted({f["properties"]["dataset"] for f in feats}) == ["mb:7:x", "mb:8:a", "mb:9:x"]
    assert per["mb:7"]["fetched_at"] == per["mb:9"]["fetched_at"] == "2026-09-21T14:13:20Z" and per["mb:8"]["carried"] is True
    assert set(fails) == {"mb:8"} and fails["mb:8"]["error"] == "TimeoutError('down')" and "carried_from" in fails["mb:8"]


def test_licence_refusal_is_not_an_error_and_is_never_carried():
    def process(src, study, now=None):
        return [], {"dropped": "licence CC_BY_NC not in ('CC_0', 'CC_BY')"}
    src = {"id": "movebank", "studies": [{"id": 7}]}
    feats, per, fails = collect_movebank(src, src["studies"], _prev(1), NOW, process, sleep=0, retry_pause=0)
    assert feats == [] and fails == {} and "CC_BY_NC" in per["mb:7"]["dropped"]


def test_build_collection_groups_and_byte_cap():
    feats = [_feat("mb:7:a", "birds"), _feat("atn_1", "seals", "harbor seal")]
    gj = build_collection([{"id": "a", "name": "A", "base": "b"}], feats, {}, {}, max_bytes=10_000)
    assert gj["groups"] == ["seals", "birds"] and gj["groups"] == [g for g in GROUPS if g in ("seals", "birds")]
    assert gj["species"] == ["harbor seal", "white stork"]
    with pytest.raises(SystemExit, match="no group.*harbor seal"):
        build_collection([], [feats[0], _feat("atn_1", None, "harbor seal")], {}, {}, max_bytes=10_000)
    with pytest.raises(SystemExit, match="no group.*hare"):
        build_collection([], [_feat("x", "rodents", "hare")], {}, {}, max_bytes=10_000)
    with pytest.raises(SystemExit, match="exceeds"):
        build_collection([], feats, {}, {}, max_bytes=200)
    with pytest.raises(SystemExit, match="no tracks"):
        build_collection([], [], {}, {}, max_bytes=10_000)


def test_config_groups_windows_and_caps():
    from pathlib import Path
    from pipeline.movebank import study_window
    cfg = {s["id"]: s for s in json.loads((Path(__file__).parents[1] / "tracks.json").read_text())}
    assert set(cfg["atn"]["groups"].values()) <= set(GROUPS)
    mb = cfg["movebank"]
    assert "days" not in mb, "the window is per study (A38)"
    assert mb["max_individuals"] == 12
    ids = [st["id"] for st in mb["studies"]]
    assert len(ids) == len(set(ids)) == 13
    for st in mb["studies"]:
        assert st["group"] in GROUPS, st["id"]
        study_window(st, NOW)  # raises on a bad window
