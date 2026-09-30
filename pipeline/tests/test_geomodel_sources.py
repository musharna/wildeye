"""pipeline.geomodel_sources: the harness's inputs, tested on real file bytes and on URL-checked fakes."""

import urllib.parse
from pathlib import Path

import numpy as np
import pytest

from pipeline import geomodel_sources as gs
from pipeline.tests.test_mvt import _tile

FIXTURES = Path(__file__).parent / "fixtures"


def test_reads_species_ranges_from_a_real_geopackage():
    # geomodel_amphibia_2rows.gpkg: three rows copied verbatim from iNaturalist_geomodel_Amphibia.gpkg (v2.34)
    ranges = list(gs.species_ranges(FIXTURES / "geomodel_amphibia_2rows.gpkg"))
    assert {r.name for r in ranges} == {
        "Capensibufo rosei",
        "Plethodon stormi",
    }  # the genus row is not a species
    by = {r.name: r for r in ranges}
    assert all(r.version == "2.34" for r in ranges)
    # Capensibufo rosei is a South African toad and Plethodon stormi an Oregon/California salamander
    lon, lat = by["Capensibufo rosei"].geom.centroid.coords[0]
    assert 17 < lon < 21 and -35 < lat < -32
    lon, lat = by["Plethodon stormi"].geom.centroid.coords[0]
    assert -125 < lon < -121 and 40 < lat < 43


def test_rejects_a_blob_that_is_not_a_geopackage_geometry():
    with pytest.raises(gs.SourceError, match="GeoPackage"):
        gs.geometry_from_gpkg(b"\x01\x03\x00\x00\x00")


def test_collection_files_follow_the_bucket_names():
    meta = {"collections": {"Amphibia": {"archives": 1}, "Aves": {"archives": 2}}}
    assert gs.collection_files("Amphibia", meta) == [
        "iNaturalist_geomodel_Amphibia.gpkg"
    ]
    assert gs.collection_files("Aves", meta) == [
        "iNaturalist_geomodel_Aves_1.gpkg",
        "iNaturalist_geomodel_Aves_2.gpkg",
    ]


def test_effort_grid_is_all_records_minus_inaturalist_and_minus_excluded_taxa():
    calls = []

    def tile(url):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        calls.append(q)
        assert (
            q["license"] == ["CC0_1_0", "CC_BY_4_0"]
            and q["bin"] == ["square"]
            and q["squareSize"] == ["128"]
        )
        if not url.split("/adhoc/")[1].startswith("4/0/0."):
            return b""
        inat = "datasetKey" in q
        if q["taxonKey"] == ["1"]:  # Animalia
            return _tile([(0, 0, 128, 40 if inat else 100)])
        return _tile([(0, 0, 128, 10 if inat else 30)])  # the excluded classes together

    grid = gs.effort_grid("OtherAnimalia", get_tile=tile)
    # (100 - 40) animals not from iNaturalist, minus (30 - 10) of those in the excluded classes
    assert grid[0, 0] == 40 and grid.sum() == 40
    # z4, not z3: GBIF's adhoc tiles at z3 misplace records by more than a cell (L1 error 1.6-2.6x the
    # records in 6x6-cell blocks checked against occurrence search, 2026-09-29); z4 and z5 agree at 0.08-0.22
    assert len(calls) == 4 * 256  # 4 terms per tile, 256 tiles at z4
    assert gs.effort_grid("Aves", get_tile=tile)[0, 0] == 20  # 30 - 10


def test_background_lands_where_the_counts_are():
    rng = np.random.default_rng(1)
    grid = np.zeros((512, 512), dtype=np.int64)
    grid[0, 0] = 3  # north-west corner cell: lon -180..-179.30, lat ~85.05..85.01
    grid[256, 256] = 1  # the cell just south-east of lon 0, lat 0
    pts = gs.sample_background(grid, 4000, rng)
    nw = (pts[:, 0] < -179) & (pts[:, 1] > 84.9)
    centre = (
        (pts[:, 0] >= 0) & (pts[:, 0] < 0.71) & (pts[:, 1] <= 0) & (pts[:, 1] > -0.71)
    )
    assert nw.sum() + centre.sum() == 4000
    assert nw.mean() == pytest.approx(0.75, abs=0.03)
    with pytest.raises(gs.SourceError, match="empty"):
        gs.sample_background(np.zeros((512, 512)), 10, rng)


def _fake_search(records, count):
    urls = []

    def get_json(url):
        urls.append(url)
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        if q["limit"] == ["0"]:
            return {"count": count}
        return {"results": records}

    return get_json, urls


def test_presences_drop_inaturalist_records_and_ask_for_open_licences():
    recs = [
        {
            "key": 1,
            "datasetKey": "ebird",
            "decimalLongitude": 1.0,
            "decimalLatitude": 2.0,
        },
        {
            "key": 2,
            "datasetKey": gs.INAT_DATASET,
            "decimalLongitude": 3.0,
            "decimalLatitude": 4.0,
        },
        {
            "key": 3,
            "datasetKey": "museum",
            "decimalLongitude": 5.0,
            "decimalLatitude": 6.0,
        },
    ]
    get_json, urls = _fake_search(recs, 3)
    pts = gs.occurrence_points(
        99, inat=False, want=500, rng=np.random.default_rng(0), get_json=get_json
    )
    assert sorted(map(tuple, pts)) == [(1.0, 2.0), (5.0, 6.0)]
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(urls[0]).query)
    assert (
        q["license"] == ["CC0_1_0", "CC_BY_4_0"]
        and "datasetKey" not in q
        and q["hasGeospatialIssue"] == ["false"]
    )
    # the model's own records: iNaturalist only, any licence
    get_json, urls = _fake_search(recs[1:2], 1)
    pts = gs.occurrence_points(
        99, inat=True, want=500, rng=np.random.default_rng(0), get_json=get_json
    )
    assert pts.tolist() == [[3.0, 4.0]]
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(urls[0]).query)
    assert q["datasetKey"] == [gs.INAT_DATASET] and "license" not in q


def test_verify_group_keys_stops_on_a_moved_key():
    names = {
        k: n
        for spec in gs.GROUPS.values()
        for k, n in {**spec["include"], **spec.get("exclude", {})}.items()
    }
    ok = lambda url: {"canonicalName": names[int(url.rsplit("/", 1)[1])]}  # noqa: E731
    gs.verify_group_keys(ok)
    moved = lambda url: {
        "canonicalName": "Reptilia"
        if url.endswith("/11592253")
        else names[int(url.rsplit("/", 1)[1])]
    }  # noqa: E731
    with pytest.raises(
        gs.SourceError, match="11592253 is 'Reptilia', expected 'Squamata'"
    ):
        gs.verify_group_keys(moved)


def test_match_species_takes_only_exact_species_matches():
    answers = {
        "Turdus migratorius": {
            "matchType": "EXACT",
            "rank": "SPECIES",
            "usageKey": 9510564,
        },
        "Old name": {
            "matchType": "EXACT",
            "rank": "SPECIES",
            "usageKey": 1,
            "acceptedUsageKey": 2,
        },
        "Turdus": {"matchType": "EXACT", "rank": "GENUS", "usageKey": 5},
        "Typo": {"matchType": "FUZZY", "rank": "SPECIES", "usageKey": 6},
    }
    get = lambda url: answers[
        urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["name"][0]
    ]  # noqa: E731
    assert gs.match_species("Turdus migratorius", get) == 9510564
    assert gs.match_species("Old name", get) == 2
    assert gs.match_species("Turdus", get) is None
    assert gs.match_species("Typo", get) is None


def _http_error(code, body):
    import io
    import urllib.error

    return urllib.error.HTTPError("https://api.gbif.org/x", code, "err", {}, io.BytesIO(body.encode()))


def test_fetch_tile_reads_gbifs_filtered_empty_400_as_no_records(monkeypatch):
    import urllib.request

    answers = {
        "empty": _http_error(400, gs.EMPTY_TILE_BODY),
        "bad": _http_error(400, "Invalid taxonKey"),
    }

    class Ok:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"tile-bytes"

    def fake_urlopen(req, timeout=None):
        which = req.full_url.rsplit("/", 1)[1]
        if which == "ok":
            return Ok()
        raise answers[which]

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    assert gs.fetch_tile("https://api.gbif.org/ok") == b"tile-bytes"
    assert gs.fetch_tile("https://api.gbif.org/empty") == b""
    with pytest.raises(gs.SourceError, match="400"):
        gs.fetch_tile("https://api.gbif.org/bad")


def _block_sources(truth: dict, shift_rows: int):
    """Fakes for placement_error: GBIF search answers `truth` (cell -> count); the tiles put each count
    `shift_rows` cells south of where search has it."""
    per = 4096 // gs.SQUARE

    def get_tile(url):
        z, x, y = (int(v) for v in url.split("/adhoc/")[1].split(".")[0].split("/"))
        assert z == gs.TILE_ZOOM
        feats = [
            ((c - x * per) * gs.SQUARE, (r + shift_rows - y * per) * gs.SQUARE, gs.SQUARE, n)
            for (r, c), n in truth.items()
            if r + shift_rows in range(y * per, (y + 1) * per) and c in range(x * per, (x + 1) * per)
        ]
        return _tile(feats) if feats else b""

    def get_json(url):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert q["license"] == ["CC0_1_0", "CC_BY_4_0"] and q["limit"] == ["0"]
        la0, la1 = (float(v) for v in q["decimalLatitude"][0].split(","))
        lo0, lo1 = (float(v) for v in q["decimalLongitude"][0].split(","))
        return {"count": truth.get(gs._lonlat_to_cell((lo0 + lo1) / 2, (la0 + la1) / 2), 0)}

    return get_tile, get_json


def test_placement_error_reads_misplaced_tiles():
    r0, c0 = gs._lonlat_to_cell(7.0, 47.5)
    rng = np.random.default_rng(4)
    truth = {(r0 + i, c0 + j): int(rng.integers(1, 1000)) for i in range(6) for j in range(6)}
    # tiles that put every record in its own cell agree with search exactly
    get_tile, get_json = _block_sources(truth, 0)
    assert gs.placement_error(7.0, 47.5, 212, get_tile=get_tile, get_json=get_json) == 0.0
    # tiles that put every record one cell south, as GBIF's z3 adhoc tiles did, do not
    get_tile, get_json = _block_sources(truth, 1)
    assert gs.placement_error(7.0, 47.5, 212, get_tile=get_tile, get_json=get_json) > 0.4


class _FakeGbif:
    """GBIF occurrence search over known records, in an index order that groups them by place (as GBIF's
    does, by dataset). Pages past offset 10,000 are refused: live, they take minutes."""

    def __init__(self, lon, lat):
        self.lon, self.lat, self.requests = np.asarray(lon, float), np.asarray(lat, float), []

    def __call__(self, url):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.requests.append(q)
        m = np.ones(len(self.lon), bool)
        if "decimalLatitude" in q:
            a, b = (float(v) for v in q["decimalLatitude"][0].split(","))
            m &= (self.lat >= a) & (self.lat <= b)
        if "decimalLongitude" in q:
            a, b = (float(v) for v in q["decimalLongitude"][0].split(","))
            m &= (self.lon >= a) & (self.lon <= b)
        idx = np.flatnonzero(m)
        limit, offset = int(q["limit"][0]), int(q.get("offset", ["0"])[0])
        assert offset + limit <= 10_000, f"deep page requested: offset {offset}"
        page = idx[offset : offset + limit]
        results = [{"key": int(i), "datasetKey": "d", "decimalLongitude": self.lon[i], "decimalLatitude": self.lat[i]} for i in page]
        return {"count": int(len(idx)), "results": results}


def test_presences_are_a_spatial_random_sample_of_a_common_species():
    rng = np.random.default_rng(3)
    n_b, n_a = 30_000, 120_000  # 20% in B (indexed first), 80% in A
    lon = np.concatenate([rng.uniform(-100, -90, n_b), rng.uniform(0, 10, n_a)])
    lat = np.concatenate([rng.uniform(30, 40, n_b), rng.uniform(40, 50, n_a)])
    gbif = _FakeGbif(lon, lat)
    pts = gs.occurrence_points(99, inat=False, want=500, rng=np.random.default_rng(0), get_json=gbif)
    assert len(pts) == 500
    # the first 10,000 records are all B; a sample of the species is ~80% A
    assert (pts[:, 0] >= 0).mean() == pytest.approx(0.8, abs=0.15)
    # positive control in the same test: a rare species comes back whole
    few = _FakeGbif(rng.uniform(0, 10, 420), rng.uniform(40, 50, 420))
    assert len(gs.occurrence_points(99, inat=False, want=500, rng=np.random.default_rng(0), get_json=few)) == 420
    # and one with a few thousand records is read in full and subsampled, not taken in clustered pages
    mid = _FakeGbif(np.r_[rng.uniform(-100, -90, 500), rng.uniform(0, 10, 2000)], np.r_[rng.uniform(30, 40, 500), rng.uniform(40, 50, 2000)])
    pts = gs.occurrence_points(99, inat=False, want=500, rng=np.random.default_rng(0), get_json=mid)
    assert len(pts) == 500 and (pts[:, 0] >= 0).mean() == pytest.approx(0.8, abs=0.06)
    assert sum(int(q["limit"][0]) for q in mid.requests) >= 2500  # every record was read


def test_fetch_backs_off_for_minutes_when_gbif_says_too_many_requests(monkeypatch):
    # GBIF's limit follows server load; a run of hours met 429 and the old 5-40 s backoff gave up
    import urllib.request

    waits, answers = [], [_http_error(429, "Too Many Requests"), _http_error(429, "Too Many Requests")]

    class Ok:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"{}"

    def fake_urlopen(req, timeout=None):
        if answers:
            raise answers.pop(0)
        return Ok()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(gs.time, "sleep", waits.append)
    assert gs.fetch("https://api.gbif.org/v1/occurrence/search?x") == b"{}"
    assert len(waits) == 2 and waits[0] >= 60 and waits[1] > waits[0]
    # positive control in the same test: a request GBIF rejects outright is not retried
    waits.clear()
    answers[:] = [_http_error(400, "Invalid taxonKey")]
    with pytest.raises(gs.SourceError, match="400"):
        gs.fetch("https://api.gbif.org/v1/occurrence/search?bad")
    assert waits == []
