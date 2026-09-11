"""Build public/data/birds.geojson from the newest NEXRAD volume per site."""
from __future__ import annotations
import argparse, datetime as dt, json, logging, os, re, tempfile, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .nexrad import latest_volume_key, download_volume
from .vol2bird import run_vol2bird, parse_profile, reduce_profile
from .ppi import ppi_for_volume
from .field import composite, write_field_png

log = logging.getLogger("birds")
HERE = Path(__file__).parent
SITES = json.loads((HERE / "sites.json").read_text())
_TS = re.compile(r"(\d{8})_(\d{6})")

def scan_time_from_key(key: str) -> str:
    m = _TS.search(key)
    if not m:
        raise ValueError(f"no timestamp in key {key}")
    d, t = m.groups()
    return f"{d[:4]}-{d[4:6]}-{d[6:]}T{t[:2]}:{t[2:4]}:{t[4:]}Z"

def build_feature(site: dict, record: dict, scan_key: str) -> dict:
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [site["lon"], site["lat"]]},
            "properties": {"site": site["id"], "name": site["name"],
                           "scan_time": scan_time_from_key(scan_key), "stale": False, **record}}

def merge_last_good(new: dict[str, dict], previous_geojson: dict | None) -> list[dict]:
    out = dict(new)
    for f in (previous_geojson or {}).get("features", []):
        sid = f["properties"]["site"]
        if sid not in out:
            g = json.loads(json.dumps(f))
            g["properties"]["stale"] = True
            out[sid] = g
    return [out[k] for k in sorted(out)]

def write_atomic(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    os.replace(tmp, path)

def process_site(site: dict, workdir: Path, ppi_dir: Path) -> tuple[dict, dict]:
    """Returns (feature, ppi_meta). ppi_meta = {png, bounds, grid}."""
    key = latest_volume_key(site["id"])
    if not key:
        raise RuntimeError(f"{site['id']}: no volume found for today/yesterday")
    vol = download_volume(key, workdir / site["id"])
    rec = reduce_profile(parse_profile(run_vol2bird(vol)))
    grid, bounds = ppi_for_volume(vol, ppi_dir / f"{site['id']}.png")
    return build_feature(site, rec, key), {"png": f"data/birds_ppi/{site['id']}.png", "bounds": bounds, "grid": grid}

def site_entry(feature: dict, meta: dict | None) -> dict:
    p = feature["properties"]
    e = {k: p.get(k) for k in ("site", "name", "u_ms", "v_ms", "speed_ms", "heading_deg",
                               "density_birds_km3", "peak_altitude_m", "scan_time", "stale")}
    e["lon"], e["lat"] = feature["geometry"]["coordinates"]
    e["png"] = meta["png"] if meta else None
    e["bounds"] = meta["bounds"] if meta else None
    return e

def load_grid(png_path: Path):
    """Re-read a last-good PPI PNG's alpha-weighted intensity as a uint8 grid."""
    from PIL import Image
    import numpy as np
    from .ppi import DBZ_MIN  # noqa: F401  (documenting the byte mapping lives there)
    im = np.asarray(Image.open(png_path).convert("RGBA"))
    a = im[..., 3].astype(int)
    return np.clip(a - 60, 0, 255).astype("uint8")  # inverse of colorize alpha = 60 + byte

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--workdir", type=Path,
                    default=Path(os.environ.get("WILDEYE_WORK", "/tmp/wildeye-nexrad")))
    ap.add_argument("--sites", type=int, default=None, help="limit to first N sites")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sites = SITES[: a.sites] if a.sites else SITES
    prev = json.loads(a.out.read_text()) if a.out.exists() else None
    ppi_dir = a.out.parent / "birds_ppi"
    field_json = a.out.parent / "birds_field.json"
    prev_field = json.loads(field_json.read_text()) if field_json.exists() else None
    prev_meta = {e["site"]: e for e in (prev_field or {}).get("sites", []) if e.get("png")}
    metas = {}
    t0 = time.time()
    new, failures = {}, {}
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process_site, s, a.workdir, ppi_dir): s for s in sites}
        for fut in as_completed(futs):
            s = futs[fut]
            try:
                new[s["id"]], metas[s["id"]] = fut.result()
                log.info("%s ok dens=%s", s["id"], new[s["id"]]["properties"]["density_birds_km3"])
            except Exception as e:  # logged loud; last-good keeps the site
                failures[s["id"]] = repr(e)
                log.error("%s FAILED: %r", s["id"], e)
    fc = {"type": "FeatureCollection",
          "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
          "site_count": len(sites), "fresh_count": len(new), "failures": failures,
          "features": merge_last_good(new, prev)}
    write_atomic(a.out, fc)
    # Field: per-site entries (last-good png/bounds for failed sites) + composite grid.
    entries, items = [], []
    for f in fc["features"]:
        sid = f["properties"]["site"]
        meta = metas.get(sid)
        if meta is None and sid in prev_meta and (a.out.parent / prev_meta[sid]["png"].removeprefix("data/")).exists():
            pm = prev_meta[sid]
            meta = {"png": pm["png"], "bounds": pm["bounds"],
                    "grid": load_grid(a.out.parent / pm["png"].removeprefix("data/"))}
        entries.append(site_entry(f, meta))
        if meta is not None:
            items.append((meta["grid"], meta["bounds"]))
    if items:
        grid, bounds = composite(items)
        write_field_png(grid, a.out.parent / "birds_field.png")
        write_atomic(field_json, {"generated_at": fc["generated_at"], "bounds": bounds,
                                  "width": int(grid.shape[1]), "height": int(grid.shape[0]),
                                  "png": "data/birds_field.png", "sites": entries})
        log.info("wrote %s %dx%d from %d sites", field_json, grid.shape[1], grid.shape[0], len(items))
    log.info("wrote %s fresh=%d stale=%d wall=%.0fs", a.out, len(new),
             len(fc["features"]) - len(new), time.time() - t0)
    if not new:
        raise SystemExit("every site failed")

if __name__ == "__main__":
    main()
