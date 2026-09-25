"""Global Register of Introduced and Invasive Species (GRIIS) by country (polygon contract) →
public/data/griis.geojson.

Item 4 of the 2026-09-25 wave (grill_wildeye_next_wave_2026-09-25, GRIIS mini-grill Q13/Q14,
A22–A33). Source: the live GRIIS checklists the Invasive Species Specialist Group (ISSG) publishes on
GBIF, one Darwin Core Archive per country, territory or island (2026-09-25: 307 area registers, 75
protected-area registers named but not drawn, and the Global Invasive Species Database, which is not a
register; CC BY 4.0, three CC0). Not the 2022 Country Compendium (V1_0, stale: 94 lists updated in 2026) and not third-party
re-bundles. Each archive is downloaded once per version and cached.
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import logging
import os
import re
import time
import urllib.request
from pathlib import Path

from .atomic import write_atomic

log = logging.getLogger("griis")
ORG = "cdef28b1-db4e-4c58-aa71-3c5238c2d0b5"  # Invasive Species Specialist Group ISSG on GBIF
LIST_URL = (
    "https://api.gbif.org/v1/organization/"
    + ORG
    + "/publishedDataset?limit={limit}&offset={offset}"
)
UA = "wildeye/0.1 (griis sync)"
LICENCES = {
    "http://creativecommons.org/licenses/by/4.0/legalcode": "CC BY 4.0",
    "http://creativecommons.org/publicdomain/zero/1.0/legalcode": "CC0 1.0",
}
_REGISTER = (
    r"(?:Global Register|GRIIS Checklist) of (?:Introduced and Invasive|Invasive and Introduced) Species"
    r"(?: GRIIS)?\s*[-–]\s*(.+?)\s*$"
)
_TITLE = re.compile("^" + _REGISTER)
_PROTECTED = re.compile(r"^Protected Areas\s*[-–]\s*" + _REGISTER)
# ISSG checklists that are not area registers; any other title that fits neither form raises.
NOT_A_REGISTER = {"Global Invasive Species Database"}
_VERSION_TAG = re.compile(r"\s*\(ver\.[^()]*\)$")


def area_of(title: str) -> str:
    """The area a GRIIS checklist covers, from its title: 'Hawaii, United States (ver.2.0, 2022)' → 'Hawaii, United States'."""
    m = _TITLE.match(title)
    if not m:
        raise ValueError(f"not a GRIIS title: {title!r}")
    return _VERSION_TAG.sub("", m.group(1)).strip()


def list_checklists(fetch_json, limit: int = 1000) -> tuple[list[dict], list[str]]:
    """Every national GRIIS checklist ISSG publishes, sorted by GBIF dataset key, and the areas of the
    protected-area lists (named, not drawn). A checklist whose title matches neither form and is not in
    NOT_A_REGISTER raises, as does a GRIIS list without a Darwin Core Archive or under a licence
    other than CC BY 4.0 / CC0: nothing is skipped silently."""
    out, protected, offset = [], [], 0
    while True:
        page = fetch_json(LIST_URL.format(limit=limit, offset=offset))
        for d in page["results"]:
            if d.get("type") != "CHECKLIST":
                continue
            title = d.get("title", "")
            if m := _PROTECTED.match(title):
                protected.append(_VERSION_TAG.sub("", m.group(1)).strip())
                continue
            if title in NOT_A_REGISTER:
                continue
            if not _TITLE.match(title):
                raise ValueError(f"{title}: unrecognised GRIIS title")
            arch = [
                e["url"]
                for e in d.get("endpoints", [])
                if e.get("type") == "DWC_ARCHIVE"
            ]
            if not arch:
                raise ValueError(f"{title}: no DWC_ARCHIVE endpoint")
            licence = LICENCES.get(d.get("license"))
            if not licence:
                raise ValueError(
                    f"{title}: licence {d.get('license')!r} is neither CC BY 4.0 nor CC0"
                )
            out.append(
                {
                    "key": d["key"],
                    "title": title,
                    "area": area_of(title),
                    "modified": d["modified"][:10],
                    "doi": d.get("doi"),
                    "licence": licence,
                    "citation": (d.get("citation") or {}).get("text", ""),
                    "archive": arch[0],
                }
            )
        if page.get("endOfRecords", True):
            break
        offset += limit
    return sorted(out, key=lambda c: c["key"]), sorted(protected)


def cached_archive(c: dict, cache: Path, fetch_bytes) -> Path:
    """The checklist's archive at `cache/<key>_<modified>.zip`, downloaded only when that version is not
    cached; older versions of the same list are deleted."""
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"{c['key']}_{c['modified']}.zip"
    if not path.exists():
        data = fetch_bytes(c["archive"])
        tmp = path.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(path)
        for old in cache.glob(f"{c['key']}_*.zip"):
            if old != path:
                old.unlink()
    return path


def _unescape(s: str) -> str:
    return s.replace("\\t", "\t").replace(
        "\\n", "\n"
    )  # meta.xml writes separators escaped


def read_dwca(data: bytes | Path) -> dict[str, list[dict]]:
    """A Darwin Core Archive → {rowType short name: [{"id": …, term short name: value}]}, columns mapped by the
    indexes meta.xml declares (headers are not trusted; a default-only field fills every row). A row with fewer
    columns than meta.xml needs raises.

    XML: stdlib ElementTree, as in pipeline/gibs.py — meta.xml comes from GBIF's own IPT over HTTPS, the bundled
    expat bounds entity expansion, and defusedxml is not a dependency CI installs."""
    import csv
    import io
    import zipfile
    import xml.etree.ElementTree as ET

    z = zipfile.ZipFile(io.BytesIO(data) if isinstance(data, bytes) else data)
    if "meta.xml" not in z.namelist():
        raise ValueError(f"no meta.xml in archive ({z.namelist()[:5]})")
    ns = "{http://rs.tdwg.org/dwc/text/}"
    root = ET.fromstring(z.read("meta.xml"))
    out: dict[str, list[dict]] = {}
    for node in [*root.findall(f"{ns}core"), *root.findall(f"{ns}extension")]:
        kind = node.get("rowType", "").rstrip("/").rsplit("/", 1)[-1]
        loc_node = node.find(f"{ns}files/{ns}location")
        id_node = (
            node.find(f"{ns}id")
            if node.tag == f"{ns}core"
            else node.find(f"{ns}coreid")
        )
        if (
            loc_node is None
            or not (loc_node.text or "").strip()
            or id_node is None
            or id_node.get("index") is None
        ):
            raise ValueError(
                f"meta.xml: {kind or node.tag} has no file location or id index"
            )
        loc = (loc_node.text or "").strip()
        id_idx = int(id_node.get("index") or 0)
        fields = []
        for f in node.findall(f"{ns}field"):
            term, idx = f.get("term"), f.get("index")
            if not term:
                raise ValueError(f"meta.xml: {loc} has a field with no term")
            fields.append(
                (
                    term.rstrip("/").rsplit("/", 1)[-1],
                    int(idx) if idx is not None else None,
                    f.get("default"),
                )
            )
        need = max([id_idx, *[i for _, i, _ in fields if i is not None]]) + 1
        sep = _unescape(node.get("fieldsTerminatedBy", ","))
        quote = node.get("fieldsEnclosedBy", "")
        text = z.read(loc).decode(node.get("encoding", "UTF-8"))
        reader = csv.reader(
            io.StringIO(text),
            delimiter=sep,
            quotechar=quote or None,
            quoting=csv.QUOTE_MINIMAL if quote else csv.QUOTE_NONE,
        )
        rows = []
        for n, cols in enumerate(reader, start=1):
            if n <= int(node.get("ignoreHeaderLines", "0")) or not any(
                c.strip() for c in cols
            ):
                continue
            if len(cols) < need:
                raise ValueError(
                    f"{loc} line {n}: {len(cols)} columns, meta.xml needs {need}"
                )
            row = {"id": cols[id_idx]}
            for term, i, default in fields:
                row[term] = cols[i] if i is not None else (default or "")
            rows.append(row)
        out[kind] = rows
    return out


# Vocabularies as published (census of the live archives, 2026-09-25), compared lower-cased with runs of
# whitespace collapsed. Anything else raises: a new spelling is a decision, not a guess.
PRESENT = {
    "present",
    "reported",
    "invasive",
}  # "Invasive" in the status column (Niue): the species is there
NOT_PRESENT = {
    "uncertain",
    "eradicated",
    "absent",
    "on-going eradication",
    "",
    "cryptogenic|uncertain",  # an origin value in the status column (TAAF): the occurrence is not asserted
}
INTRODUCED = {
    "alien",
    "introduced",
    "introduced (alien, exotic, non-native, nonindigenous)",
    "introduced: assisted colonization",
    "introduced (alien, exotic, non-native, nonindigenous); introduced: assisted colonization",
    # native in part of the area, alien in another: on the register as alien there
    "native|alien",
    "native|introduced",
    "alien/native",
    "native/alien",
    "native|invasive",
}
ORIGIN_UNKNOWN = {
    "cryptogenic|uncertain",
    "cryptogenic|uncerain",
    "cryptogenic/uncertain",
    "cryptogenic|unknown",
    "uncertain",
    "",
}  # "" = origin not stated
FLAG_TRUE = {
    "invasive",
    "yes",
    "true",
    "invasive in the north of the island (122).",  # Montserrat: invasive, with where
}
FLAG_FALSE = {
    "",
    "null",
    "false",
    "invasive?",
    "invasive ?",
}  # a questioned flag is not a flag
_CATEGORY = re.compile(r"\(category ([A-E]\d?)\)$")
SPREAD_INVASIVE = {
    "D2",
    "E",
}  # Darwin Core degreeOfEstablishment (TDWG, after Blackburn et al. 2011, doi:10.1016/j.tree.2011.03.023): D2 invasive, E widespread invasive
# The same vocabulary as bare words, pipe-joined when a taxon has several (Belgium). "transported" (Belgium)
# is the framework's transport stage; "NA" is Belgium's not-assessed.
DOE_INVASIVE = {"invasive", "widespreadinvasive"}
DOE_OTHER = {
    "native",
    "captive",
    "cultivated",
    "released",
    "failing",
    "casual",
    "reproducing",
    "established",
    "colonising",
    "transported",
    "na",
}


def _degree_invasive(v) -> bool:
    raw = " ".join(str(v or "").split())
    if m := _CATEGORY.search(raw):
        return m.group(1) in SPREAD_INVASIVE
    words = [w.strip().lower() for w in raw.split("|")]
    if not raw or any(w not in DOE_INVASIVE | DOE_OTHER for w in words):
        raise ValueError(f"degreeOfEstablishment {v!r} has no rule")
    return any(w in DOE_INVASIVE for w in words)


def _norm(v) -> str:
    return " ".join(str(v or "").split()).lower()


def count_list(t: dict[str, list[dict]]) -> dict:
    """Species on one checklist: `introduced` = taxa present and introduced; `invasive` = those of them flagged
    invasive, by the list's own basis — "impact" (GRIIS isInvasive: evidence of impact in the area) or
    "spread" (degreeOfEstablishment D2/E or the words invasive/widespreadInvasive, used when no isInvasive
    value is filled in: US-RIIS, Belgium) or "not stated" (an isInvasive column left blank and no degree
    column: `invasive` is None, not 0). `excluded` counts the taxa left out and why. A list with no occurrenceStatus column (Turkey) asserts no
    status, so its rows count as present and `presence` says "not stated"; a blank value in a list that has the
    column is not present."""
    dist = t.get("Distribution") or []
    if not dist:
        raise ValueError("no Distribution rows")
    if "Taxon" not in t:
        raise ValueError(f"no Taxon core: {sorted(t)}")
    taxa = {r["id"] for r in t["Taxon"]}
    sp = t.get("SpeciesProfile") or []
    flag_column = bool(sp) and "isInvasive" in sp[0]
    has_flag = flag_column and any(_norm(r.get("isInvasive")) for r in sp)
    has_degree = "degreeOfEstablishment" in dist[0]
    has_status = "occurrenceStatus" in dist[0]
    if not flag_column and not has_degree:
        raise ValueError(
            "neither an isInvasive column nor degreeOfEstablishment: no invasive basis"
        )
    basis = "impact" if has_flag else "spread" if has_degree else "not stated"
    introduced, not_present, unknown_origin, spread, no_taxon = set(), set(), set(), set(), set()
    for r in dist:
        if r["id"] not in taxa:
            no_taxon.add(r["id"])
            continue
        status, means = (
            _norm(r.get("occurrenceStatus")) if has_status else "present",
            _norm(r.get("establishmentMeans")),
        )
        if status not in PRESENT | NOT_PRESENT:
            raise ValueError(
                f"occurrenceStatus {r.get('occurrenceStatus')!r} has no rule"
            )
        if means not in INTRODUCED | ORIGIN_UNKNOWN:
            raise ValueError(
                f"establishmentMeans {r.get('establishmentMeans')!r} has no rule"
            )
        if status not in PRESENT:
            not_present.add(r["id"])
        elif means in ORIGIN_UNKNOWN:
            unknown_origin.add(r["id"])
        else:
            introduced.add(r["id"])
            if basis == "spread" and _degree_invasive(r.get("degreeOfEstablishment")):
                spread.add(r["id"])
    if has_flag:
        flagged = set()
        for r in sp:
            v = _norm(r.get("isInvasive"))
            if v not in FLAG_TRUE | FLAG_FALSE:
                raise ValueError(f"isInvasive {r.get('isInvasive')!r} has no rule")
            if v in FLAG_TRUE:
                flagged.add(r["id"])
        invasive = len(flagged & introduced)
    else:
        invasive = len(spread) if basis == "spread" else None
    return {
        "basis": basis,
        "presence": "stated" if has_status else "not stated",
        "introduced": len(introduced),
        "invasive": invasive,
        "excluded": {
            k: len(v)
            for k, v in (
                ("not present", not_present - introduced),
                ("origin unknown", unknown_origin - introduced),
                ("no taxon row", no_taxon),
            )
            if v - introduced
        },
    }


def _rnd(c, nd=2):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [_rnd(x, nd) for x in c]


def _us_piece(poly) -> str:
    """Which GRIIS US list a part of the Natural Earth USA map unit belongs to (grill A27: the US has no
    national GRIIS list, only Contiguous, Alaska and Hawaii). Decided by the part's mean vertex."""
    ring = poly[0]
    lon = sum(p[0] for p in ring) / len(ring)
    lat = sum(p[1] for p in ring) / len(ring)
    if -179.5 < lon < -154 and 18 < lat < 29.5:
        return "USA-HI"
    if lat > 50 and (lon < -129 or lon > 170):  # the Aleutians cross the antimeridian
        return "USA-AK"
    return "USA-CONT"


def load_units(path: Path) -> dict[str, dict]:
    """Natural Earth 50m admin-0 map units → {GU_A3: MultiPolygon} (coordinates rounded to 0.01°), with the
    USA unit replaced by USA-CONT / USA-AK / USA-HI."""
    out: dict[str, dict] = {}
    for f in json.loads(path.read_text())["features"]:
        gu = f["properties"].get("GU_A3")
        if not gu or gu == "-99":
            raise ValueError(f"map unit without GU_A3: {f['properties'].get('NAME')}")
        g = f["geometry"]
        polys = _rnd(
            g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        )
        for poly in polys:
            key = _us_piece(poly) if gu == "USA" else gu
            out.setdefault(key, {"type": "MultiPolygon", "coordinates": []})[
                "coordinates"
            ].append(poly)
    return out


def build(
    lists: list[dict],
    counts: dict[str, dict],
    table: dict[str, dict],
    units: dict[str, dict],
) -> tuple[list[dict], list[dict]]:
    """One feature per checklist the reviewed table maps to map units (geometry = all its units); lists the
    table maps to no unit (smaller than any map unit) are returned as `not_drawn`. A list missing from the
    table, a unit Natural Earth does not have, or two lists on one unit raises."""
    feats, not_drawn, owner = [], [], {}
    for c in sorted(lists, key=lambda c: c["key"]):
        row = table.get(c["key"])
        if row is None:
            raise ValueError(
                f"{c['area']} ({c['key']}) is not in griis_areas.json: map it to its units or to none"
            )
        n = counts[c["key"]]
        if not row["units"]:
            not_drawn.append(
                {
                    "key": c["key"],
                    "area": c["area"],
                    "introduced": n["introduced"],
                    "invasive": n["invasive"],
                    "basis": n["basis"],
                    "presence": n["presence"],
                    "version": c["modified"],
                }
            )
            continue
        coords = []
        for u in row["units"]:
            if u not in units:
                raise ValueError(
                    f"{c['area']}: unit {u!r} is not a Natural Earth map unit"
                )
            if u in owner:
                raise ValueError(
                    f"{u} is claimed by two lists: {owner[u]} and {c['area']}"
                )
            owner[u] = c["area"]
            coords.extend(units[u]["coordinates"])
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": coords},
                "properties": {
                    "key": c["key"],
                    "area": c["area"],
                    "units": row["units"],
                    "introduced": n["introduced"],
                    "invasive": n["invasive"],
                    "basis": n["basis"],
                    "presence": n["presence"],
                    "version": c["modified"],
                    "doi": c["doi"],
                    "licence": c["licence"],
                    "citation": c["citation"],
                },
            }
        )
    gone = sorted(set(table) - {c["key"] for c in lists})
    if gone:
        log.warning(
            "griis_areas.json rows for %d lists GBIF no longer publishes: %s",
            len(gone),
            [table[k]["area"] for k in gone],
        )
    return feats, not_drawn


def _fetch_bytes(url: str) -> bytes:
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": UA}), timeout=300
    ).read()


def _fetch_json(url: str) -> dict:
    return json.loads(_fetch_bytes(url))


AREAS = Path(__file__).with_name("griis_areas.json")
SEED_N, SEED_TOL, SEED_MIN_AREA = 20, 0.25, 0.1


def seed_collection(gj: dict, n: int = SEED_N, tol: float = SEED_TOL, min_area: float = SEED_MIN_AREA) -> dict:
    """The committed fresh-clone seed (< 100 KB): the `n` lists with the most introduced species, shapes
    simplified (pipeline.ecoregions.simplify_geometry); every value kept as is."""
    from .ecoregions import simplify_geometry

    feats = sorted(gj["features"], key=lambda f: -f["properties"]["introduced"])
    keep = feats[:n]
    return {
        **gj,
        "source": {
            **gj["source"],
            "subsample": f"seed: {len(keep)} of {len(feats)} lists with the most introduced species, shapes "
            f"simplified at {tol} deg with parts under {min_area} square degrees dropped; "
            "run pipeline/run_griis.sh for every list",
        },
        "features": [{**f, "geometry": simplify_geometry(f["geometry"], tol, min_area)} for f in keep],
    }


def main(argv=None, *, fetch_json=_fetch_json, fetch_bytes=_fetch_bytes, areas: Path = AREAS):
    from .gmw import NE_URL, _cached

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/griis.geojson"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")),
    )
    ap.add_argument("--seed-out", type=Path, default=None, help="also write the < 100 KB fresh-clone seed here")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    t0 = time.time()
    table = json.loads(areas.read_text())
    lists, protected = list_checklists(fetch_json)
    gone = set(table) - {c["key"] for c in lists}
    if len(gone) > len(table) // 10:
        raise SystemExit(
            f"{len(gone)} of {len(table)} lists in griis_areas.json are not in GBIF's listing: "
            "a truncated listing or a republished register; review before drawing"
        )
    counts = {}
    for c in lists:
        try:
            counts[c["key"]] = count_list(read_dwca(cached_archive(c, a.cache / "griis", fetch_bytes)))
        except ValueError as e:
            raise ValueError(f"{c['area']} ({c['key']}, {c['modified']}): {e}") from e
    units = load_units(_cached(a.cache / "ne_50m_admin_0_map_units.geojson", NE_URL, fetch_bytes))
    feats, not_drawn = build(lists, counts, table, units)
    if not feats:
        raise SystemExit("no GRIIS list matched a map unit")
    gj = {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "id": "griis",
            "name": "Global Register of Introduced and Invasive Species (GRIIS), ISSG via GBIF",
            "licence": "CC BY 4.0 (three lists CC0 1.0); each list's own licence, citation and DOI are in its feature",
            "url": f"https://www.gbif.org/publisher/{ORG}",
            "shapes": "Natural Earth 50m admin-0 map units (public domain); the US split into its three US-RIIS lists",
            "citation": "Invasive Species Specialist Group ISSG. Global Register of Introduced and Invasive Species, "
            "one checklist per area, published on GBIF.",
            "note": "Introduced = taxa present in the area and introduced there. Invasive, by the list's own basis: "
            "GRIIS isInvasive (evidence of impact) or US-RIIS degreeOfEstablishment D2/E (spreading). "
            "The two are not comparable, so the fill is the introduced count.",
        },
        "protected_areas": protected,
        "not_drawn": not_drawn,
        "features": feats,
    }
    write_atomic(a.out, gj)
    if a.seed_out:
        write_atomic(a.seed_out, seed_collection(gj))
        log.info("wrote seed %s: %d bytes", a.seed_out, a.seed_out.stat().st_size)
    log.info(
        "wrote %s: %d lists drawn, %d not drawn, %d protected-area lists named (%.0f s)",
        a.out,
        len(feats),
        len(not_drawn),
        len(protected),
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
