"""Antarctic penguin breeding colonies from the Antarctic Penguin Biogeography Project database (mapppdr v3.1).

Spec: docs/superpowers/specs/2026-10-07-penguins-design.md. The release is the authors' `mapppdr` R package, GitHub
CCheCastaldo/mapppdr tag v3.1 (commit 88c73a50), CC BY 4.0 for the data. GitHub builds release tarballs on request
and does not promise their bytes, so the four files read here are fetched from the commit itself and each is refused
unless its sha256 is the pinned one. The tables are R save files; `pipeline/rda.py` reads them without R.

One point per site x species with at least one presence record (the 6 pairs whose every record is an absence are
listed, not drawn). Each carries the latest counts: every record with a count in the latest season that has one, as
the release holds several per season (nests and chicks of one survey, two parties on one day, one survey from two
publications) and the authors keep them all. Counts of different types are never added or compared.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import logging
import os
import shutil
import urllib.request
from pathlib import Path

from . import rda
from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("penguins")
VERSION = "3.1"
COMMIT = "88c73a507e0921b2541c218c71eaf16721bc6502"  # tag v3.1, 2026-08-21
BASE_URL = f"https://raw.githubusercontent.com/CCheCastaldo/mapppdr/{COMMIT}/"
# sha256 of each committed file (equal to the v3.1 tarball's copies, md5 cfa87ca7b876cd3aa50947e9c6c1f23c), 2026-10-07
FILES = {
    "data/penguin_obs.rda": "b569def7d9a121bcca4bf78f4a4918af16f07e252ac65578ccc7636f3242afbd",
    "data/sites.rda": "d3b0021a413c752411da18e87d544916329be77001a065749552203b013a9205",
    "data/species.rda": "189724677ff40d6ff77df635973b1ad88d2c0947f8594452bfc3f9525e078f7f",
    "README.md": "9a9f35a0c2bae77e938311a715c02fa44034d764cb4cdb67d1a123b06b636266",
}
LICENCE_TEXT = "This database is licensed under a [Creative Commons Attribution 4.0\nInternational License](http://creativecommons.org/licenses/by/4.0/)"
UA = "wildeye/0.1 (penguins; +https://github.com/musharna)"
TYPES = ("nests", "chicks", "adults")
# the release's vantage values (man/penguin_obs.Rd), each labelled in src/data/penguins.js; None = not stated
VANTAGES = (
    "aerial",
    "aerial photo",
    "ground",
    "ground photo",
    "landsat",
    "offshore vessel",
    "sentinel",
    "uav",
    "vhr",
    None,
)
SOUTH_OF = -55.0  # the release covers breeding sites south of 60S; a site north of 55S is a wrong sign or a typo
SOURCE_META = {
    "id": "penguins",
    "name": "Antarctic Penguin Biogeography Project database (mapppdr)",
    "version": VERSION,
    "published": "2026-08-21",
    "commit": COMMIT,
    "data": f"https://github.com/CCheCastaldo/mapppdr/tree/v{VERSION}",
    "doi": "10.3897/BDJ.11.e101476",
    "datasetDoi": "10.48361/zftxkr",
    "citation": "Che-Castaldo C, Humphries G, Lynch H (2023) Antarctic Penguin Biogeography Project: Database of abundance and distribution for the Adélie, chinstrap, gentoo, emperor, macaroni and king penguin south of 60°S. Biodiversity Data Journal 11: e101476",
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
            urllib.request.Request(url, headers={"User-Agent": UA}), timeout=300
        ) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def fetch(
    cache: Path, *, files: dict = FILES, base_url: str = BASE_URL, fetch_to=_fetch_to
) -> dict[str, Path]:
    """{name: path} of the pinned files, each downloaded once; one whose sha256 is not pinned is refused (and a
    refused download is not kept)."""
    out = {}
    for name, sha in files.items():
        path = cache / name
        if path.exists():
            got = _sha256(path)
            if got != sha:
                raise ValueError(
                    f"{path}: sha256 {got} is not the pinned {sha}; delete it to fetch again"
                )
            out[name] = path
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_name(path.name + ".part")
        log.info("downloading %s", base_url + name)
        try:
            fetch_to(base_url + name, part)
            got = _sha256(part)
            if got != sha:
                raise ValueError(
                    f"{base_url + name}: sha256 {got} is not the pinned {sha}"
                )
            os.replace(part, path)
        finally:
            part.unlink(missing_ok=True)
        out[name] = path
    return out


def check_licence(readme: str) -> str:
    """The README's licence sentence for the data; a README that no longer states CC BY 4.0 stops the run."""
    if LICENCE_TEXT not in readme:
        i = readme.find("## Licenses")
        raise ValueError(
            f"the release README no longer states CC BY 4.0 for the data: {readme[i : i + 300]!r}"
        )
    return "This database is licensed under a Creative Commons Attribution 4.0 International License."


def check_tables(obs: list[dict], sites: list[dict], species: list[dict]) -> None:
    """Refuse a release the layer's decisions do not cover, naming the first offending row."""
    ids = [s["site_id"] for s in sites]
    dup = [k for k, n in collections.Counter(ids).items() if n > 1]
    if dup:
        raise ValueError(f"duplicate site ids {dup[:5]}")
    for s in sites:
        lat, lon = s["latitude"], s["longitude"]
        if (
            lat is None
            or lon is None
            or not (-90 <= lat <= SOUTH_OF)
            or not (-180 <= lon <= 180)
        ):
            raise ValueError(
                f"site {s['site_id']} at ({lat}, {lon}) is not a position south of {SOUTH_OF}"
            )
    known_sites, known_species = set(ids), {s["species_id"] for s in species}
    for r in obs:
        where = f"{r['site_id']} {r['species_id']} {r['citekey']} season {r['season']}"
        if r["site_id"] not in known_sites:
            raise ValueError(f"{where}: unknown site")
        if r["species_id"] not in known_species:
            raise ValueError(f"{where}: unknown species")
        if r["type"] not in TYPES:
            raise ValueError(f"{where}: unknown count type {r['type']!r}")
        if r["presence"] not in (0, 1):
            raise ValueError(f"{where}: presence {r['presence']!r} is not 0 or 1")
        if not isinstance(r["season"], int):
            raise ValueError(f"{where}: no season")
        c = r["count"]
        if c is not None and c < 0:
            raise ValueError(f"{where}: negative count {c}")
        if r["presence"] == 0 and c != 0:
            raise ValueError(f"{where}: an absence with count {c}")
        if r["presence"] == 1 and c == 0:
            raise ValueError(f"{where}: present with a count of 0")
        if r["accuracy"] is not None and r["accuracy"] not in (1, 2, 3, 4, 5):
            raise ValueError(f"{where}: accuracy {r['accuracy']!r} is not 1-5")
        if r["vantage"] not in VANTAGES:
            raise ValueError(f"{where}: unknown vantage {r['vantage']!r}")


def _date_key(r: dict) -> str:
    return r["date"] or ""  # undated sorts before any date, so after it once reversed


def summarise(records: list[dict]) -> dict:
    """One site x species: surveys, span, the latest counts and a later presence-only season."""
    counted = [r for r in records if r["count"] is not None]
    surveys = {(r["citekey"], r["season"], r["date"], r["vantage"]) for r in records}
    out = {
        "records": len(records),
        "surveys": len(surveys),
        "first": min(r["season"] for r in records),
        "last": max(r["season"] for r in records),
        "latest": None,
        "presentOnly": None,
    }
    if counted:
        season = max(r["season"] for r in counted)
        rows = sorted(
            (r for r in counted if r["season"] == season),
            key=lambda r: (_date_key(r), r["type"], r["count"], r["citekey"]),
            reverse=True,
        )
        out["latest"] = {
            "season": season,
            "counts": [
                {
                    "type": r["type"],
                    "count": r["count"],
                    "date": r["date"],
                    "accuracy": r["accuracy"],
                    "vantage": r["vantage"],
                }
                for r in rows
            ],
        }
    # a record with no count is presence only: check_tables refuses an absence without a count of 0
    present = [r["season"] for r in records if r["count"] is None]
    if present and (not counted or max(present) > out["latest"]["season"]):
        out["presentOnly"] = max(present)
    return out


def build(obs: list[dict], sites: list[dict], species: list[dict]) -> dict:
    check_tables(obs, sites, species)
    site = {s["site_id"]: s for s in sites}
    groups = collections.defaultdict(list)
    for r in obs:
        groups[(r["site_id"], r["species_id"])].append(r)
    points, absent = [], []
    for (sid, sp), rs in sorted(groups.items()):
        if not any(r["presence"] == 1 for r in rs):
            absent.append(f"{sid} {sp}")
            continue
        s = site[sid]
        points.append(
            {
                "site": sid,
                "name": s["site_name"],
                "region": s["region"],
                "lat": s["latitude"],
                "lon": s["longitude"],
                "species": sp,
            }
            | summarise(rs)
        )
    used = {p["species"] for p in points}
    return {
        "points": points,
        "absentOnly": absent,
        "species": [
            {"id": s["species_id"], "name": s["common_name"]}
            for s in species
            if s["species_id"] in used
        ],
    }


def main(argv=None, *, fetch_to=_fetch_to, files=FILES):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        )
        / "penguins"
        / f"v{VERSION}",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    paths = fetch(a.cache, files=files, fetch_to=fetch_to)
    rights = check_licence(paths["README.md"].read_text(encoding="utf-8"))
    out = build(
        rda.data_frame(paths["data/penguin_obs.rda"], "penguin_obs"),
        rda.data_frame(paths["data/sites.rda"], "sites"),
        rda.data_frame(paths["data/species.rda"], "species"),
    )
    pts = out["points"]
    log.info(
        "%d points at %d sites, %d with a count, %d presence only, %d absence-only pairs left off",
        len(pts),
        len({p["site"] for p in pts}),
        sum(p["latest"] is not None for p in pts),
        sum(p["latest"] is None for p in pts),
        len(out["absentOnly"]),
    )
    write_atomic(
        a.out_dir / "penguins.json",
        {"generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
        | out
        | {"source": SOURCE_META | {"rights": rights}},
    )


if __name__ == "__main__":
    main()
