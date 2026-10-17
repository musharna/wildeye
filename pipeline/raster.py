"""Config-driven raster drapes: fetch a data-only PNG (ERDDAP transparentPng), post-process,
write public/data/rasters/<id>.png and public/data/rasters.json."""
from __future__ import annotations
import argparse, datetime as dt, http.client, io, json, logging, re, ssl, time, urllib.error, urllib.request
from pathlib import Path
import numpy as np
from PIL import Image
from .atomic import write_atomic
from .net import urlopen

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
    return urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)

def fetch_png(url: str, timeout: int = 180) -> np.ndarray:
    with _open(url, timeout) as r:
        data = r.read()
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"))

def fill_empty_right_edge(rgba: np.ndarray) -> np.ndarray:
    """ERDDAP's transparentPng leaves the LAST pixel column empty for a whole-globe request, whatever
    longitude range is asked for (NOAA_DHW and the VIIRS chlorophyll set, probed 2026-09-12). Drawn
    over -180..180 that empty column is a visible seam along the antimeridian. When the last column is
    fully transparent and its neighbour has data, repeat the neighbour (0.25° at 1440 px wide).
    Anything else — data in the last column, or nothing next to it either — is left as it is."""
    if rgba.ndim != 3 or rgba.shape[1] < 2 or rgba.shape[2] != 4:
        return rgba
    if rgba[:, -1, 3].any() or not rgba[:, -2, 3].any():
        return rgba
    out = rgba.copy()
    out[:, -1] = rgba[:, -2]
    return out


def fetch_time(url: str | None) -> str | None:
    if not url:
        return None
    with _open(url, 60) as r:
        d = json.load(r)
    return d["table"]["rows"][0][0]

def _read_text(url: str, timeout: int = 60) -> str:
    with _open(url, timeout) as r:
        return r.read().decode("utf-8", "replace")


def resolve_source(product: dict, catalog_xml: str | None = None, today: dt.date | None = None,
                   read_catalog=None) -> tuple[str, str | None]:
    """(url, time) for a product. Static products return (url, None → fetch_time later).
    Products with `catalog` pick the newest file matching `file_regex` from a THREDDS
    catalog.xml, fill `url_template` with {file}, and read the acquisition date from the
    filename via `time_regex` (a date-stamped daily file, e.g. NOAA NDVI CDR on NCEI).
    `catalog` and `url_template` carry {year}: this year's catalog is read, and last year's only when this one is a
    404 or holds no matching file (early January: NCEI opens a year's directory with its first file, ~2 days late);
    the data URL takes the year of the chosen file. Any other HTTP error is raised."""
    if "catalog" not in product:
        return product["url"], None
    return _file_source(product, _catalog_files(product, catalog_xml, today, read_catalog)[-1])


def _catalog_files(product: dict, catalog_xml: str | None = None, today: dt.date | None = None,
                   read_catalog=None) -> list[str]:
    """The sorted file names matching `file_regex` in this year's catalog (last year's when this one is a 404 or holds
    no matching file); see resolve_source."""
    if catalog_xml is None:
        year, tried = (today or dt.datetime.now(dt.UTC).date()).year, []  # UTC, as fetch_cmems
        for y in (year, year - 1):
            url = product["catalog"].format(year=y)
            try:
                xml = (read_catalog or _read_text)(url)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                tried.append(f"{url} (404)")
                continue
            if re.search(product["file_regex"], xml):
                catalog_xml = xml
                break
            tried.append(f"{url} (no matching file)")
        else:
            raise RuntimeError(f"{product['id']}: no file matching {product['file_regex']!r} in {'; '.join(tried)}")
    files = sorted(set(re.findall(product["file_regex"], catalog_xml)))
    if not files:
        raise RuntimeError(f"{product['id']}: no file matching {product['file_regex']!r} in {product['catalog']}")
    return files


def _file_source(product: dict, f: str) -> tuple[str, str | None]:
    """(data url, time from the file name) for one catalog file."""
    m = re.search(product["time_regex"], f)
    if m is None and "{year}" in product["url_template"]:
        raise RuntimeError(f"{product['id']}: {f} has no date for the {{year}} in its url_template")
    when = f"{m.group(1)}-{m.group(2)}-{m.group(3)}T00:00:00Z" if m else None
    return product["url_template"].format(file=f, year=m.group(1) if m else ""), when


def ramp_rgba(values: np.ndarray, ramp: dict) -> np.ndarray:
    """Map a 2-D float field to RGBA through `ramp` {min, max, stops:[[r,g,b],…], log?, clear_at_or_below?}; NaN →
    transparent, and so are values ≤ `clear_at_or_below` (CRW: 0 = no heat stress). The manifest publishes the ramp, so
    the click readout knows a first-stop pixel is above that value rather than at or below min.
    `log: true` spaces the stops evenly in log10 between min and max (both > 0); values ≤ 0 take the low end."""
    stops = np.asarray(ramp["stops"], dtype=float)
    lo, hi = float(ramp["min"]), float(ramp["max"])
    ok = ~np.isnan(values)
    if "clear_at_or_below" in ramp:
        ok &= values > float(ramp["clear_at_or_below"])
    if ramp.get("log"):
        if not 0 < lo < hi:
            raise ValueError(f"log ramp needs 0 < min < max, got {lo}..{hi}")
        v = np.where(values > lo, values, lo)  # NaN compares False: it takes lo here and is made transparent below
        t = np.clip(np.log10(v / lo) / np.log10(hi / lo), 0.0, 1.0)
    else:
        t = np.clip((np.where(ok, values, lo) - lo) / (hi - lo), 0.0, 1.0)
    idx = t * (len(stops) - 1)
    i0 = np.clip(np.floor(idx), 0, len(stops) - 2).astype(int)
    f = (idx - i0)[..., None]
    rgb = stops[i0] * (1 - f) + stops[i0 + 1] * f
    out = np.zeros(values.shape + (4,), dtype=np.uint8)
    out[..., :3] = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
    out[..., 3] = np.where(ok, 255, 0).astype(np.uint8)
    return out


def edge_align(rgba: np.ndarray, lat_north_first: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, dict]:
    """A north-up image of a regular grid given by its cell CENTRES → (image, bounds at the cells' outer EDGES).
    The drape stretches the image across `bounds` edge to edge, so bounds must be edges: taking the centre range
    (e.g. -80..90, -180..180 for Copernicus 0.25°) drew every cell up to half a cell off. Rows whose cell reaches
    past a pole are dropped (Cesium cannot draw past ±90). A global grid whose edges sit half a cell off ±180 (centres
    on -180) is drawn two pixels per cell and turned one pixel, so the image spans exactly -180..180; any other
    global offset raises rather than draw cells in the wrong place. Regularity is judged at the coordinates' own
    precision as well as by equal gaps (float32 centres sit up to half a float32 step off, so a gap can be off by a
    whole step: NCEI NDVI 2026-10-12), and the step is the whole span's."""
    def regular(c):
        c = np.asarray(c)
        x = c.astype(float)
        if len(x) < 2:
            return None
        step = (x[-1] - x[0]) / (len(x) - 1)
        gaps = np.diff(x)
        ulp = float(np.spacing(np.abs(c).max())) if np.issubdtype(c.dtype, np.floating) else 0.0
        on_grid = np.all(np.abs(x - (x[0] + step * np.arange(len(x)))) <= max(1e-5 * abs(step), 2 * ulp))
        return step if step != 0 and (np.allclose(gaps, gaps[0]) or on_grid) else None
    sy, sx = regular(lat_north_first), regular(lon)
    if sy is None or sx is None or sy >= 0 or sx <= 0:
        raise ValueError("edge_align needs a regular grid: latitude north first, longitude ascending")
    lat = np.asarray(lat_north_first, dtype=float); lon = np.asarray(lon, dtype=float)
    hy, hx = -sy / 2, sx / 2
    keep = (lat + hy <= 90 + 1e-9) & (lat - hy >= -90 - 1e-9)
    rgba, lat = rgba[keep], lat[keep]
    bounds = {"west": float(lon[0] - hx), "south": float(lat[-1] - hy), "east": float(lon[-1] + hx), "north": float(lat[0] + hy)}
    if not np.isclose(bounds["east"] - bounds["west"], 360):
        return rgba, bounds
    off = bounds["west"] + 180
    if np.isclose(off, 0):
        return rgba, bounds | {"west": -180.0, "east": 180.0}
    if not np.isclose(abs(off), hx):
        raise ValueError(f"edge_align cannot place a global grid whose west edge is {bounds['west']}")
    # Two pixels per cell, then turn by one pixel: the half cell past ±180 wraps to the other end.
    return np.roll(np.repeat(rgba, 2, axis=1), -1 if off < 0 else 1, axis=1), bounds | {"west": -180.0, "east": 180.0}


def fetch_cmems(product: dict, today: dt.date | None = None, open_dataset=None) -> tuple[np.ndarray, str, dict]:
    """Latest ANALYSIS day (≤ today; the datasets extend ~10 d into forecast) of one surface
    variable from Copernicus Marine, rendered north-up through the product's ramp, with the grid's cell-edge bounds
    from edge_align (they replace any configured bounds in the manifest). With `block` and `grid` (a whole-globe grid of
    [width, height] cells), each block x block group of cells is averaged into one, NaN left out. Credentials
    from CMEMS_USER / CMEMS_PASS (never in the browser). copernicusmarine is imported lazily so the
    module stays importable without it."""
    import os
    c = product["cmems"]
    if open_dataset is None:
        import copernicusmarine as cm
        user, pw = os.environ.get("CMEMS_USER"), os.environ.get("CMEMS_PASS")
        if not user or not pw:
            raise RuntimeError("CMEMS_USER / CMEMS_PASS not set (source ~/.config/wildeye/env)")
        open_dataset = lambda **kw: cm.open_dataset(username=user, password=pw, **kw)  # noqa: E731
    ds = open_dataset(dataset_id=c["dataset_id"], variables=[c["variable"]], minimum_depth=0, maximum_depth=float(c.get("max_depth", 1)))
    today = today or dt.datetime.now(dt.UTC).date()
    times = ds["time"].values
    days = np.asarray(times, dtype="datetime64[D]")
    eligible = np.nonzero(days <= np.datetime64(today))[0]
    if not len(eligible):
        raise RuntimeError(f"{product['id']}: no time step at or before {today}")
    k = int(eligible[-1])
    da = ds[c["variable"]].isel(time=k)
    if "depth" in da.dims:
        da = da.isel(depth=0)
    vals = np.asarray(da.values, dtype=float)
    lat = np.asarray(ds["latitude"].values)
    if lat[0] < lat[-1]:
        vals, lat = vals[::-1], lat[::-1]  # north-up
    lon = np.asarray(ds["longitude"].values)
    if "block" in c:
        # Copernicus-GlobColour 4 km: float32 coordinates sit ~5e-6 deg off the true centres, which edge_align reads as
        # an irregular grid once blocks are averaged. Check the grid is the configured whole globe, then use exact centres.
        from .cmems_pft import check_grid
        check_grid(lat, lon, c["grid"])
        b = int(c["block"])
        vals = block_mean(vals, b)
        h, w = vals.shape
        lat, lon = 90 - (np.arange(h) + 0.5) * 180 / h, -180 + (np.arange(w) + 0.5) * 360 / w
    when = str(np.datetime_as_string(days[k], unit="D")) + "T00:00:00Z"
    rgba, bounds = edge_align(ramp_rgba(vals, product["ramp"]), lat, lon)
    return rgba, when, {"bounds": bounds}


def block_mean(vals: np.ndarray, block: int) -> np.ndarray:
    """Mean of each block x block group of cells, NaN left out; a group with no finite cell stays NaN."""
    h, w = vals.shape
    if h % block or w % block:
        raise ValueError(f"{h}x{w} grid is not divisible into {block}x{block} blocks")
    ok = np.isfinite(vals)
    shape = (h // block, block, w // block, block)
    total = np.where(ok, vals, 0.0).reshape(shape).sum(axis=(1, 3), dtype=np.float64)
    n = ok.reshape(shape).sum(axis=(1, 3))
    return np.where(n > 0, total / np.maximum(n, 1), np.nan)


def _read_bytes(url: str, timeout: int = 180) -> bytes:
    with _open(url, timeout) as r:
        return r.read()


def _read_nc(url: str, timeout: int = 600):
    """A NetCDF response as an in-memory xarray Dataset. xarray is imported lazily (CI's pipeline tests lack it)."""
    import tempfile

    import xarray as xr
    data = _read_bytes(url, timeout)
    with tempfile.NamedTemporaryFile(suffix=".nc") as f:
        f.write(data)
        f.flush()
        with xr.open_dataset(f.name) as ds:
            return ds.load()


def fetch_erddap_grid(product: dict, read_nc=None) -> tuple[np.ndarray, str, dict]:
    """One time step of an ERDDAP griddap variable as numbers (`erddap_grid.url` asks for .nc), drawn north-up through
    the product's ramp with cell-edge bounds from edge_align, like fetch_cmems. ERDDAP's own transparentPng was coloured
    by its colour bar, which the manifest ramp only approximated (median 4-12 levels off, 2026-10-12): the legend was
    not exact and a click could not be read back. NaN (land) is clear. Optional `scale` multiplies the values (a 0..1
    fraction on a % ramp); the ramp's optional `clear_at_or_below` makes those values clear as well (ramp_rgba)."""
    c = product["erddap_grid"]
    return _draw_grid(product, c, (read_nc or _read_nc)(c["url"]))


def _read_opendap(url: str, variable: str, stride: int, offset: int):
    """`variable` over OPeNDAP, every `stride`-th cell from `offset` on both axes; only that subset is transferred."""
    import xarray as xr
    with xr.open_dataset(url) as ds:
        cut = slice(offset, None, stride)
        return ds[[variable]].isel(latitude=cut, longitude=cut).load()


def fetch_opendap_grid(product: dict, catalog_xml: str | None = None, read_grid=None) -> tuple[np.ndarray, str, dict]:
    """The newest catalog file (resolve_source) read as numbers over OPeNDAP and drawn like fetch_erddap_grid. ndvi:
    NCEI's WMS PNG was coloured by its own seq-YlGn palette, which the manifest ramp only approximated; the numbers make
    the legend exact and a click readable. Optional `clear_outside` [lo, hi] makes values outside it clear (ndvi: the WMS
    hid < 0 and > 1, 2026-10-12). The file's own time must be the date in its name."""
    c = product["opendap_grid"]
    url, named = resolve_source(product, catalog_xml)
    rgba, when, extras = _draw_grid(
        product, c, (read_grid or _read_opendap)(url, c["variable"], int(c["stride"]), int(c["offset"])))
    if named and when != named:
        raise ValueError(f"{product['id']}: the file says {when}, its name says {named}")
    return rgba, when, extras


def _draw_grid(product: dict, c: dict, ds) -> tuple[np.ndarray, str, dict]:
    """One time step of ds[c.variable] on (latitude, longitude), drawn north-up through the ramp with edge_align bounds,
    after the optional `scale` and `clear_outside` of the source config `c`."""
    times = np.asarray(ds["time"].values).ravel()
    if len(times) != 1:
        raise ValueError(f"{product['id']}: expected one time step, got {len(times)}")
    da = ds[c["variable"]]
    axes = tuple(d for d, n in zip(da.dims, np.shape(da.values)) if n != 1)
    if axes != ("latitude", "longitude"):
        raise ValueError(f"{product['id']}: {c['variable']} axes are ({', '.join(axes)}), expected (latitude, longitude)")
    vals = np.asarray(da.values, dtype=float).squeeze() * float(c.get("scale", 1))
    if "clear_at_or_below" in c:
        raise ValueError(f"{product['id']}: clear_at_or_below belongs in ramp, where the click readout can see it")
    if "clear_outside" in c:
        lo, hi = (float(x) for x in c["clear_outside"])
        vals[(vals < lo) | (vals > hi)] = np.nan
    lat = np.asarray(ds["latitude"].values)  # native dtype: edge_align judges regularity at its precision
    lon = np.asarray(ds["longitude"].values)
    if vals.shape != (len(lat), len(lon)):
        raise ValueError(f"{product['id']}: {c['variable']} is {vals.shape}, the grid is {len(lat)}x{len(lon)}")
    if lat[0] < lat[-1]:
        vals, lat = vals[::-1], lat[::-1]  # north-up
    when = str(np.datetime_as_string(times[0].astype("datetime64[s]"), unit="s")) + "Z"
    rgba, bounds = edge_align(ramp_rgba(vals, product["ramp"]), lat, lon)
    return rgba, when, {"bounds": bounds}


def render(product: dict, out_dir: Path) -> tuple[np.ndarray, str | None, dict, float]:
    """(image, time, manifest extras, masked fraction) of the product's newest time step, or of the step a
    source_steps variant asks for."""
    extras = {}
    if "cmems" in product:
        rgba, when_from_name, extras = fetch_cmems(product)
    elif "erddap_grid" in product:
        rgba, when_from_name, extras = fetch_erddap_grid(product)
    elif "opendap_grid" in product:
        rgba, when_from_name, extras = fetch_opendap_grid(product)
    elif "cmems_dominant" in product:
        from . import cmems_pft
        rgba, when_from_name = cmems_pft.fetch_cmems_dominant(product)
    elif "crw_outlook" in product:
        from .crw_outlook import fetch_crw_outlook
        rgba, when_from_name, extras = fetch_crw_outlook(
            product, out_dir, read_text=lambda u: _read_bytes(u, 60).decode("utf-8", "replace"), read_bytes=_read_bytes)
    else:
        url, when_from_name = resolve_source(product)
        rgba = fill_empty_right_edge(fetch_png(url))
    masked = 0.0
    t = product.get("transparent", "none")
    if isinstance(t, dict) and "rgb" in t:
        rgba, masked = color_to_alpha(rgba, t["rgb"], int(t.get("tolerance", 0)))
        log.info("%s masked %.1f%% of opaque pixels as %s", product["id"], 100 * masked, t["rgb"])
    elif t != "none":
        raise ValueError(f"{product['id']}: transparent must be 'none' or {{'rgb': [r,g,b]}}, got {t!r}")
    return rgba, when_from_name or fetch_time(product.get("time_url")), extras, masked


def _save_png(rgba: np.ndarray, png: Path) -> None:
    png.parent.mkdir(parents=True, exist_ok=True)
    tmp = png.with_suffix(".tmp.png")
    Image.fromarray(rgba, "RGBA").save(tmp, optimize=True)
    tmp.replace(png)


def process(product: dict, out_dir: Path) -> dict:
    rgba, when, extras, masked = render(product, out_dir)
    png = out_dir / f"{product['id']}.png"
    _save_png(rgba, png)
    keep_days = int(product.get("keep_days", KEEP_DAYS))
    gap_failures = fill_gaps(product, out_dir, when, extras.get("bounds", product.get("bounds")), keep_days)
    history = archive_frame(png, product["id"], when, out_dir, keep_days)
    keep = ("id", "name", "icon", "bounds", "legend", "credit", "credit_key", "classes", "ramp", "kind", "zrank")
    return {k: product[k] for k in keep if k in product} | {
        "png": f"data/rasters/{product['id']}.png", "time": when,
        "width": int(rgba.shape[1]), "height": int(rgba.shape[0]), "masked_fraction": round(masked, 4),
        "history": history} | extras | ({"gap_failures": gap_failures} if gap_failures else {})


GAP_MAX = 7  # steps drawn per product per run: ~200 s each for oisst at 06:45, and the deploy is at 09:00


def source_steps(product: dict, since: str, read_json=None, catalog_xml: str | None = None) -> list[tuple[str, dict]]:
    """[(time, product variant that fetches that step)] for every time step the source holds from `since` on, oldest
    first; [] for a source that only offers its newest step (cmems, cmems_dominant, crw_outlook). An ERDDAP url asking
    for `(last)` lists the dataset's own time axis; a catalog product lists its files (this year's catalog only)."""
    if "opendap_grid" in product and "catalog" in product:
        steps = []
        for f in _catalog_files(product, catalog_xml):
            url, when = _file_source(product, f)
            if when and when >= since:
                steps.append((when, {k: v for k, v in product.items() if k != "catalog"} | {"url": url}))
        return sorted(steps, key=lambda s: s[0])
    if "erddap_grid" in product:
        url = product["erddap_grid"]["url"]
    elif "url" in product and not any(k in product for k in ("cmems", "cmems_dominant", "crw_outlook", "catalog")):
        url = product["url"]
    else:
        return []
    if url.count("(last)") != 1:
        raise ValueError(f"{product['id']}: expected one (last) in {url}")
    axis = url.split("?", 1)[0].rsplit(".", 1)[0] + f".json?time%5B({since}):1:(last)%5D"
    rows = (read_json or (lambda u: json.loads(_read_text(u, 120))))(axis)["table"]["rows"]

    def at(t):
        v = json.loads(json.dumps(product))
        if "erddap_grid" in v:
            v["erddap_grid"]["url"] = url.replace("(last)", f"({t})")
        else:
            v["url"] = url.replace("(last)", f"({t})")
            if v.get("time_url"):
                v["time_url"] = v["time_url"].replace("(last)", f"({t})")
        return v
    return [(r[0], at(r[0])) for r in rows]


def fill_gaps(product: dict, out_dir: Path, latest: str | None, bounds: dict | None, keep_days: int) -> dict:
    """Draw the time steps older than `latest` that the source holds but rasters/<id>/ lacks, within keep_days, newest
    first and at most GAP_MAX a run. The run used to fetch only the newest step, so a morning the source was down left
    a hole for good (2026-10-15: 15 missing days over 6 layers; ERDDAP answers 404 "Currently unknown datasetID" while
    it reloads a dataset). Returns {time: error} for the steps that still failed after retries; the next run tries them
    again. A step drawn with a different time or bounds from the one asked for is refused."""
    pid, d = product["id"], out_dir / product["id"]
    if latest is None:  # no time for the newest step (a PNG product without time_url): nothing to call older (PR #89 review)
        log.warning("%s has no time for its newest step; gaps not filled", pid)
        return {}
    since = (dt.datetime.now(dt.UTC) - dt.timedelta(days=keep_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        steps = with_retries(lambda: source_steps(product, since), f"{pid} time steps")
    except Exception as e:
        log.error("%s time steps FAILED: %r", pid, e)
        return {"time steps": repr(e)}
    have = {f.stem for f in d.glob("*.png")} if d.exists() else set()
    missing = [(t, v) for t, v in steps if t < latest and _stamp(t) not in have][::-1][:GAP_MAX]
    failed = {}
    for t, variant in missing:
        try:
            rgba, when, extras, _ = with_retries(lambda v=variant: render(v, out_dir), f"{pid} {t}")
            if when != t:
                raise ValueError(f"asked for {t}, the source gave {when}")
            if extras.get("bounds", product.get("bounds")) != bounds:
                raise ValueError(f"{t} bounds {extras.get('bounds')} differ from the newest step's {bounds}")
            _save_png(rgba, d / f"{_stamp(t)}.png")
            log.info("%s filled %s", pid, t)
        except Exception as e:
            failed[t] = repr(e)
            log.error("%s %s FAILED: %r", pid, t, e)
    return failed


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

RETRY_ATTEMPTS = 3
RETRY_WAIT_S = 30  # then 60: the daily run has hours of slack before the 09:00 deploy
_sleep = time.sleep


def transient(e: BaseException) -> bool:
    """An error the next attempt may not hit. PacIOOS on 2026-10-12 gave a 503, a 404 for a day it serves, a body cut
    short (IncompleteRead) and a TLS handshake timeout, each gone on the next try; so 5xx, 404, 408, 429 and broken
    connections are retried. Any other HTTP status, and every error raised by our own code, is not."""
    if isinstance(e, urllib.error.HTTPError):
        return e.code >= 500 or e.code in (404, 408, 429)
    return isinstance(e, (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError, ssl.SSLError))


def with_retries(fn, name: str):
    """fn() with up to RETRY_ATTEMPTS tries, waiting RETRY_WAIT_S × the try number between them, for transient errors
    only; the last error, or any other, is raised as it was."""
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == RETRY_ATTEMPTS or not transient(e):
                raise
            log.warning("%s try %d/%d failed: %r; again in %ds", name, attempt, RETRY_ATTEMPTS, e, RETRY_WAIT_S * attempt)
            _sleep(RETRY_WAIT_S * attempt)


def log_formatter() -> logging.Formatter:
    """Log lines stamped in UTC with a Z. copernicusmarine sets logging.Formatter.converter = time.gmtime for the whole
    process when it loads, so the run's unmarked local times turned into unmarked UTC partway through (2026-10-16: an
    exact +4:00 jump read as a 4 h stall). The converter is set on this instance, which that class-wide change can't reach."""
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%SZ")
    fmt.converter = time.gmtime
    return fmt


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data"))
    ap.add_argument("--only", default=None, help="comma-separated product ids")
    a = ap.parse_args(argv)
    handler = logging.StreamHandler()
    handler.setFormatter(log_formatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    products = json.loads((HERE / "rasters.json").read_text())
    if a.only:
        keep = set(a.only.split(",")); products = [p for p in products if p["id"] in keep]
    manifest_path = a.out / "rasters.json"
    prev = {e["id"]: e for e in (json.loads(manifest_path.read_text()) if manifest_path.exists() else {"products": []})["products"]}
    # products not selected this run keep their previous manifest entry untouched
    entries = {k: v for k, v in prev.items() if k not in {p["id"] for p in products}}
    failures, gap_failures = {}, {}
    for p in products:
        t0 = time.time()
        try:
            entries[p["id"]] = with_retries(lambda: process(p, a.out / "rasters"), p["id"])
            if entries[p["id"]].get("gap_failures"):
                gap_failures[p["id"]] = entries[p["id"]].pop("gap_failures")
            log.info("%s ok time=%s %.0fs", p["id"], entries[p["id"]]["time"], time.time() - t0)
        except Exception as e:
            failures[p["id"]] = repr(e); log.error("%s FAILED: %r", p["id"], e)
            if p["id"] in prev:
                entries[p["id"]] = prev[p["id"]] | {"stale": True}
    write_atomic(manifest_path, {"generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                 "failures": failures, "gap_failures": gap_failures, "products": [entries[k] for k in sorted(entries)]})
    if failures and len(failures) == len(products):
        raise SystemExit(f"every selected raster failed: {failures}")

if __name__ == "__main__":
    main()
