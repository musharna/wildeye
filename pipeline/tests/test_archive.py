import datetime as dt
import json
from pathlib import Path

import pytest

import pipeline.build_archive as ba

UTC = dt.UTC
NIGHT = set(range(0, 13))
SETTLE = dt.timedelta(minutes=35)


def t(s):
    return dt.datetime.fromisoformat(s).replace(tzinfo=UTC)


def test_pending_hours_start_after_the_archive_end_not_from_the_clock():
    """The window's left edge is the archive's own newest frame, so a stalled run catches up
    instead of leaving a hole the size of the stall."""
    got = ba.pending_hours(
        ["2026-09-09T12", "2026-09-10T11"], t("2026-09-12T13:00"), NIGHT, SETTLE
    )
    assert got[0] == t("2026-09-10T12:00")
    assert got[-1] == t("2026-09-12T12:00")
    # three nights' worth of 0-12 UTC hours after 09-10T11: 1 + 13 + 13
    assert len(got) == 27
    assert all(h.hour in NIGHT for h in got)


def test_pending_hours_leaves_an_hour_whose_scans_may_not_have_landed():
    # a frame at HH needs scans up to HH+tolerance; at 12:30 the 12:00 frame is not settled
    got = ba.pending_hours(["2026-09-12T10"], t("2026-09-12T12:30"), NIGHT, SETTLE)
    assert got == [t("2026-09-12T11:00")]
    got = ba.pending_hours(["2026-09-12T10"], t("2026-09-12T12:35"), NIGHT, SETTLE)
    assert got == [t("2026-09-12T11:00"), t("2026-09-12T12:00")]


def test_pending_hours_empty_archive_is_an_error_not_a_guess():
    with pytest.raises(SystemExit, match="--start"):
        ba.pending_hours([], t("2026-09-12T13:00"), NIGHT, SETTLE)


def _frame(root: Path, fid: str):
    d = root / f"{fid[:4]}/{fid[5:7]}/{fid[8:10]}/{fid[11:13]}"
    d.mkdir(parents=True)
    (d / "field.json").write_text("{}")
    return {
        "fresh": 20,
        "sites": 20,
        "dir": f"data/birds_archive/{d.relative_to(root)}",
    }


def test_prune_keeps_the_newest_nights_counted_from_the_data(tmp_path):
    ids = ["2026-09-01T00", "2026-09-01T12", "2026-09-02T00", "2026-09-03T05"]
    man = {"frames": {i: _frame(tmp_path, i) for i in ids}}
    dropped = ba.prune_nights(man, tmp_path, keep=2)
    assert dropped == ["2026-09-01T00", "2026-09-01T12"]
    assert sorted(man["frames"]) == ["2026-09-02T00", "2026-09-03T05"]
    assert not (tmp_path / "2026/09/01").exists()
    # positive control: kept frames still on disk
    assert (tmp_path / "2026/09/02/00/field.json").exists()
    assert (tmp_path / "2026/09/03/05/field.json").exists()


def test_frame_with_no_site_is_not_written(tmp_path, monkeypatch):
    """An empty frame written once is skipped as done forever (resume checks field.json)."""
    sites = [{"id": "KAAA"}, {"id": "KBBB"}]
    monkeypatch.setattr(ba, "volume_key_at", lambda sid, when, tol: None)
    with pytest.raises(ba.EmptyFrame):
        ba.build_frame(t("2026-09-11T03:00"), sites, tmp_path, tmp_path / "w", 2, 20)
    assert not list(tmp_path.rglob("field.json"))


def _fake_site(monkeypatch, fail_at=None):
    monkeypatch.setattr(
        ba,
        "volume_key_at",
        lambda sid, when, tol: None if when == fail_at else f"{sid}/{when:%H}",
    )
    feat = lambda sid: {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [0, 0]},
        "properties": {"site": sid},
    }
    monkeypatch.setattr(
        ba,
        "process_site",
        lambda s, w, p, key: (feat(s["id"]), {"grid": None, "bounds": None}),
    )
    monkeypatch.setattr(ba, "composite", lambda pairs: (_Grid(), [0, 0, 1, 1]))
    monkeypatch.setattr(ba, "write_field_png", _png)
    monkeypatch.setattr(ba, "write_ppi_png", _png)
    monkeypatch.setattr(ba, "SITES", [{"id": "KAAA"}, {"id": "KBBB"}])


def _png(grid, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"png")


class _Grid:
    shape = (4, 8)


def _seed(root: Path, fid: str):
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(
        json.dumps({"frames": {fid: _frame(root, fid)}})
    )


def test_catch_up_appends_then_stops_loud_at_an_empty_hour(tmp_path, monkeypatch):
    _fake_site(monkeypatch, fail_at=t("2026-09-11T02:00"))
    _seed(tmp_path, "2026-09-10T12")
    monkeypatch.setattr(ba, "_now", lambda: t("2026-09-11T13:00"))
    rc = ba.main(
        ["--catch-up", "--out", str(tmp_path), "--workdir", str(tmp_path / "w")]
    )
    assert rc == 1
    frames = json.loads((tmp_path / "manifest.json").read_text())["frames"]
    # positive control: hours before the hole were appended
    assert sorted(frames) == ["2026-09-10T12", "2026-09-11T00", "2026-09-11T01"]
    # nothing past the hole, so the next run's window starts at it and retries it
    assert not (tmp_path / "2026/09/11/03").exists()


def test_catch_up_fills_to_the_settled_edge_and_prunes(tmp_path, monkeypatch):
    _fake_site(monkeypatch)
    _seed(tmp_path, "2026-09-10T12")
    monkeypatch.setattr(ba, "_now", lambda: t("2026-09-12T13:00"))
    rc = ba.main(
        [
            "--catch-up",
            "--keep-nights",
            "2",
            "--out",
            str(tmp_path),
            "--workdir",
            str(tmp_path / "w"),
        ]
    )
    assert rc == 0
    frames = sorted(json.loads((tmp_path / "manifest.json").read_text())["frames"])
    assert frames[0] == "2026-09-11T00" and frames[-1] == "2026-09-12T12"
    assert len(frames) == 26
    assert not (tmp_path / "2026/09/10").exists()
