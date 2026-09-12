"""H5N1 sampled spread from the Nextstrain avian-flu builds (site-series contract) →
public/data/h5n1.geojson.

What ships and why only this: the Nextstrain avian-flu project publishes two families of
H5N1 builds (README read 2026-09-12). The *segment-focused* builds (`avian-flu/h5n1/ha/2y`,
`.../all-time`, h5nx, h7n9, h9n2) are built "using GISAID data"; the GISAID EpiFlu Database
Access Agreement (read live 2026-09-12) defines "Data" to include "derivatives", says "You
agree not to distribute Data to any third party other than Authorized Users", and forbids use
"in connection with any other database related to influenza gene sequences, including …  by
enabling others to access or use the Data through a separate portal … except for operators
duly authorized by GISAID". A public globe is such a portal and wildeye is not an authorized
operator, so the GISAID-fed builds are DECLINED even in aggregate. The *genome-focused*
builds (the 2024 cattle outbreak and the D1.1 outbreak) come from USDA → NCBI GenBank + SRA
(`meta.data_provenance`), which is open, so those are the builds this pipeline reads.

Nothing per-sample is written. Sequences, accessions, strain names, authors and originating /
submitting laboratories are read in memory only (strain names are used to de-duplicate across
builds and to separate poultry from wild birds) and never reach the output: the output is
counts per location per ISO week per host category and per genotype.

Datasets are discovered LIVE through the charon API (`/charon/getAvailable`) — a configured
build that charon no longer lists is a hard failure, not a silent skip. The Auspice JSON for a
charon request path is that path with "/" → "_" on https://data.nextstrain.org/.

Coordinates are the build's own `meta.geo_resolutions` deme centroids: division where the
build has one, else country, else region. Dates are Auspice decimal years
(`node_attrs.num_date`); augur writes `year + (day_of_year - 0.5) / days_in_year`, and a tip
whose date confidence interval spans more than a week cannot be put in a week bin, so it is
dropped and counted in `counts.imprecise_date`.
"""

from __future__ import annotations
import argparse
import collections
import datetime as dt
import gzip
import json
import logging
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("h5n1")
CHARON = "https://nextstrain.org/charon/getAvailable"
DATA_HOST = "https://data.nextstrain.org"
UA = {"User-Agent": "wildeye (github.com/musharna/wildeye)"}
# The open (NCBI/USDA) H5N1 builds. The GISAID-fed segment builds are declined — see module docstring.
OPEN_REQUESTS = (
    "avian-flu/h5n1-cattle-outbreak/ha",
    "avian-flu/h5n1-d1.1/genome",
)
GISAID_REQUESTS = (
    "avian-flu/h5n1/ha/2y",
    "avian-flu/h5n1/ha/all-time",
)
LICENCE = (
    "No licence is asserted over the build itself (nextstrain.org: source code AGPL-3.0/MIT, "
    "\"Screenshots may be used under a CC-BY-4.0 license\"); the underlying sequences and metadata "
    "are USDA/NVSL submissions to NCBI GenBank and the SRA, US Government work in the public domain"
)
NOTE = (
    "Counts are sequenced samples, not infections: they follow surveillance and sequencing effort "
    "(dairy-herd testing, poultry outbreak response, wild-bird surveillance) as much as where the virus is. "
    "Aggregated counts only — no sequences, accessions or per-sample metadata."
)
HOST_CATEGORIES = ("poultry", "wild bird", "cattle", "human", "other")
DEFAULT_WEEKS = 26
WEEK_D = 7

# --- host category: exactly five classes -------------------------------------------------------
# The build's `host` is mostly canonical ("Avian", "Cattle", "Human", "Nonhuman Mammal") but the
# D1.1 and cattle builds also carry raw submitter strings (read 2026-09-12): "CATTLE, DOMESTIC DAIRY
# (NO BREED SPECIFIED)", "Bovidae", "Brant Goose", "Aquila chrysaetos", "HAWK, COOPER'S",
# "Embden Goose", "House fly", "Ursus sp." … So: cattle and human by vocabulary; a sample is avian
# when host says "Avian" or names a bird; an avian sample is POULTRY when its host string or the
# strain-name host token (A/<host>/<place>/<id>/<year>) names a domestic bird, and WILD BIRD
# otherwise. Neither open build carries Nextstrain's `domestic_status`. "turkeyvulture" is diverted
# before "turkey" can match poultry. Everything else (mammals, insects, environment) is OTHER.
CATTLE_WORDS = ("cattle", "bovidae", "bovine", "bos taurus", "dairy")
HUMAN_WORDS = ("human", "homo sapiens")
WILD_FIRST = ("vulture", "condor")
POULTRY_WORDS = (
    "chicken", "turkey", "guineafowl", "guinea fowl", "pheasant", "quail", "poultry", "broiler",
    "layer", "breeder", "ostrich", "emu", "peafowl", "partridge", "domestic", "commercial",
    "backyard", "farm", "gamefowl", "gamebird", "muscovy", "pekin", "embden", "toulouse", "hybrid",
)
BIRD_WORDS = (
    "avian", "bird", "fowl", "goose", "duck", "swan", "teal", "mallard", "wigeon", "pintail", "shoveler",
    "gadwall", "merganser", "scaup", "grebe", "eider", "bufflehead", "anser", "branta", "anas", "cygnus",
    "eagle", "hawk", "owl", "falcon", "kestrel", "harrier", "osprey", "kite", "vulture", "condor",
    "aquila", "buteo", "accipiter", "haliaeetus", "bubo", "strix", "falco", "cathartes", "coragyps",
    "crow", "raven", "corvus", "jay", "magpie", "starling", "sparrow", "blackbird", "cowbird", "grackle", "finch",
    "fringillidae", "sialia", "bluebird", "robin", "turdus", "pigeon", "dove", "columba",
    "heron", "egret", "night heron", "pelican", "cormorant", "ibis", "stork", "crane", "flamingo",
    "tern", "gull", "larus", "leucophaeus", "kittiwake", "skua", "murre", "puffin", "auk",
    "sandpiper", "plover", "godwit", "curlew", "dunlin", "stilt", "himantopus", "avocet", "coot",
    "fulica", "loon", "gavia", "rail", "gallinule", "shorebird", "waterfowl", "seabird", "raptor",
)


def _norm(x: str | None) -> str:
    return (x or "").strip().lower()


def _has_word(text: str, words) -> bool:
    """Whole-word match (plural s allowed) so "tern" does not fire inside "eastern"."""
    return any(re.search(rf"\b{re.escape(w)}s?\b", text) for w in words)


def host_category(host: str | None, strain: str | None) -> str:
    """One of the five HOST_CATEGORIES for a tip (see the table comment above).

    Host strings are matched on whole words; the strain-name token is matched as a squashed
    substring because names write species run together ("canadagoose", "turkeyvulture")."""
    h = _norm(host)
    parts = (strain or "").split("/")
    token = _norm(parts[1]).replace(" ", "") if len(parts) > 2 else ""
    if _has_word(h, CATTLE_WORDS):
        return "cattle"
    if _has_word(h, HUMAN_WORDS):
        return "human"
    if h != "avian" and not _has_word(h, BIRD_WORDS):
        return "other"
    if _has_word(h, WILD_FIRST) or any(w in token for w in WILD_FIRST):
        return "wild bird"
    if _has_word(h, POULTRY_WORDS) or any(w.replace(" ", "") in token for w in POULTRY_WORDS):
        return "poultry"
    return "wild bird"


# --- fetching ----------------------------------------------------------------------------------
def decode_body(raw: bytes, encoding: str | None) -> dict:
    """data.nextstrain.org serves the Auspice JSON gzip-encoded even to a client that sent no
    Accept-Encoding (seen 2026-09-12: body starts 1f 8b), and urllib does not inflate it."""
    if (encoding or "").lower() == "gzip" or raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def _get_json(url: str, timeout: int = 300) -> dict:
    req = urllib.request.Request(url, headers={**UA, "Accept": "application/json", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return decode_body(r.read(), r.headers.get("Content-Encoding"))


def dataset_url(request: str) -> str:
    """Auspice JSON for a charon request path: the path with "/" → "_" under data.nextstrain.org."""
    return f"{DATA_HOST}/{request.replace('/', '_')}.json"


def available(fetch=None) -> list[str]:
    d = (fetch or _get_json)(CHARON)
    return [x["request"] for x in d.get("datasets", []) if x.get("request")]


def resolve(requests: tuple[str, ...], listed: list[str]) -> list[str]:
    """Every configured build must still be listed by charon; a vanished build fails loud."""
    missing = [r for r in requests if r not in listed]
    if missing:
        raise RuntimeError(f"charon no longer lists: {missing} (listed {len(listed)} datasets)")
    return list(requests)


# --- dates -------------------------------------------------------------------------------------
def _days_in_year(y: int) -> int:
    return 366 if (y % 4 == 0 and (y % 100 or y % 400 == 0)) else 365


def decimal_to_date(v: float) -> dt.date:
    """Invert augur's `numeric_date` = year + (day_of_year - 0.5) / days_in_year."""
    y = int(v)
    doy = round((v - y) * _days_in_year(y) + 0.5)
    doy = min(max(doy, 1), _days_in_year(y))
    return dt.date(y, 1, 1) + dt.timedelta(days=doy - 1)


def tip_date(num_date: dict, max_span_days: float = 7.0) -> dt.date | None:
    """Tip date, or None when the confidence interval is too wide to place in a week."""
    v = (num_date or {}).get("value")
    if not isinstance(v, (int, float)):
        return None
    c = num_date.get("confidence")
    if c and len(c) == 2 and (c[1] - c[0]) * 365.25 > max_span_days:
        return None
    return decimal_to_date(float(v))


def week_ends(data_end: dt.date, weeks: int) -> list[dt.date]:
    """`weeks` 7-day bins ending on `data_end`, newest first (bin k covers (end-7k-6 … end-7k])."""
    return [data_end - dt.timedelta(days=WEEK_D * k) for k in range(weeks)]


# --- tree walking ------------------------------------------------------------------------------
def iter_tips(node: dict):
    kids = node.get("children")
    if kids:
        for k in kids:
            yield from iter_tips(k)
    else:
        yield node


def _val(attrs: dict, key: str):
    v = (attrs.get(key) or {}).get("value")
    return v if isinstance(v, str) and v.strip() else None


def clade_of(attrs: dict) -> tuple[str, str] | tuple[None, None]:
    """(clade, field) from the first clade-ish attribute the build carries."""
    for field in ("label_clade", "gisaid_clade", "genoflu"):
        v = _val(attrs, field)
        if v:
            return v, field
    return None, None


def parse_dataset(gj: dict, request: str) -> tuple[list[dict], dict, dict]:
    """(samples, demes_by_level, meta) for one Auspice JSON.

    A sample is {strain, date, host, clade, clade_field, division, country, region}; strain never
    leaves this module's memory.
    """
    meta = gj.get("meta") or {}
    demes = {g["key"]: g.get("demes") or {} for g in meta.get("geo_resolutions") or []}
    out, counts = [], collections.Counter()
    for tip in iter_tips(gj["tree"]):
        a = tip.get("node_attrs") or {}
        d = tip_date(a.get("num_date"))
        if d is None:
            counts["imprecise_date"] += 1
            continue
        clade, field = clade_of(a)
        out.append({
            "strain": tip.get("name") or "",
            "date": d,
            "host": _val(a, "host"),
            "category": host_category(_val(a, "host"), tip.get("name")),
            "clade": clade,
            "clade_field": field,
            "division": _val(a, "division"),
            "country": _val(a, "country"),
            "region": _val(a, "region"),
        })
    info = {
        "request": request,
        "url": dataset_url(request),
        "title": meta.get("title"),
        "updated": meta.get("updated"),
        "build_url": meta.get("build_url"),
        "provenance": [p.get("name") for p in meta.get("data_provenance") or [] if p.get("name")],
        "tips": len(out) + counts["imprecise_date"],
        "imprecise_date": counts["imprecise_date"],
    }
    return out, demes, info


def locate(s: dict, demes: dict) -> tuple[str, str, float, float] | None:
    """(level, name, lon, lat) — division if the build has a centroid for it, else country, else region."""
    for level in ("division", "country", "region"):
        name = s.get(level)
        if not name:
            continue
        c = (demes.get(level) or {}).get(name)
        if c and c.get("longitude") is not None and c.get("latitude") is not None:
            return level, name, round(float(c["longitude"]), 5), round(float(c["latitude"]), 5)
    return None


# --- aggregation -------------------------------------------------------------------------------
def aggregate(per_dataset: list[tuple[list[dict], dict]], weeks: int,
              data_end: dt.date | None = None) -> tuple[list[dict], dict]:
    """Point features with weekly per-host-category and per-clade counts.

    `per_dataset` = [(samples, demes)]. Samples are de-duplicated on strain name across builds
    (the cattle-outbreak and D1.1 builds share the USDA/NCBI feed), so a strain sequenced into
    both is counted once. Returns (features, counts).
    """
    counts = collections.Counter()
    seen: set[str] = set()
    flat: list[tuple[dict, dict]] = []
    for samples, demes in per_dataset:
        for s in samples:
            counts["samples"] += 1
            key = s["strain"].lower()
            if key and key in seen:
                counts["duplicate"] += 1
                continue
            if key:
                seen.add(key)
            flat.append((s, demes))
    if not flat:
        return [], dict(counts) | {"locations": 0, "data_end": None, "in_window": 0}
    if data_end is None:
        data_end = max(s["date"] for s, _ in flat)
    ends = week_ends(data_end, weeks)
    locs: dict[tuple, dict] = {}
    for s, demes in flat:
        where = locate(s, demes)
        if where is None:
            counts["no_geo"] += 1
            continue
        k = (data_end - s["date"]).days // WEEK_D
        if k < 0 or k >= weeks:
            counts["outside_window"] += 1
            continue
        counts["in_window"] += 1
        level, name, lon, lat = where
        e = locs.setdefault((level, name, s.get("country") or name, lon, lat), {
            "hosts": [collections.Counter() for _ in range(weeks)],
            "clades": [collections.Counter() for _ in range(weeks)],
            "region": s.get("region"),
            "raw_hosts": collections.Counter(),
        })
        e["hosts"][k][s["category"]] += 1
        e["raw_hosts"][s["host"] or "unknown"] += 1
        if s["clade"]:
            e["clades"][k][s["clade"]] += 1
    feats = []
    for (level, name, country, lon, lat), e in sorted(locs.items()):
        total = collections.Counter()
        clade_total = collections.Counter()
        for c in e["hosts"]:
            total.update(c)
        for c in e["clades"]:
            clade_total.update(c)
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "loc": name,
                "level": level,
                "country": country,
                "region": e["region"],
                "n": sum(total.values()),
                "hosts": {c: total[c] for c in HOST_CATEGORIES if total[c]},
                "raw_hosts": dict(e["raw_hosts"].most_common()),
                "clades": dict(clade_total.most_common(6)),
                "weeks": [
                    {"w": ends[k].isoformat(), "n": dict(e["hosts"][k]), "c": dict(e["clades"][k])}
                    for k in range(weeks) if e["hosts"][k]
                ],
            },
        })
    counts["locations"] = len(feats)
    counts["data_end"] = data_end.isoformat()
    return feats, dict(counts)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/h5n1.geojson"))
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS, help="weekly bins kept, ending at the newest sample")
    ap.add_argument("--sleep", type=float, default=2.0, help="seconds between dataset fetches")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    t0 = time.time()
    listed = available()
    requests = resolve(OPEN_REQUESTS, listed)
    log.info("charon lists %d datasets; using %s", len(listed), requests)
    per_dataset, infos, clade_fields = [], [], set()
    for i, r in enumerate(requests):
        if i:
            time.sleep(a.sleep)
        gj = _get_json(dataset_url(r))
        samples, demes, info = parse_dataset(gj, r)
        per_dataset.append((samples, demes))
        infos.append(info)
        clade_fields |= {s["clade_field"] for s in samples if s["clade_field"]}
        log.info("%s: %d tips, %d usable, updated %s", r, info["tips"], len(samples), info["updated"])
    feats, counts = aggregate(per_dataset, a.weeks)
    if not feats:
        raise SystemExit("no locations with dated, placeable samples")
    clades = sorted({c for f in feats for c in f["properties"]["clades"]})
    write_atomic(a.out, {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "id": "h5n1",
            "name": "Nextstrain avian-flu H5N1 (genome-focused, open NCBI data)",
            "url": "https://nextstrain.org/avian-flu",
            "charon": CHARON,
            "licence": LICENCE,
            "declined": {"requests": list(GISAID_REQUESTS),
                         "reason": "built from GISAID data; the EpiFlu Database Access Agreement bars redistributing Data or derivatives through a separate portal"},
            "note": NOTE,
        },
        "data_end": counts["data_end"],
        "weeks": a.weeks,
        "categories": list(HOST_CATEGORIES),
        "clade_field": sorted(clade_fields),
        "clades": clades,
        "datasets": infos,
        "counts": counts,
        "features": feats,
    })
    log.info("wrote %s: %s (%.0f s)", a.out, counts, time.time() - t0)


if __name__ == "__main__":
    main()
