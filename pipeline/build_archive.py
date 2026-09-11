"""Backfill hourly replay frames from the NEXRAD archive.

Frame = one UTC hour: public/data/birds_archive/YYYY/MM/DD/HH/{birds.geojson, field.png, field.json}
plus a top-level manifest.json. Resumable (existing frames skipped). No last-good carry:
a site that fails for an hour is simply absent from that frame and listed in failures.
"""
from __future__ import annotations
import argparse, datetime as dt, json, logging, os, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .build_birds import SITES, process_site, site_entry, write_atomic
from .field import composite, write_field_png
from .ppi import write_ppi_png
from .nexrad import volume_key_at

log = logging.getLogger("archive")

def frame_dir(root: Path, t: dt.datetime) -> Path:
    return root / f"{t:%Y/%m/%d/%H}"

def frame_id(t: dt.datetime) -> str:
    return f"{t:%Y-%m-%dT%H}"

def build_frame(t: dt.datetime, sites: list[dict], root: Path, workdir: Path, workers: int, tol_min: int) -> dict:
    out = frame_dir(root, t)
    if (out / "field.json").exists():
        return json.loads((out / "field.json").read_text()) | {"skipped": True}
    tol = dt.timedelta(minutes=tol_min)
    feats, metas, failures = {}, {}, {}
    def one(site):
        key = volume_key_at(site["id"], t, tol)
        if not key:
            raise RuntimeError(f"no scan within {tol_min} min of {t:%Y-%m-%dT%H:%MZ}")
        return process_site(site, workdir, None, key=key)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(one, s): s for s in sites}
        for fut in as_completed(futs):
            s = futs[fut]
            try:
                feats[s["id"]], metas[s["id"]] = fut.result()
            except Exception as e:
                failures[s["id"]] = repr(e)
                log.error("%s %s FAILED: %r", frame_id(t), s["id"], e)
    fc = {"type": "FeatureCollection", "frame": frame_id(t), "site_count": len(sites),
          "fresh_count": len(feats), "failures": failures,
          "features": [feats[k] for k in sorted(feats)]}
    fj = {"frame": frame_id(t), "site_count": len(sites), "fresh_count": len(feats), "failures": failures,
          "sites": [site_entry(feats[k], None) for k in sorted(feats)]}
    if metas:
        grid, bounds = composite([(m["grid"], m["bounds"]) for m in metas.values()])
        write_field_png(grid, out / "field.png")
        write_ppi_png(grid, out / "drape.png")  # colourised composite for the single replay drape
        fj |= {"bounds": bounds, "width": int(grid.shape[1]), "height": int(grid.shape[0]),
               "png": f"data/birds_archive/{t:%Y/%m/%d/%H}/field.png",
               "drape": f"data/birds_archive/{t:%Y/%m/%d/%H}/drape.png"}
    write_atomic(out / "birds.geojson", fc)
    write_atomic(out / "field.json", fj)
    return fj

def hours(start: dt.datetime, end: dt.datetime, utc_hours: set[int]):
    t = start.replace(minute=0, second=0, microsecond=0)
    while t <= end:
        if t.hour in utc_hours:
            yield t
        t += dt.timedelta(hours=1)

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="UTC, e.g. 2026-09-01")
    ap.add_argument("--end", required=True, help="UTC inclusive, e.g. 2026-09-10")
    ap.add_argument("--hours", default="0-12", help="UTC hour range, e.g. 0-12 (nights in the eastern US)")
    ap.add_argument("--sites", type=int, default=None)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--tolerance-min", type=int, default=20)
    ap.add_argument("--out", type=Path, default=Path("public/data/birds_archive"))
    ap.add_argument("--workdir", type=Path, default=Path(os.environ.get("WILDEYE_WORK", "/tmp/wildeye-nexrad-archive")))
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    h0, h1 = (int(x) for x in a.hours.split("-"))
    utc_hours = set(range(h0, h1 + 1))
    start = dt.datetime.fromisoformat(a.start).replace(tzinfo=dt.UTC)
    end = dt.datetime.fromisoformat(a.end).replace(tzinfo=dt.UTC) + dt.timedelta(hours=23)
    sites = SITES[: a.sites] if a.sites else SITES
    manifest_path = a.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"frames": {}}
    t0 = time.time(); n = 0
    for t in hours(start, end, utc_hours):
        ft = time.time()
        fj = build_frame(t, sites, a.out, a.workdir, a.workers, a.tolerance_min)
        manifest["frames"][frame_id(t)] = {"fresh": fj["fresh_count"], "sites": fj["site_count"],
                                            "png": fj.get("png"), "drape": fj.get("drape"), "bounds": fj.get("bounds"),
                                            "dir": f"data/birds_archive/{t:%Y/%m/%d/%H}"}
        manifest["generated_at"] = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        manifest["site_ids"] = [s["id"] for s in sites]
        write_atomic(manifest_path, manifest)
        n += 1
        log.info("%s fresh=%d/%d %s%.0fs", frame_id(t), fj["fresh_count"], fj["site_count"],
                 "(skipped) " if fj.get("skipped") else "", time.time() - ft)
    log.info("done %d frames in %.0fs", n, time.time() - t0)

if __name__ == "__main__":
    main()
