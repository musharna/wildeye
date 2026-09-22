#!/usr/bin/env bash
# pipeline/deploy_pages.sh — build the site for GitHub Pages and publish it as a commit on `gh-pages`,
# on top of what is already there, so each deploy pushes only the files that changed.
# Data: ships the live public/data files but only the newest $KEEP_NIGHTS nights of the birds replay archive
# (the full archive is 30 nights / 424 MB; the manifest is rewritten so the client never asks for a pruned frame).
# Credentials never enter the build: every credentialed pipeline runs locally and writes plain data files.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node24/bin:$PATH"
BASE="${PAGES_BASE:-/wildeye/}"
# ~14 MB/night. The ~50 MB that survives this uplink (2026-09-12) bounds the push DELTA, not the whole
# site, so the ceiling on the total is the 1 GB Pages limit instead: ship every night the pipeline has
# (pipeline/run_archive.sh prunes its own archive to 30 nights, ~424 MB). This default was 2 while each deploy re-uploaded
# the site; leaving it there would have had the nightly cron prune the published archive back to two
# nights the morning after it was filled. Lower it only to make a single deploy smaller.
KEEP_NIGHTS="${KEEP_NIGHTS:-999}"
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
BRANCH=gh-pages
WT="$(mktemp -d "${TMPDIR:-/tmp}/wildeye-pages.XXXXXX")"
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true; git worktree prune' EXIT

# VITE_STATIC_HOST=1: no /api/* server on Pages, so server-backed features stay off (src/backend.js)
VITE_STATIC_HOST=1 npx vite build --base="$BASE" >/dev/null
[ -f dist/index.html ] || {
	echo "build produced no dist/index.html" >&2
	exit 1
}
"$PY" - "$KEEP_NIGHTS" <<'PYEOF'
import json, shutil, sys, pathlib
keep = int(sys.argv[1])
root = pathlib.Path("dist/data/birds_archive")
man = root / "manifest.json"
if man.exists():
    m = json.loads(man.read_text())
    ids = sorted(m["frames"])
    nights = sorted({i[:10] for i in ids})
    keep_nights = set(nights[-keep:])
    dropped = [i for i in ids if i[:10] not in keep_nights]
    for i in dropped:
        d = root / m["frames"][i]["dir"].split("birds_archive/", 1)[1]
        shutil.rmtree(d, ignore_errors=True)
        del m["frames"][i]
    for day in sorted(root.glob("*/*/*"), reverse=True):
        if day.is_dir() and not any(day.iterdir()):
            day.rmdir()
    man.write_text(json.dumps(m, separators=(",", ":")))
    print(f"birds archive: kept {len(m['frames'])} frames over {len(keep_nights)} nights, dropped {len(dropped)}")
PYEOF
touch dist/.nojekyll
# vite-plugin-cesium 1.2.23 (latest on npm, 2024) copies Cesium to outDir + base + "cesium/", i.e.
# dist/wildeye/cesium, while the page asks for /wildeye/cesium/ — which on a project Pages site is
# dist/cesium. Every deploy before 2026-09-12 shipped a site whose Cesium.js 404'd ("Cesium is not
# defined", stuck on the loader) while this script printed "pushed".
REL="${BASE#/}"
REL="${REL%/}"
if [ -n "$REL" ] && [ -d "dist/$REL/cesium" ]; then
	rm -rf dist/cesium && mv "dist/$REL/cesium" dist/cesium && rmdir "dist/$REL" 2>/dev/null || true
fi
# Every same-origin src/href in index.html must exist in dist, or the deploy fails before pushing.
"$PY" - "$BASE" <<'PYEOF'
import pathlib, re, sys
base = sys.argv[1]
html = pathlib.Path("dist/index.html").read_text()
refs = sorted({m for m in re.findall(r'(?:src|href)="([^"#?]+)', html) if m.startswith(base)})
missing = [r for r in refs if not (pathlib.Path("dist") / r[len(base):]).exists()]
if not refs or missing:
    sys.exit(f"index.html references missing from dist: {missing or 'no same-origin refs found'}")
print(f"index.html: {len(refs)} same-origin refs resolve in dist")
PYEOF
echo "dist size: $(du -sh dist | cut -f1)"

SRC="$(git rev-parse --short HEAD)"
# Every deploy before 2026-09-20 was `checkout --orphan` + `push --force`, so the whole site went up
# the uplink each night (108 MB, landing on attempt 2 or 3) and the archive had to be pruned to 2
# nights to stay near the ~50 MB that survives. Building on the remote tip instead makes the push a
# delta — one new night is ~14 MB — so KEEP_NIGHTS is bounded by the 1 GB Pages limit, not the uplink.
# Cost: pruned frames stay in the branch's history, so re-orphan this branch when it grows unwieldy.
# `--exit-code`: 0 = branch exists, 2 = no such ref, anything else is a real failure. A network error
# must NOT read as "first deploy" and silently orphan the history back to a full re-upload.
set +e
git ls-remote --exit-code origin "refs/heads/$BRANCH" >/dev/null 2>&1
LS=$?
set -e
case "$LS" in
0) REMOTE_EXISTS=1 ;;
2) REMOTE_EXISTS=0 ;;
*)
	echo "git ls-remote origin $BRANCH failed (exit $LS); refusing to deploy" >&2
	exit 1
	;;
esac
if [ "$REMOTE_EXISTS" = 1 ]; then
	git fetch -q origin "$BRANCH"
	# the local branch must sit exactly on the remote tip, or the push below is a non-fast-forward
	git branch -f "$BRANCH" FETCH_HEAD >/dev/null 2>&1
	git worktree add -q "$WT" "$BRANCH"
else
	echo "remote $BRANCH does not exist: first deploy, starting its history" >&2
	git worktree add --detach "$WT" HEAD >/dev/null 2>&1
	(cd "$WT" && git checkout -q --orphan "$BRANCH")
fi
# replace the published tree wholesale: identical files are content-addressed, so only real changes ship
(cd "$WT" && git rm -rfq . >/dev/null 2>&1 || true)
cp -a dist/. "$WT"/
(cd "$WT" && git add -A >/dev/null)
if (cd "$WT" && git diff --cached --quiet); then
	echo "no change to publish; $BRANCH left at $(git rev-parse --short "$BRANCH")"
	exit 0
fi
STAMP="$(date -u +%Y-%m-%dT%H:%MZ)"
publish() { # commit what is staged, push it
	(cd "$WT" && git -c user.name="wildeye deploy" -c user.email="deploy@wildeye.local" commit -qm "$1")
	# the regression this design exists to prevent: a commit with no parent means the history was orphaned
	# and the next push is a full re-upload again.
	if [ "$REMOTE_EXISTS" = 1 ]; then
		git rev-parse -q --verify "$BRANCH^" >/dev/null || {
			echo "new $BRANCH commit has no parent: history was orphaned" >&2
			exit 1
		}
	fi
	for attempt in 1 2 3; do
		if (cd "$WT" && git push -q origin "$BRANCH"); then return 0; fi
		echo "push attempt $attempt failed" >&2
		[ "$attempt" = 3 ] && exit 1
		sleep 10
	done
}
# A push near 50 MB does not survive this uplink, and a night of replay frames is ~14 MB, so the first
# deploy after the archive catches up on several nights cannot go as one push. New archive frame files
# go up first in commits of at most $BATCH_MB, while the published manifest still lists only the old
# frames: every tip the uplink leaves behind is a site whose manifest names only files it has. The
# manifest and everything else go last.
BATCH_MB="${BATCH_MB:-40}"
mapfile -t NEW < <(cd "$WT" && git diff --cached --name-only --diff-filter=A -- data/birds_archive ':(exclude)data/birds_archive/manifest.json')
NEW_BYTES=0
[ "${#NEW[@]}" -gt 0 ] && NEW_BYTES="$(cd "$WT" && printf '%s\0' "${NEW[@]}" | du -cb --files0-from=- | tail -1 | cut -f1)"
if [ "$NEW_BYTES" -gt $((BATCH_MB * 1000000)) ]; then
	(cd "$WT" && git reset -q)
	part=0 size=0 batch=()
	flush() {
		part=$((part + 1))
		(cd "$WT" && printf '%s\n' "${batch[@]}" | git add --pathspec-from-file=-)
		publish "deploy $STAMP from $SRC: archive frames, part $part"
		echo "pushed archive part $part: ${#batch[@]} files, $((size / 1000000)) MB"
		size=0 batch=()
	}
	while IFS=$'\t' read -r bytes f; do
		if [ "${#batch[@]}" -gt 0 ] && [ $((size + bytes)) -gt $((BATCH_MB * 1000000)) ]; then flush; fi
		batch+=("$f") size=$((size + bytes))
	done < <(cd "$WT" && printf '%s\0' "${NEW[@]}" | du -b --files0-from=-)
	[ "${#batch[@]}" -gt 0 ] && flush
	(cd "$WT" && git add -A >/dev/null)
fi
publish "deploy $STAMP from $SRC"
LOCAL="$(git rev-parse "$BRANCH")"
REMOTE="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
[ "$LOCAL" = "$REMOTE" ] || {
	echo "remote $BRANCH is $REMOTE, expected $LOCAL" >&2
	exit 1
}
echo "pushed $BRANCH ${LOCAL:0:7} from $SRC"
