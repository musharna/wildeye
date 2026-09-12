"""NASA FIRMS VIIRS active fires, gridded (point contract, dated) → public/data/fires.geojson.

FIRMS publishes the last 24 h / 48 h / 7 d of VIIRS 375 m active-fire detections as
key-free global CSVs (Suomi-NPP, NOAA-20 and NOAA-21; probed 2026-09-12, HTTP 200, no
MAP_KEY, ~39 MB each). The FIRMS FAQ (read 2026-09-12): "NASA promotes full and open sharing
of data ... please cite it as "NASA FIRMS"". Raw is ~450k detections per satellite per week,
far too many for one Point each, so every detection with nominal or high confidence is
aggregated into 0.5° cells per 6-hour UTC bin: count and fire radiative power (FRP, MW)
summed. One Point per cell (cell centre) with its bin series over the last `--days` days.

Size (2026-09-12, 1.25 M kept detections): 0.25° cells capped at 15,000 wrote 3.5 MB; 0.5° cells
with >= `--min-frp` 100 MW over the window write ~1.6 MB (6.2k cells) and keep 97.7 % of the
window's FRP and 98.1 % of the last 24 h's. Dropped cells are counted, not hidden.
Low-confidence detections (sun glint, weak anomalies) are dropped and counted.
"""

from __future__ import annotations
import argparse
import collections
import csv
import datetime as dt
import io
import logging
import math
import time
import urllib.error
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("fires")
BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
# satellite id → (directory, file prefix). Files: <PREFIX>_Global_{24h,48h,7d}.csv
SATELLITES = {
    "N": ("suomi-npp-viirs-c2", "SUOMI_VIIRS_C2"),
    "N20": ("noaa-20-viirs-c2", "J1_VIIRS_C2"),
    "N21": ("noaa-21-viirs-c2", "J2_VIIRS_C2"),
}
UA = "wildeye (github.com/musharna/wildeye)"
LICENCE = 'NASA full and open sharing, no restrictions (FIRMS FAQ); cite as "NASA FIRMS"; provided "as is" (LANCE disclaimer)'
FAQ_URL = "https://www.earthdata.nasa.gov/data/tools/firms/faq"
CELL_DEG = 0.5
BIN_H = 6
BIN_S = BIN_H * 3600
DEFAULT_DAYS = 7
DEFAULT_MIN_FRP = 100.0
DEFAULT_MAX_CELLS = 12000  # safety bound only; at 100 MW the 2026-09-12 run kept 6.2k
CONFIDENCE_KEPT = ("nominal", "high", "n", "h")
RETRIES = 4
NOTE = (
    f"Each point is a {CELL_DEG}° cell; colour = summed fire radiative power (MW) of VIIRS 375 m detections in "
    "the 6-hour bin(s) in scope. Detections are thermal anomalies at overpass time (gas flares, volcanoes "
    "and hot rooftops included), not fire perimeters; clouds hide fires. Low-confidence pixels dropped; "
    "cells under the window FRP floor dropped."
)


def url_for(sat: str, span: str = "7d") -> str:
    d, p = SATELLITES[sat]
    return f"{BASE}/{d}/csv/{p}_Global_{span}.csv"


def _get_text(
    url: str, timeout: int = 300, retries: int = RETRIES, sleep=time.sleep
) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == retries - 1:
                raise
            log.warning(
                "HTTP %d from %s, retry %d/%d", e.code, url, attempt + 1, retries - 1
            )
            sleep(30 * 2**attempt)
    raise AssertionError("unreachable")


def acq_ts(acq_date: str, acq_time: str) -> int:
    """Epoch seconds (UTC) of a detection. `acq_time` is HHMM; the global CSVs zero-pad it ("0024")
    but the FIRMS area API does not ("45" = 00:45), so it is parsed as an integer."""
    hh, mm = divmod(int(acq_time), 100)
    d = dt.date.fromisoformat(acq_date)
    return int(dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=dt.UTC).timestamp())


def cell_of(lat: float, lon: float) -> tuple[int, int]:
    return math.floor(lat / CELL_DEG), math.floor(lon / CELL_DEG)


def cell_centre(cell: tuple[int, int]) -> list[float]:
    i, j = cell
    return [round((j + 0.5) * CELL_DEG, 3), round((i + 0.5) * CELL_DEG, 3)]


def _iso(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def aggregate(
    csv_text: str, acc: dict, counts: collections.Counter, sats: dict
) -> int | None:
    """Fold one FIRMS CSV into acc[cell][bin_index] = [n, frp]; returns the newest kept
    acquisition (epoch s). A changed header raises naming the columns; an unparseable
    position/time raises too (ValueError) rather than being skipped silently."""
    rdr = csv.DictReader(io.StringIO(csv_text))
    need = {
        "latitude",
        "longitude",
        "acq_date",
        "acq_time",
        "confidence",
        "frp",
        "satellite",
    }
    missing = need - set(rdr.fieldnames or [])
    if missing:
        raise RuntimeError(
            f"FIRMS CSV header missing {sorted(missing)}: {rdr.fieldnames}"
        )
    latest = None
    for r in rdr:
        counts["rows"] += 1
        if (r["confidence"] or "").strip().lower() not in CONFIDENCE_KEPT:
            counts["dropped_low"] += 1
            continue
        ts = acq_ts(r["acq_date"], r["acq_time"])
        latest = ts if latest is None or ts > latest else latest
        cell = cell_of(float(r["latitude"]), float(r["longitude"]))
        b = acc.setdefault(cell, {}).setdefault(ts // BIN_S, [0, 0.0])
        b[0] += 1
        b[1] += max(float(r["frp"] or 0), 0.0)
        sats[r["satellite"]] = sats.get(r["satellite"], 0) + 1
        counts["kept"] += 1
    return latest


def build(
    acc: dict,
    days: int,
    max_cells: int,
    min_frp: float = 0.0,
    end_bin: int | None = None,
) -> tuple[list[dict], dict]:
    """Features (cell centres) with `bins` = [[bin_index - bin0, n, frp], …] newest first over the
    last `days` days ending at the newest bin; cells whose window FRP is below `min_frp` are dropped,
    the rest ranked by FRP and capped at `max_cells`. Returns (features, meta)."""
    if not acc:
        raise RuntimeError("no detections aggregated")
    newest = (
        end_bin
        if end_bin is not None
        else max(k for cells in acc.values() for k in cells)
    )
    bin0 = newest - days * 24 // BIN_H + 1  # oldest bin index kept
    rows, below = [], 0
    for cell, bins in acc.items():
        keep = sorted(
            ((k, v) for k, v in bins.items() if bin0 <= k <= newest), reverse=True
        )
        if not keep:
            continue
        frp = sum(v[1] for _, v in keep)
        if frp < min_frp:
            below += 1
            continue
        rows.append((frp, sum(v[0] for _, v in keep), cell, keep))
    rows.sort(key=lambda x: (-x[0], -x[1], x[2]))
    feats = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": cell_centre(cell)},
            "properties": {
                "n": n,
                "frp": round(frp, 1),
                "frp_max_bin": round(max(v[1] for _, v in keep), 1),
                "bins": [[k - bin0, v[0], round(v[1], 1)] for k, v in keep],
            },
        }
        for frp, n, cell, keep in rows[:max_cells]
    ]
    meta = {
        "bin0": _iso(bin0 * BIN_S),
        "bin_hours": BIN_H,
        "bins": newest - bin0 + 1,
        "newest": _iso((newest + 1) * BIN_S),
        "cells_total": len(rows) + below,
        "cells_below_floor": below,
        "cells_over_cap": max(0, len(rows) - max_cells),
        "cells_kept": len(feats),
        "min_frp": min_frp,
    }
    return feats, meta


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/fires.geojson"))
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS)
    ap.add_argument(
        "--min-frp",
        type=float,
        default=DEFAULT_MIN_FRP,
        help="drop cells with less window FRP (MW)",
    )
    ap.add_argument("--max-cells", type=int, default=DEFAULT_MAX_CELLS)
    ap.add_argument(
        "--span",
        default="7d",
        choices=("24h", "48h", "7d"),
        help="FIRMS file span to download",
    )
    ap.add_argument(
        "--satellites",
        default=",".join(SATELLITES),
        help="comma-separated ids from N,N20,N21",
    )
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    acc: dict = {}
    counts: collections.Counter = collections.Counter()
    sats: dict = {}
    latest = None
    sat_ids = a.satellites.split(",")
    for i, sat in enumerate(sat_ids):
        if i:
            time.sleep(2.0)
        url = url_for(sat, a.span)
        got = aggregate(_get_text(url), acc, counts, sats)
        latest = got if latest is None or (got is not None and got > latest) else latest
        log.info("%s: %s (%.0f s)", url, dict(counts), time.time() - t0)
    feats, meta = build(acc, a.days, a.max_cells, a.min_frp)
    if meta["cells_over_cap"]:
        log.warning(
            "%d cells above the FRP floor cut by --max-cells %d",
            meta["cells_over_cap"],
            a.max_cells,
        )
    if not feats:
        raise SystemExit(f"no cells with >= {a.min_frp} MW in the last {a.days} days")
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {
                "id": "fires",
                "name": "NASA FIRMS VIIRS 375 m active fire detections (Suomi-NPP, NOAA-20, NOAA-21)",
                "url": "https://firms.modaps.eosdis.nasa.gov/",
                "terms": FAQ_URL,
                "licence": LICENCE,
                "citation": "NASA FIRMS",
                "files": [url_for(s, a.span) for s in sat_ids],
                "cell_deg": CELL_DEG,
                "note": NOTE,
            },
            **meta,
            "latest": _iso(latest) if latest is not None else None,
            "days": a.days,
            "counts": {**counts, "satellites": sats},
            "features": feats,
        },
    )
    log.info(
        "wrote %s: %d cells, latest %s, meta=%s counts=%s (%.0f s)",
        a.out,
        len(feats),
        _iso(latest) if latest else None,
        meta,
        dict(counts),
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
