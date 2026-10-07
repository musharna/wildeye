"""Native vascular plant species per TDWG botanical country (WCVP 16.0) → public/data/plants_wcvp.geojson (polygon
contract, static).

Spec: docs/superpowers/specs/2026-10-06-wcvp-plants-design.md. Decisions: grill_wildeye_wave3_2026-10-06, decision 3.
Sources: the World Checklist of Vascular Plants Darwin Core archive (Royal Botanic Gardens, Kew; version 16.0,
2026-06-04, CC BY 3.0) and the TDWG World Geographical Scheme for Recording Plant Distributions (WGSRPD) Level 3
boundaries (github tdwg/wgsrpd at a pinned commit; tdwg.org content CC BY 4.0). Both are downloaded once into the cache
and refused unless their md5 is the pinned one; the archive's eml.xml must still say version 16.0 under CC BY 3.0.

Columns are mapped by the indexes the archive's meta.xml declares for each Darwin Core term (the CSV header misspells
two names), never by header. Per Level-3 unit ("botanical country"), counting accepted species only (taxonRank
Species, taxonomicStatus Accepted; infraspecific taxa, synonyms and "Provisionally Accepted" names are left out):

- native: distinct species with a distribution row there that is not introduced (establishmentMeans), not doubtful
  (occurrenceStatus) and not extinct (threatStatus);
- introduced: distinct species with a row there marked introduced, not doubtful and not extinct;
- endemic: native species whose native rows name that unit and no other place: no other Level-3 unit and no
  Level-1 or Level-2 region (a coarse row could lie outside the unit).

Any other value in those three columns, a location that is not a WGSRPD code, or a Level-3 code with no boundary stops
the run. Anything but 369 units with unique codes, or an output over the budget, stops it too.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import logging
import os
import re
import time
import zipfile
from pathlib import Path

from .atomic import write_atomic
from .ecoregions import simplify_geometry
from .gfw import geometry_area_km2
from .hfp import _fetch_to, _md5
from .marine_realms import MAX_PART_WIDTH, split_wide

log = logging.getLogger("wcvp_plants")
CACHE_DIR = "wcvp"
ZIP = "wcvp_dwca.zip"
L3 = "level3.geojson"
ZIP_URL = "https://sftp.kew.org/pub/data-repositories/WCVP/wcvp_dwca.zip"
TDWG_COMMIT = (
    "52da7828aba9d461dd133c27b3bd7a4407161f54"  # tdwg/wgsrpd master, 2026-10-06
)
L3_URL = f"https://raw.githubusercontent.com/tdwg/wgsrpd/{TDWG_COMMIT}/geojson/level3.geojson"
# md5 of each file as downloaded 2026-10-06 (Kew publishes none; Last-Modified 2026-06-04, 88,208,088 B)
FILES = {
    ZIP: (ZIP_URL, "76dba53d4a7606923a5b70437fe7d7c8"),
    L3: (L3_URL, "021533df6348ba7c81fe0c1bb5ef34fb"),
}
VERSION = "16.0"
LICENCE_URL = "https://creativecommons.org/licenses/by/3.0/"
EXPECTED_UNITS = 369
BUDGET_BYTES = 3_000_000
TOL = 0.01  # degrees; the source's 44,549 vertices are already coarse
MIN_AREA = 0.0  # keep every island: many units are only islands

DWC = "http://rs.tdwg.org/dwc/terms/"
TAXON = "Taxon"
DISTRIBUTION = "Distribution"
TAXON_TERMS = ("taxonID", "taxonRank", "taxonomicStatus")
DIST_TERMS = (
    "locationID",
    "establishmentMeans",
    "occurrenceStatus",
    "threatStatus",
)
# The vocabularies as published in 16.0 (census of all 1,995,338 rows, 2026-10-06); anything else stops the run.
ESTABLISHMENT = {"": "native", "introduced": "introduced"}
OCCURRENCE = {"": "present", "Doubtful": "doubtful"}
THREAT = {"": "extant", "Extinct": "extinct"}
_LOCATION = re.compile(r"TDWG:(?:([A-Z]{3})|([0-9]{1,2}))")

# Lower edge of each bin (native species), half-decades; Colombia's 25,490 is the most.
BIN_EDGES = (1, 10, 30, 100, 300, 1000, 3000, 10000)
# viridis at 8 steps, as the freshwater fish layer: more species reads lighter on the dark globe
BIN_COLOURS = (
    "#440154",
    "#46327e",
    "#365c8d",
    "#277f8e",
    "#1fa187",
    "#4ac16d",
    "#a0da39",
    "#fde725",
)
NONE_COLOUR = "#6b7280"  # a unit with no native species recorded (Bouvet Island)
SOURCE = {
    "id": "plants-wcvp",
    "name": "World Checklist of Vascular Plants (WCVP) 16.0",
    "url": "https://sftp.kew.org/pub/data-repositories/WCVP/",
    "paper": "https://doi.org/10.1038/s41597-021-00997-6",
    "data": ZIP_URL,
    "licence": "CC BY 3.0 (Royal Botanic Gardens, Kew)",
    # the eml.xml citation's DOI 10.34885/egs6-cp24 answered 404 at doi.org on 2026-10-06, so it is not published
    "citation": "WCVP (2026) World Checklist of Vascular Plants, version 16.0. Facilitated by the Royal Botanic "
    "Gardens, Kew. https://sftp.kew.org/pub/data-repositories/WCVP/ Retrieved 2026-10-06; Govaerts R., Nic Lughadha "
    "E., Black N., Turner R., Paton A. (2021) The World Checklist of Vascular Plants, a continuously updated resource "
    "for exploring global plant diversity. Scientific Data 8:215. doi:10.1038/s41597-021-00997-6",
    "boundaries": "TDWG World Geographical Scheme for Recording Plant Distributions (WGSRPD), Level 3, "
    f"github.com/tdwg/wgsrpd @ {TDWG_COMMIT[:7]}; tdwg.org content CC BY 4.0",
    "note": "Accepted species only. Native: not introduced, doubtful or extinct there. Endemic: native to that unit "
    "and no other place in WCVP. Larger units hold more species. Boundaries lightly simplified for display.",
}


def bin_of(n: int) -> int | None:
    """Bin index of a native count; None for 0 (no native species recorded)."""
    if n < 0:
        raise ValueError(f"{n} species")
    if n == 0:
        return None
    return max(i for i, e in enumerate(BIN_EDGES) if n >= e)


def bin_label(i: int) -> str:
    if i == len(BIN_EDGES) - 1:
        return f"{BIN_EDGES[i]:,}+"
    return f"{BIN_EDGES[i]:,}–{BIN_EDGES[i + 1] - 1:,}"


def fetch(cache: Path, *, fetch_to=_fetch_to, want: dict = FILES) -> Path:
    """Both files in `cache`, each downloaded once; a file is refused (and not kept) unless its md5 is the pinned one."""
    cache.mkdir(parents=True, exist_ok=True)
    for name, (url, md5) in want.items():
        path = cache / name
        if path.exists():
            got = _md5(path)
            if got != md5:
                raise ValueError(
                    f"{path}: md5 {got} is not the pinned {md5}; delete it to fetch again"
                )
            continue
        part = cache / f"{name}.part"
        log.info("downloading %s → %s", url, path)
        try:
            fetch_to(url, part)
            got = _md5(part)
            if got != md5:
                raise ValueError(f"{name}: md5 {got} is not the pinned {md5}")
            os.replace(part, path)
        finally:
            part.unlink(missing_ok=True)
    return cache


def check_eml(z: zipfile.ZipFile) -> dict:
    """The archive's own version and licence, re-read at every build: anything but 16.0 under CC BY 3.0 stops it."""
    text = z.read("eml.xml").decode("utf-8")
    version = re.search(r"<version>\s*([^<\s]+)\s*</version>", text)
    rights = re.search(r"<intellectualRights>(.*?)</intellectualRights>", text, re.S)
    pub = re.search(r"<pubDate>\s*([^<\s]+)\s*</pubDate>", text)
    if not version or version.group(1) != VERSION:
        raise ValueError(
            f"eml.xml: version {version and version.group(1)!r}, not {VERSION}"
        )
    if not rights or LICENCE_URL not in rights.group(1):
        raise ValueError(f"eml.xml: intellectualRights does not name {LICENCE_URL}")
    return {
        "version": version.group(1),
        "licence": "CC BY 3.0",
        "published": pub and pub.group(1),
    }


def read_meta(z: zipfile.ZipFile) -> dict:
    """meta.xml → {rowType short name: {"file", "sep", "quote", "skip", "encoding", "index": {term short name: column}}};
    the id / coreid column is "taxonID" in the core and "coreid" in an extension.

    XML: stdlib ElementTree, as in pipeline/griis.py: Kew's own archive over HTTPS, md5-pinned; the bundled expat bounds
    entity expansion, and defusedxml is not a dependency CI installs."""
    import xml.etree.ElementTree as ET

    ns = "{http://rs.tdwg.org/dwc/text/}"
    root = ET.fromstring(z.read("meta.xml"))  # nosec B314 - Kew archive over HTTPS, md5-pinned; expat bounds entity expansion, see docstring
    out = {}
    for node in [*root.findall(f"{ns}core"), *root.findall(f"{ns}extension")]:
        kind = node.get("rowType", "").rstrip("/").rsplit("/", 1)[-1]
        loc = node.find(f"{ns}files/{ns}location")
        idn = (
            node.find(f"{ns}id")
            if node.tag == f"{ns}core"
            else node.find(f"{ns}coreid")
        )
        if loc is None or idn is None:
            raise ValueError(f"meta.xml: {kind} has no file location or id index")
        index = {"coreid": int(idn.get("index", "0"))}
        for f in node.findall(f"{ns}field"):
            if f.get("index") is not None:
                index[f.get("term", "").rstrip("/").rsplit("/", 1)[-1]] = int(
                    f.get("index")
                )
        out[kind] = {
            "file": (loc.text or "").strip(),
            "sep": node.get("fieldsTerminatedBy", ","),
            "quote": node.get("fieldsEnclosedBy", ""),
            "skip": int(node.get("ignoreHeaderLines", "0")),
            "encoding": node.get("encoding", "UTF-8"),
            "index": index,
        }
    return out


def iter_rows(z: zipfile.ZipFile, spec: dict, terms: tuple[str, ...]):
    """Stream the named terms of each row of one archive file, in order. A missing term or a short row stops the run."""
    missing = [t for t in terms if t not in spec["index"]]
    if missing:
        raise ValueError(f"meta.xml: {spec['file']} declares no {missing}")
    idx = [spec["index"][t] for t in terms]
    need = max(idx) + 1
    with z.open(spec["file"]) as raw:
        text = io.TextIOWrapper(raw, encoding=spec["encoding"], newline="")
        reader = csv.reader(
            text,
            delimiter=spec["sep"],
            quotechar=spec["quote"] or None,
            quoting=csv.QUOTE_MINIMAL if spec["quote"] else csv.QUOTE_NONE,
        )
        for n, cols in enumerate(reader, start=1):
            if n <= spec["skip"]:
                continue
            if len(cols) < need:
                raise ValueError(
                    f"{spec['file']} line {n}: {len(cols)} columns, meta.xml needs {need}"
                )
            yield tuple(cols[i] for i in idx)


def accepted_species(rows) -> set[str]:
    """taxonIDs of accepted species, from (taxonID, taxonRank, taxonomicStatus) rows."""
    return {
        tid for tid, rank, status in rows if rank == "Species" and status == "Accepted"
    }


def tally(rows, species: set[str], l3_codes: set[str]) -> tuple[dict, dict]:
    """Distribution rows (coreid, locationID, establishmentMeans, occurrenceStatus, threatStatus) of the accepted
    species → ({L3 code: {"native": n, "endemic": n, "introduced": n}} for every code in l3_codes, stats)."""
    native: dict[str, set] = {c: set() for c in l3_codes}
    introduced: dict[str, set] = {c: set() for c in l3_codes}
    native_units: dict[str, set] = {}  # species → its native L3 codes
    coarse_native: set = set()  # species with a native row at Level 1 or 2
    stats = {"rows": 0, "species_rows": 0, "coarse_rows": 0}
    for sid, loc, est, occ, thr in rows:
        stats["rows"] += 1
        if est not in ESTABLISHMENT or occ not in OCCURRENCE or thr not in THREAT:
            raise ValueError(
                f"taxon {sid} at {loc}: establishmentMeans {est!r}, occurrenceStatus {occ!r}, threatStatus {thr!r} "
                "is not in the published vocabulary"
            )
        m = _LOCATION.fullmatch(loc)
        if not m:
            raise ValueError(f"taxon {sid}: location {loc!r} is not a WGSRPD code")
        code = m.group(1)
        if code is not None and code not in l3_codes:
            raise ValueError(f"taxon {sid}: Level-3 code {code} has no boundary")
        if sid not in species:
            continue
        stats["species_rows"] += 1
        is_native = (
            ESTABLISHMENT[est] == "native"
            and OCCURRENCE[occ] == "present"
            and THREAT[thr] == "extant"
        )
        is_introduced = (
            ESTABLISHMENT[est] == "introduced"
            and OCCURRENCE[occ] == "present"
            and THREAT[thr] == "extant"
        )
        if code is None:
            stats["coarse_rows"] += 1
            if is_native:
                coarse_native.add(sid)
            continue
        if is_native:
            native[code].add(sid)
            native_units.setdefault(sid, set()).add(code)
        elif is_introduced:
            introduced[code].add(sid)
    endemic: dict[str, int] = dict.fromkeys(l3_codes, 0)
    for sid, units in native_units.items():
        if len(units) == 1 and sid not in coarse_native:
            endemic[next(iter(units))] += 1
    stats.update(
        {
            "species": len(species),
            "species_native_somewhere": len(
                native_units | dict.fromkeys(coarse_native)
            ),
            "species_native_coarse_only": len(coarse_native - native_units.keys()),
            "endemic_lost_to_coarse_rows": sum(
                1 for s, u in native_units.items() if len(u) == 1 and s in coarse_native
            ),
        }
    )
    counts = {
        c: {
            "native": len(native[c]),
            "endemic": endemic[c],
            "introduced": len(introduced[c]),
        }
        for c in sorted(l3_codes)
    }
    return counts, stats


def read_units(path: Path) -> list[dict]:
    """The WGSRPD Level-3 features; a repeated code stops the run."""
    feats = json.loads(path.read_text(encoding="utf-8"))["features"]
    seen = set()
    for f in feats:
        code = f["properties"]["LEVEL3_COD"]
        if code in seen:
            raise ValueError(f"Level-3 code {code} appears twice")
        seen.add(code)
    return feats


def build(
    units: list[dict],
    counts: dict,
    tol: float = TOL,
    min_area: float = MIN_AREA,
    expect: int = EXPECTED_UNITS,
):
    """WGSRPD features and the per-code counts → (features in source order, stats)."""
    from shapely.geometry import mapping, shape

    if len(units) != expect:
        raise ValueError(f"{len(units)} Level-3 units, not {expect:,}")
    feats = []
    stats = {"vertices_in": 0, "vertices_out": 0, "invalid_in": 0}
    for u in units:
        p = u["properties"]
        code = p["LEVEL3_COD"]
        c = counts[code]
        g = shape(u["geometry"])
        stats["invalid_in"] += not g.is_valid
        stats["vertices_in"] += _vertices(u["geometry"])
        simple = shape(simplify_geometry(g, tol, min_area))
        if not simple.is_valid:
            raise ValueError(f"{code}: simplified geometry is invalid")
        cut = split_wide(simple)
        if not all(q.is_valid for q in getattr(cut, "geoms", [cut])):
            raise ValueError(f"{code}: a cut strip is invalid")
        sg = mapping(cut)
        stats["vertices_out"] += _vertices(sg)
        b = bin_of(c["native"])
        feats.append(
            {
                "type": "Feature",
                "geometry": sg,
                "properties": {
                    "id": code,
                    "name": p["LEVEL3_NAM"],
                    "level2": p["LEVEL2_COD"],
                    "level1": p["LEVEL1_COD"],
                    "native": c["native"],
                    "endemic": c["endemic"],
                    "introduced": c["introduced"],
                    "bin": b,
                    "color": NONE_COLOUR if b is None else BIN_COLOURS[b],
                    "area_km2": round(
                        sum(
                            geometry_area_km2(mapping(q))
                            for q in getattr(g, "geoms", [g])
                            if q.geom_type == "Polygon"
                        )
                    ),
                },
            }
        )
    stats["units"] = len(feats)
    return feats, stats


def _vertices(geom: dict) -> int:
    polys = (
        geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    )
    return sum(len(r) for poly in polys for r in poly)


def collection(feats: list[dict], stats: dict, eml: dict) -> dict:
    return {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {**SOURCE, "version": eml["version"], "published": eml["published"]},
        "bins": [
            {"min": e, "label": bin_label(i), "color": BIN_COLOURS[i]}
            for i, e in enumerate(BIN_EDGES)
        ],
        "none_color": NONE_COLOUR,
        "counts": stats,
        "features": feats,
    }


def count_archive(zpath: Path, l3_codes: set[str]) -> tuple[dict, dict, dict]:
    """The archive → (per-code counts, stats, eml facts)."""
    with zipfile.ZipFile(zpath) as z:
        eml = check_eml(z)
        meta = read_meta(z)
        if TAXON not in meta or DISTRIBUTION not in meta:
            raise ValueError(
                f"meta.xml: row types {sorted(meta)}, need Taxon and Distribution"
            )
        species = accepted_species(iter_rows(z, meta[TAXON], TAXON_TERMS))
        dist_terms = ("coreid", *DIST_TERMS)
        counts, stats = tally(
            iter_rows(z, meta[DISTRIBUTION], dist_terms), species, l3_codes
        )
    return counts, stats, eml


def main(
    argv=None, *, fetch_to=_fetch_to, want: dict = FILES, expect: int = EXPECTED_UNITS
) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=Path("public/data/plants_wcvp.geojson"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        ),
    )
    ap.add_argument("--tol", type=float, default=TOL)
    ap.add_argument("--budget", type=int, default=BUDGET_BYTES)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    d = fetch(a.cache / CACHE_DIR, fetch_to=fetch_to, want=want)
    units = read_units(d / L3)
    counts, stats, eml = count_archive(
        d / ZIP, {u["properties"]["LEVEL3_COD"] for u in units}
    )
    feats, gstats = build(units, counts, a.tol, MIN_AREA, expect=expect)
    stats.update({**gstats, "tol_deg": a.tol, "max_part_width_deg": MAX_PART_WIDTH})
    doc = collection(feats, stats, eml)
    # the bytes write_atomic writes (json.dump, compact separators)
    size = len(json.dumps(doc, separators=(",", ":")))
    if size > a.budget:
        raise SystemExit(
            f"{size:,} B is over the {a.budget:,} B budget: nothing written"
        )
    write_atomic(a.out, doc)
    log.info(
        "wrote %s: %s, %.2f MB (%.0f s)",
        a.out,
        stats,
        a.out.stat().st_size / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
