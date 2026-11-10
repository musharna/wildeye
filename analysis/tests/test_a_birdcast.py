"""A's BirdCast source: a BirdCast scan must read exactly like the vol2bird profile it came from, and the night's scans
must be the ones the backfill would have kept."""

import csv
import datetime as dt
import io

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


@pytest.mark.parametrize("missing", ["", "NaN"])
def test_birdcast_scan_reads_like_the_vol2bird_profile(missing):
    rows = birdcast_rows(
        V2B, "2025-10-19T07:22:26Z", "KDIX20251019_072226_V06", missing
    )
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
