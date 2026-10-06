"""Is every cron-fed layer on the live site still updating? Writes a markdown report; exit 1 if not.

HPAI failed every night from 2026-09-12 to 2026-10-06 and nobody saw it: the error only reached
cron_hpai.log on the laptop. .github/workflows/stale-data.yml runs this daily on a GitHub-hosted
runner against the deployed site, so it also fires when the laptop, its cron or the deploy stops,
and opens, updates or closes a GitHub issue labelled stale-data.

A layer is stale when its file's generated_at is older than two missed runs plus 6 hours. Anything
written more often than daily counts as daily, because the site only changes at the daily deploy.
Each raster product is also checked on its own data `time`: rasters.json is rewritten every day
even when one product's fetch fails. A file that cannot be read is a problem, never a pass.
LAYERS mirrors the laptop crontab, which is not in the repo: keep the two in step.
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from .net import urlopen

BASE = "https://musharna.github.io/wildeye/data/"
UA = "wildeye/0.1 (freshness check)"
DAY = dt.timedelta(days=1)
PERIOD = {"daily": DAY, "weekly": 7 * DAY, "monthly": 31 * DAY}
SLACK = dt.timedelta(hours=6)

# file under data/ -> how often the cron job that writes it runs (crontab on the laptop)
LAYERS = {
    "birds.geojson": "daily",  # every 10 minutes; the site changes daily
    "birds_field.json": "daily",
    "aloft.geojson": "daily",
    "rasters.json": "daily",
    "gibs.json": "daily",
    "occurrences.geojson": "daily",
    "hpai.geojson": "daily",
    "whispers.geojson": "daily",
    "arbonet.geojson": "daily",
    "phenology.geojson": "daily",
    "gfw.geojson": "daily",
    "rivers.geojson": "daily",
    "fires.geojson": "daily",  # four times a day
    "geomodel_species.json": "daily",
    "tracks.geojson": "weekly",
    "neon.geojson": "weekly",
    "neon-vectors.geojson": "weekly",
    "h5n1.geojson": "weekly",
    "otn.geojson": "weekly",
    "cetaceans.geojson": "weekly",
    "wastewater.geojson": "weekly",
    "drought.geojson": "weekly",
    "ecoregions.geojson": "monthly",
    "gmw.geojson": "monthly",
    "griis.geojson": "monthly",
    "geomodel_verdicts.json": "monthly",
}
# A raster product's data time trails its fetch by up to 3 days (NDVI, chlorophyll), so 7 days
# is two missed fetches with room to spare. The coral outlook is issued monthly.
PRODUCT_LIMIT = {"crw-outlook": 2 * PERIOD["monthly"] + SLACK}
PRODUCT_DEFAULT = 7 * DAY
# main's exit status when a layer is stale. Not 1: an uncaught exception exits 1, and the workflow
# must not read a crash as a report.
STALE_EXIT = 10
GENERATED_AT = re.compile(r'"generated_at"\s*:\s*"([^"]+)"')


def limit(cadence: str) -> dt.timedelta:
    return 2 * PERIOD[cadence] + SLACK


def _when(s: str) -> dt.datetime:
    t = dt.datetime.fromisoformat(s)
    return t if t.tzinfo else t.replace(tzinfo=dt.UTC)


def _age(d: dt.timedelta) -> str:
    days, hours = d.days, d.seconds // 3600
    return f"{days} days {hours} h" if days else f"{hours} h"


def assess(stamps: dict, rasters: dict | None, now: dt.datetime, layers: dict = LAYERS) -> list[dict]:
    """Problems as {layer, why}. stamps: file -> generated_at (ISO), None (the file has none) or an
    error message (it could not be read). rasters: the parsed rasters.json, or None."""
    out = []
    for name, cadence in layers.items():
        v = stamps.get(name, "not checked")
        if v is None:
            out.append({"layer": name, "why": "no generated_at in the file"})
            continue
        try:
            t = _when(v)
        except ValueError:
            out.append({"layer": name, "why": f"could not read it: {v}"})
            continue
        if now - t > limit(cadence):
            out.append({"layer": name, "why": f"written {v}, {_age(now - t)} old; {cadence} job, limit {_age(limit(cadence))}"})
    for p in (rasters or {}).get("products", []):
        pid, t = p.get("id", "?"), p.get("time")
        lim = PRODUCT_LIMIT.get(pid, PRODUCT_DEFAULT)
        if not t:
            out.append({"layer": f"rasters.json: {pid}", "why": "no data time"})
            continue
        try:
            when = _when(t)
        except ValueError:
            out.append({"layer": f"rasters.json: {pid}", "why": f"could not read its data time: {t}"})
            continue
        if now - when > lim:
            out.append({"layer": f"rasters.json: {pid}", "why": f"newest data {t}, {_age(now - when)} old; limit {_age(lim)}"})
    return out


def report(problems: list[dict], now: dt.datetime, checked: int) -> str:
    stamp = now.strftime("%Y-%m-%d %H:%M UTC")
    if not problems:
        return f"Every layer on the live site is fresh ({checked} files checked at {stamp}).\n"
    names = ",".join(sorted(p["layer"] for p in problems))
    rows = "\n".join(f"| `{p['layer']}` | {p['why']} |" for p in sorted(problems, key=lambda p: p["layer"]))
    return (f"<!-- stale: {names} -->\n"
            f"{len(problems)} layer(s) on {BASE} have stopped updating (checked {stamp}, by `pipeline/freshness.py`).\n\n"
            f"| layer | why |\n|---|---|\n{rows}\n\n"
            "Look at the layer's `pipeline/cron_*.log` on the laptop. This issue closes itself when every layer is fresh again.\n")


def _get(name: str, head: int | None) -> bytes:
    req = urllib.request.Request(BASE + name, headers={"User-Agent": UA})
    with urlopen(req, timeout=60) as r:
        return r.read(head) if head else r.read()


def read_stamps(layers: dict = LAYERS) -> tuple[dict, dict | None]:
    stamps, rasters = {}, None
    for name in layers:
        try:
            if name == "rasters.json":
                rasters = json.loads(_get(name, None))
                stamps[name] = rasters.get("generated_at")
            else:
                m = GENERATED_AT.search(_get(name, 4096).decode("utf-8", "replace"))
                stamps[name] = m.group(1) if m else None
        except urllib.error.HTTPError as e:
            stamps[name] = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            stamps[name] = f"{type(e).__name__}: {e}"
    return stamps, rasters


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", type=Path, required=True)
    ap.add_argument("--now", default=None, help="pretend it is this ISO time (to test the alert path)")
    a = ap.parse_args(argv)
    now = _when(a.now) if a.now else dt.datetime.now(dt.UTC)
    stamps, rasters = read_stamps()
    problems = assess(stamps, rasters, now)
    text = report(problems, now, len(stamps))
    a.report.write_text(text)
    print(text)
    return STALE_EXIT if problems else 0


if __name__ == "__main__":
    sys.exit(main())
