"""Fetch the USDA APHIS HPAI wild-bird CSV for the hpai-mirror GitHub release.

Run by .github/workflows/hpai-mirror.yml on a GitHub-hosted runner, because Akamai in front of
usda.gov refuses the connection the nightly cron runs from (see pipeline/hpai.py). Writes
<out-dir>/hpai-wild-birds.csv, the bytes as fetched less any BOM, and hpai-wild-birds.json:
{source, fetched_at, sha256, rows, dated, newest}. pipeline/hpai.py checks the sha256 and the
age before it uses the CSV. Nothing is written unless the text is the detection table: an
error page (Akamai's "Access Denied" is HTML with status 403, but a 200 error page would pass
urlopen) has none of the columns and raises.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import logging
from pathlib import Path

from .atomic import write_atomic
from .hpai import CSV_URL, fetch_csv, parse_rows

log = logging.getLogger("hpai_mirror")
CSV_NAME = "hpai-wild-birds.csv"
META_NAME = "hpai-wild-birds.json"
# The columns pipeline/hpai.py reads.
REQUIRED = (
    "State",
    "County",
    "Collection Date",
    "Date Detected",
    "HPAI Strain",
    "Bird Species",
    "WOAH Classification",
    "Sampling Method",
)


def check_table(text: str) -> dict:
    """{rows, dated, newest} for the APHIS detection table; ValueError for anything else."""
    header = next(csv.reader(io.StringIO(text)), [])
    missing = [c for c in REQUIRED if c not in header]
    if missing:
        raise ValueError(
            f"missing columns {missing}; the response starts {text[:120]!r}"
        )
    rows, counts = parse_rows(text)
    if not rows:
        raise ValueError(f"no row with a detection date ({counts.get('rows', 0)} rows)")
    return {
        "rows": counts["rows"],
        "dated": len(rows),
        "newest": max(r["detected"] for r in rows).isoformat(),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, required=True)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    text = fetch_csv()
    stats = check_table(text)
    body = text.encode("utf-8")
    meta = {
        "source": CSV_URL,
        "fetched_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sha256": hashlib.sha256(body).hexdigest(),
        **stats,
    }
    a.out_dir.mkdir(parents=True, exist_ok=True)
    (a.out_dir / CSV_NAME).write_bytes(body)
    write_atomic(a.out_dir / META_NAME, meta)
    log.info(
        "wrote %s (%d bytes) and %s: %s",
        CSV_NAME,
        len(body),
        META_NAME,
        json.dumps(meta),
    )


if __name__ == "__main__":
    main()
