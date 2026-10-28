#!/usr/bin/env bash
# scripts/squash_pages.sh — replace gh-pages with one parentless commit of its own tree, made on GitHub's side.
#
# Every deploy (pipeline/deploy_pages.sh) is a commit on the last, so each file a deploy dropped (pruned archive
# nights, rebuilt tiles) stays in the branch's history: 248 commits made the repo 1.95 GB on 2026-10-26 for a 668 MB
# site, past GitHub's recommended 1 GB. A git push of a root commit cannot do this cheaply: git leaves out only what
# lies behind the new commits' parents, and a root commit has none, so the push carried the whole site (98,006
# objects, 538 MB, measured 2026-10-27) and this uplink dropped it. The API makes the commit from the tree GitHub
# already holds, so nothing is uploaded. The ref moves only if it still points at the tip read (updateRefs
# beforeOid), so a deploy that lands in between is never overwritten. The old commits become unreachable and GitHub
# collects them in its own time; the published tree is the same, byte for byte.
#
# Usage: scripts/squash_pages.sh            (needs `gh` with contents: write on the repo)
#        DRY_RUN=1 scripts/squash_pages.sh  (reads and checks, writes nothing)
#        BRANCH=some-branch ...             (another branch, e.g. a throwaway to try it on)
set -euo pipefail
REPO="${GITHUB_REPOSITORY:-musharna/wildeye}"
BRANCH="${BRANCH:-gh-pages}"
fail() {
	echo "squash_pages: $*" >&2
	exit 1
}

tip="$(gh api "repos/$REPO/git/ref/heads/$BRANCH" -q .object.sha)"
[ -n "$tip" ] || fail "no tip read for $BRANCH"
read -r tree parents < <(gh api "repos/$REPO/git/commits/$tip" -q '"\(.tree.sha) \(.parents | length)"')
[ -n "$tree" ] && [ -n "$parents" ] || fail "could not read the tree of $BRANCH ${tip:0:7}"
if [ "$parents" = 0 ]; then
	echo "$BRANCH ${tip:0:7} has no history; nothing to squash"
	exit 0
fi
entries="$(gh api "repos/$REPO/git/trees/$tree" -q '.tree | length')"
[ "$entries" -gt 0 ] || fail "$BRANCH ${tip:0:7} has an empty tree; refusing to squash"
if [ -n "${DRY_RUN:-}" ]; then
	echo "dry run: would replace $BRANCH ${tip:0:7} ($parents parent) with a root commit of tree ${tree:0:7} ($entries top-level entries)"
	exit 0
fi

# no parents given: GitHub writes a root commit
new="$(gh api -X POST "repos/$REPO/git/commits" -f "tree=$tree" -f "message=squash of $BRANCH ${tip:0:7}, same tree" -q .sha)"
[ -n "$new" ] || fail "no commit made"
read -r got_tree got_parents < <(gh api "repos/$REPO/git/commits/$new" -q '"\(.tree.sha) \(.parents | length)"')
[ "$got_tree" = "$tree" ] && [ "$got_parents" = 0 ] || fail "commit $new has tree $got_tree and $got_parents parents; not moving $BRANCH"

repo_id="$(gh api "repos/$REPO" -q .node_id)"
# shellcheck disable=SC2016 # GraphQL variables, not shell ones
jq -n --arg repo "$repo_id" --arg ref "refs/heads/$BRANCH" --arg before "$tip" --arg after "$new" '{
	query: "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
	variables: { input: { repositoryId: $repo, refUpdates: [{ name: $ref, beforeOid: $before, afterOid: $after, force: true }] } }
}' | gh api graphql --input - >/dev/null || fail "updateRefs refused (did $BRANCH move since ${tip:0:7} was read?); $BRANCH not squashed"

now="$(gh api "repos/$REPO/git/ref/heads/$BRANCH" -q .object.sha)"
[ "$now" = "$new" ] || fail "$BRANCH is $now after the update, expected $new"
echo "squashed $BRANCH ${tip:0:7} -> ${new:0:7}: tree ${tree:0:7} unchanged, no parents"
