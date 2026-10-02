"""Assemblage time series from BioTIME 2.0 (Dornelas et al. 2025): one entry per openly licensed study, with raw
per-year counts of taxa and samples.

Spec: docs/superpowers/specs/2026-10-01-biotime-design.md. Zenodo record 15222193 (the 2025-04-15 issue, CC BY 4.0)
holds the records as an R data frame (.rds) and a metadata CSV, both md5-pinned here; a file that differs, cached or
fetched, is refused. pipeline/biotime_extract.R only converts the .rds to a gzipped CSV of six columns sorted by study
and year; everything else happens here. Each study carries its own licence as free text: only open-attribution studies
are kept, by an explicit table, and a string the table does not know stops the run. Counts are raw (distinct taxa and
distinct samples per study-year), published beside each other so a reader sees the effort behind a count. A study
spanning more than WIDE_KM2 also gets the 0.01° grid cells it sampled each year, drawn instead of a misleading centroid.
No contact fields and no raw records are published.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import logging
import math
import os
import re
import shutil
import subprocess  # nosec B404 — runs the repo's own Rscript extract with a fixed argument list, no shell
import time
import urllib.request
from pathlib import Path

from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("biotime")
RECORD = 15222193
FILE_URL = "https://zenodo.org/records/{}/files/{}?download=1"
# (file name, Zenodo's md5), read from the record's API 2026-10-01
SOURCE = {
    "rds": ("biotime_v2_query_15April25.rds", "2fed9f6c8028d4c44d80769c594be056"),
    "meta": ("biotime_v2_metadata_15April25.csv", "3daed71ed554888309f9f2443a847bea"),
    "refs": ("references_biotime_v2_15April25.csv", "3c963064177e4369ccb730cee536651e"),
}
EXTRACT_COLUMNS = [
    "STUDY_ID",
    "YEAR",
    "SAMPLE_DESC",
    "LATITUDE",
    "LONGITUDE",
    "valid_name",
]
EXTRACT_SCRIPT = Path(__file__).with_name("biotime_extract.R")
WIDE_KM2 = 10_000
LOCATIONS = "biotime_locations.json"
UA = "wildeye/0.1 (biotime)"
SOURCE_META = {
    "id": "biotime",
    "name": "BioTIME 2.0",
    "doi": "10.1111/geb.70003",
    "data": "https://doi.org/10.5281/zenodo.15222193",
    "site": "https://biotime.st-andrews.ac.uk/",
    "licence": "CC BY 4.0 (Zenodo record); per study: open-attribution licences only (CC0, CC BY, PDDL, ODC-By, OGL, "
    "Licence Ouverte, public domain)",
    "citation": "Dornelas, M., et al. (2025). BioTIME 2.0: expanding and improving a database of biodiversity time "
    "series. Global Ecology and Biogeography 34(5), e70003. doi:10.1111/geb.70003",
}

# Every PERMISSIONS string in the 2025-04-15 metadata, after repair() and lower-casing, and its class.
_OPEN = [
    "cc by",
    "cc by 4.0",
    "cc by 4.0 attribution 4.0 international",
    "cc by 4.0 attribution 4.0 international; please acknowledge the wildlife and environment zimbabwe – matabeleland branch",
    "cc by 4.0 deed attribution 4.0 international",
    "cc- by",
    "cc-by",
    "cc-by 4",
    "cc-by 4.0",
    "cc-by, https://db.cger.nies.go.jp/gem/moni-e/inter/gems/database/kasumi/contents/terms.html",
    "cc-by, if data from multiple projects are used, please acknowledge the data paper publication; if individual project "
    "data are used, please acknowledge use of data as per the custodian information. please use the following "
    'acknowledgement: "data was sourced from australia’s integrated marine observing system (imos) – imos is '
    'enabled by the national collaborative research infrastructure strategy (ncris)."',
    'cc-by, please acknowledge use of the dataset as well with "data was sourced from australia’s integrated marine '
    'observing system (imos) – imos is enabled by the national collaborative research infrastructure strategy (ncris)."',
    'cc-by, please also include in acknowledgments "a part of the data included in the database was obtained with support '
    "from the great barrier reef marine park authority, through funding from the australian government reef program and "
    'from the australian institute of marine science"',
    "cc-by-4",
    "cc-by-attribution",
    "cc-by-attribution 4.0 international",
    "cc0",
    "cc0 1.0",
    "cc0 1.0 universal (cc0 1.0)",
    "cc0 1.0 universal (cc0 1.0) public domain dedication",
    "ccby4.0",
    "creative commons attribution (cc-by) 4.0",
    "creative commons attribution 4.0",
    "creative commons attribution 4.0 international",
    "creative commons license - attribution - cc by (https://creativecommons.org/licenses/by/4.0/)",
    "odc-by",
    "ogl (https://eidc.ceh.ac.uk/licences/ogl/plain)",
    "open government licence",
    "open government licence - canada",
    "open government licence v.3",
    "open government licence v3 (ogl)",
    "open government licence v3 (ogl) you must always use the following attribution statement to acknowledge the source "
    'of the information: "contains data supplied by uk centre for ecology & hydrology."',
    "open license 2.0 (licence ouverte / open license)",
    "pddl",
    "public domain attribution required",
    "public domain dppl",
    "public domain pddl",
    "toronto and region conservation open data license v1.0",
    "u.s. public domain",
]
_NON_COMMERCIAL = [
    "attribution-noncommercial 4.0 international",
    "cc by-nc",
    "cc by-nc 4.0 attribution-noncommercial 4.0 international",
    "cc by-nc 4.0 deed attribution-noncommercial 4.0 international",
    "cc by-nc-sa",
    "cc by-nc-sa 4.0",
    "cc-by-nc",
    "cc-by-nc 4.0",
    "creative commons attribution-noncommercial 4.0 international",
    "odbl (cc-by-nc)",
]
_SHARE_ALIKE = [
    "attribution and share-alike odbl",
    "cc by-sa",
    "cc by-sa 4.0 attribution-sharealike 4.0 international",
    "cc-by-sa",
    "odbl",
    "odbl: attribution and share-alike",
]
_UNCLEAR = [
    "",
    "citation required",
    "citation required.",
    "public",
    "public - full access",
]
LICENCES = {
    **dict.fromkeys(_OPEN, "open"),
    **dict.fromkeys(_NON_COMMERCIAL, "non-commercial"),
    **dict.fromkeys(_SHARE_ALIKE, "share-alike"),
    **dict.fromkeys(_UNCLEAR, "unclear"),
}
_MOJIBAKE = ("Ã", "Â", "â€")


def repair(text: str) -> str:
    """Undo UTF-8 read as cp1252 (the metadata holds 'australiaâ€™s'), then collapse whitespace; clean text is kept."""
    if any(m in text for m in _MOJIBAKE):
        try:
            text = text.encode("cp1252").decode("utf-8")
        except UnicodeError:
            pass  # not mojibake after all: keep the text as written
    return re.sub(r"\s+", " ", text).strip()


def licence_class(text: str) -> str:
    """open / non-commercial / share-alike / unclear, from the table; a string not in it is refused."""
    key = repair(text).lower()
    if key not in LICENCES:
        raise ValueError(
            f"licence {text!r} is not in the BioTIME licence table; classify it in pipeline/biotime.py"
        )
    return LICENCES[key]


_FIELD = re.compile(r"^\s{0,8}(\w{1,20})\s{0,4}=\s{0,4}\{(.*)\},?\s{0,4}$")


def _surname(name: str) -> str:
    name = name.strip()
    return name.split(",")[0].strip() if "," in name else name.split()[-1]


def format_bib(bib: str) -> str:
    """One BibTeX entry as 'Webb & Scanga (2001). Title. Journal 82(3):893-897. doi:…'; missing parts are left out."""
    f = {}
    for line in bib.splitlines():
        m = _FIELD.match(line)
        if m:
            f[m.group(1).lower()] = m.group(2).replace("{", "").replace("}", "").strip()
    names = [_surname(a) for a in f.get("author", "").split(" and ") if a.strip()]
    who = (
        names[0]
        if len(names) == 1
        else f"{names[0]} & {names[1]}"
        if len(names) == 2
        else f"{names[0]} et al."
        if names
        else ""
    )
    head = " ".join(p for p in (who, f"({f['year']})" if f.get("year") else "") if p)
    where = f.get("journal", "")
    if f.get("volume"):
        where += f" {f['volume']}" + (f"({f['number']})" if f.get("number") else "")
    if f.get("pages"):
        where += f":{f['pages']}"
    parts = [p.strip() for p in (head, f.get("title", ""), where) if p.strip()]
    text = ". ".join(parts) + "."
    return text + (f" doi:{f['doi']}" if f.get("doi") else "")


def read_citations_rows(rows) -> dict[int, list[str]]:
    by = {}
    for r in rows:
        by.setdefault(int(r["STUDY_ID"]), []).append(
            (int(r["CITATION_ID"]), format_bib(r["BIB"]))
        )
    return {sid: [c for _, c in sorted(v)] for sid, v in by.items()}


def iter_records(fh):
    """(study, year, sample, lat, lon, taxon) from the extract's gzipped CSV; a missing or unparsable field is refused."""
    reader = csv.reader(
        io.TextIOWrapper(gzip.GzipFile(fileobj=fh), encoding="utf-8", newline="")
    )
    header = next(reader)
    if header != EXTRACT_COLUMNS:
        raise ValueError(f"extract columns {header} are not {EXTRACT_COLUMNS}")
    for n, row in enumerate(reader, start=2):
        try:
            yield int(row[0]), int(row[1]), row[2], float(row[3]), float(row[4]), row[5]
        except (ValueError, IndexError) as e:
            col = next(
                (c for c, v in zip(EXTRACT_COLUMNS, row) if v in ("", "NA")), "a field"
            )
            raise ValueError(
                f"extract line {n}: {col} missing or unparsable in {row}"
            ) from e


def count_years(records, *, keep: set, wide: set):
    """Distinct taxa and distinct samples per kept study-year, and each wide study's sampled 0.01° grid cells per year,
    as cell centres. A cell is floor(x * 100): rounding a coordinate has ties that languages break differently (R and
    Python split -139.025 two ways), a grid index has none, so an independent count in R gives the same cells.
    Records must come sorted by study then year (the extract sorts them), so only one group is held at a time."""
    years, locs = {}, {}
    key, taxa, samples, cells, last = None, set(), set(), set(), (-1, -1)

    def flush():
        if key is None or key[0] not in keep:
            return
        years.setdefault(key[0], {})[key[1]] = (len(taxa), len(samples))
        if cells:  # only wide studies collect cells
            centres = {(round((i + 0.5) / 100, 3), round((j + 0.5) / 100, 3)) for i, j in cells}
            locs.setdefault(key[0], {})[key[1]] = sorted(
                centres, key=lambda c: (c[1], c[0]), reverse=True
            )

    for sid, year, sample, lat, lon, name in records:
        if (sid, year) < last:
            raise ValueError(
                f"records are not sorted by study and year: {(sid, year)} after {last}"
            )
        last = (sid, year)
        if (sid, year) != key:
            flush()
            key, taxa, samples, cells = (sid, year), set(), set(), set()
        if sid in keep:
            taxa.add(name)
            samples.add(sample)
            if sid in wide:
                cells.add((math.floor(lon * 100), math.floor(lat * 100)))
    flush()
    return years, locs


def _md5(path: Path) -> str:
    h = hashlib.md5(usedforsecurity=False)
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_to(url: str, path: Path) -> None:
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=1800
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch(cache: Path, file: tuple[str, str], *, fetch_to=_fetch_to) -> Path:
    """The pinned file, downloaded once; refused (and not kept) unless its md5 is Zenodo's."""
    name, want = file
    path = cache / name
    if path.exists():
        got = _md5(path)
        if got != want:
            raise ValueError(
                f"{path}: md5 {got} is not Zenodo's {want}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    url = FILE_URL.format(RECORD, name)
    log.info("downloading %s", url)
    try:
        fetch_to(url, part)
        got = _md5(part)
        if got != want:
            raise ValueError(f"{url}: md5 {got} is not Zenodo's {want}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def run_extract(rds: Path, dest: Path) -> None:
    rscript = shutil.which("Rscript")
    if not rscript:
        raise RuntimeError(
            "Rscript not found: the .rds extract needs R"
        )
    subprocess.run([rscript, "--vanilla", str(EXTRACT_SCRIPT), str(rds), str(dest)], check=True)  # nosec B603 — fixed argv, no shell


def main(argv=None, *, fetch_to=_fetch_to, source=SOURCE, extract=run_extract):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "biotime",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    paths = {k: fetch(a.cache, f, fetch_to=fetch_to) for k, f in source.items()}
    with open(paths["meta"], encoding="utf-8", newline="") as fh:
        meta = {int(r["STUDY_ID"]): r for r in csv.DictReader(fh)}
    classes = {sid: licence_class(r["PERMISSIONS"]) for sid, r in meta.items()}
    keep = {sid for sid, c in classes.items() if c == "open"}
    wide = {sid for sid in keep if float(meta[sid]["AREA_SQ_KM"] or 0) > WIDE_KM2}
    dropped = {
        c: sum(1 for v in classes.values() if v == c)
        for c in ("non-commercial", "share-alike", "unclear")
    }
    log.info("licences: %d open (%d wide), dropped %s", len(keep), len(wide), dropped)
    with open(paths["refs"], encoding="utf-8", newline="") as fh:
        citations = read_citations_rows(csv.DictReader(fh))
    records = a.cache / "biotime_records.csv.gz"
    part = records.with_name(records.name + ".part")
    extract(paths["rds"], part)
    os.replace(part, records)
    log.info("extracted %s (%.0f s)", records, time.time() - t0)
    with open(records, "rb") as fh:
        years, locs = count_years(iter_records(fh), keep=keep, wide=wide)
    empty = sorted(keep - set(years))
    if empty:
        log.warning("%d open studies have no records: %s", len(empty), empty)
    studies = []
    for sid in sorted(years):
        r = meta[sid]
        studies.append(
            {
                "id": sid,
                "title": repair(r["TITLE"]),
                "organisms": repair(r["ORGANISMS"]),
                "taxa": r["TAXA"],
                "realm": r["REALM"],
                "lat": float(r["CENT_LAT"]),
                "lon": float(r["CENT_LONG"]),
                "areaKm2": float(r["AREA_SQ_KM"] or 0),
                "wide": sid in wide,
                "licence": repair(r["PERMISSIONS"]),
                "link": r["WEB_LINK"].strip(),
                "citations": citations.get(sid, []),
                "years": {str(y): list(v) for y, v in sorted(years[sid].items())},
            }
        )
    write_atomic(
        a.out_dir / LOCATIONS,
        {
            str(sid): {
                str(y): [list(c) for c in cells] for y, cells in sorted(per.items())
            }
            for sid, per in sorted(locs.items())
        },
    )
    write_atomic(
        a.out_dir / "biotime.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "studies": studies,
            "dropped": dropped,
            "noRecords": empty,
            "wideKm2": WIDE_KM2,
            "locations": f"data/{LOCATIONS}",
            "source": SOURCE_META,
        },
    )
    log.info("wrote %d studies (%.0f s)", len(studies), time.time() - t0)


if __name__ == "__main__":
    main()
