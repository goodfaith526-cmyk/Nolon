#!/usr/bin/env bash
# The server's own alert check, every 5 minutes, for one NOLON stack (production, or staging with
# NOLON_STACK=staging in .env). Runs on the server, from ~/nolon-production (or ~/nolon-staging),
# with nothing installed on the host but curl and cron. What it checks:
# - the site answers its health check over HTTPS (host nginx, certificate, Caddy, API, database),
#   within 10 seconds;
# - the server's disk (and Docker's, if apart) is under ALERT_DISK_PERCENT full (default 85);
# - when backups are set up (BACKUP_S3_BUCKET in .env): a backup succeeded in the last 26 hours,
#   and a restore test passed in the last 35 days (DEPLOY-PRODUCTION.md, Backups).
# New alerts are pushed to the URL stored with `./alerts.sh set-url` (for example an ntfy.sh topic
# URL the operator's phone subscribes to). The same alerts again are not pushed, and one "cleared"
# push follows when they clear. An alert counts as delivered only when the push succeeded: a failed
# push, or no URL stored, is logged, the run exits 1, and the next run tries again. Alerts hold the
# stack, the domain and numbers only: no customer data.
#
#   ./alerts.sh set-url       once: stores the push URL (asked hidden; https only), shared by
#                             both stacks, in ~/.config/nolon-alerts/push-url (mode 600)
#   ./alerts.sh test          pushes one test message
#   ./alerts.sh install-cron  every 5 minutes (deploy.sh does this once a push URL is stored).
#                             Log: ~/nolon-<stack>-alerts.log
#   ./alerts.sh run           one check (what cron runs; test-alerts.sh runs it with stubs)
set -euo pipefail
cd "$(dirname "$0")"

die() {
  echo "alerts.sh: $*" >&2
  exit 1
}

env_value() {
  sed -n "s/^$1='\{0,1\}\([^']*\)'\{0,1\}$/\1/p" .env 2> /dev/null | tail -n 1
}

stack="$(env_value NOLON_STACK)"
stack="${stack:-production}"
case "$stack" in production | staging) ;; *) die "NOLON_STACK in .env must be production or staging" ;; esac

DIR="${NOLON_ALERTS_DIR:-$HOME/.config/nolon-alerts}"
URL_FILE="$DIR/push-url"
STATE="$DIR/last-$stack"
DISK_PERCENT="${ALERT_DISK_PERCENT:-85}"

# What to do with this check's alerts (sorted, on stdin), given the last ones delivered: push new
# or changed alerts, push once when they clear, else nothing. Only reads the state file.
decide() {
  local now last
  now="$(cat)"
  last="$(cat "$STATE" 2> /dev/null || true)"
  if [ "$now" = "$last" ]; then
    echo quiet
  elif [ -z "$now" ]; then
    echo resolved
  else
    echo send
  fi
}

# Records the alerts as delivered. Called only after a successful push.
record() {
  umask 077
  mkdir -p "$DIR"
  cat > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}

# Pushes one message; fails (without printing the URL) when it was not delivered.
push() {
  local title="$1" body="$2" url
  url="$(cat "$URL_FILE" 2> /dev/null || true)"
  if [ -z "$url" ]; then
    echo "alerts.sh: no push URL stored (./alerts.sh set-url): not delivered, the next run tries again." >&2
    return 1
  fi
  case "$url" in https://*) ;; *)
    echo "alerts.sh: the push URL must be https: not delivered." >&2
    return 1
    ;;
  esac
  if ! curl --fail --silent --show-error --max-time 20 -H "Title: $title" \
    --data-binary "$body" "$url" > /dev/null 2>&1; then
    echo "alerts.sh: the push failed: not delivered, the next run tries again." >&2
    return 1
  fi
}

# Seconds since a file was last written, or nothing when it does not exist.
age_of() {
  [ -f "$1" ] || return 0
  echo $(($(date +%s) - $(stat -c %Y "$1")))
}

# This check's alerts, one "ALERT ..." line each.
collect() {
  local domain mounts mount used age
  domain="$(env_value SITE_DOMAIN)"
  if [ -z "$domain" ]; then
    echo "ALERT $stack: no SITE_DOMAIN in .env, the site cannot be checked"
  elif ! curl --fail --silent --max-time 10 --output /dev/null "https://$domain/api/v1/health"; then
    echo "ALERT $stack: https://$domain did not answer its health check within 10 seconds"
  fi

  # The root disk and Docker's (images, volumes, the database), each mount point once.
  mounts="$( {
    df -P / | awk 'NR == 2 { print $5, $6 }'
    docker_root="$(docker info --format '{{.DockerRootDir}}' 2> /dev/null || true)"
    if [ -n "$docker_root" ] && [ -d "$docker_root" ]; then
      df -P "$docker_root" | awk 'NR == 2 { print $5, $6 }'
    fi
  } | sort -u -k2,2)"
  while read -r used mount; do
    [ -n "${used:-}" ] || continue
    used="${used%\%}"
    if [[ "$used" =~ ^[0-9]+$ ]] && [ "$used" -ge "$DISK_PERCENT" ]; then
      echo "ALERT $stack: disk $mount is $used% full (limit $DISK_PERCENT%)"
    fi
  done <<< "$mounts"

  if [ -n "$(env_value BACKUP_S3_BUCKET)" ]; then
    age="$(age_of last-backup)"
    if [ -z "$age" ]; then
      echo "ALERT $stack: no successful backup recorded yet (run ./backup.sh)"
    elif [ "$age" -gt $((26 * 3600)) ]; then
      echo "ALERT $stack: the last successful backup is older than 26 hours"
    fi
    age="$(age_of last-restore-test)"
    if [ -z "$age" ] || [ "$age" -gt $((35 * 86400)) ]; then
      echo "ALERT $stack: no restore test passed in the last 35 days (run ./backup.sh restore-test)"
    fi
  fi
}

case "${1:-}" in
  set-url)
    [ -t 0 ] || die "run set-url in a terminal: it asks for the URL hidden"
    read -rsp "Push URL (https://...): " url
    echo >&2
    case "$url" in https://?*) ;; *) die "the push URL must start with https://" ;; esac
    umask 077
    mkdir -p "$DIR"
    chmod 700 "$DIR"
    printf '%s\n' "$url" > "$URL_FILE.tmp" && mv "$URL_FILE.tmp" "$URL_FILE"
    echo "Stored. Next: ./alerts.sh test"
    ;;
  test)
    push "NOLON $stack test" "Test message from the NOLON $stack alert check." || exit 1
    echo "Pushed. If nothing reached your phone, check the URL (./alerts.sh set-url)."
    ;;
  install-cron)
    line="*/5 * * * * cd $PWD && ./alerts.sh run >> \$HOME/nolon-$stack-alerts.log 2>&1"
    { crontab -l 2> /dev/null | grep -vF "cd $PWD && ./alerts.sh" || true; echo "$line"; } | crontab -
    echo "Alert check installed: $line"
    ;;
  run)
    now="$(collect | LC_ALL=C sort -u)"
    case "$(printf '%s' "$now" | decide)" in
      send) push "NOLON $stack alert" "$now" || exit 1 ;;
      resolved) push "NOLON $stack alerts cleared" "No alerts in the last check." || exit 1 ;;
      quiet) exit 0 ;;
    esac
    printf '%s' "$now" | record
    echo "$(date -u +%FT%TZ) pushed:"
    printf '%s\n' "${now:-cleared}"
    ;;
  *) die "usage: alerts.sh [set-url | test | install-cron | run]" ;;
esac
