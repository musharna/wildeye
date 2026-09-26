"""Animal tracks (track contract) → public/data/tracks.geojson.

Wave 2 of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md. First source is the
IOOS Animal Telemetry Network ERDDAP (US-gov, no credentials, one tabledap dataset per
deployment). Every fix is cleaned (invalid Argos class, impossible speed), downsampled
to a display budget (≥ min_gap_s apart, endpoints kept), segmented on long gaps and at
the antimeridian, and emitted as one LineString per segment with a parallel `times`
array whose length is validated against the coordinates. Per-deployment licence,
citation and institution ride along into the info box. A publication lag drops fixes
newer than `min_age_days` (sensitive-taxon protection; archival data is unaffected).

Every track carries one of GROUPS (ATN: per species in tracks.json `groups`; Movebank: per
study `group`); the build fails on a track with no group rather than inventing "other". A
Movebank study that fails is retried once at the end of the run; if it fails again, its
features from the previous output are carried for up to CARRY_MAX_DAYS after their last good
fetch, flagged in `failures` with `carried_from`; older, or with no fetch on record, the study
is dropped and `failures` says so. The build also fails if the output would exceed --max-bytes.
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
GROUPS = ("whales & dolphins", "seals", "land mammals", "birds", "reptiles")  # legend order
CARRY_MAX_DAYS = 28
MAX_BYTES = 6_000_000


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
    info["group"] = source.get("groups", {}).get(info["species"])  # unmapped → None → build fails
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


def load_previous(path: Path) -> dict | None:
    """The last written output, the source of carried-forward Movebank studies (None if absent)."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        log.error("previous %s unreadable, nothing can be carried: %r", path, e)
        return None


def carry_forward(
    key: str, prev: dict | None, now: float, error: str
) -> tuple[list[dict], dict, dict]:
    """A study that failed twice: its features from `prev` if its last good fetch is at most
    CARRY_MAX_DAYS old → (features, stats, failure). The age keeps counting from the real
    fetch (`fetched_at` is copied, not renewed), so a long outage still ends in a drop."""
    st = (prev or {}).get("datasets", {}).get(key) or {}
    fetched = st.get("fetched_at")
    if not fetched:
        return [], {}, {"error": error, "dropped": "no previous good fetch on record"}
    age_d = (now - _parse_time(fetched)) / 86400
    if age_d > CARRY_MAX_DAYS:
        return [], {}, {"error": error, "dropped": f"last good fetch {fetched} is older than {CARRY_MAX_DAYS} days"}
    feats = [f for f in prev.get("features", []) if str(f["properties"].get("dataset", "")).startswith(key + ":")]
    return feats, st | {"carried": True}, {"error": error, "carried_from": fetched}


def collect_movebank(
    src: dict, studies: list[dict], prev: dict | None, now: float, process=None,
    sleep: float = 0.5, retry_pause: float = 60,
) -> tuple[list[dict], dict, dict]:
    """One pass over the studies, then one retry each for the failures at the end, then
    carry_forward for any that failed twice. A licence refusal is a result, not an error."""
    if process is None:
        from .movebank import process_study as process
    features, per, failures, failed = [], {}, {}, []

    def attempt(study):
        feats, st = process(src, study, now=now)
        key = f"mb:{study['id']}"
        per[key] = st | {"fetched_at": _iso(now)}
        features.extend(feats)
        log.info("%s %s", key, st)
        if not feats and "dropped" not in st:  # a curated study that yields nothing is news, not an error to retry
            failures[key] = {"empty": f"no tracks in window {st.get('window')}"}
            log.warning("%s: %s", key, failures[key]["empty"])

    for study in studies:
        try:
            attempt(study)
        except Exception as e:  # noqa: BLE001
            log.error("mb:%s FAILED (one retry at the end of the run): %r", study["id"], e)
            failed.append(study)
        time.sleep(sleep)
    if failed:
        time.sleep(retry_pause)
    for study in failed:
        key = f"mb:{study['id']}"
        try:
            attempt(study)
            log.info("%s succeeded on retry", key)
        except Exception as e:  # noqa: BLE001
            feats, st, failure = carry_forward(key, prev, now, repr(e))
            failures[key] = failure
            if feats:
                features.extend(feats)
                per[key] = st
            log.error("%s FAILED twice: %s", key, failure)
        time.sleep(sleep)
    return features, per, failures


def build_collection(
    sources: list[dict], features: list[dict], per_dataset: dict, failures: dict, max_bytes: int
) -> dict:
    """The output document; fails the build on no tracks, a track without a known group, or a
    document larger than max_bytes (measured as written: compact separators)."""
    if not features:
        raise SystemExit("no tracks fetched")
    bad = sorted({(str(f["properties"].get("group")), f["properties"].get("species")) for f in features if f["properties"].get("group") not in GROUPS})
    if bad:
        raise SystemExit(f"no group in {GROUPS} for (group, species): {bad} — map them in pipeline/tracks.json")
    present = {f["properties"]["group"] for f in features}
    gj = {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": [{k: s[k] for k in ("id", "name", "base")} for s in sources],
        "species": sorted({f["properties"]["species"] for f in features}),
        "groups": [g for g in GROUPS if g in present],
        "datasets": per_dataset,
        "failures": failures,
        "features": features,
    }
    size = len(json.dumps(gj, separators=(",", ":")))
    if size > max_bytes:
        raise SystemExit(f"tracks output {size:,} bytes exceeds the {max_bytes:,}-byte cap; thin or drop studies in pipeline/tracks.json")
    return gj


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
    ap.add_argument(
        "--max-bytes", type=int, default=MAX_BYTES, help="fail rather than write a larger file"
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
    now = time.time()
    features, per_dataset, failures = [], {}, {}
    for src in sources:
        if src.get("kind") == "movebank":
            studies = src["studies"][: a.limit] if a.limit else src["studies"]
            feats, per, fails = collect_movebank(src, studies, load_previous(a.out), now, sleep=a.sleep)
            features += feats
            per_dataset |= per
            failures |= fails
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
    gj = build_collection(sources, features, per_dataset, failures, a.max_bytes)
    write_atomic(a.out, gj)
    log.info(
        "wrote %d segments from %d deployments (%d species, %d groups) in %.0fs, %d failures",
        len(features),
        len(per_dataset),
        len(gj["species"]),
        len(gj["groups"]),
        time.time() - t0,
        len(failures),
    )


if __name__ == "__main__":
    main()
