"""NASA GIBS layer manifest for the browser (stdlib only).

Reads the GIBS WMTS capabilities (Web Mercator, "best") and each layer's v1.3 colour map and writes
public/data/gibs.json: per wildeye layer its tile set, zoom limit, the time intervals GIBS serves and a
legend in the shape rasterDrape.legendItems() reads. The browser fetches tiles straight from GIBS and
never downloads the 5.7 MB capabilities document.

XML: stdlib ElementTree over NASA's fixed HTTPS endpoints; the bundled expat (2.7.1 when this was
written; >= 2.4.1 bounds entity expansion) and defusedxml is not a dependency this repo's CI installs.
Any fetch or parse failure raises before the atomic write, so yesterday's file survives a bad night.
"""

from __future__ import annotations
import argparse
import datetime as dt
import logging
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from .atomic import write_atomic
from .net import urlopen

log = logging.getLogger("gibs")
CAPABILITIES = (
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"
)
UA = "wildeye (github.com/musharna/wildeye)"
NS = {
    "w": "http://www.opengis.net/wmts/1.0",
    "o": "http://www.opengis.net/ows/1.1",
    "x": "http://www.w3.org/1999/xlink",
}
RAMP_STOPS = 9
LAYERS = {
    "gibs-landcover": {
        "gibsId": "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual",
        "legend": "Land cover type (IGBP), yearly",
    },
    "gibs-evi": {
        "gibsId": "MODIS_Terra_L3_EVI_16Day",
        "legend": "Enhanced vegetation index, 16-day composite",
    },
    "gibs-lst": {
        "gibsId": "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day",
        "legend": "Daytime land surface temperature, 8-day",
    },
    "gibs-nightlights": {
        "gibsId": "VIIRS_Black_Marble",
        "legend": "Night lights, true colour (no values)",
        "colormap": False,  # true-colour imagery: GIBS publishes no colour map for it
    },
    "gibs-biomass": {
        "gibsId": "GEDI_ISS_L4B_Aboveground_Biomass_Density_Mean_201904-202303",
        "legend": "Aboveground biomass density, 2019–2023 composite",
    },
    # SEDAC grids of IUCN 2013 ranges: GIBS serves them with no time dimension, so the year comes from here
    "gibs-amphibians": {
        "gibsId": "Amphibian_Richness_All_Species_2013",
        "legend": "Amphibian species per ~1 km cell (IUCN ranges, 2013); none or no data not drawn",
        "asOf": "2013",
    },
    "gibs-mammals": {
        "gibsId": "Mammal_Richness_Grids_All_Species_2013",
        "legend": "Mammal species per ~1 km cell (IUCN ranges, 2013); none or no data not drawn",
        "asOf": "2013",
    },
    # wave 2 (spec 2026-10-03-gibs-gpp-canopy-anthromes-design.md)
    "gibs-gpp": {
        "gibsId": "MODIS_Terra_L4_Gross_Primary_Productivity_8Day",
        "legend": "Gross primary productivity, carbon fixed by plants over each 8 days (MOD17A2H); "
        "urban, wetland, water, snow, ice and barren land not drawn",
    },
    "gibs-canopy": {
        "gibsId": "GEDI_ISS_L3_Canopy_Height_Mean_RH100_201904-202303",
        "legend": "Mean canopy top height (GEDI RH100) per ~1 km cell, 2019–2023 composite; "
        "GEDI covers 52°S–52°N; bare desert reads about 3.5–4 m",
    },
    # Ellis & Ramankutty v1: undated in GIBS; CMR gives the data period 2001-2006
    "gibs-anthromes": {
        "gibsId": "Anthropogenic_Biomes_of_the_World_2001-2006",
        "legend": "Anthropogenic biomes: how people use and live in each ~9 km cell (v1, 2001–2006)",
        "asOf": "2001–2006",
    },
    # OPERA vegetation disturbance, calendar-year summary (survey wildeye_fresh_global_data_survey_2026-10-24).
    # Meanings from the OPERA DIST product specification (lpdaac.usgs.gov/documents/1766): "confirmed" = detected with
    # high confidence; < / >= 50% = the largest drop in vegetation cover; "finished" = no anomaly in two later looks.
    # "No Disturbance" covers 90-99% of a tile (probe 2026-10-24), so it is keyed out and only disturbance is drawn.
    "gibs-disturbance": {
        "gibsId": "OPERA_L3_DIST-ANN-HLS_Color_Index",
        "legend": "Vegetation disturbance confirmed in the year (NASA OPERA, 30 m Landsat + Sentinel-2): fire, "
        "drought, clearing, storms and other losses of plant cover; no disturbance not drawn",
        "hide": ["No Disturbance"],
        "labels": {
            "No Disturbance": "No disturbance",
            "Confirmed < 50%": "Disturbed, ongoing: under half the plant cover lost",
            "Confirmed >= 50%": "Disturbed, ongoing: half or more of the plant cover lost",
            "Confirmed < 50% finished": "Disturbed, ended: under half the plant cover lost",
            "Confirmed >= 50% finished": "Disturbed, ended: half or more of the plant cover lost",
        },
        # Status values 9 and 10 (spec: "confirmed previous year <50% / >=50%") are drawn in the tile but missing
        # from GIBS's colour map; the tile's palette index is the value (0, 3, 6, 7, 8 match the map's sourceValue),
        # and index 9 = 51,51,51, 10 = 68,68,68 in the live tiles at every zoom (probe 2026-10-24).
        "extra_classes": [
            {"label": "Disturbed, carried over from the year before: under half the plant cover lost", "rgb": [51, 51, 51]},
            {"label": "Disturbed, carried over from the year before: half or more of the plant cover lost", "rgb": [68, 68, 68]},
        ],
        # GIBS serves some open-ocean tiles of this layer corrupt: RGBA, with bytes of other clients' requests in the
        # pixels (9 of 12 fetches, probe 2026-10-24); the app drops a tile holding a pixel that is no class colour.
        "discardForeignTiles": True,
    },
}


def _get(url: str, timeout: int = 120, tries: int = 4) -> bytes:
    """GET with UA; retries 5xx / connection errors with backoff, never swallows a 4xx."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for k in range(tries):
        try:
            with urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or k == tries - 1:
                raise
            log.warning("%s → HTTP %s, retry %d", url, e.code, k + 1)
        except (urllib.error.URLError, TimeoutError) as e:
            if k == tries - 1:
                raise
            log.warning("%s → %s, retry %d", url, e, k + 1)
        time.sleep(2 ** (k + 1))
    raise AssertionError("unreachable")


def parse_layers(xml: bytes, ids: set[str]) -> dict:
    """Tile set, zoom limit, format, served time intervals and v1.3 colour-map link for each id.
    Raises LookupError naming any id the capabilities no longer list."""
    root = ET.fromstring(xml)  # nosec B314 - NASA GIBS over HTTPS; expat 2.7.1 (>= 2.4.1 bounds entity expansion), see module docstring
    found = {}
    for layer in root.iter(f"{{{NS['w']}}}Layer"):
        lid = layer.findtext("o:Identifier", namespaces=NS)
        if lid not in ids:
            continue
        tms = layer.findtext("w:TileMatrixSetLink/w:TileMatrixSet", namespaces=NS)
        dim = layer.find("w:Dimension", NS)
        hrefs = [
            m.get(f"{{{NS['x']}}}href") or "" for m in layer.findall("o:Metadata", NS)
        ]
        found[lid] = {
            "tileMatrixSet": tms,
            "maximumLevel": int(tms.rsplit("Level", 1)[1]),
            "format": layer.findtext("w:Format", namespaces=NS).split("/")[-1],
            "times": [v.text for v in dim.findall("w:Value", NS)]
            if dim is not None
            else [],
            "colormapUrl": next((h for h in hrefs if "/colormaps/v1.3/" in h), None),
        }
    missing = sorted(ids - set(found))
    if missing:
        raise LookupError(f"not in GIBS capabilities: {missing}")
    return found


def _num(label: str) -> float:
    m = re.search(r"-?\d+(?:\.\d+)?", label or "")
    if not m:
        raise ValueError(f"no number in legend label {label!r}")
    return float(m.group())


def parse_colormap(xml: bytes) -> dict:
    """{'classes': [...]} for a classification legend, {'ramp': {...}} for a continuous one.
    The data map is the one with an opaque entry: a 'No Data'/'Fill' map draws nothing, however many legend
    entries it has (SEDAC's has two, "No Species" and "No Data")."""
    root = ET.fromstring(xml)  # nosec B314 - NASA GIBS over HTTPS; expat 2.7.1 (>= 2.4.1 bounds entity expansion), see module docstring
    data = [
        cm
        for cm in root.iter("ColorMap")
        if cm.find("Legend") is not None
        and any(e.get("transparent") != "true" for e in cm.iter("ColorMapEntry"))
    ]
    if len(data) != 1:
        raise ValueError(f"expected one data colour map, found {len(data)}")
    cm = data[0]
    legend = cm.find("Legend")
    entries = [
        ([int(c) for c in e.get("rgb").split(",")], e.get("tooltip")) for e in legend
    ]

    # A colour the map only ever declares transparent is no data whatever alpha a tile gives it: GIBS's empty
    # SEDAC tile in EPSG:3857 is opaque black, with no tRNS chunk (probe 2026-10-02). A colour that is also
    # drawn opaque somewhere (GEDI's black) is data.
    def rgbs(transparent):
        return {
            tuple(int(c) for c in e.get("rgb").split(","))
            for e in root.iter("ColorMapEntry")
            if (e.get("transparent") == "true") == transparent
        }

    no_data = sorted(rgbs(True) - rgbs(False))
    extra = {"noData": [list(c) for c in no_data]} if no_data else {}
    if legend.get("type") == "classification":
        # a legend entry whose colour is only ever no data (OPERA's "No Data") is not a class to draw a swatch for
        return {
            "classes": [
                {"label": label, "rgb": rgb}
                for rgb, label in entries
                if tuple(rgb) not in no_data
            ]
        } | extra
    idx = [round(i * (len(entries) - 1) / (RAMP_STOPS - 1)) for i in range(RAMP_STOPS)]
    unit = cm.get("units")
    return extra | {
        "ramp": {
            "stops": [entries[i][0] for i in idx],
            "min": _num(legend.get("minLabel")),
            "max": _num(legend.get("maxLabel")),
            "unit": f" {unit}" if unit else "",
        },
        # Tiles are palette PNGs whose every opaque pixel is one of these colours (probe 2026-09-23),
        # so the browser reads a value by exact lookup: [r, g, b, lo, hi] for value="[lo,hi)", with
        # null for an open end (GEDI's top bin is "[250,+INF)"; JSON has no infinity).
        "decode": [
            [*(int(c) for c in e.get("rgb").split(",")), *_interval(e.get("value"))]
            for e in cm.iter("ColorMapEntry")
            if e.get("nodata") != "true"
        ],
    }


def _interval(value: str) -> tuple[float | None, float | None]:
    exact = re.fullmatch(
        r"\[(-?[\d.]+)\]", value or ""
    )  # one value, e.g. a species count "[12]"
    if exact:
        return float(exact.group(1)), float(exact.group(1))
    m = re.fullmatch(r"\[(-?[\d.]+|-INF),(-?[\d.]+|\+INF)\)", value or "")
    if not m:
        raise ValueError(f"unparseable colour-map value {value!r}")
    lo, hi = m.groups()
    return (None if lo == "-INF" else float(lo)), (None if hi == "+INF" else float(hi))


def configure_classes(key: str, classes: list[dict], cfg: dict, no_data=()) -> list[dict]:
    """A copy of NASA's classes with LAYERS' plain labels ("labels": NASA label -> ours) and the "hide" classes
    marked hidden (drawn transparent, still read by a click), then the "extra_classes" the tiles draw but the colour
    map omits. A NASA label the colour map lacks raises: a renamed class must not silently keep its old wording or
    stop being hidden. An extra class in a colour the map already uses raises: one colour cannot mean two things."""
    labels, hide = cfg.get("labels", {}), set(cfg.get("hide", []))
    names = {c["label"] for c in classes}
    unknown = sorted((set(labels) | hide) - names)
    if unknown:
        raise LookupError(f"{key}: no class {unknown} in the colour map (it has {sorted(names)})")
    taken = [c["rgb"] for c in classes] + [list(c) for c in no_data]
    for extra in cfg.get("extra_classes", []):
        if extra["rgb"] in taken:
            raise LookupError(f"{key}: extra class {extra['rgb']} is a colour the map already uses")
        taken.append(extra["rgb"])
    return [
        {**c, "label": labels.get(c["label"], c["label"])}
        | ({"hidden": True} if c["label"] in hide else {})
        for c in classes
    ] + [dict(e) for e in cfg.get("extra_classes", [])]


def build(fetch=_get, layers=LAYERS) -> dict:
    caps = parse_layers(fetch(CAPABILITIES), {v["gibsId"] for v in layers.values()})
    out = {}
    for key, cfg in layers.items():
        c = caps[cfg["gibsId"]]
        entry = {
            "gibsId": cfg["gibsId"],
            "legend": cfg["legend"],
            **{k: c[k] for k in ("tileMatrixSet", "maximumLevel", "format", "times")},
        }
        if cfg.get("colormap", True):
            if not c["colormapUrl"]:
                raise LookupError(
                    f"{key}: GIBS lists no v1.3 colour map for {cfg['gibsId']}"
                )
            entry |= parse_colormap(fetch(c["colormapUrl"]))
        if {"labels", "hide", "extra_classes"} & cfg.keys():
            if "classes" not in entry:
                raise LookupError(f"{key}: labels/hide/extra_classes given but {cfg['gibsId']} has no classes")
            entry["classes"] = configure_classes(key, entry["classes"], cfg, entry.get("noData", ()))
        if cfg.get("discardForeignTiles"):
            if "classes" not in entry:
                raise LookupError(f"{key}: discardForeignTiles given but {cfg['gibsId']} has no classes")
            entry["discardForeignTiles"] = True
        if not c["times"] and "asOf" not in cfg:
            raise LookupError(
                f"{key}: GIBS serves no dates and LAYERS gives no asOf for {cfg['gibsId']}"
            )
        if c["times"] and "asOf" in cfg:
            raise LookupError(
                f"{key}: GIBS serves dates, so asOf would hide them for {cfg['gibsId']}"
            )
        if "asOf" in cfg:
            entry["asOf"] = cfg["asOf"]
        out[key] = entry
    return {
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "layers": out,
    }


def main(argv=None, fetch=_get, layers=LAYERS) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("public/data/gibs.json"))
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    doc = build(fetch, layers)
    write_atomic(a.out, doc)
    log.info(
        "wrote %s: %s",
        a.out,
        ", ".join(
            f"{k} ({len(v['times'])} intervals)" for k, v in doc["layers"].items()
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
