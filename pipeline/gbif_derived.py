"""Register the sightings layer as a GBIF derived dataset (one citable DOI per snapshot).

GBIF asks that filtered/derived uses of occurrence data be registered so the contributing
datasets get credit: https://www.gbif.org/derived-dataset. Input is the live
public/data/occurrences.geojson; the payload lists every GBIF `dataset_key` with its record
count. `--register` POSTs to api.gbif.org with GBIF_USER / GBIF_PASS (from
~/.config/gbif/credentials via the runner); the default is a dry run that prints the payload.
The `--source-url` must be a public URL where the derived data can be seen — register only
once wildeye is hosted; a DOI pointing at localhost would be a false record.
"""

from __future__ import annotations
import argparse
import base64
import collections
import datetime as dt
import json
import os
import urllib.request
from pathlib import Path

API = "https://api.gbif.org/v1/derivedDataset"
UA = "wildeye/0.1 (gbif derived dataset)"


def related_datasets(gj: dict) -> dict[str, int]:
    """GBIF dataset key → record count over the file's GBIF-sourced features."""
    c = collections.Counter(
        f["properties"]["dataset_key"]
        for f in gj.get("features", [])
        if f.get("properties", {}).get("source") == "gbif" and f["properties"].get("dataset_key")
    )
    return dict(sorted(c.items()))


def payload(gj: dict, source_url: str, today: dt.date | None = None) -> dict:
    rel = related_datasets(gj)
    if not rel:
        raise ValueError("no GBIF-sourced features with a dataset_key — nothing to register")
    today = today or dt.date.today()
    return {
        "title": f"wildeye live wildlife-sightings layer, GBIF subset, snapshot {today.isoformat()}",
        "description": (
            f"Occurrence records from the last {gj.get('window_days', '?')} days for "
            f"{len(gj.get('taxa', []))} configured taxa, CC0/CC BY records only, displayed on the wildeye "
            f"3D globe. {sum(rel.values())} records from {len(rel)} datasets; generated {gj.get('generated_at')}."
        ),
        "sourceUrl": source_url,
        "relatedDatasets": rel,
    }


def register(body: dict, user: str, password: str, post=None) -> dict:
    def _post(url, data, headers):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)

    auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    return (post or _post)(API, json.dumps(body).encode(), {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA, "Authorization": auth})


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", type=Path, default=Path("public/data/occurrences.geojson"))
    ap.add_argument("--source-url", required=True, help="public URL of the hosted layer")
    ap.add_argument("--register", action="store_true", help="POST to GBIF (default: dry run)")
    ap.add_argument("--record", type=Path, default=Path("public/data/seed/gbif_derived.json"), help="where the DOI response is appended")
    a = ap.parse_args(argv)
    body = payload(json.loads(a.inp.read_text()), a.source_url)
    if not a.register:
        print(json.dumps({k: (v if k != "relatedDatasets" else f"{len(v)} datasets, {sum(v.values())} records") for k, v in body.items()}, indent=2))
        return
    user, pw = os.environ.get("GBIF_USER"), os.environ.get("GBIF_PASS")
    if not user or not pw:
        raise SystemExit("GBIF_USER / GBIF_PASS not set")
    resp = register(body, user, pw)
    a.record.parent.mkdir(parents=True, exist_ok=True)
    hist = json.loads(a.record.read_text()) if a.record.exists() else []
    hist.append({"registered_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "doi": resp.get("doi"), "title": body["title"], "datasets": len(body["relatedDatasets"]), "records": sum(body["relatedDatasets"].values())})
    a.record.write_text(json.dumps(hist, indent=2) + "\n")
    print(json.dumps({"doi": resp.get("doi"), "citation": resp.get("citation")}, indent=2))


if __name__ == "__main__":
    main()
