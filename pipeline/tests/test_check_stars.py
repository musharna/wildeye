"""check_stars.sh, the weekly star check, run for real: a sandbox PATH holds the tools it needs, a stub curl that
answers from a file, the real jq, and no gh (the cron host msi-4080 has no gh login). One test reads the live API."""

import os
import shutil
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "check_stars.sh"
TOOLS = ["bash", "jq", "date", "dirname", "cat"]


def _sandbox(tmp_path: Path, body: str, rc: int = 0) -> dict:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    for tool in TOOLS:
        real = shutil.which(tool)
        assert real, f"{tool} not installed"
        link = bin_dir / tool
        if not link.exists():
            link.symlink_to(real)
    (tmp_path / "body.json").write_text(body)
    curl = bin_dir / "curl"
    curl.write_text(
        f'#!{shutil.which("bash")}\ncat "{tmp_path / "body.json"}"\nexit {rc}\n'
    )
    curl.chmod(0o755)
    return {
        "PATH": str(bin_dir),
        "MARKER": str(tmp_path / "NOTIFY_OTN_DUE"),
        "THRESHOLD": "2",
    }


def _run(env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_marker_appears_at_the_threshold_once_and_not_below(tmp_path: Path):
    marker = tmp_path / "NOTIFY_OTN_DUE"
    below = _run(_sandbox(tmp_path, '{"stargazers_count": 1}'))
    assert below.returncode == 0, below.stderr
    assert below.stdout.rstrip().endswith("stars=1")
    assert not marker.exists(), "one star is below the threshold"
    at = _run(_sandbox(tmp_path, '{"stargazers_count": 2}'))
    assert at.returncode == 0, at.stderr
    assert "NOTIFY_OTN_DUE created" in at.stdout
    first = marker.read_text()
    assert first.startswith("stars=2 on ") and "data@oceantrack.org" in first
    again = _run(_sandbox(tmp_path, '{"stargazers_count": 7}'))
    assert again.returncode == 0, again.stderr
    assert "created" not in again.stdout and marker.read_text() == first, (
        "an existing marker is left as it was"
    )


def test_a_failed_or_odd_answer_fails_loud_and_leaves_no_marker(tmp_path: Path):
    marker = tmp_path / "NOTIFY_OTN_DUE"
    down = _run(_sandbox(tmp_path, "", rc=22))  # curl -f on an HTTP error
    assert down.returncode != 0
    assert not marker.exists()
    limited = _run(_sandbox(tmp_path, '{"message": "API rate limit exceeded"}'))
    assert limited.returncode == 1
    assert "is not a count: 'null'" in limited.stderr
    assert not marker.exists()
    ok = _run(_sandbox(tmp_path, '{"stargazers_count": 5}'))
    assert ok.returncode == 0, (
        "positive control: the same sandbox with a real count works: " + ok.stderr
    )
    assert marker.exists()


def test_the_live_api_answers_a_count(tmp_path: Path):
    env = {
        "PATH": os.environ["PATH"],
        "MARKER": str(tmp_path / "NOTIFY_OTN_DUE"),
        "THRESHOLD": "1000000",
    }
    out = _run(env)
    assert out.returncode == 0, out.stderr
    stars = out.stdout.rstrip().rsplit("stars=", 1)[1]
    assert stars.isdigit(), out.stdout
    assert not (tmp_path / "NOTIFY_OTN_DUE").exists()
