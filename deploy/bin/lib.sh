#!/usr/bin/env bash
# Shared helpers, sourced by the other scripts. Not meant to be executed.
# shellcheck shell=bash
set -euo pipefail

APP_DIR=/opt/leadnest
IMAGES_ENV="$APP_DIR/state/images.env"

mkdir -p "$APP_DIR/env" "$APP_DIR/state" "$APP_DIR/backups"
touch "$IMAGES_ENV"
[[ -f "$APP_DIR/config.env" ]] || { echo "config.env is missing: run install.sh first" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . "$APP_DIR/config.env"; set +a

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "ERROR: $*"; exit 1; }

dc() {
  docker compose -p leadnest \
    -f "$APP_DIR/docker-compose.yml" --project-directory "$APP_DIR" \
    --env-file "$APP_DIR/config.env" --env-file "$IMAGES_ENV" "$@"
}

get_image() { grep -E "^$1=" "$IMAGES_ENV" | tail -n1 | cut -d= -f2- || true; }

set_image() { # set_image VAR value
  local tmp
  tmp=$(mktemp "$APP_DIR/state/.images.XXXXXX")
  { grep -vE "^$1=" "$IMAGES_ENV" || true; echo "$1=$2"; } > "$tmp"
  mv "$tmp" "$IMAGES_ENV"
}

# wait_healthy <service> [timeout-seconds]: waits for the Docker HEALTHCHECK
wait_healthy() {
  local svc=$1 deadline=$((SECONDS + ${2:-180})) cid status
  while (( SECONDS < deadline )); do
    cid=$(dc ps -q "$svc" || true)
    if [[ -n "$cid" ]]; then
      status=$(docker inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}{{else}}stopped{{end}}' "$cid" 2>/dev/null || echo missing)
      case "$status" in
        healthy|nohealth) return 0 ;;
      esac
    fi
    sleep 3
  done
  return 1
}
