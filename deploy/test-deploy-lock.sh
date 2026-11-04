#!/usr/bin/env bash
# The deploy lock in deploy/staging/deploy.sh and deploy/production/deploy.sh (Codex F183-1):
# - the block is identical in both scripts;
# - two overlapping deploys (staging and production, same user) run one after the other, and each
#   one's registry login lasts from its own pull to its own end: the first deploy's logout never
#   removes the second's login, and the second never pulls logged out.
# A stub `docker` records login/logout in a shared file (as the deploy user's Docker config would)
# and fails a pull made while logged out. Runs with no Docker and no network.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

block() { sed -n '/^# --- deploy lock/,/^# --- end deploy lock ---$/p' "$1"; }
block "$repo/deploy/staging/deploy.sh" > "$work/staging-block"
block "$repo/deploy/production/deploy.sh" > "$work/production-block"
[ -s "$work/staging-block" ] || fail "no deploy lock block in deploy/staging/deploy.sh"
cmp -s "$work/staging-block" "$work/production-block" ||
  fail "the deploy lock block differs between staging and production deploy.sh"
pass "the deploy lock block is identical in both deploy.sh"

mkdir -p "$work/bin" "$work/home"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Shared "Docker config": one login state for the user, like ~/.docker/config.json.
state="$HOME/docker-login"
case "$1" in
  login) cat > /dev/null; echo in > "$state"; echo "login $NAME" >> "$HOME/events" ;;
  logout) rm -f "$state"; echo "logout $NAME" >> "$HOME/events" ;;
  pull)
    if [ -f "$state" ]; then echo "pull-ok $NAME" >> "$HOME/events"
    else echo "pull-denied $NAME" >> "$HOME/events"; exit 1; fi ;;
esac
STUB
chmod +x "$work/bin/docker"

# A deploy: the real lock block, then a pull, some work, a second pull (as compose does later).
for stack in staging production; do
  # shellcheck disable=SC2016 # these lines are written into the generated script, unexpanded
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    cat "$work/$stack-block"
    echo 'echo "start $NAME" >> "$HOME/events"'
    echo 'docker pull image'
    echo 'sleep 1'
    echo 'docker pull image'
    echo 'echo "end $NAME" >> "$HOME/events"'
  } > "$work/$stack-deploy.sh"
done

export HOME="$work/home" PATH="$work/bin:$PATH"
# Staging starts first; production logs in while staging still holds the lock.
printf token | NAME=staging bash "$work/staging-deploy.sh" --registry-login ci &
sleep 0.3
printf token | NAME=production bash "$work/production-deploy.sh" --registry-login ci &
wait

events="$(cat "$HOME/events")"
grep -q "pull-denied" <<< "$events" && fail "a deploy pulled while logged out:
$events"
expected="login staging
start staging
pull-ok staging
pull-ok staging
end staging
logout staging
login production
start production
pull-ok production
pull-ok production
end production
logout production"
[ "$events" = "$expected" ] || fail "overlapping deploys did not run login..logout one after the other:
$events"
pass "overlapping deploys run one at a time, each logged in from its first pull to its end"
echo "All deploy lock tests passed."
