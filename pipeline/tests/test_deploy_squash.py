"""deploy_pages.sh squash_branch (the last step of a full deploy, and --squash alone), run for real against a local bare
repo standing in for GitHub: the published tree is kept byte for byte, the history that held dropped files goes, and
the force push is refused if anything moved the branch since it was read."""

import os
import shutil
import subprocess
from pathlib import Path

from pipeline.tests.test_deploy_birds import _deploy, _git, _hold, _published, _setup


def _push_commit(origin: Path, tmp: Path, name: str, files: dict, parent: bool = True):
    """Commit `files` (path -> bytes, None to delete) onto origin's gh-pages (or as a root commit) and push it."""
    work = tmp / name
    _git(tmp, "clone", "-q", "--branch", "gh-pages", str(origin), str(work))
    if not parent:
        _git(work, "checkout", "-q", "--orphan", "fresh")
        _git(work, "rm", "-rfq", ".")
    for rel, data in files.items():
        p = work / rel
        if data is None:
            p.unlink()
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "--allow-empty", "-m", name)
    _git(work, "push", "-q", "--force", "origin", "HEAD:refs/heads/gh-pages")
    return _git(work, "rev-parse", "HEAD")


def _objects(origin: Path) -> set:
    return {
        line.split()[0]
        for line in _git(origin, "rev-list", "--objects", "gh-pages").splitlines()
    }


def _has_parent(origin: Path) -> bool:
    return (
        subprocess.run(
            ["git", "rev-parse", "-q", "--verify", "gh-pages^"],
            cwd=origin,
            capture_output=True,
            check=False,
        ).returncode
        == 0
    )


def test_squash_keeps_the_published_tree_and_drops_the_history_that_held_removed_files(
    tmp_path: Path,
):
    origin, site, home, locks, _ = _setup(tmp_path)
    dropped = os.urandom(50_000)
    _push_commit(origin, tmp_path, "add", {"data/dropped.bin": dropped})
    tip = _push_commit(origin, tmp_path, "drop", {"data/dropped.bin": None})
    blob = (
        subprocess.run(
            ["git", "hash-object", "--stdin"],
            input=dropped,
            capture_output=True,
            check=True,
        )
        .stdout.decode()
        .strip()
    )
    tree, files = _git(origin, "rev-parse", "gh-pages^{tree}"), _published(origin)
    assert blob in _objects(origin), (
        "control: before the squash, the branch's history still holds the dropped file"
    )

    out = _deploy(tmp_path, site, home, locks, "--squash")
    assert out.returncode == 0, out.stdout + out.stderr
    assert f"squashed gh-pages {tip[:7]} -> " in out.stdout, out.stdout
    assert not _has_parent(origin), "the new tip is a root commit"
    assert _git(origin, "rev-parse", "gh-pages^{tree}") == tree, (
        "same tree, so the push carried no files"
    )
    assert _published(origin) == files and "data/dropped.bin" not in files
    assert blob not in _objects(origin), (
        "the dropped file is no longer reachable from gh-pages"
    )
    assert not list(tmp_path.glob("wildeye-pages.*")), (
        "--squash leaves no temp worktree dir behind"
    )

    # a branch with no history is left alone
    root = _git(origin, "rev-parse", "gh-pages")
    again = _deploy(tmp_path, site, home, locks, "--squash")
    assert again.returncode == 0 and "nothing to squash" in again.stdout, (
        again.stdout + again.stderr
    )
    assert _git(origin, "rev-parse", "gh-pages") == root


def test_squash_refuses_when_another_push_moved_the_branch_after_it_was_read(
    tmp_path: Path,
):
    origin, site, home, locks, _ = _setup(tmp_path)
    _push_commit(origin, tmp_path, "second", {"data/x.json": b"x"})
    racer = tmp_path / "racer"
    _git(tmp_path, "clone", "-q", "--branch", "gh-pages", str(origin), str(racer))
    (racer / "data" / "race.json").write_text("someone else's deploy")
    _git(racer, "add", "-A")
    _git(racer, "commit", "-qm", "race")
    raced = _git(racer, "rev-parse", "HEAD")
    # a git that lets one other deploy land between the squash's read of the tip and its push
    fake = tmp_path / "fakebin"
    fake.mkdir()
    real = shutil.which("git")
    marker = tmp_path / "raced"
    (fake / "git").write_text(
        "#!/bin/sh\n"
        f'if [ "$1" = push ] && [ ! -e "{marker}" ]; then touch "{marker}"; "{real}" -C "{racer}" push -q origin HEAD:refs/heads/gh-pages; fi\n'
        f'exec "{real}" "$@"\n'
    )
    (fake / "git").chmod(0o755)
    path = f"{fake}:{os.environ['PATH']}"

    out = _deploy(tmp_path, site, home, locks, "--squash", PATH=path)
    assert marker.exists(), "the race was injected"
    assert out.returncode == 1 and "squash push refused or failed" in out.stderr, (
        out.stdout + out.stderr
    )
    assert _git(origin, "rev-parse", "gh-pages") == raced, (
        "the other deploy's commit was not overwritten"
    )

    ok = _deploy(tmp_path, site, home, locks, "--squash", PATH=path)
    assert ok.returncode == 0, (
        "positive control: with nothing racing it, the squash lands: " + ok.stderr
    )
    assert (
        not _has_parent(origin)
        and _git(origin, "show", "gh-pages:data/race.json") == "someone else's deploy"
    )


def test_squash_waits_for_a_deploy_holding_the_lock_and_gives_up_loud(tmp_path: Path):
    origin, site, home, locks, _ = _setup(tmp_path)
    tip = _push_commit(origin, tmp_path, "second", {"data/x.json": b"x"})
    other = _hold(locks / "wildeye-deploy.lock", tmp_path, seconds=4)
    out = _deploy(tmp_path, site, home, locks, "--squash", DEPLOY_LOCK_WAIT="1")
    other.wait(timeout=30)
    assert out.returncode == 1 and "another deploy still holds" in out.stderr, (
        out.stdout + out.stderr
    )
    assert _git(origin, "rev-parse", "gh-pages") == tip
    ok = _deploy(tmp_path, site, home, locks, "--squash")
    assert ok.returncode == 0 and not _has_parent(origin), (
        "positive control: free, it squashes: " + ok.stderr
    )


def test_squash_refuses_a_tip_with_an_empty_tree(tmp_path: Path):
    origin, site, home, locks, _ = _setup(tmp_path)
    empty = _push_commit(origin, tmp_path, "emptied", {})
    _git(tmp_path / "emptied", "rm", "-rfq", ".")
    _git(tmp_path / "emptied", "commit", "-qm", "empty tree")
    _git(tmp_path / "emptied", "push", "-q", "origin", "HEAD:refs/heads/gh-pages")
    empty = _git(origin, "rev-parse", "gh-pages")
    assert _git(origin, "ls-tree", "-r", "gh-pages") == ""
    out = _deploy(tmp_path, site, home, locks, "--squash")
    assert out.returncode == 1 and "empty tree; refusing" in out.stderr, (
        out.stdout + out.stderr
    )
    assert _git(origin, "rev-parse", "gh-pages") == empty
    _push_commit(origin, tmp_path, "refilled", {"index.html": b"site"})
    ok = _deploy(tmp_path, site, home, locks, "--squash")
    assert ok.returncode == 0 and _published(origin) == {"index.html"}, (
        "positive control: " + ok.stderr
    )
