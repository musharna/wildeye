"""A0: can the radar see waterfowl apart from songbirds? Rules: docs/analysis/a0-fast-fliers.md (committed cfdb763b1
before any season airspeed or eBird count).

Each vol2bird bin's airspeed (|ground velocity - RAP wind|, as pipeline/insect_check.py computes it) puts its
density in a class: insect-like < 5 m/s, slow 5-12 (songbirds), intermediate 12-15 (reported only), fast >= 15
(ducks, geese and swans fly 15-20 m/s: Alerstam et al. 2007, PLoS Biol 5:e197). A night's fast passage is its
mt x its fast share. Five gates decide whether the fast series is a waterfowl measure (FIRED) or not (VOID).

Commands: `ebird` fetches the eBird (GBIF EOD) weekly duck-family share near each radar; `run` computes the classes
from the season store and RAP, the radiosonde second engine, and the verdict. Run with
`uv run --python 3.13 --with pygrib --with numpy python -m pipeline.fast_fliers ...`."""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import itertools
import json
import math
import time
import urllib.parse
from pathlib import Path

from . import insect_check as ic
from .bird_nights import night_total, night_window, stored_profiles
from .pair_check import spearman
from .vol2bird import parse_profile

INSECT_MAX = 5.0
SLOW_MAX = 12.0
FAST_MIN = 15.0
CLASSES = ("insect", "slow", "mid", "fast")
SEASON = ((8, 1), (11, 15))
M1_MIN_SHARE, M1_MIN_RADARS = 0.02, 14
M2_MIN_DAYS, M2_MIN_RADARS = 7, 14
M2_SLOW_WINDOW = ((9, 10), (10, 20))
M3_MAX_KM, M3_WINDOW_MIN, M3_MIN_RHO, M3_RATIO = 50.0, 30, 0.6, (0.5, 2.0)
M4_KM, M4_MIN_RADARS = 150, 15
EBIRD = "4fa7b334-ce0d-4e88-aaae-2e0c138d049e"
ANATIDAE, AVES = 2986, 212
GBIF = "https://api.gbif.org/v1/occurrence/search"
IEM_RAOB_STATIONS = "https://mesonet.agron.iastate.edu/geojson/network/RAOB.geojson"


def klass(a: float) -> str:
    if a < INSECT_MAX:
        return "insect"
    if a < SLOW_MAX:
        return "slow"
    return "mid" if a < FAST_MIN else "fast"


def class_density(profiles: list[tuple[dt.datetime, str]], wind_for) -> dict:
    """Density per airspeed class over `profiles`. wind_for(t) gives the wind column for a profile time, or None.
    Bins as insect_check.night_airspeed takes them (dens > 0 with u, v and a height; wind at the bin's middle);
    bins with no wind are counted under no_wind, never classed."""
    out = {c: 0.0 for c in CLASSES} | {"no_wind": 0.0, "profiles_used": 0}
    for t, text in profiles:
        col = wind_for(t)
        bins = parse_profile(text)
        hs = [b["height_m"] for b in bins if b["height_m"] is not None]
        dh = min((b - a for a, b in itertools.pairwise(hs) if b > a), default=200.0)
        took = False
        for b in bins:
            if not (
                b["dens"]
                and b["dens"] > 0
                and b["u"] is not None
                and b["v"] is not None
                and b["height_m"] is not None
            ):
                continue
            wv = ic.wind_at(b["height_m"] + dh / 2, col) if col is not None else None
            if wv is None:
                out["no_wind"] += b["dens"]
                continue
            out[klass(math.hypot(b["u"] - wv[0], b["v"] - wv[1]))] += b["dens"]
            took = True
        out["profiles_used"] += took
    return out


def share(d: dict, c: str) -> float | None:
    tot = sum(d[k] for k in CLASSES)
    return d[c] / tot if tot > 0 else None


def weighted_median_day(series: dict[str, float]) -> dt.date | None:
    """The night by which half the season's passage has gone (nights in date order, weights = passage)."""
    items = sorted(
        (dt.date.fromisoformat(n), w) for n, w in series.items() if w and w > 0
    )
    tot = sum(w for _, w in items)
    if tot <= 0:
        return None
    run = 0.0
    for n, w in items:
        run += w
        if run >= tot / 2:
            return n
    return items[-1][0]  # pragma: no cover - the loop always reaches half


def season_nights(year: int) -> list[dt.date]:
    (m0, d0), (m1, d1) = SEASON
    a, b = dt.date(year, m0, d0), dt.date(year, m1, d1)
    return [a + dt.timedelta(days=k) for k in range((b - a).days + 1)]


# --- gates ------------------------------------------------------------------------------------------------


def m1(radars: dict) -> dict:
    """radars: {sid: {night: class_density}} for one fall. Fast share of the season density per radar."""
    per = {}
    for sid, nights in radars.items():
        tot = {c: sum(n[c] for n in nights.values()) for c in CLASSES}
        per[sid] = share(tot, "fast")
    hits = sum(1 for v in per.values() if v is not None and v >= M1_MIN_SHARE)
    return {"fast_share": per, "radars_passing": hits, "passes": hits >= M1_MIN_RADARS}


def m2(radars: dict, year: int, mt: dict) -> dict:
    """Median night of fast vs slow passage (passage = mt x class share) per radar, and the slow-class control."""
    (am, ad), (bm, bd) = M2_SLOW_WINDOW
    lo, hi = dt.date(year, am, ad), dt.date(year, bm, bd)
    per = {}
    for sid, nights in radars.items():
        med = {}
        for c in ("fast", "slow"):
            s = {}
            for n, d in nights.items():
                sh, m = share(d, c), mt.get(sid, {}).get(n)
                if sh is not None and m is not None:
                    s[n] = sh * m
            med[c] = weighted_median_day(s)
        lag = (med["fast"] - med["slow"]).days if med["fast"] and med["slow"] else None
        per[sid] = {
            "fast": med["fast"] and med["fast"].isoformat(),
            "slow": med["slow"] and med["slow"].isoformat(),
            "lag_days": lag,
            "slow_in_window": bool(med["slow"] and lo <= med["slow"] <= hi),
        }
    later = sum(
        1
        for p in per.values()
        if p["lag_days"] is not None and p["lag_days"] >= M2_MIN_DAYS
    )
    control = sum(1 for p in per.values() if p["slow_in_window"])
    return {
        "per_radar": per,
        "radars_later": later,
        "slow_control_radars": control,
        "passes": later >= M2_MIN_RADARS and control >= M2_MIN_RADARS,
    }


def m3(pairs: dict) -> dict:
    """pairs: {sid: {night: (rap_density, raob_density)}} on the same profiles. Spearman of nightly fast shares
    per radar (median over radars) and the pooled share ratio (radiosonde / RAP)."""
    rhos, rap_tot, raob_tot = {}, {c: 0.0 for c in CLASSES}, {c: 0.0 for c in CLASSES}
    for sid, nights in pairs.items():
        xs, ys = [], []
        for rap, raob in nights.values():
            a, b = share(rap, "fast"), share(raob, "fast")
            if a is None or b is None:
                continue
            xs.append(a)
            ys.append(b)
            for c in CLASSES:
                rap_tot[c] += rap[c]
                raob_tot[c] += raob[c]
        rhos[sid] = {
            "nights": len(xs),
            "rho": spearman(xs, ys) if len(xs) >= 3 else None,
        }
    vals = sorted(r["rho"] for r in rhos.values() if r["rho"] is not None)
    med = (
        vals[len(vals) // 2]
        if len(vals) % 2
        else (sum(vals[len(vals) // 2 - 1 : len(vals) // 2 + 1]) / 2 if vals else None)
    )
    a, b = share(rap_tot, "fast"), share(raob_tot, "fast")
    ratio = b / a if a and b is not None else None
    ok = (
        med is not None
        and med >= M3_MIN_RHO
        and ratio is not None
        and M3_RATIO[0] <= ratio <= M3_RATIO[1]
    )
    return {
        "per_radar": rhos,
        "median_rho": med,
        "pooled_fast_share": {"rap": a, "raob": b},
        "ratio": ratio,
        "passes": ok,
    }


def weekly_fast_share(nights: dict) -> dict[str, float]:
    """{ISO week 'YYYY-Www': fast share} pooling the week's class densities."""
    weeks: dict[str, dict] = {}
    for n, d in nights.items():
        y, w, _ = dt.date.fromisoformat(n).isocalendar()
        acc = weeks.setdefault(f"W{w:02d}", {c: 0.0 for c in CLASSES})
        for c in CLASSES:
            acc[c] += d[c]
    return {w: s for w, acc in weeks.items() if (s := share(acc, "fast")) is not None}


def m4(ducks: dict, same: dict, wrong: dict) -> dict:
    """ducks: {sid: {week: duck share}} (2025); same/wrong: {sid: {night: class_density}} for 2025 / 2026.
    Weeks are matched by ISO week number. Same year must beat wrong year at >= M4_MIN_RADARS radars."""
    per, wins = {}, 0
    for sid, dk in ducks.items():
        r = {}
        for arm, src in (("same", same), ("wrong", wrong)):
            fs = weekly_fast_share(src.get(sid, {}))
            ws = sorted(set(dk) & set(fs))
            r[arm] = (
                spearman([dk[w] for w in ws], [fs[w] for w in ws])
                if len(ws) >= 5
                else None
            )
            r[f"{arm}_weeks"] = len(ws)
        r["same_beats_wrong"] = (
            r["same"] is not None and r["wrong"] is not None and r["same"] > r["wrong"]
        )
        wins += r["same_beats_wrong"]
        per[sid] = r
    return {
        "per_radar": per,
        "radars_same_beats_wrong": wins,
        "passes": wins >= M4_MIN_RADARS,
    }


# --- eBird on GBIF -----------------------------------------------------------------------------------------


def iso_weeks(year: int) -> list[tuple[str, dt.date, dt.date]]:
    """ISO weeks overlapping the season, each clipped to it."""
    nights = season_nights(year)
    out: dict[str, list[dt.date]] = {}
    for n in nights:
        out.setdefault(f"W{n.isocalendar()[1]:02d}", []).append(n)
    return [(w, ds[0], ds[-1]) for w, ds in out.items()]


def gbif_count(params: dict, get=ic._get) -> int:
    body = json.loads(
        get(GBIF + "?" + urllib.parse.urlencode(params | {"limit": 0})).decode()
    )
    if "count" not in body:
        raise ValueError(
            f"GBIF answered without a count for {params}: {str(body)[:200]}"
        )
    return int(body["count"])


def duck_share(
    site: dict, start: dt.date, end: dt.date, get=ic._get, sleep: float = 1.0
) -> dict:
    base = {
        "datasetKey": EBIRD,
        "geo_distance": f"{site['lat']},{site['lon']},{M4_KM}km",
        "eventDate": f"{start.isoformat()},{end.isoformat()}",
    }
    aves = gbif_count(base | {"classKey": AVES}, get)
    time.sleep(sleep)
    ducks = gbif_count(base | {"familyKey": ANATIDAE}, get)
    time.sleep(sleep)
    return {"aves": aves, "anatidae": ducks, "share": ducks / aves if aves else None}


# --- radiosondes --------------------------------------------------------------------------------------------


def km(lat1, lon1, lat2, lon2) -> float:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    return 6371.0 * math.acos(
        min(
            1.0,
            math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl),
        )
    )


def near_stations(sites: dict, stations: list[dict]) -> dict[str, dict]:
    """{site: nearest RAOB station within M3_MAX_KM}, from the IEM station GeoJSON features."""
    out = {}
    for sid, s in sites.items():
        best = None
        for f in stations:
            lon, lat = f["geometry"]["coordinates"][:2]
            d = km(s["lat"], s["lon"], lat, lon)
            if d <= M3_MAX_KM and (best is None or d < best["km"]):
                best = {"station": f["properties"]["sid"], "km": round(d, 1)}
        if best:
            out[sid] = best
    return out


def raob_column(rows: list[dict]) -> dict | None:
    """IEM raob.py profile rows -> a wind column {"hgt", "u", "v"} (m ASL), levels with height and wind only."""
    pts = {}
    for r in rows:
        if r.get("hght") is None or r.get("drct") is None or r.get("sknt") is None:
            continue
        s, d = r["sknt"] * 0.514444, math.radians(r["drct"])
        pts[float(r["hght"])] = (-s * math.sin(d), -s * math.cos(d))
    if len(pts) < 2:
        return None
    hs = sorted(pts)
    return {"hgt": hs, "u": [pts[h][0] for h in hs], "v": [pts[h][1] for h in hs]}


# --- run ------------------------------------------------------------------------------------------------------


def verdict(gates: dict) -> str:
    return "FIRED" if all(g["passes"] for g in gates.values()) else "VOID"


def cmd_ebird(a):
    sites = {
        s["id"]: s
        for s in json.loads((Path(__file__).parent / "sites.json").read_text())
    }
    doc = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "dataset": EBIRD,
        "radius_km": M4_KM,
        "year": 2025,
        "sites": {},
    }
    for sid, s in sites.items():
        doc["sites"][sid] = {w: duck_share(s, a0, b0) for w, a0, b0 in iso_weeks(2025)}
        print(sid, len(doc["sites"][sid]), "weeks", flush=True)
    a.out.write_text(json.dumps(doc, indent=1) + "\n")


def cmd_run(a):
    sites = {
        s["id"]: s
        for s in json.loads((Path(__file__).parent / "sites.json").read_text())
    }
    sids = sorted(sites)
    years = [int(y) for y in a.years.split(",")]
    nights = [n for y in years for n in season_nights(y)]
    if a.limit_nights:
        nights = nights[: a.limit_nights]
    windows = {
        (sid, n): night_window(n, sites[sid]["lon"], sites[sid]["lat"])
        for sid in sids
        for n in nights
    }
    hours = sorted(
        {
            ic.nearest_hour(s) + dt.timedelta(hours=k)
            for s, r in windows.values()
            for k in range(
                int((ic.nearest_hour(r) - ic.nearest_hour(s)).total_seconds() // 3600)
                + 1
            )
        }
    )
    t0 = time.monotonic()
    with cf.ThreadPoolExecutor(4) as ex:
        for k, _ in enumerate(ex.map(lambda h: ic.fetch_hour(h, a.cache), hours)):
            if k % 24 == 0:
                print(
                    f"fetched {k + 1}/{len(hours)} in {time.monotonic() - t0:.0f} s",
                    flush=True,
                )
    fetch_s = time.monotonic() - t0
    winds = {h: ic.columns(ic.fetch_hour(h, a.cache), sites) for h in hours}
    turn = max(c["turn_error_deg"] for cols in winds.values() for c in cols.values())
    classes, mt = {}, {}
    for sid in sids:
        for n in nights:
            sunset, sunrise = windows[(sid, n)]
            profs = stored_profiles(a.vp_dir, sid, sunset, sunrise)
            if not profs:
                continue
            d = class_density(
                profs, lambda t, sid=sid: (winds.get(ic.nearest_hour(t)) or {}).get(sid)
            )
            classes.setdefault(n.year, {}).setdefault(sid, {})[n.isoformat()] = d
            mt.setdefault(sid, {})[n.isoformat()] = night_total(profs, sunset, sunrise)[
                "mt_birds_km"
            ]
    stations = near_stations(
        sites, json.loads(ic._get(IEM_RAOB_STATIONS).decode())["features"]
    )
    pairs, errs = {}, []
    for sid, st in stations.items():
        for n in nights:
            sunset, sunrise = windows[(sid, n)]
            h00 = dt.datetime.combine(n + dt.timedelta(days=1), dt.time(0), dt.UTC)
            lo, hi = (
                h00 - dt.timedelta(minutes=M3_WINDOW_MIN),
                h00 + dt.timedelta(minutes=M3_WINDOW_MIN),
            )
            profs = (
                [
                    p
                    for p in stored_profiles(
                        a.vp_dir, sid, max(sunset, lo), min(sunrise, hi)
                    )
                ]
                if sunset < hi
                else []
            )
            if not profs:
                continue
            cache = a.cache / f"raob_{st['station']}_{h00:%Y%m%d%H}.json"
            if not cache.exists():
                cache.write_bytes(
                    ic._get(
                        f"{ic.IEM_RAOB}?ts={h00:%Y%m%d%H%M}&station={st['station']}"
                    )
                )
                time.sleep(2)
            got = json.loads(cache.read_text()).get("profiles") or []
            col = raob_column(got[0]["profile"]) if got else None
            if col is None:
                continue
            rap = class_density(
                profs, lambda t, sid=sid: (winds.get(ic.nearest_hour(t)) or {}).get(sid)
            )
            raob = class_density(profs, lambda t: col)
            pairs.setdefault(sid, {})[n.isoformat()] = (rap, raob)
            rcol = winds.get(h00, {}).get(sid)
            for p in ic.RAOB_LEVELS_HPA:
                obs = ic.raob_uv(got[0]["profile"], float(p))
                if obs is not None and rcol is not None:
                    ue, ve = ic.col_at_pressure(rcol, p)
                    errs.append(math.hypot(ue - obs[0], ve - obs[1]))
    rms = ic.rms(errs)
    gates = {
        "M0": {
            "turn_error_deg_max": turn,
            "raob_rms_ms": rms,
            "levels": len(errs),
            "passes": turn <= ic.TURN_MAX_DEG
            and rms is not None
            and len(errs) >= 30
            and rms <= ic.RAOB_MAX_RMS_MS,
        }
    }
    for y in years:
        gates[f"M1_{y}"] = m1(classes.get(y, {}))
        gates[f"M2_{y}"] = m2(classes.get(y, {}), y, mt)
    gates["M3"] = m3(pairs)
    ducks = (
        {
            sid: {w: v["share"] for w, v in ws.items() if v["share"] is not None}
            for sid, ws in json.loads(a.ebird.read_text())["sites"].items()
        }
        if a.ebird
        else {}
    )
    gates["M4"] = (
        m4(ducks, classes.get(2025, {}), classes.get(2026, {}))
        if ducks
        else {"passes": False, "why": "no eBird file"}
    )
    doc = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "rules": "docs/analysis/a0-fast-fliers.md",
        "years": years,
        "nights": len(nights),
        "hours": len(hours),
        "rap_fetch_s": round(fetch_s),
        "stations": stations,
        "verdict": verdict(gates),
        "gates": gates,
        "classes": {str(y): v for y, v in classes.items()},
        "mt": mt,
    }
    a.out.write_text(json.dumps(doc, indent=1, default=str) + "\n")
    print(
        json.dumps(
            {
                "verdict": doc["verdict"],
                "gates": {k: g["passes"] for k, g in gates.items()},
                "hours": len(hours),
                "rap_fetch_s": round(fetch_s),
            },
            indent=1,
        )
    )


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("ebird")
    e.add_argument("--out", type=Path, required=True)
    r = sub.add_parser("run")
    r.add_argument("--vp-dir", type=Path, required=True)
    r.add_argument("--cache", type=Path, required=True)
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--years", default="2025,2026")
    r.add_argument("--ebird", type=Path, default=None)
    r.add_argument(
        "--limit-nights", type=int, default=0, help="pilot: the first N nights only"
    )
    a = ap.parse_args(argv)
    if a.cmd == "run":
        a.cache.mkdir(parents=True, exist_ok=True)
    (cmd_ebird if a.cmd == "ebird" else cmd_run)(a)


if __name__ == "__main__":
    main()
