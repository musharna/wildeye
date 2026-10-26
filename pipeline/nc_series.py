"""A multi-step netCDF its source rewrites in place, one file per year with a step appended as it comes, downloaded
whole into the cache when the server's ETag changes and read one step at a time. soil-moisture: JRC's GDO Soil Moisture
Index Anomaly v3.0.1, smang_m_gdo_<year>0101_<newest step>_t.nc (601 MB on 2026-10-21, a step per dekad). Its map
server draws the field but cannot serve the numbers (GetFeatureInfo answers with a PNG, 2026-10-25), and the drawn map
resamples, so the numbers come from the file.

Config, under `nc_series`: `variable`, `stride` and `offset` (every stride-th cell from offset on both axes, as
opendap_grid), `grid` {west, north, cell, width, height} (exact_centres), optional `bins` (raster._draw_grid) and `time` (the step to draw; the newest when absent). The product's
`catalog` is the directory listing, `file_regex` picks the files, and `url_template` takes {file}."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import urllib.request
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


def cache_root() -> Path:
    return (
        Path(os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye"))
        / "nc_series"
    )


def _head(url: str, timeout: int = 60) -> tuple[str, int]:
    """(ETag, Content-Length) from a HEAD request; a server that sends neither cannot tell us the file changed."""
    from .net import urlopen
    from .raster import UA

    with urlopen(
        urllib.request.Request(url, headers=UA, method="HEAD"), timeout=timeout
    ) as r:
        etag, size = r.headers.get("ETag"), r.headers.get("Content-Length")
    if not etag or not size:
        raise RuntimeError(
            f"{url}: HEAD gave ETag {etag!r}, Content-Length {size!r}; a changed file could not be told"
        )
    return etag, int(size)


def _fetch_to(url: str, path: Path, timeout: int = 120) -> None:
    from .net import urlopen
    from .raster import UA

    with (
        urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r,
        open(path, "wb") as fh,
    ):
        shutil.copyfileobj(r, fh, 1 << 20)


def _read_listing(url: str) -> str:
    from .raster import _read_text

    return _read_text(url, 60)


def newest_file(product: dict, listing: str) -> str:
    """The last of the file names matching `file_regex` in the listing, sorted: the newest year's file."""
    files = sorted(set(re.findall(product["file_regex"], listing)))
    if not files:
        raise RuntimeError(
            f"{product['id']}: no file matching {product['file_regex']!r} in {product['catalog']}"
        )
    return files[-1]


def cached(
    url: str, cache: Path, name: str, file_regex: str, head=_head, fetch_to=_fetch_to
) -> Path:
    """The file at url, kept in cache as `name` with its ETag beside it, fetched again only when the server's ETag
    differs. A download whose size is not the server's Content-Length is refused and the cached copy is kept. Once a
    new file is in, the product's other files (last year's) are removed from the cache."""
    etag, size = head(url)
    path, tag = cache / name, cache / f"{name}.etag"
    if path.exists() and tag.exists() and tag.read_text() == etag:
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = cache / f"{name}.part"
    log.info("downloading %s (%d MB)", url, size >> 20)
    try:
        fetch_to(url, part)
        got = part.stat().st_size
        if got != size:
            raise ValueError(f"{url}: downloaded {got} bytes, the server said {size}")
        os.replace(part, path)
        tag.write_text(etag)
    finally:
        part.unlink(missing_ok=True)
    for old in cache.iterdir():
        if old.name != name and re.fullmatch(file_regex, old.name):
            old.unlink()
            cache.joinpath(f"{old.name}.etag").unlink(missing_ok=True)
    return path


def source_file(
    product: dict,
    read_listing=_read_listing,
    head=_head,
    fetch_to=_fetch_to,
    cache: Path | None = None,
) -> Path:
    """The newest year's file, from the cache when it is unchanged on the server."""
    name = newest_file(product, read_listing(product["catalog"]))
    url = product["url_template"].format(file=name)
    return cached(
        url,
        (cache or cache_root()) / product["id"],
        name,
        product["file_regex"],
        head,
        fetch_to,
    )


def _when(t) -> str:
    return str(np.datetime_as_string(np.datetime64(t, "s"), unit="s")) + "Z"


def read_step(path: Path, c: dict):
    """One step of c.variable (the newest, or c.time) as a one-step dataset on (latitude, longitude), every c.stride-th
    cell from c.offset; an asked-for time the file lacks is refused."""
    import xarray as xr

    with xr.open_dataset(path) as ds:
        times = [_when(t) for t in np.asarray(ds["time"].values)]
        if "time" in c:
            if c["time"] not in times:
                raise ValueError(
                    f"{path.name} has no step {c['time']} (it has {times[0]}..{times[-1]})"
                )
            k = times.index(c["time"])
        else:
            k = len(times) - 1
        lat, lon = exact_centres(
            np.asarray(ds["lat"].values), np.asarray(ds["lon"].values), c["grid"]
        )
        cut = slice(int(c["offset"]), None, int(c["stride"]))
        sub = ds[[c["variable"]]].isel(time=[k], lat=cut, lon=cut).load()
    sub = sub.assign_coords(lat=lat[cut], lon=lon[cut])
    return sub.rename({"lat": "latitude", "lon": "longitude"})


def exact_centres(
    lat: np.ndarray, lon: np.ndarray, g: dict
) -> tuple[np.ndarray, np.ndarray]:
    """The exact cell centres of the configured grid {west, north, cell, width, height} (north-first), once the file's
    own centres are checked to be that grid within 0.001°. smang stores float32 centres (-179.9750061), which put the
    drape's west edge at -180.0000061, and edge_align rightly refuses a global grid it cannot place (2026-10-25)."""
    w, h, cell = int(g["width"]), int(g["height"]), float(g["cell"])
    want_lon = float(g["west"]) + (np.arange(w) + 0.5) * cell
    want_lat = float(g["north"]) - (np.arange(h) + 0.5) * cell
    if lon.shape != want_lon.shape or lat.shape != want_lat.shape:
        raise ValueError(f"grid is {len(lon)}x{len(lat)}, expected {w}x{h}")
    if not np.allclose(lon, want_lon, rtol=0, atol=1e-3) or not np.allclose(
        lat, want_lat, rtol=0, atol=1e-3
    ):
        raise ValueError(
            f"cell centres are not the {cell}° grid from {g['west']}, {g['north']}"
        )
    return want_lat, want_lon


def fetch_nc_series(
    product: dict, file: Path | None = None
) -> tuple[np.ndarray, str, dict]:
    """One step drawn like an erddap_grid product (raster._draw_grid): north-up, cell-edge bounds, `bins` classed."""
    from .raster import _draw_grid

    c = product["nc_series"]
    return _draw_grid(product, c, read_step(file or source_file(product), c))


def series_steps(
    product: dict, since: str, file: Path | None = None
) -> list[tuple[str, dict]]:
    """[(time, variant that draws that step)] for the steps of the newest year's file from `since` on, oldest first.
    Steps of earlier years' files are not offered: the cache keeps one file, and each year's frames are drawn while
    that year's file is the newest."""
    import xarray as xr

    with xr.open_dataset(file or source_file(product)) as ds:
        times = [_when(t) for t in np.asarray(ds["time"].values)]
    out = []
    for t in sorted(times):
        if t >= since:
            v = json.loads(json.dumps(product))
            v["nc_series"]["time"] = t
            out.append((t, v))
    return out
