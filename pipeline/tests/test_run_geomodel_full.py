"""pipeline/run_geomodel_full.sh and run_geomodel_check.sh run whole, with WILDEYE_PYTHON pointing at a stand-in that
records each module it is asked to run and exits with the code given for it, so the order of the check and the listing,
what a failed check stops, and what the verdicts lock refuses are read from the real scripts. The lock is held with
flock(2), the call flock(1) makes."""

import fcntl
import json
import os
import shutil
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]

FAKE_PY = r"""
import json, os, sys
with open(os.environ["FAKE_PY_CALLS"], "a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\n")
sys.exit(int(os.environ.get("FAKE_EXIT_" + sys.argv[2].rsplit(".", 1)[1], "0")))
"""


class _HeldLock:
    """Another check holding the verdicts, as flock(1) would."""

    def __init__(self, path: Path):
        self.path = path

    def __enter__(self):
        self.fh = open(self.path, "w")
        fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return self

    def __exit__(self, *exc):
        self.fh.close()


def _run(tmp_path, script="run_geomodel_full.sh", hold_verdicts=False, **exits):
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
    lock = root / "public" / "data" / ".geomodel_verdicts.lock"
    with _HeldLock(lock) if hold_verdicts else nullcontext():
        r = subprocess.run(
            ["bash", str(root / "pipeline" / script)],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,  # the exit code is what the tests read
        )
    args = (
        [json.loads(line) for line in calls.read_text().splitlines()]
        if calls.exists()
        else []
    )
    return r.returncode, [a[1] for a in args], args


def test_the_daily_run_checks_a_new_model_before_listing(tmp_path):
    code, modules, args = _run(tmp_path, geomodel_species=3)
    assert modules == ["pipeline.geomodel_check", "pipeline.geomodel_species"]
    assert "--if-new-model" in args[0] and "--if-new-model" not in args[1]
    # the listing's own exit: species still unchecked, the next day's run goes on
    assert code == 3


def test_a_failed_check_stops_the_listing(tmp_path):
    code, modules, _ = _run(tmp_path, geomodel_check=2)
    assert code == 2 and modules == ["pipeline.geomodel_check"]
    # positive control in the same test: a check that passes (or has nothing to do) goes on to the listing
    code, modules, _ = _run(tmp_path / "again", geomodel_check=0)
    assert code == 0 and modules == [
        "pipeline.geomodel_check",
        "pipeline.geomodel_species",
    ]


def test_a_check_does_not_start_while_another_holds_the_verdicts(tmp_path):
    # review of PR #142: the daily run and the monthly cron both run the check, which writes the verdicts (and the
    # attempts file) whole; two at once and the last to finish discards the other's hours of work
    code, modules, _ = _run(
        tmp_path, script="run_geomodel_check.sh", hold_verdicts=True
    )
    assert code == 75 and modules == []
    # positive control in the same test: with the lock free the check runs
    code, modules, _ = _run(tmp_path / "free", script="run_geomodel_check.sh")
    assert code == 0 and modules == ["pipeline.geomodel_check"]


def test_the_daily_run_still_lists_while_another_check_holds_the_verdicts(tmp_path):
    # the other check (the monthly one) is on the verdicts; the listing goes on and refuses verdicts of another model
    # itself, so a day's tiles are not lost to a check that would have had nothing to do
    code, modules, _ = _run(tmp_path, hold_verdicts=True, geomodel_species=3)
    assert code == 3 and modules == ["pipeline.geomodel_species"]
