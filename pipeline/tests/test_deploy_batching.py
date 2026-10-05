"""deploy_pages.sh's batching block, run for real in a scratch git repo: new or changed data files go up in commits
of at most BATCH_MB, and the manifests go in the last commit, so every tip the uplink leaves behind is a site whose
manifest names only files it has. The block is cut out of the script itself, so the test runs the shipped code.
"""

import os
import re
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy_pages.sh"
FILE_BYTES = 400_000  # BATCH_MB=1 below: two files to a part


def _block() -> str:
    text = SCRIPT.read_text()
    m = re.search(r"^BATCH_MB=.*?^fi$", text, re.MULTILINE | re.DOTALL)
    assert m, "batching block not found in deploy_pages.sh"
    return m.group(0)


def _git(wt, *args):
    return subprocess.run(
        ["git", *args], cwd=wt, check=True, capture_output=True, text=True
    ).stdout


def _deploy(tmp_path, wt):
    """Stage everything, run the block and a final publish; the files of each commit, oldest first."""
    _git(wt, "add", "-A")
    harness = tmp_path / "run.sh"
    harness.write_text(
        f"WT={wt}; STAMP=t; SRC=test\n"
        'publish() { (cd "$WT" && git commit -qm "$1" && printf "COMMIT\\t%s\\t" "$1" '
        '&& git show --name-only --format= HEAD | tr "\\n" " " && echo); }\n'
        f"{_block()}\n"
        'publish "deploy t from test"\n'
    )
    out = subprocess.run(
        ["bash", str(harness)],
        check=False,  # the assert below shows stderr
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "BATCH_MB": "1"},
    )
    assert out.returncode == 0, out.stderr
    commits = [
        line.split("\t")
        for line in out.stdout.splitlines()
        if line.startswith("COMMIT\t")
    ]
    return [(msg, set(files.split())) for _, msg, files in commits]


def _write_tiles(wt, seed, tiles="data/protected/tiles/7/{i}/0.png", manifest="data/protected_areas.json"):
    for i in range(5):
        p = wt / tiles.format(i=i)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(bytes([seed]) * FILE_BYTES)
    (wt / manifest).write_text(f'{{"release": "{seed}"}}')


def _check_batched(commits, tiles, manifest="data/protected_areas.json"):
    *parts, final = commits
    assert len(parts) == 3, [
        m for m, _ in commits
    ]  # 5 files of 0.4 MB, at most 1 MB a part
    assert set().union(*(f for _, f in parts)) == tiles
    for _, files in parts:
        assert len(files) <= 2 and manifest not in files
    assert manifest in final[1] and not final[1] & tiles


def _repo(tmp_path):
    wt = tmp_path / "wt"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.name", "test")
    _git(wt, "config", "user.email", "test@example.invalid")
    _git(wt, "commit", "-q", "--allow-empty", "-m", "base")
    return wt


def test_new_and_rewritten_protected_tiles_go_up_in_batches_with_the_manifest_last(
    tmp_path,
):
    wt = _repo(tmp_path)
    tiles = {f"data/protected/tiles/7/{i}/0.png" for i in range(5)}

    # first deploy: every tile is new (the positive control; the old filter, added files only, passed this)
    _write_tiles(wt, 1)
    _check_batched(_deploy(tmp_path, wt), tiles)

    # a rebuild rewrites every tile in place: changed paths, not new ones, and still 2 MB to push
    _write_tiles(wt, 2)
    _check_batched(_deploy(tmp_path, wt), tiles)

    # every change went up: nothing left staged or unstaged
    assert _git(wt, "status", "--porcelain") == ""


def test_a_layer_the_script_does_not_name_goes_up_in_batches_with_its_manifest_last(
    tmp_path,
):
    # Wave 2 (2026-10-04) added four tiled layers, ~90 MB, none in the old list (birds_archive, protected):
    # they went up as one push the uplink drops. Any directory under data/ batches; its data/<layer>.json goes last.
    wt = _repo(tmp_path)
    tiles = {f"data/seagrass/2019_2020/9/{i}/0.png" for i in range(5)}
    _write_tiles(wt, 1, "data/seagrass/2019_2020/9/{i}/0.png", "data/seagrass.json")
    _check_batched(_deploy(tmp_path, wt), tiles, "data/seagrass.json")
    assert _git(wt, "status", "--porcelain") == ""
