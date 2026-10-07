"""Modelled soil bacterial richness (Bickel et al. 2026) → a geographic tile pyramid and level-3 value tiles.

Spec: docs/superpowers/specs/2026-10-07-soil-bacteria-design.md. Zenodo record 21133869 (CC BY 4.0) holds the model's
0.1° maps in ensemble.zip; it is downloaded once and refused unless its md5 is Zenodo's. Only bacteria_mean.nc and
bacteria_std.nc are read, into memory from the zip. Each grid is placed by its own lat/lon axes, which must be the
regular global 0.1° grid (north first); the GeoTransform attribute the files carry contradicts the axes and is never
read. Mean and SD are rounded half up to whole numbers. The mean is resampled by nearest neighbour to level 3 of
Cesium's geographic tiling (4096 × 2048, so every 0.1° cell keeps its own pixels), binned in tens from 150 to 900 with
one palette colour each, and averaged over the pixels with data for the coarser levels. Level 3 also gets RGBA value
tiles carrying each cell's whole-number mean and SD (R = mean mod 256, G = SD mod 256, B = the two high nibbles,
A = 255; no data all zero). A grid off the 0.1° axes, files whose blank cells differ, a value the encoding or the
display range cannot hold, or tiles over the budget stop the run; soil_bacteria.json, written last, is what the layer
reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import logging
import os
import shutil
import time
import zipfile
from pathlib import Path

import numpy as np

from .atomic import write_atomic
from .hfp import TILE, _fetch_to, _md5, block_mean, tiles_for_level

log = logging.getLogger("soil_bacteria")
RECORD_API = "https://zenodo.org/api/records/21133869"
CACHE_DIR = "soil_richness"
ZIP_NAME = "ensemble.zip"
ZIP_MD5 = "822beb1e913521d4831b4d12320f4278"  # Zenodo's md5 (record 21133869, API read 2026-10-07)
MEAN, SD = "bacteria_mean.nc", "bacteria_std.nc"
RES = 0.1  # degrees per cell
ROWS, COLS = 1800, 3600
AXIS_TOL = 1e-6  # degrees: the files' centres sit within 4e-15 of the 0.1° grid
MAX_LEVEL = 3  # 4096 × 2048: finer than the 0.1° grid (3600 × 1800)
BUDGET_BYTES = 5_000_000
ENCODE_MAX = 4095  # 12 bits each for mean and SD in the value tiles
# display bins: index k = 1..BINS covers [DISPLAY_MIN + STEP (k - 1), DISPLAY_MIN + STEP k), the last one closed
DISPLAY_MIN, DISPLAY_MAX, STEP = 150, 900, 10
BINS = (DISPLAY_MAX - DISPLAY_MIN) // STEP
# ColorBrewer YlOrBr from its fourth-darkest stop to its palest: low orange-brown, high pale yellow (the two darkest
# browns dropped: lost on the night globe)
RAMP = [
    (204, 76, 2),
    (236, 112, 20),
    (254, 153, 41),
    (254, 196, 79),
    (254, 227, 145),
    (255, 247, 188),
    (255, 255, 229),
]
UNIT = "bacterial sequence variants per soil sample"
MODEL = {"r2": 0.41, "r2Sd": 0.09, "r2Max": 0.62, "locations": 320, "reads": 7500}
SOURCE = {
    "id": "soil-bacteria",
    "name": "Global maps of soil microbial and plant richness (Bickel 2026), bacteria ensemble mean and SD",
    "url": "https://doi.org/10.5281/zenodo.21133869",
    "licence": "CC BY 4.0 (Zenodo 10.5281/zenodo.21133869)",
    "citation": "Bickel S., Abdelfattah A., Tack A.J.M., Wicaksono W.A., Berg G. (2026) Associations among soil "
    "microbial and plant richness across global terrestrial biomes. ISME Communications 6:ycag266. "
    "doi:10.1093/ismeco/ycag266",
}


def fetch(cache: Path, *, fetch_to=_fetch_to, md5: str = ZIP_MD5) -> Path:
    """The record's ensemble.zip in `cache`, downloaded once; refused (and not kept) unless its md5 is Zenodo's."""
    path = cache / ZIP_NAME
    if path.exists():
        got = _md5(path)
        if got != md5:
            raise ValueError(
                f"{path}: md5 {got} is not Zenodo's {md5}; delete it to fetch again"
            )
        return path
    cache.mkdir(parents=True, exist_ok=True)
    part = cache / f"{ZIP_NAME}.part"
    url = f"{RECORD_API}/files/{ZIP_NAME}/content"
    log.info("downloading %s → %s", url, path)
    try:
        fetch_to(url, part)
        got = _md5(part)
        if got != md5:
            raise ValueError(f"{ZIP_NAME}: md5 {got} is not Zenodo's {md5}")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def check_axis(
    name: str, values: np.ndarray, n: int, first: float, step: float
) -> None:
    """Every coordinate of the axis on the regular grid: n values from `first` by `step`, within AXIS_TOL."""
    v = np.asarray(values, dtype=float)
    want = first + step * np.arange(n)
    if v.shape != (n,) or not np.all(np.abs(v - want) <= AXIS_TOL):
        raise ValueError(
            f"{name} axis {v[:2].tolist()}…{v[-1:].tolist()} ({v.size}) is not {n} centres from {first} by {step}"
        )


def read_grid(ds) -> np.ndarray:
    """`richness` of an open netCDF4 dataset as float64 (rows north to south), NaN where blank, after checking that its
    axes are the global 0.1° grid. Placement comes from the lat/lon variables only."""
    if "richness" not in ds.variables:
        raise ValueError(f"no `richness` variable (have {sorted(ds.variables)})")
    var = ds["richness"]
    if tuple(var.dimensions) != ("lat", "lon"):
        raise ValueError(f"richness dims {var.dimensions} are not (lat, lon)")
    check_axis("lat", ds["lat"][:], ROWS, 90 - RES / 2, -RES)
    check_axis("lon", ds["lon"][:], COLS, -180 + RES / 2, RES)
    return np.ma.filled(var[:].astype(np.float64), np.nan)


def read_member(zip_path: Path, member: str) -> np.ndarray:
    """One grid read from the zip into memory (never extracted)."""
    import netCDF4

    with zipfile.ZipFile(zip_path) as z:
        data = z.read(member)
    with netCDF4.Dataset(member, memory=data) as ds:
        return read_grid(ds)


def round_half_up(a: np.ndarray) -> np.ndarray:
    return np.floor(a + 0.5)


def check_pair(
    mean: np.ndarray, sd: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(whole-number mean, whole-number SD, has-data mask) from the two grids; anything the tiles cannot carry stops."""
    if mean.shape != (ROWS, COLS) or sd.shape != (ROWS, COLS):
        raise ValueError(f"grids {mean.shape} and {sd.shape} are not {ROWS} × {COLS}")
    for name, a in (("mean", mean), ("SD", sd)):
        if np.isinf(a).any():
            raise ValueError(f"{int(np.isinf(a).sum())} {name} cells are infinite")
    ok = ~np.isnan(mean)
    if not np.array_equal(ok, ~np.isnan(sd)):
        raise ValueError(
            f"mean and SD are blank in different cells ({int((ok != ~np.isnan(sd)).sum())} differ)"
        )
    if not ok.any():
        raise ValueError("every cell is blank")
    m, s = mean[ok], sd[ok]
    if (m <= 0).any() or (s < 0).any():
        raise ValueError(
            f"a mean ≤ 0 or an SD < 0 (mean min {m.min()}, SD min {s.min()})"
        )
    mi, si = round_half_up(m), round_half_up(s)
    if mi.max() > ENCODE_MAX or si.max() > ENCODE_MAX:
        raise ValueError(
            f"mean {mi.max():.0f} or SD {si.max():.0f} is over the {ENCODE_MAX} a value tile carries"
        )
    if mi.min() < DISPLAY_MIN or mi.max() > DISPLAY_MAX:
        raise ValueError(
            f"means {mi.min():.0f}–{mi.max():.0f} reach outside the display range {DISPLAY_MIN}–{DISPLAY_MAX}"
        )
    mean_i = np.zeros(mean.shape, np.uint16)
    sd_i = np.zeros(sd.shape, np.uint16)
    mean_i[ok], sd_i[ok] = mi.astype(np.uint16), si.astype(np.uint16)
    return mean_i, sd_i, ok


def nearest(src: np.ndarray, width: int) -> np.ndarray:
    """`src` (the global grid) at width × width/2 by nearest neighbour, dtype kept: each pixel takes the cell under its
    centre."""
    h, w = src.shape
    cols = np.floor((np.arange(width) + 0.5) * w / width).astype(np.intp)
    rows = np.floor((np.arange(width // 2) + 0.5) * h / (width // 2)).astype(np.intp)
    return src[np.ix_(rows, cols)]


def encode(mean_i: np.ndarray, sd_i: np.ndarray, ok: np.ndarray) -> np.ndarray:
    """RGBA uint8: R = mean mod 256, G = SD mod 256, B = mean // 256 + 16 · (SD // 256), A = 255; blank → 0, 0, 0, 0."""
    if mean_i.max(initial=0) > ENCODE_MAX or sd_i.max(initial=0) > ENCODE_MAX:
        raise ValueError(f"a value over {ENCODE_MAX} cannot be encoded")
    out = np.zeros(mean_i.shape + (4,), np.uint8)
    m, s = mean_i.astype(np.uint32), sd_i.astype(np.uint32)
    out[..., 0] = m & 255
    out[..., 1] = s & 255
    out[..., 2] = (m >> 8) | ((s >> 8) << 4)
    out[..., 3] = 255
    out[~ok] = 0
    return out


def bins(field: np.ndarray) -> np.ndarray:
    """Values → palette index 1..BINS in steps of STEP from DISPLAY_MIN (DISPLAY_MAX in the last); NaN → 0."""
    idx = np.zeros(field.shape, np.uint8)
    ok = ~np.isnan(field)
    idx[ok] = np.clip(1 + np.floor((field[ok] - DISPLAY_MIN) / STEP), 1, BINS).astype(
        np.uint8
    )
    return idx


def palette() -> list[tuple[int, int, int]]:
    """Index 0 (blank, transparent) then one colour per bin along the ramp; all distinct."""
    out = [(0, 0, 0)]
    for k in range(BINS):
        f = k / (BINS - 1) * (len(RAMP) - 1)
        i = min(int(f), len(RAMP) - 2)
        w = f - i
        out.append(
            tuple(int(round(a * (1 - w) + b * w)) for a, b in zip(RAMP[i], RAMP[i + 1]))
        )
    if len(set(out[1:])) != BINS:
        raise ValueError(f"the ramp gives fewer than {BINS} distinct colours")
    return out


def levels(mean_i: np.ndarray, ok: np.ndarray, max_level: int = MAX_LEVEL):
    """(z, uint8 palette index) from max_level down to 0: nearest at max_level; each coarser level the mean of the 2 × 2
    block's pixels with data (display only: the readout reads the value tiles)."""
    field = np.where(ok, mean_i.astype(np.float64), np.nan)
    field = nearest(field, TILE * 2 ** (max_level + 1))
    for z in range(max_level, -1, -1):
        yield z, bins(field)
        if z:
            field = block_mean(field, 2)


def png_palette(idx: np.ndarray, pal: list[tuple[int, int, int]]) -> bytes:
    """8-bit palette PNG (the readout's decoder, src/data/pngDecode.js, reads 8-bit only), index 0 transparent."""
    from PIL import Image

    im = Image.fromarray(np.ascontiguousarray(idx), "P")
    im.putpalette(bytes(c for rgb in pal for c in rgb))
    buf = io.BytesIO()
    im.save(
        buf,
        "PNG",
        optimize=True,
        bits=8,
        transparency=bytes([0] + [255] * (len(pal) - 1)),
    )
    return buf.getvalue()


def png_rgba(rgba: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgba), "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def write_tiles(
    mean_i: np.ndarray,
    sd_i: np.ndarray,
    ok: np.ndarray,
    out: Path,
    max_level: int = MAX_LEVEL,
) -> dict:
    """Display pyramid under out/{z}/{x}/{y}.png and level-max value tiles under out/value/{x}/{y}.png."""
    pal = palette()
    sizes = {"display": 0, "value": 0}
    for z, idx in levels(mean_i, ok, max_level):
        for (x, y), tile in tiles_for_level(idx, z):
            p = out / str(z) / str(x) / f"{y}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            data = png_palette(tile, pal)
            p.write_bytes(data)
            sizes["display"] += len(data)
    width = TILE * 2 ** (max_level + 1)
    rgba = encode(nearest(mean_i, width), nearest(sd_i, width), nearest(ok, width))
    # tiles_for_level checks a 2-D shape: cut the channels with the coordinates it yields for the first one
    for (x, y), _ in tiles_for_level(rgba[..., 0], max_level):
        p = out / "value" / str(x) / f"{y}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        data = png_rgba(rgba[y * TILE : (y + 1) * TILE, x * TILE : (x + 1) * TILE])
        p.write_bytes(data)
        sizes["value"] += len(data)
    return sizes


def main(argv=None, *, fetch_to=_fetch_to, md5: str = ZIP_MD5) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", type=Path, default=Path("public/data"))
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(
            os.environ.get("WILDEYE_CACHE", Path.home() / ".cache" / "wildeye")
        ),
    )
    ap.add_argument("--budget", type=int, default=BUDGET_BYTES)
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    t0 = time.time()
    zip_path = fetch(a.cache / CACHE_DIR, fetch_to=fetch_to, md5=md5)
    mean_i, sd_i, ok = check_pair(
        read_member(zip_path, MEAN), read_member(zip_path, SD)
    )
    log.info("read %d cells with data (%.0f s)", int(ok.sum()), time.time() - t0)
    staging = a.out_dir / ".soil_bacteria.tmp"
    shutil.rmtree(staging, ignore_errors=True)
    try:
        sizes = write_tiles(mean_i, sd_i, ok, staging)
        if sum(sizes.values()) > a.budget:
            raise SystemExit(
                f"{sum(sizes.values()):,} B of tiles is over the {a.budget:,} B budget: nothing published"
            )
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    final, old = a.out_dir / "soil_bacteria", a.out_dir / ".soil_bacteria.old"
    shutil.rmtree(old, ignore_errors=True)
    if final.exists():
        os.replace(final, old)
    os.replace(staging, final)
    shutil.rmtree(old, ignore_errors=True)
    write_atomic(
        a.out_dir / "soil_bacteria.json",
        {
            "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "maxLevel": MAX_LEVEL,
            "tile": "data/soil_bacteria/{z}/{x}/{y}.png",
            "valueTile": "data/soil_bacteria/value/{x}/{y}.png",
            "encoding": "RGBA: mean = R + 256 * (B % 16), SD = G + 256 * floor(B / 16), A 255; no data 0,0,0,0",
            "palette": [list(c) for c in palette()],
            "display": {"min": DISPLAY_MIN, "max": DISPLAY_MAX, "step": STEP},
            "mean": [int(mean_i[ok].min()), int(mean_i[ok].max())],
            "sd": [int(sd_i[ok].min()), int(sd_i[ok].max())],
            "unit": UNIT,
            "model": MODEL,
            "resolution": f"{RES}° cells; whole numbers, rounded half up",
            "source": SOURCE,
            "bytes": sizes,
        },
    )
    log.info(
        "wrote %s: mean %d–%d, SD %d–%d, %.2f MB (%.0f s)",
        a.out_dir / "soil_bacteria.json",
        int(mean_i[ok].min()),
        int(mean_i[ok].max()),
        int(sd_i[ok].min()),
        int(sd_i[ok].max()),
        sum(sizes.values()) / 1e6,
        time.time() - t0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
