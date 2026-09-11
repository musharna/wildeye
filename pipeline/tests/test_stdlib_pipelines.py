"""Pipelines that only need the stdlib must import without the NEXRAD stack (boto3/pyart/numpy).

Cron runs under system python3; 2026-09-11 all daily jobs died at import because
write_atomic lived in build_birds.py, which imports nexrad -> boto3.
"""
import subprocess, sys
from pathlib import Path

ROOT = Path(__file__).parents[2]
HEAVY = ["boto3", "botocore", "pyart", "numpy", "PIL"]


def _import_with_blocked(modules: str) -> subprocess.CompletedProcess:
    code = (
        "import sys\n"
        + "".join(f"sys.modules[{m!r}] = None\n" for m in HEAVY)
        + f"import {modules}\nprint('ok')\n"
    )
    return subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=60)


def test_stdlib_pipelines_import_without_heavy_deps():
    r = _import_with_blocked("pipeline.occurrences, pipeline.aloft, pipeline.atomic")
    assert r.returncode == 0 and "ok" in r.stdout, r.stderr[-800:]


def test_positive_control_heavy_pipeline_does_need_stack():
    # The blocker actually blocks: build_birds must fail under the same conditions.
    r = _import_with_blocked("pipeline.build_birds")
    assert r.returncode != 0 and "ModuleNotFoundError" in r.stderr


def test_runners_pin_interpreter():
    # cron PATH has no miniconda; bare `python3` = /usr/bin/python3 with no deps.
    for sh in sorted((ROOT / "pipeline").glob("run_*.sh")):
        text = sh.read_text()
        assert "WILDEYE_PYTHON" in text, sh.name
        assert " python3 -m " not in text, f"{sh.name} still execs bare python3"
