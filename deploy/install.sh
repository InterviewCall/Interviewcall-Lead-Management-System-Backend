#!/usr/bin/env bash
# One-time setup of the LeadNest server (Ubuntu 22.04/24.04 or Amazon Linux 2023, 64-bit Arm).
# Run it from the folder you copied over:   sudo bash install.sh
# Safe to re-run: existing answers and passwords in /opt/leadnest/settings.env are kept.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo bash install.sh" >&2; exit 1; }
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP=/opt/leadnest

echo "== 1/5 Installing Docker"
. /etc/os-release
case "$ID" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null
    apt-get install -y docker.io cron openssl curl ca-certificates >/dev/null
    CRON_SERVICE=cron
    ;;
  amzn)
    dnf install -y docker cronie openssl >/dev/null
    CRON_SERVICE=crond
    ;;
  *)
    echo "Unsupported OS '$ID'. Use Ubuntu 22.04/24.04 or Amazon Linux 2023 (both 64-bit Arm)." >&2
    exit 1
    ;;
esac
[[ "$(uname -m)" == aarch64 ]] || { echo "This setup expects an Arm (Graviton, t4g) server; the images are built for linux/arm64." >&2; exit 1; }
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" }, "live-restore": true }
JSON
systemctl enable --now docker "$CRON_SERVICE" >/dev/null 2>&1
# Docker Compose plugin: this exact version is what the config files were checked with
mkdir -p /usr/local/lib/docker/cli-plugins
if ! /usr/local/lib/docker/cli-plugins/docker-compose version 2>/dev/null | grep -q "v2.29.7"; then
  curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-aarch64" -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi
docker compose version
if [[ ! -f /swapfile ]]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 2/5 Copying files to $APP"
mkdir -p "$APP"/{bin,env,state,backups}
cp "$SRC/docker-compose.yml" "$SRC/Caddyfile" "$APP/"
cp "$SRC"/bin/*.sh "$APP/bin/"
chmod +x "$APP"/bin/*.sh
chmod 700 "$APP/env"

echo "== 3/5 Your settings"
SETTINGS="$APP/settings.env"
touch "$SETTINGS"; chmod 600 "$SETTINGS"
# shellcheck disable=SC1090
. "$SETTINGS"

ask() { # ask VAR "question" [secret] [optional]
  local var=$1 q=$2 secret=${3:-} optional=${4:-} cur=${!1:-} val
  if [[ -n "$cur" ]]; then return 0; fi
  while true; do
    if [[ "$secret" == secret ]]; then read -r -s -p "$q: " val; echo; else read -r -p "$q: " val; fi
    [[ -n "$val" || "$optional" == optional ]] && break
    echo "  (required)"
  done
  [[ -n "$val" ]] || return 0
  [[ "$val" != *"'"* ]] || { echo "  quotes are not supported in values"; exit 1; }
  printf "%s='%s'\n" "$var" "$val" >> "$SETTINGS"
  printf -v "$var" '%s' "$val"
}
gen() { # gen VAR [bytes]: random letters+digits, kept on re-runs
  local var=$1 bytes=${2:-20}
  if [[ -z "${!var:-}" ]]; then
    local val; val=$(openssl rand -hex "$bytes")
    printf "%s='%s'\n" "$var" "$val" >> "$SETTINGS"
    printf -v "$var" '%s' "$val"
  fi
}

echo "Domain (create an A record for it, pointing at this server's Elastic IP):"
ask CRM_API_DOMAIN "  CRM API hostname, e.g. crm-api.interviewcall.club"
ask ACME_EMAIL "  Your email (for HTTPS certificate notices)"
echo "The web app is on Vercel. It and the API must share a parent domain, e.g. crm.interviewcall.club and crm-api.interviewcall.club:"
ask CRM_WEB_URL "  Web app URL (https://..., no trailing slash)"
ask CRM_COOKIE_DOMAIN "  Parent domain shared by the web app and the API, e.g. interviewcall.club"
ask CRM_REDIS_URL "  Redis URL from Redis Cloud (rediss://default:PASSWORD@host:port, use redis:// if TLS is off)" secret
echo "First admin (created on the first deploy; this is the password you will sign in with):"
ask CRM_SEED_ADMIN_NAME "  Name"
ask CRM_SEED_ADMIN_EMAIL "  Email"
ask CRM_SEED_ADMIN_PHONE "  Mobile number with country code, e.g. +919876543210"
ask CRM_SEED_ADMIN_PASSWORD "  Password (10+ characters)" secret
echo "GitHub (the server pulls your private images from GitHub Container Registry):"
ask GHCR_OWNER "  GitHub username or organisation that owns the backend repo (lowercase)"
ask GHCR_USER "  GitHub username to log in with"
ask GHCR_TOKEN "  GitHub personal access token with read:packages" secret
echo "Email (AWS SES in THIS AWS account; access keys of the sender IAM user):"
ask AWS_REGION "  SES region (e.g. ap-south-1)"
ask AWS_ACCESS_KEY_ID "  AWS access key id" secret
ask AWS_SECRET_ACCESS_KEY "  AWS secret access key" secret
ask SES_FROM_EMAIL "  From email address (verified in SES)"
ask SES_REPLY_TO_EMAIL "  Reply-to email (optional)" "" optional
ask SES_CONFIGURATION_SET_NAME "  SES configuration set (optional)" "" optional
for v in MYSQL_ROOT_PASSWORD DB_PASSWORD_CRM CRM_RECONCILIATION_SECRET; do gen "$v"; done
gen CRM_ACCESS_TOKEN_SECRET 32

echo "== 4/5 Starting the database and the web proxy"
"$APP/bin/render-env.sh"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
# shellcheck source=bin/lib.sh
. "$APP/bin/lib.sh"
dc up -d mysql caddy
wait_healthy mysql 240 || die "MySQL did not become healthy: docker compose -p leadnest logs mysql"
"$APP/bin/bootstrap-db.sh"
touch "$APP/state/db-bootstrapped"

echo "== 5/5 Nightly database backup (02:30 IST, kept 7 days)"
echo "30 21 * * * root $APP/bin/backup.sh >> /var/log/leadnest-backup.log 2>&1" > /etc/cron.d/leadnest-backup

cat <<DONE

Server is ready. Next:
  1. DNS: an A record  $CRM_API_DOMAIN  ->  this server's Elastic IP (if you have not already)
  2. In the backend GitHub repo add the 3 secrets EC2_HOST, EC2_USER and EC2_SSH_KEY, then merge develop into main
     (the workflow builds the images and deploys them here).
(Step by step in README.md.)
DONE
