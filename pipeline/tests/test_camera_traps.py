"""Camera traps and eDNA per 1° cell from a GBIF SQL download (spec 2026-10-03-camera-traps-edna-design.md).

The method rule is tested by running the query's own SQL text in DuckDB over a planted `occurrence` table, so the test
reads the shipped query, not a copy of its rule. DuckDB renders CONCAT_WS over a list as "[a, b]" where GBIF joins with
"|"; the rule only asks whether a phrase is a substring, which either form keeps.
"""

import io
import json
import zipfile

import numpy as np
import pytest
from PIL import Image

# a hard import: CI without duckdb must fail, not skip
import duckdb
from pipeline import camera_traps as ct

DS1 = "0a0b594e-0c5e-4766-a5d7-66043160de5f"
DS2 = "11111111-2222-3333-4444-555555555555"
KEY = "0009014-260928105237408"


def _occurrences(rows):
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE occurrence (samplingprotocol VARCHAR[], license VARCHAR, hascoordinate BOOLEAN, "
        "hasgeospatialissues BOOLEAN, occurrencestatus VARCHAR, kingdom VARCHAR, decimallatitude DOUBLE, "
        "decimallongitude DOUBLE, datasetkey VARCHAR, species VARCHAR)"
    )
    base = dict(
        license="CC_BY_4_0",
        hascoordinate=True,
        hasgeospatialissues=False,
        occurrencestatus="PRESENT",
        kingdom="Animalia",
        decimallatitude=46.5,
        decimallongitude=7.5,
        datasetkey=DS1,
        species="Vulpes vulpes",
    )
    for protocols, extra in rows:
        r = {**base, **extra, "samplingprotocol": protocols}
        con.execute(
            "INSERT INTO occurrence VALUES ($samplingprotocol, $license, $hascoordinate, $hasgeospatialissues, "
            "$occurrencestatus, $kingdom, $decimallatitude, $decimallongitude, $datasetkey, $species)",
            r,
        )
    return con


def _run(con, bbox=None):
    return sorted(
        (k, int(lat), int(lon), d, s, n)
        for k, lat, lon, d, s, n in con.execute(ct.query(bbox)).fetchall()
    )


# Protocols as GBIF records carry them (most seen 2026-10-03), each caught by exactly one phrase of METHODS: a phrase
# dropped from METHODS leaves one of these unmatched. Written out, not built from METHODS, so the test cannot follow it.
CAMERA_SEEN = [
    "camera trapping",
    "Camera trap",
    "cameratrap",
    "camera-trap grid",
    "camera - surveillance/remote",
    "observed-remote camera",
    "Video taken using a remote camera",
    "photo trap",
    "Trail camera survey",
]
EDNA_SEEN = [
    "edna expeditions citizen science sampling",
    "eDNA sampling from soil",
    "e-DNA water sample",
    "Environmental DNA metabarcoding",
]


def test_a_record_counts_by_what_its_own_protocol_names():
    rows = [([p], {"species": f"cam {p}"}) for p in CAMERA_SEEN]
    rows += [([p], {"species": f"dna {p}"}) for p in EDNA_SEEN]
    rows += [
        (
            ["Remote sensing camera image"],
            {"species": "satellite"},
        ),  # imagery, not a trap
        (["photo_plot_surveys"], {"species": "plot"}),
        (["orthophoto and ground surveys"], {"species": "ortho"}),
        (
            ["DNA extraction from the rhizosphere"],
            {"species": "barcode"},
        ),  # DNA, but not said to be environmental
        (
            ["eDNA sampling from soil"],
            {"species": "bacterium", "kingdom": "Bacteria"},
        ),  # not an animal
        (["camera trap"], {"species": "nc", "license": "CC_BY_NC_4_0"}),
        (["camera trap"], {"species": "absent", "occurrencestatus": "ABSENT"}),
        (["camera trap"], {"species": "bad coords", "hasgeospatialissues": True}),
        (["camera trap"], {"species": "no coords", "hascoordinate": False}),
        ([], {"species": "no protocol"}),
        (None, {"species": "null protocol"}),
        (["eDNA survey", "camera trap"], {"species": "both"}),  # camera wins
        (
            ["camera trap"],
            {
                "species": "cc0",
                "license": "CC0_1_0",
                "decimallatitude": -0.5,
                "decimallongitude": -179.5,
            },
        ),
    ]
    got = _run(_occurrences(rows))
    want = sorted(
        [("camera", 46, 7, DS1, f"cam {p}", 1) for p in CAMERA_SEEN]
        + [("edna", 46, 7, DS1, f"dna {p}", 1) for p in EDNA_SEEN]
        + [("camera", 46, 7, DS1, "both", 1), ("camera", -1, -180, DS1, "cc0", 1)]
    )
    assert got == want


def test_the_bbox_narrows_the_query_and_records_group_by_cell_dataset_and_species():
    rows = [
        (["camera trap"], {}),
        (["camera trap"], {}),
        (["camera trap"], {"datasetkey": DS2}),
        (["camera trap"], {"decimallatitude": 10.2, "decimallongitude": 20.9}),
    ]
    con = _occurrences(rows)
    assert _run(con) == [
        ("camera", 10, 20, DS1, "Vulpes vulpes", 1),
        ("camera", 46, 7, DS1, "Vulpes vulpes", 2),
        ("camera", 46, 7, DS2, "Vulpes vulpes", 1),
    ]
    assert _run(con, (5, 45, 11, 48)) == [
        ("camera", 46, 7, DS1, "Vulpes vulpes", 2),
        ("camera", 46, 7, DS2, "Vulpes vulpes", 1),
    ]


def _zip(text, names=("a.csv",)):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n in names:
            z.writestr(n, text)
    return buf.getvalue()


TSV = (
    "\t".join(ct.COLUMNS)
    + "\n"
    + "\n".join(
        [
            f"camera\t46\t7\t{DS1}\tCapreolus capreolus\t146",
            f"camera\t46\t7\t{DS1}\tSus scrofa\t54",
            f"camera\t46\t7\t{DS2}\tSus scrofa\t10",
            f"camera\t46\t7\t{DS2}\t\t7",  # not identified to species: a record, not a species
            f"camera\t46\t7\t{DS2}\tMeles meles\t64",
            f"camera\t46\t7\t{DS2}\tVulpes vulpes\t9",
            f"edna\t90\t180\t{DS2}\tGadus morhua\t3",  # the pole and the antimeridian fold into the last cell
            f"edna\t-12\t-77\t{DS1}\tEngraulis ringens\t2",
        ]
    )
    + "\n"
)


def test_the_download_file_is_read_only_when_it_is_the_one_asked_for():
    rows = ct.read_rows(_zip(TSV))
    assert len(rows) == 8 and rows[6] == {
        "kind": "edna",
        "lat": 89,
        "lon": 179,
        "dataset": DS2,
        "species": "Gadus morhua",
        "n": 3,
    }
    bad = [
        _zip(TSV.replace("datasetkey", "dataset")),
        _zip(TSV, names=("a.csv", "b.csv")),
        _zip(TSV.replace("edna\t-12", "acoustic\t-12")),
        _zip(TSV.replace(DS1, "not-a-key")),
    ]
    for b in bad:
        with pytest.raises(ct.DownloadError):
            ct.read_rows(b)


def test_cells_sum_records_count_species_and_datasets_and_name_the_three_most_recorded():
    cells = ct.aggregate(ct.read_rows(_zip(TSV)))
    # Sus scrofa 54 + 10 = 64 across two datasets ties Meles meles 64: the name breaks the tie; Vulpes vulpes 9 is fourth
    assert cells["camera"] == [
        [46, 7, 290, 4, 2, ["Capreolus capreolus", "Meles meles", "Sus scrofa"]]
    ]
    assert cells["edna"] == [
        [-12, -77, 2, 1, 1, ["Engraulis ringens"]],
        [89, 179, 3, 1, 1, ["Gadus morhua"]],
    ]


def test_each_method_renders_its_own_ramp_one_pixel_per_cell():
    cells = ct.aggregate(ct.read_rows(_zip(TSV)))
    im = Image.open(io.BytesIO(ct.render(cells["camera"], ct.RAMPS["camera"])))
    px = np.array(im)
    pal = im.getpalette()
    assert (
        px.shape == (180, 360) and px[89 - 46, 7 + 180] == 2
    )  # 290 records: the hundreds
    assert pal[6:9] == list(ct.RAMPS["camera"][2]) and (px == 7).sum() == 180 * 360 - 1
    with pytest.raises(ValueError, match="7 colours"):
        ct.render(cells["camera"], ct.RAMPS["camera"][:6])


class FakeGbif:
    """GBIF's download and dataset endpoints, answering from planted state; records every URL asked."""

    def __init__(
        self, statuses=("PREPARING", "RUNNING", "SUCCEEDED"), tsv=TSV, key=KEY
    ):
        self.statuses, self.tsv, self.key, self.asked = list(statuses), tsv, key, []

    def __call__(self, url, data=None, headers=None, timeout=120):
        self.asked.append(url)
        if url.endswith("/occurrence/download/request"):
            assert headers["Authorization"].startswith("Basic ")
            return self.key.encode()
        if url.endswith(f"/occurrence/download/{KEY}"):
            status = (
                self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
            )
            return json.dumps(
                {
                    "key": KEY,
                    "status": status,
                    "doi": "10.15468/dl.test",
                    "created": "2026-10-03T08:00:00",
                    "downloadLink": "https://x/dl.zip",
                }
            ).encode()
        if url == "https://x/dl.zip":
            return _zip(self.tsv)
        if "/dataset/" in url:
            return json.dumps(
                {"title": f"Dataset {url.rsplit('/', 1)[1][:4]}"}
            ).encode()
        raise AssertionError(url)


def test_submit_and_wait_follow_the_download_to_success_and_stop_on_failure():
    gbif = FakeGbif()
    assert ct.submit("SELECT 1", "Basic x", gbif) == KEY
    assert ct.wait(KEY, gbif, sleep=lambda s: None)["status"] == "SUCCEEDED"
    with pytest.raises(ct.DownloadError, match="not a download key"):
        ct.submit("SELECT 1", "Basic x", FakeGbif(key="<html>maintenance</html>"))
    with pytest.raises(ct.DownloadError, match="ended FAILED"):
        ct.wait(KEY, FakeGbif(statuses=("RUNNING", "FAILED")), sleep=lambda s: None)
    with pytest.raises(ct.DownloadError, match="still RUNNING"):
        ct.wait(
            KEY,
            FakeGbif(statuses=("RUNNING",)),
            sleep=lambda s: None,
            poll=60,
            limit=120,
        )


def test_a_status_poll_that_cannot_reach_gbif_is_tried_again_a_few_times_and_a_4xx_never():
    import urllib.error

    def flaky(errors):
        gbif, left = FakeGbif(), list(errors)

        def open_(url, *a, **kw):
            if "/occurrence/download/" in url and left:
                err = left.pop(0)
                if err is not None:  # None: this poll gets through
                    raise err
            return gbif(url, *a, **kw)

        return open_

    drop = urllib.error.URLError(OSError(101, "Network is unreachable"))
    busy = urllib.error.HTTPError("u", 503, "Service Unavailable", {}, None)
    # positive control: two drops and a 503, then the download is followed to success
    assert ct.wait(KEY, flaky([drop, drop, busy]), sleep=lambda s: None)["status"] == "SUCCEEDED"
    with pytest.raises(ct.DownloadError, match="unreachable 5 polls in a row"):
        ct.wait(KEY, flaky([drop] * 5), sleep=lambda s: None)
    # in a row, not in all: a poll that gets through starts the count again
    assert ct.wait(KEY, flaky([drop] * 4 + [None] + [drop] * 4), sleep=lambda s: None)["status"] == "SUCCEEDED"
    gone = urllib.error.HTTPError("u", 404, "Not Found", {}, None)
    with pytest.raises(urllib.error.HTTPError) as e:
        ct.wait(KEY, flaky([gone]), sleep=lambda s: None)
    assert e.value.code == 404


def test_credentials_come_from_the_environment_or_the_file_and_neither_stops_the_run(
    tmp_path, monkeypatch
):
    f = tmp_path / "credentials"
    f.write_text("username=alice\npassword=s3cret=x\n")
    monkeypatch.delenv("GBIF_USER", raising=False)
    monkeypatch.delenv("GBIF_PASS", raising=False)
    assert ct.credentials(f) == "Basic " + "YWxpY2U6czNjcmV0PXg="  # alice:s3cret=x
    monkeypatch.setenv("GBIF_USER", "bob")
    monkeypatch.setenv("GBIF_PASS", "pw")
    assert ct.credentials(tmp_path / "none") == "Basic Ym9iOnB3"  # bob:pw
    monkeypatch.delenv("GBIF_USER")
    with pytest.raises(SystemExit, match="no GBIF account"):
        ct.credentials(tmp_path / "none")


def test_main_writes_both_images_the_listing_and_the_manifest_last_and_nothing_on_a_bad_download(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("GBIF_USER", "u")
    monkeypatch.setenv("GBIF_PASS", "p")
    out, staging = tmp_path / "out", tmp_path / "staging"
    gbif = FakeGbif()
    assert (
        ct.main(
            ["--out-dir", str(out), "--staging", str(staging)],
            open_=gbif,
            sleep=lambda s: None,
        )
        == 0
    )
    doc = json.loads((out / "camera_traps.json").read_text())
    assert doc["download"] == {
        "key": KEY,
        "doi": "10.15468/dl.test",
        "created": "2026-10-03T08:00:00",
    }
    assert doc["methods"]["camera"]["cells"] == [
        [46, 7, 290, 4, 2, ["Capreolus capreolus", "Meles meles", "Sus scrofa"]]
    ]
    assert (
        doc["methods"]["camera"]["records"],
        doc["methods"]["camera"]["datasets"],
    ) == (290, 2)
    assert (doc["methods"]["edna"]["records"], doc["methods"]["edna"]["datasets"]) == (
        5,
        2,
    )
    listing = json.loads((out / "camera_traps_datasets.json").read_text())["datasets"]
    assert listing[0] == {"id": DS1, "title": "Dataset 0a0b", "camera": 200, "edna": 2}
    for name in ("camera_traps.png", "edna.png"):
        assert Image.open(out / name).size == (360, 180)
    m = {p.name: p.stat().st_mtime_ns for p in out.iterdir()}
    assert m["camera_traps.json"] == max(m.values())

    # a rerun with the key reads the staged zip: no request, no status poll, no titles asked again
    again = FakeGbif()
    ct.main(
        ["--out-dir", str(out), "--staging", str(staging), "--download", KEY],
        open_=again,
        sleep=lambda s: None,
    )
    assert again.asked == []

    # a download whose file is not this query's writes nothing
    bad_out = tmp_path / "bad"
    with pytest.raises(ct.DownloadError):
        ct.main(
            ["--out-dir", str(bad_out), "--staging", str(tmp_path / "s2")],
            open_=FakeGbif(tsv=TSV.replace("species", "taxon")),
            sleep=lambda s: None,
        )
    assert not bad_out.exists()

    # a download that matches nothing is a broken query, not an empty world: nothing written, a bbox run included
    camera_only = "\n".join(r for r in TSV.split("\n") if not r.startswith("edna"))
    for tsv, extra, why in [
        (TSV.split("\n", 1)[0] + "\n", [], "no camera or edna records"),
        (TSV.split("\n", 1)[0] + "\n", ["--bbox", "5,45,11,48"], "no camera or edna"),
        (camera_only, [], "no edna records"),
    ]:
        empty_out = tmp_path / "empty"
        with pytest.raises(ct.DownloadError, match=why):
            ct.main(
                ["--out-dir", str(empty_out), "--staging", str(tmp_path / "s3"), *extra],
                open_=FakeGbif(tsv=tsv),
                sleep=lambda s: None,
            )
        assert not empty_out.exists()
        for p in (tmp_path / "s3").glob("*.zip"):
            p.unlink()
    # positive control: a check run over a box with camera traps and no eDNA writes its layers
    box_out = tmp_path / "box"
    ct.main(
        ["--out-dir", str(box_out), "--staging", str(tmp_path / "s4"), "--bbox", "5,45,11,48"],
        open_=FakeGbif(tsv=camera_only),
        sleep=lambda s: None,
    )
    assert json.loads((box_out / "camera_traps.json").read_text())["methods"]["edna"]["records"] == 0
