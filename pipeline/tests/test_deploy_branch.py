"""deploy_pages.sh run whole, for real, against a local bare repo standing in for GitHub: PAGES_BRANCH sends the deploy to
another branch (a trial push from a new host) and leaves gh-pages alone; unset, it still publishes gh-pages. The build
step is a stub npx on the script's own PATH ($HOME/.local/node24/bin), so everything after it is the shipped code."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy_pages.sh"
ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@t",
}


def _git(cwd, *args):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **ENV},
    ).stdout.strip()


def _setup(tmp: Path, branches: list[str]):
    """A bare 'GitHub' whose `branches` all point at one published commit, and a site repo whose origin it is."""
    origin, seed, site, home = (
        tmp / "origin.git",
        tmp / "seed",
        tmp / "site",
        tmp / "home",
    )
    _git(tmp, "init", "-q", "--bare", str(origin))
    seed.mkdir()
    _git(seed, "init", "-q")
    (seed / "index.html").write_text("old site")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-qm", "published")
    for b in branches:
        _git(seed, "push", "-q", str(origin), f"HEAD:refs/heads/{b}")
    tip = _git(seed, "rev-parse", "HEAD")
    (site / "pipeline").mkdir(parents=True)
    shutil.copy(SCRIPT, site / "pipeline" / "deploy_pages.sh")
    _git(site, "init", "-q")
    _git(site, "add", "-A")
    _git(site, "commit", "-qm", "src")
    _git(site, "remote", "add", "origin", str(origin))
    npx = home / ".local" / "node24" / "bin" / "npx"
    npx.parent.mkdir(parents=True)
    npx.write_text(
        "#!/bin/sh\nmkdir -p dist/assets\necho x > dist/assets/a.js\n"
        "echo '<script src=\"/wildeye/assets/a.js\"></script>' > dist/index.html\n"
    )
    npx.chmod(0o755)
    return origin, site, home, tip


def _deploy(tmp, site, home, extra):
    env = {
        **{k: v for k, v in os.environ.items() if k != "PAGES_BRANCH"},
        **ENV,
        "HOME": str(home),
        "TMPDIR": str(tmp),
        "WILDEYE_PYTHON": sys.executable,
        **extra,
    }
    out = subprocess.run(
        ["bash", str(site / "pipeline" / "deploy_pages.sh")],
        cwd=tmp,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert out.returncode == 0, out.stdout + out.stderr
    return out


def test_pages_branch_sends_the_deploy_elsewhere_and_leaves_gh_pages(tmp_path: Path):
    origin, site, home, tip = _setup(tmp_path, ["gh-pages", "zz-trial"])
    out = _deploy(tmp_path, site, home, {"PAGES_BRANCH": "zz-trial"})
    assert _git(origin, "rev-parse", "gh-pages") == tip, (
        "gh-pages moved on a trial deploy"
    )
    assert (
        _git(origin, "rev-parse", "zz-trial^") == tip
    )  # built on the remote tip: a delta, not an orphan re-upload
    assert _git(origin, "show", "zz-trial:assets/a.js") == "x"
    assert "pushed zz-trial" in out.stdout


def test_unset_pages_branch_still_publishes_gh_pages(tmp_path: Path):
    origin, site, home, tip = _setup(tmp_path, ["gh-pages"])
    out = _deploy(tmp_path, site, home, {})
    assert _git(origin, "rev-parse", "gh-pages^") == tip
    assert _git(origin, "show", "gh-pages:assets/a.js") == "x"
    assert "pushed gh-pages" in out.stdout
