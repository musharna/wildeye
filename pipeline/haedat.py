"""Harmful algal events from HAEDAT (IOC-UNESCO Harmful Algal Event Database), one entry per recorded position with
its events counted by year and by the illness the event was linked to.

Spec: docs/superpowers/specs/2026-10-03-haedat-design.md. The source is the Darwin Core Archive IOC publishes on the
OBIS HAB IPT (resource `haedat`, version 3.35 of 2025-05-23, 14,341 events, CC BY 4.0, doi:10.25607/k68d5v), pinned
by version and sha256; a file that differs, cached or fetched, is refused, and so is an archive whose own metadata no
longer states CC BY 4.0. The live site's CSV export is not used: it carries submitters' e-mail addresses and states no
licence. Positions are HAEDAT's monitoring-grid or regional points, not where an event happened: each carries the
archive's coordinateUncertaintyInMeters (10 km to 985 km), published so the map can say how loose a point is. An
event whose date does not start with a four-digit year from 1700 on is counted as undated and kept off the years (36
in 3.35: '0000-00-00', two-digit years such as '88-8-15', day-first '28/05/2002'); the archive's historical records
(1770, 1860, 1878, ...) are real and keep their years. An event placed off the globe (9 in 3.35, all at longitude
-808.8684) is left off the map and listed by id. No contact fields, free-text remarks or higherGeography (free text that can contradict the point:
'California' at a Maine position) are published.
"""

from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import io
import logging
import os
import re
import shutil
import urllib.request
import zipfile
from pathlib import Path

from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("haedat")
VERSION = "3.35"
ARCHIVE_URL = f"https://ipt.iobis.org/hab/archive.do?r=haedat&v={VERSION}"
SHA256 = "d44c61e7e7042c816c92988f699f274644bdd29451373542c5c1d11d34866414"  # the 3.35 archive, 2026-10-03
LICENCE_URL = "creativecommons.org/licenses/by/4.0"
UA = "wildeye/0.1 (haedat; +https://github.com/musharna)"
# the archive's "HAB associated illness" values (3.35), in the order the legend lists them; anything else stops the run
ILLNESSES = {
    "PSP": "PSP",
    "DSP": "DSP",
    "ASP": "ASP",
    "NSP": "NSP",
    "AZP": "AZP",
    "CFP (Ciguatera Fish Poisoning)": "CFP",
    "Cyanobacterial toxins effects": "Cyano",
    "Aerosolized toxins effects": "Aerosol",
    "OTHER": "Other",
}
NONE = "None"  # an event with no illness recorded (water discoloration, fish kills, closures without a syndrome)
FIRST_YEAR = 1700  # the archive's earliest dated record is 1770
TOP_SPECIES = 5
TOP_LOCALITIES = 3
SOURCE_META = {
    "id": "haedat",
    "name": "Harmful Algal Event Database (HAEDAT)",
    "publisher": "IOC-UNESCO Harmful Algal Bloom Programme",
    "version": VERSION,
    "published": "2025-05-23",
    "doi": "10.25607/k68d5v",
    "data": "https://ipt.iobis.org/hab/resource?r=haedat",
    "licence": "CC BY 4.0",
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_to(url: str, path: Path) -> None:
    with (
        urlopen(
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=600
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch(
    cache: Path, *, url: str = ARCHIVE_URL, sha256: str = SHA256, fetch_to=_fetch_to
) -> Path:
    """The pinned archive, downloaded once; refused (and not kept) unless its sha256 is the pinned one."""
    path = cache / f"haedat-{VERSION}.zip"
    if path.exists():
        got = _sha256(path)
        if got != sha256:
            raise ValueError(
                f"{path}: sha256 {got} is not the pinned {sha256}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    log.info("downloading %s", url)
    try:
        fetch_to(url, part)
        got = _sha256(part)
        if got != sha256:
            raise ValueError(f"{url}: sha256 {got} is not the pinned {sha256}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def _table(zf: zipfile.ZipFile, name: str) -> list[dict]:
    text = zf.read(name).decode("utf-8")
    return list(
        csv.DictReader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_NONE)
    )


def year_of(event_date: str, this_year: int) -> int | None:
    """The event's year: the leading four digits of its (possibly ranged) date, from FIRST_YEAR to this year."""
    m = re.match(r"(\d{4})(?:$|[-/])", event_date.strip())
    if not m:
        return None
    y = int(m.group(1))
    return y if FIRST_YEAR <= y <= this_year else None


def read_archive(path: Path, this_year: int) -> tuple[list[dict], dict]:
    """(events, licence statement) from the archive: each event with its position, year, illnesses and causative taxa."""
    with zipfile.ZipFile(path) as zf:
        eml = zf.read("eml.xml").decode("utf-8")
        rights = re.search(r"<intellectualRights>(.*?)</intellectualRights>", eml, re.S)
        if not rights or LICENCE_URL not in rights.group(1):
            raise ValueError(
                f"the archive's eml.xml no longer states CC BY 4.0: {rights.group(1)[:300] if rights else None!r}"
            )
        events = _table(zf, "event.txt")
        occurrences = _table(zf, "occurrence.txt")
        facts = _table(zf, "extendedmeasurementorfact.txt")
    illness = collections.defaultdict(set)
    for f in facts:
        if f["measurementType"] != "HAB associated illness":
            continue
        if f["measurementValue"] not in ILLNESSES:
            raise ValueError(
                f"unknown HAB associated illness {f['measurementValue']!r} for {f['id']}"
            )
        illness[f["id"]].add(ILLNESSES[f["measurementValue"]])
    causative = collections.defaultdict(set)
    for o in occurrences:
        if ":causative:" in o["occurrenceID"] and o["scientificName"]:
            causative[o["id"]].add(o["scientificName"])
    out = []
    for e in events:
        lat, lon = float(e["decimalLatitude"]), float(e["decimalLongitude"])
        out.append(
            {
                "id": e["id"],
                "lat": lat,
                "lon": lon,
                "uncertaintyKm": round(
                    float(e["coordinateUncertaintyInMeters"]) / 1000, 1
                ),
                "country": e["country"],
                "localities": [p for p in e["locality"].split(";") if p.strip()],
                "year": year_of(e["eventDate"], this_year),
                "illnesses": sorted(illness.get(e["id"], ())) or [NONE],
                "species": sorted(causative.get(e["id"], ())),
            }
        )
    return out, {"text": re.sub(r"<[^>]+>|\s+", " ", rights.group(1)).strip()}


def on_globe(e: dict) -> bool:
    return -90 <= e["lat"] <= 90 and -180 <= e["lon"] <= 180


def _top(counts: collections.Counter, k: int) -> list[tuple[str, int]]:
    """The k commonest, a tie broken by name: Counter.most_common breaks it by the order rows happen to come in, so
    whether a taxon tied at the cut is listed would depend on the archive's row order (review of PR #52)."""
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:k]


def by_position(events: list[dict]) -> list[dict]:
    """One entry per position: per-year event counts split by illness (an event with two illnesses counts under
    both, so a year's illness counts can add to more than its events), the undated events, the commonest causative
    taxa and place names."""
    groups = collections.defaultdict(list)
    for e in events:
        groups[(e["lat"], e["lon"])].append(e)
    positions = []
    for (lat, lon), es in sorted(groups.items()):
        years: dict[str, dict] = {}
        undated = {"n": 0, "ill": collections.Counter()}
        for e in es:
            bucket = undated if e["year"] is None else years.setdefault(str(e["year"]), {"n": 0, "ill": collections.Counter()})
            bucket["n"] += 1
            for i in e["illnesses"]:
                bucket["ill"][i] += 1
        species = collections.Counter(s for e in es for s in e["species"])
        places = collections.Counter(p.strip() for e in es for p in e["localities"])
        positions.append(
            {
                "lat": lat,
                "lon": lon,
                # one position, one stated precision: the widest if the archive ever disagrees with itself
                "uncertaintyKm": max(e["uncertaintyKm"] for e in es),
                "countries": sorted({e["country"] for e in es}),
                "places": [p for p, _ in _top(places, TOP_LOCALITIES)],
                "species": [[s, n] for s, n in _top(species, TOP_SPECIES)],
                "years": {
                    y: {"n": v["n"], "ill": dict(sorted(v["ill"].items()))}
                    for y, v in sorted(years.items())
                },
                "undated": {"n": undated["n"], "ill": dict(sorted(undated["ill"].items()))},
            }
        )
    return positions


def main(
    argv=None,
    *,
    fetch_to=_fetch_to,
    url=ARCHIVE_URL,
    sha256=SHA256,
    today: dt.date | None = None,
):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "haedat",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    today = today or dt.datetime.now(dt.UTC).date()
    events, rights = read_archive(
        fetch(a.cache, url=url, sha256=sha256, fetch_to=fetch_to), today.year
    )
    # 3.35 holds 9 Yucatán events at longitude -808.8684: left off the map and listed, not guessed back onto it
    off = sorted(f"{e['id']} ({e['lat']}, {e['lon']})" for e in events if not on_globe(e))
    if off:
        log.warning("%d events have a position off the globe: %s", len(off), off)
    events = [e for e in events if on_globe(e)]
    positions = by_position(events)
    undated = sorted(e["id"] for e in events if e["year"] is None)
    years = [e["year"] for e in events if e["year"] is not None]
    log.info(
        "%d events at %d positions, %d undated, years %d-%d",
        len(events),
        len(positions),
        len(undated),
        min(years),
        max(years),
    )
    write_atomic(
        a.out_dir / "haedat.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "events": len(events),
            "undated": undated,
            "offGlobe": off,
            "illnesses": list(dict.fromkeys(ILLNESSES.values())) + [NONE],
            "positions": positions,
            "source": SOURCE_META | {"rights": rights["text"]},
        },
    )


if __name__ == "__main__":
    main()
