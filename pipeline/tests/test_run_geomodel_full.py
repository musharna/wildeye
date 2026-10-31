"""pipeline/run_geomodel_full.sh run whole, with WILDEYE_PYTHON pointing at a stand-in that records each module it is
asked to run and exits with the code given for it, so the order of the check and the listing, and what a failed check
stops, are read from the real script."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]

FAKE_PY = r"""
import json, os, sys
with open(os.environ["FAKE_PY_CALLS"], "a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\n")
sys.exit(int(os.environ.get("FAKE_EXIT_" + sys.argv[2].rsplit(".", 1)[1], "0")))
"""


def _run(tmp_path, **exits):
    root = tmp_path / "repo"
    (root / "pipeline").mkdir(parents=True)
    (root / "public" / "data").mkdir(parents=True)
    for name in ("run_geomodel_full.sh", "run_geomodel_check.sh"):
        shutil.copy(PIPELINE / name, root / "pipeline" / name)
    fake = tmp_path / "fake_python"
    fake.write_text(f"#!{sys.executable}\n{FAKE_PY}")
    fake.chmod(0o755)
    calls = tmp_path / "calls.jsonl"
    env = {**os.environ, "WILDEYE_PYTHON": str(fake), "FAKE_PY_CALLS": str(calls)}
    env.update({f"FAKE_EXIT_{module}": str(code) for module, code in exits.items()})
    r = subprocess.run(
        ["bash", str(root / "pipeline" / "run_geomodel_full.sh")],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,  # the exit code is what the tests read
    )
    modules = (
        [json.loads(line)[1] for line in calls.read_text().splitlines()]
        if calls.exists()
        else []
    )
    args = (
        [json.loads(line) for line in calls.read_text().splitlines()]
        if calls.exists()
        else []
    )
    return r.returncode, modules, args


def test_the_daily_run_checks_a_new_model_before_listing(tmp_path):
    code, modules, args = _run(tmp_path, geomodel_species=3)
    assert modules == ["pipeline.geomodel_check", "pipeline.geomodel_species"]
    assert "--if-new-model" in args[0] and "--if-new-model" not in args[1]
    assert (
        code == 3
    )  # the listing's own exit: species still unchecked, the next day's run goes on


def test_a_failed_check_stops_the_listing(tmp_path):
    code, modules, _ = _run(tmp_path, geomodel_check=2)
    assert code == 2 and modules == ["pipeline.geomodel_check"]
    # positive control in the same test: a check that passes (or has nothing to do) goes on to the listing
    code, modules, _ = _run(tmp_path / "again", geomodel_check=0)
    assert code == 0 and modules == [
        "pipeline.geomodel_check",
        "pipeline.geomodel_species",
    ]
