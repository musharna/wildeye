"""USGS WHISPers wildlife mortality/morbidity events by county (polygon contract) →
public/data/whispers.geojson.

WHISPers (Wildlife Health Information Sharing Partnership event reporting system, USGS
National Wildlife Health Center) is a public, U.S. Government (public domain) register of
wildlife die-offs and disease events reported by partner agencies. The public API
(`/api/eventsummaries/`) returns events with their counties (FIPS), species, diagnoses and
affected counts. Its date filters are ignored server-side (probed 2026-09-12), so this pulls
pages ordered by start date descending until the window edge. One polygon per county with
≥1 event starting in the last `--weeks` weeks; events spanning several counties count in each.
Counties come from the Census 2021 boundary file shared with pipeline/wastewater.py.
"""

from __future__ import annotations
import argparse
import collections
import datetime as dt
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from .atomic import write_atomic
from .wastewater import load_county_shapes, week_ends

log = logging.getLogger("whispers")
API = "https://whispers.usgs.gov/api/eventsummaries/"
PAGE = 500
UA = "wildeye/0.1 (whispers sync)"
DEFAULT_WEEKS = 26
LICENCE = "Public Domain U.S. Government (USGS)"
NOTE = ("Events are reported by partner agencies as they investigate; counts are what was observed, not a "
        "census, and diagnoses change as lab results arrive. Reference to USGS data does not imply endorsement.")


def _get_json(url: str, timeout: int = 120) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_events(since: dt.date, fetch=_get_json, max_pages: int = 20, sleep: float = 1.0) -> list[dict]:
    """Event summaries with start_date >= since, paging newest-first until the window edge."""
    out, page = [], 1
    while page <= max_pages:
        q = urllib.parse.urlencode({"page_size": PAGE, "ordering": "-start_date", "page": page})
        d = fetch(f"{API}?{q}")
        rows = d.get("results") or []
        older = False
        for e in rows:
            sd = e.get("start_date")
            if not sd:
                continue  # undated events sort first under -start_date; unusable for a time series
            if sd < since.isoformat():
                older = True
                break
            out.append(e)
        if older or not d.get("next"):
            break
        page += 1
        time.sleep(sleep)
    return out


def normalise(e: dict) -> dict | None:
    """One event → {id, start, end, kind, affected, species[], diagnoses[], fips[], complete}."""
    fips = [str(a.get("fips_code")).zfill(5) for a in e.get("administrativeleveltwos") or [] if a.get("fips_code")]
    if not fips or not e.get("start_date"):
        return None
    diags = []
    for d in e.get("eventdiagnoses") or []:
        s = (d.get("diagnosis_string") or "").strip()
        label = s + (" (suspect)" if d.get("suspect") and "suspect" not in s.lower() else "")
        if s and label not in diags:
            diags.append(label)
    species = [s.get("name") for s in e.get("species") or [] if s.get("name")]
    return {"id": e["id"], "start": e["start_date"], "end": e.get("end_date") or e["start_date"],
            "kind": e.get("event_type_string") or "event", "affected": int(e.get("affected_count") or 0),
            "species": species, "diagnoses": diags, "fips": fips, "complete": bool(e.get("complete"))}


def county_index(events: list[dict], today: dt.date, weeks: int) -> tuple[dict, dict]:
    """fips → {n, affected, species, diagnoses, weeks:[{w, n, affected, sp}], events:[…]}."""
    ends = week_ends(today, weeks)
    idx: dict[str, dict] = {}
    counts = collections.Counter()
    for e in events:
        k = (today - dt.date.fromisoformat(e["start"])).days // 7
        if k < 0 or k >= weeks:
            counts["outside_window"] += 1
            continue
        counts["in_window"] += 1
        for f in e["fips"]:
            c = idx.setdefault(f, {"bins": [collections.Counter() for _ in range(weeks)], "aff": [0] * weeks,
                                   "species": collections.Counter(), "diagnoses": collections.Counter(), "events": []})
            c["bins"][k]["n"] += 1
            c["aff"][k] += e["affected"]
            c["species"].update(e["species"])
            c["diagnoses"].update(e["diagnoses"])
            c["events"].append({"id": e["id"], "start": e["start"], "end": e["end"], "affected": e["affected"],
                                "species": e["species"][:6], "diagnoses": e["diagnoses"][:4], "complete": e["complete"]})
    out = {}
    for f, c in idx.items():
        wk = [{"w": ends[k].isoformat(), "n": c["bins"][k]["n"], "affected": c["aff"][k],
               "sp": {}} for k in range(weeks) if c["bins"][k]["n"]]
        # species per week: rebuild from events (cheap; events are few per county)
        for w in wk:
            end = dt.date.fromisoformat(w["w"]); start = end - dt.timedelta(days=6)
            sp = collections.Counter()
            for ev in c["events"]:
                if start.isoformat() <= ev["start"] <= end.isoformat():
                    sp.update(ev["species"])
            w["sp"] = dict(sp.most_common(6))
        out[f] = {"n": sum(w["n"] for w in wk), "affected": sum(w["affected"] for w in wk),
                  "species": dict(c["species"].most_common(8)), "diagnoses": dict(c["diagnoses"].most_common(6)),
                  "weeks": wk, "events": sorted(c["events"], key=lambda x: x["start"], reverse=True)[:12]}
    counts["counties"] = len(out)
    return out, dict(counts)


def to_features(counties: dict, shapes: dict) -> tuple[list[dict], list[str]]:
    feats, missing = [], []
    for f in sorted(counties):
        sh = shapes.get(f)
        if not sh:
            missing.append(f)
            continue
        feats.append({"type": "Feature", "geometry": sh["geometry"],
                      "properties": {"fips": f, "name": sh["name"], "st": sh["st"], **counties[f]}})
    return feats, missing


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/whispers.geojson"))
    ap.add_argument("--weeks", type=int, default=DEFAULT_WEEKS)
    ap.add_argument("--cache", type=Path, default=Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")))
    ap.add_argument("--today", default=None)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    t0 = time.time()
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    since = today - dt.timedelta(days=7 * a.weeks)
    raw = fetch_events(since)
    events = [n for n in (normalise(e) for e in raw) if n]
    log.info("%d events since %s, %d with a county and a date", len(raw), since, len(events))
    counties, counts = county_index(events, today, a.weeks)
    shapes = load_county_shapes(a.cache / "cb_2021_us_county_20m.zip", set(counties))
    feats, missing = to_features(counties, shapes)
    if missing:
        log.warning("%d counties without a shape: %s", len(missing), missing[:10])
    if not feats:
        raise SystemExit("no counties with events")
    newest = max((e["start"] for e in events), default=None)
    write_atomic(a.out, {
        "type": "FeatureCollection",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"id": "whispers", "name": "USGS WHISPers wildlife mortality and morbidity events", "url": "https://whispers.usgs.gov",
                   "api": API, "licence": LICENCE, "note": NOTE},
        "today": today.isoformat(), "newest": newest, "weeks": [w.isoformat() for w in week_ends(today, a.weeks)],
        "counts": {**counts, "raw": len(raw), "events": len(events), "missing_shape": len(missing)}, "features": feats})
    log.info("wrote %s: %d counties, counts=%s, newest=%s (%.0f s)", a.out, len(feats), counts, newest, time.time() - t0)


if __name__ == "__main__":
    main()
