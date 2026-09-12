"""Movebank adapter for the track contract (curated public studies, CC0 / CC BY only).

Wave 2 item 2 of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md. Reads the
Movebank direct-read API with the account in MOVEBANK_USER / MOVEBANK_PASS (never in the
browser). Per study: metadata (name, citation, licence type and terms, PI), individuals
with their taxon, and GPS events since `days` ago (visible fixes only). One "dataset" per
individual (`mb:<study>:<individual>`) feeds the same clean → lag → downsample →
segment → split pipeline as ATN in pipeline/tracks.py. A study whose live `license_type`
is not CC_0 / CC_BY is refused at run time even if it is listed, because the licence is
read from Movebank, not from our config. Some studies answer a download with a licence
page instead of CSV; the md5 handshake (re-request with `license-md5`) accepts it once.
"""

from __future__ import annotations
import base64
import csv
import datetime as dt
import hashlib
import io
import logging
import os
import urllib.parse
import urllib.request

log = logging.getLogger("movebank")
BASE = "https://www.movebank.org/movebank/service/direct-read"
GPS_SENSOR = 653
ALLOWED = ("CC_0", "CC_BY")
LICENCE_LABEL = {"CC_0": "CC0 1.0", "CC_BY": "CC BY 4.0"}
UA = "wildeye/0.1 (movebank sync)"


def _auth_header() -> str:
    user, pw = os.environ.get("MOVEBANK_USER"), os.environ.get("MOVEBANK_PASS")
    if not user or not pw:
        raise RuntimeError("MOVEBANK_USER / MOVEBANK_PASS not set (source ~/.config/wildeye/env)")
    return "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()


def _get_text(url: str, timeout: int = 300) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Authorization": _auth_header()})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def is_licence_page(body: str) -> bool:
    head = body.lstrip()[:300].lower()
    return head.startswith("<") or "license terms" in head


def fetch_csv(params: dict, fetch_text=_get_text) -> list[dict]:
    """direct-read CSV → rows; accepts a licence page once via the md5 handshake, and
    refuses anything that is still not CSV."""
    url = f"{BASE}?{urllib.parse.urlencode(params)}"
    body = fetch_text(url)
    if is_licence_page(body):
        md5 = hashlib.md5(body.encode("utf-8")).hexdigest()
        body = fetch_text(f"{url}&license-md5={md5}")
        if is_licence_page(body):
            raise RuntimeError(f"Movebank still returned a licence page after the md5 handshake: {params}")
    return list(csv.DictReader(io.StringIO(body)))


def fetch_study(study_id: int, fetch_text=_get_text) -> dict:
    rows = fetch_csv({"entity_type": "study", "study_id": study_id}, fetch_text)
    if not rows:
        raise RuntimeError(f"study {study_id}: no metadata row (not visible to this account?)")
    r = rows[0]
    return {
        "id": str(r["id"]), "name": r.get("name"), "citation": r.get("citation") or None,
        "license_type": r.get("license_type"), "license_terms": r.get("license_terms") or None,
        "pi": r.get("principal_investigator_name") or None,
        "url": f"https://www.movebank.org/cms/webapp?gwt_fragment=page=studies,path=study{r['id']}",
    }


def fetch_individuals(study_id: int, fetch_text=_get_text) -> dict[str, str]:
    """individual local identifier → taxon canonical name."""
    rows = fetch_csv({"entity_type": "individual", "study_id": study_id}, fetch_text)
    return {r["local_identifier"]: (r.get("taxon_canonical_name") or "").strip() for r in rows if r.get("local_identifier")}


def fetch_events(study_id: int, since: dt.datetime, fetch_text=_get_text) -> list[dict]:
    """Visible GPS fixes since `since` (UTC) as track-contract fixes {t, lat, lon, cls, animal}."""
    rows = fetch_csv({
        "entity_type": "event", "study_id": study_id, "sensor_type_id": GPS_SENSOR,
        "attributes": "individual_local_identifier,timestamp,location_long,location_lat,visible",
        "timestamp_start": since.strftime("%Y%m%d%H%M%S000"),
    }, fetch_text)
    out = []
    for r in rows:
        if (r.get("visible") or "true").lower() != "true":
            continue
        try:
            ts = dt.datetime.strptime(r["timestamp"][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.UTC).timestamp()
            lat, lon = float(r["location_lat"]), float(r["location_long"])
        except (KeyError, TypeError, ValueError):
            continue
        if abs(lat) > 90 or abs(lon) > 180:
            continue
        out.append({"t": ts, "lat": lat, "lon": lon, "cls": "", "animal": r.get("individual_local_identifier") or "?"})
    return out


def process_study(source: dict, study: dict, fetch_text=_get_text, now: float | None = None) -> tuple[list[dict], dict]:
    """All individuals of one curated study → features (via tracks.py helpers) + per-individual stats.
    Refuses the study unless its live licence_type is CC_0 or CC_BY."""
    from .tracks import clean, apply_publication_lag, downsample, segment, split_antimeridian, to_features

    sid = int(study["id"])
    meta = fetch_study(sid, fetch_text)
    if meta["license_type"] not in ALLOWED:
        return [], {"dropped": f"licence {meta['license_type']} not in {ALLOWED}", "study": meta["name"]}
    taxa = fetch_individuals(sid, fetch_text)
    now_s = now if now is not None else dt.datetime.now(dt.UTC).timestamp()
    since = dt.datetime.fromtimestamp(now_s, dt.UTC) - dt.timedelta(days=float(source.get("days", 60)))
    raw = fetch_events(sid, since, fetch_text)
    by_animal: dict[str, list[dict]] = {}
    for f in raw:
        by_animal.setdefault(f["animal"], []).append(f)
    common = study.get("common", {})
    feats, stats = [], {"study": meta["name"], "licence": meta["license_type"], "individuals": len(by_animal), "raw": len(raw), "kept": 0, "segments": 0, "dropped_individuals": 0}
    for animal, fixes in sorted(by_animal.items()):
        fixes = clean(fixes, (), float(source.get("max_speed_ms", 50)))
        fixes = apply_publication_lag(fixes, float(source.get("min_age_days", 7)), now_s)
        fixes = downsample(fixes, float(source.get("min_gap_s", 3600)))
        if len(fixes) < int(source.get("min_fixes", 5)):
            stats["dropped_individuals"] += 1
            continue
        sci = taxa.get(animal, "")
        info = {
            "title": meta["name"], "species": common.get(sci) or study.get("default_species") or sci or "unknown", "sci": sci,
            "institution": meta["pi"], "citation": meta["citation"] or f"Movebank study {sid}: {meta['name']}",
            "license": LICENCE_LABEL.get(meta["license_type"], meta["license_type"]), "url": meta["url"],
        }
        segs = [s for seg in segment(fixes, float(source.get("segment_gap_h", 24))) for s in split_antimeridian(seg)]
        feats += to_features(f"mb:{sid}:{animal}", source, info, segs)
        stats["kept"] += len(fixes)
        stats["segments"] += len(segs)
    return feats, stats
