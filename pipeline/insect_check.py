"""Are a radar's big nights insects? The airspeed check (rules fixed in the insect grill ledger,
grill_wildeye_insects_2026-10-20.md, closed 2026-10-21, and in docs/analysis/bird-insects.md, before any wind
was fetched).

Airspeed = |vol2bird's ground velocity (u, v) - the model wind at that height and hour|, per height bin. Birds fly
through the air; insects mostly drift with it. Wind: NOAA RAP hourly analyses (13 km, pressure levels 1000-600 hPa,
geopotential height + u/v), the grid point nearest the radar, linear in height, the analysis hour nearest the
profile. RAP's u/v are grid-relative on its Lambert grid and are turned to earth-relative here. A night is "insects"
when at least INSECT_SHARE of its density (bins pooled over the night's profiles, weighted by dens) has an
airspeed below CUTOFF_MS; otherwise "birds". It is "void" when the wind did not change the answer it was meant to
change: no profile found a wind, or airspeed and ground speed differ by under FIRED_MIN_MS on average."""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import itertools
import json
import math
import time
import urllib.request
from pathlib import Path

from .bird_nights import night_total, night_window, stored_profiles
from .vol2bird import parse_profile

RAP = "https://noaa-rap-pds.s3.amazonaws.com"
IEM_RAOB = "https://mesonet.agron.iastate.edu/json/raob.py"
LEVELS_HPA = tuple(
    range(1000, 575, -25)
)  # 1000 ... 600 hPa: the layer birds fly in, to ~4 km
# 5 m/s per time-altitude bin: Shi et al. 2025, Ornithol. Appl. 127:duaf020 (doi:10.1093/ornithapp/duaf020) on
# vol2bird profiles; Horton et al. 2016, Biol. Lett. 12:20160591 use 5.5. Both trace it to Larkin 1991. The night
# rule on top (INSECT_SHARE of the density) is this check's own, not theirs. 5.5 and 7 (Cabrera-Cruz et al. 2013,
# Condor 115:263, best cutoff 5.5-9 in the tropics) are reported beside it, not used.
CUTOFF_MS = 5.0
SENSITIVITY_MS = (5.5, 7.0)
TURN_MAX_DEG = 0.2
INSECT_SHARE = 0.5
FIRED_MIN_MS = 0.5
RAOB_LEVELS_HPA = (925, 850, 700)
RAOB_MAX_RMS_MS = 3.0

# --- RAP: which bytes, and what they say -------------------------------------------------------------


def rap_key(hour: dt.datetime) -> str:
    return f"rap.{hour:%Y%m%d}/rap.t{hour:%H}z.awp130pgrbf00.grib2"


def idx_ranges(idx_text: str, levels=LEVELS_HPA) -> list[tuple[int, int | None]]:
    """Byte ranges (inclusive end; None = to the end of the file) of the HGT and UGRD messages at `levels`
    in a RAP .idx. VGRD shares UGRD's message (same offset, records n.1 / n.2), so it comes with it.
    A wanted field missing from the index raises."""
    rows = []
    for line in idx_text.splitlines():
        parts = line.split(":")
        if len(parts) >= 6:
            rows.append((int(parts[1]), parts[3], parts[4]))
    offsets = sorted({r[0] for r in rows})
    nxt = {
        o: (offsets[i + 1] - 1 if i + 1 < len(offsets) else None)
        for i, o in enumerate(offsets)
    }
    want = {(var, f"{lev} mb") for var in ("HGT", "UGRD", "VGRD") for lev in levels}
    found, out = set(), {}
    for off, var, lev in rows:
        if (var, lev) in want:
            found.add((var, lev))
            out[off] = nxt[off]
    missing = want - found
    if missing:
        raise ValueError(
            f"RAP index lacks {sorted(missing)[:4]}{' ...' if len(missing) > 4 else ''}"
        )
    return sorted(out.items())


def to_earth(
    u: float, v: float, lon: float, lov: float, latin: float
) -> tuple[float, float]:
    """Grid-relative (u, v) on a tangent Lambert conformal grid (LoV, Latin1 = Latin2) to earth-relative:
    the grid's y axis points at LoV's north, turned by n * (lon - LoV) with cone constant n = sin(Latin)."""
    a = math.radians(math.sin(math.radians(latin)) * (((lon - lov + 180) % 360) - 180))
    return math.cos(a) * u + math.sin(a) * v, -math.sin(a) * u + math.cos(a) * v


def wind_at(h: float, col: dict) -> tuple[float, float] | None:
    """(u, v) at height h (m) from a column {"hgt": [...], "u": [...], "v": [...]}, linear in height between
    levels; None outside the column (below its lowest or above its highest level)."""
    pts = sorted(zip(col["hgt"], col["u"], col["v"]))
    if not pts or h < pts[0][0] or h > pts[-1][0]:
        return None
    for (h0, u0, v0), (h1, u1, v1) in itertools.pairwise(pts):
        if h0 <= h <= h1:
            f = 0.0 if h1 == h0 else (h - h0) / (h1 - h0)
            return u0 + f * (u1 - u0), v0 + f * (v1 - v0)
    return pts[0][1], pts[0][2]  # one level only, and h equals it


def columns(grib: Path, sites: dict) -> dict:
    """{site: column} from a RAP subset file (HGT, UGRD, VGRD at LEVELS_HPA), earth-relative, at the grid point
    nearest each site. Imports pygrib here so the rest of the module (and its tests) need only the stdlib."""
    import numpy as np
    import pygrib

    cols = {sid: {"hgt": {}, "u": {}, "v": {}} for sid in sites}
    near, uv = {}, {}
    for m in pygrib.open(str(grib)):
        if m.typeOfLevel != "isobaricInhPa" or m.shortName not in ("gh", "u", "v"):
            continue
        if not near:
            if m.gridType != "lambert" or m["Latin1InDegrees"] != m["Latin2InDegrees"]:
                raise ValueError(
                    f"{grib.name}: expected a tangent Lambert grid, got {m.gridType}"
                )
            lat, lon = m.latlons()
            for sid, s in sites.items():
                d = (lat - s["lat"]) ** 2 + (
                    (lon - s["lon"]) * math.cos(math.radians(s["lat"]))
                ) ** 2
                near[sid] = np.unravel_index(int(np.argmin(d)), d.shape)
            geo = (m["LoVInDegrees"], m["Latin1InDegrees"])
            grid_lon = {sid: float(lon[ij]) for sid, ij in near.items()}
            turn_err = {
                sid: turn_error_deg(lat, lon, ij, geo) for sid, ij in near.items()
            }
        vals = m.values
        for sid, ij in near.items():
            x = float(vals[ij])
            if m.shortName == "gh":
                cols[sid]["hgt"][m.level] = x
            else:
                uv.setdefault((sid, m.level), {})[m.shortName] = (
                    x,
                    m["uvRelativeToGrid"],
                )
    for (sid, lev), d in uv.items():
        (u, ru), (v, rv) = d["u"], d["v"]
        if ru != rv:
            raise ValueError(
                f"{grib.name}: u and v disagree on grid-relative at {lev} hPa"
            )
        cols[sid]["u"][lev], cols[sid]["v"][lev] = (
            to_earth(u, v, grid_lon[sid], *geo) if ru else (u, v)
        )
    out = {}
    for sid, c in cols.items():
        levs = sorted(set(c["hgt"]) & set(c["u"]) & set(c["v"]))
        if len(levs) != len(LEVELS_HPA):
            raise ValueError(
                f"{grib.name}: {sid} has {len(levs)} of {len(LEVELS_HPA)} levels"
            )
        out[sid] = {
            "hgt": [c["hgt"][x] for x in levs],
            "u": [c["u"][x] for x in levs],
            "v": [c["v"][x] for x in levs],
            "levels": levs,
            "grid_lon": grid_lon[sid],
            "lov": geo[0],
            "latin": geo[1],
            "turn_error_deg": turn_err[sid],
        }
    return out


def turn_error_deg(lat, lon, ij: tuple[int, int], geo: tuple[float, float]) -> float:
    """How far to_earth's turn of the grid's x axis is from that axis as the grid's own lat/lon draw it at ij
    (the next point along x), in degrees. Exact geometry, no weather in it: the check that the turn is right."""
    j, i = ij
    i2 = i + 1 if i + 1 < lat.shape[1] else i - 1
    sign = 1 if i2 > i else -1
    dlat = sign * (float(lat[j, i2]) - float(lat[j, i]))
    dlon = (
        sign
        * (float(lon[j, i2]) - float(lon[j, i]))
        * math.cos(math.radians(float(lat[j, i])))
    )
    ue, ve = to_earth(1.0, 0.0, float(lon[j, i]), *geo)
    d = math.degrees(math.atan2(ve, ue)) - math.degrees(math.atan2(dlat, dlon))
    return abs((d + 180) % 360 - 180)


def _get(url: str, rng: tuple[int, int | None] | None = None, tries: int = 6) -> bytes:
    for k in range(tries):
        try:
            req = urllib.request.Request(
                url,
                headers={"Range": f"bytes={rng[0]}-{'' if rng[1] is None else rng[1]}"}
                if rng
                else {},
            )
            with urllib.request.urlopen(req, timeout=60) as r:  # nosec B310 - always the https RAP or IEM_RAOB constant + fixed fields
                return r.read()
        except OSError:
            if k == tries - 1:
                raise
            time.sleep(5 * (k + 1))  # WSL DNS drops out for tens of seconds at a time


def fetch_hour(hour: dt.datetime, cache: Path) -> Path:
    """The RAP analysis at `hour`, cut to HGT/UGRD/VGRD at LEVELS_HPA, cached as one GRIB file."""
    f = cache / f"rap_{hour:%Y%m%d%H}.grb2"
    if f.exists():
        return f
    url = f"{RAP}/{rap_key(hour)}"
    ranges = idx_ranges(_get(url + ".idx").decode())
    with cf.ThreadPoolExecutor(8) as ex:
        parts = list(ex.map(lambda r: _get(url, r), ranges))
    tmp = f.with_suffix(".part")
    tmp.write_bytes(b"".join(parts))
    tmp.rename(f)
    return f


# --- one night ---------------------------------------------------------------------------------------


def nearest_hour(t: dt.datetime) -> dt.datetime:
    return (t + dt.timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def night_airspeed(
    profiles: list[tuple[dt.datetime, str]], winds: dict, cutoff: float
) -> dict:
    """The night's airspeed readout from its profiles and {hour: column}. Bins: dens > 0 with u and v, at the bin's
    middle height; weighted by dens. Profiles whose nearest hour has no column, and bins outside the column, are
    counted, not guessed."""
    w = air = ground = effect = below = 0.0
    below_at = {c: 0.0 for c in SENSITIVITY_MS}
    used = no_wind = 0
    dens_all = dens_out = 0.0
    winds_seen = []
    for t, text in profiles:
        col = winds.get(nearest_hour(t))
        bins = parse_profile(text)
        hs = [b["height_m"] for b in bins if b["height_m"] is not None]
        dh = min((b - a for a, b in itertools.pairwise(hs) if b > a), default=200.0)
        good = [
            b
            for b in bins
            if b["dens"]
            and b["dens"] > 0
            and b["u"] is not None
            and b["v"] is not None
            and b["height_m"] is not None
        ]
        if col is None:
            no_wind += 1 if good else 0
            continue
        took = False
        for b in good:
            dens_all += b["dens"]
            wv = wind_at(b["height_m"] + dh / 2, col)
            if wv is None:
                dens_out += b["dens"]
                continue
            a = math.hypot(b["u"] - wv[0], b["v"] - wv[1])
            g = math.hypot(b["u"], b["v"])
            d = b["dens"]
            w += d
            air += d * a
            ground += d * g
            effect += d * abs(a - g)
            below += d if a < cutoff else 0.0
            for c in below_at:
                below_at[c] += d if a < c else 0.0
            winds_seen.append(math.hypot(*wv))
            took = True
        used += took
    out = {
        "profiles": len(profiles),
        "profiles_used": used,
        "profiles_without_wind": no_wind,
        "dens_share_outside_wind": dens_out / dens_all if dens_all else None,
        "airspeed_ms": air / w if w else None,
        "ground_speed_ms": ground / w if w else None,
        "wind_effect_ms": effect / w if w else None,
        "insect_share": below / w if w else None,
        "insect_share_at": {
            str(c): (x / w if w else None) for c, x in below_at.items()
        },
        "wind_ms_range": [min(winds_seen), max(winds_seen)] if winds_seen else None,
    }
    out["verdict"] = verdict(out)
    return out


def verdict(r: dict) -> str | None:
    if not r["profiles"]:
        return None
    if (
        not r["profiles_used"]
        or r["wind_effect_ms"] is None
        or r["wind_effect_ms"] < FIRED_MIN_MS
    ):
        return "void"
    return "insects" if r["insect_share"] >= INSECT_SHARE else "birds"


# --- what the popup may say -----------------------------------------------------------------------------

ASKED = (
    ("KFFC", "2026-10-11"),
    ("KFFC", "2026-10-12"),
    ("KFFC", "2026-10-16"),
    ("KFFC", "2026-10-17"),
    ("KOHX", "2026-10-16"),
)
BIRD_CONTROLS = (("KBUF", "2026-10-16"), ("KBOX", "2026-10-17"))


def popup_table(nights: dict, raob_passes: bool) -> tuple[dict, dict]:
    """The rules' controls, then the popup's line per night: the asked nights and every night that reads insects.
    A night says what it read only when the wind passed the radiosondes and both bird controls read birds; "birds"
    also needs some night to have read insects (else the rule was never seen to catch any). Otherwise "unclear"."""
    get = lambda sid, n: nights.get(sid, {}).get(n) or {}
    insect_nights = sorted(
        (sid, n)
        for sid, ns in nights.items()
        for n, r in ns.items()
        if r.get("verdict") == "insects"
    )
    bird_ok = {f"{sid} {n}": get(sid, n).get("verdict") for sid, n in BIRD_CONTROLS}
    controls = {
        "asked": [f"{sid} {n}" for sid, n in ASKED],
        "raob_passes": raob_passes,
        "bird_controls": bird_ok,
        "bird_controls_pass": all(v == "birds" for v in bird_ok.values()),
        "insect_nights": [f"{sid} {n}" for sid, n in insect_nights],
    }
    trusted = controls["raob_passes"] and controls["bird_controls_pass"]
    table = {}
    for sid, n in sorted(set(ASKED) | set(insect_nights)):
        r = get(sid, n)
        v = r.get("verdict")
        if (
            not trusted
            or v not in ("birds", "insects")
            or (v == "birds" and not insect_nights)
        ):
            v = "unclear"
        table[f"{sid} {n}"] = {
            "verdict": v,
            "airspeed_ms": None
            if r.get("airspeed_ms") is None
            else round(r["airspeed_ms"], 1),
            "insect_share": None
            if r.get("insect_share") is None
            else round(r["insect_share"], 2),
        }
    return controls, table


# --- radiosondes: is the turned wind the real wind? -----------------------------------------------------


def raob_uv(profile: list[dict], pres: float) -> tuple[float, float] | None:
    """(u, v) m/s at a mandatory level from an IEM raob.py profile (drct deg from, sknt kt); None if absent."""
    for r in profile:
        if (
            r.get("pres") == pres
            and r.get("drct") is not None
            and r.get("sknt") is not None
        ):
            s, d = r["sknt"] * 0.514444, math.radians(r["drct"])
            return -s * math.sin(d), -s * math.cos(d)
    return None


def col_at_pressure(col: dict, pres: int) -> tuple[float, float]:
    i = col["levels"].index(pres)
    return col["u"][i], col["v"][i]


def rms(errs: list[float]) -> float | None:
    return math.sqrt(sum(e * e for e in errs) / len(errs)) if errs else None


# --- run ---------------------------------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp-dir", type=Path, required=True)
    ap.add_argument("--first-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument("--last-night", type=dt.date.fromisoformat, required=True)
    ap.add_argument(
        "--cutoff",
        type=float,
        default=CUTOFF_MS,
        help="airspeed (m/s) below which a bin is insect-like",
    )
    ap.add_argument(
        "--raob", required=True, help="site:station pairs, e.g. KFFC:KFFC,KLWX:KIAD"
    )
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    a.cache.mkdir(parents=True, exist_ok=True)
    sites = {
        s["id"]: s
        for s in json.loads((Path(__file__).parent / "sites.json").read_text())
    }
    sids = sorted(p.name for p in a.vp_dir.iterdir() if p.is_dir())
    nights = [
        a.first_night + dt.timedelta(days=d)
        for d in range((a.last_night - a.first_night).days + 1)
    ]
    windows = {
        (sid, n): night_window(n, sites[sid]["lon"], sites[sid]["lat"])
        for sid in sids
        for n in nights
    }
    hours = sorted(
        {
            nearest_hour(s) + dt.timedelta(hours=k)
            for s, r in windows.values()
            for k in range(
                int((nearest_hour(r) - nearest_hour(s)).total_seconds() // 3600) + 1
            )
        }
    )
    with cf.ThreadPoolExecutor(
        4
    ) as ex:  # S3 latency, not bandwidth, sets the pace: hours in parallel
        for k, _ in enumerate(ex.map(lambda h: fetch_hour(h, a.cache), hours)):
            if k % 24 == 0:
                print(f"fetched {k + 1}/{len(hours)}", flush=True)
    winds = {
        h: columns(fetch_hour(h, a.cache), {sid: sites[sid] for sid in sids})
        for h in hours
    }
    result = {}
    for sid in sids:
        for n in nights:
            sunset, sunrise = windows[(sid, n)]
            profs = stored_profiles(a.vp_dir, sid, sunset, sunrise)
            r = night_airspeed(profs, {h: c[sid] for h, c in winds.items()}, a.cutoff)
            r["mt_birds_km"] = (
                night_total(profs, sunset, sunrise)["mt_birds_km"] if profs else None
            )  # the count it is about
            result.setdefault(sid, {})[n.isoformat()] = r
    # radiosondes at 00Z and 12Z inside the run, against the turned and the unturned RAP wind
    raob = {"stations": {}, "rms_ms": {}}
    errs = {"turned": [], "unturned": [], "turned_backwards": []}
    for pair in a.raob.split(","):
        sid, stn = pair.split(":")
        raob["stations"][sid] = stn
        for h in hours:
            if h.hour not in (0, 12):
                continue
            cache = a.cache / f"raob_{stn}_{h:%Y%m%d%H}.json"
            if not cache.exists():
                cache.write_bytes(_get(f"{IEM_RAOB}?ts={h:%Y%m%d%H%M}&station={stn}"))
                time.sleep(2)
            profs = json.loads(cache.read_text()).get("profiles") or []
            if not profs:
                continue
            col = winds[h][sid]
            turn = (
                col["grid_lon"],
                col["lov"],
                -col["latin"],
            )  # -latin turns the other way
            for p in RAOB_LEVELS_HPA:
                obs = raob_uv(profs[0]["profile"], float(p))
                if obs is None:
                    continue
                ue, ve = col_at_pressure(col, p)
                # undo the turn to get RAP's own grid-relative numbers, then turn the wrong way
                ug, vg = to_earth(ue, ve, *turn)
                ub, vb = to_earth(ug, vg, *turn)
                errs["turned"].append(math.hypot(ue - obs[0], ve - obs[1]))
                errs["unturned"].append(math.hypot(ug - obs[0], vg - obs[1]))
                errs["turned_backwards"].append(math.hypot(ub - obs[0], vb - obs[1]))
    raob["rms_ms"] = {k: rms(v) for k, v in errs.items()}
    raob["levels_compared"] = len(errs["turned"])
    raob["passes"] = (
        raob["levels_compared"] >= 30
        and raob["rms_ms"]["turned"] is not None
        and raob["rms_ms"]["turned"] <= RAOB_MAX_RMS_MS
    )
    turn = max(c["turn_error_deg"] for cols in winds.values() for c in cols.values())
    if turn > TURN_MAX_DEG:
        raise ValueError(
            f"RAP wind turn is off by {turn:.3f} deg (limit {TURN_MAX_DEG}): earth-relative wind is wrong"
        )
    doc = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "rules": {
            "cutoff_ms": a.cutoff,
            "insect_share": INSECT_SHARE,
            "fired_min_ms": FIRED_MIN_MS,
            "levels_hpa": [LEVELS_HPA[0], LEVELS_HPA[-1]],
            "raob_max_rms_ms": RAOB_MAX_RMS_MS,
        },
        "first_night": a.first_night.isoformat(),
        "last_night": a.last_night.isoformat(),
        "hours": len(hours),
        "raob": raob,
        "turn_error_deg_max": turn,
    }
    doc["controls"], doc["popup"] = popup_table(result, raob["passes"])
    doc["nights"] = result
    a.out.write_text(json.dumps(doc, indent=1) + "\n")
    print(
        json.dumps(
            {k: doc[k] for k in ("raob", "turn_error_deg_max", "controls", "popup")},
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
