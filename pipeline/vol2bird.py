"""Run vol2bird (Docker) and reduce its vertical profile to one record."""
from __future__ import annotations
import math, subprocess
from pathlib import Path

IMAGE = "adokter/vol2bird"
MAX_HEIGHT_M = 3000

def run_vol2bird(volume: Path, timeout_s: int = 300) -> str:
    cmd = ["docker", "run", "--rm", "-v", f"{volume.parent}:/data", IMAGE,
           "vol2bird", f"/data/{volume.name}"]
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
        })
    rows.sort(key=lambda b: b["height_m"] if b["height_m"] is not None else 1e9)
    return rows

def reduce_profile(bins: list[dict]) -> dict:
    use = [b for b in bins if b.get("height_m") is not None and b["height_m"] <= MAX_HEIGHT_M
           and b.get("dens") is not None]
    out = {"bins": len(bins), "density_birds_km3": None, "heading_deg": None,
           "speed_ms": None, "peak_altitude_m": None}
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
    ws = [(b["dens"], b["ff"]) for b in use if b.get("ff") is not None and b["dens"] > 0]
    if ws:
        tot = sum(d for d, _ in ws)
        out["speed_ms"] = sum(d * f for d, f in ws) / tot if tot else None
    return out
