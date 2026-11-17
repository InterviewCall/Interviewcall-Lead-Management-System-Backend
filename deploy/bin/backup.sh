#!/usr/bin/env bash
# Nightly dump of the CRM database, kept for 7 days in /opt/leadnest/backups (cron, installed by install.sh).
set -euo pipefail
# shellcheck source=lib.sh
. /opt/leadnest/bin/lib.sh

out="$APP_DIR/backups/leadnest-$(date +%F).sql.gz"
tmp="$out.partial"
dc exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
  mysqldump -uroot --single-transaction --routines --databases leadnest | gzip > "$tmp"
[[ -s "$tmp" ]] || die "backup is empty"
mv "$tmp" "$out"
find "$APP_DIR/backups" -name 'leadnest-*.sql.gz' -mtime +7 -delete
log "backup written: $out ($(du -h "$out" | cut -f1))"
