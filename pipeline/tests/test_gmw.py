import hashlib
import json

import openpyxl
import pytest

from pipeline.gmw import YEARS, read_stats, load_units, build, main

SQ = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
SQ2 = [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]]


def write_xlsx(
    path,
    rows,
    *,
    lo_scale=0.9,
    hi_scale=1.1,
    years=YEARS,
    sheets=("Extent", "lower95th", "upper95th"),
    lo_rows=None,
):
    """rows = [(iso, name, [ha per year])] → the three-sheet layout of the GMW v4.1.12 country stats file."""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for sheet, scale in zip(sheets, (1.0, lo_scale, hi_scale)):
        ws = wb.create_sheet(sheet)
        ws.append(["iso", "cnty_name", *[str(y) for y in years]])
        src = lo_rows if (sheet == "lower95th" and lo_rows is not None) else rows
        for iso, name, ha in src:
            ws.append([iso, name, *[v * scale for v in ha]])
    wb.save(path)


def series(start, step=1.0):
    return [start + step * i for i in range(len(YEARS))]


def test_read_stats_reads_all_three_sheets_and_refuses_a_malformed_file(tmp_path):
    good = tmp_path / "good.xlsx"
    write_xlsx(
        good,
        [
            ("IDN", "Indonesia", series(3000000.0, -1000)),
            ("ABW", "Aruba", series(86.0, 0.1)),
        ],
    )
    s = read_stats(good)
    assert YEARS[0] == 1985 and YEARS[-1] == 2025 and len(YEARS) == 41
    assert set(s) == {"IDN", "ABW"}
    assert s["IDN"]["name"] == "Indonesia"
    assert (
        s["IDN"]["ha"][0] == 3000000.0
        and s["IDN"]["lo"][0] == pytest.approx(2700000.0)
        and s["IDN"]["hi"][-1] == pytest.approx(1.1 * (3000000.0 - 40000))
    )

    gap = tmp_path / "gap.xlsx"
    write_xlsx(
        gap,
        [("IDN", "Indonesia", series(1.0)[:40])],
        years=[y for y in YEARS if y != 2000],
    )
    with pytest.raises(ValueError, match="years"):
        read_stats(gap)

    swapped = tmp_path / "swapped.xlsx"
    write_xlsx(
        swapped,
        [("IDN", "Indonesia", series(10.0)), ("ABW", "Aruba", series(1.0))],
        lo_rows=[("ABW", "Aruba", series(1.0)), ("IDN", "Indonesia", series(10.0))],
    )
    with pytest.raises(ValueError, match="lower95th"):
        read_stats(swapped)

    outside = tmp_path / "outside.xlsx"
    write_xlsx(outside, [("IDN", "Indonesia", series(10.0))], lo_scale=1.2)
    with pytest.raises(ValueError, match="IDN.*1985"):
        read_stats(outside)


def test_load_units_merges_parts_per_iso_and_falls_back_to_adm0(tmp_path):
    ne = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "ISO_A3": "GUF",
                    "ADM0_A3": "FRA",
                    "ADMIN": "France",
                    "NAME": "Fr. Guiana",
                },
                "geometry": {"type": "Polygon", "coordinates": SQ},
            },
            {
                "type": "Feature",
                "properties": {
                    "ISO_A3": "IDN",
                    "ADM0_A3": "IDN",
                    "ADMIN": "Indonesia",
                    "NAME": "Indonesia",
                },
                "geometry": {"type": "Polygon", "coordinates": SQ},
            },
            {
                "type": "Feature",
                "properties": {
                    "ISO_A3": "IDN",
                    "ADM0_A3": "IDN",
                    "ADMIN": "Indonesia",
                    "NAME": "Indonesia",
                },
                "geometry": {"type": "MultiPolygon", "coordinates": [SQ2, SQ]},
            },
            {
                "type": "Feature",
                "properties": {
                    "ISO_A3": "-99",
                    "ADM0_A3": "NOR",
                    "ADMIN": "Norway",
                    "NAME": "Norway",
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [[0.123456, 0.987654], [1, 0], [1, 1], [0.123456, 0.987654]]
                    ],
                },
            },
        ],
    }
    p = tmp_path / "mu.geojson"
    p.write_text(json.dumps(ne))
    u = load_units(p)
    assert set(u) == {"GUF", "IDN", "NOR"}
    assert u["IDN"]["type"] == "MultiPolygon" and len(u["IDN"]["coordinates"]) == 3
    assert u["GUF"]["coordinates"] == [SQ]
    assert u["NOR"]["coordinates"][0][0][0] == [0.12, 0.99]


def test_build_keeps_countries_with_shapes_and_names_the_rest():
    stats = {
        "IDN": {
            "name": "Indonesia",
            "ha": series(100.04),
            "lo": series(90.0),
            "hi": series(110.0),
        },
        "BES_B": {
            "name": "Bonaire",
            "ha": series(238.0),
            "lo": series(200.0),
            "hi": series(260.0),
        },
        "ZZZ": {
            "name": "Never mangrove",
            "ha": [0.0] * 41,
            "lo": [0.0] * 41,
            "hi": [0.0] * 41,
        },
    }
    units = {
        "IDN": {"type": "MultiPolygon", "coordinates": [SQ]},
        "ZZZ": {"type": "MultiPolygon", "coordinates": [SQ]},
    }
    feats, missing = build(stats, units)
    assert [f["properties"]["iso"] for f in feats] == ["IDN"], (
        "a country with no mangrove in any year is not drawn"
    )
    p = feats[0]["properties"]
    assert (
        p["name"] == "Indonesia"
        and len(p["ha"]) == 41
        and p["ha"][0] == 100.0
        and p["lo"][0] == 90.0
    )
    assert missing == [{"iso": "BES_B", "name": "Bonaire", "ha_last": 278.0}]


def test_main_refuses_a_download_whose_checksum_does_not_match(tmp_path):
    xlsx = tmp_path / "src.xlsx"
    write_xlsx(xlsx, [("IDN", "Indonesia", series(100.0))])
    good_md5 = hashlib.md5(xlsx.read_bytes()).hexdigest()
    mu = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"ISO_A3": "IDN", "ADM0_A3": "IDN", "ADMIN": "Indonesia"},
                "geometry": {"type": "Polygon", "coordinates": SQ},
            }
        ],
    }

    def fetch(url):
        return (
            xlsx.read_bytes()
            if url.endswith(("content", ".xlsx"))
            else json.dumps(mu).encode()
        )

    out = tmp_path / "gmw.geojson"
    main(
        ["--out", str(out), "--cache", str(tmp_path / "c1")],
        fetch_bytes=fetch,
        md5=good_md5,
    )
    gj = json.loads(out.read_text())
    assert gj["years"] == [1985, 2025]
    assert (
        gj["source"]["doi"] == "10.5281/zenodo.21346457"
        and "CC BY 4.0" in gj["source"]["licence"]
    )
    assert gj["missing"] == [] and len(gj["features"]) == 1

    with pytest.raises(SystemExit, match="md5"):
        main(
            ["--out", str(tmp_path / "bad.geojson"), "--cache", str(tmp_path / "c2")],
            fetch_bytes=fetch,
            md5="0" * 32,
        )
    assert not (tmp_path / "bad.geojson").exists()
