#!/usr/bin/env bash
# Checks the switches.env guard of both deploy.sh scripts (DEPLOY.md, Feature switches): it runs
# each script's guard, cut out between its "Feature switches" comment and compose(), against
# allowed and forbidden files, including a large forbidden one (Codex F177-1: a piped
# `grep | grep -q` passed it under pipefail).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'chmod -R u+rw "$work"; rm -rf "$work"' EXIT

guard() {
  sed -n '/^# Feature switches/,/^compose() {/p' "$root/deploy/$1/deploy.sh" | sed '$d'
}

# expect <stack> <ok|refused> <name>: runs the guard on $work/switches.env.
expect() {
  local result
  if (cd "$work" && bash -euo pipefail -c "$(guard "$1")") > /dev/null 2>&1; then
    result=ok
  else
    result=refused
  fi
  if [ "$result" != "$2" ]; then
    echo "FAIL $1: $3: expected $2, got $result" >&2
    exit 1
  fi
  echo "ok   $1: $3 ($2)"
}

for stack in staging production; do
  [ -n "$(guard "$stack")" ] || { echo "FAIL $stack: guard not found" >&2; exit 1; }
  rm -f "$work/switches.env"
  expect "$stack" ok "no switches.env"
  printf '%s\n' '# comment' '' '  ' 'CS_BOOKING_CANCEL_ENABLED=true' \
    "CS_CUSTOMER_IDENTITY_CLIENTS='{\"k\":{\"accounts\":[]}}'" > "$work/switches.env"
  expect "$stack" ok "CS_* settings, comments and blank lines"
  printf '%s\n' 'BILLING_AUTO_APPROVE_ENABLED=true' 'HANDOVER_PAYMENT_GATE_ENABLED=false' \
    > "$work/switches.env"
  expect "$stack" ok "the plan 12 billing switches"
  printf '%s\n' 'WINDOW_DESK_ENABLED=true' > "$work/switches.env"
  expect "$stack" ok "the plan 13 window desk switch"
  printf '%s\n' 'WINDOW_DESK_ENABLED=1' > "$work/switches.env"
  expect "$stack" refused "a window switch that is not true or false"
  printf '%s\n' 'BILLING_AUTO_APPROVE_ENABLED=yes' > "$work/switches.env"
  expect "$stack" refused "a billing switch that is not true or false"
  printf '%s\n' 'BILLING_AUTO_APPROVE_ENABLED_X=true' > "$work/switches.env"
  expect "$stack" refused "another BILLING_ key"
  printf '%s\n' 'CS_A=true' 'API_IMAGE=evil:1' > "$work/switches.env"
  expect "$stack" refused "one forbidden line"
  printf 'CS_A=true\n' > "$work/switches.env"
  for _ in $(seq 1 20000); do echo 'API_IMAGE=evil:1'; done >> "$work/switches.env"
  expect "$stack" refused "20000 forbidden lines"
  printf 'cs_a=true\n' > "$work/switches.env"
  expect "$stack" refused "lower-case key"
  printf 'CS_A=true\n' > "$work/switches.env"
  chmod 000 "$work/switches.env"
  if [ "$(id -u)" != 0 ]; then expect "$stack" refused "unreadable file"; fi
  chmod 600 "$work/switches.env"
done
