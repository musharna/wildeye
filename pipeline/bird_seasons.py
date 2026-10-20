"""Whole migration seasons of nightly totals per radar, kept after birds_nights.json's 60-night window and the
profiles behind it are gone (rules: grill_wildeye_bird_season ledger, 2026-10-19).

Fall = Aug 1 to Nov 15, BirdCast's season window. The archive is append-only: a night goes in once its sunrise is
FREEZE_AFTER past (the last scans of a night reach the store a few minutes after sunrise) and is never rewritten,
because the profiles it came from are pruned. `archive` runs from the bird cron on birds_nights.json; `build`
fills past nights from a backfilled profile store."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import logging
from pathlib import Path
from .atomic import write_atomic
from .bird_nights import night_total, night_window, stored_profiles

log = logging.getLogger("bird_seasons")
SEASONS = {"fall": ((8, 1), (11, 15))}
FREEZE_AFTER = dt.timedelta(hours=6)
FIELDS = ("mt_birds_km", "bio_gate_share", "coverage")
SITES = json.loads((Path(__file__).parent / "sites.json").read_text())

def season_of(night: dt.date) -> str | None:
    for name, (start, end) in SEASONS.items():
        if dt.date(night.year, *start) <= night <= dt.date(night.year, *end):
            return f"{name}-{night.year}"
    return None

def season_nights(season: str) -> list[dt.date]:
    name, year = season.rsplit("-", 1)
    (sm, sd), (em, ed) = SEASONS[name]
    first, last = dt.date(int(year), sm, sd), dt.date(int(year), em, ed)
    return [first + dt.timedelta(days=i) for i in range((last - first).days + 1)]

def freeze(doc: dict, site: str, night: dt.date, entry: dict) -> bool:
    """Put one finished night into the archive unless it is already there; True if it was added. A night with no
    profiles stays out (absent = no data): a backfill chunk still to run, or an outage, can never be frozen empty."""
    season = season_of(night)
    if season is None or not entry.get("profiles"):
        return False
    slot = doc.setdefault("seasons", {}).setdefault(season, {}).setdefault(site, {})
    if night.isoformat() in slot:
        return False
    slot[night.isoformat()] = {k: entry.get(k) for k in FIELDS}
    return True

def archive(doc: dict, nights_doc: dict, now: dt.datetime) -> int:
    """Freeze every night of birds_nights.json whose sunrise is FREEZE_AFTER past; the number added."""
    added = 0
    for site, rows in nights_doc.get("sites", {}).items():
        for n in rows:
            if now - dt.datetime.fromisoformat(n["sunrise"].replace("Z", "+00:00")) >= FREEZE_AFTER:
                added += freeze(doc, site, dt.date.fromisoformat(n["night"]), n)
    return added

def load(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {"seasons": {}}

def save(doc: dict, path: Path, now: dt.datetime) -> None:
    doc["generated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    doc["windows"] = {k: [f"{m:02d}-{d:02d}" for m, d in v] for k, v in SEASONS.items()}
    doc["fields"] = list(FIELDS)
    doc["seasons"] = {s: {site: dict(sorted(n.items())) for site, n in sorted(v.items())}
                      for s, v in sorted(doc["seasons"].items())}
    write_atomic(path, doc)

def archive_file(path: Path, nights_doc: dict, now: dt.datetime) -> int:
    doc = load(path)
    added = archive(doc, nights_doc, now)
    if added:
        save(doc, path, now)
    return added

def build(doc: dict, root: Path, sites: list[dict], season: str, now: dt.datetime) -> tuple[int, dict]:
    """Freeze every night of `season` up to now from the profiles stored under root; (added, failures)."""
    added, failures = 0, {}
    for site in sites:
        for night in season_nights(season):
            sunset, sunrise = night_window(night, site["lon"], site["lat"])
            if now - sunrise < FREEZE_AFTER:
                continue
            try:
                entry = night_total(stored_profiles(root, site["id"], sunset, sunrise), sunset, sunrise)
            except Exception as e:  # one bad site-night must not cost the others; listed, and the run fails
                failures[f"{site['id']} {night}"] = repr(e)
                continue
            added += freeze(doc, site["id"], night, entry)
    return added, failures

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["archive", "build"])
    ap.add_argument("--out", type=Path, default=Path("public/data/birds_seasons.json"))
    ap.add_argument("--nights", type=Path, default=Path("public/data/birds_nights.json"), help="archive: source")
    ap.add_argument("--vp-dir", type=Path, help="build: a backfilled profile store")
    ap.add_argument("--season", action="append", help="build: e.g. fall-2025")
    ap.add_argument("--site", action="append", help="build: default every site")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    now = dt.datetime.now(dt.UTC)
    if a.command == "archive":
        log.info("archived %d nights", archive_file(a.out, json.loads(a.nights.read_text()), now))
        return
    if not a.vp_dir or not a.season:
        raise SystemExit("build needs --vp-dir and --season")
    unknown = set(a.site or []) - {s["id"] for s in SITES}
    if unknown:   # a misspelt radar would otherwise archive nothing and exit 0
        raise SystemExit(f"unknown site(s): {sorted(unknown)}")
    sites = [s for s in SITES if not a.site or s["id"] in a.site]
    doc, failures, added = load(a.out), {}, 0
    for season in a.season:
        n, f = build(doc, a.vp_dir, sites, season, now)
        added, failures = added + n, {**failures, **f}
    save(doc, a.out, now)
    log.info("added %d nights", added)
    if failures:
        raise SystemExit(f"{len(failures)} site-nights failed: {dict(list(failures.items())[:5])}")

if __name__ == "__main__":
    main()
