"""Backfill hourly replay frames from the NEXRAD archive.

Frame = one UTC hour: public/data/birds_archive/YYYY/MM/DD/HH/{birds.geojson, field.png, field.json}
plus a top-level manifest.json. Resumable (existing frames skipped). No last-good carry:
a site that fails for an hour is simply absent from that frame and listed in failures.

Two modes. --start/--end backfills an explicit range. --catch-up (the nightly cron) derives its
window from the archive itself: from the hour after the newest frame to the newest hour whose scans
have landed, then prunes to --keep-nights. The window was once only the one-shot backfill, so the
archive stopped at 2026-09-10 while the page's clock kept going; a stalled run now catches up.
"""
from __future__ import annotations
import argparse, datetime as dt, json, logging, os, shutil, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .build_birds import SITES, process_site, site_entry, write_atomic
from .field import composite, write_field_png
from .ppi import write_ppi_png
from .nexrad import volume_key_at

log = logging.getLogger("archive")

class EmptyFrame(RuntimeError):
    """No site produced a profile for the hour. Never written: resume treats a written frame as done."""

def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)

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
    if not feats:
        raise EmptyFrame(f"{frame_id(t)}: 0/{len(sites)} sites; first failure {next(iter(failures.values()), None)}")
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

def pending_hours(frame_ids, now: dt.datetime, utc_hours: set[int], settle: dt.timedelta) -> list[dt.datetime]:
    """Hours after the archive's newest frame whose scans have landed (a frame at HH reads scans up to
    HH + tolerance, so it is settled once `now - settle` has passed it)."""
    if not frame_ids:
        raise SystemExit("--catch-up needs an existing archive to continue; backfill one with --start/--end")
    newest = dt.datetime.strptime(max(frame_ids), "%Y-%m-%dT%H").replace(tzinfo=dt.UTC)
    return list(hours(newest + dt.timedelta(hours=1), now - settle, utc_hours))

def prune_nights(manifest: dict, root: Path, keep: int) -> list[str]:
    """Drop frames outside the newest `keep` UTC nights present in the archive (counted from the data,
    not the clock). Returns the dropped frame ids."""
    ids = sorted(manifest["frames"])
    kept = set(sorted({i[:10] for i in ids})[-keep:])
    dropped = [i for i in ids if i[:10] not in kept]
    for i in dropped:
        shutil.rmtree(root / manifest["frames"].pop(i)["dir"].split("birds_archive/", 1)[1], ignore_errors=True)
    for d in sorted(root.glob("*/*/*"), reverse=True) + sorted(root.glob("*/*"), reverse=True):
        if d.is_dir() and not any(d.iterdir()):
            d.rmdir()
    return dropped

def main(argv=None):
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--start", help="UTC, e.g. 2026-09-01 (with --end)")
    mode.add_argument("--catch-up", action="store_true",
                      help="append every settled hour after the archive's newest frame, then prune")
    ap.add_argument("--end", help="UTC inclusive, e.g. 2026-09-10")
    ap.add_argument("--keep-nights", type=int, default=30, help="--catch-up prunes to this many newest nights")
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
    sites = SITES[: a.sites] if a.sites else SITES
    manifest_path = a.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"frames": {}}
    if a.catch_up:
        todo = pending_hours(manifest["frames"], _now(), utc_hours, dt.timedelta(minutes=a.tolerance_min + 15))
    else:
        if not a.end:
            ap.error("--start needs --end")
        start = dt.datetime.fromisoformat(a.start).replace(tzinfo=dt.UTC)
        end = dt.datetime.fromisoformat(a.end).replace(tzinfo=dt.UTC) + dt.timedelta(hours=23)
        todo = list(hours(start, end, utc_hours))
    log.info("%d frames to build%s", len(todo), f" ({frame_id(todo[0])} .. {frame_id(todo[-1])})" if todo else "")
    t0 = time.time(); n = 0
    for t in todo:
        ft = time.time()
        try:
            fj = build_frame(t, sites, a.out, a.workdir, a.workers, a.tolerance_min)
        except EmptyFrame as e:
            # stop, don't skip: frames past a hole would move the archive's end past it and it would
            # never be retried. Exit non-zero so cron's log and the caller see it.
            log.error("STOPPED at empty frame, next run retries it: %s", e)
            return 1
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
    if a.catch_up:
        dropped = prune_nights(manifest, a.out, a.keep_nights)
        write_atomic(manifest_path, manifest)
        log.info("kept %d frames, pruned %d older than the newest %d nights", len(manifest["frames"]),
                 len(dropped), a.keep_nights)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
