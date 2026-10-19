"""deploy_pages.sh drops the tmp*.tmp a killed writer leaves in public/data, run for real on a scratch dist/: the line is
cut out of the script itself, so the test runs the shipped code."""

import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy_pages.sh"


def _line() -> str:
    lines = [x for x in SCRIPT.read_text().splitlines() if x.startswith("find dist -type f -name 'tmp*.tmp'")]
    assert len(lines) == 1, "tmp-file line not found in deploy_pages.sh"
    return lines[0]


def test_deploy_drops_unfinished_writes_and_ships_everything_else(tmp_path: Path):
    files = {
        "dist/data/tmpf9_virpb.tmp": b"",                 # the one that shipped (0 bytes: killed before a flush)
        "dist/data/birds/tmpab12cd.tmp": b'{"a":',        # partial, in a layer directory
        "dist/data/birds_nights.json": b"{}",
        "dist/data/tmp_tiles/0/0.png": b"png",            # a directory named tmp*: data
        "dist/data/attempt.tmp": b"x",                    # not mkstemp's tmp* name: left alone
        "dist/index.html": b"<html>",
    }
    for rel, data in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_bytes(data)
    out = subprocess.run(["bash", "-c", "set -euo pipefail\n" + _line()], cwd=tmp_path,
                         capture_output=True, text=True, timeout=60, check=False)
    assert out.returncode == 0, out.stderr
    left = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*") if p.is_file())
    assert left == ["dist/data/attempt.tmp", "dist/data/birds_nights.json", "dist/data/tmp_tiles/0/0.png",
                    "dist/index.html"]
    assert sorted(out.stderr.splitlines()) == [
        "not shipped (unfinished write): dist/data/birds/tmpab12cd.tmp",
        "not shipped (unfinished write): dist/data/tmpf9_virpb.tmp",
    ]
