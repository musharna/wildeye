"""Recent wildlife occurrences from GBIF + OBIS → public/data/occurrences.geojson.

Only records whose per-record licence is CC0 or CC-BY are kept (GBIF filters
server-side; OBIS is filtered here). NC / SA / all-rights-reserved records are
dropped, so the output can be redistributed under the app's own terms with
attribution. Taxa come from pipeline/taxa.json.
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import logging
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("occurrences")
HERE = Path(__file__).parent
GBIF = "https://api.gbif.org/v1/occurrence/search"
OBIS = "https://api.obis.org/v3/occurrence"
GBIF_LICENCES = ("CC0_1_0", "CC_BY_4_0")
PAGE = 300


def licence_ok(text: str | None) -> bool:
    """CC0 and plain CC-BY only. Anything NC/SA/ND or non-CC is out."""
    s = (text or "").lower().strip()
    if "publicdomain/zero" in s or s in ("cc0", "cc0_1_0", "cc0-1.0"):
        return True
    if "licenses/by/" in s or s in ("cc_by_4_0", "cc-by", "cc-by-4.0"):
        return True
    return False


def licence_label(text: str | None) -> str:
    """Short human label for a licence URL/code; never collapses distinct licences."""
    s = (text or "").lower()
    if "publicdomain/zero" in s or s.startswith("cc0"):
        return "CC0 1.0"
    if "licenses/by/4.0" in s or s in ("cc_by_4_0", "cc-by-4.0"):
        return "CC BY 4.0"
    if "licenses/by/" in s or s in ("cc-by",):
        return "CC BY"
    return text or "unknown"


def _get_json(url: str, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url, headers={"User-Agent": "wildeye/0.1 (occurrence sync)"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _iso_date(s: str | None) -> str | None:
    """Normalise to YYYY-MM-DD; None if unparseable."""
    if not s:
        return None
    s = str(s)[:10]
    try:
        dt.date.fromisoformat(s)
    except ValueError:
        return None
    return s


def gbif_records(
    taxon: dict, since: dt.date, until: dt.date, cap: int = 600
) -> tuple[list[dict], bool]:
    """Returns (records, truncated). truncated=True when the cap stopped paging."""
    out, offset, truncated = [], 0, False
    while True:
        if len(out) >= cap:
            truncated = True
            break
        q = [
            ("taxonKey", taxon["gbif_key"]),
            ("eventDate", f"{since},{until}"),
            ("hasCoordinate", "true"),
            ("hasGeospatialIssue", "false"),
            ("limit", PAGE),
            ("offset", offset),
        ] + [("license", l) for l in GBIF_LICENCES]
        d = _get_json(f"{GBIF}?{urllib.parse.urlencode(q)}")
        for r in d.get("results", []):
            out.append(normalise_gbif(r, taxon))
        if d.get("endOfRecords", True) or not d.get("results"):
            break
        offset += PAGE
    return [r for r in out if r], truncated


def normalise_gbif(r: dict, taxon: dict) -> dict | None:
    date = _iso_date(r.get("eventDate"))
    lat, lon = r.get("decimalLatitude"), r.get("decimalLongitude")
    if date is None or lat is None or lon is None or not licence_ok(r.get("license")):
        return None
    return {
        "taxon": taxon["id"],
        "date": date,
        "lat": float(lat),
        "lon": float(lon),
        "source": "gbif",
        "dataset": r.get("datasetName") or r.get("datasetKey"),
        "dataset_key": r.get("datasetKey"),
        "license": r.get("license"),
        "uncertainty_m": r.get("coordinateUncertaintyInMeters"),
        "basis": r.get("basisOfRecord"),
        "url": f"https://www.gbif.org/occurrence/{r['key']}" if r.get("key") else None,
    }


def obis_records(
    taxon: dict, since: dt.date, until: dt.date, cap: int = 2000
) -> tuple[list[dict], bool]:
    out, after, truncated = [], None, False
    while True:
        if len(out) >= cap:
            truncated = True
            break
        q = [
            ("scientificname", taxon["sci"]),
            ("startdate", since.isoformat()),
            ("enddate", until.isoformat()),
            ("size", min(1000, cap)),
        ]
        if after:
            q.append(("after", after))
        d = _get_json(f"{OBIS}?{urllib.parse.urlencode(q)}", timeout=120)
        res = d.get("results", [])
        if not res:
            break
        for r in res:
            n = normalise_obis(r, taxon)
            if n:
                out.append(n)
        after = res[-1].get("id")
        if len(res) < 1000 or not after:
            break
    return out, truncated


def normalise_obis(r: dict, taxon: dict) -> dict | None:
    date = _iso_date(r.get("eventDate"))
    lat, lon = r.get("decimalLatitude"), r.get("decimalLongitude")
    if date is None or lat is None or lon is None or not licence_ok(r.get("license")):
        return None
    return {
        "taxon": taxon["id"],
        "date": date,
        "lat": float(lat),
        "lon": float(lon),
        "source": "obis",
        "dataset": r.get("datasetName") or r.get("dataset_id"),
        "dataset_key": r.get("dataset_id"),
        "license": r.get("license"),
        "uncertainty_m": r.get("coordinateUncertaintyInMeters"),
        "basis": r.get("basisOfRecord"),
        "url": f"https://obis.org/dataset/{r['dataset_id']}"
        if r.get("dataset_id")
        else None,
    }


def gbif_dataset_meta(key: str) -> dict:
    """Title, DOI and publishing organisation for one GBIF dataset (per-publisher citation)."""
    d = _get_json(f"https://api.gbif.org/v1/dataset/{key}")
    org = None
    if d.get("publishingOrganizationKey"):
        org = _get_json(
            f"https://api.gbif.org/v1/organization/{d['publishingOrganizationKey']}"
        ).get("title")
    return {
        "source": "gbif",
        "title": d.get("title"),
        "doi": d.get("doi"),
        "publisher": org,
        "license": d.get("license"),
        "url": f"https://www.gbif.org/dataset/{key}",
    }


def obis_dataset_meta(key: str) -> dict:
    d = _get_json(f"https://api.obis.org/v3/dataset/{key}").get("results", [{}])[0]
    cit = d.get("citation") or ""
    m = re.search(r"10\.\d{4,9}/\S+?(?=[\s.]*$)", cit)
    return {
        "source": "obis",
        "title": d.get("title"),
        "doi": m.group(0) if m else None,
        "publisher": None,
        "citation": cit or None,
        "url": f"https://obis.org/dataset/{key}",
    }


def resolve_datasets(records: list[dict], fetch_gbif=gbif_dataset_meta, fetch_obis=obis_dataset_meta) -> dict:
    """One metadata entry per distinct (source, dataset_key); failures are recorded, not hidden."""
    out = {}
    for r in records:
        k = r.get("dataset_key")
        if not k or k in out:
            continue
        try:
            if r["source"] == "npn":
                out[k] = dict(NPN_META)
                continue
            out[k] = fetch_gbif(k) if r["source"] == "gbif" else fetch_obis(k)
        except Exception as e:  # noqa: BLE001
            log.warning("dataset meta %s failed: %r", k, e)
            out[k] = {"source": r["source"], "title": r.get("dataset"), "error": repr(e)}
    return out


NPN = "https://services.usanpn.org/npn_portal/observations/getObservations.json"
NPN_DATASET_KEY = "usanpn-natures-notebook"
NPN_META = {
    "source": "npn",
    "title": "USA National Phenology Network, Nature's Notebook",
    "doi": None,
    "publisher": "USA National Phenology Network",
    "citation": "Data were provided by the USA National Phenology Network and the many participants who contribute to its Nature's Notebook program.",
    "license": "https://creativecommons.org/licenses/by/4.0/",
    "url": "https://www.usanpn.org/data/observational",
}


def npn_records(taxon: dict, since: dt.date, until: dt.date, fetch=None) -> tuple[list[dict], bool]:
    """USA-NPN phenology observations (CC BY 4.0) for taxa with `npn_species_id`.
    Only phenophase_status == 1 (the phenophase was observed) becomes an occurrence;
    0 (looked, not seen) and -1 (uncertain) are dropped. Never truncated: the API returns
    the whole window."""
    sid = taxon.get("npn_species_id")
    if not sid:
        return [], False
    q = urllib.parse.urlencode({"start_date": since.isoformat(), "end_date": until.isoformat(),
                                "species_id[0]": sid, "request_src": "wildeye"})
    rows = (fetch or _get_json)(f"{NPN}?{q}", timeout=180)
    out = []
    for r in rows if isinstance(rows, list) else []:
        n = normalise_npn(r, taxon)
        if n:
            out.append(n)
    return out, False


def normalise_npn(r: dict, taxon: dict) -> dict | None:
    if r.get("phenophase_status") != 1:
        return None
    date = _iso_date(r.get("observation_date"))
    lat, lon = r.get("latitude"), r.get("longitude")
    if date is None or lat is None or lon is None:
        return None
    return {
        "taxon": taxon["id"],
        "date": date,
        "lat": float(lat),
        "lon": float(lon),
        "source": "npn",
        "dataset": NPN_META["title"],
        "dataset_key": NPN_DATASET_KEY,
        "license": NPN_META["license"],
        "uncertainty_m": None,
        "basis": f"phenophase: {r.get('phenophase_description') or 'observed'}",
        "url": "https://www.usanpn.org/data/observational",
    }


def dedupe(records: list[dict]) -> list[dict]:
    """Same taxon, same day, same ~100 m cell → one record (GBIF and OBIS overlap heavily)."""
    seen, out = set(), []
    for r in records:
        k = (r["taxon"], r["date"], round(r["lat"], 3), round(r["lon"], 3))
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def to_feature(r: dict, taxon: dict) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
        "properties": {
            "taxon": taxon["id"],
            "name": taxon["name"],
            "sci": taxon["sci"],
            "group": taxon["group"],
            "icon": taxon["icon"],
            "date": r["date"],
            "source": r["source"],
            "dataset": r["dataset"],
            "dataset_key": r.get("dataset_key"),
            "license": r["license"],
            "license_label": licence_label(r["license"]),
            "uncertainty_m": r.get("uncertainty_m"),
            "basis": r["basis"],
            "url": r["url"],
        },
    }


def process_taxon(
    taxon: dict, since: dt.date, until: dt.date
) -> tuple[list[dict], dict]:
    g, gt = gbif_records(taxon, since, until)
    o, ot = obis_records(taxon, since, until)
    n, _ = npn_records(taxon, since, until)
    recs = dedupe(sorted(g + o + n, key=lambda r: r["date"], reverse=True))
    return [to_feature(r, taxon) for r in recs], {
        "gbif": len(g),
        "obis": len(o),
        "npn": len(n),
        "kept": len(recs),
        "truncated": gt or ot,
        "truncated_gbif": gt,
        "truncated_obis": ot,
    }, recs


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/occurrences.geojson"))
    ap.add_argument(
        "--days",
        type=int,
        default=120,
        help="lookback window (OBIS ingestion lags months)",
    )
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--taxa", default=None, help="comma-separated taxon ids")
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    taxa = json.loads((HERE / "taxa.json").read_text())
    if a.taxa:
        keep = set(a.taxa.split(","))
        taxa = [t for t in taxa if t["id"] in keep]
    until = dt.datetime.now(dt.UTC).date()
    since = until - dt.timedelta(days=a.days)
    features, counts, failures, all_recs = [], {}, {}, []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process_taxon, t, since, until): t for t in taxa}
        for f in as_completed(futs):
            t = futs[f]
            try:
                feats, c, recs = f.result()
                features += feats
                all_recs += recs
                counts[t["id"]] = c
                log.info(
                    "%s gbif=%d obis=%d kept=%d",
                    t["id"],
                    c["gbif"],
                    c["obis"],
                    c["kept"],
                )
            except Exception as e:
                failures[t["id"]] = repr(e)
                log.error("%s FAILED: %r", t["id"], e)
    if not features:
        raise SystemExit("no occurrences fetched")
    datasets = resolve_datasets(all_recs)
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "window_days": a.days,
            "since": since.isoformat(),
            "counts": counts,
            "truncated": sorted(k for k, c in counts.items() if c["truncated"]),
            "failures": failures,
            "datasets": datasets,
            "taxa": [
                {k: t[k] for k in ("id", "name", "sci", "group", "icon")} for t in taxa
            ],
            "features": features,
        },
    )
    log.info(
        "wrote %d features for %d taxa in %.0fs",
        len(features),
        len(counts),
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
