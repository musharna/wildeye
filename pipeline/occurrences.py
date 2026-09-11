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
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .build_birds import write_atomic

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
) -> list[dict]:
    out, offset = [], 0
    while len(out) < cap:
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
    return [r for r in out if r]


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
        "license": r.get("license"),
        "basis": r.get("basisOfRecord"),
        "url": f"https://www.gbif.org/occurrence/{r['key']}" if r.get("key") else None,
    }


def obis_records(
    taxon: dict, since: dt.date, until: dt.date, cap: int = 2000
) -> list[dict]:
    out, after = [], None
    while len(out) < cap:
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
    return out


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
        "license": r.get("license"),
        "basis": r.get("basisOfRecord"),
        "url": f"https://obis.org/dataset/{r['dataset_id']}"
        if r.get("dataset_id")
        else None,
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
            "license": r["license"],
            "basis": r["basis"],
            "url": r["url"],
        },
    }


def process_taxon(
    taxon: dict, since: dt.date, until: dt.date
) -> tuple[list[dict], dict]:
    g = gbif_records(taxon, since, until)
    o = obis_records(taxon, since, until)
    recs = dedupe(sorted(g + o, key=lambda r: r["date"], reverse=True))
    return [to_feature(r, taxon) for r in recs], {
        "gbif": len(g),
        "obis": len(o),
        "kept": len(recs),
    }


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
    features, counts, failures = [], {}, {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process_taxon, t, since, until): t for t in taxa}
        for f in as_completed(futs):
            t = futs[f]
            try:
                feats, c = f.result()
                features += feats
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
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "window_days": a.days,
            "since": since.isoformat(),
            "counts": counts,
            "failures": failures,
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
