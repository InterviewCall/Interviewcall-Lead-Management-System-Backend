#!/usr/bin/env bash
# Turns /opt/leadnest/settings.env (the ONE file you edit) into config.env and env/crm.env.
# Run it after editing settings.env, then redeploy (GitHub -> Actions -> Run workflow) or restart the containers.
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/leadnest}
# shellcheck disable=SC1091
set -a; . "$APP_DIR/settings.env"; set +a

mkdir -p "$APP_DIR/env"
umask 077

need() { for k in "$@"; do [[ -n "${!k:-}" ]] || { echo "settings.env: $k is empty" >&2; exit 1; }; done; }
need CRM_API_DOMAIN ACME_EMAIL GHCR_OWNER CRM_WEB_URL CRM_COOKIE_DOMAIN CRM_REDIS_URL \
     MYSQL_ROOT_PASSWORD DB_PASSWORD_CRM CRM_ACCESS_TOKEN_SECRET CRM_RECONCILIATION_SECRET \
     AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY SES_FROM_EMAIL

# emit KEY VALUE: writes KEY='value' (single quotes are literal for docker compose). Skips empty optionals.
emit() {
  local key=$1 val=${2:-}
  [[ -n "$val" ]] || return 0
  if [[ "$val" == *"'"* || "$val" == *$'\n'* ]]; then echo "value for $key contains a quote or newline, not supported" >&2; exit 1; fi
  printf "%s='%s'\n" "$key" "$val"
}

# Compose-level settings (hostname, image owner, database password). Plain values, no quotes.
{
  echo "CRM_API_DOMAIN=$CRM_API_DOMAIN"
  echo "ACME_EMAIL=$ACME_EMAIL"
  echo "GHCR_OWNER=$GHCR_OWNER"
  echo "MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD"
} > "$APP_DIR/config.env"

# One env file shared by crm-api, crm-worker and the one-off migrate/seed containers
{
  emit NODE_ENV production
  emit PORT 3000
  emit TRUST_PROXY 1
  emit TZ Asia/Kolkata
  emit DATABASE_URL "mysql://leadnest:${DB_PASSWORD_CRM}@mysql:3306/leadnest"
  emit DB_HOST mysql
  emit DB_PORT 3306
  emit DB_USER leadnest
  emit DB_PASSWORD "$DB_PASSWORD_CRM"
  emit DB_NAME leadnest
  # Redis Cloud: the queues, the timers and the rate limits
  emit REDIS_URL "$CRM_REDIS_URL"
  emit ACCESS_TOKEN_SECRET "$CRM_ACCESS_TOKEN_SECRET"
  emit ACCESS_TOKEN_TTL_MINUTES 15
  emit REFRESH_TOKEN_TTL_DAYS 7
  # The web app (on Vercel) and this API must share a parent domain: the session cookies are set on it
  emit CRM_WEB_ORIGIN "$CRM_WEB_URL"
  emit COOKIE_DOMAIN "$CRM_COOKIE_DOMAIN"
  emit AWS_REGION "$AWS_REGION"
  emit AWS_ACCESS_KEY_ID "$AWS_ACCESS_KEY_ID"
  emit AWS_SECRET_ACCESS_KEY "$AWS_SECRET_ACCESS_KEY"
  emit EMAIL_FROM "${CRM_EMAIL_FROM:-LeadNest <$SES_FROM_EMAIL>}"
  emit EMAIL_REPLY_TO "${SES_REPLY_TO_EMAIL:-}"
  emit SES_CONFIGURATION_SET "${SES_CONFIGURATION_SET_NAME:-}"
  emit RECONCILIATION_SECRET "$CRM_RECONCILIATION_SECRET"
  # Used only by the one-off seed (first deploy); it never changes an existing admin's password.
  # They may be deleted from settings.env afterwards (empty values are skipped here).
  emit SEED_ADMIN_NAME "${CRM_SEED_ADMIN_NAME:-}"
  emit SEED_ADMIN_EMAIL "${CRM_SEED_ADMIN_EMAIL:-}"
  emit SEED_ADMIN_PHONE "${CRM_SEED_ADMIN_PHONE:-}"
  emit SEED_ADMIN_PASSWORD "${CRM_SEED_ADMIN_PASSWORD:-}"
} > "$APP_DIR/env/crm.env"

echo "rendered config.env and env/crm.env from settings.env"
