"""deploy_pages.sh --birds (the hourly night deploy) and the locks it shares with run_birds.sh, run whole and for real: a
local bare repo stands in for GitHub, `flock` is the real util-linux one, and the only stubs are the build (npx) and the
birds builder (WILDEYE_PYTHON for run_birds.sh), each of which reports whether the birds lock was held while it ran."""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@t",
}
BIRDS = [
    "birds.geojson",
    "birds_field.json",
    "birds_field.png",
    "birds_nights.json",
    "birds_seasons.json",
]


def _git(cwd, *args):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **ENV},
    ).stdout.strip()


def _setup(tmp: Path, published: bool = True):
    """A bare 'GitHub' whose gh-pages holds an old site, and a site repo whose public/data has newer birds files."""
    origin, seed, site, home, locks = (
        tmp / n for n in ("origin.git", "seed", "site", "home", "locks")
    )
    locks.mkdir(parents=True)
    _git(tmp, "init", "-q", "--bare", str(origin))
    old = {
        "index.html": "old site",
        "data/other.json": "old",
        "data/birds_ppi/A.png": "oldA",
        "data/birds_ppi/B.png": "oldB",
    }
    old |= {f"data/{f}": "old" for f in BIRDS}
    for rel, text in old.items():
        (seed / rel).parent.mkdir(parents=True, exist_ok=True)
        (seed / rel).write_text(text)
    _git(seed, "init", "-q")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-qm", "published")
    if published:
        _git(seed, "push", "-q", str(origin), "HEAD:refs/heads/gh-pages")
    tip = _git(seed, "rev-parse", "HEAD")
    (site / "pipeline").mkdir(parents=True)
    for s in ("deploy_pages.sh", "run_birds.sh"):
        shutil.copy(PIPELINE / s, site / "pipeline" / s)
    _git(site, "init", "-q")
    _git(site, "add", "-A")
    _git(site, "commit", "-qm", "src")
    _git(site, "remote", "add", "origin", str(origin))
    new = {
        "data/other.json": "new",
        "data/birds_ppi/A.png": "newA",
        "data/birds_ppi/C.png": "newC",
    }
    new |= {f"data/{f}": "new" for f in BIRDS}
    new |= {
        "data/birds_ppi/A.tmp.png": "half",
        "data/birds_ppi/tmpk3j2.tmp": "half",
    }  # killed writers' leftovers
    for rel, text in new.items():
        (site / "public" / rel).parent.mkdir(parents=True, exist_ok=True)
        (site / "public" / rel).write_text(text)
    # the build stub records whether the birds lock was held while it ran (`flock -n` fails on a held lock)
    npx = home / ".local" / "node24" / "bin" / "npx"
    npx.parent.mkdir(parents=True)
    npx.write_text(
        "#!/bin/sh\nmkdir -p dist/assets\necho x > dist/assets/a.js\n"
        "echo '<script src=\"/wildeye/assets/a.js\"></script>' > dist/index.html\n"
        f'if flock -n "{locks}/wildeye-birds.lock" true; then echo free; else echo held; fi > dist/assets/lock\n'
        f'touch "{tmp}/npx-ran"\n'
    )
    npx.chmod(0o755)
    return origin, site, home, locks, tip


def _env(tmp, home, locks, **extra):
    return {
        **os.environ,
        **ENV,
        "HOME": str(home),
        "TMPDIR": str(tmp),
        "WILDEYE_LOCK_DIR": str(locks),
        "WILDEYE_PYTHON": sys.executable,
        **extra,
    }


def _deploy(tmp, site, home, locks, *args, **extra):
    return subprocess.run(
        ["bash", str(site / "pipeline" / "deploy_pages.sh"), *args],
        cwd=tmp,
        env=_env(tmp, home, locks, **extra),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def _published(origin):
    return set(_git(origin, "ls-tree", "-r", "--name-only", "gh-pages").splitlines())


def _hold(lock: Path, tmp: Path, then: str = "true", seconds: float = 2):
    """Another process holding `lock` (a build or a deploy) for about `seconds`, then running `then` before it lets go."""
    ready = tmp / f"held-{lock.name}"
    p = subprocess.Popen(
        ["flock", str(lock), "sh", "-c", f'touch "{ready}"; sleep {seconds}; {then}']
    )
    deadline = time.monotonic() + 30
    while not ready.exists():
        assert p.poll() is None and time.monotonic() < deadline, (
            "lock holder never got the lock"
        )
        time.sleep(0.05)
    return p


def test_birds_deploy_ships_only_the_birds_files_on_the_published_tip(tmp_path: Path):
    origin, site, home, locks, tip = _setup(tmp_path)
    out = _deploy(tmp_path, site, home, locks, "--birds")
    assert out.returncode == 0, out.stdout + out.stderr
    assert _git(origin, "rev-parse", "gh-pages^") == tip, (
        "laid over the published tip, not orphaned"
    )
    for f in BIRDS:
        assert _git(origin, "show", f"gh-pages:data/{f}") == "new", f
    assert _git(origin, "show", "gh-pages:data/birds_ppi/A.png") == "newA"
    assert _published(origin) == {
        "index.html",
        "data/other.json",
        "data/birds_ppi/A.png",
        "data/birds_ppi/C.png",
        *(f"data/{f}" for f in BIRDS),
    }, "B.png (a radar no longer built) goes; the temp files never ship"
    assert _git(origin, "show", "gh-pages:data/other.json") == "old", (
        "a non-birds data file is left as published"
    )
    assert _git(origin, "show", "gh-pages:index.html") == "old site"
    assert not (tmp_path / "npx-ran").exists(), "a birds deploy does not build the site"
    assert "deploy birds " in _git(origin, "log", "-1", "--format=%s", "gh-pages")
    assert sorted(out.stderr.splitlines()) == [
        "not shipped (unfinished write): data/birds_ppi/A.tmp.png",
        "not shipped (unfinished write): data/birds_ppi/tmpk3j2.tmp",
    ]


def test_birds_deploy_refuses_when_nothing_is_published(tmp_path: Path):
    origin, site, home, locks, _ = _setup(tmp_path / "none", published=False)
    out = _deploy(tmp_path / "none", site, home, locks, "--birds")
    assert out.returncode == 1 and "run a full deploy first" in out.stderr, (
        out.stdout + out.stderr
    )
    assert _git(origin, "branch", "--list", "gh-pages") == "", (
        "no history started from a handful of birds files"
    )
    origin, site, home, locks, _ = _setup(tmp_path / "some")
    ok = _deploy(tmp_path / "some", site, home, locks, "--birds")
    assert ok.returncode == 0, (
        "positive control: with a published site the same deploy ships: " + ok.stderr
    )


def test_birds_copy_waits_for_a_build_holding_the_lock_and_gives_up_loud(
    tmp_path: Path,
):
    origin, site, home, locks, tip = _setup(tmp_path)
    field = site / "public" / "data" / "birds_field.json"
    build = _hold(
        locks / "wildeye-birds.lock", tmp_path, then=f'printf final > "{field}"'
    )
    out = _deploy(tmp_path, site, home, locks, "--birds")
    build.wait(timeout=30)
    assert out.returncode == 0, out.stderr
    assert _git(origin, "show", "gh-pages:data/birds_field.json") == "final", (
        "copied after the build, not mid-write"
    )
    published = _git(origin, "rev-parse", "gh-pages")
    build = _hold(locks / "wildeye-birds.lock", tmp_path, seconds=6)
    stuck = _deploy(tmp_path, site, home, locks, "--birds", BIRDS_LOCK_WAIT="1")
    build.wait(timeout=30)
    assert stuck.returncode == 1 and "not copying half-written files" in stuck.stderr, (
        stuck.stdout + stuck.stderr
    )
    assert _git(origin, "rev-parse", "gh-pages") == published


def test_one_deploy_at_a_time(tmp_path: Path):
    origin, site, home, locks, tip = _setup(tmp_path)
    other = _hold(locks / "wildeye-deploy.lock", tmp_path, seconds=4)
    skipped = _deploy(tmp_path, site, home, locks, "--birds")
    full = _deploy(tmp_path, site, home, locks, DEPLOY_LOCK_WAIT="1")
    other.wait(timeout=30)
    assert skipped.returncode == 0 and "skipping" in skipped.stdout, (
        skipped.stdout + skipped.stderr
    )
    assert full.returncode == 1 and "another deploy still holds" in full.stderr, (
        full.stdout + full.stderr
    )
    assert _git(origin, "rev-parse", "gh-pages") == tip, (
        "neither moved gh-pages while another deploy held it"
    )
    ok = _deploy(tmp_path, site, home, locks, "--birds")
    assert ok.returncode == 0 and _git(origin, "rev-parse", "gh-pages^") == tip, (
        "positive control: free, it ships"
    )


def test_full_deploy_builds_inside_the_birds_lock(tmp_path: Path):
    origin, site, home, locks, tip = _setup(tmp_path)
    out = _deploy(tmp_path, site, home, locks)
    assert out.returncode == 0, out.stdout + out.stderr
    assert _git(origin, "rev-parse", "gh-pages^") == tip
    assert _git(origin, "show", "gh-pages:assets/lock") == "held", (
        "vite copied public/ with no lock against a build"
    )


def test_run_birds_holds_the_lock_for_the_whole_build(tmp_path: Path):
    _, site, home, locks, _ = _setup(tmp_path)
    builder = tmp_path / "build_birds"
    builder.write_text(
        f'#!/bin/sh\nif flock -n "{locks}/wildeye-birds.lock" true; then echo free; else echo held; fi\n'
    )
    builder.chmod(0o755)

    def run(**extra):
        return subprocess.run(
            ["bash", str(site / "pipeline" / "run_birds.sh")],
            cwd=tmp_path,
            env=_env(tmp_path, home, locks, WILDEYE_PYTHON=str(builder), **extra),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    ok = run()
    assert ok.returncode == 0 and ok.stdout.strip() == "held", ok.stdout + ok.stderr
    deploy = _hold(locks / "wildeye-birds.lock", tmp_path, seconds=5)
    blocked = run(BIRDS_LOCK_WAIT="1")
    deploy.wait(timeout=30)
    assert blocked.returncode == 75 and blocked.stdout == "", (
        blocked.stdout + blocked.stderr
    )
    assert "skipping this run" in blocked.stderr


def test_an_unknown_argument_fails_before_anything_runs(tmp_path: Path):
    origin, site, home, locks, tip = _setup(tmp_path)
    out = _deploy(tmp_path, site, home, locks, "--bird")
    assert out.returncode == 2 and "usage: deploy_pages.sh [--birds]" in out.stderr, out.stdout + out.stderr
    assert not (tmp_path / "npx-ran").exists(), "a typo'd flag must not run a full build and deploy"
    assert _git(origin, "rev-parse", "gh-pages") == tip
    ok = _deploy(tmp_path, site, home, locks, "--birds")
    assert ok.returncode == 0, "positive control: the real flag deploys: " + ok.stderr


def test_the_birds_set_goes_up_as_one_commit_however_big(tmp_path: Path):
    """Nothing gates a client's reads of birds_ppi/ the way the archive manifest gates frames, so the batching that
    splits big data pushes must not split the birds set: a tip between its parts would mix two builds' radars."""
    origin, site, home, locks, tip = _setup(tmp_path)
    ppi = site / "public" / "data" / "birds_ppi"
    for name in ("A.png", "C.png", "D.png"):
        (ppi / name).write_bytes(os.urandom(600_000))
    assert sum(p.stat().st_size for p in ppi.glob("[ACD].png")) > 1_000_000, "the set must be over BATCH_MB=1"
    out = _deploy(tmp_path, site, home, locks, "--birds", BATCH_MB="1")
    assert out.returncode == 0, out.stdout + out.stderr
    assert _git(origin, "rev-parse", "gh-pages^") == tip, _git(origin, "log", "--format=%s", "gh-pages")
    assert "part" not in out.stdout
    assert {"data/birds_ppi/A.png", "data/birds_ppi/C.png", "data/birds_ppi/D.png"} <= _published(origin)
