import collections
import datetime as dt
import json
import pytest
from pipeline.fires import (
    acq_ts,
    aggregate,
    build,
    cell_of,
    cell_centre,
    url_for,
    main,
    BIN_S,
)

# Real rows from SUOMI_VIIRS_C2_Global_7d.csv fetched 2026-09-12 (header verbatim; the NOAA-21 file
# fetched the same day has the identical header with satellite "N21").
HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight"
ROWS = [
    "41.16739,15.27853,300.66,0.63,0.54,2026-09-05,0024,N,nominal,2.0NRT,288.55,0.96,N",
    "13.33663,13.66445,329.75,0.56,0.43,2026-09-05,0033,N,nominal,2.0NRT,291.65,4.79,N",
    "-28.15003,151.34506,331.87,0.51,0.66,2026-09-05,0300,N,low,2.0NRT,304.49,5.63,D",
    "29.10856,9.6664,367,0.51,0.66,2026-09-05,0028,N,high,2.0NRT,293.93,17.73,N",
    "-9.09623,30.38278,335.96,0.36,0.58,2026-09-12,0005,N,nominal,2.0NRT,287.42,1.65,N",
]
CSV = "\n".join([HEADER, *ROWS]) + "\n"
K0 = acq_ts("2026-09-05", "0000") // BIN_S  # the 2026-09-05 00–06 UTC bin


def csv_of(*rows):
    return "\n".join([HEADER, *rows]) + "\n"


def test_acq_ts_and_cells_area_api_unpadded_time():
    """Mutants seen failing: divmod(t, 60) (13:30 parsed as 22:30); math.floor → round in cell_of
    (-1.1° → row -2 instead of -3)."""
    assert acq_ts("2026-09-05", "0024") == int(
        dt.datetime(2026, 9, 5, 0, 24, tzinfo=dt.UTC).timestamp()
    )
    assert acq_ts("2026-09-05", "45") == acq_ts("2026-09-05", "0045"), (
        "area API drops the zero padding"
    )
    assert acq_ts("2026-09-05", "1330") == int(
        dt.datetime(2026, 9, 5, 13, 30, tzinfo=dt.UTC).timestamp()
    )
    assert cell_of(-1.1, 29.9) == (-3, 59) and cell_centre((-3, 59)) == [29.75, -1.25]
    assert cell_of(0.0, 0.0) == (0, 0) and cell_centre((0, 0)) == [0.25, 0.25]
    assert (
        url_for("N20")
        == "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv"
    )


def test_aggregate_drops_low_confidence_bins_by_6h_sums_frp_and_returns_latest_with_positive_control():
    """Mutants seen failing: "low" added to CONFIDENCE_KEPT (dropped_low 0, the -28.15 cell appears);
    `latest = ts` without the max (returns the last row's time, not the newest)."""
    acc, counts, sats = {}, collections.Counter(), {}
    latest = aggregate(CSV, acc, counts, sats)
    assert counts == {"rows": 5, "kept": 4, "dropped_low": 1} and sats == {"N": 4}
    assert cell_of(-28.15003, 151.34506) not in acc, "low-confidence row dropped"
    assert acc[cell_of(41.16739, 15.27853)] == {K0: [1, 0.96]}, (
        "positive control: nominal row kept in the 00–06 UTC bin"
    )
    assert acc[cell_of(29.10856, 9.6664)] == {K0: [1, 17.73]}, (
        "high-confidence row kept"
    )
    assert latest == acq_ts("2026-09-12", "0005")
    assert aggregate(csv_of(ROWS[4], ROWS[0]), {}, collections.Counter(), {}) == acq_ts(
        "2026-09-12", "0005"
    ), "newest, not last"
    acc2 = {}
    aggregate(
        csv_of(ROWS[0], ROWS[0].replace("0024", "0530").replace("0.96", "2.04")),
        acc2,
        collections.Counter(),
        {},
    )
    assert acc2[cell_of(41.16739, 15.27853)] == {K0: [2, 3.0]}, (
        "same cell, same bin → summed"
    )
    acc3 = {}
    aggregate(
        csv_of(ROWS[0], ROWS[0].replace("0024", "0601")),
        acc3,
        collections.Counter(),
        {},
    )
    assert sorted(acc3[cell_of(41.16739, 15.27853)]) == [K0, K0 + 1], (
        "06:01 lands in the next bin"
    )


def test_aggregate_fails_loud_on_changed_header_with_positive_control():
    """Mutant seen failing: header check removed → KeyError inside the loop, not a RuntimeError naming the column."""
    with pytest.raises(RuntimeError, match="missing.*frp"):
        aggregate(
            "latitude,longitude,acq_date,acq_time,confidence\n1,2,2026-09-05,0000,nominal\n",
            {},
            collections.Counter(),
            {},
        )
    assert aggregate(CSV, {}, collections.Counter(), {}) is not None, (
        "positive control: the real header parses"
    )


def test_build_windows_to_days_floors_ranks_caps_and_encodes_bins_relative_to_bin0():
    """Mutants seen failing: bin0 = newest - days*24//BIN_H (29 bins, the 9999 MW bin survives the window);
    `frp < min_frp` → `frp <= min_frp` (the cell at exactly the floor is dropped); floor check removed
    (cells_below_floor 0, three cells kept)."""
    acc = {}
    aggregate(CSV, acc, collections.Counter(), {})
    newest = acq_ts("2026-09-12", "0005") // BIN_S
    assert newest == K0 + 28
    acc[cell_of(41.16739, 15.27853)][K0] = [
        99,
        9999.0,
    ]  # 7 days + 1 bin before the newest bin: must be cut
    feats, meta = build(acc, days=7, max_cells=2)
    assert (
        meta["bins"] == 28
        and meta["bin0"] == "2026-09-05T06:00:00Z"
        and meta["newest"] == "2026-09-12T06:00:00Z"
    )
    assert meta["cells_total"] == 1 and meta["cells_kept"] == 1, (
        "only the 2026-09-12 row is inside the window"
    )
    assert feats[0]["geometry"]["coordinates"] == [30.25, -9.25]
    # 1.65 MW rounds to 1.6 (binary 1.65 is 1.6499…); bins encoded relative to bin0, newest = k 27
    assert feats[0]["properties"] == {
        "n": 1,
        "frp": 1.6,
        "frp_max_bin": 1.6,
        "bins": [[27, 1, 1.6]],
    }
    # window ending at K0 holds all three nominal/high cells: 9999, 17.73, 4.79 MW
    feats2, meta2 = build(acc, days=7, max_cells=2, end_bin=K0)
    assert (
        meta2["cells_total"] == 3
        and meta2["cells_kept"] == 2
        and meta2["cells_over_cap"] == 1
    )
    assert [f["properties"]["frp"] for f in feats2] == [9999.0, 17.7], (
        "ranked by FRP, capped"
    )
    feats3, meta3 = build(acc, days=7, max_cells=10, min_frp=17.73, end_bin=K0)
    assert [f["properties"]["frp"] for f in feats3] == [9999.0, 17.7], (
        "positive control: cell at exactly the floor kept"
    )
    assert (
        meta3["cells_below_floor"] == 1
        and meta3["cells_total"] == 3
        and meta3["min_frp"] == 17.73
    )
    with pytest.raises(RuntimeError):
        build({}, 7, 10)


def test_main_end_to_end_default_floor_refuses_a_tiny_file_and_writes_with_floor_zero(
    tmp_path, monkeypatch
):
    """Mutant seen failing: `if not feats: raise SystemExit` removed (an empty file is written under the default floor)."""
    import pipeline.fires as m

    monkeypatch.setattr(m, "_get_text", lambda url, **kw: CSV)
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    out = tmp_path / "f.geojson"
    with pytest.raises(SystemExit, match="100.0 MW"):
        main(["--out", str(out), "--satellites", "N"])
    assert not out.exists()
    main(["--out", str(out), "--satellites", "N,N21", "--min-frp", "0"])
    gj = json.loads(out.read_text())
    assert (
        gj["counts"]["kept"] == 8
        and gj["counts"]["dropped_low"] == 2
        and gj["counts"]["satellites"] == {"N": 8}
    )
    assert (
        len(gj["features"]) == 1
        and gj["bin_hours"] == 6
        and gj["days"] == 7
        and gj["latest"] == "2026-09-12T00:05:00Z"
    )
    assert gj["source"]["citation"] == "NASA FIRMS" and gj["source"]["files"] == [
        url_for("N"),
        url_for("N21"),
    ]
    assert (
        gj["source"]["cell_deg"] == 0.5 and "full and open" in gj["source"]["licence"]
    )
