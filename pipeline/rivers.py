"""USGS river temperature and flow (site-series contract) → public/data/rivers.geojson.

Gap layer `rivers` (token `rv`). Source: the modernized USGS Water Data OGC API
(`api.waterdata.usgs.gov/ogcapi/v0`, collection `daily`), NOT the legacy
waterservices.usgs.gov `nwis/dv` service, which USGS says "will be intentionally throttled and
undergo several planned outages before their final decommissioning" (Water Data Blog, NWISWeb
Decommission Campaign 3, 2026-07-31; legacy access ends after February 2027).

Per parameter — 00010 water temperature (°C), then 00060 discharge (ft³/s) — one
`time-series-metadata` request (sublocation label of every daily-mean series) and one national,
cursor-paged `daily` query for the daily MEAN (`statistic_id=00003`, `time=P{days+1}D`, 50 000
rows a page), ≥ 2 s between requests. Discharge rows are kept only for gages that reported a
temperature; only gages reporting BOTH inside the window are emitted (the layer colours by
temperature and sizes by flow). Names, state and HUC come from `monitoring-locations` in id
batches of 200. About 18 requests a run, inside the keyless api.data.gov limit (optional key
`USGS_WATER_API_KEY`, sent as `X-Api-Key`).

One series per gage and parameter. Some gages run several sensors, each its own time series
(2026-09-12: 49 of 1 779 recently reporting temperature gages, e.g. TOP/BOTTOM, East/West, a
depth — and the metadata `primary` flag is "Primary" on 2–10 of them per gage, so it does not
choose). Rule: the single series without a sublocation if there is exactly one, else the series
with the most values in the window, ties to the lowest series id; its sublocation is published
as `sensor`. Mixing rows across sensors day by day is never done.

One Point per gage with a daily series (`d0` = first day, `t[]`/`q[]` aligned per day,
null = no value). `time` is the gage's local calendar day. Values are provisional
("Provisional data are subject to revision" — the service's own disclaimer). USGS-authored
data are U.S. Public Domain (usgs.gov copyrights-and-credits); any use of trade, firm, or
product names is for descriptive purposes only and does not imply endorsement by the U.S.
Government.
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from .atomic import write_atomic

log = logging.getLogger("rivers")
BASE = "https://api.waterdata.usgs.gov/ogcapi/v0/collections"
UA = "wildeye (github.com/musharna/wildeye)"
LICENCE = "Public Domain U.S. Government (USGS)"
NOTE = (
    "Daily mean water temperature and discharge from USGS gages; provisional data are subject to "
    "revision. Any use of trade, firm, or product names is for descriptive purposes only and does "
    "not imply endorsement by the U.S. Government."
)
TEMP, FLOW = "00010", "00060"
MEAN = "00003"
PAGE = 50000
MAX_PAGES = 40  # national flow is ~6 pages at P31D; 40 means the query shape broke
ID_BATCH = 200
RETRIES = 4
SEED_MAX_BYTES = 100_000


def _headers() -> dict:
    h = {"User-Agent": UA}
    key = os.environ.get("USGS_WATER_API_KEY")
    if key:
        h["X-Api-Key"] = key
    return h


def _get_json(
    url: str, timeout: int = 300, retries: int = RETRIES, sleep=time.sleep
) -> dict:
    """GET JSON; 5xx and 429 (api.data.gov rate limit) retried with backoff, other 4xx raised."""
    req = urllib.request.Request(url, headers=_headers())
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if (e.code < 500 and e.code != 429) or attempt == retries - 1:
                raise
            log.warning(
                "HTTP %d from %s, retry %d/%d",
                e.code,
                url[:120],
                attempt + 1,
                retries - 1,
            )
            sleep(30 * 2**attempt)
    raise AssertionError("unreachable")


def daily_url(param: str, days: int) -> str:
    return (
        f"{BASE}/daily/items?f=json&parameter_code={param}&statistic_id={MEAN}"
        f"&time=P{days}D&limit={PAGE}"
        f"&properties=monitoring_location_id,time_series_id,time,value"
    )


def series_meta_url(param: str) -> str:
    return (
        f"{BASE}/time-series-metadata/items?f=json&parameter_code={param}"
        f"&statistic_id={MEAN}&limit={PAGE}&properties=monitoring_location_id,sublocation_identifier"
    )


def locations_url(ids: list[str]) -> str:
    return (
        f"{BASE}/monitoring-locations/items?f=json&limit={len(ids)}"
        f"&properties=monitoring_location_name,state_name,hydrologic_unit_code,site_type_code"
        f"&id={','.join(ids)}"
    )


def fetch_pages(url: str, fetch, gap: float, sleep=time.sleep) -> list[dict]:
    """All features behind a cursor-paged OGC items URL (follows rel=next), `gap` s between pages."""
    out: list[dict] = []
    pages = 0
    while url:
        if pages >= MAX_PAGES:
            raise RuntimeError(f"more than {MAX_PAGES} pages for {url[:160]}")
        if pages:
            sleep(gap)
        page = fetch(url)
        pages += 1
        out.extend(page["features"])
        url = next(
            (l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None
        )
    log.info("%d rows in %d page(s)", len(out), pages)
    return out


def sublocations(meta_rows: list[dict]) -> dict[str, str | None]:
    """time-series-metadata features → {series id: sublocation label or None}."""
    return {
        f["id"]: (f["properties"].get("sublocation_identifier") or None)
        for f in meta_rows
    }


def series(rows: list[dict], keep: set[str] | None = None) -> tuple[dict, dict]:
    """Daily rows → {location id: {"xy": [lon, lat], "by": {series id: {date: value}}}}.
    Null and unparsable values are dropped; a repeated (series, date) keeps the first value.
    `keep` restricts to those location ids. Returns (sites, counts)."""
    counts = {"rows": len(rows), "null": 0, "dup": 0, "skipped": 0}
    out: dict[str, dict] = {}
    for f in rows:
        p = f["properties"]
        sid = p["monitoring_location_id"]
        if keep is not None and sid not in keep:
            counts["skipped"] += 1
            continue
        try:
            x = float(p["value"])
        except (TypeError, ValueError):
            counts["null"] += 1
            continue
        s = out.setdefault(sid, {"xy": f["geometry"]["coordinates"], "by": {}})
        v = s["by"].setdefault(p["time_series_id"], {})
        if p["time"] in v:
            counts["dup"] += 1
            continue
        v[p["time"]] = x
    return out, counts


def pick(sites: dict, subloc: dict, drange: list[str]) -> tuple[dict, int]:
    """One series per location → {id: {"xy", "v": {date: value}, "sensor": label|None}}, plus the
    number of locations that had more than one series. Rule in the module docstring."""
    win = set(drange)
    out, multi = {}, 0
    for sid, s in sites.items():
        ids = sorted(s["by"])
        if len(ids) > 1:
            multi += 1
            plain = [i for i in ids if subloc.get(i) is None]
            if len(plain) == 1:
                ids = plain
            else:
                ids.sort(key=lambda i: -sum(1 for d in s["by"][i] if d in win))
        out[sid] = {"xy": s["xy"], "v": s["by"][ids[0]], "sensor": subloc.get(ids[0])}
    return out, multi


def fetch_locations(ids: list[str], fetch, gap: float, sleep=time.sleep) -> dict:
    """{id: {name, state, huc, type}} for `ids`, ID_BATCH per request. A missing id raises."""
    out: dict[str, dict] = {}
    for i in range(0, len(ids), ID_BATCH):
        if i:
            sleep(gap)
        for f in fetch(locations_url(ids[i : i + ID_BATCH]))["features"]:
            p = f["properties"]
            out[f["id"]] = {
                "name": p.get("monitoring_location_name") or "",
                "state": p.get("state_name") or "",
                "huc": p.get("hydrologic_unit_code"),
                "type": p.get("site_type_code"),
            }
    missing = [i for i in ids if i not in out]
    if missing:
        raise RuntimeError(
            f"{len(missing)} location(s) absent from monitoring-locations: {missing[:5]}"
        )
    return out


def day_range(today: dt.date, days: int) -> list[str]:
    """The `days` calendar days ending yesterday (today's daily mean is never complete)."""
    end = today - dt.timedelta(days=1)
    return [(end - dt.timedelta(days=days - 1 - i)).isoformat() for i in range(days)]


def _q(v: float) -> float | int:
    """Discharge to 3 significant figures; values ≥ 100 as ints (no trailing .0)."""
    r = float(f"{v:.3g}")
    return int(r) if abs(r) >= 100 else r


def aggregate(
    temp: dict, flow: dict, meta: dict, today: dt.date, days: int
) -> tuple[list[dict], dict]:
    """One Point per gage with a temperature AND a discharge inside the window (inputs are `pick`
    output), series aligned to `day_range(today, days)`; temperature to 0.1 °C.
    `latest` = newest day with a temperature."""
    drange = day_range(today, days)
    counts = {"temp_sites": len(temp), "half": 0, "gages": 0}
    features = []
    for sid in sorted(temp):
        tv, qv = temp[sid]["v"], flow.get(sid, {}).get("v", {})
        t = [tv.get(d) for d in drange]
        q = [qv.get(d) for d in drange]
        if not any(v is not None for v in t) or not any(v is not None for v in q):
            counts["half"] += 1
            continue
        t = [None if v is None else round(v, 1) for v in t]
        q = [None if v is None else _q(v) for v in q]
        li = max(i for i, v in enumerate(t) if v is not None)
        md = meta[sid]
        lon, lat = temp[sid]["xy"]
        props = {
            "site": sid.split("-", 1)[1] if sid.startswith("USGS-") else sid,
            "name": md["name"],
            "state": md["state"],
            "huc": md["huc"],
            "type": md["type"],
            "d0": drange[0],
            "t": t,
            "q": q,
            "latest": {"d": drange[li], "t": t[li], "q": q[li]},
        }
        if temp[sid].get("sensor"):
            props["sensor"] = temp[sid]["sensor"]
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lon, 5), round(lat, 5)],
                },
                "properties": props,
            }
        )
    counts["gages"] = len(features)
    return features, counts


def make_seed(gj: dict, n: int = 300, days: int = 10) -> dict:
    """< 100 KB seed: `n` gages round-robin across states (alphabetical; file order within a state),
    series cut to the last `days` days, coordinates to 3 dp, no HUC/type. Gages whose only
    temperatures are older than the cut are dropped. Raises if the result is still too big."""
    by_state: dict[str, list[dict]] = {}
    for f in gj["features"]:
        by_state.setdefault(f["properties"]["state"], []).append(f)
    queues = [by_state[s] for s in sorted(by_state)]
    picked: list[dict] = []
    k = 0
    while len(picked) < n and any(k < len(qu) for qu in queues):
        picked.extend(qu[k] for qu in queues if k < len(qu))
        k += 1
    picked = sorted(picked[:n], key=lambda f: f["properties"]["site"])
    feats = []
    for f in picked:
        p = f["properties"]
        t, q = p["t"][-days:], p["q"][-days:]
        if not any(v is not None for v in t):
            continue
        li = max(i for i, v in enumerate(t) if v is not None)
        d0 = dt.date.fromisoformat(p["d0"]) + dt.timedelta(days=len(p["t"]) - days)
        lon, lat = f["geometry"]["coordinates"]
        props = {
            "site": p["site"],
            "name": p["name"],
            "state": p["state"],
            "d0": d0.isoformat(),
            "t": t,
            "q": q,
            "latest": {
                "d": (d0 + dt.timedelta(days=li)).isoformat(),
                "t": t[li],
                "q": q[li],
            },
        }
        if p.get("sensor"):
            props["sensor"] = p["sensor"]
        feats.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lon, 3), round(lat, 3)],
                },
                "properties": props,
            }
        )
    seed = {
        **{
            k: v
            for k, v in gj.items()
            if k not in ("features", "source", "days", "day0")
        },
        "source": {
            **gj["source"],
            "subsample": (
                f"seed: {len(feats)} of {len(gj['features'])} gages round-robin across states, "
                f"last {days} days only, coordinates 3 dp (seed < 100 KB)"
            ),
        },
        "days": days,
        "day0": feats[0]["properties"]["d0"] if feats else None,
        "features": feats,
    }
    size = len(json.dumps(seed, separators=(",", ":")).encode())
    if size >= SEED_MAX_BYTES:
        raise SystemExit(
            f"seed is {size} bytes (≥ {SEED_MAX_BYTES}); lower --seed-n/--seed-days"
        )
    return seed


def _one_parameter(param, fetch, days, gap, keep=None):
    """Sublocation metadata + daily rows for one parameter → (pick() output, counts)."""
    subloc = sublocations(fetch_pages(series_meta_url(param), fetch, gap, time.sleep))
    time.sleep(gap)
    sites, c = series(
        fetch_pages(daily_url(param, days + 1), fetch, gap, time.sleep), keep=keep
    )
    return sites, subloc, c


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/rivers.geojson"))
    ap.add_argument(
        "--days", type=int, default=30, help="daily bins kept, ending yesterday"
    )
    ap.add_argument("--today", default=None, help="YYYY-MM-DD (tests)")
    ap.add_argument("--sleep", type=float, default=2.0, help="seconds between requests")
    ap.add_argument(
        "--seed-from",
        type=Path,
        default=None,
        help="no network: build the seed from this existing output file",
    )
    ap.add_argument("--seed-out", type=Path, default=None)
    ap.add_argument("--seed-n", type=int, default=300)
    ap.add_argument("--seed-days", type=int, default=10)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    if a.seed_from:
        if not a.seed_out:
            raise SystemExit("--seed-from needs --seed-out")
        seed = make_seed(json.loads(a.seed_from.read_text()), a.seed_n, a.seed_days)
        write_atomic(a.seed_out, seed)
        log.info(
            "wrote seed %s: %d gages, %d bytes",
            a.seed_out,
            len(seed["features"]),
            a.seed_out.stat().st_size,
        )
        return
    t0 = time.time()
    today = (
        dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.UTC).date()
    )
    drange = day_range(today, a.days)
    fetch = _get_json  # module global looked up at call time (tests monkeypatch it)
    tsites, tsub, tc = _one_parameter(TEMP, fetch, a.days, a.sleep)
    temp, tc["multi_series_sites"] = pick(tsites, tsub, drange)
    log.info("temperature: %s, %d sites (%.0f s)", tc, len(temp), time.time() - t0)
    if not temp:
        raise SystemExit("no daily-mean water temperature returned")
    time.sleep(a.sleep)
    qsites, qsub, qc = _one_parameter(FLOW, fetch, a.days, a.sleep, keep=set(temp))
    flow, qc["multi_series_sites"] = pick(qsites, qsub, drange)
    log.info(
        "discharge at temperature sites: %s, %d sites (%.0f s)",
        qc,
        len(flow),
        time.time() - t0,
    )
    both = sorted(
        set(temp) & set(flow)
    )  # empty → aggregate yields no features → exit below
    time.sleep(a.sleep)
    meta = fetch_locations(both, fetch, a.sleep, time.sleep)
    features, counts = aggregate(temp, flow, meta, today, a.days)
    if not features:
        raise SystemExit(
            f"no gage reported both temperature and discharge in the window: {counts}"
        )
    counts |= {"temp_rows": tc, "flow_rows": qc}
    write_atomic(
        a.out,
        {
            "type": "FeatureCollection",
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {
                "id": "rivers",
                "name": "USGS Water Data APIs (daily values)",
                "api": f"{BASE}/daily",
                "licence": LICENCE,
                "url": "https://waterdata.usgs.gov",
                "note": NOTE,
            },
            "today": today.isoformat(),
            "days": a.days,
            "day0": drange[0],
            "data_end": drange[-1],
            "parameters": {
                TEMP: "water temperature, °C, daily mean",
                FLOW: "discharge, ft³/s, daily mean",
            },
            "counts": counts,
            "features": features,
        },
    )
    log.info(
        "wrote %s: %d gages, %s (%.0f s)",
        a.out,
        len(features),
        {k: counts[k] for k in ("temp_sites", "half", "gages")},
        time.time() - t0,
    )


if __name__ == "__main__":
    main()
