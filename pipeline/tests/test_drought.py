"""U.S. Drought Monitor pipeline. Fixtures are shaped from the real responses fetched 2026-09-12:
`GISData.aspx/ReturnDMWeeks` → {"d": ["20260908", "20260901", "20260825", ...]} and
`/data/json/usdm_20260908.json` → FeatureCollection of 5 MultiPolygons with properties like
{'OBJECTID': 1, 'DM': 0, 'Shape_Length': 1116.745, 'Shape_Area': 209.268} (coordinates lon/lat,
e.g. [-66.37669146899998, 18.48779243000007]).

Mutants verified 2026-09-12 by a green-first harness (restore md5-checked; each named test failed):
- list_weeks: `ymds.sort(reverse=True)` → `ymds.sort()` → test_list_weeks fails (oldest first).
- simplify (shapely): `and p.area >= min_area` removed → sliver survives → [True] fails.
- simplify (pure): `if rings and _ring_area_deg2(rings[0]) >= min_area` → `if rings` → [False] fails (needs the
  tol-0.001 assertion: at tol 0.02 DP alone collapses the sliver, so the area floor was untested; a redundant
  pre-DP area check that made single-check mutants survive was deleted).
- week_features: RELEASE_LAG_DAYS = 3 → released-date assertion fails.
- week_features: `_rnd(simp, nd)` → `simp` → 3-decimal assertion fails (corner -98.00049 survives).
- collection: `"newest": ws[-1]["w"]` → newest assertion fails.
- fetch_week: cache-validation raise → `pass` → test_fetch_week fails; main: `old.unlink()` → `pass` → end-to-end fails.
- _get: `e.code < 500` → `e.code < 400` → the 404 is retried → test_get_retries fails.
"""

import builtins
import datetime as dt
import json
import pytest
from pipeline.drought import (
    list_weeks,
    ymd_to_date,
    fetch_week,
    simplify_multipolygon,
    week_features,
    collection,
    multipolygon_area_km2,
    main,
    CREDIT,
)

WEEKS_RESP = b'{"d":["20260908","20260901","20260825","20260818","20260811","20260804","20260728"]}'

# a coarse D-shaped part with a jagged edge (DP removes the 0.001° wobble) plus a sliver part
BIG = [
    [
        [-100.0, 40.0],
        [-99.5, 40.001],
        [-99.0, 40.0],
        [-98.5, 39.999],
        [-98.0, 40.0],
        [-98.00049, 41.00049],  # 5-decimal corner: the 3-decimal rounding test needs a coordinate that has something to lose
        [-100.0, 41.0],
        [-100.0, 40.0],
    ]
]
HOLE = [[-99.5, 40.4], [-98.5, 40.4], [-98.5, 40.6], [-99.5, 40.6], [-99.5, 40.4]]
SLIVER = [
    [[-90.0, 30.0], [-89.99, 30.0], [-89.99, 30.01], [-90.0, 30.01], [-90.0, 30.0]]
]


def usdm_fc(dms=(0, 1, 2, 3, 4)):
    """Shaped like the real weekly file: 5 features, properties OBJECTID/DM/Shape_Length/Shape_Area."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [[BIG[0], HOLE], SLIVER],
                },
                "properties": {
                    "OBJECTID": i + 1,
                    "DM": dm,
                    "Shape_Length": 1116.7451639195592,
                    "Shape_Area": 209.26892808450629,
                },
            }
            for i, dm in enumerate(dms)
        ],
    }


def test_list_weeks_newest_first_and_capped():
    assert list_weeks(3, fetch=lambda url: WEEKS_RESP) == [
        "20260908",
        "20260901",
        "20260825",
    ]
    assert list_weeks(3, fetch=lambda url: b'{"d":["20260901","20260908"]}') == [
        "20260908",
        "20260901",
    ], "sorted even if the server is not"
    assert ymd_to_date("20260908") == dt.date(2026, 9, 8)
    with pytest.raises(RuntimeError):
        list_weeks(3, fetch=lambda url: b'{"d":[]}')


def test_fetch_week_caches_valid_files_and_rejects_non_collections(tmp_path):
    calls = []

    def fetch(url):
        calls.append(url)
        return json.dumps(usdm_fc()).encode()

    gj = fetch_week("20260908", tmp_path, fetch, sleep=0)
    assert len(gj["features"]) == 5 and calls == [
        "https://droughtmonitor.unl.edu/data/json/usdm_20260908.json"
    ]
    assert (tmp_path / "usdm_20260908.json").exists()
    fetch_week("20260908", tmp_path, fetch, sleep=0)
    assert len(calls) == 1, "second call served from the cache"
    with pytest.raises(RuntimeError):
        fetch_week("20260901", tmp_path, lambda url: b'{"type":"Feature"}', sleep=0)
    assert not (tmp_path / "usdm_20260901.json").exists(), "bad payload not cached"


@pytest.mark.parametrize("with_shapely", [True, False])
def test_simplify_drops_slivers_removes_wobble_keeps_holes_both_backends(
    monkeypatch, with_shapely
):
    if not with_shapely:
        real = builtins.__import__

        def blocked(name, *a, **k):
            if name.startswith("shapely"):
                raise ImportError(name)
            return real(name, *a, **k)

        monkeypatch.setattr(builtins, "__import__", blocked)
    coords = [[BIG[0], HOLE], SLIVER]
    out = simplify_multipolygon(coords, 0.02, 0.002)
    assert len(out) == 1, "sliver (1e-4 deg²) dropped; big part kept (positive control)"
    assert len(out[0]) == 2, "hole preserved"
    assert len(out[0][0]) == 5 and out[0][0][0] == out[0][0][-1], (
        "wobble collapsed to a closed 4-corner ring"
    )
    assert (
        abs(multipolygon_area_km2(out) - multipolygon_area_km2(coords))
        / multipolygon_area_km2(coords)
        < 0.01
    )
    # area floor alone must drop the sliver: at tol 0.001 Douglas–Peucker keeps its 4 corners, so only min_area can
    assert len(simplify_multipolygon(coords, 0.001, 0.002)) == 1, "min_area drops the sliver even when DP keeps it"
    # positive control: with a tolerance below the sliver's size and no area floor, both backends keep it
    assert len(simplify_multipolygon(coords, 0.001, 0.0)) == 2, "min_area 0 keeps the sliver"


def test_week_features_one_per_category_with_release_date_and_rounding():
    feats = week_features("20260908", usdm_fc(dms=(4, 0, 2)))
    assert [f["properties"]["dm"] for f in feats] == [0, 2, 4], (
        "sorted by category, only those present"
    )
    p = feats[0]["properties"]
    assert (
        p["w"] == "2026-09-08"
        and p["released"] == "2026-09-10"
        and p["label"] == "D0 Abnormally dry"
        and p["parts"] == 1
    )
    assert p["area_km2"] == round(multipolygon_area_km2([[BIG[0], HOLE], SLIVER])), (
        "area from the full geometry, before simplification"
    )
    assert all(
        len(str(c[0]).split(".")[1]) <= 3
        for c in feats[0]["geometry"]["coordinates"][0][0]
    ), "3-decimal coordinates"
    with pytest.raises(RuntimeError):
        week_features("20260908", usdm_fc(dms=(5,)))


def test_collection_newest_first_with_credit_line():
    per = {
        "20260908": week_features("20260908", usdm_fc(dms=(0,))),
        "20260901": week_features("20260901", usdm_fc(dms=(0, 1))),
    }
    gj = collection(["20260908", "20260901"], per, dt.date(2026, 9, 12))
    assert gj["newest"] == "2026-09-08" and gj["weeks"] == [
        {"w": "2026-09-08", "released": "2026-09-10"},
        {"w": "2026-09-01", "released": "2026-09-03"},
    ]
    assert (
        gj["counts"] == {"weeks": 2, "features": 3, "parts": 3}
        and gj["source"]["credit"] == CREDIT
    )
    assert (
        "jointly produced by the National Drought Mitigation Center"
        in gj["source"]["credit"]
    )


def test_main_end_to_end_with_seed(tmp_path, monkeypatch):
    import pipeline.drought as m

    monkeypatch.setattr(
        m, "list_weeks", lambda n, fetch=None: ["20260908", "20260901"][:n]
    )
    monkeypatch.setattr(
        m, "fetch_week", lambda ymd, cache, fetch=None, sleep=2.0: usdm_fc()
    )
    (tmp_path / "usdm_20250101.json").write_text(
        "{}"
    )  # stale cache entry must be pruned
    out, seed = tmp_path / "d.geojson", tmp_path / "seed.geojson"
    main(
        [
            "--out",
            str(out),
            "--seed-out",
            str(seed),
            "--weeks",
            "2",
            "--today",
            "2026-09-12",
            "--cache",
            str(tmp_path),
        ]
    )
    gj = json.loads(out.read_text())
    assert (
        len(gj["features"]) == 10
        and gj["newest"] == "2026-09-08"
        and gj["today"] == "2026-09-12"
    )
    s = json.loads(seed.read_text())
    assert (
        len(s["weeks"]) == 1
        and len(s["features"]) == 5
        and "SEED" in s["source"]["note"]
    )
    assert not (tmp_path / "usdm_20250101.json").exists()


def test_get_retries_5xx_then_succeeds_but_raises_4xx_at_once(monkeypatch):
    """Mutant verified: `e.code < 500` → `e.code < 400` → the 404 is retried (calls == 4) → fails."""
    import io
    import urllib.error
    import pipeline.drought as m

    monkeypatch.setattr(m.time, "sleep", lambda s: None)

    def opener(codes):
        calls = []

        def urlopen(req, timeout=0):
            calls.append(req.full_url)
            code = codes[len(calls) - 1]
            if code != 200:
                raise urllib.error.HTTPError(req.full_url, code, "x", {}, io.BytesIO(b""))  # type: ignore[arg-type]
            return io.BytesIO(b'{"d":["20260908"]}')

        return urlopen, calls

    # positive control: 503 then 200 → body returned after one retry
    urlopen, calls = opener([503, 200])
    monkeypatch.setattr(m.urllib.request, "urlopen", urlopen)
    assert m._get(m.WEEKS_API) == b'{"d":["20260908"]}' and len(calls) == 2
    # negative: a 404 is never retried
    urlopen, calls = opener([404, 200, 200, 200])
    monkeypatch.setattr(m.urllib.request, "urlopen", urlopen)
    with pytest.raises(urllib.error.HTTPError):
        m._get(m.WEEKS_API)
    assert len(calls) == 1
