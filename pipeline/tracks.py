"""Animal tracks (track contract) → public/data/tracks.geojson.

Wave 2 of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md. First source is the
IOOS Animal Telemetry Network ERDDAP (US-gov, no credentials, one tabledap dataset per
deployment). Every fix is cleaned (invalid Argos class, impossible speed), downsampled
to a display budget (≥ min_gap_s apart, endpoints kept), segmented on long gaps and at
the antimeridian, and emitted as one LineString per segment with a parallel `times`
array whose length is validated against the coordinates. Per-deployment licence,
citation and institution ride along into the info box. A publication lag drops fixes
newer than `min_age_days` (sensitive-taxon protection; archival data is unaffected).
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import logging
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("tracks")
HERE = Path(__file__).parent
UA = {"User-Agent": "wildeye/0.1 (tracks sync)"}


def _get_json(url: str, timeout: int = 90) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


# ---------- ERDDAP discovery ----------


def list_erddap_datasets(base: str, match: str, fetch=_get_json) -> list[str]:
    q = urllib.parse.quote(match.strip("_") or "trajectory")
    t = fetch(f"{base}/search/index.json?page=1&itemsPerPage=5000&searchFor={q}")[
        "table"
    ]
    i = t["columnNames"].index("Dataset ID")
    return sorted(r[i] for r in t["rows"] if match in r[i])


def species_of(dataset_id: str) -> str:
    """'atn_98364_false-killer-whale_trajectory_2013…' → 'false-killer-whale'."""
    return re.sub(r"^atn_\d+_", "", dataset_id).split("_trajectory_")[0]


def select_datasets(
    ids: list[str], max_per_species: int, exclude: set[str] | frozenset = frozenset()
) -> list[str]:
    """Newest `max_per_species` deployments per species (by the end date in the id)."""
    by: dict[str, list[str]] = {}
    for d in ids:
        sp = species_of(d)
        if sp in exclude:
            continue
        by.setdefault(sp, []).append(d)
    out = []
    for sp, lst in sorted(by.items()):
        out += sorted(lst, key=lambda s: s.rsplit("-", 1)[-1])[-max_per_species:]
    return out


def fetch_info(base: str, dataset_id: str, fetch=_get_json) -> dict:
    rows = fetch(f"{base}/info/{dataset_id}/index.json")["table"]["rows"]
    g = {r[2]: r[4] for r in rows if r[0] == "attribute" and r[1] == "NC_GLOBAL"}
    return {
        "title": g.get("title"),
        "species": g.get("animal_common_name")
        or species_of(dataset_id).replace("-", " "),
        "sci": g.get("animal_scientific_name"),
        "institution": g.get("institution"),
        "citation": g.get("citation"),
        "license": g.get("license"),
        "url": g.get("infoUrl") or f"{base}/info/{dataset_id}/index.html",
        "start": g.get("time_coverage_start"),
        "end": g.get("time_coverage_end"),
    }


def fetch_fixes(base: str, dataset_id: str, fetch=_get_json) -> list[dict]:
    q = "deploy_id,time,latitude,longitude,location_class&orderBy(%22time%22)"
    t = fetch(f"{base}/tabledap/{dataset_id}.json?{q}")["table"]
    c = {n: i for i, n in enumerate(t["columnNames"])}
    out = []
    for r in t["rows"]:
        try:
            ts = _parse_time(r[c["time"]])
            lat, lon = float(r[c["latitude"]]), float(r[c["longitude"]])
        except (TypeError, ValueError):
            continue
        if (
            not (math.isfinite(lat) and math.isfinite(lon))
            or abs(lat) > 90
            or abs(lon) > 180
        ):
            continue
        out.append(
            {
                "t": ts,
                "lat": lat,
                "lon": lon,
                "cls": str(r[c["location_class"]] or ""),
                "animal": str(r[c["deploy_id"]] or dataset_id),
            }
        )
    return out


def _parse_time(s: str) -> float:
    return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()


# ---------- cleaning (pure) ----------


def haversine_m(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dphi, dl = math.radians(b_lat - a_lat), math.radians(b_lon - a_lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def clean(
    fixes: list[dict], drop_classes=("Z",), max_speed_ms: float = 10.0
) -> list[dict]:
    """Sort by time, drop invalid Argos classes and fixes that imply an impossible speed
    from the last accepted fix (the later fix is dropped, never the earlier)."""
    out = []
    for f in sorted(fixes, key=lambda x: x["t"]):
        if f["cls"] in drop_classes:
            continue
        if out:
            p = out[-1]
            dts = f["t"] - p["t"]
            if dts <= 0:
                continue
            if haversine_m(p["lat"], p["lon"], f["lat"], f["lon"]) / dts > max_speed_ms:
                continue
        out.append(f)
    return out


def downsample(fixes: list[dict], min_gap_s: float = 3600) -> list[dict]:
    """Keep the first fix, then any fix ≥ min_gap_s after the last kept, and always the last."""
    if len(fixes) <= 2:
        return list(fixes)
    out = [fixes[0]]
    for f in fixes[1:-1]:
        if f["t"] - out[-1]["t"] >= min_gap_s:
            out.append(f)
    out.append(fixes[-1])
    return out


def segment(fixes: list[dict], gap_h: float = 24) -> list[list[dict]]:
    """Split where consecutive fixes are more than gap_h apart (never join across a gap)."""
    segs, cur = [], []
    for f in fixes:
        if cur and f["t"] - cur[-1]["t"] > gap_h * 3600:
            segs.append(cur)
            cur = []
        cur.append(f)
    if cur:
        segs.append(cur)
    return segs


def split_antimeridian(seg: list[dict]) -> list[list[dict]]:
    """Split a segment where |Δlon| > 180 between consecutive fixes, inserting the crossing
    point (lat interpolated) at +180 on the leaving side and −180 on the arriving side, so
    an exported LineString never draws the long way round."""
    out, cur = [], []
    for f in seg:
        if cur:
            p = cur[-1]
            dlon = f["lon"] - p["lon"]
            if abs(dlon) > 180:
                # unwrap the arriving longitude onto the leaving side
                unwrapped = f["lon"] - 360 if dlon > 0 else f["lon"] + 360
                edge = 180.0 if unwrapped > p["lon"] else -180.0
                frac = (
                    (edge - p["lon"]) / (unwrapped - p["lon"])
                    if unwrapped != p["lon"]
                    else 0.5
                )
                lat = p["lat"] + frac * (f["lat"] - p["lat"])
                t = p["t"] + frac * (f["t"] - p["t"])
                cur.append({**p, "t": t, "lat": lat, "lon": edge})
                out.append(cur)
                cur = [{**f, "t": t, "lat": lat, "lon": -edge}]
        cur.append(f)
    if cur:
        out.append(cur)
    return out


def apply_publication_lag(
    fixes: list[dict], min_age_days: float, now: float | None = None
) -> list[dict]:
    cutoff = (now if now is not None else time.time()) - min_age_days * 86400
    return [f for f in fixes if f["t"] <= cutoff]


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_features(
    dataset_id: str, source: dict, info: dict, segments: list[list[dict]]
) -> list[dict]:
    feats = []
    for k, seg in enumerate(segments):
        if len(seg) < 2:
            continue
        coords = [[round(f["lon"], 4), round(f["lat"], 4)] for f in seg]
        times = [_iso(f["t"]) for f in seg]
        if len(coords) != len(times):
            raise ValueError(f"{dataset_id} segment {k}: times/coords length mismatch")
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "source": source["id"],
                    "source_name": source["name"],
                    "dataset": dataset_id,
                    "animal": seg[0]["animal"],
                    "segment": k,
                    "species": info["species"],
                    "group": info.get("group"),
                    "sci": info["sci"],
                    "start": times[0],
                    "end": times[-1],
                    "n": len(seg),
                    "times": times,
                    "institution": info["institution"],
                    "citation": info["citation"],
                    "license": info["license"],
                    "url": info["url"],
                    "title": info["title"],
                },
            }
        )
    return feats


def process_dataset(
    source: dict, dataset_id: str, fetch=_get_json, now: float | None = None
) -> tuple[list[dict], dict]:
    info = fetch_info(source["base"], dataset_id, fetch)
    raw = fetch_fixes(source["base"], dataset_id, fetch)
    fixes = clean(
        raw,
        tuple(source.get("drop_location_classes", ["Z"])),
        float(source.get("max_speed_ms", 10)),
    )
    fixes = apply_publication_lag(fixes, float(source.get("min_age_days", 7)), now)
    fixes = downsample(fixes, float(source.get("min_gap_s", 3600)))
    stats = {"raw": len(raw), "kept": len(fixes), "species": info["species"]}
    if len(fixes) < int(source.get("min_fixes", 5)):
        return [], stats | {"dropped": "too few fixes"}
    segs = [
        s
        for seg in segment(fixes, float(source.get("segment_gap_h", 24)))
        for s in split_antimeridian(seg)
    ]
    return to_features(dataset_id, source, info, segs), stats | {"segments": len(segs)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/tracks.geojson"))
    ap.add_argument("--sources", default=None, help="comma-separated source ids")
    ap.add_argument(
        "--limit", type=int, default=None, help="max datasets per source (smoke)"
    )
    ap.add_argument(
        "--sleep",
        type=float,
        default=0.5,
        help="seconds between requests (serial, polite)",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    sources = json.loads((HERE / "tracks.json").read_text())
    if a.sources:
        keep = set(a.sources.split(","))
        sources = [s for s in sources if s["id"] in keep]
    t0 = time.time()
    features, per_dataset, failures = [], {}, {}
    for src in sources:
        if src.get("kind") == "movebank":
            from .movebank import process_study

            for study in src["studies"][: a.limit] if a.limit else src["studies"]:
                key = f"mb:{study['id']}"
                try:
                    feats, st = process_study(src, study)
                    features += feats
                    per_dataset[key] = st
                    log.info("%s %s", key, st)
                except Exception as e:  # noqa: BLE001
                    failures[key] = repr(e)
                    log.error("%s FAILED: %r", key, e)
                time.sleep(a.sleep)
            continue
        ids = select_datasets(
            list_erddap_datasets(src["base"], src["match"]),
            int(src["max_per_species"]),
            set(src.get("exclude_species", [])),
        )
        if a.limit:
            ids = ids[: a.limit]
        log.info("%s: %d deployments selected", src["id"], len(ids))
        for d in ids:  # strictly serial: one request in flight per host
            try:
                feats, st = process_dataset(src, d)
                features += feats
                per_dataset[d] = st
                log.info(
                    "%s raw=%d kept=%d segs=%s",
                    d,
                    st["raw"],
                    st["kept"],
                    st.get("segments", 0),
                )
            except Exception as e:  # noqa: BLE001
                failures[d] = repr(e)
                log.error("%s FAILED: %r", d, e)
            time.sleep(a.sleep)
    if not features:
        raise SystemExit("no tracks fetched")
    species = sorted({f["properties"]["species"] for f in features})
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sources": [{k: s[k] for k in ("id", "name", "base")} for s in sources],
            "species": species,
            "datasets": per_dataset,
            "failures": failures,
            "features": features,
        },
    )
    log.info(
        "wrote %d segments from %d deployments (%d species) in %.0fs, %d failures",
        len(features),
        len(per_dataset),
        len(species),
        time.time() - t0,
        len(failures),
    )


if __name__ == "__main__":
    main()
