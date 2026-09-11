"""Config-driven raster drapes: fetch a data-only PNG (ERDDAP transparentPng), post-process,
write public/data/rasters/<id>.png and public/data/rasters.json."""
from __future__ import annotations
import argparse, datetime as dt, io, json, logging, time, urllib.request
from collections import Counter
from pathlib import Path
import numpy as np
from PIL import Image
from .atomic import write_atomic

log = logging.getLogger("raster")
HERE = Path(__file__).parent

def mode_color_to_alpha(rgba: np.ndarray) -> np.ndarray:
    """Make the most frequent OPAQUE colour transparent (e.g. bleaching level 0 over open ocean)."""
    out = rgba.copy()
    opaque = out[..., 3] > 0
    if not opaque.any():
        return out
    cols = [tuple(c) for c in out[opaque][:, :3].reshape(-1, 3)]
    mode = Counter(cols).most_common(1)[0][0]
    hit = opaque & np.all(out[..., :3] == np.array(mode, np.uint8), axis=-1)
    out[hit, 3] = 0
    return out

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

def process(product: dict, out_dir: Path) -> dict:
    rgba = fetch_png(product["url"])
    if product.get("transparent") == "mode_color":
        rgba = mode_color_to_alpha(rgba)
    png = out_dir / f"{product['id']}.png"
    png.parent.mkdir(parents=True, exist_ok=True)
    tmp = png.with_suffix(".tmp.png")
    Image.fromarray(rgba, "RGBA").save(tmp, optimize=True)
    tmp.replace(png)
    return {k: product[k] for k in ("id", "name", "icon", "bounds", "legend", "credit", "credit_key")} | {
        "png": f"data/rasters/{product['id']}.png", "time": fetch_time(product.get("time_url")),
        "width": int(rgba.shape[1]), "height": int(rgba.shape[0])}

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
