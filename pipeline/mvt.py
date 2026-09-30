"""Read GBIF's binned occurrence count tiles (Mapbox Vector Tile 2.1) with the stdlib.

GBIF's maps API (`/v2/map/occurrence/{density,adhoc}/{z}/{x}/{y}.mvt?bin=square&squareSize=N`) returns
one layer, `occurrence`, of square polygons, each tagged `total` = the number of records in the square.
Only what the geomodel harness needs is decoded: each square's bounds in tile units and its total.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any


class MvtError(ValueError):
    pass


@dataclass(frozen=True)
class Cell:
    x0: int
    y0: int
    x1: int
    y1: int
    total: int


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        if i >= len(buf):
            raise MvtError("truncated varint")
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def _fields(buf: bytes) -> Iterator[tuple[int, int, Any]]:
    """Yield (field number, wire type, value) for one protobuf message; value is bytes for wire type 2."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            val, i = _varint(buf, i)
        elif wire == 2:
            n, i = _varint(buf, i)
            val, i = buf[i : i + n], i + n
        elif wire == 1:
            val, i = buf[i : i + 8], i + 8
        elif wire == 5:
            val, i = buf[i : i + 4], i + 4
        else:
            raise MvtError(f"unsupported wire type {wire}")
        yield num, wire, val


def _packed(buf: bytes) -> list[int]:
    out, i = [], 0
    while i < len(buf):
        v, i = _varint(buf, i)
        out.append(v)
    return out


def _unzigzag(n: int) -> int:
    return (n >> 1) ^ -(n & 1)


def _value(buf: bytes) -> int | float | str | bool:
    for num, _wire, val in _fields(buf):
        if num == 1:
            return val.decode()
        if num in (4, 5):
            return val
        if num == 6:
            return _unzigzag(val)
        if num == 7:
            return bool(val)
        if num in (2, 3):
            return struct.unpack("<f" if num == 2 else "<d", val)[0]
    raise MvtError("empty value")


def _bounds(geometry: list[int]) -> tuple[int, int, int, int]:
    x = y = 0
    xs, ys, i = [], [], 0
    while i < len(geometry):
        cmd, count = geometry[i] & 7, geometry[i] >> 3
        i += 1
        if cmd == 7:  # ClosePath has no parameters
            continue
        if cmd not in (1, 2):
            raise MvtError(f"unknown geometry command {cmd}")
        for _ in range(count):
            x += _unzigzag(geometry[i])
            y += _unzigzag(geometry[i + 1])
            i += 2
            xs.append(x)
            ys.append(y)
    if not xs:
        raise MvtError("feature without geometry")
    return min(xs), min(ys), max(xs), max(ys)


def cells(tile: bytes) -> list[Cell]:
    """Every square in the tile's `occurrence` layer. GBIF sends an empty body for a tile with no records."""
    if not tile:
        return []
    for num, _wire, layer in _fields(tile):
        if num != 3:
            continue
        name, keys, values, features = None, [], [], []
        for lnum, _lw, lval in _fields(layer):
            if lnum == 1:
                name = lval.decode()
            elif lnum == 2:
                features.append(lval)
            elif lnum == 3:
                keys.append(lval.decode())
            elif lnum == 4:
                values.append(_value(lval))
        if name != "occurrence":
            continue
        out = []
        for feature in features:
            tags, geometry = [], []
            for fnum, _fw, fval in _fields(feature):
                if fnum == 2:
                    tags = _packed(fval)
                elif fnum == 4:
                    geometry = _packed(fval)
            props = {keys[tags[k]]: values[tags[k + 1]] for k in range(0, len(tags), 2)}
            if "total" not in props:
                raise MvtError(f"feature without a total: {props}")
            out.append(Cell(*_bounds(geometry), total=int(props["total"])))
        return out
    raise MvtError("tile has no 'occurrence' layer")
