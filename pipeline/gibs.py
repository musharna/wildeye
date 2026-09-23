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
    },
    "gibs-biomass": {
        "gibsId": "GEDI_ISS_L4B_Aboveground_Biomass_Density_Mean_201904-202303",
        "legend": "Aboveground biomass density, 2019–2023 composite",
    },
}


def _get(url: str, timeout: int = 120, tries: int = 4) -> bytes:
    """GET with UA; retries 5xx / connection errors with backoff, never swallows a 4xx."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for k in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
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
    root = ET.fromstring(xml)
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
    The data map is the one whose legend has more than one entry; 'No Data'/'Fill' maps have one."""
    root = ET.fromstring(xml)
    data = [
        cm
        for cm in root.iter("ColorMap")
        if cm.find("Legend") is not None and len(cm.find("Legend")) > 1
    ]
    if len(data) != 1:
        raise ValueError(f"expected one data colour map, found {len(data)}")
    cm = data[0]
    legend = cm.find("Legend")
    entries = [
        ([int(c) for c in e.get("rgb").split(",")], e.get("tooltip")) for e in legend
    ]
    if legend.get("type") == "classification":
        return {"classes": [{"label": label, "rgb": rgb} for rgb, label in entries]}
    idx = [round(i * (len(entries) - 1) / (RAMP_STOPS - 1)) for i in range(RAMP_STOPS)]
    unit = cm.get("units")
    return {
        "ramp": {
            "stops": [entries[i][0] for i in idx],
            "min": _num(legend.get("minLabel")),
            "max": _num(legend.get("maxLabel")),
            "unit": f" {unit}" if unit else "",
        }
    }


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
        if c["colormapUrl"]:
            entry |= parse_colormap(fetch(c["colormapUrl"]))
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
