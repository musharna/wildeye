"""A's BirdCast source: a BirdCast scan must read exactly like the vol2bird profile it came from, and the night's scans
must be the ones the backfill would have kept."""

import csv
import datetime as dt
import http.server
import io
import threading

import pytest

from analysis import a_birdcast as bc
from pipeline.bird_nights import night_total, night_window, stored_profiles
from pipeline.vol2bird import (
    bio_gate_share,
    integrate_profile,
    parse_profile,
    profile_time,
)

# a real stored profile (KDIX 2025-10-19 07:22:26, pinned vol2bird), trimmed: bird bins, a gap bin, empty bins
V2B = """# vol2bird Vertical Profile of Birds (VPB)
# date   time HGHT    u      v       w     ff    dd  sd_vvp gap dbz     eta   dens   DBZH   n   n_dbz n_all n_dbz_all
20251019 0722    0   0.05   9.41   11.92  9.41   0.3   4.13 F   7.24  114.5  10.41   6.97 39759 44593 43824 49144
20251019 0722  200   3.12  10.84    5.85 11.28  16.1   3.83 F   6.56   97.9   8.90   5.53 79679 83924 112511 119079
20251019 0722  400   4.98  10.98  -33.61 12.06  24.4   3.39 F   2.74   40.6   3.69   0.02 26413 29388 70640 81173
20251019 0722  600    nan    nan     nan   nan   nan    nan T -31.85    0.0   0.00 -31.85    48 10066    48 10066
20251019 0722  800    nan    nan     nan   nan   nan    nan T    nan    nan    nan    nan     0     0     0     0
"""
FIELDS = [
    "radar",
    "datetime",
    "height",
    "height_reference",
    "u",
    "v",
    "w",
    "ff",
    "dd",
    "sd_vvp",
    "gap",
    "eta",
    "dens",
    "dbz",
    "dbz_all",
    "n",
    "n_dbz",
    "n_all",
    "n_dbz_all",
    "rcs",
    "sd_vvp_threshold",
    "radar_height",
    "source_file",
]


def birdcast_rows(text, when, source, missing=""):
    """BirdCast's CSV rows for a vol2bird text: dbz_all for DBZH, true/false for T/F, blank (or NaN) for nan,
    seconds in the time; heights high to low so the converter has to sort."""
    head = None
    rows = []
    for line in text.splitlines():
        toks = line.lstrip("#").split()
        if line.startswith("#") and "HGHT" in toks:
            head = toks
        elif not line.startswith("#") and line.strip():
            col = dict(zip(head, toks))
            r = {
                "radar": "KDIX",
                "datetime": when,
                "height": col["HGHT"],
                "height_reference": "sea",
                "rcs": "11",
                "sd_vvp_threshold": "1",
                "radar_height": "45",
                "source_file": source,
                "dbz_all": col["DBZH"],
                "gap": {"T": "true", "F": "false"}[col["gap"]],
            }
            for k in (
                "u",
                "v",
                "w",
                "ff",
                "dd",
                "sd_vvp",
                "eta",
                "dens",
                "dbz",
                "n",
                "n_dbz",
                "n_all",
                "n_dbz_all",
            ):
                r[k] = col[k]
            rows.append({k: (missing if v == "nan" else v) for k, v in r.items()})
    return rows[::-1]


def to_csv(rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=FIELDS)
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


@pytest.mark.parametrize(
    "missing, when",  # both time layouts BirdCast uses: 2021-2024 files, and 2025 files with milliseconds
    [
        ("", "2025-10-19T07:22:26Z"),
        ("NaN", "2025-10-19T07:22:26Z"),
        ("", "2025-10-19T07:22:26.000Z"),
    ],
)
def test_birdcast_scan_reads_like_the_vol2bird_profile(missing, when):
    rows = birdcast_rows(V2B, when, "KDIX20251019_072226_V06", missing)
    text = bc.to_vol2bird(rows)
    assert parse_profile(text) == parse_profile(V2B)
    assert (
        profile_time(text)
        == profile_time(V2B)
        == dt.datetime(2025, 10, 19, 7, 22, tzinfo=dt.UTC)
    )
    assert integrate_profile(parse_profile(text)) == integrate_profile(
        parse_profile(V2B)
    )
    assert bio_gate_share(parse_profile(text)) == bio_gate_share(parse_profile(V2B))
    assert (
        integrate_profile(parse_profile(text))["vid_birds_km2"] > 0
    )  # the plant carries birds, so == can fail


def test_select_is_the_backfill_rule():
    sunset = dt.datetime(2021, 9, 15, 23, 10, tzinfo=dt.UTC)
    sunrise = dt.datetime(2021, 9, 16, 10, 30, tzinfo=dt.UTC)
    names = [
        "KDIX20210915_230500_V06",  # before sunset
        "KDIX20210915_231000_V06",  # slot 0, first
        "KDIX20210915_231400_V06",  # slot 0, second: dropped
        "KDIX20210915_231700_MDM",  # not a volume
        "KDIX20210915_232200_V06",  # slot 1
        "KDIX20210916_102900_V06",  # last slot before sunrise
        "KDIX20210916_103100_V06",  # after sunrise
    ]
    assert bc.select(names[::-1], sunset, sunrise) == [
        "KDIX20210915_231000_V06",
        "KDIX20210915_232200_V06",
        "KDIX20210916_102900_V06",
    ]


def test_scans_rejects_a_scan_at_two_times_and_a_foreign_radar():
    good = birdcast_rows(V2B, "2025-10-19T07:22:26Z", "KDIX20251019_072226_V06")
    assert list(bc.scans(to_csv(good), "KDIX")) == ["KDIX20251019_072226_V06"]
    split = [dict(r) for r in good]
    split[0]["datetime"] = "2025-10-19T07:23:26Z"
    with pytest.raises(ValueError, match="rows at 2 times"):
        bc.scans(to_csv(split), "KDIX")
    with pytest.raises(ValueError, match="holds a row for KDIX"):
        bc.scans(to_csv(good), "KOKX")


def test_radar_fall_fills_a_store_night_total_reads(tmp_path, monkeypatch):
    site = {"id": "KDIX", "lat": 39.947, "lon": -74.411}
    monkeypatch.setattr(bc, "fall_nights", lambda year: [dt.date(2021, 9, 15)])
    sunset, sunrise = night_window(dt.date(2021, 9, 15), site["lon"], site["lat"])
    plant = {}  # one scan every 5 min through the night: the 10-min rule keeps every other one
    t = sunset + dt.timedelta(seconds=30)
    while t <= sunrise:
        name = f"KDIX{t:%Y%m%d_%H%M%S}_V06"
        plant.setdefault(t.date(), []).extend(
            birdcast_rows(V2B, f"{t:%Y-%m-%dT%H:%M:%SZ}", name)
        )
        t += dt.timedelta(minutes=5)
    calls = []

    def get(radar, day):
        calls.append(day)
        if day == sunrise.date() + dt.timedelta(days=1):
            raise AssertionError("fetched a day outside the night")
        return (
            (to_csv(plant[day]), {"etag": f'"{day}"', "last_modified": None})
            if day in plant
            else None
        )

    r = bc.radar_fall(site, 2021, tmp_path, get)
    expect = len(
        bc.select(
            [s["source_file"] for rows in plant.values() for s in rows], sunset, sunrise
        )
    )
    assert r["profiles"] == expect > 60  # ~11.5 h night, one scan per 10-min slot
    assert r["nights_with_profiles"] == r["nights"] == 1 and r["missing_days"] == []
    tot = night_total(
        stored_profiles(tmp_path, "KDIX", sunset, sunrise), sunset, sunrise
    )
    assert (
        tot["profiles"] == expect and tot["coverage"] > 0.95 and tot["mt_birds_km"] > 0
    )
    # a day BirdCast lacks is listed, and the night keeps the scans it has
    plant.pop(sunrise.date())
    r2 = bc.radar_fall(site, 2021, tmp_path / "second", get)
    assert r2["missing_days"] == [sunrise.date().isoformat()]
    assert 0 < r2["profiles"] < expect


def test_to_vol2bird_refuses_a_time_that_is_not_utc():
    utc = birdcast_rows(V2B, "2025-10-19T07:22:26.000Z", "KDIX20251019_072226_V06")
    assert " 0722 " in bc.to_vol2bird(utc)  # positive control
    local = birdcast_rows(V2B, "2025-10-19T07:22:26-04:00", "KDIX20251019_072226_V06")
    with pytest.raises(ValueError, match="is not UTC"):
        bc.to_vol2bird(local)


def test_scans_refuses_heights_not_above_sea_level():
    good = birdcast_rows(V2B, "2025-10-19T07:22:26Z", "KDIX20251019_072226_V06")
    assert (
        len(bc.scans(to_csv(good), "KDIX")["KDIX20251019_072226_V06"]) == 5
    )  # "sea" passes
    blank = [
        dict(r, height_reference="") for r in good
    ]  # every 2023 file: no label, heights still ASL
    assert len(bc.scans(to_csv(blank), "KDIX")["KDIX20251019_072226_V06"]) == 5
    buf = io.StringIO()  # the 26-column files have no height_reference column at all
    w = csv.DictWriter(
        buf,
        fieldnames=[f for f in FIELDS if f != "height_reference"],
        extrasaction="ignore",
    )
    w.writeheader()
    w.writerows(good)
    assert "height_reference" not in buf.getvalue().splitlines()[0]
    assert len(bc.scans(buf.getvalue(), "KDIX")["KDIX20251019_072226_V06"]) == 5
    ground_frame = [
        dict(r, height_reference="", radar_height="361") for r in good
    ]  # gates at 0-200 m, antenna 361
    with pytest.raises(ValueError, match="below the antenna at 361 m"):
        bc.scans(to_csv(ground_frame), "KDIX")
    above_antenna = [dict(r, height_reference="radar") for r in good]
    with pytest.raises(ValueError, match="heights above 'radar', not sea level"):
        bc.scans(to_csv(above_antenna), "KDIX")


def test_fetch_against_a_real_http_server(monkeypatch):
    """fetch() over real HTTP: 200 returns text + ETag, 404 is a missing day (None), a 500 is retried, a 403 raises."""
    hits = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits[self.path] = hits.get(self.path, 0) + 1
            day = self.path.rsplit("/", 1)[-1]
            code = {"20210916.csv": 404, "20210918.csv": 403}.get(day, 200)
            if day == "20210917.csv" and hits[self.path] == 1:
                code = 500
            self.send_response(code)
            if code == 200:
                self.send_header("ETag", '"abc"')
            self.end_headers()
            if code == 200:
                self.wfile.write(b"radar,datetime\nKDIX,x\n")

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(
            bc, "URL", f"http://127.0.0.1:{srv.server_port}/{{r}}/{{d:%Y%m%d}}.csv"
        )
        monkeypatch.setattr(bc.time, "sleep", lambda s: None)
        text, meta = bc.fetch("KDIX", dt.date(2021, 9, 15))
        assert text == "radar,datetime\nKDIX,x\n" and meta["etag"] == '"abc"'
        assert bc.fetch("KDIX", dt.date(2021, 9, 16)) is None
        assert (
            bc.fetch("KDIX", dt.date(2021, 9, 17))[0].startswith("radar")
            and hits["/KDIX/20210917.csv"] == 2
        )
        with pytest.raises(bc.urllib.error.HTTPError, match="403"):
            bc.fetch("KDIX", dt.date(2021, 9, 18), tries=2)
        assert hits["/KDIX/20210918.csv"] == 2
    finally:
        srv.shutdown()


def test_select_matches_backfill_night(tmp_path, monkeypatch):
    """The two copies of the slot rule (backfill_night's and select's) keep the same scans from one archive listing,
    at 10 and 30 min; edge cases: before sunset, two in a slot, a non-volume key, after sunrise."""
    import pipeline.bird_nights as bn
    import pipeline.nexrad as nx

    site = {"id": "KDIX", "lat": 39.947, "lon": -74.411}
    sunset, sunrise = night_window(dt.date(2021, 9, 15), site["lon"], site["lat"])
    times = [
        sunset + dt.timedelta(minutes=m)
        # no scan at sunset and none within a second of a boundary (keys drop fractions of a second):
        # slots from sunset keep 3, 11, 25, 400; counted from the first scan they would keep 3, 14, 25, 400
        for m in (-5, 3, 9, 11, 14, 25, 27, 400)
    ]
    times.append(sunrise + dt.timedelta(minutes=1))
    keys = [f"{t:%Y/%m/%d}/KDIX/KDIX{t:%Y%m%d_%H%M%S}_V06" for t in times]
    keys.append(
        f"{sunset:%Y/%m/%d}/KDIX/KDIX{sunset + dt.timedelta(minutes=1):%Y%m%d_%H%M%S}_MDM"
    )
    monkeypatch.setattr(
        nx,
        "list_day_keys",
        lambda sid, day: [k for k in keys if k.split("/")[2] == f"{day:%d}"],
    )
    ran = []

    def fake_download(k, dest):
        ran.append(k.rsplit("/", 1)[-1])
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "v").write_bytes(b"x")
        return dest / "v"

    monkeypatch.setattr(nx, "download_volume", fake_download)
    monkeypatch.setattr(bn, "run_vol2bird", lambda vol, options=None: "raw")
    names = [k.rsplit("/", 1)[-1] for k in keys]
    for every, root, n in ((10, "a", 4), (30, "b", 2)):
        ran.clear()
        assert (
            bn.backfill_night(
                site,
                dt.date(2021, 9, 15),
                tmp_path / root,
                tmp_path / "w",
                1,
                every_min=every,
            )
            == []
        )
        assert (
            sorted(ran) == sorted(bc.select(names, sunset, sunrise, every))
            and len(ran) == n
        )


def test_a_scan_at_another_sd_vvp_threshold_gives_its_slot_to_the_next_scan(
    tmp_path, monkeypatch
):
    site = {"id": "KDIX", "lat": 39.947, "lon": -74.411}
    monkeypatch.setattr(bc, "fall_nights", lambda year: [dt.date(2021, 9, 15)])
    sunset, _ = night_window(dt.date(2021, 9, 15), site["lon"], site["lat"])
    plant = {}

    def scan(t, threshold):
        name = f"KDIX{t:%Y%m%d_%H%M%S}_V06"
        rows = birdcast_rows(V2B, f"{t:%Y-%m-%dT%H:%M:%SZ}", name)
        plant.setdefault(t.date(), []).extend(
            dict(r, sd_vvp_threshold=threshold) for r in rows
        )
        return name

    first = scan(sunset + dt.timedelta(minutes=2), "2")  # night, slot 0: dropped
    second = scan(
        sunset + dt.timedelta(minutes=6), "1"
    )  # night, slot 0: takes the slot
    scan(sunset - dt.timedelta(hours=3), "2")  # by day: dropped, not counted
    later = scan(sunset + dt.timedelta(minutes=12), "1")  # slot 1, untouched

    def get(radar, day):
        return (
            (to_csv(plant[day]), {"etag": None, "last_modified": None})
            if day in plant
            else None
        )

    r = bc.radar_fall(site, 2021, tmp_path, get)
    stored = sorted(p.name for p in (tmp_path / "KDIX").rglob("*.txt.gz"))
    assert (
        stored == sorted([second + ".txt.gz", later + ".txt.gz"])
        and first + ".txt.gz" not in stored
    )
    assert r["other_threshold_scans"] == 1 and r["profiles"] == 2


def test_main_lists_a_failed_radar_fall_and_still_writes_the_rest(
    tmp_path, monkeypatch
):
    import concurrent.futures as cf
    import json

    def fake(site, year, root):
        if site["id"] == "KBOX":
            raise ValueError("planted failure")
        return {
            "nights": 1,
            "nights_with_profiles": 1,
            "profiles": 3,
            "missing_days": [],
            "days": {},
        }

    monkeypatch.setattr(bc, "EXECUTOR", cf.ThreadPoolExecutor)
    monkeypatch.setattr(bc, "radar_fall", fake)
    args = [
        "--root",
        str(tmp_path),
        "--falls",
        "2021",
        "--site",
        "KDIX",
        "--site",
        "KBOX",
        "--workers",
        "2",
    ]
    with pytest.raises(SystemExit, match=r"failed: \['KBOX 2021'\]"):
        bc.main(args)
    (manifest,) = tmp_path.glob("manifest_*.json")
    doc = json.loads(manifest.read_text())
    assert doc["failed_radar_falls"] == {"KBOX 2021": "ValueError('planted failure')"}
    assert (
        doc["radar_falls"]["KDIX 2021"]["profiles"] == 3
    )  # the good radar-fall is kept
