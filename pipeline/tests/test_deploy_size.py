"""deploy_pages.sh's size line, run as written on a tree of small files (PR #91 review)."""
import re
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "deploy_pages.sh"


def test_the_deploy_reports_bytes_not_disk_blocks(tmp_path):
    """`du -sh` printed 1.1G for an 866 MB site on 2026-10-16: each of ~87,000 small files counted as a 4 KB block. 400
    files of 100 bytes are 40 kB of data and 1.6 MB of blocks; the line must say the former, and count the files."""
    line, = [ln for ln in SCRIPT.read_text().splitlines() if ln.startswith('echo "dist size:')]
    d = tmp_path / "dist" / "data"
    d.mkdir(parents=True)
    for i in range(400):
        (d / f"{i}.json").write_bytes(b"x" * 100)
    out = subprocess.run(["bash", "-c", line], cwd=tmp_path, capture_output=True, text=True, check=True).stdout.strip()
    m = re.fullmatch(r"dist size: ([\d.]+)([KMG]) in (\d+) files", out)
    assert m, out
    size, unit, files = float(m[1]), m[2], int(m[3])
    assert files == 400 and unit == "K" and 39 <= size < 100, f"{out}: 40 kB of files plus their directories"
