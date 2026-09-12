#!/usr/bin/env bash
# pipeline/deploy_pages.sh — build the site for GitHub Pages and force-push it as a single-commit `gh-pages` branch.
# Data: ships the live public/data files but only the newest $KEEP_NIGHTS nights of the birds replay archive
# (the full archive is 30 nights / 424 MB; the manifest is rewritten so the client never asks for a pruned frame).
# Credentials never enter the build: every credentialed pipeline runs locally and writes plain data files.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node24/bin:$PATH"
BASE="${PAGES_BASE:-/wildeye/}"
KEEP_NIGHTS="${KEEP_NIGHTS:-2}"   # pushes above ~50 MB get dropped by GitHub on this uplink (2026-09-12)
PY="${WILDEYE_PYTHON:-/home/mjarnold/miniconda3/bin/python3}"
BRANCH=gh-pages
WT="$(mktemp -d "${TMPDIR:-/tmp}/wildeye-pages.XXXXXX")"
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true; git worktree prune' EXIT

npx vite build --base="$BASE" >/dev/null
[ -f dist/index.html ] || { echo "build produced no dist/index.html" >&2; exit 1; }
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
echo "dist size: $(du -sh dist | cut -f1)"

SRC="$(git rev-parse --short HEAD)"
git worktree add --detach "$WT" HEAD >/dev/null 2>&1
( cd "$WT" && git checkout -q --orphan "$BRANCH" && git rm -rfq . >/dev/null 2>&1 || true )
cp -a dist/. "$WT"/
( cd "$WT" && git add -A >/dev/null && git -c user.name="wildeye deploy" -c user.email="deploy@wildeye.local" commit -qm "deploy $(date -u +%Y-%m-%dT%H:%MZ) from $SRC" )
for attempt in 1 2 3; do
  if ( cd "$WT" && git push -q --force origin "$BRANCH" ); then break; fi
  echo "push attempt $attempt failed" >&2; [ "$attempt" = 3 ] && exit 1; sleep 10
done
echo "pushed $BRANCH from $SRC"
