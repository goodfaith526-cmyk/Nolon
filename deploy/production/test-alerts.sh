#!/usr/bin/env bash
# Checks deploy/production/alerts.sh with stubs for curl, df and docker (no network, no server):
# what is alerted, that the same alerts are pushed once, that a clear is pushed once, that a
# failed or missing push is retried on the next run, and the backup and restore-test ages.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/stack" "$work/home"
cp "$root/deploy/production/alerts.sh" "$work/stack/"

# curl: the health check answers per $work/health (ok|down); a push is logged to $work/pushed and
# succeeds per $work/push (ok|fail).
cat > "$work/bin/curl" << 'EOF'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  */api/v1/health) [ "$(cat "$STUB/health")" = ok ] ;;
  https://push.test/*)
    [ "$(cat "$STUB/push")" = ok ] || exit 22
    title=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -H) title="$2"; shift 2 ;;
        --data-binary) body="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    { echo "$title"; echo "$body"; echo "--"; } >> "$STUB/pushed"
    ;;
  *) exit 6 ;;
esac
EOF
cat > "$work/bin/df" << 'EOF'
#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
case "${*: -1}" in
  /) echo "/dev/sda1 100 1 1 $(cat "$STUB/disk")% /" ;;
  *) echo "/dev/sdb1 100 1 1 $(cat "$STUB/docker-disk")% /data" ;;
esac
EOF
cat > "$work/bin/docker" << 'EOF'
#!/usr/bin/env bash
[ "$1" = info ] && cat "$STUB/docker-root"
EOF
chmod +x "$work/bin/"*

export STUB="$work" HOME="$work/home" PATH="$work/bin:$PATH"
echo ok > "$work/health"
echo ok > "$work/push"
echo 40 > "$work/disk"
echo 40 > "$work/docker-disk"
echo / > "$work/docker-root"
: > "$work/pushed"
printf "SITE_DOMAIN='erp.example.com'\nBACKUP_S3_BUCKET=''\n" > "$work/stack/.env"

run() { (cd "$work/stack" && ./alerts.sh run) > "$work/out" 2>&1; }
pushes() { grep -c '^--$' "$work/pushed" || true; }

fail() {
  echo "FAIL: $1" >&2
  echo "--- pushed:" >&2
  cat "$work/pushed" >&2
  echo "--- last output:" >&2
  cat "$work/out" >&2
  exit 1
}
ok() { echo "ok   $1"; }

# 1. No push URL stored: an alert is not delivered, the run fails, nothing is recorded.
echo down > "$work/health"
if run; then fail "a run with no push URL must fail"; fi
grep -q "no push URL stored" "$work/out" || fail "missing URL not reported"
[ ! -f "$HOME/.config/nolon-alerts/last-production" ] || fail "state recorded without a push"
ok "no push URL: not delivered, exit 1, nothing recorded"

mkdir -p "$HOME/.config/nolon-alerts"
echo "https://push.test/topic" > "$HOME/.config/nolon-alerts/push-url"

# 2. Everything fine (backups not set up): nothing pushed.
echo ok > "$work/health"
run || fail "a quiet run must pass"
[ "$(pushes)" = 0 ] || fail "nothing to push, yet pushed"
ok "all fine: nothing pushed"

# 3. Site down: pushed once, not again while it stays down.
echo down > "$work/health"
run || fail "the alert run must pass"
[ "$(pushes)" = 1 ] || fail "site down not pushed"
grep -q "ALERT production: https://erp.example.com did not answer its health check" "$work/pushed" ||
  fail "health alert text"
grep -q "Title: NOLON production alert" "$work/pushed" || fail "alert title"
run || fail "the repeat run must pass"
[ "$(pushes)" = 1 ] || fail "the same alert pushed twice"
ok "site down: pushed once, not repeated"

# 4. Back up: one "cleared" push, then quiet.
echo ok > "$work/health"
run || fail "the clear run must pass"
[ "$(pushes)" = 2 ] || fail "clear not pushed"
grep -q "Title: NOLON production alerts cleared" "$work/pushed" || fail "clear title"
run || fail "quiet after clear"
[ "$(pushes)" = 2 ] || fail "pushed again after clear"
ok "recovery: one cleared push"

# 5. A failed push is retried on the next run.
echo 91 > "$work/disk"
echo fail > "$work/push"
if run; then fail "a failed push must fail the run"; fi
echo ok > "$work/push"
run || fail "the retry must pass"
[ "$(pushes)" = 3 ] || fail "the alert was not retried after a failed push"
grep -q "ALERT production: disk / is 91% full (limit 85%)" "$work/pushed" || fail "disk alert text"
ok "disk 91%: alerted; a failed push is retried"

# 6. Docker on its own disk is checked too; the same disk is checked once.
echo 40 > "$work/disk"
mkdir -p "$work/dockerroot"
echo "$work/dockerroot" > "$work/docker-root"
echo 88 > "$work/docker-disk"
run || fail "docker disk run"
grep -q "ALERT production: disk /data is 88% full" "$work/pushed" || fail "docker disk alert"
[ "$(grep -c 'disk / is' "$work/pushed")" = 1 ] || fail "root disk alerted again"
echo 40 > "$work/docker-disk"
ALERT_DISK_PERCENT=30 bash -c 'cd "$1" && ./alerts.sh run' _ "$work/stack" > "$work/out" 2>&1 || fail "limit run"
[ "$(tail -n 4 "$work/pushed" | grep -c 'is 40% full (limit 30%)')" = 2 ] || fail "ALERT_DISK_PERCENT or one line per disk"
run || fail "back under the limit"
ok "docker disk alerted apart; ALERT_DISK_PERCENT honoured"

# 7. Backups set up: no backup and no restore test yet, then fresh, then a stale backup.
printf "SITE_DOMAIN='erp.example.com'\nBACKUP_S3_BUCKET='nolon-backups'\n" > "$work/stack/.env"
before="$(pushes)"
run || fail "backup run"
grep -q "ALERT production: no successful backup recorded yet" "$work/pushed" || fail "no backup alert"
grep -q "ALERT production: no restore test passed in the last 35 days" "$work/pushed" || fail "no restore test alert"
touch "$work/stack/last-backup" "$work/stack/last-restore-test"
run || fail "fresh backup run"
[ "$(tail -n 3 "$work/pushed" | head -n 1)" = "Title: NOLON production alerts cleared" ] || fail "fresh backup did not clear"
touch -d '27 hours ago' "$work/stack/last-backup"
touch -d '36 days ago' "$work/stack/last-restore-test"
run || fail "stale backup run"
grep -q "ALERT production: the last successful backup is older than 26 hours" "$work/pushed" || fail "stale backup alert"
[ "$(tail -n 4 "$work/pushed" | grep -c 'restore test')" = 1 ] || fail "stale restore test alert"
[ "$(pushes)" -gt "$before" ] || fail "backup alerts not pushed"
ok "backups: missing, fresh and stale backup and restore test"

# 8. Staging keeps its own state and names itself.
printf "NOLON_STACK=staging\nSITE_DOMAIN='staging.example.com'\n" > "$work/stack/.env"
touch "$work/stack/last-backup"
echo down > "$work/health"
run || fail "staging run"
grep -q "ALERT staging: https://staging.example.com did not answer" "$work/pushed" || fail "staging alert"
[ -f "$HOME/.config/nolon-alerts/last-staging" ] || fail "staging state file"
ok "staging: own state and name"

# 9. An http push URL is refused.
echo "http://push.test/topic" > "$HOME/.config/nolon-alerts/push-url"
echo ok > "$work/health"
if run; then fail "an http push URL must be refused"; fi
grep -q "must be https" "$work/out" || fail "http URL not reported"
ok "http push URL refused"

echo "alerts.sh: all checks passed"
