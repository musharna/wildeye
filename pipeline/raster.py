"""Config-driven raster drapes: fetch a data-only PNG (ERDDAP transparentPng), post-process,
write public/data/rasters/<id>.png and public/data/rasters.json."""
from __future__ import annotations
import argparse, datetime as dt, io, json, logging, re, time, urllib.request
from pathlib import Path
import numpy as np
from PIL import Image
from .atomic import write_atomic

log = logging.getLogger("raster")
HERE = Path(__file__).parent

class PaletteChanged(RuntimeError):
    """The pinned no-data colour is absent from a rendered image: ERDDAP's palette moved."""


def color_to_alpha(rgba: np.ndarray, rgb, tolerance: int = 0) -> tuple[np.ndarray, float]:
    """Make ONE explicit colour transparent (the pinned 'no data / class 0' swatch).
    Returns (image, fraction of opaque pixels masked). Raises PaletteChanged when the
    pinned colour does not occur at all in a non-empty image — a most-frequent-colour
    heuristic would have silently hidden a real class instead (panel audit 2026-09-11)."""
    out = rgba.copy()
    opaque = out[..., 3] > 0
    if not opaque.any():
        return out, 0.0
    diff = np.abs(out[..., :3].astype(np.int16) - np.array(rgb, np.int16)).max(axis=-1)
    hit = opaque & (diff <= tolerance)
    n = int(hit.sum())
    if n == 0:
        raise PaletteChanged(f"pinned colour {tuple(rgb)} not present; palette changed?")
    out[hit, 3] = 0
    return out, n / int(opaque.sum())

UA = {"User-Agent": "wildeye/0.1 (raster sync; +https://github.com/musharna)"}

def _open(url: str, timeout: int):
    # coastwatch.noaa.gov (ERDDAP redirect target) returns 403 to the default Python-urllib agent
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)

def fetch_png(url: str, timeout: int = 180) -> np.ndarray:
    with _open(url, timeout) as r:
        data = r.read()
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"))

def fetch_time(url: str | None) -> str | None:
    if not url:
        return None
    with _open(url, 60) as r:
        d = json.load(r)
    return d["table"]["rows"][0][0]

def resolve_source(product: dict, catalog_xml: str | None = None) -> tuple[str, str | None]:
    """(url, time) for a product. Static products return (url, None → fetch_time later).
    Products with `catalog` pick the newest file matching `file_regex` from a THREDDS
    catalog.xml, fill `url_template` with {file}, and read the acquisition date from the
    filename via `time_regex` (a date-stamped daily file, e.g. NOAA NDVI CDR on NCEI)."""
    if "catalog" not in product:
        return product["url"], None
    if catalog_xml is None:
        with _open(product["catalog"], 60) as r:
            catalog_xml = r.read().decode("utf-8", "replace")
    files = sorted(set(re.findall(product["file_regex"], catalog_xml)))
    if not files:
        raise RuntimeError(f"{product['id']}: no file matching {product['file_regex']!r} in {product['catalog']}")
    f = files[-1]
    m = re.search(product["time_regex"], f)
    when = f"{m.group(1)}-{m.group(2)}-{m.group(3)}T00:00:00Z" if m else None
    return product["url_template"].format(file=f), when


def process(product: dict, out_dir: Path) -> dict:
    url, when_from_name = resolve_source(product)
    rgba = fetch_png(url)
    masked = 0.0
    t = product.get("transparent", "none")
    if isinstance(t, dict) and "rgb" in t:
        rgba, masked = color_to_alpha(rgba, t["rgb"], int(t.get("tolerance", 0)))
        log.info("%s masked %.1f%% of opaque pixels as %s", product["id"], 100 * masked, t["rgb"])
    elif t != "none":
        raise ValueError(f"{product['id']}: transparent must be 'none' or {{'rgb': [r,g,b]}}, got {t!r}")
    when = when_from_name or fetch_time(product.get("time_url"))
    png = out_dir / f"{product['id']}.png"
    png.parent.mkdir(parents=True, exist_ok=True)
    tmp = png.with_suffix(".tmp.png")
    Image.fromarray(rgba, "RGBA").save(tmp, optimize=True)
    tmp.replace(png)
    history = archive_frame(png, product["id"], when, out_dir, int(product.get("keep_days", KEEP_DAYS)))
    keep = ("id", "name", "icon", "bounds", "legend", "credit", "credit_key", "classes", "ramp", "kind", "zrank")
    return {k: product[k] for k in keep if k in product} | {
        "png": f"data/rasters/{product['id']}.png", "time": when,
        "width": int(rgba.shape[1]), "height": int(rgba.shape[0]), "masked_fraction": round(masked, 4),
        "history": history}


KEEP_DAYS = 30


def _stamp(when: str | None) -> str:
    return (when or dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")).replace(":", "").replace("-", "")


def archive_frame(latest_png: Path, pid: str, when: str | None, out_dir: Path, keep_days: int) -> list[dict]:
    """Copy the latest image into rasters/<id>/<stamp>.png (skipped when that acquisition
    is already archived), prune frames older than keep_days, and return the sorted history
    [{time, png}] — the time dimension a replay slider needs (panel audit 2026-09-11)."""
    d = out_dir / pid
    d.mkdir(parents=True, exist_ok=True)
    frame = d / f"{_stamp(when)}.png"
    if not frame.exists():
        tmp = frame.with_suffix(".tmp.png")
        tmp.write_bytes(latest_png.read_bytes())
        tmp.replace(frame)
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=keep_days)
    hist = []
    for f in sorted(d.glob("*.png")):
        stamp = f.stem
        try:
            t = dt.datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.UTC)
        except ValueError:
            continue
        if t < cutoff:
            f.unlink()
            continue
        hist.append({"time": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "png": f"data/rasters/{pid}/{f.name}"})
    return hist

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data"))
    ap.add_argument("--only", default=None, help="comma-separated product ids")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    products = json.loads((HERE / "rasters.json").read_text())
    if a.only:
        keep = set(a.only.split(",")); products = [p for p in products if p["id"] in keep]
    manifest_path = a.out / "rasters.json"
    prev = {e["id"]: e for e in (json.loads(manifest_path.read_text()) if manifest_path.exists() else {"products": []})["products"]}
    # products not selected this run keep their previous manifest entry untouched
    entries = {k: v for k, v in prev.items() if k not in {p["id"] for p in products}}
    failures = {}
    for p in products:
        t0 = time.time()
        try:
            entries[p["id"]] = process(p, a.out / "rasters")
            log.info("%s ok time=%s %.0fs", p["id"], entries[p["id"]]["time"], time.time() - t0)
        except Exception as e:
            failures[p["id"]] = repr(e); log.error("%s FAILED: %r", p["id"], e)
            if p["id"] in prev:
                entries[p["id"]] = prev[p["id"]] | {"stale": True}
    write_atomic(manifest_path, {"generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                 "failures": failures, "products": [entries[k] for k in sorted(entries)]})
    if failures and len(failures) == len(products):
        raise SystemExit(f"every selected raster failed: {failures}")

if __name__ == "__main__":
    main()
