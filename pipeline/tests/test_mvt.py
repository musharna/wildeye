"""pipeline.mvt reads GBIF's binned count tiles (Mapbox Vector Tile 2.1) without a protobuf package."""

from pathlib import Path

import pytest

from pipeline import mvt

FIXTURE = (
    Path(__file__).parent / "fixtures" / "gbif_aves_z2_1_1_sq64.mvt"
)  # live GBIF tile, 2026-09-29


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _field(num: int, wire: int, payload: bytes) -> bytes:
    key = _varint(num << 3 | wire)
    return key + (_varint(len(payload)) + payload if wire == 2 else payload)


def _zz(n: int) -> int:
    return (n << 1) ^ (n >> 31)


def _square(x0: int, y0: int, size: int) -> bytes:
    # MoveTo(x0,y0) LineTo(+size,0)(0,+size)(-size,0) ClosePath
    cmds = [
        1 << 3 | 1,
        _zz(x0),
        _zz(y0),
        3 << 3 | 2,
        _zz(size),
        _zz(0),
        _zz(0),
        _zz(size),
        _zz(-size),
        _zz(0),
        1 << 3 | 7,
    ]
    return b"".join(_varint(c) for c in cmds)


def _tile(features: list[tuple[int, int, int, int]]) -> bytes:
    """features: (x0, y0, size, total) squares in one 'occurrence' layer."""
    values, feats = [], b""
    for x0, y0, size, total in features:
        values.append(total)
        tags = _varint(0) + _varint(len(values) - 1)
        feats += _field(
            2,
            2,
            _field(2, 2, tags)
            + _field(3, 0, _varint(3))
            + _field(4, 2, _square(x0, y0, size)),
        )
    layer = _field(1, 2, b"occurrence") + feats + _field(3, 2, b"total")
    layer += b"".join(_field(4, 2, _field(5, 0, _varint(v))) for v in values)
    layer += _field(5, 0, _varint(4096)) + _field(15, 0, _varint(2))
    return _field(3, 2, layer)


def test_decodes_squares_and_counts_from_a_known_tile():
    cells = mvt.cells(_tile([(0, 0, 64, 7), (128, 64, 64, 300000)]))
    assert cells == [
        mvt.Cell(x0=0, y0=0, x1=64, y1=64, total=7),
        mvt.Cell(x0=128, y0=64, x1=192, y1=128, total=300000),
    ]


def test_rejects_a_tile_without_the_occurrence_layer():
    # GBIF returns an empty body for an empty tile; anything else without the layer is not a count tile.
    assert mvt.cells(b"") == []
    with pytest.raises(mvt.MvtError, match="occurrence"):
        mvt.cells(_field(3, 2, _field(1, 2, b"other") + _field(5, 0, _varint(4096))))


def test_reads_a_real_gbif_count_tile():
    cells = mvt.cells(FIXTURE.read_bytes())
    assert len(cells) > 500
    # squareSize=64 on a 4096 extent: every cell is a 64-unit square on the 64-unit grid
    assert all(c.x1 - c.x0 == 64 and c.y1 - c.y0 == 64 for c in cells)
    assert all(c.x0 % 64 == 0 and c.y0 % 64 == 0 for c in cells)
    assert all(c.total > 0 for c in cells)
    assert len({(c.x0, c.y0) for c in cells}) == len(cells)
    # Known answer (2026-09-29): GBIF's occurrence search for the same box (lon -90..0, lat 0..66.51326),
    # taxonKey 212, CC0 + CC BY, counted 932,732,274 records; the decoded squares sum to within 0.1% of it.
    assert abs(sum(c.total for c in cells) - 932_732_274) / 932_732_274 < 0.001
