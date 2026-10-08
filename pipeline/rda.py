"""Read data frames from an R `.rda` file (gzip, XDR serialisation version 2 or 3) without R.

CI has no R and its pipeline env has no R reader package, so this reads the one shape the penguin release ships
(`pipeline/penguins.py`; spec docs/superpowers/specs/2026-10-07-penguins-design.md): a save() file holding data
frames whose columns are character, integer, logical or double vectors (a Date column is a double with class "Date").
Anything else in the stream (a closure, an environment, an ALTREP vector, a factor, a long vector) stops the read with
the type it met, so an unsupported release fails loud instead of being read wrong. Format: R Internals, section 1.8
"Serialization Formats" (XDR = big-endian; flags word: type in bits 0-7, object bit 8, attribute bit 9, tag bit 10,
levels from bit 12).
"""

from __future__ import annotations

import gzip
import math
import struct
from pathlib import Path

NILVALUE = 254
REFSXP = 255
SYMSXP, LISTSXP, CHARSXP = 1, 2, 9
LGLSXP, INTSXP, REALSXP, STRSXP, VECSXP = 10, 13, 14, 16, 19
NA_INTEGER = -(2**31)
NA_REAL_LOW_WORD = (
    1954  # R's NA_real_ is the NaN whose low word is 1954; other NaNs are NaN, not NA
)
UTF8_MASK, LATIN1_MASK, BYTES_MASK, ASCII_MASK = 1 << 3, 1 << 2, 1 << 1, 1 << 6
TYPE_NAMES = {
    3: "CLOSXP",
    4: "ENVSXP",
    6: "LANGSXP",
    238: "ALTREP_SXP",
    242: "EMPTYENV",
    253: "GLOBALENV",
}


class RdaError(ValueError):
    pass


class _Reader:
    def __init__(self, data: bytes):
        self.b = data
        self.i = 0
        self.refs: list = []

    def take(self, n: int) -> bytes:
        if self.i + n > len(self.b):
            raise RdaError(
                f"stream ends at byte {len(self.b)}, wanted {n} more at {self.i}"
            )
        out = self.b[self.i : self.i + n]
        self.i += n
        return out

    def int(self) -> int:
        return struct.unpack(">i", self.take(4))[0]

    def length(self) -> int:
        n = self.int()
        if n == -1:
            raise RdaError("a long vector (over 2^31 - 1 elements) is not supported")
        if n < 0:
            raise RdaError(f"negative length {n} at byte {self.i - 4}")
        return n

    def charsxp(self, flags: int) -> str | None:
        n = self.int()
        if n == -1:
            return None  # NA_character_
        raw = self.take(n)
        levels = flags >> 12
        if levels & LATIN1_MASK:
            return raw.decode("latin-1")
        if levels & BYTES_MASK:
            raise RdaError(
                f"a bytes-encoded string at byte {self.i - n} is not supported"
            )
        # UTF-8, ASCII, or native (this release was written in a UTF-8 session: header native encoding checked)
        return raw.decode("utf-8")

    def item(self):
        flags = self.int()
        t = flags & 0xFF
        has_attr = bool(flags & (1 << 9))
        has_tag = bool(flags & (1 << 10))
        if t == NILVALUE:
            return None
        if t == REFSXP:
            idx = flags >> 8 or self.int()
            return self.refs[idx - 1]
        if t == SYMSXP:
            name = self.item()  # a CHARSXP
            sym = Symbol(name)
            self.refs.append(sym)
            return sym
        if t == LISTSXP:
            out = []  # a pairlist as [(tag, value)], read iteratively along its CDR
            while True:
                attr = self.item() if has_attr else None
                if attr is not None:
                    raise RdaError("a pairlist with attributes is not supported")
                tag = self.item() if has_tag else None
                out.append((tag.name if isinstance(tag, Symbol) else None, self.item()))
                flags = self.int()
                t = flags & 0xFF
                if t == NILVALUE:
                    return out
                if t != LISTSXP:
                    raise RdaError(f"pairlist continues with type {t}, not LISTSXP")
                has_attr = bool(flags & (1 << 9))
                has_tag = bool(flags & (1 << 10))
        if t == CHARSXP:
            return self.charsxp(flags)
        if t in (LGLSXP, INTSXP):
            n = self.length()
            vals = struct.unpack(f">{n}i", self.take(4 * n))
            out = [
                None if v == NA_INTEGER else (bool(v) if t == LGLSXP else v)
                for v in vals
            ]
        elif t == REALSXP:
            n = self.length()
            raw = self.take(8 * n)
            out = []
            for k in range(n):
                (v,) = struct.unpack_from(">d", raw, 8 * k)
                if (
                    math.isnan(v)
                    and struct.unpack_from(">I", raw, 8 * k + 4)[0] == NA_REAL_LOW_WORD
                ):
                    out.append(None)
                else:
                    out.append(v)
        elif t == STRSXP:
            n = self.length()
            out = []
            for _ in range(n):
                f = self.int()
                if f & 0xFF != CHARSXP:
                    raise RdaError(
                        f"a string vector element of type {f & 0xFF}, not CHARSXP"
                    )
                out.append(self.charsxp(f))
        elif t == VECSXP:
            n = self.length()
            out = [self.item() for _ in range(n)]
        else:
            raise RdaError(
                f"R type {TYPE_NAMES.get(t, t)} at byte {self.i - 4} is not supported"
            )
        attrs = dict(self.item()) if has_attr else {}
        return Vector(t, out, attrs)


class Symbol:
    def __init__(self, name: str):
        self.name = name


class Vector:
    def __init__(self, kind: int, values: list, attrs: dict):
        self.kind = kind
        self.values = values
        self.attrs = attrs

    def attr(self, name: str):
        a = self.attrs.get(name)
        return a.values if isinstance(a, Vector) else a


def read_objects(path: Path) -> dict:
    """{name: object} for every object a save() file holds."""
    data = gzip.decompress(Path(path).read_bytes())
    if data[:5] not in (b"RDX2\n", b"RDX3\n") or data[5:7] != b"X\n":
        raise RdaError(f"{path}: not an XDR .rda file (starts {data[:7]!r})")
    r = _Reader(data[7:])
    version = r.int()
    r.int()  # the R version that wrote it
    r.int()  # the oldest R that can read it
    if version == 3:
        enc = r.take(r.int()).decode("ascii")
        if enc.upper().replace("-", "") != "UTF8":
            raise RdaError(f"{path}: written in native encoding {enc!r}, not UTF-8")
    elif version != 2:
        raise RdaError(f"{path}: serialisation version {version} is not 2 or 3")
    top = r.item()
    if not isinstance(top, list):
        raise RdaError(f"{path}: the top object is not a pairlist of saved objects")
    if r.i != len(r.b):
        raise RdaError(f"{path}: {len(r.b) - r.i} bytes left after the saved objects")
    return dict(top)


def data_frame(path: Path, name: str) -> list[dict]:
    """The rows of the data frame `name` in `path`, as dicts; a Date column holds ISO strings, NA is None."""
    objs = read_objects(path)
    if name not in objs:
        raise RdaError(f"{path}: no object {name!r} (holds {sorted(objs)})")
    df = objs[name]
    if (
        not isinstance(df, Vector)
        or df.kind != VECSXP
        or "data.frame" not in (df.attr("class") or [])
    ):
        raise RdaError(f"{path}: {name} is not a data.frame")
    names = df.attr("names")
    cols = []
    for col_name, col in zip(names, df.values, strict=True):
        if not isinstance(col, Vector) or col.kind not in (
            LGLSXP,
            INTSXP,
            REALSXP,
            STRSXP,
        ):
            raise RdaError(f"{name}${col_name}: not an atomic vector")
        cls = col.attr("class") or []
        if cls == ["Date"]:
            vals = [None if v is None else _iso_date(v) for v in col.values]
        elif cls:
            raise RdaError(
                f"{name}${col_name}: class {cls} is not supported (a factor would read as its codes)"
            )
        else:
            vals = col.values
        cols.append(vals)
    n = {len(c) for c in cols}
    if len(n) > 1:
        raise RdaError(f"{name}: columns of different lengths {sorted(n)}")
    rows = n.pop() if n else 0
    rn = df.attr("row.names")
    # compact row names c(NA, -n) or c(NA, n): their count must agree with the columns
    if rn and len(rn) == 2 and rn[0] is None and abs(rn[1]) != rows:
        raise RdaError(f"{name}: row.names say {abs(rn[1])} rows, columns hold {rows}")
    return [dict(zip(names, vals, strict=True)) for vals in zip(*cols, strict=True)]


def _iso_date(days: float) -> str:
    import datetime as dt

    if days != int(days):
        raise RdaError(f"a Date of {days} days is not a whole day")
    return (dt.date(1970, 1, 1) + dt.timedelta(days=int(days))).isoformat()
