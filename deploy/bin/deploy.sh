#!/usr/bin/env bash
# Usage: sudo deploy.sh <image> <migrate-image>
# Called by GitHub Actions over SSH. Steps: pull -> migrate -> restart -> health check, and if the new version is
# not healthy the previous one is started again. Migrations are NOT undone, so keep them backward compatible.
# The API and the worker run from the one image (two containers); the migrate image runs the migrations and the first seed.
set -euo pipefail
# shellcheck source=lib.sh
. /opt/leadnest/bin/lib.sh

image=${1:?usage: deploy.sh <image> <migrate-image>}
migrate_image=${2:?missing migrate image}

tag_re='^[0-9a-f]{40}$'
prefix="ghcr.io/$GHCR_OWNER/leadnest"
[[ "$image" == "$prefix:"* && "${image##*:}" =~ $tag_re ]] || die "image must be $prefix:<git sha>"
[[ "$migrate_image" == "$prefix-migrate:"* && "${migrate_image##*:}" =~ $tag_re ]] || die "migrate image must be $prefix-migrate:<git sha>"

# One deploy at a time
exec 9>/var/lock/leadnest-deploy.lock
flock -w 900 9 || die "another deploy is still running"

log "== deploy -> ${image##*/}"

previous=$(get_image CRM_IMAGE)
previous_migrate=$(get_image CRM_MIGRATE_IMAGE)

# If anything fails before the new version is confirmed healthy, the image pointers go back to what was running,
# so a reboot can never start a half-deployed version.
state=pending
restore_pointers() {
  if [[ "$state" == pending ]]; then
    set_image CRM_IMAGE "$previous"
    set_image CRM_MIGRATE_IMAGE "$previous_migrate"
    log "deploy failed before start; image pointers restored"
  fi
}
trap restore_pointers EXIT

docker pull "$image" >/dev/null
docker pull "$migrate_image" >/dev/null

# The database and the web proxy must be up before migrating
dc up -d mysql caddy
wait_healthy mysql 180 || die "mysql is not healthy"
if [[ ! -f "$APP_DIR/state/db-bootstrapped" ]]; then
  "$APP_DIR/bin/bootstrap-db.sh"
  touch "$APP_DIR/state/db-bootstrapped"
fi

# One-off commands use the NEW image
set_image CRM_IMAGE "$image"
set_image CRM_MIGRATE_IMAGE "$migrate_image"
log "running Prisma migrations"
dc --profile tools run -T --rm --no-deps crm-migrate
if [[ ! -f "$APP_DIR/state/seeded" ]]; then
  log "seeding (admin user, lead sources, outcomes, lost reasons; first deploy only)"
  dc --profile tools run -T --rm --no-deps crm-seed
  touch "$APP_DIR/state/seeded"
fi

log "starting crm-api and crm-worker"
dc up -d --no-deps crm-api crm-worker

# The worker has no HTTP port and so no health check: it only has to be running
worker_running() { [[ -n "$(dc ps -q --status running crm-worker || true)" ]]; }

if wait_healthy crm-api 180 && sleep 5 && worker_running; then
  state=done
  log "healthy"
else
  state=handled
  log "NEW VERSION IS NOT HEALTHY. Last logs:"
  dc logs --no-color --tail 60 crm-api crm-worker || true
  if [[ -n "$previous" ]]; then
    log "rolling back to ${previous##*/}"
    set_image CRM_IMAGE "$previous"
    dc up -d --no-deps crm-api crm-worker
    if wait_healthy crm-api 120; then log "rolled back, previous version is healthy"; else log "previous version is not healthy either"; fi
  else
    log "no previous version; stopping crm-api and crm-worker"
    dc stop crm-api crm-worker || true
    set_image CRM_IMAGE ""
  fi
  exit 1
fi

# Keep roughly a week of old images for fast rollback
docker image prune -af --filter "until=168h" >/dev/null || true
log "== deploy done"
