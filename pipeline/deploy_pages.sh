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
PY="${WILDEYE_PYTHON:-$HOME/miniconda3/bin/python3}"
BRANCH=gh-pages
WT="$(mktemp -d "${TMPDIR:-/tmp}/wildeye-pages.XXXXXX")"
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true; git worktree prune' EXIT

# VITE_STATIC_HOST=1: no /api/* server on Pages, so server-backed features stay off (src/backend.js)
VITE_STATIC_HOST=1 npx vite build --base="$BASE" >/dev/null
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
# vite-plugin-cesium 1.2.23 (latest on npm, 2024) copies Cesium to outDir + base + "cesium/", i.e.
# dist/wildeye/cesium, while the page asks for /wildeye/cesium/ — which on a project Pages site is
# dist/cesium. Every deploy before 2026-09-12 shipped a site whose Cesium.js 404'd ("Cesium is not
# defined", stuck on the loader) while this script printed "pushed".
REL="${BASE#/}"; REL="${REL%/}"
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
git worktree add --detach "$WT" HEAD >/dev/null 2>&1
# a local $BRANCH left by an earlier run makes `checkout --orphan` fail; the first version of this script
# swallowed that and force-pushed the STALE branch while printing "pushed" (2026-09-12)
git branch -D "$BRANCH" >/dev/null 2>&1 || true
( cd "$WT" && git checkout -q --orphan "$BRANCH" && { git rm -rfq . >/dev/null 2>&1 || true; } )
cp -a dist/. "$WT"/
( cd "$WT" && git add -A >/dev/null && git -c user.name="wildeye deploy" -c user.email="deploy@wildeye.local" commit -qm "deploy $(date -u +%Y-%m-%dT%H:%MZ) from $SRC" )
for attempt in 1 2 3; do
  if ( cd "$WT" && git push -q --force origin "$BRANCH" ); then break; fi
  echo "push attempt $attempt failed" >&2; [ "$attempt" = 3 ] && exit 1; sleep 10
done
LOCAL="$(git rev-parse "$BRANCH")"
REMOTE="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
[ "$LOCAL" = "$REMOTE" ] || { echo "remote $BRANCH is $REMOTE, expected $LOCAL" >&2; exit 1; }
echo "pushed $BRANCH ${LOCAL:0:7} from $SRC"
