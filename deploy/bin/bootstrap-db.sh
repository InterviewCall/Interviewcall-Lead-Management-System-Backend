#!/usr/bin/env bash
# Idempotent: creates the CRM database and its own user (who can reach only that database).
set -euo pipefail
# shellcheck source=lib.sh
. /opt/leadnest/bin/lib.sh
# shellcheck disable=SC1091
. /opt/leadnest/settings.env

[[ "${DB_PASSWORD_CRM:?DB_PASSWORD_CRM is missing: run install.sh again}" =~ ^[A-Za-z0-9]+$ ]] || die "the database password must be letters and digits only"

sql="CREATE DATABASE IF NOT EXISTS \`leadnest\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'leadnest'@'%' IDENTIFIED BY '$DB_PASSWORD_CRM';
ALTER USER 'leadnest'@'%' IDENTIFIED BY '$DB_PASSWORD_CRM';
GRANT ALL PRIVILEGES ON \`leadnest\`.* TO 'leadnest'@'%';
FLUSH PRIVILEGES;"

dc exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql mysql -uroot <<<"$sql"
log "database and user are in place"
