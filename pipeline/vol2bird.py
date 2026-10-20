"""Run vol2bird (Docker), reduce its vertical profile to one record, and integrate it
the way bioRad does (integrate_profile: vid, mtr, cumulative mt)."""
from __future__ import annotations
import contextlib, datetime as dt, gzip, math, os, re, shutil, subprocess, tempfile
from pathlib import Path

# pinned by digest so the nightly numbers cannot change under a silent `latest` pull; this is vol2bird
# 0.5.0.9169 (image built 2021-02-05), the build every stored profile and docs/analysis result came from.
IMAGE = "adokter/vol2bird@sha256:fdead127f0271358c18ca73d99a41faa5d61ae6dfe988629831b705f49e47e95"
MAX_HEIGHT_M = 3000

_OPT_KEY, _OPT_VALUE = re.compile(r"[A-Z][A-Z0-9_]*"), re.compile(r"[A-Za-z0-9_.+-]+")

def run_vol2bird(volume: Path, timeout_s: int = 300, options: dict[str, str] | None = None) -> str:
    """vol2bird on one volume. options (e.g. AZIMMIN) go in an options.conf in a fresh directory mounted
    as vol2bird's working directory, where it looks for one; None runs vol2bird's defaults."""
    for k, val in (options or {}).items():
        if not (_OPT_KEY.fullmatch(k) and _OPT_VALUE.fullmatch(str(val))):
            raise ValueError(f"bad vol2bird option {k!r} = {val!r}")
    with tempfile.TemporaryDirectory() if options else contextlib.nullcontext() as conf_dir:
        cmd = ["docker", "run", "--rm", "-v", f"{volume.parent}:/data"]
        if options:
            Path(conf_dir, "options.conf").write_text("".join(f"{k} = {val}\n" for k, val in options.items()))
            cmd += ["-v", f"{conf_dir}:/conf", "-w", "/conf"]
        cmd += [IMAGE, "vol2bird", f"/data/{volume.name}"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if p.returncode != 0:
        raise RuntimeError(f"vol2bird failed rc={p.returncode} on {volume.name}: {p.stderr[-2000:]}")
    return p.stdout

def _f(tok):
    try:
        v = float(tok)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v

def parse_profile(text: str) -> list[dict]:
    header, rows = None, []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            toks = s.lstrip("#").split()
            if "HGHT" in toks:
                header = toks
            continue
        if header is None:
            continue
        toks = s.split()
        if len(toks) < len(header):
            continue
        col = dict(zip(header, toks))
        rows.append({
            "height_m": _f(col["HGHT"]),
            "u": _f(col.get("u")), "v": _f(col.get("v")),
            "ff": _f(col.get("ff")), "dd": _f(col.get("dd")),
            "dens": _f(col.get("dens")), "dbz": _f(col.get("dbz")),
            "eta": _f(col.get("eta")),
            "sd_vvp": _f(col.get("sd_vvp")), "gap": {"T": True, "F": False}.get(col.get("gap")),
            "n_dbz": _f(col.get("n_dbz")), "n_dbz_all": _f(col.get("n_dbz_all")),
        })
    rows.sort(key=lambda b: b["height_m"] if b["height_m"] is not None else 1e9)
    return rows

def reduce_profile(bins: list[dict]) -> dict:
    use = [b for b in bins if b.get("height_m") is not None and b["height_m"] <= MAX_HEIGHT_M
           and b.get("dens") is not None]
    out = {"bins": len(bins), "density_birds_km3": None, "heading_deg": None,
           "speed_ms": None, "peak_altitude_m": None, "u_ms": None, "v_ms": None}
    if not use:
        return out
    dens = [b["dens"] for b in use]
    out["density_birds_km3"] = sum(dens) / len(dens)
    out["peak_altitude_m"] = max(use, key=lambda b: b["dens"])["height_m"]
    w = [(b["dens"], b) for b in use if b.get("dd") is not None and b["dens"] > 0]
    if w:
        sx = sum(d * math.sin(math.radians(b["dd"])) for d, b in w)
        sy = sum(d * math.cos(math.radians(b["dd"])) for d, b in w)
        out["heading_deg"] = math.degrees(math.atan2(sx, sy)) % 360
    uv = [(b["dens"], b["u"], b["v"]) for b in use
          if b.get("u") is not None and b.get("v") is not None and b["dens"] > 0]
    if uv:
        tot = sum(d for d, _, _ in uv)
        if tot:
            out["u_ms"] = sum(d * u for d, u, _ in uv) / tot
            out["v_ms"] = sum(d * v for d, _, v in uv) / tot
    ws = [(b["dens"], b["ff"]) for b in use if b.get("ff") is not None and b["dens"] > 0]
    if ws:
        tot = sum(d for d, _ in ws)
        out["speed_ms"] = sum(d * f for d, f in ws) / tot if tot else None
    return out

def profile_time(text: str) -> dt.datetime:
    """The profile's time as vol2bird prints it (date, HHMM; UTC), which is what bioRad reads."""
    stamps = {tuple(s.split()[:2]) for s in (line.strip() for line in text.splitlines())
              if s and not s.startswith("#")}
    if not stamps:
        raise ValueError("no profile rows in vol2bird output")
    if len(stamps) > 1:
        raise ValueError(f"more than one profile time in one vol2bird output: {sorted(stamps)}")
    (day, hhmm), = stamps
    return dt.datetime.strptime(day + hhmm.zfill(4), "%Y%m%d%H%M").replace(tzinfo=dt.UTC)

def bin_interval(heights: list[float]) -> float:
    """The one height step of a profile's bins (m): bioRad assumes a single interval. Raises on fewer than
    two bins, uneven steps, or duplicate heights (step 0)."""
    hs = sorted(heights)
    if len(hs) < 2:
        raise ValueError(f"need at least two height bins to know the interval, got {len(hs)}")
    steps = {round(b - a, 6) for a, b in zip(hs, hs[1:])}
    if len(steps) != 1:
        raise ValueError(f"uneven height bins (steps {sorted(steps)} m); need one interval")
    interval, = steps
    if interval <= 0:
        raise ValueError(f"duplicate height bins (step {interval} m)")
    return interval

def integrate_profile(bins: list[dict], alt_min_m: float = 0.0, alt_max_m: float = math.inf) -> dict:
    """bioRad integrate_profile for one vp, defaults included (heights are bin bottoms, m ASL).
    vid (birds/km2) = sum dens*dh; mtr (birds/km/h) = sum dens*ff*3.6*dh. A bin with dens but no
    ff (vol2bird gap) counts in vid and drops out of mtr, as bioRad's na.rm does; speedless_share
    is the part of vid that mtr cannot see."""
    if all(b.get("dens") is None for b in bins):
        return {"vid_birds_km2": None, "mtr_birds_km_h": None, "speedless_share": None}
    interval = bin_interval([b["height_m"] for b in bins])
    vid = mtr = speedless = 0.0
    for b in bins:
        if b.get("dens") is None:
            continue
        h = b["height_m"]
        dh = min(min(max(h + interval - alt_min_m, 0), interval), min(max(alt_max_m - h, 0), interval)) / 1000
        vid += b["dens"] * dh
        if b.get("ff") is None:
            speedless += b["dens"] * dh
        else:
            mtr += b["dens"] * b["ff"] * 3.6 * dh
    return {"vid_birds_km2": vid, "mtr_birds_km_h": mtr,
            "speedless_share": speedless / vid if vid > 0 else None}

def height_quantile(heights: list[float], weights: list[float | None], q: float) -> float | None:
    """bioRad integrate_profile(height_quantile = q): the height (m ASL) below which a share q of the
    weight lies, linear within the bin it falls in. heights are the bin bottoms in order and weights
    the bins' dens (None as 0; bioRad's dens*dh has one dh, which cancels), so the interpolation runs from a
    bin's bottom to the next bin's bottom,
    and bioRad's NaN (q exactly at the top of the last bin) is 0. None when there is no weight."""
    w = [x or 0.0 for x in weights]
    total = sum(w)
    if total <= 0:
        return None
    cum, c = [], 0.0
    for x in w:
        c += x / total
        cum.append(c)
    n = len(cum)
    idx = sum(1 for c in cum if c <= q)   # R findInterval on a non-decreasing vector
    lower, upper = heights[min(idx, n - 1)], heights[min(idx + 1, n - 1)]
    q_lower = 0.0 if idx == 0 else cum[idx - 1]
    q_upper = cum[min(idx, n - 1)]
    if q_upper == q_lower:   # only past the last bin (lower == upper), where bioRad's 0/0 becomes 0
        return lower
    return lower + (q - q_lower) * (upper - lower) / (q_upper - q_lower)

def _height_weights(bins: list[dict]) -> tuple[list[float], list[float]]:
    hs = [b["height_m"] for b in bins]
    bin_interval(hs)   # the checks integrate_profile makes, duplicate heights included
    return hs, [b["dens"] or 0.0 for b in bins]

def profile_height_quantile(bins: list[dict], q: float) -> float | None:
    """One profile's flight-height quantile, as bioRad's integrate_profile(height_quantile = q)."""
    return height_quantile(*_height_weights(bins), q)

def pooled_height_quantiles(profiles: list[list[dict]], hours: list[float],
                            qs: tuple[float, ...] = (0.25, 0.5, 0.75)) -> list[float] | None:
    """Where a night's birds flew: the quantiles of every profile's density pooled, each weighted by
    the hours it stands for (profile_hours), so one profile alone gives bioRad's own quantiles."""
    if len(profiles) != len(hours):
        raise ValueError(f"{len(profiles)} profiles for {len(hours)} durations")
    grids = [_height_weights(bins) for bins in profiles]
    if not grids:
        return None
    hs = grids[0][0]
    if any(g[0] != hs for g in grids):
        raise ValueError("profiles of one night have different height bins")
    pooled = [sum(h * g[1][i] for h, g in zip(hours, grids)) for i in range(len(hs))]
    if sum(pooled) <= 0:
        return None
    return [height_quantile(hs, pooled, q) for q in qs]

def bio_gate_share(bins: list[dict]) -> float | None:
    """Share of the profile's reflective gates vol2bird kept as biological, sum n_dbz / sum n_dbz_all.
    Its dual-pol rain filter and clutter screen drop the rest, so a rain-filled volume reads near 0 and
    its dens rests on the few gates left. None when no gate had reflectivity."""
    if any(b.get("n_dbz") is None or b.get("n_dbz_all") is None for b in bins):
        raise ValueError("no n_dbz / n_dbz_all gate counts in this vol2bird output")
    kept, total = sum(b["n_dbz"] for b in bins), sum(b["n_dbz_all"] for b in bins)
    return kept / total if total else None

def migration_traffic(times: list[dt.datetime], mtr: list[float], interval_max_s: float = 3600.0) -> list[float]:
    """bioRad integrate_profile.vpts mt (birds/km), cumulative from the first profile: each profile
    stands for half the step on either side, capped at the mean of the steps shorter than
    interval_max_s, so a hole in the series adds no traffic."""
    if len(times) != len(mtr):
        raise ValueError(f"{len(times)} times for {len(mtr)} migration traffic rates")
    missing = [i for i, m in enumerate(mtr) if m is None]
    if missing:
        raise ValueError(f"no migration traffic rate for profiles {missing}")
    out, cum = [], 0.0
    for h, m in zip(profile_hours(times, interval_max_s), mtr):
        cum += h * m
        out.append(cum)
    return out

def profile_hours(times: list[dt.datetime], interval_max_s: float = 3600.0) -> list[float]:
    """Hours each profile stands for in bioRad's time integration: half the step on either side
    (none past the ends), capped at the mean of the steps shorter than interval_max_s."""
    steps = [(b - a).total_seconds() for a, b in zip(times, times[1:])]
    if any(s <= 0 for s in steps):
        raise ValueError("profile times must be strictly increasing")
    short = [s for s in steps if s < interval_max_s]
    replace = sum(short) / len(short) if short else interval_max_s
    return [min(replace, (before + after) / 2) / 3600 for before, after in zip([0.0] + steps, steps + [0.0])]

_SCAN = re.compile(r"(\d{8})_\d{6}")

def profile_path(site: str, key: str, root: Path) -> Path:
    name = Path(key).name
    m = _SCAN.search(name)
    if not m:
        raise ValueError(f"no scan time in key {key}")
    return root / site / m.group(1) / f"{name}.txt.gz"

def save_profile(text: str, site: str, key: str, root: Path) -> Path:
    """Keep one scan's raw vol2bird output as root/SITE/YYYYMMDD/<volume>.txt.gz (UTC day of the scan),
    the input bioRad's read_stdout takes. A scan already stored is left as first written."""
    dest = profile_path(site, key, root)
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, suffix=".tmp")
    with os.fdopen(fd, "wb") as fh:
        fh.write(gzip.compress(text.encode(), mtime=0))
    os.replace(tmp, dest)
    return dest

def prune_profiles(root: Path, keep_days: int, today: dt.date | None = None) -> list[Path]:
    """Delete stored day directories older than keep_days. Anything else in the store is an error."""
    cutoff = (today or dt.datetime.now(dt.UTC).date()) - dt.timedelta(days=keep_days)
    removed = []
    for day_dir in sorted(root.glob("*/*")):
        day = dt.datetime.strptime(day_dir.name, "%Y%m%d").date()
        if day < cutoff:
            shutil.rmtree(day_dir)
            removed.append(day_dir)
    return removed
