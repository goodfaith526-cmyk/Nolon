#!/usr/bin/env bash
# Which commit did staging actually deploy? (Codex F173-1)
#
# A Deploy staging run triggered by CI checks out the commit CI passed on, but the run itself can
# be listed under a later commit of main (workflow_run runs carry main's head at trigger time).
# So run metadata never says what was deployed. Instead, the last step of a successful staging
# deploy uploads an artifact named staging-deployed-<sha>, where <sha> is the commit it checked
# out and whose images it ran. This script reads only that, and only from successful Deploy
# staging runs of main.
#
#   staging-deployed.sh run <run-id>   prints the commit that staging run deployed
#   staging-deployed.sh check <sha>    succeeds when a successful staging run deployed <sha>
#
# Needs gh (GH_TOKEN with actions:read) and GITHUB_REPOSITORY.
set -euo pipefail

workflow=.github/workflows/deploy-staging.yml
prefix=staging-deployed-
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

die() {
  echo "::error::$*" >&2
  exit 1
}

# is_staging_deploy <run-id>: a successful Deploy staging run on main of this repository.
is_staging_deploy() {
  local facts
  facts="$(gh api "repos/$repo/actions/runs/$1" \
    --jq '[(.path | sub("@.*$"; "")), .conclusion, .head_branch, .repository.full_name] | join(" ")')"
  [ "$facts" = "$workflow success main $repo" ]
}

case "${1:-}" in
  run)
    run_id="${2:-}"
    [[ "$run_id" =~ ^[0-9]+$ ]] || die "staging run id must be a number, got '$run_id'"
    is_staging_deploy "$run_id" || die "run $run_id is not a successful Deploy staging run of main"
    names="$(gh api "repos/$repo/actions/runs/$run_id/artifacts?per_page=100" \
      --jq ".artifacts[] | select(.expired | not) | .name | select(startswith(\"$prefix\"))")"
    mapfile -t found <<< "$names"
    if [ "${#found[@]}" != 1 ] || [[ ! "${found[0]}" =~ ^$prefix([0-9a-f]{40})$ ]]; then
      die "staging run $run_id has no single $prefix<sha> artifact, so what it deployed is unknown"
    fi
    echo "${BASH_REMATCH[1]}"
    ;;
  check)
    sha="${2:-}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "commit must be a full 40-character SHA, got '$sha'"
    run_ids="$(gh api "repos/$repo/actions/artifacts?name=$prefix$sha&per_page=100" \
      --jq '.artifacts[] | select(.expired | not) | .workflow_run.id')"
    for run_id in $run_ids; do
      if is_staging_deploy "$run_id"; then
        echo "$sha was deployed to staging by run $run_id"
        exit 0
      fi
    done
    die "$sha was never deployed to staging successfully (no $prefix$sha artifact from a successful Deploy staging run of main). Production runs only what staging ran first."
    ;;
  *)
    echo "usage: $0 run <run-id> | check <sha>" >&2
    exit 2
    ;;
esac
