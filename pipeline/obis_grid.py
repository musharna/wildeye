"""Where marine life has been recorded: OBIS records per 1° cell, CC0 and CC BY datasets only → public/data/obis_grid.json.

Spec: docs/superpowers/specs/2026-10-02-obis-grid-design.md. OBIS's own grid API mixes in non-commercial datasets (about
22% of its records) and gives counts only, so the grid is built from OBIS's open-data export instead: one parquet file
per dataset on AWS (s3://obis-open-data/occurrence/<dataset id>.parquet). A dataset is in only if its licence text is
CC0 or plain CC BY (obis_licences.TABLE, read by hand). DuckDB reads the four columns needed straight over HTTPS, a
dataset at a time, into a local staging file keyed by the dataset's ETag, so a rerun fetches only what changed and an
interrupted run resumes. Records OBIS flags `dropped` (failed its quality checks) or `absence` are left out, as its API
does by default. Every cell lists records, distinct species, datasets and the year span.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import time
import urllib.parse
from pathlib import Path

from .atomic import write_atomic
from .net import urlopen
from .obis_licences import CC0, CC_BY, OUT, licence

log = logging.getLogger("obis_grid")
API = "https://api.obis.org/v3"
BUCKET = "https://obis-open-data.s3.amazonaws.com"
UA = {"User-Agent": "wildeye/0.1 (obis grid)"}
PAGE = 1000
# Records per cell in decades, one colour each (ColorBrewer RdPu, 7 classes): 1–9, 10–99, …, 1,000,000 and more.
# Distinct from Human Footprint's YlOrRd, and light enough to read over the dark ocean.
RAMP = [
    (254, 235, 226),
    (252, 197, 192),
    (250, 159, 181),
    (247, 104, 161),
    (221, 52, 151),
    (174, 1, 126),
    (122, 1, 119),
]
BIN_FLOORS = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000]
NODATA = len(RAMP)  # palette index of a cell with no records: transparent


def _get(url: str, timeout: int = 120) -> bytes:
    import urllib.request

    with urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def datasets(get=_get, pause: float = 2.0) -> list[dict]:
    """Every OBIS dataset: id, title, records and its licence class (LicenceError on a text not yet classed)."""
    out, skip = [], 0
    while True:
        page = json.loads(get(f"{API}/dataset?size={PAGE}&skip={skip}"))
        for d in page["results"]:
            out.append(
                {
                    "id": d["id"],
                    "title": d.get("title") or "",
                    "records": d.get("records") or 0,
                    "licence": licence(d.get("intellectualrights")),
                }
            )
        skip += PAGE
        if skip >= page["total"]:
            break
        time.sleep(pause)
    if len({d["id"] for d in out}) != len(out):
        raise RuntimeError(
            "OBIS dataset listing repeated a dataset: pages shifted during the listing"
        )
    return out


def export_files(get=_get) -> dict[str, str]:
    """{dataset id: ETag} of every occurrence parquet file in the export (paginated S3 listing)."""
    files, token = {}, None
    while True:
        q = {"list-type": "2", "prefix": "occurrence/", "max-keys": "1000"}
        if token:
            q["continuation-token"] = token
        xml = get(f"{BUCKET}/?{urllib.parse.urlencode(q)}").decode()
        for key, etag in re.findall(
            r"<Key>occurrence/([0-9a-f-]{36})\.parquet</Key>.*?<ETag>(?:&quot;|\")?([0-9a-f-]+)(?:&quot;|\")?</ETag>",
            xml,
        ):
            files[key] = etag  # hex and dashes only: with the id it names a staging file that goes into SQL
        m = re.search(r"<NextContinuationToken>([^<]*)</NextContinuationToken>", xml)
        if not m:
            return files
        token = m.group(1)


CELL_SQL = """
SELECT
    CAST(least(floor(interpreted.decimalLatitude), 89) AS INTEGER) AS lat,
    CAST(least(floor(interpreted.decimalLongitude), 179) AS INTEGER) AS lon,
    interpreted.speciesid AS species,
    count(*) AS records,
    min(interpreted.date_year) AS y0,
    max(interpreted.date_year) AS y1
FROM read_parquet($src)
WHERE NOT coalesce(dropped, false) AND NOT coalesce(absence, false)
  AND interpreted.decimalLatitude BETWEEN -90 AND 90
  AND interpreted.decimalLongitude BETWEEN -180 AND 180
GROUP BY ALL
"""


def connect():
    import duckdb

    con = duckdb.connect()
    con.execute("SET enable_progress_bar = false")
    con.execute("INSTALL httpfs")
    con.execute("LOAD httpfs")
    return con


def _sql_path(p: Path) -> str:
    """A local path quoted for a DuckDB statement that takes no parameter there (COPY ... TO, read_parquet lists)."""
    text = str(p)
    if "'" in text:
        raise ValueError(f"path with a quote cannot be quoted for DuckDB: {text}")
    return f"'{text}'"


def stage(con, source: str, dataset_id: str, out: Path) -> int:
    """One dataset's (cell, species) counts from `source` (a parquet URL or path) → `out`; returns its records."""
    tmp = out.with_suffix(".part")
    con.execute(
        f"COPY (SELECT $id::VARCHAR AS dataset, * FROM ({CELL_SQL})) TO {_sql_path(tmp)} (FORMAT parquet)",  # nosec B608 - CELL_SQL is a constant; the path is staging/<uuid>-<hex etag>.parquet, both regex-checked in export_files and quote-refused by _sql_path; id and source are parameters
        {"id": dataset_id, "src": source},
    )
    os.replace(tmp, out)
    return staged_records(con, out)


def staged_records(con, path: Path) -> int:
    sql = f"SELECT coalesce(sum(records), 0) FROM read_parquet({_sql_path(path)})"  # nosec B608 - a staging path (<uuid>-<hex etag>.parquet, regex-checked in export_files), quote-refused by _sql_path
    (n,) = con.execute(sql).fetchone()
    return int(n)


def aggregate(con, staged: list[Path]) -> list[list]:
    """[lat, lon, records, species, datasets, first year, last year] per cell with records, south-west corner first."""
    if not staged:
        return []
    files = "[" + ", ".join(_sql_path(p) for p in staged) + "]"
    cols = "lat, lon, sum(records)::BIGINT, count(DISTINCT species), count(DISTINCT dataset), min(y0), max(y1)"
    sql = f"SELECT {cols} FROM read_parquet({files}) GROUP BY lat, lon ORDER BY lat, lon"  # nosec B608 - cols is a constant; files are staging paths (<uuid>-<hex etag>.parquet, regex-checked in export_files), quote-refused by _sql_path
    rows = con.execute(sql).fetchall()
    return [
        [
            int(a),
            int(b),
            int(c),
            int(d),
            int(e),
            None if f is None else int(f),
            None if g is None else int(g),
        ]
        for a, b, c, d, e, f, g in rows
    ]


def record_bin(records: int) -> int:
    """Palette index of a cell's record count: the decade it falls in, the last one open-ended."""
    if records < 1:
        raise ValueError(f"a drawn cell has at least one record, not {records}")
    return min(len(str(int(records))) - 1, len(RAMP) - 1)


def render(cells: list[list], ramp: list[tuple] = RAMP) -> bytes:
    """A 360 × 180 palette PNG, one pixel per 1° cell, north up: row 0 is 89–90°N, column 0 is 180–179°W (`ramp`: 7 colours)."""
    import io

    import numpy as np
    from PIL import Image

    if len(ramp) != len(RAMP):
        raise ValueError(f"a ramp has {len(RAMP)} colours, one per decade, not {len(ramp)}")
    px = np.full((180, 360), NODATA, dtype=np.uint8)
    for lat, lon, records, *_ in cells:
        px[89 - lat, lon + 180] = record_bin(records)
    im = Image.fromarray(px, "P")
    im.putpalette(bytes(c for rgb in ramp for c in rgb) + bytes(3))
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True, transparency=bytes([255] * len(RAMP) + [0]))
    return buf.getvalue()


def build(
    all_datasets: list[dict],
    files: dict[str, str],
    staging: Path,
    *,
    source_url=None,
    con=None,
) -> tuple[dict, list[dict]]:
    """Stage every CC0 / CC BY dataset in the export and return the grid document (without a date) and the dataset listing."""
    source_url = source_url or (lambda i: f"{BUCKET}/occurrence/{i}.parquet")
    con = con or connect()
    staging.mkdir(parents=True, exist_ok=True)
    kept = [d for d in all_datasets if d["licence"] in (CC0, CC_BY)]
    missing = [d["id"] for d in kept if d["id"] not in files]
    staged, per_dataset = [], {}
    log.info(
        "%d of %d datasets are CC0 or CC BY; %d of them are not in the export (counted, not drawn)",
        len(kept),
        len(all_datasets),
        len(missing),
    )
    todo = [d for d in kept if d["id"] in files]
    t0 = time.time()
    for i, d in enumerate(todo, 1):
        out = staging / f"{d['id']}-{files[d['id']]}.parquet"
        n = staged_records(con, out) if out.exists() else stage(con, source_url(d["id"]), d["id"], out)
        staged.append(out)
        per_dataset[d["id"]] = n
        if i % 50 == 0 or i == len(todo):
            log.info("staged %d/%d datasets (%.0f s)", i, len(todo), time.time() - t0)
    cells = aggregate(con, staged)
    total = sum(d["records"] for d in all_datasets)
    shown = sum(per_dataset.values())
    return {
        "source": "OBIS open-data export (s3://obis-open-data/occurrence), CC0 1.0 and CC BY 4.0 datasets only",
        "cell_degrees": 1,
        "image": "data/obis_grid.png",
        "palette": [list(c) for c in RAMP],
        "bin_floors": BIN_FLOORS,
        "columns": [
            "lat",
            "lon",
            "records",
            "species",
            "datasets",
            "first_year",
            "last_year",
        ],
        "share": {
            "datasets_in": len(per_dataset),
            "datasets_total": len(all_datasets),
            "datasets_out": sum(1 for d in all_datasets if d["licence"] == OUT),
            "records_in": shown,
            "records_total_listed": total,
        },
        "cells": cells,
    }, [
        {
            "id": d["id"],
            "title": d["title"],
            "licence": d["licence"],
            "records": per_dataset[d["id"]],
        }
        for d in todo
    ]


def main(argv=None, *, get=_get, now=None, source_url=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--staging",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "obis_grid",
    )
    ap.add_argument(
        "--only",
        default=None,
        help="comma-separated dataset ids: stage only these (checks, not publishing)",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    all_datasets = datasets(get)
    files = export_files(get)
    if a.only:
        wanted = set(a.only.split(","))
        all_datasets = [d for d in all_datasets if d["id"] in wanted]
    doc, listing = build(all_datasets, files, a.staging, source_url=source_url)
    when = (now or (lambda: dt.datetime.now(dt.timezone.utc)))()
    doc = {"asOf": when.date().isoformat(), **doc}
    write_atomic(
        a.out_dir / "obis_grid_datasets.json",
        {"asOf": doc["asOf"], "datasets": listing},
    )
    png = a.out_dir / "obis_grid.png"
    png.with_suffix(".png.part").write_bytes(render(doc["cells"]))
    os.replace(png.with_suffix(".png.part"), png)
    write_atomic(a.out_dir / "obis_grid.json", doc)  # last: the layer reads this one
    log.info(
        "wrote %d cells from %d datasets",
        len(doc["cells"]),
        doc["share"]["datasets_in"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
