"""Where camera traps and eDNA sampling recorded animals: GBIF records per 1° cell, CC0 and CC BY only → public/data/camera_traps.json.

Spec: docs/superpowers/specs/2026-10-03-camera-traps-edna-design.md. Neither method has a flag of its own in GBIF:
the record's sampling protocol names it, as free text, so a record counts when its lower-cased protocol contains one of
the phrases in METHODS (a rule on the record, not a list of datasets). GBIF's DNA-derived extension is not used: most
of its animal records are specimen barcodes, and its fields are not in the SQL table. One GBIF SQL download does the
grouping on GBIF's side (method, 1° cell, dataset, species), so the file is the aggregate, not millions of rows; the
zip is kept in the staging directory under its download key, and `--download <key>` rebuilds from it without a new
request. Every download has a DOI, cited in the manifest.
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import io
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from .atomic import write_atomic
from .net import urlopen
from .obis_grid import BIN_FLOORS, render

log = logging.getLogger("camera_traps")
API = "https://api.gbif.org/v1"
UA = {"User-Agent": "wildeye/0.1 (camera traps)"}
# A record is in a method when its lower-cased sampling protocol contains one of these. Read off the 1,000 commonest
# protocol values (2026-10-03); "remote camera" catches "observed-remote camera" and "video taken using a remote
# camera" but not "remote sensing camera image" (satellite and aerial imagery).
METHODS = {
    "camera": (
        "camera trap",
        "cameratrap",
        "camera-trap",
        "camera - surveillance",
        "remote camera",
        "photo trap",
        "trail camera",
    ),
    "edna": ("edna", "e-dna", "environmental dna"),
}
LABELS = {"camera": "Camera traps (GBIF)", "edna": "eDNA (GBIF)"}
LICENCES = ("CC0_1_0", "CC_BY_4_0")
# By name: the SQL table's kingdomkey holds the new taxonomy's letter keys (N, P, F...), not the backbone's 1, though
# /describe/sql calls it INT; `kingdomkey = 1` matched nothing (download 0009037-260928105237408, 2026-10-03)
ANIMALIA = "Animalia"
PROTOCOL = "LOWER(CONCAT_WS('|', samplingprotocol))"
COLUMNS = ["kind", "lat", "lon", "datasetkey", "species", "n"]
# Records per cell in decades, one colour each (ColorBrewer, 7 classes): camera Oranges, eDNA Blues; neither is the
# OBIS grid's RdPu, Human Footprint's YlOrRd or the protected areas' greens.
RAMPS = {
    "camera": [
        (254, 237, 222),
        (253, 208, 162),
        (253, 174, 107),
        (253, 141, 60),
        (241, 105, 19),
        (217, 72, 1),
        (140, 45, 4),
    ],
    "edna": [
        (239, 243, 255),
        (198, 219, 239),
        (158, 202, 225),
        (107, 174, 214),
        (66, 146, 198),
        (33, 113, 181),
        (8, 69, 148),
    ],
}
KEY = re.compile(r"\d{7}-\d{15}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TOP = 3

for _phrase in (p for ps in METHODS.values() for p in ps):
    # the phrases go into SQL text: letters, spaces and hyphens only (no quote, and none of LIKE's wildcards)
    assert re.fullmatch(r"[a-z \-]+", _phrase), _phrase


class DownloadError(RuntimeError):
    """The GBIF download failed, or its file is not the one this query asks for: nothing is written."""


def _matches(method: str) -> str:
    return "(" + " OR ".join(f"{PROTOCOL} LIKE '%{p}%'" for p in METHODS[method]) + ")"


def query(bbox: tuple[float, float, float, float] | None = None) -> str:
    """The SQL: CC0 / CC BY animal records present, with clean coordinates, whose protocol names a method, grouped by
    method, 1° cell, dataset and species. Camera wins when a protocol names both. `bbox` (W, S, E, N) for checks."""
    kind = f"CASE WHEN {_matches('camera')} THEN 'camera' ELSE 'edna' END"
    where = [
        "license IN (" + ", ".join(f"'{x}'" for x in LICENCES) + ")",
        "hascoordinate = TRUE",
        "hasgeospatialissues = FALSE",
        "occurrencestatus = 'PRESENT'",
        f"kingdom = '{ANIMALIA}'",
        f"({_matches('camera')} OR {_matches('edna')})",
    ]
    if bbox:
        w, s, e, n = (float(v) for v in bbox)
        where += [
            f"decimallatitude >= {s!r}",
            f"decimallatitude < {n!r}",
            f"decimallongitude >= {w!r}",
            f"decimallongitude < {e!r}",
        ]
    cell = "FLOOR(decimallatitude), FLOOR(decimallongitude)"
    return (
        f"SELECT {kind} AS kind, FLOOR(decimallatitude) AS lat, FLOOR(decimallongitude) AS lon, datasetkey, species, "  # nosec B608 - only constants are interpolated (METHODS phrases asserted [a-z \-]+ at import, LICENCES, ANIMALIA) and the bbox, forced through float(); the SQL is sent to GBIF, which parses it (test_the_bbox_narrows_the_query_and_records_group_by_cell_dataset_and_species)
        f"COUNT(*) AS n FROM occurrence WHERE {' AND '.join(where)} GROUP BY {kind}, {cell}, datasetkey, species"
    )


def credentials(path: Path) -> str:
    """HTTP basic auth for GBIF: GBIF_USER / GBIF_PASS from the environment, else `username=` and `password=` lines."""
    user, pw = os.environ.get("GBIF_USER"), os.environ.get("GBIF_PASS")
    if not (user and pw) and path.exists():
        kv = dict(
            line.strip().split("=", 1)
            for line in path.read_text().splitlines()
            if "=" in line
        )
        user, pw = kv.get("username"), kv.get("password")
    if not (user and pw):
        raise SystemExit(f"no GBIF account: set GBIF_USER / GBIF_PASS or write {path}")
    return "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()


def _open(
    url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 120
) -> bytes:
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urlopen(req, timeout=timeout) as r:
        return r.read()


def validate(sql: str, open_=_open) -> dict:
    """GBIF's own parser on the query (no account needed): its normalised form, or HTTPError with the reason."""
    body = json.dumps({"format": "SQL_TSV_ZIP", "sql": sql}).encode()
    return json.loads(
        open_(
            f"{API}/occurrence/download/request/validate",
            body,
            {"Content-Type": "application/json"},
        )
    )


def submit(sql: str, auth: str, open_=_open) -> str:
    body = json.dumps(
        {"sendNotification": False, "format": "SQL_TSV_ZIP", "sql": sql}
    ).encode()
    key = (
        open_(
            f"{API}/occurrence/download/request",
            body,
            {"Content-Type": "application/json", "Authorization": auth},
        )
        .decode()
        .strip()
    )
    if not KEY.fullmatch(key):
        raise DownloadError(
            f"GBIF answered a download request with {key[:200]!r}, not a download key"
        )
    return key


def wait(
    key: str,
    open_=_open,
    sleep=time.sleep,
    poll: float = 60,
    limit: float = 6 * 3600,
    retries: int = 5,
) -> dict:
    """The download's metadata once it has succeeded; DownloadError if it failed or `limit` seconds pass.

    A poll that cannot reach GBIF, or that GBIF answers 5xx, is tried again at the next poll, up to `retries` in a row:
    the download runs on GBIF's side, and one network drop killed a check run (2026-10-03). A 4xx is never retried.
    """
    waited, failed = 0.0, 0
    while True:
        try:
            meta = json.loads(open_(f"{API}/occurrence/download/{key}"))
            failed = 0
        except urllib.error.URLError as e:
            if isinstance(e, urllib.error.HTTPError) and e.code < 500:
                raise
            failed += 1
            if failed >= retries:
                raise DownloadError(
                    f"GBIF download {key}: status unreachable {failed} polls in a row: {e}"
                ) from e
            log.warning("download %s status poll failed (%d in a row): %s", key, failed, e)
            sleep(poll)
            waited += poll
            continue
        if meta["status"] == "SUCCEEDED":
            return meta
        if meta["status"] in ("FAILED", "KILLED", "CANCELLED", "FILE_ERASED"):
            raise DownloadError(f"GBIF download {key} ended {meta['status']}")
        if waited >= limit:
            raise DownloadError(
                f"GBIF download {key} still {meta['status']} after {waited:.0f} s"
            )
        log.info("download %s %s (%.0f s)", key, meta["status"], waited)
        sleep(poll)
        waited += poll


def read_rows(zip_bytes: bytes) -> list[dict]:
    """The one TSV in the zip as rows; DownloadError unless its header is exactly COLUMNS."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = z.namelist()
        if len(names) != 1:
            raise DownloadError(f"expected one file in the download, found {names}")
        text = z.read(names[0]).decode("utf-8")
    reader = csv.reader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_NONE)
    header = next(reader, None)
    if header != COLUMNS:
        raise DownloadError(f"download columns {header}, expected {COLUMNS}")
    rows = []
    for line in reader:
        kind, lat, lon, dataset, species, n = line
        if kind not in METHODS or not UUID.fullmatch(dataset):
            raise DownloadError(f"unexpected row {line[:6]}")
        rows.append(
            {
                "kind": kind,
                "lat": min(
                    int(float(lat)), 89
                ),  # 90°N and 180°E fold into the last cell
                "lon": min(int(float(lon)), 179),
                "dataset": dataset,
                "species": species,
                "n": int(n),
            }
        )
    return rows


def aggregate(rows: list[dict]) -> dict[str, list[list]]:
    """{method: [[lat, lon, records, species, datasets, [up to 3 species, most records first]], …]}, cells sorted."""
    acc: dict[tuple, dict] = {}
    for r in rows:
        c = acc.setdefault(
            (r["kind"], r["lat"], r["lon"]), {"n": 0, "species": {}, "datasets": set()}
        )
        c["n"] += r["n"]
        c["datasets"].add(r["dataset"])
        if r["species"]:
            c["species"][r["species"]] = c["species"].get(r["species"], 0) + r["n"]
    out: dict[str, list[list]] = {m: [] for m in METHODS}
    for (kind, lat, lon), c in sorted(acc.items()):
        top = sorted(c["species"].items(), key=lambda kv: (-kv[1], kv[0]))[:TOP]
        out[kind].append(
            [
                lat,
                lon,
                c["n"],
                len(c["species"]),
                len(c["datasets"]),
                [s for s, _ in top],
            ]
        )
    return out


def dataset_titles(
    keys: list[str], cache: Path, open_=_open, pause: float = 0.3
) -> dict[str, str]:
    """{dataset key: title} from the GBIF dataset API, cached across runs."""
    known = json.loads(cache.read_text()) if cache.exists() else {}
    for i, k in enumerate(k for k in keys if k not in known):
        known[k] = json.loads(open_(f"{API}/dataset/{k}"))["title"]
        if i % 50 == 49:
            write_atomic(cache, known)
        time.sleep(pause)
    write_atomic(cache, known)
    return {k: known[k] for k in keys}


def build(
    rows: list[dict], meta: dict, titles: dict[str, str]
) -> tuple[dict, list[dict]]:
    """The manifest (without a date) and the dataset listing."""
    cells = aggregate(rows)
    per: dict[str, dict[str, int]] = {}
    for r in rows:
        per.setdefault(r["dataset"], {m: 0 for m in METHODS})[r["kind"]] += r["n"]
    methods = {
        m: {
            "label": LABELS[m],
            "phrases": list(METHODS[m]),
            "image": f"data/{'camera_traps' if m == 'camera' else 'edna'}.png",
            "palette": [list(c) for c in RAMPS[m]],
            "records": sum(c[2] for c in cells[m]),
            "datasets": sum(1 for d in per.values() if d[m]),
            "cells": cells[m],
        }
        for m in METHODS
    }
    doc = {
        "source": "GBIF.org occurrence download (SQL), CC0 1.0 and CC BY 4.0 animal records whose sampling protocol names the method",
        "download": {
            "key": meta["key"],
            "doi": meta["doi"],
            "created": meta.get("created"),
        },
        "cell_degrees": 1,
        "bin_floors": BIN_FLOORS,
        "columns": ["lat", "lon", "records", "species", "datasets", "top_species"],
        "methods": methods,
    }
    listing = [
        {"id": k, "title": titles[k], **{m: v[m] for m in METHODS}}
        for k, v in sorted(per.items(), key=lambda kv: -sum(kv[1].values()))
    ]
    return doc, listing


def main(argv=None, *, open_=_open, sleep=time.sleep, now=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--staging",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "camera_traps",
    )
    ap.add_argument(
        "--credentials",
        type=Path,
        default=Path.home() / ".config" / "gbif" / "credentials",
    )
    ap.add_argument(
        "--download",
        default=None,
        help="an existing download key: rebuild from it, no new request",
    )
    ap.add_argument(
        "--bbox",
        default=None,
        help="W,S,E,N: a small download for checks, not publishing",
    )
    ap.add_argument(
        "--validate-only",
        action="store_true",
        help="print GBIF's parse of the query and stop",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else None
    sql = query(bbox)
    if a.validate_only:
        print(json.dumps(validate(sql, open_), indent=1))
        return 0
    a.staging.mkdir(parents=True, exist_ok=True)
    key = a.download or submit(sql, credentials(a.credentials), open_)
    if not KEY.fullmatch(key):
        raise SystemExit(f"not a GBIF download key: {key!r}")
    log.info("download %s", key)
    zip_path = a.staging / f"{key}.zip"
    meta_path = a.staging / f"{key}.json"
    if not zip_path.exists():
        meta = wait(key, open_, sleep)
        part = zip_path.with_suffix(".zip.part")
        part.write_bytes(open_(meta["downloadLink"], timeout=1800))
        os.replace(part, zip_path)
        write_atomic(meta_path, meta)
    meta = json.loads(meta_path.read_text())
    rows = read_rows(zip_path.read_bytes())
    titles = dataset_titles(
        sorted({r["dataset"] for r in rows}), a.staging / "dataset_titles.json", open_
    )
    doc, listing = build(rows, meta, titles)
    # A query that matches nothing reads as a broken query, not an empty world: the first real run wrote two empty
    # layers and exited 0. A check run (--bbox) may lack one method, never both.
    empty = [m for m, spec in doc["methods"].items() if not spec["records"]]
    if len(empty) == len(METHODS) or (empty and bbox is None):
        raise DownloadError(
            f"download {key} has no {' or '.join(empty)} records: nothing written"
        )
    when = (now or (lambda: dt.datetime.now(dt.timezone.utc)))()
    doc = {"asOf": when.date().isoformat(), **doc}
    write_atomic(
        a.out_dir / "camera_traps_datasets.json",
        {"asOf": doc["asOf"], "datasets": listing},
    )
    for m, spec in doc["methods"].items():
        png = a.out_dir / Path(spec["image"]).name
        png.with_suffix(".png.part").write_bytes(render(spec["cells"], RAMPS[m]))
        os.replace(png.with_suffix(".png.part"), png)
    write_atomic(a.out_dir / "camera_traps.json", doc)  # last: the layers read this one
    for m, spec in doc["methods"].items():
        log.info(
            "%s: %d records in %d cells from %d datasets",
            m,
            spec["records"],
            len(spec["cells"]),
            spec["datasets"],
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
