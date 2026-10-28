"""scripts/squash_pages.sh run whole against a stand-in `gh` that keeps a small GitHub (refs, commits, trees) in a JSON
file. The stand-in's answers are the ones the real API gave on 2026-10-27, on a throwaway branch and then on gh-pages:
POST git/commits without parents writes a root commit; updateRefs with a stale beforeOid fails (gh exits 1) and the
ref stays, with the current one it moves; `gh api -q` prints jq's raw output."""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "squash_pages.sh"

FAKE_GH = r"""
import json, os, subprocess, sys
state_path = os.environ["FAKE_GH_STATE"]
s = json.load(open(state_path))
args = sys.argv[1:]
assert args[0] == "api", args
args = args[1:]
method, fields, query, inp = "GET", {}, None, False
rest = []
while args:
    a = args.pop(0)
    if a == "-X": method = args.pop(0)
    elif a == "-f": k, v = args.pop(0).split("=", 1); fields[k] = v
    elif a == "-q": query = args.pop(0)
    elif a == "--input": args.pop(0); inp = True
    else: rest.append(a)
path = rest[0]
s.setdefault("calls", []).append([method, path])
def out(obj):
    json.dump(s, open(state_path, "w"))
    if query is None: print(json.dumps(obj)); sys.exit(0)
    r = subprocess.run(["jq", "-r", query], input=json.dumps(obj), capture_output=True, text=True, check=True)
    sys.stdout.write(r.stdout); sys.exit(0)
def commit_json(sha):
    c = s["commits"][sha]
    return {"sha": sha, "tree": {"sha": c["tree"]}, "parents": [{"sha": p} for p in c["parents"]]}
repo = "repos/" + s["repo"]
if path == "graphql":
    body = json.load(sys.stdin)
    u = body["variables"]["input"]["refUpdates"][0]
    name = u["name"].removeprefix("refs/heads/")
    if s["refs"].get(name) != u["beforeOid"]:
        json.dump(s, open(state_path, "w"))
        print('{"errors":[{"message":"Something went wrong while executing your query"}]}')
        sys.exit(1)
    if not s.pop("ignore_update", False):  # an API that says yes and does nothing
        s["refs"][name] = u["afterOid"]
    out({"data": {"updateRefs": {"clientMutationId": None}}})
if path == repo:
    out({"node_id": "R_test"})
if path.startswith(repo + "/git/ref/heads/"):
    out({"object": {"sha": s["refs"][path.rsplit("/", 1)[1]]}})
if path.startswith(repo + "/git/commits/"):
    out(commit_json(path.rsplit("/", 1)[1]))
if path.startswith(repo + "/git/trees/"):
    out({"tree": s["trees"][path.rsplit("/", 1)[1]]})
if path == repo + "/git/commits" and method == "POST":
    sha = "new%04d" % len(s["commits"])
    s["commits"][sha] = {"tree": fields["tree"], "parents": s.get("forced_parents", [])}
    race = s.pop("race", None)
    if race: s["refs"][race[0]] = race[1]  # another deploy lands between the read and the update
    out({"sha": sha})
sys.exit(f"fake gh: unhandled {method} {path}")
"""


def _world(tmp: Path, **state):
    base = {
        "repo": "o/r",
        "refs": {"gh-pages": "c2"},
        "commits": {
            "c1": {"tree": "t1", "parents": []},
            "c2": {"tree": "t2", "parents": ["c1"]},
            "c3": {"tree": "t3", "parents": ["c2"]},
        },
        "trees": {
            "t1": [{"path": "a"}],
            "t2": [{"path": "index.html"}, {"path": "data"}],
            "t3": [{"path": "x"}],
            "t0": [],
        },
    }
    base.update(state)
    (tmp / "state.json").write_text(json.dumps(base))
    bindir = tmp / "bin"
    bindir.mkdir(exist_ok=True)
    gh = bindir / "gh"
    gh.write_text(f"#!{sys.executable}\n{FAKE_GH}")
    gh.chmod(0o755)
    return tmp / "state.json", bindir


def _run(tmp: Path, bindir: Path, **env):
    return subprocess.run(
        ["bash", str(SCRIPT)],
        env={
            **os.environ,
            "PATH": f"{bindir}:{os.environ['PATH']}",
            "FAKE_GH_STATE": str(tmp / "state.json"),
            "GITHUB_REPOSITORY": "o/r",
            **env,
        },
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def _state(path: Path) -> dict:
    return json.loads(path.read_text())


def test_squash_makes_a_root_commit_of_the_same_tree_and_moves_the_ref(tmp_path: Path):
    state, bindir = _world(tmp_path)
    out = _run(tmp_path, bindir)
    assert out.returncode == 0, out.stdout + out.stderr
    s = _state(state)
    new = s["refs"]["gh-pages"]
    assert new != "c2" and s["commits"][new] == {"tree": "t2", "parents": []}
    assert "squashed gh-pages c2 -> " in out.stdout
    # once squashed there is nothing left to do, and nothing is written
    again = _run(tmp_path, bindir)
    assert again.returncode == 0 and "nothing to squash" in again.stdout, (
        again.stdout + again.stderr
    )
    assert _state(state)["refs"]["gh-pages"] == new
    assert ["POST", "repos/o/r/git/commits"] not in _state(state)["calls"][
        len(s["calls"]) :
    ]


def test_a_deploy_landing_between_the_read_and_the_update_is_not_overwritten(
    tmp_path: Path,
):
    state, bindir = _world(tmp_path, race=["gh-pages", "c3"])
    out = _run(tmp_path, bindir)
    assert out.returncode == 1 and "updateRefs refused" in out.stderr, (
        out.stdout + out.stderr
    )
    assert _state(state)["refs"]["gh-pages"] == "c3", "the other deploy's commit stays"
    ok = _run(tmp_path, bindir)
    assert ok.returncode == 0, (
        "positive control: with nothing racing it, the squash lands: " + ok.stderr
    )
    s = _state(state)
    assert s["commits"][s["refs"]["gh-pages"]] == {"tree": "t3", "parents": []}


def test_dry_run_reads_and_writes_nothing(tmp_path: Path):
    state, bindir = _world(tmp_path)
    out = _run(tmp_path, bindir, DRY_RUN="1")
    assert out.returncode == 0 and "dry run: would replace gh-pages c2" in out.stdout, (
        out.stdout + out.stderr
    )
    s = _state(state)
    assert s["refs"]["gh-pages"] == "c2"
    assert all(m == "GET" for m, _ in s["calls"]), s["calls"]
    assert (
        _run(tmp_path, bindir).returncode == 0
        and _state(state)["refs"]["gh-pages"] != "c2"
    ), "positive control: without DRY_RUN it squashes"


def test_an_empty_tree_is_refused(tmp_path: Path):
    state, bindir = _world(tmp_path, refs={"gh-pages": "c4"})
    s = _state(state)
    s["commits"]["c4"] = {"tree": "t0", "parents": ["c2"]}
    state.write_text(json.dumps(s))
    out = _run(tmp_path, bindir)
    assert out.returncode == 1 and "empty tree; refusing" in out.stderr, (
        out.stdout + out.stderr
    )
    assert _state(state)["refs"]["gh-pages"] == "c4"
    (tmp_path / "good").mkdir()
    _, good_bin = _world(tmp_path / "good")
    assert _run(tmp_path / "good", good_bin).returncode == 0, (
        "positive control: a tree with files squashes"
    )


def test_a_made_commit_that_is_not_a_root_of_the_same_tree_is_not_published(
    tmp_path: Path,
):
    state, bindir = _world(tmp_path, forced_parents=["c1"])
    out = _run(tmp_path, bindir)
    assert out.returncode == 1 and "not moving gh-pages" in out.stderr, (
        out.stdout + out.stderr
    )
    assert _state(state)["refs"]["gh-pages"] == "c2"


def test_an_update_that_reports_success_but_leaves_the_ref_is_caught(tmp_path: Path):
    state, bindir = _world(tmp_path, ignore_update=True)
    out = _run(tmp_path, bindir)
    assert (
        out.returncode == 1
        and "gh-pages is c2 after the update, expected" in out.stderr
    ), out.stdout + out.stderr
    ok = _run(tmp_path, bindir)
    assert ok.returncode == 0 and _state(state)["refs"]["gh-pages"] != "c2", (
        "positive control: a real update passes: " + ok.stderr
    )
