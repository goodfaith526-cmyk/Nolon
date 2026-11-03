#!/usr/bin/env bash
# Tests staging-deployed.sh (Codex F173-1) against a fake `gh api` serving fixed run and artifact
# listings, including the case that motivated it: CI for commit A finishes after main has moved
# to B, so the staging run that deployed A is listed under B. Production must take A from that
# run, and must not treat B as deployed.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/deploy/production/staging-deployed.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=cccccccccccccccccccccccccccccccccccccccc
repo=acme/Nolon
staging=.github/workflows/deploy-staging.yml

# Fake gh: `gh api <endpoint> --jq <filter>` answers from $work/api/<endpoint with / ? & = as _>.
mkdir -p "$work/bin" "$work/api"
cat > "$work/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] && [ "$3" = --jq ] || { echo "fake gh: unexpected call: $*" >&2; exit 2; }
file="$FAKE_API/$(printf '%s' "$2" | tr '/?&=' '____')"
[ -f "$file" ] || { echo "fake gh: HTTP 404 for $2" >&2; exit 1; }
jq -r "$4" "$file"
GH
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" FAKE_API="$work/api" GITHUB_REPOSITORY="$repo"

api() { cat > "$work/api/$(printf '%s' "$1" | tr '/?&=' '____')"; }
# run <id> <workflow path> <conclusion> <branch> [repo]
run() {
  api "repos/$repo/actions/runs/$1" <<JSON
{"id": $1, "path": "$2", "conclusion": "$3", "head_branch": "$4", "head_sha": "$B",
 "repository": {"full_name": "${5:-$repo}"}}
JSON
}
# artifacts_of <run id> <name>... (an "expired:" prefix marks an expired artifact)
artifacts_of() {
  local id="$1" list="" name expired
  shift
  for name in "$@"; do
    expired=false
    if [[ "$name" == expired:* ]]; then expired=true; name="${name#expired:}"; fi
    list="$list${list:+,}{\"name\": \"$name\", \"expired\": $expired}"
  done
  api "repos/$repo/actions/runs/$id/artifacts?per_page=100" <<< "{\"artifacts\": [$list]}"
}
# artifact_index <sha> <run id>... (runs that uploaded staging-deployed-<sha>)
artifact_index() {
  local sha="$1" list="" id
  shift
  for id in "$@"; do
    list="$list${list:+,}{\"expired\": false, \"workflow_run\": {\"id\": $id}}"
  done
  api "repos/$repo/actions/artifacts?name=staging-deployed-$sha&per_page=100" <<< "{\"artifacts\": [$list]}"
}

expect_out() { # <expected stdout> <args...>
  local want="$1" got
  shift
  got="$("$script" "$@" 2>/dev/null)" || { echo "FAIL: $* failed, expected '$want'" >&2; exit 1; }
  [ "$got" = "$want" ] || { echo "FAIL: $* printed '$got', expected '$want'" >&2; exit 1; }
  echo "ok   $*"
}
expect_ok() {
  "$script" "$@" > /dev/null 2>&1 || { echo "FAIL: $* refused, expected success" >&2; exit 1; }
  echo "ok   $* (accepted)"
}
expect_refused() { # <why> <args...>
  local why="$1"
  shift
  if "$script" "$@" > /dev/null 2>&1; then
    echo "FAIL: $* accepted: $why" >&2
    exit 1
  fi
  echo "ok   $* (refused: $why)"
}

# 100: CI for A finished after main moved to B; staging deployed A, but its run lists head_sha B.
run 100 "$staging" success main
artifacts_of 100 "staging-deployed-$A"
artifact_index "$A" 100
artifact_index "$B"
expect_out "$A" run 100
expect_ok check "$A"
expect_refused "B was never deployed, even though run 100 is listed under it" check "$B"

# 101: a manual staging run (the workflow file path can carry @ref).
run 101 "$staging@refs/heads/main" success main
artifacts_of 101 "staging-deployed-$C"
expect_out "$C" run 101

# Runs that must not count.
run 200 "$staging" failure main
artifacts_of 200 "staging-deployed-$C"
expect_refused "the staging run failed" run 200
run 201 .github/workflows/ci.yml success main
artifacts_of 201 "staging-deployed-$C"
expect_refused "another workflow uploaded the artifact" run 201
run 202 "$staging" success some-branch
artifacts_of 202 "staging-deployed-$C"
expect_refused "not a run of main" run 202
run 203 "$staging" success main other/Nolon
artifacts_of 203 "staging-deployed-$C"
expect_refused "a run of another repository" run 203
artifact_index "$C" 200 201 202 203
expect_refused "only failed, foreign or off-main runs uploaded it" check "$C"

# Artifacts that do not say what was deployed.
run 300 "$staging" success main
artifacts_of 300
expect_refused "a staging run from before this change has no artifact" run 300
run 301 "$staging" success main
artifacts_of 301 "staging-deployed-$A" "staging-deployed-$B"
expect_refused "two deployed commits" run 301
run 302 "$staging" success main
artifacts_of 302 "expired:staging-deployed-$A"
expect_refused "the artifact expired" run 302
run 303 "$staging" success main
artifacts_of 303 "staging-deployed-${A:0:39}"
expect_refused "not a full SHA" run 303

# Bad input.
expect_refused "not a run id" run "100;x"
expect_refused "not a full SHA" check "${A:0:7}"
expect_refused "unknown run" run 999

echo "All staging-deployed tests passed."
